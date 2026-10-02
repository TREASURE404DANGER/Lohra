import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const live = await import('../plugins/_agentlive.js');
const tools = await import('../plugins/_agenttools.js');
const KEY = 'AQ.TestKey1234567890abcdef';

function fakeWS(handler) {
  return class FakeWS extends EventEmitter {
    static instances = [];
    constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; FakeWS.instances.push(this); setImmediate(() => this.emit('open')); }
    reply(obj, ms = 0) { setTimeout(() => this.emit('message', Buffer.from(JSON.stringify(obj))), ms); }
    send(d) {
      const m = JSON.parse(d);
      this.sent.push(m);
      if (m.setup) return void this.reply({ setupComplete: {} });
      handler?.(m, this);
    }
    close() { setImmediate(() => this.emit('close', 1000, Buffer.from(''))); }
    terminate() {}
  };
}
const say = (ws, text, ms = 0) => ws.reply({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AA==', mimeType: 'audio/pcm' } }] }, outputTranscription: { text } } }, ms);
const done = (ws, ms = 5) => ws.reply({ serverContent: { turnComplete: true } }, ms);
const call = (ws, ...fcs) => ws.reply({ toolCall: { functionCalls: fcs.map(([name, args], i) => ({ id: `c${i + 1}`, name, args })) } });
const base = { key: KEY, decls: tools.TOOL_DECLS, system: tools.SYSTEM_PROMPT };

test('runAgentCommand: one tool round, then the reply; tool result is sent back with the call id', async () => {
  const calls = [];
  const WS = fakeWS((m, ws) => {
    if (m.clientContent) return call(ws, ['send_message', { to: 'Tomas', text: 'Running late.' }]);
    if (m.toolResponse) { say(ws, 'I asked for your approval. '); say(ws, 'Please react on your phone.', 5); done(ws, 20); }
  });
  const dispatch = async (name, args) => { calls.push([name, args]); return { ok: true, id: 'ab12', status: 'pending', to: 'Thomas' }; };
  const r = await live.runAgentCommand("Send Tomas a message saying I'm running late", { ...base, WS, dispatch });
  assert.deepEqual(calls, [['send_message', { to: 'Tomas', text: 'Running late.' }]]);
  assert.equal(r.text, 'I asked for your approval. Please react on your phone.');
  assert.deepEqual(r.trace, [{ tool: 'send_message', ok: true, error: undefined, status: 'pending' }]);
  const ws = WS.instances[0];
  assert.equal(ws.opts.headers['x-goog-api-key'], KEY);                       // key in a header only
  assert.ok(!ws.url.includes(KEY));
  assert.equal(ws.sent[0].setup.model, 'models/gemini-3.8-live');
  assert.equal(ws.sent[0].setup.tools[0].functionDeclarations.length, tools.TOOL_DECLS.length);
  assert.match(ws.sent[0].setup.systemInstruction.parts[0].text, /owner's WhatsApp assistant/);
  assert.equal(ws.sent[1].clientContent.turns[0].parts[0].text, "Send Tomas a message saying I'm running late");
  assert.deepEqual(ws.sent[2].toolResponse.functionResponses, [{ id: 'c1', name: 'send_message', response: { output: { ok: true, id: 'ab12', status: 'pending', to: 'Thomas' } } }]);
});

test('runAgentCommand: no tool call needed -> just the reply', async () => {
  const WS = fakeWS((m, ws) => { if (m.clientContent) { say(ws, "That isn't something I can do."); done(ws); } });
  const r = await live.runAgentCommand('what is the capital of France', { ...base, WS, dispatch: async () => assert.fail('no tool expected') });
  assert.equal(r.text, "That isn't something I can do.");
  assert.deepEqual(r.trace, []);
});

test('runAgentCommand: chatter before a tool call is dropped, and an early turnComplete does not end the run (async tool mode)', async () => {
  const WS = fakeWS((m, ws) => {
    if (m.clientContent) { say(ws, 'Sure, one moment.'); call(ws, ['find_contact', { query: 'Mum' }]); done(ws, 10); }   // turn ends before our answer
    if (m.toolResponse) { say(ws, 'Mum is in your contacts.'); done(ws, 30); }
  });
  const dispatch = async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true, match: { name: 'Mum' } }; };   // slower than the model's turnComplete
  const r = await live.runAgentCommand('who is mum', { ...base, WS, dispatch });
  assert.equal(r.text, 'Mum is in your contacts.');
});

test('runAgentCommand: several calls in one turn are answered together; a throwing tool becomes an error result', async () => {
  const WS = fakeWS((m, ws) => {
    if (m.clientContent) return call(ws, ['list_contacts', {}], ['bot_status', {}]);
    if (m.toolResponse) { say(ws, 'Done.'); done(ws); }
  });
  const dispatch = async (name) => { if (name === 'bot_status') throw new Error('boom'); return { ok: true }; };
  const r = await live.runAgentCommand('status and contacts', { ...base, WS, dispatch });
  assert.equal(r.text, 'Done.');
  const resp = WS.instances[0].sent.find((x) => x.toolResponse).toolResponse.functionResponses;
  assert.equal(resp.length, 2);
  assert.deepEqual(resp[1].response.output, { ok: false, error: 'internal', message: 'boom' });
});

test('runAgentCommand: a runaway model is stopped after maxCalls, and the error says what already ran', async () => {
  const WS = fakeWS((m, ws) => { if (m.clientContent || m.toolResponse) call(ws, ['draft_message', { to: 'Mum', text: 'hi' }]); });
  let n = 0;
  await assert.rejects(
    live.runAgentCommand('loop', { ...base, WS, maxCalls: 3, dispatch: async () => { n++; return { ok: true, status: 'drafted' }; } }),
    (e) => e.code === 'rejected' && e.trace.length === 3 && e.trace.every((x) => x.tool === 'draft_message'),
  );
  assert.equal(n, 3);
});

test('runAgentCommand: a dropped connection after a tool ran still reports the trace', async () => {
  const WS = fakeWS((m, ws) => {
    if (m.clientContent) return call(ws, ['send_message', { to: 'Mum', text: 'hi' }]);
    if (m.toolResponse) ws.emit('close', 1013, Buffer.from('quota exhausted'));
  });
  await assert.rejects(
    live.runAgentCommand('send', { ...base, WS, dispatch: async () => ({ ok: true, status: 'pending' }) }),
    (e) => e.code === 'quota' && e.trace.length === 1 && e.trace[0].tool === 'send_message',
  );
});

test('runAgentCommand: refuses without a key or with an empty command, before connecting', async () => {
  const WS = fakeWS();
  await assert.rejects(live.runAgentCommand('hi', { ...base, key: '', WS, dispatch: async () => ({}) }), { code: 'auth' });
  await assert.rejects(live.runAgentCommand('   ', { ...base, WS, dispatch: async () => ({}) }), { code: 'skip' });
  assert.equal(WS.instances.length, 0);
});

// ---------- tool surface ----------
test('tool declarations and rules mention the new reactions only', () => {
  const all = JSON.stringify(tools.TOOL_DECLS) + tools.SYSTEM_PROMPT;
  for (const e of ['👍', '🙏', '😢']) assert.ok(all.includes(e), e);
  for (const e of ['👎', '✍']) assert.ok(!all.includes(e), `${e} is gone`);
  assert.ok(!tools.TOOL_DECLS.some((t) => t.name === 'wait_for_action'));
  assert.ok(!tools.TOOL_DECLS.some((t) => /approve/i.test(t.name)));           // the agent has no way to approve
  assert.deepEqual(tools.TOOL_DECLS.map((t) => t.name).sort(), ['bot_status', 'cancel_action', 'cancel_watch', 'check_action', 'deliver_to_owner', 'draft_message', 'find_contact', 'find_messages', 'get_contact_status', 'list_contacts', 'list_pending', 'list_watches', 'notify_owner', 'send_bulk', 'send_message', 'watch_contact']);
});

test('makeDispatch: maps each tool to the Agent operation, drops non-string arguments, rejects unknown tools', async () => {
  const seen = [];
  const agent = { handle: async (req) => { seen.push(req); return { ok: true }; } };
  const d = tools.makeDispatch(agent);
  await d('send_message', { to: 'Thomas', text: 'hi', op: 'cancel', extra: 1 });
  await d('draft_message', { to: { evil: true }, text: 42 });
  await d('find_contact', { query: 'Tomas' });
  await d('list_pending', {});
  assert.deepEqual(seen[0], { op: 'send', to: 'Thomas', text: 'hi', source: 'voice' });      // an "op" smuggled in the arguments is ignored
  assert.deepEqual(seen[1], { op: 'draft', to: undefined, text: undefined, source: 'voice' });
  assert.deepEqual(seen[2], { op: 'contacts.find', query: 'Tomas' });
  assert.deepEqual(seen[3], { op: 'list' });
  assert.equal((await d('approve_action', { id: 'x' })).error, 'unknown_tool');
  assert.equal((await d('send_message', null)).ok, true);                                   // bad args object tolerated
  assert.equal((await tools.makeDispatch({ handle: async () => { throw new Error('x'); } })('bot_status', {})).error, 'internal');
});

// ---------- the phrase ----------
test('parseVoiceCommand: only a note that ENDS with "this is a command" counts', () => {
  const p = tools.parseVoiceCommand;
  assert.deepEqual(p("Tell Thomas I'm running late, this is a command."), { command: "Tell Thomas I'm running late" });
  assert.deepEqual(p('Send mum a message saying call me. This is a command'), { command: 'Send mum a message saying call me.' });
  assert.deepEqual(p('THIS IS A COMMAND!'), { command: '' });                             // nothing before it
  assert.deepEqual(p('draft a note to Sarah - "this is a command"'), { command: 'draft a note to Sarah' });
  assert.deepEqual(p('text Sarah hello… this is a command…'), { command: 'text Sarah hello…' });
  for (const no of [
    'this is a command to Thomas that he should call me',      // phrase not at the end
    'send mum a message this is the command',                   // not the exact words
    'send mum a message this is command',
    'send mum a message this is a commando',
    'send mum a message this is a command center',
    'this is a command and then some more',
    'thisisa command', 'Lohra ping', '', null, undefined,
  ]) assert.equal(p(no), null, String(no));
});

// ---------- the reply guard ----------
test('commandReply: a "sent" claim after a send request is replaced; honest replies pass through', () => {
  const asked = [{ tool: 'send_message', ok: true, status: 'pending' }];
  assert.match(tools.commandReply('Done, I sent it to Thomas.', asked), /asked for your OK.*👍.*🙏.*😢/);
  assert.match(tools.commandReply('Message delivered!', asked), /asked for your OK/);
  assert.match(tools.commandReply('', asked), /asked for your OK/);
  assert.equal(tools.commandReply('I asked for your approval, please react on your phone.', asked), 'I asked for your approval, please react on your phone.');
  assert.equal(tools.commandReply('Nothing has been sent yet. Waiting for you.', asked), 'Nothing has been sent yet. Waiting for you.');
  assert.equal(tools.commandReply('More than one Thomas. Which one?', [{ tool: 'send_message', ok: false, error: 'ambiguous_contact' }]), 'More than one Thomas. Which one?');
  assert.equal(tools.commandReply("I can't do that.", []), "I can't do that.");
  assert.equal(tools.commandReply('', []), "I didn't hear a request I can act on.");
  assert.equal(tools.commandReply('', [{ tool: 'list_pending', ok: true }]), 'Done.');
  assert.ok(tools.STATE_TOOLS.has('send_message') && !tools.STATE_TOOLS.has('find_contact'));
});
