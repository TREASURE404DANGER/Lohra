import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { Sender } from '../src/send.js';
import { Agent } from '../plugins/agent.js';
import { parseContacts, resolveRecipient, classifyEmoji, classifyWord, normalizeNumber, parseContactInput, saveContact, deleteContact } from '../plugins/_contacts.js';
import agentPlugin from '../plugins/agent.js';
import { fakeConn, silent, until } from './helpers.js';

const CONTACTS = {
  _note: 'ignored',
  Thomas: '+234 801 234 5678',
  'Thomas Okafor': { number: '2348099990001', aliases: ['tom o'] },
  Mum: { number: '2348011112222', aliases: ['mom', 'mother'] },
  Sarah: '2348033334444',
  'Family Group': { jid: '120363000000000001@g.us' },
  Broken: 'abc',
};
const book = () => parseContacts(CONTACTS).contacts;

async function setup(contacts = CONTACTS, cfg) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-'));
  await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify(contacts));
  if (cfg) { await fs.mkdir(path.join(dir, 'agent')); await fs.writeFile(path.join(dir, 'agent', 'config.json'), JSON.stringify(cfg)); }
  const conn = fakeConn();
  conn.sock.onWhatsApp = async (j) => [{ jid: j, exists: !j.startsWith('2340000') }];
  const store = createStore();
  const sender = new Sender({ conn, store, config: { sendGapMs: 0 }, log: silent });
  const clock = { t: 1_700_000_000_000 };
  const api = { config: { dataDir: dir, allowed: [] }, conn, store, log: silent, startedAt: clock.t, send: (j, c, o) => sender.send(j, c, o) };
  const agent = new Agent(api, { now: () => clock.t });
  await agent.start();
  return { dir, conn, api, agent, clock, sent: conn.sent, self: '15550001111@s.whatsapp.net' };
}
const react = (targetId, text, fromMe = true) => ({ messages: [{ key: { id: `R${Math.random()}`, fromMe, remoteJid: '15550001111@s.whatsapp.net' }, message: { reactionMessage: { key: { id: targetId }, text } } }] });
const reply = (stanzaId, text, fromMe = true) => ({ messages: [{ key: { id: `T${Math.random()}`, fromMe, remoteJid: '15550001111@s.whatsapp.net' }, message: { extendedTextMessage: { text, contextInfo: { stanzaId } } } }] });

// ---------- contacts ----------
test('contacts: parses maps, ignores _keys, reports broken entries', () => {
  const { contacts, warnings } = parseContacts(CONTACTS);
  assert.equal(contacts.length, 5);
  assert.ok(warnings.some((w) => w.startsWith('Broken')));
  assert.equal(contacts.find((c) => c.name === 'Thomas').number, '2348012345678');
  assert.equal(contacts.find((c) => c.name === 'Family Group').group, true);
});

test('contacts: exact, alias, partial, fuzzy', () => {
  const c = book();
  const r = (q) => resolveRecipient(c, q);
  assert.equal(r('thomas').contact.name, 'Thomas');
  assert.equal(r('THOMAS').matchedBy, 'exact');
  assert.equal(r('mom').contact.name, 'Mum');
  assert.equal(r('Thomas Okafor').contact.name, 'Thomas Okafor');
  assert.equal(r('Tomas').status, 'ambiguous');           // misheard, and two Thomases: ask
  assert.equal(resolveRecipient(c.filter((x) => x.name !== 'Thomas Okafor'), 'Tomas').contact.name, 'Thomas');
  assert.equal(r('sara').contact.name, 'Sarah');
  assert.equal(r('sarh').matchedBy, 'fuzzy');
  assert.equal(r('fam').contact.name, 'Family Group');
});

test('contacts: ambiguity and misses', () => {
  const c = parseContacts({ 'Thomas A': '2348000000001', 'Thomas B': '2348000000002', Zed: '2348000000003' }).contacts;
  const amb = resolveRecipient(c, 'thomas');
  assert.equal(amb.status, 'ambiguous');
  assert.equal(amb.candidates.length, 2);
  assert.equal(resolveRecipient(c, 'xylophone').status, 'none');
  assert.equal(resolveRecipient(c, '').status, 'invalid');
});

