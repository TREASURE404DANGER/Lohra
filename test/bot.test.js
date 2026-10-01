import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store.js';
import { Sender } from '../src/send.js';
import { PluginManager } from '../src/plugins.js';
import { Bot, parseCommand, extractText, digitsOf } from '../src/bot.js';
import { fakeConn, silent, until, sleep } from './helpers.js';

test('parseCommand', () => {
  assert.deepEqual(parseCommand('.Ping a  b', '.'), { name: 'ping', args: ['a', 'b'], argText: 'a  b' });
  assert.equal(parseCommand('hello', '.'), null);
  assert.equal(parseCommand('. ', '.'), null);
  assert.equal(parseCommand('...', '.'), null);
  const p = parseCommand('LOHRA   PiNg  x', 'Lohra');
  assert.deepEqual(p, { name: 'ping', args: ['x'], argText: 'x' });
  assert.equal(parseCommand('lohraping', 'Lohra'), null);
  assert.equal(parseCommand('lohra', 'Lohra'), null);
  assert.equal(parseCommand('hello lohra ping', 'Lohra'), null);
});
test('extractText / digitsOf', () => {
  assert.equal(extractText({ extendedTextMessage: { text: 'x' } }), 'x');
  assert.equal(extractText({ imageMessage: { caption: 'c' } }), 'c');
  assert.equal(extractText(null), '');
  assert.equal(digitsOf('15550001111:12@s.whatsapp.net'), '15550001111');
});
test('Sender keeps order, marks sent ids', async () => {
  const conn = fakeConn(); const store = createStore();
  const s = new Sender({ conn, store, config: { sendGapMs: 0 }, log: silent });
  await Promise.all([s.send('a@s.whatsapp.net', { text: '1' }), s.send('a@s.whatsapp.net', { text: '2' })]);
  assert.deepEqual(conn.sent.map((x) => x.content.text), ['1', '2']);
  assert.ok(store.isSent('OUT1'));
});

async function setup(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pl-'));
  const config = loadConfig({ PLUGINS_DIR: dir, SEND_GAP_MS: '0', ...env });
  const conn = fakeConn(); const store = createStore();
  const sender = new Sender({ conn, store, config, log: silent });
  const api = { config, conn, store, log: silent, startedAt: Date.now() };
  const plugins = new PluginManager({ config, log: silent, api, conn });
  api.plugins = plugins;
  const bot = new Bot({ config, conn, store, log: silent, plugins, sender });
  await plugins.reload(); bot.start();
  return { dir, config, conn, store, plugins, bot };
}
const msg = (text, extra = {}) => ({
  key: { remoteJid: '15559998888@s.whatsapp.net', fromMe: false, id: `M${Math.random()}`, ...extra.key },
  message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), ...extra.top,
});
const up = (conn, ...messages) => conn.emit('messages.upsert', { type: 'notify', messages });

test('owner (fromMe) command gets a reply', async () => {
  const { conn } = await setup();
  up(conn, msg('.ping', { key: { fromMe: true } }));
  assert.ok(await until(() => conn.sent.length === 1));
  assert.match(conn.sent[0].content.text, /^pong/);
});
test('strangers are ignored unless PUBLIC; owner-only stays blocked', async () => {
  let t = await setup();
  up(t.conn, msg('.ping')); await sleep(80);
  assert.equal(t.conn.sent.length, 0);
  t = await setup({ PUBLIC: 'true' });
  up(t.conn, msg('.ping'), msg('.status'));
  assert.ok(await until(() => t.conn.sent.length === 2));
  assert.deepEqual(t.conn.sent.map((x) => x.content.text).sort().map((s) => s.slice(0, 4)), ['Owne', 'pong']);
});
test('ALLOWED numbers can run commands', async () => {
  const { conn } = await setup({ ALLOWED: '15559998888' });
  up(conn, msg('.status'));
  assert.ok(await until(() => conn.sent.length === 1));
  assert.match(conn.sent[0].content.text, /State: open/);
});
test('stale, own-output and non-notify messages are ignored', async () => {
  const { conn, store } = await setup();
  up(conn, msg('.ping', { key: { fromMe: true }, top: { messageTimestamp: Math.floor(Date.now() / 1000) - 3600 } }));
  store.markSent('SELF1'); up(conn, msg('.ping', { key: { fromMe: true, id: 'SELF1' } }));
  conn.emit('messages.upsert', { type: 'append', messages: [msg('.ping', { key: { fromMe: true } })] });
  await sleep(100);
  assert.equal(conn.sent.length, 0);
});
test('plugins load, isolate failures, and hot reload', async () => {
  const { dir, conn, plugins } = await setup();
  await fs.writeFile(path.join(dir, 'good.js'), "export default { name:'good', commands:{ yo:{ run: c => c.reply('yo '+c.argText) } } }");
  await fs.writeFile(path.join(dir, 'bad.js'), 'throw new Error("boom")');
  await fs.writeFile(path.join(dir, 'dup.js'), "export default { name:'dup', commands:{ ping:{ run(){} } } }");
  await fs.writeFile(path.join(dir, '_ignored.js'), 'throw new Error("never loaded")');
  const r = await plugins.reload();
  assert.equal(r.failed.length, 2);
  assert.ok(plugins.resolve('yo') && plugins.resolve('ping').plugin === 'core');
  up(conn, msg('.yo there', { key: { fromMe: true } }));
  assert.ok(await until(() => conn.sent.length === 1));
  assert.equal(conn.sent[0].content.text, 'yo there');
  await fs.rm(path.join(dir, 'good.js'));
  await plugins.reload();
  assert.equal(plugins.resolve('yo'), undefined);
});
test('a crashing command reports an error and the bot keeps working', async () => {
  const { dir, conn, plugins } = await setup();
  await fs.writeFile(path.join(dir, 'crash.js'), "export default { name:'crash', commands:{ crash:{ run(){ throw new Error('nope') } } } }");
  await plugins.reload();
  up(conn, msg('.crash', { key: { fromMe: true } }));
  assert.ok(await until(() => conn.sent.length === 1));
  assert.match(conn.sent[0].content.text, /Command failed: nope/);
  up(conn, msg('.ping', { key: { fromMe: true } }));
  assert.ok(await until(() => conn.sent.length === 2));
});
test('plugin event handlers receive baileys events', async () => {
  const { dir, conn, plugins } = await setup();
  await fs.writeFile(path.join(dir, 'ev.js'), "export default { name:'ev', on:{ 'call':(d,api)=>{ api.got=d } } }");
  await plugins.reload();
  conn.emit('call', { id: 1 });
  assert.ok(await until(() => plugins.api.got?.id === 1));
});

test('own commands are never deleted (even if HIDE_COMMANDS is still set)', async () => {
  const { conn } = await setup({ HIDE_COMMANDS: 'true' });
  up(conn, msg('.ping', { key: { fromMe: true } }));
  assert.ok(await until(() => conn.sent.length === 1));
  await sleep(150);
  assert.equal(conn.sent.length, 1);
  assert.ok(!conn.sent.some((x) => x.content?.delete));
});
