// Watch a contact: "Lohra watch Precious next status that is a meme" / "Lohra watch Precious next message about waste beats".
// The AI turns the request into a spec and writes its own check (rubric); every new status/message from that contact is then run
// through the check, and the first match (or every match, for "keep watching") is sent to your own chat with the media.
//   Lohra watch <plain English>      create          Lohra watch list           active + recent
//   Lohra watch info <id>            details         Lohra watch cancel <id|name|all>
// Env (optional): WATCH_MODEL, WATCH_MIN_CONF (0.6), WATCH_MAX_EVALS (150 AI checks per watch), GEMINI_API_KEY (required for AI conditions)
import path from 'node:path';
import { Watcher, fmtDur, MAX_ACTIVE } from './_watch.js';
import { parseRequest } from './_judge.js';
import { loadContacts, resolveRecipient, norm } from './_contacts.js';
import { suggest } from './_names.js';
import { digitsOf } from '../src/bot.js';

let watcher = null;
let apiRef = null;

const USAGE =
  '_Tell me who and what to wait for, e.g._\n' +
  '• *Lohra --watch Precious next status that is a meme*\n' +
  '• *Lohra --watch Precious next message about waste beats*\n' +
  '• *Lohra --watch Precious every status that mentions food for 3 days*\n\n' +
  'Also: *Lohra --watch list* · *Lohra --watch info <id>* · *Lohra --watch cancel <id|name|all>*';

const line = (t) => {
  const left = t.state === 'active' ? `${fmtDur(t.expiresAt - Date.now())} left` : t.endReason || t.state;
  const what = `next ${t.kind}${t.condition ? ` “${t.condition}”` : ''}`;
  return `#${t.id} · *${t.target.name}* · ${what} · ${t.once ? 'once' : 'keep'} · ${left} · ${t.stats.seen} seen`;
};

async function resolveTarget(api, query) {
  const dataDir = api.config.dataDir;
  const selfDigits = digitsOf(api.conn?.sock?.user?.id);
  const defaultCc = api.agent?.cfg?.defaultCountryCode || (selfDigits.startsWith('234') ? '234' : '');
  const { contacts } = await loadContacts(path.join(dataDir, 'contacts.json'), { defaultCc });
  return { contacts: contacts || [], r: resolveRecipient(contacts || [], query, { allowRaw: true, defaultCc }) };
}

const usable = (c) => !!c && !c.group && !!c.number;

async function finish(ctx, spec, text, c) {
  let task;
  try {
    task = await watcher.add({
      target: { name: c.name || `+${c.number}`, number: c.number, jid: c.jid },
      kind: spec.kind, condition: spec.condition, rubric: spec.rubric, once: spec.once, anywhere: spec.anywhere, ttlHours: spec.ttlHours, instruction: text,
    });
  } catch (e) { return void (await ctx.reply(`⚠️ ${e.message}`)); }

  const out = [
    `✅ Watching *${task.target.name}* (#${task.id})`,
    `• Waits for: their next ${task.kind}${task.anywhere ? ' (any chat)' : task.kind === 'message' ? ' (private chat)' : ''}${task.condition ? ` that matches “${task.condition}”` : ' (anything)'}`,
    `• ${task.once ? 'Stops after the first match' : 'Keeps going after matches'} · expires in ${fmtDur(task.expiresAt - task.createdAt)}`,
  ];
  if (task.rubric) out.push(`• My check: ${task.rubric.length > 420 ? task.rubric.slice(0, 417) + '…' : task.rubric}`);
  out.push(`Cancel: Lohra watch cancel ${task.id}`);
  await ctx.reply(out.join('\n'));
}

