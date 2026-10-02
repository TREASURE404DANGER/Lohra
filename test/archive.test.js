import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BufferJSON } from 'baileys';
import { Archive, classify } from '../plugins/_archive.js';
import { Agent } from '../plugins/agent.js';
import { TOOL_DECLS, SYSTEM_PROMPT, makeDispatch, STATE_TOOLS } from '../plugins/_agenttools.js';
import { fakeConn, silent } from './helpers.js';

const PRECIOUS = '2349000009208';
let n = 0;
const msg = (message, { jid = `${PRECIOUS}@s.whatsapp.net`, fromMe = false, ts, extraKey = {}, pushName = 'Precious' } = {}) => ({
  key: { remoteJid: jid, fromMe, id: `ID${++n}`, ...extraKey }, message, messageTimestamp: ts, pushName,
});
const voice = (seconds = 7) => ({ audioMessage: { ptt: true, seconds, mimetype: 'audio/ogg; codecs=opus', mediaKey: Buffer.from('k'), directPath: '/x', jpegThumbnail: Buffer.from('big') } });

async function mk({ now = 1_800_000_000_000, days = 30 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arch-'));
  const conn = fakeConn();
  const a = new Archive({ dataDir: dir, log: silent, conn, retentionDays: days, now: () => now });
  await a.init();
  return { dir, conn, a, now, ts: (agoSec) => Math.floor(now / 1000) - agoSec };
}

test('classify: keeps text and media kinds, ignores reactions and protocol messages', () => {
  assert.equal(classify(voice()).kind, 'voice');
  assert.equal(classify({ audioMessage: { ptt: false } }).kind, 'audio');
  assert.deepEqual([classify({ imageMessage: { caption: 'lol' } }).kind, classify({ imageMessage: { caption: 'lol' } }).text], ['image', 'lol']);
  assert.equal(classify({ extendedTextMessage: { text: 'hi' } }).kind, 'text');
  assert.equal(classify({ documentMessage: { fileName: 'a.pdf' } }).fileName, 'a.pdf');
  assert.equal(classify({ reactionMessage: { text: '👍' } }), null);
  assert.equal(classify({ protocolMessage: {} }), null);
});

test('record + find: newest voice note first, filters by kind, direction and words, never stores media bytes', async () => {
  const { a, ts, dir } = await mk();
  await a.record(msg({ conversation: 'are we still on for the meeting?' }, { ts: ts(3000) }));
  const old = msg(voice(3), { ts: ts(2000) });
  const newest = msg(voice(9), { ts: ts(600) });
  await a.record(old); await a.record(newest);
  await a.record(msg({ conversation: 'ok sending it' }, { fromMe: true, ts: ts(100) }));
  await a.record(msg({ conversation: 'someone else' }, { jid: '2348000000000@s.whatsapp.net', ts: ts(50) }));
  const v = await a.find({ number: PRECIOUS, kind: 'voice' });
  assert.deepEqual(v.map((x) => x.id), [newest.key.id, old.key.id]);
  assert.equal(v[0].seconds, 9);
  assert.equal(v[0].raw, undefined);
  assert.equal((await a.find({ number: PRECIOUS, from: 'me' })).length, 1);
  assert.equal((await a.find({ number: PRECIOUS, query: 'MEETING' })).length, 1);
  assert.equal((await a.find({ number: PRECIOUS, kind: 'image' })).length, 0);
  assert.equal((await a.find({ number: PRECIOUS })).length, 4);
  const file = await fs.readFile(path.join(dir, 'archive', `${PRECIOUS}.jsonl`), 'utf8');
  assert.ok(!file.includes('jpegThumbnail') && !file.includes('big'), 'thumbnails are stripped');
});

test('record: ignores statuses, newsletters, duplicates and a switched-off archive', async () => {
  const { a, ts } = await mk();
  assert.equal(await a.record(msg({ conversation: 'x' }, { jid: 'status@broadcast', ts: ts(5) })), null);
  assert.equal(await a.record(msg({ conversation: 'x' }, { jid: '1203@newsletter', ts: ts(5) })), null);
  const m = msg({ conversation: 'hello there' }, { ts: ts(5) });
  assert.ok(await a.record(m));
  assert.equal(await a.record(m), null);
  await a.setEnabled(false);
  assert.equal(await a.record(msg({ conversation: 'later' }, { ts: ts(4) })), null);
  assert.equal(a.stats().messages, 1);
});

test('LID chats are linked to the phone number', async () => {
  const { a, conn, ts } = await mk();
  conn.sock.signalRepository = { lidMapping: { getPNForLID: async () => `${PRECIOUS}@s.whatsapp.net`, getLIDForPN: async () => '9988776655@lid' } };
  await a.record(msg(voice(), { jid: '9988776655@lid', ts: ts(60) }));
  assert.equal((await a.find({ number: PRECIOUS, kind: 'voice' })).length, 1);
  // a LID chat the mapping cannot resolve at record time is still found through the reverse mapping
  conn.sock.signalRepository.lidMapping.getPNForLID = async () => null;
  await a.record(msg(voice(), { jid: '9988776655@lid', ts: ts(30) }));
  assert.equal((await a.find({ number: PRECIOUS, kind: 'voice' })).length, 2);
});

test('retention: old messages are dropped, survivors persist across a restart', async () => {
  const { a, dir, now, ts, conn } = await mk({ days: 30 });
  await a.record(msg({ conversation: 'recent' }, { ts: ts(3600) }));
  await a.chain;
  assert.equal(await a.record(msg({ conversation: 'ancient' }, { ts: ts(40 * 86400) })), null);
  const b = new Archive({ dataDir: dir, log: silent, conn, retentionDays: 30, now: () => now + 31 * 86400_000 });
  await b.init();
  assert.equal(b.stats().messages, 0, 'a month later the recent message has aged out');
  const c = new Archive({ dataDir: dir, log: silent, conn, retentionDays: 30, now: () => now });
  await c.init();
  // b rewrote the files, so nothing is left; a fresh archive on a new dir keeps data:
  assert.equal(c.stats().messages, 0);
  const d1 = await mk();
  await d1.a.record(msg({ conversation: 'keep me' }, { ts: d1.ts(10) }));
  await d1.a.chain;
  const d2 = new Archive({ dataDir: d1.dir, log: silent, conn: d1.conn, now: () => d1.now });
  await d2.init();
  assert.equal((await d2.find({ number: PRECIOUS }))[0].text, 'keep me');
});

test('deliver: text, media, and an expired media file', async () => {
  const { a, ts } = await mk();
  const sent = [];
  const send = async (jid, content) => { sent.push({ jid, content }); };
  const t = await a.record(msg({ conversation: 'the code is 4411' }, { ts: ts(120) }));
  assert.equal((await a.deliver(t, 'me@s.whatsapp.net', { send, who: 'Precious' })).ok, true);
  assert.match(sent[0].content.text, /Precious.*\n\nthe code is 4411/s);
  const v = await a.record(msg(voice(8), { ts: ts(60) }));
  let received;
  const ok = await a.deliver(v, 'me@s.whatsapp.net', { send, who: 'Precious', download: async (m) => { received = m; return Buffer.from('opus'); } });
  assert.equal(ok.ok, true);
  assert.ok(Buffer.isBuffer(received.message.audioMessage.mediaKey), 'mediaKey is restored as a Buffer');
  const audio = sent.find((s) => s.content.audio);
  assert.equal(audio.content.ptt, true);
  assert.equal(audio.jid, 'me@s.whatsapp.net');
  const gone = await a.deliver(v, 'me@s.whatsapp.net', { send, download: async () => { throw new Error('404 gone'); } });
  assert.equal(gone.error, 'media_expired');
});

// ---------- the agent operations ----------
async function agentRig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentarch-'));
  await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify({ Precious: PRECIOUS, Thomas: '2348012345678' }));
  const conn = fakeConn();
  const sent = [];
  const arch = new Archive({ dataDir: dir, log: silent, conn, now: () => 1_800_000_000_000 });
  await arch.init();
  const api = { config: { dataDir: dir, allowed: [] }, conn, log: silent, startedAt: 0, send: async (j, c) => { sent.push({ jid: j, content: c }); return { key: { id: 'S' } }; }, archive: arch };
  const agent = new Agent(api, { now: () => 1_800_000_000_000 });
  await agent.start();
  return { agent, arch, sent, ts: (s) => Math.floor(1_800_000_000_000 / 1000) - s, api };
}

