import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { log, baileysLog } from "./logger.js";
import { createStore } from "./store.js";
import { Connection } from "./connection.js";
import { Sender } from "./send.js";
import { PluginManager } from "./plugins.js";
import { Bot } from "./bot.js";
import { atomicWrite } from "./util.js";

const startedAt = Date.now();
await fs.mkdir(config.dataDir, { recursive: true });
await fs.mkdir(config.pluginsDir, { recursive: true });

const store = createStore();
const conn = new Connection({ config, store, log, baileysLog });
const sender = new Sender({ conn, store, config, log });
const api = {
  config,
  conn,
  store,
  log,
  startedAt,
  send: (jid, content, opts) => sender.send(jid, content, opts),
};
let shutdown;
const plugins = new PluginManager({
  config,
  log,
  api,
  conn,
  onHelperChanged: () => shutdown("helper-changed"),
});
api.plugins = plugins;
const bot = new Bot({ config, conn, store, log, plugins, sender });

const beat = () =>
  atomicWrite(
    path.join(config.dataDir, "health.json"),
    JSON.stringify({
      at: Date.now(),
      state: conn.state,
      since: conn.stateSince,
      pid: process.pid,
    }),
  ).catch((err) => log.warn({ err: err.message }, "heartbeat write failed"));
const heartbeat = setInterval(beat, 15_000);

let crashes = [];
const survive = (kind) => (err) => {
  log.error({ err: err?.message ?? String(err), stack: err?.stack }, kind);
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < 60_000).concat(now);
  if (crashes.length > 20) {
    log.fatal("too many errors in a minute, exiting so Docker restarts us");
    process.exit(1);
  }
};
process.on("unhandledRejection", survive("unhandled rejection"));
process.on("uncaughtException", survive("uncaught exception"));

let closing = false;
shutdown = async function (sig) {
  if (closing) return;
  closing = true;
  log.info({ sig }, "shutting down");
  setTimeout(() => process.exit(0), 10_000).unref();
  clearInterval(heartbeat);
  await plugins.stop().catch(() => {});
  await conn.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log.info(
  {
    prefix: config.prefix,
    public: config.public,
    allowed: config.allowed.length,
  },
  "Lohra starting",
);
await plugins.reload();
plugins.watch();
bot.start();
await beat();
conn.on("open", async (sock, isNewLogin) => {
  if (isNewLogin || process.env.TEST_WELCOME) {
    const rawId = sock.user?.id || "";
    const ownerJid = rawId.split(":")[0] + "@s.whatsapp.net";
    if (rawId) {
      try {
        await sender.send(ownerJid, {
          image: {
            url: "https://i.imgur.com/Ur3mArW.png",
          },
          caption:
            "*Lohra is now connected and ready!*\n\nTo understand how to use Lohra, type *'Lohra --help'*\n\nLohra will keep giving you usage tips as you work with it, welcome onboard.",
        });
        log.info("Sent welcome message to owner");
      } catch (err) {
        log.error({ err: err.message }, "Failed to send welcome message");
      }
    }
  }
});

await conn.start();