test('contacts: raw numbers, jids, policy', () => {
  const c = book();
  assert.equal(resolveRecipient(c, '+44 7700 900123').contact.number, '447700900123');
  assert.equal(resolveRecipient(c, '0801 234 5678').error, 'needs_country_code');
  assert.equal(resolveRecipient(c, '0801 234 5678', { defaultCc: '234' }).contact.number, '2348012345678');
  assert.equal(resolveRecipient(c, '+44 7700 900123', { allowRaw: false }).status, 'blocked');
  assert.equal(resolveRecipient(c, '+234 801 234 5678', { allowRaw: false }).contact.name, 'Thomas'); // known number is fine
  assert.equal(normalizeNumber('12').error, 'invalid_number');
});

test('classify reactions and replies', () => {
  assert.equal(classifyEmoji('👍'), 'approve');
  assert.equal(classifyEmoji('👍🏽'), 'approve');
  assert.equal(classifyEmoji('🙏'), 'draft');
  assert.equal(classifyEmoji('🙏🏾'), 'draft');
  assert.equal(classifyEmoji('😢'), 'decline');
  assert.equal(classifyEmoji('😂'), null);
  for (const old of ['✍️', '📝', '👎', '❌', '🚫', '✅', '👌']) assert.equal(classifyEmoji(old), null, `${old} no longer decides anything`);
  assert.equal(classifyEmoji(''), null);
  assert.equal(classifyWord('Yes'), 'approve');
  assert.equal(classifyWord('draft.'), 'draft');
  assert.equal(classifyWord('no'), 'decline');
  assert.equal(classifyWord('✅ Sent to Thomas.'), null);
});

// ---------- flow ----------
test('send: proposes, sends nothing, approval by 👍 sends to the recipient', async () => {
  const { agent, sent, self } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Thomas', text: 'running late\nstart without me' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, self);
  assert.match(sent[0].content.text, /Send this message\?/);
  assert.match(sent[0].content.text, /> running late\n> start without me/);
  assert.match(sent[0].content.text, /\+2348012345678/);

  await agent.onUpsert(react('OUT1', '👍'));
  const s = await agent.handle({ op: 'get', id: r.id });
  assert.equal(s.status, 'sent');
  const out = sent.find((x) => x.jid === '2348012345678@s.whatsapp.net');
  assert.deepEqual(out.content, { text: 'running late\nstart without me' });
  assert.ok(sent.some((x) => x.jid === self && /Sent to Thomas/.test(x.content.text)));
  await agent.stop();
});

test('send: nothing leaves without an owner decision; other emojis and non-owners are ignored', async () => {
  const { agent, sent } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Mum', text: 'hi' });
  await agent.onUpsert(react('OUT1', '😂'));
  await agent.onUpsert(react('OUT1', '👍', false));
  await agent.onUpsert(reply('OUT1', 'yes', false));
  await agent.onUpsert(react('SOMETHING_ELSE', '👍'));
  assert.equal((await agent.handle({ op: 'get', id: r.id })).status, 'pending');
  assert.equal(sent.length, 1);
  await agent.stop();
});

test('🙏 draft reaction drops the text in your own chat with a wa.me link, sends nothing to the recipient', async () => {
  const { agent, sent, self } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Sarah', text: 'Dinner at 8? & bring wine' });
  await agent.onUpsert(react('OUT1', '🙏'));
  assert.equal((await agent.handle({ op: 'get', id: r.id })).status, 'drafted');
  assert.ok(sent.every((x) => x.jid === self));
  assert.match(sent[1].content.text, /wa\.me\/2348033334444\?text=Dinner%20at%208%3F%20%26%20bring%20wine/);
  assert.equal(sent[2].content.text, 'Dinner at 8? & bring wine');
  await agent.stop();
});

test('decline and text replies', async () => {
  const { agent, sent } = await setup();
  const a = await agent.handle({ op: 'send', to: 'Mum', text: 'one' });
  await agent.onUpsert(react('OUT1', '😢'));
  assert.equal((await agent.handle({ op: 'get', id: a.id })).status, 'declined');
  assert.ok(!sent.some((x) => x.jid.startsWith('2348011112222')));

  const b = await agent.handle({ op: 'send', to: 'Mum', text: 'two' });
  await agent.onUpsert(reply(`OUT${sent.length}`, 'yes'));
  assert.equal((await agent.handle({ op: 'get', id: b.id })).status, 'sent');
  assert.ok(sent.some((x) => x.jid === '2348011112222@s.whatsapp.net' && x.content.text === 'two'));
  await agent.stop();
});

