import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log, baileysLog } from './logger.js';
import { createStore } from './store.js';
import { Connection } from './connection.js';
import { Sender } from './send.js';
import { PluginManager } from './plugins.js';
import { Bot } from './bot.js';
import { atomicWrite } from './util.js';

const startedAt = Date.now();
await fs.mkdir(config.dataDir, { recursive: true });
await fs.mkdir(config.pluginsDir, { recursive: true });

const store = createStore();
const conn = new Connection({ config, store, log, baileysLog });
const sender = new Sender({ conn, store, config, log });
const api = { config, conn, store, log, startedAt, send: (jid, content, opts) => sender.send(jid, content, opts) };
const plugins = new PluginManager({ config, log, api, conn });
api.plugins = plugins;
const bot = new Bot({ config, conn, store, log, plugins, sender });

const beat = () => atomicWrite(path.join(config.dataDir, 'health.json'), JSON.stringify({ at: Date.now(), state: conn.state, since: conn.stateSince, pid: process.pid }))
  .catch((err) => log.warn({ err: err.message }, 'heartbeat write failed'));
const heartbeat = setInterval(beat, 15_000);

let crashes = [];
const survive = (kind) => (err) => {
  log.error({ err: err?.message ?? String(err), stack: err?.stack }, kind);
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < 60_000).concat(now);
  if (crashes.length > 20) { log.fatal('too many errors in a minute, exiting so Docker restarts us'); process.exit(1); }
};
process.on('unhandledRejection', survive('unhandled rejection'));
process.on('uncaughtException', survive('uncaught exception'));

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  log.info({ sig }, 'shutting down');
  setTimeout(() => process.exit(0), 10_000).unref();
  clearInterval(heartbeat);
  await plugins.stop().catch(() => {});
  await conn.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info({ prefix: config.prefix, public: config.public, allowed: config.allowed.length }, 'wabot starting');
await plugins.reload();
plugins.watch();
bot.start();
await beat();
await conn.start();
