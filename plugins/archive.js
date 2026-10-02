// Chat archive plugin: keeps what the bot sees so the agent can look back ("find the last voice note Precious sent").
//   Lohra archive            status        Lohra archive off | on        Lohra archive clear
// Env: ARCHIVE_DAYS (default 30), ARCHIVE_MAX_PER_CHAT (default 2000). Details and limits: _archive.js, "Lohra guide dev archive".
import { Archive } from './_archive.js';

let archive = null;
let apiRef = null;

const feed = (data) => { for (const m of data?.messages || []) archive?.record(m); };

export default {
  name: 'archive',
  version: '1.0.0',
  description: 'Remembers recent chats so the agent can look back: Lohra archive',
  init: async (api) => {
    apiRef = api;
    archive = new Archive({ dataDir: api.config.dataDir, log: api.log, conn: api.conn, retentionDays: Number(process.env.ARCHIVE_DAYS) || 30, maxPerChat: Number(process.env.ARCHIVE_MAX_PER_CHAT) || 2000 });
    await archive.init();
    api.archive = archive;
  },
  dispose: async () => { const a = archive; archive = null; if (apiRef?.archive === a) delete apiRef.archive; await a?.stop(); },
  on: { 'messages.upsert': feed, 'messaging-history.set': feed },
  commands: {
    archive: {
      description: 'Chat memory for the agent: archive | on | off | clear',
      ownerOnly: true,
      run: async (ctx) => {
        if (!archive) return void (await ctx.reply('_The archive is starting up. Give it a sec..._'));
        const a = (ctx.args[0] || 'status').toLowerCase();
        if (a === 'on' || a === 'off') await archive.setEnabled(a === 'on');
        else if (a === 'clear') { await archive.clear(); return void (await ctx.reply('_Archive cleared. Everything saved so far is gone._')); }
        else if (a !== 'status') return void (await ctx.reply('_Usage: Lohra --archive | Lohra --archive on | Lohra --archive off | Lohra --archive clear_'));
        const s = archive.stats();
        const since = s.since ? new Date(s.since).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'nothing yet';
        await ctx.reply(`*Archive:* ${s.enabled ? 'ON' : 'OFF'}\\n${s.messages} messages in ${s.chats} chats, oldest: ${since}. Kept ${s.retention_days} days.\\n_Only messages seen while the bot was connected are saved._`);
      },
    },
  },
};
