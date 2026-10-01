import fs from 'node:fs/promises';
import path from 'node:path';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { atomicWrite } from './util.js';

const fileSafe = (s) => String(s).replace(/\//g, '__').replace(/:/g, '-');

async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'), BufferJSON.reviver);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Crash-safe replacement for useMultiFileAuthState:
 * - every write is atomic (tmp + fsync + rename)
 * - creds.json keeps a .bak of the previous good version and falls back to it if corrupt
 * - all writes are serialized
 */
export async function useAtomicAuthState(dir, log = console) {
  await fs.mkdir(dir, { recursive: true });
  const credsFile = path.join(dir, 'creds.json');

  let creds;
  try { creds = await readJSON(credsFile); } catch { log.warn?.('creds.json unreadable, trying backup'); }
  if (!creds) {
    try {
      creds = await readJSON(`${credsFile}.bak`);
      if (creds) log.warn?.('restored creds from creds.json.bak');
    } catch { /* fall through to fresh creds */ }
  }
  creds ||= initAuthCreds();

  let lock = Promise.resolve();
  const run = (fn) => { const p = lock.then(fn); lock = p.catch(() => {}); return p; };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await readJSON(path.join(dir, `${type}-${fileSafe(id)}.json`)).catch(() => undefined);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: (data) => run(async () => {
          const tasks = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const file = path.join(dir, `${type}-${fileSafe(id)}.json`);
              const val = data[type][id];
              tasks.push(val ? atomicWrite(file, JSON.stringify(val, BufferJSON.replacer)) : fs.rm(file, { force: true }));
            }
          }
          await Promise.all(tasks);
        }),
      },
    },
    saveCreds: () => run(async () => {
      await fs.copyFile(credsFile, `${credsFile}.bak`).catch(() => {});
      await atomicWrite(credsFile, JSON.stringify(creds, BufferJSON.replacer));
    }),
    flush: () => lock,
  };
}

/** Move a dead session aside (keeps the newest 2) so a fresh pairing can start. */
export async function archiveAuth(dir, log = console) {
  const dest = `${dir}.loggedout-${Date.now()}`;
  await fs.rename(dir, dest).catch(() => {});
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.loggedout-`;
  const old = (await fs.readdir(parent).catch(() => [])).filter((f) => f.startsWith(prefix)).sort().slice(0, -2);
  for (const f of old) await fs.rm(path.join(parent, f), { recursive: true, force: true });
  log.info?.({ dest }, 'archived old session');
}
