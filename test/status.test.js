import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractStatusInfo, StatusStore } from '../plugins/_status.js';

test('extractStatusInfo extracts status metadata correctly', () => {
  // Non-status message ignored
  assert.equal(extractStatusInfo({ key: { remoteJid: '123@s.whatsapp.net' } }), null);

  // Image status
  const imgMsg = {
    key: { remoteJid: 'status@broadcast', id: 'IMG1', participant: '2349049429208@s.whatsapp.net' },
    message: { imageMessage: { caption: 'Funny meme' } },
    messageTimestamp: 1727756000,
    pushName: 'Precious',
  };
  const imgInfo = extractStatusInfo(imgMsg);
  assert.equal(imgInfo.type, 'image');
  assert.equal(imgInfo.caption, 'Funny meme');
  assert.equal(imgInfo.pushName, 'Precious');
  assert.equal(imgInfo.senderNumber, '2349049429208');

  // Video status
  const vidMsg = {
    key: { remoteJid: 'status@broadcast', id: 'VID1', participant: '2348011112222@s.whatsapp.net' },
    message: { videoMessage: { caption: 'Cool video', seconds: 15 } },
    messageTimestamp: 1727756100,
    pushName: 'Thomas',
  };
  const vidInfo = extractStatusInfo(vidMsg);
  assert.equal(vidInfo.type, 'video');
  assert.equal(vidInfo.duration, 15);
  assert.equal(vidInfo.senderNumber, '2348011112222');

  // Text status
  const txtMsg = {
    key: { remoteJid: 'status@broadcast', id: 'TXT1', participant: '2348033334444@s.whatsapp.net' },
    message: { extendedTextMessage: { text: 'Hello world status' } },
    messageTimestamp: 1727756200,
  };
  const txtInfo = extractStatusInfo(txtMsg);
  assert.equal(txtInfo.type, 'text');
  assert.equal(txtInfo.text, 'Hello world status');
});

test('StatusStore records statuses and delivers to owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-test-'));
  const sent = [];
  const fakeSend = async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'OUT' } }; };
  const store = new StatusStore({
    dataDir: dir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    conn: { sock: { user: { id: '15550001111@s.whatsapp.net' } } },
    send: fakeSend,
  });
  await store.init();

  const contacts = [
    { name: 'Precious', number: '2349049429208', jid: '2349049429208@s.whatsapp.net', names: ['precious'] },
  ];

  // 1. Initially no status
  const resEmpty = await store.deliverLatest('Precious', contacts, '15550001111@s.whatsapp.net');
  assert.equal(resEmpty.ok, false);
  assert.equal(resEmpty.error, 'no_status');

  // 2. Record a text status from Precious
  await store.record({
    key: { remoteJid: 'status@broadcast', id: 'TXT1', participant: '2349049429208@s.whatsapp.net' },
    message: { extendedTextMessage: { text: 'Chilling at home today' } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Precious',
  });

  // 3. List recent statuses
  const list = store.listRecent(contacts);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Precious');
  assert.equal(list[0].latestType, 'text');

  // 4. Deliver latest status
  const resDelivered = await store.deliverLatest('Precious', contacts, '15550001111@s.whatsapp.net');
  assert.equal(resDelivered.ok, true);
  assert.equal(resDelivered.contact, 'Precious');
  assert.equal(resDelivered.type, 'text');
  assert.ok(sent.some((s) => s.content.text?.includes('Chilling at home today')));
});
