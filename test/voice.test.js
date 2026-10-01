import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../plugins/voice.js', import.meta.url));
const v = await import(file);

const user = { id: '15550001111:7@s.whatsapp.net', lid: '99887766:7@lid' };
const vn = (over = {}, ptt = true) => ({
  key: { remoteJid: '15550001111@s.whatsapp.net', fromMe: true, id: 'V1', ...over },
  message: { audioMessage: { ptt, seconds: 4 } },
});

test('isSelfVoiceNote: own voice note in own chat', () => {
  assert.equal(v.isSelfVoiceNote(vn(), user), true);
  assert.equal(v.isSelfVoiceNote(vn({ remoteJid: '99887766@lid' }), user), true);          // LID chat
  assert.equal(v.isSelfVoiceNote(vn({ remoteJid: '99887766@lid', remoteJidAlt: '15550001111@s.whatsapp.net' }), user), true);
});
test('isSelfVoiceNote: ignores everything else', () => {
  assert.equal(v.isSelfVoiceNote(vn({ remoteJid: '15559998888@s.whatsapp.net' }), user), false); // voice note to someone else
  assert.equal(v.isSelfVoiceNote(vn({ fromMe: false }), user), false);                            // incoming
  assert.equal(v.isSelfVoiceNote(vn({}, false), user), false);                                     // plain audio file, not a voice note
  assert.equal(v.isSelfVoiceNote({ key: { fromMe: true, remoteJid: '15550001111@s.whatsapp.net' }, message: { conversation: 'hi' } }, user), false);
  assert.equal(v.isSelfVoiceNote(vn({ remoteJid: '123456-789@g.us' }), user), false);
  assert.equal(v.isSelfVoiceNote(vn(), {}), false);
});
test('transcribe: sends auth + multipart, returns trimmed text', async () => {
  const tmp = path.join(os.tmpdir(), `t-${Date.now()}.wav`);
  await fs.writeFile(tmp, Buffer.from('RIFF'));
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ text: '  hello world ' }) }; };
  assert.equal(await v.transcribe(tmp, { url: 'http://x:1', key: 'K', fetchImpl }), 'hello world');
  assert.equal(seen.url, 'http://x:1/v1/audio/transcriptions');
  assert.equal(seen.init.headers.Authorization, 'Bearer K');
  assert.equal(seen.init.body.get('model'), 'phonon-2');
  assert.ok(seen.init.body.get('file'));
  await assert.rejects(v.transcribe(tmp, { url: 'http://x:1', fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await fs.rm(tmp);
});

const chat = '15550001111@s.whatsapp.net';
const replyMsg = (quoted) => ({
  key: { remoteJid: chat, fromMe: true, id: 'CMD1' },
  message: { extendedTextMessage: { text: 'Lohra transcribe', contextInfo: { stanzaId: 'Q1', participant: '15559998888@s.whatsapp.net', quotedMessage: quoted } } },
});

test('getQuoted: extracts the replied-to message, null when not a reply', () => {
  const q = v.getQuoted(replyMsg({ audioMessage: { ptt: true } }), chat);
  assert.equal(q.key.id, 'Q1');
  assert.equal(q.key.remoteJid, chat);
  assert.equal(q.key.participant, '15559998888@s.whatsapp.net');
  assert.ok(q.message.audioMessage);
  assert.equal(v.getQuoted({ key: {}, message: { conversation: 'hi' } }, chat), null);
  assert.equal(v.getQuoted(null, chat), null);
});

function fakeApi() {
  const sent = [];
  return {
    sent,
    api: {
      config: { dataDir: os.tmpdir() },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      store: { isSent: () => false },
      conn: { sock: { user, updateMediaMessage: async () => {} } },
      send: async (jid, content, opts) => { sent.push({ jid, content, opts }); return {}; },
    },
  };
}

test('transcribe command: needs a reply to an audio message', async () => {
  const { api, sent } = fakeApi();
  await v.default.init(api);
  const run = v.default.commands.transcribe.run;
  const out = [];
  const ctx = (msg) => ({ msg, jid: chat, reply: async (t) => out.push(t) });
  await run(ctx({ key: { remoteJid: chat, id: 'C' }, message: { conversation: 'Lohra transcribe' } }));
  await run(ctx(replyMsg({ conversation: 'just text' })));
  assert.equal(out.length, 2);
  assert.match(out[0], /Reply to a voice note/);
  assert.equal(sent.length, 0); // nothing queued
});

const tick = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); };
const vnSec = (id, seconds) => ({ ...vn({ id }), message: { audioMessage: { ptt: true, seconds } }, messageTimestamp: Math.floor(Date.now() / 1000) });
const feed = (api, ...msgs) => v.default.on['messages.upsert']({ messages: msgs });
const reactions = (sent) => sent.filter((x) => x.content.react).map((x) => x.content.react.text);
const texts = (sent) => sent.filter((x) => x.content.text).map((x) => x.content.text);

