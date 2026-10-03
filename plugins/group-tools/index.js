export default {
  name: "group-tools",
  version: "1.0.0",
  description: "WhatsApp group management tools",

  commands: {
    tagall: {
      ownerOnly: false,

      async run(ctx) {
        const { sock, msg } = ctx;

        const jid = msg.key.remoteJid;

        if (!jid.endsWith("@g.us")) {
          return ctx.reply("❌ This command works only in groups.");
        }

        const meta = await sock.groupMetadata(jid);

        const mentions = meta.participants.map(
          p => p.id
        );

        const text =
          "📢 Attention everyone!\n\n" +
          meta.participants
            .map((p, i) =>
              `${i + 1}. @${p.id.split("@")[0]}`
            )
            .join("\n");

        await sock.sendMessage(
          jid,
          {
            text,
            mentions
          }
        );
      }
    },

    groupinfo: {
      async run(ctx) {
        const { sock, msg } = ctx;

        const jid = msg.key.remoteJid;

        if (!jid.endsWith("@g.us")) {
          return ctx.reply("❌ Group only command.");
        }

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

        const jid = msg.key.remoteJid;

        if (!jid.endsWith("@g.us")) {
          return ctx.reply("❌ Group only command.");
        }

        const meta =
          await sock.groupMetadata(jid);

        const admins =
          meta.participants
            .filter(p => p.admin)
            .map(
              p =>
                `• @${p.id.split("@")[0]}`
            );

        await sock.sendMessage(
          jid,
          {
            text:
              "👮 Group Admins\n\n" +
              admins.join("\n"),
            mentions: meta.participants
              .filter(p => p.admin)
              .map(p => p.id)
          }
        );
      }
    },

    kick: {
      ownerOnly: true,

      async run(ctx) {
        const { sock, msg, args } = ctx;

        const jid = msg.key.remoteJid;

        if (!jid.endsWith("@g.us")) {
          return ctx.reply("❌ Group only command.");
        }

        const user =
          args[0]?.replace(/\D/g, "");

        if (!user) {
          return ctx.reply(
            "Usage: kick 234xxxxxxxxxx"
          );
        }

        await sock.groupParticipantsUpdate(
          jid,
          [`${user}@s.whatsapp.net`],
          "remove"
        );

        await ctx.reply("✅ User removed.");
      }
    },

    promote: {
      ownerOnly: true,

      async run(ctx) {
        const { sock, msg, args } = ctx;

        const jid = msg.key.remoteJid;

        const user =
          args[0]?.replace(/\D/g, "");

        if (!user)
          return ctx.reply(
            "Usage: promote 234xxxxxxxxxx"
          );

        await sock.groupParticipantsUpdate(
          jid,
          [`${user}@s.whatsapp.net`],
          "promote"
        );

        await ctx.reply(
          "✅ User promoted."
        );
      }
    },

    demote: {
      ownerOnly: true,

      async run(ctx) {
        const { sock, msg, args } = ctx;

        const jid = msg.key.remoteJid;

        const user =
          args[0]?.replace(/\D/g, "");

        if (!user)
          return ctx.reply(
            "Usage: demote 234xxxxxxxxxx"
          );

        await sock.groupParticipantsUpdate(
          jid,
          [`${user}@s.whatsapp.net`],
          "demote"
        );

        await ctx.reply(
          "✅ User demoted."
        );
      }
    }
  }
};
