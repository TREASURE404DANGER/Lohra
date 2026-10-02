// "Lohra guide": the built-in manual. Plain language by default, "Lohra guide dev" for how and why everything works.
//   Lohra guide                 menu (simple)           Lohra guide <topic>        one topic (simple)
//   Lohra guide dev             menu (technical)        Lohra guide dev <topic>    one topic (technical)
//   Lohra guide dev check       commands that are loaded but missing from the manual
// All the text lives in _guide.js. Kept separate from the built-in "help" (a one-line command list) because command names must be unique.
import { menu, topicText, find, chunk, audienceOf, missingFrom } from './_guide.js';

export default {
  name: 'guide',
  version: '1.0.0',
  description: 'Manual: Lohra guide (simple) · Lohra guide dev (technical)',
  commands: {
    guide: {
      aliases: ['howto', 'manual'],
      description: 'How everything works: Lohra guide | guide <topic> | guide dev',
      ownerOnly: true,
      run: async (ctx) => {
        const words = ctx.args.map((w) => w.toLowerCase());
        let audience = 'user';
        if (words.length && audienceOf(words[0]) === 'dev') { audience = 'dev'; words.shift(); }
        const p = ctx.prefix;
        const send = async (text) => { for (const part of chunk(text)) await ctx.reply(part); };

        if (audience === 'dev' && words[0] === 'check') {
          const names = [...ctx.api.plugins.commands.keys()];
          const missing = missingFrom(names);
          return send(missing.length
            ? `Not in the manual yet: ${missing.join(', ')}\nAdd them to a topic's "commands" in plugins/_guide.js.`
            : `All ${names.length} loaded commands (and aliases) are covered by the manual.`);
        }
        if (!words.length) return send(menu(audience, p));
        const q = words.join(' ');
        const topic = find(words[0], audience) || find(q, audience);
        if (!topic) return send(`I don't have a topic called "${q}".\n\n${menu(audience, p)}`);
        return send(topicText(topic, audience, p));
      },
    },
  },
};
