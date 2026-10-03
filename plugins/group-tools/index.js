import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_FILE = path.join(__dirname, "groups.json");

const stats = {};
const lastSeen = {};

function loadDB() {
  try {
    return JSON.parse(
      fs.readFileSync(DB_FILE, "utf8")
    );
  } catch {
    return {};
  }
}

function saveDB(data) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(data, null, 2)
  );
}

export default {
  name: "group-tools",
  version: "2.0.0",
  description: "Advanced Group Tools",

  commands: {
    tagall: {
      async run(ctx) {
        const { sock, msg } = ctx;

        const jid = msg.key.remoteJid;

        if (!jid.endsWith("@g.us")) {
          return ctx.reply(
            "❌ Group only command."
          );
        }

        const meta =
          await sock.groupMetadata(jid);

        const mentions =
          meta.participants.map(
            p => p.id
          );

        const text =
          "📢 Attention Everyone\n\n" +
          meta.participants
            .map(
              (p, i) =>
                `${i + 1}. @${
                  p.id.split("@")[0]
                }`
            )
            .join("\n");

        await sock.sendMessage(jid, {
          text,
          mentions
        });
      }
    },

    groupinfo: {
      async run(ctx) {
        const { sock, msg } = ctx;

        const jid =
          msg.key.remoteJid;

        const meta =
          await sock.groupMetadata(jid);

        const admins =
          meta.participants.filter(
            p => p.admin
          ).length;

        await ctx.reply(
`📊 Group Information

Name: ${meta.subject}
Members: ${meta.participants.length}
Admins: ${admins}
ID: ${jid}`
        );
      }
    },

    admins: {
      async run(ctx) {
        const { sock, msg } = ctx;

        const jid =
          msg.key.remoteJid;

        const meta =
          await sock.groupMetadata(jid);

        const admins =
          meta.participants.filter(
            p => p.admin
          );

        await sock.sendMessage(jid, {
          text:
            "👮 Group Admins\n\n" +
            admins
              .map(
                a =>
                  `• @${
                    a.id.split("@")[0]
                  }`
              )
              .join("\n"),

          mentions:
            admins.map(
              a => a.id
            )
        });
      }
    },

    kick: {
      ownerOnly: true,

      async run(ctx) {
        const { sock, msg, args } =
          ctx;

        const jid =
          msg.key.remoteJid;

        const user =
          args[0]?.replace(/\D/g, "");

        if (!user) {
          return ctx.reply(
            "Usage: kick 234xxxxxxxxxx"
          );
        }

        await sock.groupParticipantsUpdate(
          jid,
          [
            `${user}@s.whatsapp.net`
          ],
          "remove"
        );

        ctx.reply(
          "✅ User removed."
        );
      }
    },

    promote: {
      ownerOnly: true,

      async run(ctx) {
        const { sock, msg, args } =
          ctx;

        const jid =
          msg.key.remoteJid;

        const user =
          args[0]?.replace(/\D/g, "");

        if (!user) {
          return ctx.reply(
            "Usage: promote 234xxxxxxxxxx"
          );
        }

        await sock.groupParticipantsUpdate(
          jid,
          [
            `${user}@s.whatsapp.net`
          ],
          "promote"
        );

        ctx.reply(
          "✅ User promoted."
        );
      }
    },

    demote: {
      ownerOnly: true,

      async run(ctx) {
        const { sock, msg, args } =
          ctx;

        const jid =
          msg.key.remoteJid;

        const user =
          args[0]?.replace(/\D/g, "");

        if (!user) {
          return ctx.reply(
            "Usage: demote 234xxxxxxxxxx"
          );
        }

        await sock.groupParticipantsUpdate(
          jid,
          [
            `${user}@s.whatsapp.net`
          ],
          "demote"
        );

        ctx.reply(
          "✅ User demoted."
        );
      }
    },

    welcome: {
      ownerOnly: true,

      async run(ctx) {
        const db = loadDB();

        const jid =
          ctx.msg.key.remoteJid;

        db[jid] ??= {};
        db[jid].welcome =
          ctx.args[0] === "on";

        saveDB(db);

        ctx.reply(
          `✅ Welcome ${
            db[jid].welcome
              ? "enabled"
              : "disabled"
          }`
        );
      }
    },

    goodbye: {
      ownerOnly: true,

      async run(ctx) {
        const db = loadDB();

        const jid =
          ctx.msg.key.remoteJid;

        db[jid] ??= {};
        db[jid].goodbye =
          ctx.args[0] === "on";

        saveDB(db);

        ctx.reply(
          `✅ Goodbye ${
            db[jid].goodbye
              ? "enabled"
              : "disabled"
          }`
        );
      }
    },

    antilink: {
      ownerOnly: true,

      async run(ctx) {
        const db = loadDB();

        const jid =
          ctx.msg.key.remoteJid;

        db[jid] ??= {};
        db[jid].antilink =
          ctx.args[0] === "on";

        saveDB(db);

        ctx.reply(
          `✅ AntiLink ${
            db[jid].antilink
              ? "enabled"
              : "disabled"
          }`
        );
      }
    },

    lock: {
      ownerOnly: true,

      async run(ctx) {
        await ctx.sock.groupSettingUpdate(
          ctx.msg.key.remoteJid,
          "announcement"
        );

        ctx.reply(
          "🔒 Group locked."
        );
      }
    },

    unlock: {
      ownerOnly: true,

      async run(ctx) {
        await ctx.sock.groupSettingUpdate(
          ctx.msg.key.remoteJid,
          "not_announcement"
        );

        ctx.reply(
          "🔓 Group unlocked."
        );
      }
    },

    poll: {
      async run(ctx) {

        const text =
          ctx.args.join(" ");

        const parts =
          text.split("|");

        if (parts.length < 3) {
          return ctx.reply(
            "poll Question|Option1|Option2"
          );
        }

        const question =
          parts.shift();

        await ctx.sock.sendMessage(
          ctx.msg.key.remoteJid,
          {
            poll: {
              name: question,
              values: parts,
              selectableCount: 1
            }
          }
        );
      }
    },

    groupstats: {
      async run(ctx) {

        const jid =
          ctx.msg.key.remoteJid;

        const s = stats[jid];

        if (!s) {
          return ctx.reply(
            "No stats available."
          );
        }

        const top =
          Object.entries(
            s.users
          )
            .sort(
              (a, b) =>
                b[1] - a[1]
            )
            .slice(0, 5)
            .map(
              ([u, c], i) =>
                `${i + 1}. ${
                  u.split("@")[0]
                } (${c})`
            )
            .join("\n");

        ctx.reply(
`📊 Group Statistics

Messages:
${s.messages}

Top Members:
${top}`
        );
      }
    },

    inactive: {
      async run(ctx) {

        const jid =
          ctx.msg.key.remoteJid;

        const days =
          Number(
            ctx.args[0] || 30
          );

        const cutoff =
          Date.now() -
          days *
            24 *
            60 *
            60 *
            1000;

        const inactive =
          Object.entries(
            lastSeen[jid] || {}
          )
            .filter(
              ([, t]) =>
                t < cutoff
            )
            .map(
              ([id]) =>
                `• ${
                  id.split("@")[0]
                }`
            )
            .join("\n");

        ctx.reply(
`😴 Inactive Members (${days} days)

${inactive || "None"}`
        );
      }
    }
  },

  on: {
    "messages.upsert":
      async (
        { messages },
        api
      ) => {

        const db = loadDB();

        for (const msg of messages) {

          const jid =
            msg.key.remoteJid;

          if (
            !jid ||
            !jid.endsWith("@g.us")
          ) {
            continue;
          }

          const sender =
            msg.key.participant;

          stats[jid] ??= {
            messages: 0,
            users: {}
          };

          stats[jid].messages++;

          stats[jid].users[
            sender
          ] ??= 0;

          stats[jid].users[
            sender
          ]++;

          lastSeen[jid] ??= {};

          lastSeen[jid][sender] =
            Date.now();

          const text =
            msg.message
              ?.conversation ||
            msg.message
              ?.extendedTextMessage
              ?.text ||
            "";

          if (
            db[jid]?.antilink &&
            /chat\.whatsapp\.com/i.test(
              text
            )
          ) {

            await api.sock
              .sendMessage(
                jid,
                {
                  text:
                    "⚠️ Group links are forbidden."
                }
              )
              .catch(() => {});

            await api.sock
              .groupParticipantsUpdate(
                jid,
                [sender],
                "remove"
              )
              .catch(() => {});
          }
        }
      },

    "group-participants.update":
      async (
        data,
        api
      ) => {

        const db = loadDB();

        const cfg =
          db[data.id];

        if (!cfg) return;

        if (
          data.action === "add" &&
          cfg.welcome
        ) {

          for (const user of data.participants) {

            await api.sock.sendMessage(
              data.id,
              {
                text:
`👋 Welcome @${user.split("@")[0]}

Enjoy your stay!`,

                mentions: [user]
              }
            );
          }
        }

        if (
          data.action === "remove" &&
          cfg.goodbye
        ) {

          for (const user of data.participants) {

            await api.sock.sendMessage(
              data.id,
              {
                text:
`👋 Goodbye @${user.split("@")[0]}`,

                mentions: [user]
              }
            );
          }
        }
      }
  }
};
