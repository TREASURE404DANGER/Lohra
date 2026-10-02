import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const file = fileURLToPath(new URL('../plugins/yoink.js', import.meta.url));
const skip = !fs.existsSync(file) && 'plugins/yoink.js not present';
const y = skip ? {} : await import(pathToFileURL(file).href);

test('extractUrls trims punctuation, dedupes, caps at 3', { skip }, () => {
  assert.deepEqual(y.extractUrls('see (https://a.com/x?y=1). and https://a.com/x?y=1, <https://b.com/z>!'), ['https://a.com/x?y=1', 'https://b.com/z']);
  assert.equal(y.extractUrls('https://a.com https://b.com https://c.com https://d.com').length, 3);
  assert.deepEqual(y.extractUrls('no links here'), []);
});
test('parseUrl rejects bad schemes, creds, junk', { skip }, () => {
  assert.throws(() => y.parseUrl('ftp://a.com/x'), /http/);
  assert.throws(() => y.parseUrl('file:///etc/passwd'), /http/);
  assert.throws(() => y.parseUrl('https://user:pw@a.com/'), /credentials/);
  assert.throws(() => y.parseUrl('not a url'), /valid/);
  assert.throws(() => y.parseUrl(`https://a.com/${'x'.repeat(3000)}`), /too long/);
});
test('isPrivateIp', { skip }, () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1']) assert.equal(y.isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(y.isPrivateIp(ip), false, ip);
});
test('assertPublicUrl blocks internal targets, allows public', { skip }, async () => {
  const pub = async () => [{ address: '93.184.216.34' }];
  const priv = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
  for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://2130706433/x', 'http://169.254.169.254/latest', 'http://redis:6379/', 'http://foo.internal/x', 'http://192.168.0.1/']) {
    await assert.rejects(y.assertPublicUrl(u, pub), y.UserError, u);
  }
  await assert.rejects(y.assertPublicUrl('https://rebind.example/x', priv), /private/);
  await assert.rejects(y.assertPublicUrl('https://nx.example/x', async () => { throw new Error('ENOTFOUND'); }), /resolve/);
  assert.equal(await y.assertPublicUrl('https://example.com/a', pub), 'https://example.com/a');
});
test('classify maps yt-dlp errors', { skip }, () => {
  const k = (s) => y.classify(s).kind;
  assert.equal(k("ERROR: [youtube] x: Sign in to confirm you're not a bot"), 'botcheck');
  assert.equal(k('ERROR: [youtube] x: Private video. Sign in if you\'ve been granted access'), 'private');
  assert.equal(k('ERROR: [youtube] x: Video unavailable'), 'gone');
  assert.equal(k('ERROR: Unsupported URL: https://a.com'), 'unsupported');
  assert.equal(k('ERROR: Unable to download webpage: HTTP Error 404: Not Found'), 'gone');
  assert.equal(k('ERROR: Unable to download webpage: HTTP Error 503'), 'network');
  assert.equal(k('ERROR: unable to download video data: HTTP Error 403: Forbidden'), 'broken');
  assert.equal(k('ERROR: [twitter] 1: Unable to extract syndication data'), 'broken');
  assert.equal(k('HTTP Error 429: Too Many Requests'), 'ratelimit');
  assert.equal(k('x does not pass filter (!is_live), skipping'), 'live');
  assert.equal(k('[download] File is larger than max-filesize (200 bytes > 100 bytes). Aborting.'), 'toolarge');
  assert.equal(k('ERROR: something weird'), 'unknown');
  assert.equal(y.classify('Video unavailable').retry, false);
  assert.equal(y.classify('HTTP Error 502').retry, true);
});
test('buildArgs: no shell, url after "--", size cap and tiers', { skip }, () => {
  const a = y.buildArgs('https://a.com/x;rm -rf /', '/tmp/d', { h: 480 }, '/tmp/c');
  assert.equal(a.at(-2), '--'); assert.equal(a.at(-1), 'https://a.com/x;rm -rf /');
  assert.ok(a.includes('--no-playlist') && a.includes('--max-filesize') && a.includes('res:480,vcodec:h264,acodec:aac'));
  assert.ok(y.buildArgs('https://a.com', '/tmp/d', { audio: true }, '/tmp/c').includes('--audio-format'));
});
