// Shared "did you mean ...?" step for anything that looks up a person by name (watch, status, ...).
// A command that can't find "pressure" calls api.dym.offer(ctx, { query, ranked, onPick }); the owner answers with
//   Lohra yes · Lohra no · Lohra 1 / 2 / 3 · Lohra pick <name>  (narrows the offered list)
// Matching is sound-alike + spelling (plugins/_names.js), never AI. A sound-alike is only ever a suggestion: nothing runs until you confirm.
import { suggest, askShape } from './_names.js';

const TTL_MS = 3 * 60_000;
const MAX_OPTIONS = 5;
const label = (c) => c.name || `+${c.number}`;

const state = (api) => (api.dymPending ??= new Map()); // on api, so a hot-reload of this file keeps open questions

function question(ctx, query, options, { ambiguous = false, narrowed = false } = {}) {
  const p = ctx.prefix || '';
  const head = ambiguous ? `More than one contact matches "${query}".` : narrowed ? 'Narrowed down:' : `I don't have "${query}" in contacts.`;
  if (options.length === 1) return `${head} Did you mean *${label(options[0])}*?\nReply: ${p}yes · ${p}no`;
  const nums = options.map((_, i) => `${p}${i + 1}`).join(' · ');
  return `${head} ${ambiguous ? 'Which one?' : 'Did you mean:'}\n${options.map((c, i) => `${i + 1}. ${label(c)}`).join('\n')}\nReply: ${nums} · ${p}no\nOr narrow it down: ${p}pick <name>`;
}

export default {
  name: 'didyoumean',
  version: '1.0.0',
  description: 'Shared "did you mean ...?" for name lookups: sound-alike matching, no AI',
  init: async (api) => {
    api.dym = {
      /** ranked: [{ contact, score }] best first. list: always show a numbered list (use for real ambiguity). onPick(contact, ctx) runs on confirmation. */
      async offer(ctx, { query, ranked, list = false, onPick }) {
        const top = ranked.slice(0, MAX_OPTIONS);
        const options = top.map((r) => r.contact);
        const single = !list && askShape(top) === 'single';
        const shown = single ? options.slice(0, 1) : options.slice(0, 3);
        state(api).set(ctx.jid, { query, options: shown, onPick, ambiguous: list, expires: Date.now() + TTL_MS });
        await ctx.reply(question(ctx, query, shown, { ambiguous: list }));
      },
    };
  },
  dispose: async () => {},
  commands: {
    pick: {
      aliases: ['yes', 'y', 'no', 'n', '1', '2', '3', '4', '5'],
      description: 'Answer a "did you mean" question: yes / no / 1-3 / pick <name>',
      ownerOnly: true,
      run: async (ctx) => {
        const pending = state(ctx.api);
        const entry = pending.get(ctx.jid);
        if (!entry || entry.expires < Date.now()) {
          pending.delete(ctx.jid);
          return void (await ctx.reply('Nothing is waiting for an answer (questions expire after 3 minutes).'));
        }
        const choose = async (c) => { pending.delete(ctx.jid); await entry.onPick(c, ctx); };
        const word = ctx.command === 'pick' ? (ctx.args[0] || '').toLowerCase() : ctx.command;

        if (word === 'no' || word === 'n') { pending.delete(ctx.jid); return void (await ctx.reply('Okay, cancelled. Try the full name or their number.')); }
        if (word === 'yes' || word === 'y') {
          if (entry.options.length === 1) return void (await choose(entry.options[0]));
          return void (await ctx.reply(`Which one? ${question(ctx, entry.query, entry.options, { ambiguous: true }).split('\n').slice(1).join('\n')}`));
        }
        if (/^[1-5]$/.test(word)) {
          const c = entry.options[Number(word) - 1];
          return void (await (c ? choose(c) : ctx.reply(`Pick a number from 1 to ${entry.options.length}, or ${ctx.prefix}no.`)));
        }

        // "pick <name>": narrow the offered list with what the owner just typed
        const typed = ctx.argText.trim();
        if (!typed) return void (await ctx.reply(question(ctx, entry.query, entry.options, { ambiguous: entry.ambiguous })));
        const narrowed = suggest(typed, entry.options, { limit: MAX_OPTIONS, min: 0.55 });
        if (!narrowed.length) return void (await ctx.reply(`None of these sound like "${typed}".\n${question(ctx, entry.query, entry.options, { ambiguous: entry.ambiguous })}`));
        if (narrowed.length === 1 || askShape(narrowed) === 'single') return void (await choose(narrowed[0].contact));
        entry.options = narrowed.map((r) => r.contact).slice(0, 3);
        entry.expires = Date.now() + TTL_MS;
        await ctx.reply(question(ctx, typed, entry.options, { narrowed: true }));
      },
    },
  },
};
