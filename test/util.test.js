import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, withTimeout, fmtDuration } from '../src/util.js';
import { backoff } from '../src/connection.js';
import { useAtomicAuthState } from '../src/auth.js';
import { silent } from './helpers.js';

test('atomicWrite writes and leaves no tmp files', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-'));
  await atomicWrite(path.join(d, 'a.json'), '{"x":1}');
  assert.equal(await fs.readFile(path.join(d, 'a.json'), 'utf8'), '{"x":1}');
  assert.deepEqual(await fs.readdir(d), ['a.json']);
});
test('withTimeout rejects slow work', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 30, 'x'), /timed out/);
  assert.equal(await withTimeout(Promise.resolve(5), 100), 5);
});
test('fmtDuration', () => { assert.equal(fmtDuration(3_723_000), '1h 2m 3s'); });
test('backoff grows and is capped', () => {
  const fixed = { rnd: () => 0.5 };
  assert.equal(backoff(0, fixed), 2000);
  assert.equal(backoff(2, fixed), 8000);
  assert.equal(backoff(20, fixed), 60000);
});
test('auth state persists and falls back to backup when creds.json is corrupt', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-'));
  const a = await useAtomicAuthState(d, silent);
  await a.saveCreds();
  await a.saveCreds();
  await a.state.keys.set({ 'pre-key': { 1: { public: Buffer.from('a'), private: Buffer.from('b') } } });
  const got = await a.state.keys.get('pre-key', ['1']);
  assert.equal(Buffer.from(got['1'].public).toString(), 'a');
  await fs.writeFile(path.join(d, 'creds.json'), '{broken');
  const b = await useAtomicAuthState(d, silent);
  assert.equal(b.state.creds.registrationId, a.state.creds.registrationId);
});
