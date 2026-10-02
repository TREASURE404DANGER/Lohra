// Run: docker exec lohra node --test /app/plugins/_didyoumean.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest, phonetic, askShape, nameScore } from './_names.js';
import { parseContacts, resolveRecipient } from './_contacts.js';
import dym from './didyoumean.js';

const raw = { 'Test Me': '+234 801 000 0001', Precious: '+234 801 000 0002', 'Precious Jr': '+234 801 000 0003', Thomas: '+234 801 000 0004', 'John Okafor': '+234 801 000 0005', Kemi: '+234 801 000 0006', Chidinma: '+234 801 000 0007', Mum: '+234 801 000 0008' };
const { contacts } = parseContacts(raw, { defaultCc: '234' });
const top = (q) => suggest(q, contacts).map((x) => x.contact.name);

test('sound-alikes and typos are suggested', () => {
  assert.equal(top('pressure')[0], 'Precious');
  assert.equal(top('presh')[0], 'Precious');
  assert.equal(top('persious')[0], 'Precious');
  assert.equal(top('tomas')[0], 'Thomas');
  assert.equal(top('jon')[0], 'John Okafor');
  assert.equal(top('kemy')[0], 'Kemi');
  assert.equal(top('chidima')[0], 'Chidinma');
  assert.equal(top('testme')[0], 'Test Me');
  assert.equal(top('mom')[0], 'Mum');
});

test('unrelated words suggest nothing', () => {
  for (const w of ['ghost', 'banana', 'zebra', 'xavier', 'hello world']) assert.deepEqual(top(w), [], w);
});

test('phonetic keys', () => {
  assert.equal(phonetic('thomas'), phonetic('tomas'));
  assert.equal(phonetic('john'), phonetic('jon'));
  assert.notEqual(phonetic('precious'), phonetic('thomas'));
  assert.equal(phonetic(''), '');
  assert.ok(nameScore('Pressure', 'precious') > 0.7);
});

test('ranking: Precious beats Precious Jr for "pressure"; both appear for an ambiguous first name', () => {
  assert.deepEqual(top('pressure').slice(0, 2), ['Precious', 'Precious Jr']);
  assert.equal(askShape(suggest('tomas', contacts)), 'single');
  assert.equal(askShape(suggest('pressure', contacts)), 'list');
});

test('resolveRecipient never auto-accepts a sound-alike; it returns suggestions', () => {
  const r = resolveRecipient(contacts, 'pressure');
  assert.equal(r.status, 'none');
  assert.equal(r.suggestions[0].name, 'Precious');
  assert.equal(resolveRecipient(contacts, 'Precious').status, 'ok');
});

// ---------------------------------------------------------------- the conversation
function rig() {
  const api = {};
  const said = [];
  return (async () => {
    await dym.init(api);
    const ctx = (command, argText = '') => ({ api, jid: 'chat1', prefix: 'Lohra ', command, args: argText ? argText.split(/\s+/) : [], argText, reply: async (t) => said.push(t) });
    const run = (command, argText) => dym.commands.pick.run(ctx(command, argText));
    return { api, said, ctx, run };
  })();
}
const pickedBy = () => { const got = []; return { got, onPick: async (c) => got.push(c.name) }; };

test('single favourite: "yes" runs the action with that contact', async () => {
  const { api, said, ctx, run } = await rig();
  const p = pickedBy();
  await api.dym.offer(ctx('watch'), { query: 'tomas', ranked: suggest('tomas', contacts), onPick: p.onPick });
  assert.match(said.at(-1), /Did you mean \*Thomas\*\?/);
  assert.match(said.at(-1), /Lohra yes/);
  await run('yes');
  assert.deepEqual(p.got, ['Thomas']);
  await run('yes');
  assert.match(said.at(-1), /Nothing is waiting/);
});

test('"no" cancels and clears the question', async () => {
  const { api, said, ctx, run } = await rig();
  const p = pickedBy();
  await api.dym.offer(ctx('watch'), { query: 'tomas', ranked: suggest('tomas', contacts), onPick: p.onPick });
  await run('n');
  assert.match(said.at(-1), /cancelled/);
  await run('yes');
  assert.deepEqual(p.got, []);
});

test('several candidates: numbered list, number picks, out-of-range is refused', async () => {
  const { api, said, ctx, run } = await rig();
  const p = pickedBy();
  await api.dym.offer(ctx('watch'), { query: 'pressure', ranked: suggest('pressure', contacts), onPick: p.onPick });
  assert.match(said.at(-1), /1\. Precious\n2\. Precious Jr/);
  await run('yes');                        // "yes" is meaningless with 2 options: ask which
  assert.match(said.at(-1), /Which one\?/);
  assert.deepEqual(p.got, []);
  await run('5');
  assert.match(said.at(-1), /Pick a number/);
  await run('2');
  assert.deepEqual(p.got, ['Precious Jr']);
});

test('"pick <name>" narrows the list, then picks when one is left', async () => {
  const { api, said, ctx, run } = await rig();
  const p = pickedBy();
  await api.dym.offer(ctx('watch'), { query: 'pressure', ranked: suggest('pressure', contacts), onPick: p.onPick });
  await run('pick', 'zzzz');
  assert.match(said.at(-1), /None of these sound like "zzzz"/);
  await run('pick', 'precious jr');
  assert.deepEqual(p.got, ['Precious Jr']);
});

test('real ambiguity is always a list; questions expire; names only, no phone numbers shown', async () => {
  const { api, said, ctx, run } = await rig();
  const p = pickedBy();
  const ranked = [contacts.find((c) => c.name === 'Precious'), contacts.find((c) => c.name === 'Precious Jr')].map((contact) => ({ contact, score: 1 }));
  await api.dym.offer(ctx('watch'), { query: 'precious', ranked, list: true, onPick: p.onPick });
  assert.match(said.at(-1), /More than one contact matches/);
  assert.ok(!/\+?234/.test(said.at(-1)), 'must not print numbers');
  api.dymPending.get('chat1').expires = Date.now() - 1;
  await run('1');
  assert.match(said.at(-1), /Nothing is waiting/);
  assert.deepEqual(p.got, []);
});
