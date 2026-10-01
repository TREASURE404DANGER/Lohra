import { normalizeMessageContent } from 'baileys';
import { withTimeout } from './util.js';

export const digitsOf = (jid) => String(jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');

export function extractText(c) {
  if (!c) return '';
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';
}

/** Word prefixes need a space after them ("Lohra ping"); symbol prefixes do not (".ping"). */
export const needsSpace = (prefix) => /[a-z0-9]$/i.test(prefix);

/** "lohra Ping a b" -> { name: 'ping', args: ['a','b'], argText: 'a b' } (null when not a command). Prefix is case-insensitive. */
export function parseCommand(text, prefix) {
  if (!text || !prefix || text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  const rest = text.slice(prefix.length);
  if (needsSpace(prefix) && !/^\s/.test(rest)) return null;
  const m = rest.trim().match(/^([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const argText = (m[2] || '').trim();
  return { name: m[1].toLowerCase(), args: argText ? argText.split(/\s+/) : [], argText };
}

const IGNORED = (jid) => jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');

/** Turns incoming messages into commands and runs them through the plugin manager. */
export class Bot {
  constructor({ config, conn, store, log, plugins, sender }) {
    Object.assign(this, { cfg: config, conn, store, log, plugins, sender });
  }

  start() {
    this.conn.on('messages.upsert', (e) => this.#onUpsert(e).catch((err) => this.log.error({ err: err.message }, 'upsert handler failed')));
    this.conn.on('groups.upsert', (gs) => gs.forEach((g) => this.store.groups.set(g.id, g)));
    this.conn.on('group-participants.update', ({ id }) => this.store.groups.delete(id));
  }

  #isAllowed(key) {
    const ids = [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt].map(digitsOf).filter(Boolean);
    return ids.some((d) => this.cfg.allowed.includes(d));
  }

  async #onUpsert({ messages, type }) {
    for (const m of messages) this.store.rememberMessage(m);
    if (type !== 'notify') return;
    for (const m of messages) this.#handle(m).catch((err) => this.log.error({ err: err.message }, 'message handler failed'));
  }

  async #handle(m) {
    const key = m.key;
    if (!key?.remoteJid || IGNORED(key.remoteJid)) return;
    if (key.id && this.store.isSent(key.id)) return; // never react to our own output

    const cmd = parseCommand(extractText(normalizeMessageContent(m.message)).trim(), this.cfg.prefix);
    if (!cmd) return;

    const ts = Number(m.messageTimestamp) || 0;
    if (ts && Date.now() / 1000 - ts > this.cfg.commandMaxAgeSec) return; // stale replay after downtime

    const isOwner = !!key.fromMe || this.#isAllowed(key);
    if (!isOwner && !this.cfg.public) return;

    const entry = this.plugins.resolve(cmd.name);
    if (!entry) return;

    const jid = key.remoteJid;
    const sender = key.participant || jid;
    const send = (content, opts) => this.sender.send(jid, content, opts);
    const ctx = {
      api: this.plugins.api, msg: m, jid, sender, isOwner, isGroup: jid.endsWith('@g.us'),
      command: cmd.name, args: cmd.args, argText: cmd.argText, prefix: needsSpace(this.cfg.prefix) ? `${this.cfg.prefix} ` : this.cfg.prefix,
      send,
      reply: (text, opts) => send({ text: String(text) }, { quoted: m, ...opts }),
      react: (emoji) => send({ react: { text: emoji, key } }),
    };

    if (entry.command.ownerOnly && !isOwner) return void (await ctx.reply('Owner only.'));

    this.log.info({ cmd: cmd.name, from: sender, plugin: entry.plugin }, 'command');
    try {
      await withTimeout(entry.command.run(ctx), 60_000, `command ${cmd.name}`);
    } catch (err) {
      this.log.error({ cmd: cmd.name, err: err.message }, 'command failed');
      await ctx.reply(`Command failed: ${err.message}`).catch(() => {});
    }
  }
}