test('etaText', () => {
  assert.equal(v.etaText(20), '20 seconds');
  assert.equal(v.etaText(1), '4 seconds');        // never "2 seconds"
  assert.equal(v.etaText(119), '119 seconds');
  assert.equal(v.etaText(180), '3 minutes');
});

test('voice note: ack reaction + "ready in about 2x length", then reply, then reaction cleared', async () => {
  const { api, sent } = fakeApi();
  await v.default.init(api);
  feed(api, vnSec('ETA1', 30));
  await tick(() => reactions(sent).includes(''));
  assert.equal(sent[0].content.react.text, '⏳');                 // acknowledged first
  assert.equal(sent[0].content.react.key.id, 'ETA1');
  assert.match(sent[1].content.text, /ready in about 60 seconds/); // 30s x 2
  assert.ok(!texts(sent).some((t) => t.includes('🎙')));          // no emoji in text
  assert.ok(sent.some((x) => x.content.text && /Could not transcribe/.test(x.content.text))); // fake note can't download -> polite failure
  assert.equal(reactions(sent).at(-1), '');                        // reaction cleared at the end
});

test('no 90 second limit: a 30 minute note is accepted, acknowledged and given an honest estimate', async () => {
  const { api, sent } = fakeApi();
  await v.default.init(api);
  feed(api, vnSec('LONG1', 1800));
  await tick(() => reactions(sent).includes(''));
  assert.equal(sent[0].content.react.text, '⏳');
  assert.match(sent[1].content.text, /ready in about 60 minutes/);   // local engine: 2x the length
  assert.ok(!texts(sent).some((t) => /only transcribe|up to 90/.test(t)));
  await new Promise((r) => setTimeout(r, 50));   // let the worker release its queue slot before the next test
});

test('only a runaway recording is refused: more than 3 hours, no reaction, no work', async () => {
  const { api, sent } = fakeApi();
  await v.default.init(api);
  feed(api, vnSec('HUGE1', 3 * 3600 + 1));
  await tick(() => sent.length >= 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content.text, /181 minutes long.*limit 3 hours/);
  assert.deepEqual(reactions(sent), []);
  assert.equal(v.MAX_SECONDS, 3 * 3600);
});

test('queued notes: estimate includes the work ahead', async () => {
  const { api, sent } = fakeApi();
  await v.default.init(api);
  feed(api, vnSec('Q1', 20), vnSec('Q2', 10));   // arrive together
  await tick(() => texts(sent).filter((t) => /ready in about/.test(t)).length >= 2);
  const etas = texts(sent).filter((t) => /ready in about/.test(t));
  assert.match(etas[0], /about 40 seconds/);      // 20 x 2
  assert.match(etas[1], /about 60 seconds/);      // 10 x 2 + 40 ahead
});

test('transcribe command: a long replied voice note is accepted too', async () => {
  const { api, sent } = fakeApi();
  await v.default.init(api);
  const cmd = replyMsg({ audioMessage: { ptt: true, seconds: 600 } });
  await v.default.commands.transcribe.run({ msg: cmd, jid: chat, reply: async () => {} });
  await tick(() => reactions(sent).includes(''));
  assert.equal(sent[0].content.react.text, '⏳');
  assert.match(sent[1].content.text, /ready in about 20 minutes/);
});