test('agent: "send me the last voice note Precious sent" finds it and delivers it to the owner only', async () => {
  const { agent, arch, sent, ts } = await agentRig();
  try {
    arch.download = async () => Buffer.from('opus');
    const m = await arch.record(msg(voice(10), { ts: ts(900) }));
    const r = await agent.handle({ op: 'msgs.find', contact: 'Precious', kind: 'voice', deliver_newest: true, source: 'voice' });
    assert.equal(r.ok, true);
    assert.equal(r.messages[0].id, m.id);
    assert.equal(r.delivered.status, 'delivered_to_owner');
    assert.deepEqual([...new Set(sent.map((s) => s.jid))], ['15550001111@s.whatsapp.net']);
    arch.download = async () => { throw new Error('gone'); };
    const r2 = await agent.handle({ op: 'msgs.send', id: m.id });
    assert.equal(r2.error, 'media_expired');
  } finally { await agent.stop(); }
});

test('agent: nothing saved -> an honest none_found with the limits; unknown contact and ids are refused', async () => {
  const { agent } = await agentRig();
  const r = await agent.handle({ op: 'msgs.find', contact: 'Thomas', kind: 'voice' });
  assert.equal(r.error, 'none_found');
  assert.match(r.hint, /watch_contact/);
  assert.match(r.hint, /cannot read older chats/);
  assert.equal((await agent.handle({ op: 'msgs.find', contact: 'Nobody Atall' })).error, 'contact_not_found');
  assert.equal((await agent.handle({ op: 'msgs.find', contact: 'Thomas', kind: 'hologram' })).error, 'invalid_kind');
  assert.equal((await agent.handle({ op: 'msgs.send', id: 'nope' })).error, 'not_found');
  await agent.stop();
});

