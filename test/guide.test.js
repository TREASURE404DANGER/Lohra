import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS, find, menu, topicText, chunk, missingFrom, audienceOf } from '../plugins/_guide.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = 'Lohra ';

test('topics: unique ids, every topic has a technical text, user topics have summary + body', () => {
  const ids = TOPICS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of TOPICS) {
    assert.ok(t.dev?.summary && t.dev?.body, `${t.id}: dev text`);
    if (t.user) assert.ok(t.user.summary && t.user.body, `${t.id}: user text`);
  }
});

test('simple version stays simple: shorter than the dev text, no file names, env vars, docker or internals', () => {
  for (const t of TOPICS.filter((x) => x.user)) {
    assert.ok(t.user.body.length < t.dev.body.length, `${t.id}: user text should be shorter than dev text`);
    const text = `${t.user.summary}\n${t.user.body}`;
    assert.doesNotMatch(text, /\.js\b|\bsrc\/|\bdocker\b|[A-Z]{3,}_[A-Z_]{2,}|\bwabctl\b|\bGemini\b|\bBaileys\b|\bapi\./, `${t.id}: jargon in the user text`);
  }
});

test('placeholders: {p} is filled everywhere and nothing else is left behind', () => {
  for (const aud of ['user', 'dev']) {
    assert.doesNotMatch(menu(aud, P), /\{p\}/);
    for (const t of TOPICS.filter((x) => x[aud])) assert.doesNotMatch(topicText(t, aud, P), /\{p\}/, `${t.id}/${aud}`);
  }
  assert.match(topicText(find('watch'), 'user', P), /Lohra watch list/);
  assert.match(topicText(find('watch'), 'user', '.'), /\.watch list/);
});

test('lookup: id, alias and command names; dev-only topics are hidden from the simple version', () => {
  assert.equal(find('watch').id, 'watch');
  assert.equal(find('monitor').id, 'watch');
  assert.equal(find('story').id, 'status');
  assert.equal(find('tr').id, 'voice');
  assert.equal(find('cmd').id, 'talk');
  assert.equal(find('yes').id, 'pick');
  assert.equal(find('3').id, 'pick');
  assert.equal(find('nonsense'), null);
  assert.equal(find('arch', 'user'), null);
  assert.equal(find('arch', 'dev').id, 'arch');
  assert.equal(find('agents', 'user'), null);
  assert.equal(find('plugins', 'user').id, 'admin'); // the command, not the dev topic
});

test('audience words', () => {
  assert.equal(audienceOf('dev'), 'dev');
  assert.equal(audienceOf('Technical'), 'dev');
  assert.equal(audienceOf('watch'), 'user');
  assert.equal(audienceOf('admin'), 'user'); // "admin" is a normal topic
  assert.equal(audienceOf(undefined), 'user');
});

test('the manual explains the watch-vs-check distinction that the agent depends on', () => {
  const talk = topicText(find('talk'), 'user', P);
  assert.match(talk, /can't.*(reminders|alarms|timed)/is);
  const watch = topicText(find('watch'), 'user', P);
  assert.match(watch, /periodically/i);
  assert.match(watch, /every hour/i);
  const dev = topicText(find('agents', 'dev'), 'dev', P);
  assert.match(dev, /periodically/i);
});

test('chunk keeps messages readable and loses nothing', () => {
  for (const aud of ['user', 'dev']) {
    for (const t of TOPICS.filter((x) => x[aud])) {
      const text = topicText(t, aud, P);
      const parts = chunk(text, 1500);
      assert.equal(parts.join('\n\n'), text);
      for (const part of parts) assert.ok(part.length <= 1500 + 500, `${t.id}/${aud}: chunk too long`);
    }
  }
});

// ---- the manual must not rot: every command declared in the source is covered
function commandNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf('commands: {');
  if (i < 0) return [];
  const names = [];
  const re = /^ {4}([a-z][a-zA-Z0-9]*): \{\s*\n(?: {6}aliases: \[([^\]]*)\],?)?/gm;
  let m;
  while ((m = re.exec(src.slice(i)))) {
    names.push(m[1]);
    if (m[2]) names.push(...[...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return names;
}

test('coverage: every command in plugins/ and src/builtin/ is in the manual', (t) => {
  const dirs = [path.join(root, 'plugins'), path.join(root, 'src', 'builtin')].filter((d) => fs.existsSync(d));
  if (!dirs.length) return t.skip('no plugin sources next to the tests');
  const missing = [];
  let files = 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_') && !n.endsWith('.test.js'))) {
      const names = commandNames(path.join(dir, f));
      assert.ok(names.length, `${f}: could not find any commands (did the file style change? update commandNames in this test)`);
      files++;
      for (const n of missingFrom(names)) missing.push(`${f}: ${n}`);
    }
  }
  assert.ok(files >= 7, `expected to scan the plugins, scanned ${files}`);
  assert.deepEqual(missing, [], `commands missing from plugins/_guide.js: ${missing.join(', ')}`);
});
