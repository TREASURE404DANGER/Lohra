import { fmtDuration } from '../util.js';

export default {
  name: 'core',
  version: '1.0.0',
  description: 'Built-in commands',
  commands: {
    ping: {
      description: 'Check the bot is alive',
      run: async (ctx) => {
        const ts = Number(ctx.msg.messageTimestamp) || 0;
        const ms = ts ? Math.max(0, Date.now() - ts * 1000) : null;
        await ctx.reply(ms == null ? 'pong' : `pong (${ms} ms)`);
      },
    },
    help: {
      aliases: ['menu'],
      description: 'List commands',
      run: async (ctx) => {
        const groups = new Map();
        for (const [n, e] of ctx.api.plugins.commands) {
          if (n !== e.name.toLowerCase()) continue; // skip aliases
          if (e.command.ownerOnly && !ctx.isOwner) continue;
          if (!groups.has(e.plugin)) groups.set(e.plugin, []);
          groups.get(e.plugin).push(`${ctx.prefix}${e.name}${e.command.description ? ` - ${e.command.description}` : ''}`);
        }
        await ctx.reply([...groups].map(([p, l]) => `*${p}*\n${l.join('\n')}`).join('\n\n') || 'No commands.');
      },
    },
    status: {
      description: 'Bot health, or check contact status: Lohra status <name>',
      ownerOnly: true,
      run: async (ctx) => {
        const query = (ctx.argText || '').trim();
        if (query && ctx.api.status) {
          const storyCmd = ctx.api.plugins.resolve('story');
          if (storyCmd?.command?.run) return storyCmd.command.run(ctx);
        }
        const { conn, startedAt, plugins } = ctx.api;
        await ctx.reply([
          `State: ${conn.state} (${fmtDuration(Date.now() - conn.stateSince)})`,
          `Uptime: ${fmtDuration(Date.now() - startedAt)}`,
          `Reconnects: ${conn.reconnects}`,
          `Plugins: ${plugins.plugins.size} (${plugins.commands.size} commands, ${plugins.failed.length} failed)`,
          `Memory: ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
          `Node: ${process.version}`,
        ].join('\n'));
      },
    },
    plugins: {
      description: 'List loaded plugins',
      ownerOnly: true,
      run: async (ctx) => {
        const pm = ctx.api.plugins;
        const lines = [...pm.plugins.values()].map((p) => `- ${p.name} ${p.mod.version || ''} (${p.source})`.trim());
        for (const f of pm.failed) lines.push(`! ${f.file}: ${f.error}`);
        await ctx.reply(lines.join('\n') || 'No plugins.');
      },
    },
    reload: {
      description: 'Reload plugins',
      ownerOnly: true,
      run: async (ctx) => {
        const r = await ctx.api.plugins.reload();
        await ctx.reply(`Reloaded: ${r.loaded} plugins, ${r.commands} commands, ${r.failed.length} failed.`);
      },
    },
  },
};
