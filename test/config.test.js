import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.prefix, '.');
  assert.equal(c.public, false);
  assert.equal(c.sendGapMs, 400);
  assert.deepEqual(c.allowed, []);
});
test('parses values', () => {
  const c = loadConfig({ PHONE_NUMBER: '+1 (555) 000-1111', ALLOWED: '111, +222 ,', PUBLIC: 'true', SEND_GAP_MS: '0', PREFIX: '!' });
  assert.equal(c.phoneNumber, '15550001111');
  assert.deepEqual(c.allowed, ['111', '222']);
  assert.equal(c.public, true);
  assert.equal(c.sendGapMs, 0);
  assert.equal(c.prefix, '!');
});