test('agent: paused agent refuses delivery; deliveries are capped per hour', async () => {
  const { agent, arch, ts } = await agentRig();
  const m = await arch.record(msg({ conversation: 'hello' }, { ts: ts(30) }));
  agent.paused = true;
  assert.equal((await agent.handle({ op: 'msgs.send', id: m.id })).error, 'paused');
  agent.paused = false;
  for (let i = 0; i < 15; i++) assert.equal((await agent.handle({ op: 'msgs.send', id: m.id })).ok, true);
  assert.equal((await agent.handle({ op: 'msgs.send', id: m.id })).error, 'rate_limited');
  await agent.stop();
});

test('tools: find_messages / deliver_to_owner are declared, routed, and explained in the prompt', async () => {
  const f = TOOL_DECLS.find((d) => d.name === 'find_messages');
  assert.ok(f && TOOL_DECLS.some((d) => d.name === 'deliver_to_owner'));
  assert.deepEqual(f.parameters.properties.kind.enum, ['any', 'text', 'voice', 'image', 'video', 'document', 'sticker']);
  assert.deepEqual(f.parameters.required, ['contact']);
  assert.match(f.description, /watch_contact/);
  assert.match(SYSTEM_PROMPT, /find_messages/);
  assert.match(SYSTEM_PROMPT, /last voice note/i);
  assert.match(SYSTEM_PROMPT, /Never say you cannot look at past messages/);
  assert.ok(STATE_TOOLS.has('find_messages') && STATE_TOOLS.has('deliver_to_owner'));
  const calls = [];
  const d = makeDispatch({ handle: async (r) => { calls.push(r); return { ok: true }; } });
  await d('find_messages', { contact: 'Precious', kind: 'voice', deliver_newest: true, limit: 3 });
  await d('deliver_to_owner', { id: 'ID9', evil: 1 });
  assert.deepEqual(calls[0], { op: 'msgs.find', contact: 'Precious', kind: 'voice', from: undefined, query: undefined, limit: 3, hours: undefined, deliver_newest: true, source: 'voice' });
  assert.deepEqual(calls[1], { op: 'msgs.send', id: 'ID9', source: 'voice' });
});
