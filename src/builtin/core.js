import { fmtDuration } from "../util.js";

export default {
  name: "core",
  version: "1.0.0",
  description: "Built-in commands",
  commands: {
    ping: {
      description:
        "To check how fast Lohra is responding. Lower number means better, no response means Lohra is too busy or inactive.",
      run: async (ctx) => {
        const ts = Number(ctx.msg.messageTimestamp) || 0;
        const ms = ts ? Math.max(0, Date.now() - ts * 1000) : null;
        await ctx.reply(ms == null ? "pong" : `pong (${ms} ms)`);
      },
    },
    help: {
      aliases: ["menu"],
      description: "To list all commands",
      run: async (ctx) => {
        // Category mapping: command name -> category
        const CATEGORIES = {
          // Core
          ping: "Core",
          help: "Core",
          menu: "Core",
          guide: "Core",
          howto: "Core",
          manual: "Core",
          reload: "Core",
          plugins: "Core",
          // Messaging
          agent: "Messaging",
          voice: "Messaging",
          transcribe: "Messaging",
          tr: "Messaging",
          archive: "Messaging",
          contact: "Messaging",
          contacts: "Messaging",
          add: "Messaging",
          // Status
          status: "Status",
          story: "Status",
          stories: "Status",
          wastatus: "Status",
          watch: "Status",
          monitor: "Status",
          // Utility
          yoink: "Utility",
          yoinks: "Utility",
          pick: "Utility",
          yes: "Utility",
          no: "Utility",
        };
        const ORDER = ["Core", "Messaging", "Status", "Utility"];
        const groups = new Map(ORDER.map((c) => [c, []]));

        for (const [n, e] of ctx.api.plugins.commands) {
          if (n !== e.name.toLowerCase()) continue; // skip aliases
          if (e.command.ownerOnly && !ctx.isOwner) continue;
          const cat = CATEGORIES[e.name.toLowerCase()] || "Utility";
          if (!groups.has(cat)) groups.set(cat, []);

          let line = `*${ctx.prefix}--${e.name}*`;
          if (e.command.description) {
            line += `\n  ${e.command.description}`;
          }
          if (e.command.usage) {
            line += `\n  _Example: ${ctx.prefix}--${e.command.usage}_`;
          } else {
            line += `\n  _Example: ${ctx.prefix}--${e.name}_`;
          }
          groups.get(cat).push(line);
        }

        let out =
          "*Here's your guide:*\n\nFirstly, Lohra is built on a natural-language-to-action interface. This means that you can tell (ask) Lohra anything at all using your natural language and it'll try to take the action or give the response that matches your request the most.\nIn simple words, you can control Lohra by just communicating.\n\nTalk to Lohra by typing *'Lohra <your-request>'* in your own dm (e.g *Lohra remind David to come with his sister*).\n You can also talk to Lohra by recording a voicenote in your own dm. Make your pronunciations well articulated so that Lohra doesn't mix up your words. Lohra understands English and light Pidgin.\n\n*_Lohra is not a chatbot._*\n\nIf you prefer (and also to gain knowledge of Lohra's capabilities), you can instruct Lohra using very specific Command Lines:\n\n";
        for (const [cat, cmds] of groups) {
          if (!cmds.length) continue;
          out += `*${cat}*\n${cmds.join("\n\n")}\n\n`;
        }
        await ctx.reply(out.trim() || "No commands.");
      },
    },
    status: {
      description: "Bot health, or check contact status: Lohra status <name>",
      ownerOnly: true,
      run: async (ctx) => {
        const query = (ctx.argText || "").trim();
        if (query && ctx.api.status) {
          const storyCmd = ctx.api.plugins.resolve("story");
          if (storyCmd?.command?.run) return storyCmd.command.run(ctx);
        }
        const { conn, startedAt, plugins } = ctx.api;
        await ctx.reply(
          [
            `State: ${conn.state} (${fmtDuration(Date.now() - conn.stateSince)})`,
            `Uptime: ${fmtDuration(Date.now() - startedAt)}`,
            `Reconnects: ${conn.reconnects}`,
            `Plugins: ${plugins.plugins.size} (${plugins.commands.size} commands, ${plugins.failed.length} failed)`,
            `Memory: ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
            `Node: ${process.version}`,
          ].join("\n"),
        );
      },
    },
    plugins: {
      description: "List loaded plugins",
      ownerOnly: true,
      run: async (ctx) => {
        const pm = ctx.api.plugins;
        const lines = [...pm.plugins.values()].map((p) =>
          `- ${p.name} ${p.mod.version || ""} (${p.source})`.trim(),
        );
        for (const f of pm.failed) lines.push(`! ${f.file}: ${f.error}`);
        await ctx.reply(lines.join("\n") || "No plugins.");
      },
    },
    reload: {
      description: "Reload plugins",
      ownerOnly: true,
      run: async (ctx) => {
        const r = await ctx.api.plugins.reload();
        await ctx.reply(
          `Reloaded: ${r.loaded} plugins, ${r.commands} commands, ${r.failed.length} failed.`,
        );
      },
    },
  },
};