test('a decision applies once', async () => {
  const { agent, sent } = await setup();
  await agent.handle({ op: 'send', to: 'Mum', text: 'once' });
  await agent.onUpsert(react('OUT1', '👍'));
  await agent.onUpsert(react('OUT1', '👍'));
  assert.equal(sent.filter((x) => x.jid === '2348011112222@s.whatsapp.net').length, 1);
  await agent.stop();
});

test('expiry: late approval does not send', async () => {
  const { agent, sent, clock } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Mum', text: 'late', ttl: 60 });
  clock.t += 61_000;
  await agent.onUpsert(react('OUT1', '👍'));
  assert.equal((await agent.handle({ op: 'get', id: r.id })).status, 'expired');
  assert.ok(!sent.some((x) => x.jid === '2348011112222@s.whatsapp.net'));
  await agent.stop();
});

test('sweep expires pending requests and tells the owner', async () => {
  const { agent, sent, clock } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Mum', text: 'x', ttl: 30 });
  clock.t += 31_000;
  await agent.sweep();
  assert.equal((await agent.handle({ op: 'get', id: r.id })).status, 'expired');
  assert.match(sent.at(-1).content.text, /Expired/);
  await agent.stop();
});

test('draft op goes straight to your chat, no approval', async () => {
  const { agent, sent, self } = await setup();
  const r = await agent.handle({ op: 'draft', to: 'Thomas', text: 'hello' });
  assert.equal(r.status, 'drafted');
  assert.ok(sent.every((x) => x.jid === self));
  await agent.stop();
});

test('validation: ambiguous, unknown, bad text, not on WhatsApp, offline', async () => {
  const { agent, sent, conn } = await setup({ 'Thomas A': '2348000000001', 'Thomas B': '2348000000002', Ghost: '2340000000009' });
  const amb = await agent.handle({ op: 'send', to: 'thomas', text: 'x' });
  assert.equal(amb.error, 'ambiguous_contact');
  assert.equal(amb.candidates.length, 2);
  assert.ok(!JSON.stringify(amb).includes('2348000000001'));
  assert.equal((await agent.handle({ op: 'send', to: 'nobody', text: 'x' })).error, 'contact_not_found');
  assert.equal((await agent.handle({ op: 'send', to: 'Ghost', text: 'x' })).error, 'not_on_whatsapp');
  assert.equal((await agent.handle({ op: 'send', to: 'Ghost', text: '  ' })).error, 'invalid_text');
  assert.equal((await agent.handle({ op: 'send', to: 'Ghost', text: 'a\u0000b' })).error, 'invalid_text');
  conn.state = 'connecting';
  assert.equal((await agent.handle({ op: 'send', to: 'Thomas A', text: 'x' })).error, 'bot_offline');
  assert.equal(sent.length, 0);
  await agent.stop();
});

test('limits: duplicates, max pending, pause', async () => {
  const { agent } = await setup(CONTACTS, { maxPending: 2 });
  const a = await agent.handle({ op: 'send', to: 'Mum', text: 'same' });
  const b = await agent.handle({ op: 'send', to: 'Mum', text: 'same' });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  await agent.handle({ op: 'send', to: 'Mum', text: 'other' });
  assert.equal((await agent.handle({ op: 'send', to: 'Mum', text: 'third' })).error, 'too_many_pending');
  assert.equal(await agent.setPaused(true), 2);
  assert.equal((await agent.handle({ op: 'get', id: a.id })).status, 'cancelled');
  assert.equal((await agent.handle({ op: 'send', to: 'Sarah', text: 'x' })).error, 'paused');
  await agent.setPaused(false);
  assert.equal((await agent.handle({ op: 'send', to: 'Sarah', text: 'x' })).ok, true);
  await agent.stop();
});

test('agent can cancel its own pending request, not a finished one', async () => {
  const { agent } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Mum', text: 'c' });
  assert.equal((await agent.handle({ op: 'cancel', id: r.id })).status, 'cancelled');
  assert.equal((await agent.handle({ op: 'cancel', id: r.id })).error, 'not_pending');
  await agent.stop();
});

test('raw numbers can be disabled', async () => {
  const { agent } = await setup(CONTACTS, { allowRawNumbers: false });
  assert.equal((await agent.handle({ op: 'send', to: '+447700900123', text: 'x' })).error, 'raw_numbers_disabled');
  assert.equal((await agent.handle({ op: 'send', to: 'Mum', text: 'x' })).ok, true);
  await agent.stop();
});

