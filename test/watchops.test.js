import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { Sender } from '../src/send.js';
import { Agent } from '../plugins/agent.js';
import { makeDispatch } from '../plugins/_agenttools.js';
import { fakeConn, silent } from './helpers.js';

const CONTACTS = { Sarah: '2348033334444', Mum: { number: '2348011112222', aliases: ['mom'] }, 'Family Group': { jid: '120363000000000001@g.us' } };
const SPEC = { ok: true, problem: '', target: 'Sarah', kind: 'status', condition: 'is a meme', rubric: 'A meme is an image with a joke caption. When unsure, do not match.', once: false, anywhere: false, ttlHours: 168 };

function fakeWatcher(clock) {
  const tasks = [];
  return {
    tasks,
    list: () => tasks,
    active: () => tasks.filter((t) => t.state === 'active'),
    async add(spec) {
      const dup = tasks.find((t) => t.state === 'active' && t.target.number === spec.target.number && t.kind === spec.kind && t.condition === (spec.condition || ''));
      if (dup) { const e = new Error('dup'); e.existing = dup; throw e; }
      const t = { id: `w${tasks.length + 1}`, state: 'active', ...spec, once: spec.once !== false, expiresAt: clock.t + spec.ttlHours * 3600e3, stats: { seen: 0, matches: 0 } };
      tasks.push(t);
      return t;
    },
    async cancel(which) {
      const hit = String(which).toLowerCase() === 'all' ? this.active() : tasks.filter((t) => t.id === which && t.state === 'active');
      for (const t of hit) { t.state = 'cancelled'; t.endedAt = clock.t; }
      return hit;
    },
  };
}

async function setup(t, { watcher = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchops-'));
  await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify(CONTACTS));
  const conn = fakeConn();
  const store = createStore();
  const sender = new Sender({ conn, store, config: { sendGapMs: 0 }, log: silent });
  const clock = { t: 1_700_000_000_000 };
  const api = { config: { dataDir: dir, allowed: [] }, conn, store, log: silent, startedAt: clock.t, send: (j, c, o) => sender.send(j, c, o) };
  const agent = new Agent(api, { now: () => clock.t });
  await agent.start();
  t.after(() => agent.stop());
  if (watcher) api.watch = fakeWatcher(clock);
  return { agent, api, sent: conn.sent, clock };
}

const realFetch = globalThis.fetch;
const realKey = process.env.GEMINI_API_KEY;
function gemini(t, handler) {
  process.env.GEMINI_API_KEY = 'test-key';
  globalThis.fetch = async (...a) => handler(...a);
  t.after(() => { globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = realKey; });
}
const ok = (spec) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(spec) }] } }] }) });

test('watch.add with a condition: the AI check is built, the watch keeps going, defaults apply', async (t) => {
  let asked = '';
  gemini(t, async (url, init) => { asked = JSON.parse(init.body).contents[0].parts[0].text; return ok(SPEC); });
  const { agent, api } = await setup(t);
  const r = await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status', condition: 'is a meme', keep_watching: true, source: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'watching');
  assert.equal(r.keep_watching, true);
  assert.equal(r.expires_in_hours, 168);
  assert.match(r.how_it_works, /not a timer/i);
  assert.match(asked, /Sarah.*status.*is a meme/s);
  const task = api.watch.tasks[0];
  assert.equal(task.once, false);
  assert.equal(task.kind, 'status');
  assert.match(task.rubric, /meme/);
  assert.equal(task.target.number, '2348033334444');
});

