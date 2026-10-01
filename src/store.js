import { LRUCache } from 'lru-cache';

/** Small bounded in-memory caches Baileys needs to behave well (retries, group metadata). */
export function createStore() {
  const messages = new LRUCache({ max: 3000, ttl: 24 * 3600 * 1000 });
  const groups = new LRUCache({ max: 500, ttl: 10 * 60 * 1000 });
  const retries = new LRUCache({ max: 5000, ttl: 10 * 60 * 1000 });
  const sent = new LRUCache({ max: 5000, ttl: 3600 * 1000 });
  const k = (key) => `${key.remoteJid}|${key.id}`;

  return {
    groups,
    rememberMessage(m) { if (m?.key?.id && m.message) messages.set(k(m.key), m.message); },
    getMessage: async (key) => messages.get(k(key)),
    // Baileys "CacheStore" interface
    retryCache: {
      get: (key) => retries.get(key),
      set: (key, val) => { retries.set(key, val); },
      del: (key) => { retries.delete(key); },
      flushAll: () => retries.clear(),
    },
    // ids of messages this bot sent, so it never reacts to its own output
    markSent: (id) => { sent.set(id, 1); },
    isSent: (id) => sent.has(id),
  };
}