test('state survives a restart: pending can still be approved, interrupted sends are marked failed', async () => {
  const { agent, api, dir, clock, sent } = await setup();
  const r = await agent.handle({ op: 'send', to: 'Mum', text: 'persist' });
  await agent.stop();
  const again = new Agent(api, { now: () => clock.t });
  await again.start();
  assert.equal((await again.handle({ op: 'get', id: r.id })).status, 'pending');
  await again.onUpsert(react('OUT1', '👍'));
  assert.equal((await again.handle({ op: 'get', id: r.id })).status, 'sent');
  await again.stop();

  const st = JSON.parse(await fs.readFile(path.join(dir, 'agent', 'state.json'), 'utf8'));
  st.actions[r.id].status = 'sending';
  await fs.writeFile(path.join(dir, 'agent', 'state.json'), JSON.stringify(st));
  const third = new Agent(api, { now: () => clock.t });
  await third.start();
  const g = await third.handle({ op: 'get', id: r.id });
  assert.equal(g.status, 'failed');
  assert.match(g.error, /interrupted/);
  assert.ok(sent.length > 0);
  await third.stop();
});

test('audit log records the lifecycle', async () => {
  const { agent, dir } = await setup();
  await agent.handle({ op: 'send', to: 'Mum', text: 'audit me' });
  await agent.onUpsert(react('OUT1', '😢'));
  await agent.stop();
  const lines = (await fs.readFile(path.join(dir, 'agent', 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['proposed', 'declined']);
});

test('control socket round trip (0600) and cleanup on stop', async () => {
  const { agent, dir } = await setup();
  const sock = path.join(dir, 'agent', 'control.sock');
  assert.equal((await fs.stat(sock)).mode & 0o777, 0o600);
  const call = (req) => new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => resolve(JSON.parse(buf)));
    c.on('error', reject);
    c.write(JSON.stringify(req) + '\n');
  });
  assert.equal((await call({ op: 'ping' })).pong, true);
  const r = await call({ op: 'send', to: 'Mum', text: 'over the socket' });
  assert.equal(r.status, 'pending');
  assert.equal((await call({ op: 'nope' })).error, 'unknown_op');
  const list = await call({ op: 'contacts.list' });
  assert.ok(list.contacts.every((c) => !('number' in c)));
  await agent.stop();
  assert.equal(await until(() => true), true);
});


// ---------- contact commands & parsing ----------
test('parseContactInput handles natural language variations', () => {
  assert.deepEqual(parseContactInput('09012345678 as Thomas alias Mr. T'), {
    number: '09012345678', name: 'Thomas', aliases: ['Mr. T'], note: ''
  });
  assert.deepEqual(parseContactInput('add contact 2349012345678 as Thomas alias Mr. T'), {
    number: '2349012345678', name: 'Thomas', aliases: ['Mr. T'], note: ''
  });
  assert.deepEqual(parseContactInput('add contact +2349012345678 as Thomas alias Mr. T, Tommy note Best dev'), {
    number: '+2349012345678', name: 'Thomas', aliases: ['Mr. T', 'Tommy'], note: 'Best dev'
  });
  assert.deepEqual(parseContactInput('add contact 08012345678 as Mum'), {
    number: '08012345678', name: 'Mum', aliases: [], note: ''
  });
  assert.deepEqual(parseContactInput('Thomas as 09012345678 alias Tommy'), {
    name: 'Thomas', number: '09012345678', aliases: ['Tommy'], note: ''
  });
  assert.deepEqual(parseContactInput('Thomas 09012345678 alias Tommy'), {
    name: 'Thomas', number: '09012345678', aliases: ['Tommy'], note: ''
  });
  assert.equal(parseContactInput('invalid junk text'), null);
});

