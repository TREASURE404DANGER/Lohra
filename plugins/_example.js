// Copy to e.g. hello.js (remove the leading underscore) to enable.
export default {
  name: 'hello',
  version: '1.0.0',
  description: 'Example plugin',
  commands: {
    hello: {
      aliases: ['hi'],
      description: 'Say hello',
      // ownerOnly: true,
      run: async (ctx) => ctx.reply(`Hello ${ctx.argText || 'there'}!`),
    },
  },
  // on: { 'group-participants.update': async (data, api) => {} },
  // init: async (api) => {}, dispose: async () => {},
};