async function create(ctx, text) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return void (await ctx.reply('_GEMINI_API_KEY is not set, so I cannot build the check._ Set it in `.env`.'));
  await ctx.react('⏳');
  let spec;
  try { spec = await parseRequest(text, { key }); }
  catch (e) { await ctx.react(''); return void (await ctx.reply(`I couldn't process that (${e.message}).\n\n${USAGE}`)); }
  await ctx.react('');
  if (!spec.ok) return void (await ctx.reply(`${spec.problem || "I couldn't tell who to watch."}\n\n${USAGE}`));

  const { contacts, r } = await resolveTarget(ctx.api, spec.target);
  if (r.status === 'ok' && usable(r.contact)) return void (await finish(ctx, spec, text, r.contact));

  const dym = ctx.api.dym; // shared "did you mean" step (plugins/didyoumean.js)
  const onPick = (c, ctx2) => finish(ctx2, spec, text, c);
  if (r.status === 'ambiguous') {
    const ranked = r.candidates.filter(usable).map((contact) => ({ contact, score: 1 }));
    if (ranked.length && dym) return void (await dym.offer(ctx, { query: spec.target, ranked, list: true, onPick }));
    return void (await ctx.reply(`Which one? ${r.candidates.map((c) => c.name || `+${c.number}`).join(', ')}.\nRepeat the command with the full name or number.`));
  }
  const ranked = suggest(spec.target, contacts).filter((x) => usable(x.contact));
  if (ranked.length && dym) return void (await dym.offer(ctx, { query: spec.target, ranked, onPick }));
  const names = contacts.filter(usable).map((c) => c.name).filter(Boolean);
  await ctx.reply(`I don't have "${spec.target}" in contacts${names.length && names.length <= 12 ? `. I know: ${names.join(', ')}` : ''}.\nUse their number instead, e.g. Lohra watch +234… next status that is a meme.`);
}

export default {
  name: 'watch',
  version: '1.0.0',
  description: 'Watch a contact for their next status/message, with an AI-written check. Lohra watch <plain English>',
  init: async (api) => {
    apiRef = api;
    watcher = new Watcher({ dataDir: api.config.dataDir, log: api.log, getSock: () => api.conn?.sock, send: (jid, content, opts) => api.send(jid, content, opts) });
    await watcher.init();
    api.watch = watcher; // other plugins (e.g. the voice agent) can call api.watch.add(...)
  },
  dispose: async () => { watcher?.stop(); watcher = null; if (apiRef?.watch) delete apiRef.watch; },
  on: { 'messages.upsert': (data) => watcher?.onUpsert(data) },
  commands: {
    watch: {
      aliases: ['monitor'],
      description: 'Watch a contact: Lohra watch Precious next status that is a meme',
      ownerOnly: true,
      run: async (ctx) => {
        if (!watcher) return void (await ctx.reply('_Watch engine is starting up. Give it a sec..._'));
        const text = (ctx.argText || '').trim();
        const [sub, ...restArr] = text.split(/\s+/);
        const rest = restArr.join(' ').trim();
        switch ((sub || '').toLowerCase()) {
          case '': case 'help': return void (await ctx.reply(USAGE));
          case 'list': case 'ls': {
            const act = watcher.active();
            const ended = watcher.list().filter((t) => t.state !== 'active').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 5);
            if (!act.length && !ended.length) return void (await ctx.reply(`No watches yet.\n\n${USAGE}`));
            const out = [`*Active (${act.length}/${MAX_ACTIVE})*`, ...(act.length ? act.map(line) : ['none'])];
            if (ended.length) out.push('', '*Recently ended*', ...ended.map(line));
            return void (await ctx.reply(out.join('\n')));
          }
          case 'info': case 'show': {
            const t = watcher.get(rest);
            if (!t) return void (await ctx.reply('No watch with that id. Try: Lohra watch list'));
            const out = [
              line(t),
              `Asked: “${t.instruction}”`,
              t.rubric ? `Check: ${t.rubric}` : 'Check: none (any next item counts)',
              `Stats: ${t.stats.seen} seen · ${t.stats.evaluated} AI checks · ${t.stats.matches} matches · ${t.stats.errors} errors`,
              ...(t.recent.length ? ['Latest:', ...t.recent.slice(0, 5).map((e) => `${e.match ? '✅' : '▫️'} ${e.type} · ${e.reason || '—'}`)] : []),
            ];
            return void (await ctx.reply(out.join('\n')));
          }
          case 'cancel': case 'stop': case 'rm': case 'remove': case 'delete': {
            let hit = await watcher.cancel(rest || '__none__');
            if (!hit.length && rest) {
              const q = norm(rest.replace(/^watching\s+/i, ''));
              for (const t of watcher.active().filter((x) => q && norm(x.target.name).includes(q))) hit.push(...(await watcher.cancel(t.id)));
            }
            return void (await ctx.reply(hit.length ? `Cancelled ${hit.map((t) => `#${t.id} (${t.target.name})`).join(', ')}` : 'Nothing matched. Try: Lohra watch list'));
          }
          default: return void (await create(ctx, text));
        }
      },
    },
  },
};
