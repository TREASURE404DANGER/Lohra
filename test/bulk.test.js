import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { Sender } from '../src/send.js';
import { Agent } from '../plugins/agent.js';
import { parseContacts } from '../plugins/_contacts.js';
import { planRecipients, personalize, pickDelaySec, gapMs, bulkPrompt, finalNote, humanDuration } from '../plugins/_bulk.js';
import { TOOL_DECLS, STATE_TOOLS, makeDispatch, commandReply } from '../plugins/_agenttools.js';
import { fakeConn, silent, until } from './helpers.js';

const SELF = '15550001111';
const CONTACTS = {
  Ana: '2348000000001',
  'Ben Okoye': '2348000000002',
  Chidi: '2348000000003',
  Mum: { number: '2348000000004', aliases: ['mom'] },
  Me: SELF,
  'Family Group': { jid: '120363000000000001@g.us' },
};
const names = (r) => r.recips.map((c) => c.name);

const agents = [];
after(async () => { for (const a of agents) await a.stop().catch(() => {}); });

async function setup({ contacts = CONTACTS, cfg, failFor = [], onWhatsApp, sleepHook } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-'));
  await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify(contacts));
  if (cfg) { await fs.mkdir(path.join(dir, 'agent')); await fs.writeFile(path.join(dir, 'agent', 'config.json'), JSON.stringify(cfg)); }
  const conn = fakeConn();
  const real = conn.sock.sendMessage;
  conn.sock.sendMessage = async (jid, content, opts) => {
    if (failFor.some((n) => jid.startsWith(n))) throw new Error('boom');
    return real(jid, content, opts);
  };
  conn.sock.onWhatsApp = onWhatsApp || (async (...js) => js.map((j) => ({ jid: j, exists: true })));
  const store = createStore();
  const sender = new Sender({ conn, store, config: { sendGapMs: 0 }, log: silent });
  const clock = { t: 1_700_000_000_000 };
  const api = { config: { dataDir: dir, allowed: [] }, conn, store, log: silent, startedAt: clock.t, send: (j, c, o) => sender.send(j, c, o) };
  const waits = [];
  const agent = new Agent(api, { now: () => clock.t, sleep: async (ms) => { waits.push(ms); await sleepHook?.(ms, agent); } });
  await agent.start();
  agents.push(agent);
  const toPeople = () => conn.sent.filter((m) => !m.jid.startsWith(SELF)); // everything not in the owner's own chat
  return { dir, conn, agent, clock, waits, sent: conn.sent, toPeople, self: `${SELF}@s.whatsapp.net` };
}
const react = (id, text) => ({ messages: [{ key: { id: `R${Math.random()}`, fromMe: true, remoteJid: `${SELF}@s.whatsapp.net` }, message: { reactionMessage: { key: { id }, text } } }] });
const promptId = (s) => `OUT${s.sent.length}`;
const finished = (s) => s.agent.bulkRun?.done ?? Promise.resolve();

// ---------- pure helpers ----------
test('planRecipients: all = people only, never groups, and never yourself', () => {
  const c = parseContacts(CONTACTS).contacts;
  const r = planRecipients(c, { all: true }, { selfDigits: SELF });
  assert.deepEqual(names(r).sort(), ['Ana', 'Ben Okoye', 'Chidi', 'Mum']);
  assert.deepEqual(r.skipped, [{ name: 'Me', reason: 'that is you' }]);
});