test('saveContact and deleteContact normalize numbers and update contacts.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contacts-test-'));
  const file = path.join(dir, 'contacts.json');

  // 1. Add Nigerian 090... number with defaultCc '234'
  const r1 = await saveContact(file, { name: 'Thomas', number: '09012345678', aliases: ['Mr. T'], defaultCc: '234' });
  assert.equal(r1.ok, true);
  assert.equal(r1.number, '+2349012345678');
  assert.deepEqual(r1.aliases, ['Mr. T']);
  assert.equal(r1.updated, false);

  // 2. Add with 234... (no +)
  const r2 = await saveContact(file, { name: 'Mum', number: '2348011112222', defaultCc: '234' });
  assert.equal(r2.ok, true);
  assert.equal(r2.number, '+2348011112222');

  // 3. Update existing contact Thomas
  const r3 = await saveContact(file, { name: 'Thomas', number: '+2349012345678', aliases: ['Mr. T', 'Tommy'], note: 'Friend', defaultCc: '234' });
  assert.equal(r3.ok, true);
  assert.equal(r3.updated, true);
  assert.deepEqual(r3.aliases, ['Mr. T', 'Tommy']);
  assert.equal(r3.note, 'Friend');

  // Verify file contents
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.Thomas.number, '+2349012345678');
  assert.deepEqual(disk.Thomas.aliases, ['Mr. T', 'Tommy']);
  assert.equal(disk.Mum, '+2348011112222');

  // 4. Delete Mum
  const rDel = await deleteContact(file, 'mum');
  assert.equal(rDel.ok, true);
  assert.equal(rDel.removed, 'Mum');
  const diskAfter = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(diskAfter.Mum, undefined);
  assert.ok(diskAfter.Thomas);
});

test('agent contact command adds, lists, and removes via WhatsApp command interface', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cnt-'));
  const conn = fakeConn();
  const store = createStore();
  const api = { config: { dataDir: dir, allowed: [] }, conn, store, log: silent, startedAt: 1000, send: async () => ({}) };
  await agentPlugin.init(api);

  const replies = [];
  const makeCtx = (command, argText) => ({
    command,
    argText,
    args: argText ? argText.split(/\s+/) : [],
    reply: async (msg) => { replies.push(msg); },
    react: async () => {},
  });

  // Test "Lohra add contact 09012345678 as Thomas alias Mr. T"
  await agentPlugin.commands.contact.run(makeCtx('add', 'contact 09012345678 as Thomas alias Mr. T'));
  assert.ok(replies.some((t) => t.includes('Saved contact *Thomas*') && t.includes('+2349012345678') && t.includes('Mr. T')));

  // Test "Lohra contacts" (list)
  replies.length = 0;
  await agentPlugin.commands.contact.run(makeCtx('contacts', ''));
  assert.ok(replies.some((t) => t.includes('*Contacts (1)*') && t.includes('Thomas')));

  // Test "Lohra contact remove Thomas"
  replies.length = 0;
  await agentPlugin.commands.contact.run(makeCtx('contact', 'remove Thomas'));
  assert.ok(replies.some((t) => t.includes('Removed contact "Thomas"')));

  await agentPlugin.dispose();
});

test('agent command handles text instructions via command/cmd', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cmd-'));
  const conn = fakeConn();
  const store = createStore();
  const api = { config: { dataDir: dir, allowed: [] }, conn, store, log: silent, startedAt: 1000, send: async () => ({}) };
  await agentPlugin.init(api);

  const replies = [];
  const makeCtx = (argText) => ({
    command: 'command',
    argText,
    args: argText ? argText.split(/\s+/) : [],
    reply: async (msg) => { replies.push(msg); },
    react: async () => {},
  });

  // Empty instruction gives usage
  await agentPlugin.commands.command.run(makeCtx(''));
  assert.ok(replies.some((t) => t.includes('Usage: Lohra command')));

  // Paused agent reports paused
  replies.length = 0;
  await api.agent.setPaused(true);
  await agentPlugin.commands.command.run(makeCtx('tell Thomas I am late'));
  assert.ok(replies.some((t) => t.includes('Agent actions are paused')));

  // No Gemini key reports missing key
  delete process.env.GEMINI_API_KEY;
  await api.agent.setPaused(false);
  replies.length = 0;
  await agentPlugin.commands.command.run(makeCtx('tell Thomas I am late'));
  assert.ok(replies.some((t) => t.includes('Gemini API key is not configured')));

  // Mock runCommand to test successful execution
  replies.length = 0;
  process.env.GEMINI_API_KEY = 'mock_key';
  api.agent.runCommand = async () => ({
    text: 'I asked for your approval.',
    trace: [{ tool: 'send_message', ok: true, status: 'pending' }]
  });
  await agentPlugin.commands.command.run(makeCtx('tell Thomas I will be late'));
  assert.ok(replies.some((t) => t.includes('🤖') && t.includes('approval')));

  await agentPlugin.dispose();
});
