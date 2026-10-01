import { EventEmitter } from 'node:events';
export const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {} };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  return fn();
}
export function fakeConn() {
  const conn = new EventEmitter();
  const sent = [];
  conn.sent = sent;
  conn.sock = {
    user: { id: '15550001111:1@s.whatsapp.net' },
    sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); return { key: { id: `OUT${sent.length}` } }; },
    groupMetadata: async (id) => ({ id }),
  };
  Object.assign(conn, { state: 'open', stateSince: Date.now(), reconnects: 0, waitOpen: async () => conn.sock });
  return conn;
}
