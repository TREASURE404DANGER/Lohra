import { StatusStore } from "./_status.js";
import { digitsOf } from "../src/bot.js";
import { suggest } from "./_names.js";

let store = null;
let apiRef = null;

export default {
  name: "status",
  version: "1.0.0",
  description:
    "Download and view WhatsApp status (story) updates: Lohra status <name>",
  init: async (api) => {
    apiRef = api;
    store = new StatusStore({
      dataDir: api.config.dataDir,
      log: api.log,
      conn: api.conn,
      send: api.send,
    });
    await store.init();
    api.status = store;
  },
  on: {
    "messages.upsert": async (data) => {
      if (!store) return;
      for (const m of data?.messages || []) {
        if (m.key?.remoteJid === "status@broadcast") {
          await store.record(m).catch(() => {});
        }
      }
    },
  },
  commands: {
    story: {
      aliases: ["stories", "wastatus"],
      description: "Download contact status: Lohra status <name> | list",
      ownerOnly: true,
      run: async (ctx) => {
        if (!store)
          return void (await ctx.reply(
            "_Status manager is still warming up. Give it a sec..._",
          ));
        const query = (ctx.argText || "").trim();
        const contacts = (await ctx.api.agent?.listContacts()) || [];

        const selfDigits = digitsOf(ctx.api.conn?.sock?.user?.id);
        const selfJid = selfDigits ? `${selfDigits}@s.whatsapp.net` : ctx.jid;

        // List statuses
        if (!query || query.toLowerCase() === "list") {
          const list = store.listRecent(contacts);
          if (!list.length) {
            return void (await ctx.reply(
              "_No status updates recorded yet..._\n\n" +
                "WhatsApp statuses are received live while Lohra is connected. Once a contact posts an update, you can view or download it here with:\n" +
                "• *Lohra --status <name>*\n" +
                '• _"Lohra check <name> status and download the last meme"_',
            ));
          }
          const lines = list.map(
            (s) =>
              `• *${s.name}*: ${s.latestType} (${s.timeAgo}) - ${s.count} update${s.count > 1 ? "s" : ""}`,
          );
          return void (await ctx.reply(
            `*Recent Statuses (${list.length})*\n${lines.join("\n")}\n\n` +
              `Type: *Lohra --status <name>* to download and view.`,
          ));
        }

        const deliver = async (c, q, allowOffer) => {
          await c.react("⏳");
          const res = await store.deliverLatest(q, contacts, selfJid);
          await c.react("");
          if (!res.ok) {
            const dym = c.api.dym;
            const ranked = allowOffer && dym ? suggest(q, contacts) : [];
            if (ranked.length && ranked[0].score < 0.99) {
              // an exact name that simply has no status is not a mishearing
              return void (await dym.offer(c, {
                query: q,
                ranked,
                onPick: (pick, c2) =>
                  deliver(c2, pick.name || pick.number, false),
              }));
            }
            return void (await c.reply(res.message));
          }
          // Confirmation note
          await c.reply(
            `Delivered latest ${res.type} status from *${res.contact}* (posted ${res.posted}).`,
          );
        };
        await deliver(ctx, query, true);
      },
    },
  },
};
