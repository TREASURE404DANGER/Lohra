import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DECLS, SYSTEM_PROMPT, STATE_TOOLS, makeDispatch } from '../plugins/_agenttools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decl = (n) => TOOL_DECLS.find((d) => d.name === n);

test('declarations are well formed and every tool has a dispatcher', async () => {
  const names = TOOL_DECLS.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  const ops = [];
  const dispatch = makeDispatch({ handle: async (req) => { ops.push(req.op); return { ok: true }; } });
  for (const d of TOOL_DECLS) {
    assert.ok(d.description.length >= 30, `${d.name}: description too short to guide a model`);
    const props = Object.keys(d.parameters?.properties ?? {});
    for (const r of d.parameters?.required ?? []) assert.ok(props.includes(r), `${d.name}: required "${r}" is not a property`);
    const r = await dispatch(d.name, {});
    assert.notEqual(r.error, 'unknown_tool', `${d.name} has no dispatcher`);
  }
  assert.equal(ops.length, TOOL_DECLS.length);
});

test('the system prompt names every tool (the capability list cannot go stale)', () => {
  for (const d of TOOL_DECLS) assert.ok(SYSTEM_PROMPT.includes(d.name), `prompt never mentions ${d.name}`);
});

test('watching: the agent can set up, list and cancel an ongoing watch', async () => {
  const calls = [];
  const dispatch = makeDispatch({ handle: async (req) => { calls.push(req); return { ok: true }; } });
  await dispatch('watch_contact', { contact: 'Precious', kind: 'status', condition: 'is a meme', keep_watching: true, hours: 72 });
  await dispatch('list_watches', {});
  await dispatch('cancel_watch', { id: 'ab12' });
  assert.deepEqual(calls[0], { op: 'watch.add', contact: 'Precious', kind: 'status', condition: 'is a meme', keep_watching: true, hours: 72, source: 'voice' });
  assert.deepEqual(calls[1], { op: 'watch.list' });
  assert.deepEqual(calls[2], { op: 'watch.cancel', id: 'ab12' });
  const w = decl('watch_contact');
  assert.deepEqual(w.parameters.properties.kind.enum, ['status', 'message']);
  assert.ok(w.parameters.required.includes('keep_watching'), 'the model must decide once vs keep');
  assert.ok(STATE_TOOLS.has('watch_contact') && STATE_TOOLS.has('cancel_watch'));
});

test('routing guidance: one-time check vs ongoing watch is spelled out in the tools and the prompt', () => {
  assert.match(decl('get_contact_status').description, /one-time/i);
  assert.match(decl('get_contact_status').description, /watch_contact/);
  assert.match(decl('watch_contact').description, /periodically/i);
  assert.match(decl('watch_contact').description, /not a clock or timer/i);
  for (const cue of ['periodically', 'keep checking', 'keep an eye on', 'monitor', 'whenever', 'as soon as', 'let me know']) {
    assert.ok(SYSTEM_PROMPT.toLowerCase().includes(cue), `prompt should list the cue "${cue}"`);
  }
  assert.match(SYSTEM_PROMPT, /cannot run other scheduled jobs/i);
  assert.match(SYSTEM_PROMPT, /periodically check Precious/i); // the worked example
});

test('wabctl declares every in-bot tool (names stay in sync)', (t) => {
  const file = path.join(root, 'cli', 'wabctl');
  if (!fs.existsSync(file)) return t.skip('cli/ is not next to the tests');
  const src = fs.readFileSync(file, 'utf8');
  const cli = [...src.matchAll(/^ {4}"([a-z_]+)": dict\(/gm)].map((m) => m[1]);
  assert.ok(cli.length >= 10, 'could not read the tool list from wabctl');
  for (const d of TOOL_DECLS) assert.ok(cli.includes(d.name), `wabctl is missing tool ${d.name}`);
  const extra = cli.filter((n) => !TOOL_DECLS.some((d) => d.name === n));
  assert.deepEqual(extra, ['wait_for_action'], 'wabctl-only tools should be just wait_for_action (the in-bot agent cannot wait)');
});