// ---------- polish ----------
const llmReply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('chunkText: keeps sentences together, splits long runs, loses nothing', () => {
  assert.deepEqual(v.chunkText('One two. Three four.', 50), ['One two. Three four.']);
  const long = Array.from({ length: 30 }, (_, i) => `s${i} a b c.`).join(' ');
  const parts = v.chunkText(long, 20);
  assert.ok(parts.length > 1 && parts.every((p) => p.split(/\s+/).length <= 20));
  assert.equal(parts.join(' '), long);
  const runon = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
  assert.equal(v.chunkText(runon, 20).join(' '), runon);
});

test('looksLikeCleanup: accepts real cleanups, rejects poems, refusals, dropped content', () => {
  const inp = 'hey so um i was thinking we could meet at the the mall around four';
  assert.equal(v.looksLikeCleanup(inp, 'Hey, so I was thinking we could meet at the mall around four.'), true);
  assert.equal(v.looksLikeCleanup(inp, 'Oh how I love the grace of cats, their sleek fur and playful eyes, they run and play all day long'), false);
  assert.equal(v.looksLikeCleanup(inp, 'Hey.'), false);
  assert.equal(v.looksLikeCleanup(inp, "Sure! Here's the cleaned text: Hey, so I was thinking we could meet at the mall around four. Let me know if you want changes to anything else."), false);
  assert.equal(v.looksLikeCleanup(inp, ''), false);
});

test('polish: uses cleaned text when sane, sends auth + transcript tags', async () => {
  let body, headers;
  const f = async (url, init) => { body = JSON.parse(init.body); headers = init.headers; return llmReply('Hey, can you send me the invoice for March?')(); };
  const out = await v.polish('hey can you send me the the invoice for march', { url: 'http://llm:8080', key: 'K', fetchImpl: f });
  assert.equal(out, 'Hey, can you send me the invoice for March?');
  assert.equal(headers.Authorization, 'Bearer K');
  assert.equal(body.temperature, 0);
  assert.match(body.messages.at(-1).content, /^<transcript>hey can you send me the the invoice for march<\/transcript>$/);
});

test('polish: falls back to raw on bad output, LLM error, timeout-ish failure', async () => {
  const raw = 'tell mum i will be late tomorrow because the meeting is running over okay';
  const poem = 'Roses are red violets are blue the moon is bright and so are you my dear friend';
  assert.equal(await v.polish(raw, { url: 'x', fetchImpl: llmReply(poem) }), raw);
  assert.equal(await v.polish(raw, { url: 'x', fetchImpl: async () => ({ ok: false, status: 500 }) }), raw);
  assert.equal(await v.polish(raw, { url: 'x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), raw);
});

test('polish: skips tiny and very long texts without calling the LLM', async () => {
  let calls = 0;
  const f = async () => { calls++; return llmReply('x')(); };
  assert.equal(await v.polish('ok thanks', { url: 'x', fetchImpl: f }), 'ok thanks');
  const huge = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
  assert.equal(await v.polish(huge, { url: 'x', fetchImpl: f }), huge);
  assert.equal(calls, 0);
});

test('polish: a bad chunk falls back alone, good chunks stay polished', async () => {
  const a = Array.from({ length: 100 }, (_, i) => `alpha${i}`).join(' ') + '.';
  const b = Array.from({ length: 100 }, (_, i) => `beta${i}`).join(' ') + '.';
  let n = 0;
  const f = async () => (++n === 1 ? llmReply('nonsense unrelated output words here that do not match at all okay')() : llmReply(b.replace('beta0', 'Beta0'))());
  const out = await v.polish(`${a} ${b}`, { url: 'x', fetchImpl: f });
  assert.ok(out.startsWith('alpha0 '));
  assert.ok(out.includes('Beta0'));
});