test('planRecipients: names, except, duplicates and unclear names', () => {
  const c = parseContacts(CONTACTS).contacts;
  assert.deepEqual(names(planRecipients(c, { to: ['ana', 'Ana', 'mom'] })), ['Ana', 'Mum']);
  assert.deepEqual(names(planRecipients(c, { all: true, except: ['mom'] }, { selfDigits: SELF })).sort(), ['Ana', 'Ben Okoye', 'Chidi']);
  assert.deepEqual(names(planRecipients(c, { to: 'Ana, Chidi' })), ['Ana', 'Chidi']);
  const bad = planRecipients(c, { to: ['Ana', 'Zzyzx'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.bad.query, 'Zzyzx');
  assert.equal(planRecipients(c, { all: true, except: ['Zzyzx'] }).ok, false); // an unclear exclusion is asked about, never guessed
  assert.deepEqual(names(planRecipients(c, { to: ['Family Group'] })), ['Family Group']); // a group only when named
});

test('pacing: default 2 s, never shorter than chosen, clamped', () => {
  assert.equal(pickDelaySec(undefined), 2);
  assert.equal(pickDelaySec('abc'), 2);
  assert.equal(pickDelaySec(0), 1);
  assert.equal(pickDelaySec(500), 60);
  assert.equal(pickDelaySec(5), 5);
  assert.equal(gapMs(2, 0.25, () => 0), 2000);
  assert.equal(gapMs(2, 0.25, () => 0.999), 2500);
  for (let i = 0; i < 200; i++) assert.ok(gapMs(2) >= 2000 && gapMs(2) <= 2500);
  assert.equal(humanDuration(30), '30s');
  assert.equal(humanDuration(300), '5 min');
});

test('personalize: first name, fallback, case-insensitive', () => {
  assert.equal(personalize('Hi {name}, happy new month!', { name: 'Ben Okoye' }), 'Hi Ben, happy new month!');
  assert.equal(personalize('Hi {NAME}', {}), 'Hi there');
  assert.equal(personalize('No placeholder', { name: 'Ana' }), 'No placeholder');
});

test('approval text shows everyone, the message, the pace and the choices', () => {
  const a = { id: 'abcd', text: 'Hi {name}!', delaySec: 2, verified: true, skipped: [{ name: 'Me', reason: 'that is you' }], recips: [{ name: 'Ana' }, { name: 'Ben Okoye' }] };
  const t = bulkPrompt(a, 600);
  for (const bit of ['Send to 2 people?', 'Ana, Ben Okoye', 'Skipping: Me (that is you)', '> Hi Ana!', 'each person gets their own first name', '2s between messages', '👍 send to all', '#abcd']) assert.ok(t.includes(bit), bit);
  const many = { ...a, recips: Array.from({ length: 40 }, (_, i) => ({ name: `P${i}` })) };
  assert.match(bulkPrompt(many, 600), /and 15 more/);
});

// ---------- the flow ----------
test('bulk: proposing sends nothing to anyone; 👍 sends one by one with a pause between', async () => {
  const s = await setup();
  const r = await s.agent.handle({ op: 'send.bulk', all: true, text: 'Happy new month!', source: 'test' });
  assert.equal(r.ok, true); assert.equal(r.status, 'pending'); assert.equal(r.recipients, 4);
  assert.equal(s.toPeople().length, 0, 'nothing leaves before approval');
  const prompt = s.sent.at(-1).content.text;
  assert.match(prompt, /Send to 4 people/); assert.match(prompt, /Happy new month!/);

  await s.agent.onUpsert(react(promptId(s), '👍'));
  await finished(s);
  const out = s.toPeople();
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((m) => m.jid.split('@')[0]).sort(), ['2348000000001', '2348000000002', '2348000000003', '2348000000004']);
  assert.ok(out.every((m) => m.content.text === 'Happy new month!'));
  assert.equal(s.waits.length, 3, 'a pause between messages, none after the last');
  assert.ok(s.waits.every((ms) => ms >= 2000 && ms <= 2500), `waits ${s.waits}`);
  assert.equal(s.agent.actions.get(r.id).status, 'sent');
  assert.match(s.sent.at(-1).content.text, /Done: sent to 4 of 4/);
});

test('bulk: {name} is filled in per person; a custom pause is honoured', async () => {
  const s = await setup();
  const r = await s.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben'], text: 'Hi {name}!', delay_sec: 5 });
  await s.agent.onUpsert(react(promptId(s), '👍'));
  await finished(s);
  assert.deepEqual(s.toPeople().map((m) => m.content.text), ['Hi Ana!', 'Hi Ben!']);
  assert.ok(s.waits.every((ms) => ms >= 5000));
  assert.equal(r.ok, true);
});

test('bulk: 😢 declines and 🙏 gives a draft; nobody is messaged', async () => {
  const s = await setup();
  await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hello' });
  await s.agent.onUpsert(react(promptId(s), '😢'));
  assert.equal(s.toPeople().length, 0);
  assert.equal(s.agent.bulkRun, null);
  await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hello again' });
  await s.agent.onUpsert(react(promptId(s), '🙏'));
  assert.equal(s.toPeople().length, 0);
  assert.match(s.sent.at(-2).content.text, /Draft for 4 people/);
  assert.equal(s.sent.at(-1).content.text, 'Hello again');
});

test('bulk: stop ends it after the message in flight; the rest are reported as NOT sent', async () => {
  const s = await setup({ sleepHook: async (_ms, agent) => { if (s2.waits.length === 2) await agent.stopBulk(); } });
  const s2 = s;
  const r = await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hello' });
  await s.agent.onUpsert(react(promptId(s), '👍'));
  await finished(s);
  assert.equal(s.toPeople().length, 2);
  const a = s.agent.actions.get(r.id);
  assert.equal(a.status, 'cancelled');
  assert.deepEqual(a.recips.map((x) => x.status), ['sent', 'sent', 'skipped', 'skipped']);
  assert.match(s.sent.at(-1).content.text, /Stopped \(stopped by owner\): 2 of 4 sent, 2 NOT sent/);
  assert.equal((await s.agent.stopBulk()).error, 'not_running');
});

test('bulk: three failures in a row stop it; single failures are reported and skipped over', async () => {
  const bad = await setup({ failFor: ['2348000000002'] });
  const r1 = await bad.agent.handle({ op: 'send.bulk', all: true, text: 'Hi' });
  await bad.agent.onUpsert(react(promptId(bad), '👍'));
  await finished(bad);
  const a1 = bad.agent.actions.get(r1.id);
  assert.equal(a1.status, 'sent'); // 3 of 4 went out
  assert.deepEqual(a1.recips.map((x) => x.status), ['sent', 'failed', 'sent', 'sent']);
  assert.match(bad.sent.at(-1).content.text, /3 of 4 sent, 1 failed/);
  assert.match(bad.sent.at(-1).content.text, /Ben Okoye \(boom\)/);

  const down = await setup({ failFor: ['2348'], cfg: {} });
  const r2 = await down.agent.handle({ op: 'send.bulk', all: true, text: 'Hi' });
  await down.agent.onUpsert(react(promptId(down), '👍'));
  await finished(down);
  const a2 = down.agent.actions.get(r2.id);
  assert.equal(a2.status, 'failed');
  assert.deepEqual(a2.recips.map((x) => x.status), ['failed', 'failed', 'failed', 'skipped']);
  assert.match(a2.error, /3 failures in a row/);
});

test('bulk: pausing the agent stops a running broadcast', async () => {
  const s = await setup({ sleepHook: async (_ms, agent) => { if (s.waits.length === 1) await agent.setPaused(true, 'test'); } });
  const r = await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hi' });
  await s.agent.onUpsert(react(promptId(s), '👍'));
  await finished(s);
  assert.equal(s.toPeople().length, 1, 'paused during the pause after the first message: nobody else gets it');
  assert.equal(s.agent.actions.get(r.id).status, 'cancelled');
});

test('bulk: the same text is never sent twice to the same person within a day', async () => {
  const s = await setup();
  await s.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben'], text: 'Happy new month!' });
  await s.agent.onUpsert(react(promptId(s), '👍'));
  await finished(s);
  const again = await s.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben', 'Chidi'], text: 'Happy new month!' });
  assert.equal(again.ok, true);
  assert.equal(again.recipients, 1);
  await s.agent.onUpsert(react(promptId(s), '😢'));
  assert.deepEqual(again.skipped_people.map((x) => x.name), ['Ana', 'Ben Okoye']);
  const none = await s.agent.handle({ op: 'send.bulk', to: ['Ana'], text: 'Happy new month!' });
  assert.equal(none.error, 'no_recipients');
});

test('bulk: limits per broadcast and per day, one broadcast at a time, paused agent', async () => {
  const s = await setup({ cfg: { maxBulk: 3 } });
  const big = await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hi' });
  assert.equal(big.error, 'too_many_recipients');
  const ok = await s.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben'], text: 'Hi' });
  assert.equal(ok.ok, true);
  assert.equal((await s.agent.handle({ op: 'send.bulk', to: ['Chidi'], text: 'Other' })).error, 'bulk_busy');
  await s.agent.setPaused(true);
  assert.equal((await s.agent.handle({ op: 'send.bulk', to: ['Chidi'], text: 'Other' })).error, 'paused');

  const d = await setup({ cfg: { maxBulkPerDay: 3 } });
  await d.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben'], text: 'One' });
  await d.agent.onUpsert(react(promptId(d), '👍'));
  await finished(d);
  assert.equal((await d.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben'], text: 'Two' })).error, 'daily_limit');
});

test('bulk: needs recipients, a clean text and a clear name', async () => {
  const s = await setup();
  assert.equal((await s.agent.handle({ op: 'send.bulk', text: 'Hi' })).error, 'no_recipients');
  assert.equal((await s.agent.handle({ op: 'send.bulk', all: true, text: '  ' })).error, 'invalid_text');
  assert.equal((await s.agent.handle({ op: 'send.bulk', to: ['Ana', 'Zzyzx'], text: 'Hi' })).error, 'contact_not_found');
  assert.equal(s.sent.length, 0);
});

test('bulk: people not on WhatsApp are left out and listed', async () => {
  const s = await setup({ onWhatsApp: async (...js) => js.map((j) => ({ jid: j, exists: !j.startsWith('2348000000002') })) });
  const r = await s.agent.handle({ op: 'send.bulk', to: ['Ana', 'Ben', 'Chidi'], text: 'Hi' });
  assert.equal(r.recipients, 2);
  assert.deepEqual(r.skipped_people, [{ name: 'Ben Okoye', reason: 'not on WhatsApp' }]);
  assert.match(s.sent.at(-1).content.text, /Skipping: Ben Okoye \(not on WhatsApp\)/);
});

test('bulk: a restart mid-run never resumes by itself and tells the owner who got it', async () => {
  const s = await setup();
  const r = await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hi' });
  const a = s.agent.actions.get(r.id);
  a.status = 'sending'; a.recips[0].status = 'sent'; a.recips[0].at = s.clock.t; a.recips[1].status = 'failed';
  await s.agent.setPaused(false, 'test'); // writes the state file
  await s.agent.stop();
  const again = new Agent({ config: { dataDir: s.dir, allowed: [] }, conn: s.conn, store: createStore(), log: silent, startedAt: 0, send: (j, c, o) => s.conn.sock.sendMessage(j, c, o) }, { now: () => s.clock.t });
  await again.start();
  const b = again.actions.get(r.id);
  assert.equal(b.status, 'failed');
  assert.deepEqual(b.recips.map((x) => x.status), ['sent', 'failed', 'skipped', 'skipped']);
  assert.match(b.error, /1 sent, 3 NOT sent/);
  const before = s.sent.length;
  await again.sweep();
  assert.match(s.sent.at(-1).content.text, /Stopped \(the bot restarted\): 1 of 4 sent/);
  assert.equal(s.sent.length, before + 1);
  await again.sweep();
  assert.equal(s.sent.length, before + 1, 'told once');
  agents.push(again);
});

test('bulk: reloading the plugin ends a running broadcast cleanly', async () => {
  let release;
  const s = await setup({ sleepHook: () => new Promise((r) => { release = r; }) });
  await s.agent.handle({ op: 'send.bulk', all: true, text: 'Hi' });
  await s.agent.onUpsert(react(promptId(s), '👍'));
  assert.ok(await until(() => s.waits.length === 1));
  const stopping = s.agent.stop();
  release();
  await stopping;
  assert.equal(s.toPeople().length, 1);
  assert.match(s.sent.at(-1).content.text, /Stopped \(the bot was reloaded\)/);
});

// ---------- the agent tools ----------
test('send_bulk tool: declared, dispatched, counted as a state change, never reported as sent', async () => {
  const d = TOOL_DECLS.find((x) => x.name === 'send_bulk');
  assert.ok(d);
  assert.equal(d.parameters.properties.to.type, 'array');
  assert.deepEqual(d.parameters.required, ['text']);
  assert.ok(STATE_TOOLS.has('send_bulk'));
  const calls = [];
  await makeDispatch({ handle: async (q) => { calls.push(q); return { ok: true }; } })('send_bulk', { all_contacts: true, except: ['Mum'], text: 'Happy new month!', delay_seconds: 3 });
  assert.deepEqual(calls[0], { op: 'send.bulk', to: undefined, all: true, except: ['Mum'], text: 'Happy new month!', delay_sec: 3, source: 'voice' });
  const claim = commandReply('Sent happy new month to everyone.', [{ tool: 'send_bulk', ok: true }]);
  assert.match(claim, /react 👍/);
  assert.equal(commandReply('Asked for your OK; react to the request.', [{ tool: 'send_bulk', ok: true }]), 'Asked for your OK; react to the request.');
});