test('watch.add without a condition needs no AI call; keep_watching false means stop after the first match', async (t) => {
  gemini(t, async () => { throw new Error('Gemini must not be called'); });
  const { agent, api } = await setup(t);
  const r = await agent.handle({ op: 'watch.add', contact: 'mom', kind: 'message', keep_watching: false, hours: 24, source: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.condition, null);
  assert.equal(api.watch.tasks[0].once, true);
  assert.equal(api.watch.tasks[0].rubric, '');
  assert.equal(r.expires_in_hours, 24);
});

test('watch.add validation and refusals', async (t) => {
  gemini(t, async () => ok(SPEC));
  const { agent } = await setup(t);
  const code = async (req) => (await agent.handle({ op: 'watch.add', source: 'voice', ...req })).error;
  assert.equal(await code({ contact: 'Sarah', kind: 'nonsense' }), 'invalid_kind');
  assert.equal(await code({ contact: '', kind: 'status' }), 'invalid_contact');
  assert.equal(await code({ contact: 'Zebediah', kind: 'status', allowRaw: false }), 'contact_not_found');
  assert.equal(await code({ contact: 'Family Group', kind: 'status' }), 'invalid_contact'); // groups cannot be watched
  assert.equal((await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status', hours: 99999, source: 'voice' })).expires_in_hours, 720); // clamped
});

test('watch.add: engine missing, agent paused, no API key, AI check fails', async (t) => {
  gemini(t, async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) }));
  const none = await setup(t, { watcher: false });
  assert.equal((await none.agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status' })).error, 'watch_unavailable');

  const { agent } = await setup(t);
  const failed = await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status', condition: 'is a meme' });
  assert.equal(failed.error, 'rubric_failed');

  delete process.env.GEMINI_API_KEY;
  assert.equal((await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status', condition: 'is a meme' })).error, 'no_api_key');

  await agent.setPaused(true, 'test');
  const paused = await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status' });
  assert.equal(paused.error, 'paused');
});

test('an identical watch is reported, not duplicated', async (t) => {
  gemini(t, async () => ok(SPEC));
  const { agent, api } = await setup(t);
  const a = await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status', condition: 'is a meme', keep_watching: true, source: 'voice' });
  const b = await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'status', condition: 'is a meme', keep_watching: true, source: 'voice' });
  assert.equal(b.ok, true);
  assert.equal(b.status, 'already_watching');
  assert.equal(b.id, a.id);
  assert.equal(api.watch.tasks.length, 1);
});

test('never silent: outside agents (wabctl) leave a note in the owner chat, voice commands do not double up', async (t) => {
  const { agent, sent } = await setup(t);
  await agent.handle({ op: 'watch.add', contact: 'mom', kind: 'message', keep_watching: true, source: 'voice' });
  assert.equal(sent.length, 0);
  await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'message', keep_watching: false, source: 'wabctl' });
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0]), /Watching Sarah.*Lohra watch cancel/s);
});

test('watch.list and watch.cancel (by id, by name, all; cancel still works while paused)', async (t) => {
  const { agent } = await setup(t);
  await agent.handle({ op: 'watch.add', contact: 'Sarah', kind: 'message', keep_watching: true, source: 'voice' });
  await agent.handle({ op: 'watch.add', contact: 'mom', kind: 'message', keep_watching: true, source: 'voice' });
  const l = await agent.handle({ op: 'watch.list' });
  assert.equal(l.active.length, 2);
  assert.equal(l.active[0].contact, 'Sarah');
  assert.equal(l.active[0].keep_watching, true);
  assert.equal(l.active[0].hours_left, 168);

  assert.equal((await agent.handle({ op: 'watch.cancel', id: 'w1' })).cancelled[0].contact, 'Sarah');
  await agent.setPaused(true, 'test');
  const byName = await agent.handle({ op: 'watch.cancel', id: 'watching mum' });
  assert.equal(byName.ok, true);
  assert.equal(byName.cancelled.length, 1);
  assert.equal((await agent.handle({ op: 'watch.cancel', id: 'nobody' })).error, 'not_found');
  assert.equal((await agent.handle({ op: 'watch.cancel', id: '' })).error, 'invalid_id');
  const after = await agent.handle({ op: 'watch.list' });
  assert.equal(after.active.length, 0);
  assert.equal(after.recently_ended.length, 2);
});

test('through the tool layer: what Gemini calls reaches the same ops', async (t) => {
  gemini(t, async () => ok(SPEC));
  const { agent, api } = await setup(t);
  const dispatch = makeDispatch(agent);
  const r = await dispatch('watch_contact', { contact: 'Sarah', kind: 'status', condition: 'is a meme', keep_watching: true });
  assert.equal(r.status, 'watching');
  assert.equal((await dispatch('list_watches', {})).active.length, 1);
  assert.equal((await dispatch('cancel_watch', { id: 'Sarah' })).status, 'cancelled');
  assert.equal(api.watch.active().length, 0);
});
