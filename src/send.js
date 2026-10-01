import { sleep, withTimeout } from './util.js';

/** Serialized outgoing queue: keeps a minimum gap between messages and remembers sent ids. */
export class Sender {
  #chain = Promise.resolve();

  constructor({ conn, store, config, log }) {
    Object.assign(this, { conn, store, cfg: config, log });
  }

  send(jid, content, opts = {}) {
    const p = this.#chain.then(async () => {
      const sock = await this.conn.waitOpen(30_000);
      if (jid.endsWith('@g.us') && !this.store.groups.has(jid)) {
        try { this.store.groups.set(jid, await withTimeout(sock.groupMetadata(jid), 10_000, 'group metadata')); } catch { /* send anyway */ }
      }
      const res = await sock.sendMessage(jid, content, opts);
      if (res?.key?.id) this.store.markSent(res.key.id);
      if (this.cfg.sendGapMs > 0) await sleep(this.cfg.sendGapMs);
      return res;
    });
    this.#chain = p.catch(() => {});
    return p;
  }
}
