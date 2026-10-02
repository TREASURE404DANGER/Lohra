// Agent channel: lets an external agent (via cli/wabctl) PROPOSE actions; only the owner can approve them, on WhatsApp.
//   send   -> confirmation lands in your own chat. React 👍 = send now, 🙏 = drop it as a draft, 😢 = decline (or reply yes / draft / no).
//   draft  -> goes straight into your own chat (nothing leaves your account), so no approval is needed.
// The agent has no way to approve: approval exists only as a reaction/reply from the owner account (or the owner's "Lohra agent" command).
// Control socket: data/agent/control.sock (0600). State: data/agent/state.json. Audit: data/agent/audit.jsonl. Contacts: data/contacts.json.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeMessageContent } from 'baileys';
import { atomicWrite, withTimeout } from '../src/util.js';
import { extractText, digitsOf } from '../src/bot.js';
import { runAgentCommand } from './_agentlive.js';
import { parseRequest, cleanText as cleanJudgeText } from './_judge.js';
import { TOOL_DECLS, SYSTEM_PROMPT, makeDispatch, commandReply, STATE_TOOLS } from './_agenttools.js';
import { BULK, planRecipients, bulkPrompt, personalize, pickDelaySec, gapMs, humanDuration, estimateSec, finalNote, counts, toList } from './_bulk.js';
import { loadContacts, resolveRecipient, display, mask, classifyEmoji, classifyWord, parseContactInput, saveContact, deleteContact } from './_contacts.js';

const DEFAULTS = {
  ttlSec: 600, minTtlSec: 30, maxTtlSec: 3600, // how long an approval request stays open
  maxPending: 5, maxPerHour: 20, maxText: 4000,
  allowRawNumbers: true,      // false = agent may only message people in contacts.json
  defaultCountryCode: '',     // e.g. "234": lets "0801..." style numbers work
  verifyNumbers: true,        // check the number is on WhatsApp before asking you
  bulkDelaySec: BULK.delaySec, bulkJitter: BULK.jitter, maxBulk: BULK.maxRecipients, maxBulkPerDay: BULK.maxPerDay, bulkFailStreak: BULK.failStreak, // broadcasts
};
const FINAL = new Set(['sent', 'drafted', 'declined', 'expired', 'cancelled', 'failed']);
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const err = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
const human = (sec) => (sec < 120 ? `${sec}s` : `${Math.round(sec / 60)} min`);

export class Agent {
  constructor(api, { now = Date.now, sleep = null } = {}) {
    this.api = api; this.log = api.log; this.now = now; this.sleepFn = sleep; this.bulkRun = null;
    this.dir = path.join(api.config.dataDir, 'agent');
    this.contactsFile = path.join(api.config.dataDir, 'contacts.json');
    this.actions = new Map();
    this.byMsg = new Map();
    this.paused = false;
    this.cfg = { ...DEFAULTS };
    this.stamps = [];
    this.server = null; this.timer = null; this.#chain = Promise.resolve();
  }
  #chain;

  // ---------- lifecycle ----------
  async start() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.#loadConfig();
    await this.#loadState();
    await this.#listen();
    this.timer = setInterval(() => this.sweep().catch((e) => this.log.warn({ err: e.message }, 'agent sweep failed')), 15_000);
    this.timer.unref?.();
    this.log.info({ pending: this.#pending().length, paused: this.paused }, 'agent channel ready');
  }

  async stop() {
    clearInterval(this.timer);
    const run = this.bulkRun;
    if (run) { run.stop = true; run.reason = 'the bot was reloaded'; run.wake?.(); await Promise.race([run.done, new Promise((r) => setTimeout(r, 15_000))]).catch(() => {}); }
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
    await this.#chain.catch(() => {});
  }

  async #loadConfig() {
    try { Object.assign(this.cfg, JSON.parse(await fs.readFile(path.join(this.dir, 'config.json'), 'utf8'))); } catch { /* defaults */ }
  }

  async #loadState() {
    let s = {};
    const file = path.join(this.dir, 'state.json');
    try { s = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') { await fs.rename(file, `${file}.bad`).catch(() => {}); this.log.warn('agent state unreadable, starting fresh'); }
    }
    this.paused = !!s.paused;
    for (const a of Object.values(s.actions || {})) {
      if (a.type === 'bulk' && a.status === 'sending') {
        for (const r of a.recips) if (r.status === 'queued') r.status = 'skipped';
        const c = counts(a);
        Object.assign(a, { status: 'failed', interrupted: true, error: `interrupted by a restart: ${c.sent} sent, ${c.skipped + c.failed} NOT sent` });
      } else if (a.status === 'sending' || a.status === 'drafting') Object.assign(a, { status: 'failed', error: 'interrupted by a restart: check the chat before retrying' });
      if (a.status === 'pending' && a.expiresAt <= this.now()) a.status = 'expired';
      this.actions.set(a.id, a);
      if (a.msgId) this.byMsg.set(a.msgId, a.id);
    }
    this.#prune();
    await this.#save();
  }

  #save() {
    const snap = JSON.stringify({ paused: this.paused, actions: Object.fromEntries(this.actions) });
    this.#chain = this.#chain.then(() => atomicWrite(path.join(this.dir, 'state.json'), snap)).catch((e) => this.log.warn({ err: e.message }, 'agent state write failed'));
    return this.#chain;
  }

  #prune() {
    const cut = this.now() - 7 * 86400_000;
    const done = [...this.actions.values()].filter((a) => FINAL.has(a.status)).sort((a, b) => b.createdAt - a.createdAt);
    for (const a of done.slice(150).concat(done.filter((x) => x.createdAt < cut))) {
      this.actions.delete(a.id);
      if (a.msgId) this.byMsg.delete(a.msgId);
    }
  }

  async #audit(event, a, extra = {}) {
    const file = path.join(this.dir, 'audit.jsonl');
    const line = JSON.stringify({ t: new Date(this.now()).toISOString(), event, id: a?.id, type: a?.type, to: a?.to?.name ?? a?.to?.display, status: a?.status, ...extra }) + '\n';
    try {
      if ((await fs.stat(file).catch(() => ({ size: 0 }))).size > 5_000_000) await fs.rename(file, `${file}.1`);
      await fs.appendFile(file, line, { mode: 0o600 });
    } catch (e) { this.log.warn({ err: e.message }, 'audit write failed'); }
  }

  // ---------- control socket ----------
  async #listen() {
    const sock = process.platform === 'win32'
      ? path.join('\\\\.\\pipe\\lohra-agent', crypto.randomBytes(4).toString('hex'))
      : path.join(this.dir, 'control.sock');
    
    if (process.platform !== 'win32') await fs.rm(sock, { force: true }).catch(() => {});
    
    this.server = net.createServer((c) => this.#onConn(c));
    await new Promise((res, rej) => { 
      this.server.once('error', (err) => {
        if (process.platform === 'win32') { this.log.warn('Agent CLI socket skipped on Windows'); res(); } else rej(err);
      });
      this.server.listen(sock, () => { this.server.off('error', rej); res(); }); 
    });
    if (process.platform !== 'win32') await fs.chmod(sock, 0o600).catch(() => {});
  }

  #onConn(c) {
    c.setTimeout(60_000, () => c.destroy());
    c.on('error', () => {});
    let buf = '';
    let done = false;
    c.on('data', async (d) => {
      if (done) return;
      buf += d;
      if (buf.length > 65_536) return void c.destroy();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      done = true;
      let res;
      try { res = await this.handle(JSON.parse(buf.slice(0, i))); } catch (e) { res = err('bad_request', `Could not read the request: ${e.message}`); }
      c.end(JSON.stringify(res) + '\n');
    });
  }

  async handle(req) {
    try {
      switch (req?.op) {
        case 'ping': return { ok: true, pong: true };
        case 'status': return this.#status();
        case 'contacts.list': return await this.#contactsList();
        case 'contacts.find': return await this.#contactsFind(req.query);
        case 'contacts.add': return await this.addContact(req);
        case 'contacts.remove': return await this.removeContact(req.name);
        case 'status.get': return await this.#statusGet(req);
        case 'msgs.find': return await this.#msgsFind(req);
        case 'msgs.send': return await this.#msgsSend(req);
        case 'watch.add': return await this.#watchAdd(req);
        case 'watch.list': return this.#watchList();
        case 'watch.cancel': return await this.#watchCancel(req);
        case 'send': return await this.#propose('send', req);
        case 'draft': return await this.#propose('draft', req);
        case 'send.bulk': return await this.#proposeBulk(req);
        case 'stop': return await this.stopBulk(req.id);
        case 'notify': return await this.#notify(req.text);
        case 'get': return this.#get(req.id);
        case 'list': return this.#list();
        case 'cancel': return await this.cancel(req.id);
        default: return err('unknown_op', `Unknown operation "${req?.op}".`);
      }
    } catch (e) {
      this.log.error({ err: e.message, op: req?.op }, 'agent request failed');
      return err('internal', e.message);
    }
  }

  // ---------- watching (ongoing monitoring of a contact's NEW statuses/messages) ----------
  // Event-driven (see _watch.js): nothing is polled. Matches are delivered to the owner's own chat, never to the contact.
  async #watchAdd(req) {
    if (this.paused) return err('paused', 'The owner has paused agent actions.', { hint: 'Tell the owner; they can resume with "Lohra agent resume".' });
    const w = this.api.watch;
    if (!w) return err('watch_unavailable', 'The watch engine is not running right now.', { retryable: true });
    const who = String(req.contact || '').trim();
    if (!who) return err('invalid_contact', 'Say whose statuses or messages to watch.');
    const kind = req.kind === 'message' ? 'message' : req.kind === 'status' ? 'status' : null;
    if (!kind) return err('invalid_kind', 'kind must be "status" (status/story updates) or "message" (chat messages).');
    let condition = cleanJudgeText(req.condition, 120).replace(/\s+/g, ' ').trim();
    const keep = req.keep_watching === true || req.keep_watching === 'true';
    const hours = Math.min(720, Math.max(1, Number(req.hours) || 168));
    const anywhere = kind === 'message' && req.anywhere === true;

    const { contacts, error } = await this.#contacts();
    if (error) return err('contacts_unreadable', error);
    const r = resolveRecipient(contacts, who, { allowRaw: this.cfg.allowRawNumbers, defaultCc: this.cfg.defaultCountryCode });
    if (r.status !== 'ok') return this.#resolved(r, who);
    const c = r.contact;
    if (c.group || !c.number) return err('invalid_contact', 'Only individual contacts with a phone number can be watched, not groups.');
    const name = c.name || `+${c.number}`;

    let rubric = '';
    if (condition) {
      const key = (process.env.GEMINI_API_KEY || '').trim();
      if (!key) return err('no_api_key', 'GEMINI_API_KEY is not set, so the check for that condition cannot be built.');
      try {
        const spec = await parseRequest(`Watch ${name} for their next ${kind}: ${condition}`, { key });
        if (!spec.ok) return err('invalid_request', spec.problem || 'That is not something I can watch for.');
        rubric = spec.rubric;
        condition = spec.condition || condition;
      } catch (e) { return err('rubric_failed', `Could not build the check (${e.message}).`, { retryable: true }); }
    }

    const instruction = String(req.request || `${name}: ${kind}${condition ? ` ${condition}` : ''}`).slice(0, 300);
    let task;
    try {
      task = await w.add({ target: { name, number: c.number, jid: c.jid }, kind, condition, rubric, once: !keep, anywhere, ttlHours: hours, instruction });
    } catch (e) {
      if (e.existing) return { ok: true, status: 'already_watching', id: e.existing.id, note: 'An identical watch is already running; nothing was added.' };
      return err('watch_failed', e.message);
    }
    if (req.source !== 'voice') await this.#notify(`👀 Watching ${name}'s next ${kind}${condition ? ` that ${condition}` : ''} (#${task.id}, ${keep ? 'keeps going after matches' : 'stops after the first match'}). Cancel: Lohra watch cancel ${task.id}`).catch(() => {});
    return {
      ok: true, status: 'watching', id: task.id, contact: name, kind, condition: condition || null, keep_watching: keep, expires_in_hours: hours,
      how_it_works: 'Not a timer: the bot reacts the moment a new item arrives and posts matches (with the media) in the owner\'s own chat.',
    };
  }

  #watchList() {
    const w = this.api.watch;
    if (!w) return err('watch_unavailable', 'The watch engine is not running right now.', { retryable: true });
    const row = (t) => ({ id: t.id, contact: t.target.name, kind: t.kind, condition: t.condition || null, keep_watching: !t.once, state: t.state, hours_left: t.state === 'active' ? Math.round(((t.expiresAt - this.now()) / 3600e3) * 10) / 10 : null, seen: t.stats.seen, matches: t.stats.matches });
    const ended = w.list().filter((t) => t.state !== 'active').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 5);
    return { ok: true, active: w.active().map(row), recently_ended: ended.map(row) };
  }

  async #watchCancel(req) {
    const w = this.api.watch;
    if (!w) return err('watch_unavailable', 'The watch engine is not running right now.', { retryable: true });
    const which = String(req.id || req.contact || '').trim();
    if (!which) return err('invalid_id', 'Give a watch id, a contact name, or "all".');
    let hit = await w.cancel(which);
    if (!hit.length) {
      const q = which.toLowerCase().replace(/^watching\s+/, '');
      for (const t of w.active().filter((x) => q && x.target.name.toLowerCase().includes(q))) hit.push(...(await w.cancel(t.id)));
    }
    if (!hit.length) return err('not_found', `No active watch matches "${which}".`, { hint: 'Call list_watches to see the ids.' });
    return { ok: true, status: 'cancelled', cancelled: hit.map((t) => ({ id: t.id, contact: t.target.name })) };
  }

  // ---------- helpers ----------
  async #statusGet(req) {
    const contact = String(req.contact || req.query || '').trim();
    if (!contact) return err('invalid_contact', 'Please specify a contact name.');
    const self = this.#self();
    if (!self) return err('bot_offline', 'The WhatsApp bot is not connected right now.', { retryable: true });
    const { contacts } = await this.#contacts();
    const statusStore = this.api.status;
    if (!statusStore) return err('status_unavailable', 'Status manager is not running.');
    return await statusStore.deliverLatest(contact, contacts, self);
  }

  // ---------- looking back at saved chats (see _archive.js) ----------
  // Read-only search, plus delivery of a saved message into the OWNER's own chat. Nothing here ever goes to the contact.
  async #msgsFind(req) {
    const archive = this.api.archive;
    if (!archive) return err('archive_unavailable', 'The chat archive is not running right now.', { retryable: true });
    const who = String(req.contact || '').trim();
    if (!who) return err('invalid_contact', 'Say whose chat to look in.');
    const kind = String(req.kind || 'any').toLowerCase();
    if (!['any', 'text', 'voice', 'image', 'video', 'document', 'sticker'].includes(kind)) return err('invalid_kind', 'kind must be any, text, voice, image, video, document or sticker.');
    const from = String(req.from || 'any').toLowerCase();
    if (!['any', 'them', 'me'].includes(from)) return err('invalid_from', 'from must be any, them or me.');
    const { contacts, error } = await this.#contacts();
    if (error) return err('contacts_unreadable', error);
    const r = resolveRecipient(contacts, who, { allowRaw: this.cfg.allowRawNumbers, defaultCc: this.cfg.defaultCountryCode });
    if (r.status !== 'ok') return this.#resolved(r, who);
    const c = r.contact;
    const name = c.name || (c.number ? `+${c.number}` : 'that chat');
    const rows = await archive.find({ number: c.number, jid: c.group ? c.jid : undefined, kind, from, query: cleanJudgeText(req.query, 120), limit: Number(req.limit) || 5, sinceHours: Number(req.hours) || 0 });
    const st = archive.stats();
    if (!rows.length) {
      return err('none_found', `No saved ${kind === 'any' ? '' : `${kind} `}messages with ${name}${req.query ? ` matching "${req.query}"` : ''}.`, {
        archive_since: st.since ? new Date(st.since).toISOString() : null,
        hint: `Only messages the bot saw while connected are kept (for ${st.retention_days} days${st.enabled ? '' : '; the archive is switched OFF'}); it cannot read older chats. Say so plainly. For FUTURE messages offer watch_contact.`,
      });
    }
    const out = { ok: true, contact: name, count: rows.length, messages: rows };
    if (req.deliver_newest === true || req.deliver_newest === 'true') out.delivered = await this.#msgsSend({ id: rows[0].id, who: name, source: req.source });
    return out;
  }

  async #msgsSend(req) {
    if (this.paused) return err('paused', 'The owner has paused agent actions.', { hint: 'Tell the owner; they can resume with "Lohra agent resume".' });
    const archive = this.api.archive;
    if (!archive) return err('archive_unavailable', 'The chat archive is not running right now.', { retryable: true });
    const self = this.#self();
    if (!self) return err('bot_offline', 'The WhatsApp bot is not connected right now.', { retryable: true });
    const rec = archive.get(req.id);
    if (!rec) return err('not_found', 'No saved message has that id.', { hint: 'Call find_messages first and use an id from its result.' });
    const now = this.now();
    this.deliveries = (this.deliveries || []).filter((t) => now - t < 3600_000);
    if (this.deliveries.length >= 15) return err('rate_limited', 'Too many messages forwarded to the owner this hour (15).', { hint: 'Tell the owner and try later.' });
    this.deliveries.push(now);
    const res = await archive.deliver(rec, self, { send: this.api.send, who: req.who || '' });
    await this.#audit('msg_delivered', null, { msg: rec.id, kind: rec.kind, ok: res.ok, error: res.error, source: req.source || 'wabctl' });
    return res.ok ? { ok: true, status: 'delivered_to_owner', kind: res.kind, note: 'It is in the owner\'s own chat now. Nothing was sent to the contact.' } : res;
  }

  #self() {
    const { conn } = this.api;
    const d = digitsOf(conn.sock?.user?.id);
    return conn.state === 'open' && d ? `${d}@s.whatsapp.net` : null;
  }
  #isOwner(m) { return !!m.key?.fromMe || [m.key?.participant, m.key?.remoteJid].map(digitsOf).some((d) => d && this.api.config.allowed?.includes(d)); }
  #pending() { return [...this.actions.values()].filter((a) => a.status === 'pending'); }
  #view(a) {
    return {
      id: a.id, type: a.type, status: a.status, to: a.to.name ?? a.to.display, recipient_hint: a.to.hint, text: a.text,
      created_at: new Date(a.createdAt).toISOString(), expires_at: a.type === 'send' ? new Date(a.expiresAt).toISOString() : undefined,
      decided_via: a.via, error: a.error,
      ...(a.type === 'bulk' ? { recipients: a.recips.length, ...counts(a), delay_sec: a.delaySec, skipped_people: a.skipped } : {}),
    };
  }
  #newId() { let id; do { id = Array.from({ length: 4 }, () => ID_CHARS[crypto.randomInt(ID_CHARS.length)]).join(''); } while (this.actions.has(id)); return id; }
  #quote(a) { return { key: { remoteJid: a.selfJid, fromMe: true, id: a.msgId }, message: { conversation: a.prompt } }; }
  async #note(a, text) { try { await this.api.send(a.selfJid, { text }, { quoted: this.#quote(a) }); } catch (e) { this.log.warn({ err: e.message }, 'agent note failed'); } }
  async #contacts() { return loadContacts(this.contactsFile, { defaultCc: this.cfg.defaultCountryCode }); }

  #status() {
    const { conn, startedAt } = this.api;
    return { ok: true, connection: conn.state, uptime_sec: Math.round((this.now() - startedAt) / 1000), paused: this.paused, pending: this.#pending().length, defaults: { ttl_sec: this.cfg.ttlSec } };
  }

  async #contactsList() {
    const { contacts, error, warnings } = await this.#contacts();
    if (error) return err('contacts_unreadable', error);
    return { ok: true, count: contacts.length, contacts: contacts.map((c) => ({ name: c.name, aliases: c.aliases, hint: mask(c) })), warnings };
  }

  async #contactsFind(query) {
    const { contacts, error } = await this.#contacts();
    if (error) return err('contacts_unreadable', error);
    const r = resolveRecipient(contacts, query, { allowRaw: this.cfg.allowRawNumbers, defaultCc: this.cfg.defaultCountryCode });
    return this.#resolved(r, query, true);
  }

  #resolved(r, query, findOnly = false) {
    const c = r.contact;
    switch (r.status) {
      case 'ok': return findOnly ? { ok: true, match: { name: c.name ?? null, hint: mask(c), matched_by: r.matchedBy } } : null;
      case 'ambiguous': return err('ambiguous_contact', `More than one contact matches "${query}".`, { candidates: r.candidates.map((x) => ({ name: x.name, hint: mask(x) })), hint: 'Ask the owner which one they mean.' });
      case 'none': return err('contact_not_found', `No contact matches "${query}".`, { suggestions: r.suggestions.map((x) => x.name), hint: 'Ask the owner who they mean, or for the full phone number with country code.' });
      case 'blocked': return err(r.error, 'Only people saved in contacts.json can be messaged.');
      default: return err(r.error, r.error === 'needs_country_code' ? 'That number needs a country code (e.g. +234...).' : `Invalid recipient (${r.error}).`);
    }
  }

  // ---------- proposing ----------
  async #propose(type, req) {
    if (this.paused) return err('paused', 'The owner has paused agent actions.', { hint: 'Tell the owner; they can resume with "Lohra agent resume".' });
    const text = typeof req.text === 'string' ? req.text.replace(/\r\n/g, '\n').trim() : '';
    if (!text) return err('invalid_text', 'The message text is empty.');
    if (text.length > this.cfg.maxText) return err('invalid_text', `The message is too long (max ${this.cfg.maxText} characters).`);
    if (CTRL.test(text)) return err('invalid_text', 'The message contains control characters.');

    const { contacts, error } = await this.#contacts();
    if (error) return err('contacts_unreadable', error);
    const r = resolveRecipient(contacts, req.to, { allowRaw: this.cfg.allowRawNumbers, defaultCc: this.cfg.defaultCountryCode });
    if (r.status !== 'ok') return this.#resolved(r, req.to);

    const self = this.#self();
    if (!self) return err('bot_offline', 'The WhatsApp bot is not connected right now.', { retryable: true });

    const c = r.contact;
    const dupe = this.#pending().find((a) => a.type === type && a.to.jid === c.jid && a.text === text);
    if (dupe) return { ok: true, duplicate: true, ...this.#view(dupe), message: 'The same request is already waiting for the owner.' };
    if (type === 'send' && this.#pending().length >= this.cfg.maxPending) return err('too_many_pending', 'Too many requests are waiting for the owner.', { hint: 'Wait for the owner to answer the pending ones first.' });
    const hourAgo = this.now() - 3600_000;
    this.stamps = this.stamps.filter((t) => t > hourAgo);
    if (this.stamps.length >= this.cfg.maxPerHour) return err('rate_limited', 'Too many requests in the last hour.', { retryable: true });
    this.stamps.push(this.now());

    let jid = c.jid;
    let verified = null;
    if (type === 'send' && this.cfg.verifyNumbers && !c.group) {
      try {
        const sock = await withTimeout(this.api.conn.waitOpen(5000), 6000, 'connection');
        const hit = (await withTimeout(sock.onWhatsApp(c.jid), 8000, 'number check'))?.[0];
        if (hit && hit.exists === false) return err('not_on_whatsapp', `${display(c)} is not on WhatsApp.`, { hint: 'Check the number with the owner.' });
        if (hit?.exists) { verified = true; if (hit.jid) jid = hit.jid; }
      } catch { verified = false; }
    }

    const ttl = Math.min(this.cfg.maxTtlSec, Math.max(this.cfg.minTtlSec, Number(req.ttl) || this.cfg.ttlSec));
    const a = {
      id: this.#newId(), type, status: 'pending', query: String(req.to), matchedBy: r.matchedBy, verified, text,
      to: { name: c.name, number: c.number, jid, group: c.group, display: display(c), hint: mask(c) },
      selfJid: self, createdAt: this.now(), expiresAt: this.now() + ttl * 1000, source: String(req.source || '').slice(0, 40),
    };
    this.actions.set(a.id, a);
    await this.#audit('proposed', a, { text, matchedBy: r.matchedBy, verified, source: a.source });

    try {
      if (type === 'draft') {
        a.status = 'drafting';
        await this.#deliverDraft(a);
        a.status = 'drafted'; a.decidedAt = this.now(); a.via = 'agent';
        await this.#audit('drafted', a);
        await this.#save();
        return { ok: true, ...this.#view(a), message: 'The draft is in the owner\'s WhatsApp chat with themselves. Nothing was sent to the recipient.' };
      }
      a.prompt = this.#prompt(a, ttl);
      const res = await this.api.send(self, { text: a.prompt });
      a.msgId = res?.key?.id;
      if (!a.msgId) throw new Error('no message id returned');
      this.byMsg.set(a.msgId, a.id);
    } catch (e) {
      this.actions.delete(a.id);
      await this.#audit('failed', a, { error: e.message });
      return err('send_failed', `Could not reach the owner's WhatsApp: ${e.message}`, { retryable: true });
    }
    await this.#save();
    this.log.info({ id: a.id, to: a.to.name ?? a.to.display }, 'agent: approval requested');
    return { ok: true, ...this.#view(a), message: 'Waiting for the owner to approve on WhatsApp (nothing has been sent yet). Tell them to check their phone, then use wait_for_action / check_action.' };
  }


  // ---------- broadcasts: one message, several people, paced ----------
  async #proposeBulk(req) {
    if (this.paused) return err('paused', 'The owner has paused agent actions.', { hint: 'Tell the owner; they can resume with "Lohra agent resume".' });
    const text = typeof req.text === 'string' ? req.text.replace(/\r\n/g, '\n').trim() : '';
    if (!text) return err('invalid_text', 'The message text is empty.');
    if (text.length > this.cfg.maxText) return err('invalid_text', `The message is too long (max ${this.cfg.maxText} characters).`);
    if (CTRL.test(text)) return err('invalid_text', 'The message contains control characters.');
    if (!toList(req.to).length && !(req.all === true || req.all === 'true')) return err('no_recipients', 'Say who gets it: a list of names, or all contacts.');
    if (this.bulkRun || this.#pending().some((x) => x.type === 'bulk')) return err('bulk_busy', 'A broadcast is already waiting for approval or still sending.', { hint: 'Let the owner finish or stop that one first.' });

    const { contacts, error } = await this.#contacts();
    if (error) return err('contacts_unreadable', error);
    const self = this.#self();
    if (!self) return err('bot_offline', 'The WhatsApp bot is not connected right now.', { retryable: true });
    const plan = planRecipients(contacts, req, { selfDigits: digitsOf(self), allowRaw: this.cfg.allowRawNumbers, defaultCc: this.cfg.defaultCountryCode });
    if (!plan.ok) return this.#resolved(plan.bad.result, plan.bad.query);
    let { recips } = plan;
    const skipped = [...plan.skipped];

    // the same text already sent to someone in the last 24 h is not sent again
    const dayAgo = this.now() - 86400_000;
    const sentBefore = new Set();
    let sentToday = 0;
    for (const x of this.actions.values()) {
      if (x.type !== 'bulk') continue;
      for (const r of x.recips) if (r.status === 'sent' && (r.at || x.createdAt) > dayAgo) { sentToday++; if (x.text.trim() === text) sentBefore.add(r.jid); }
    }
    recips = recips.filter((c) => { if (sentBefore.has(c.jid)) { skipped.push({ name: c.name || display(c), reason: 'already got this message today' }); return false; } return true; });
    if (!recips.length) return err('no_recipients', 'Nobody left to send to.', { skipped });
    if (recips.length > this.cfg.maxBulk) return err('too_many_recipients', `${recips.length} people is over the limit of ${this.cfg.maxBulk} per broadcast.`, { hint: 'Split it into smaller groups, or the owner can raise maxBulk in data/agent/config.json.' });
    if (sentToday + recips.length > this.cfg.maxBulkPerDay) return err('daily_limit', `That would make ${sentToday + recips.length} broadcast messages in 24 hours (limit ${this.cfg.maxBulkPerDay}). Sending in bulk can get a WhatsApp number restricted.`, { hint: 'Tell the owner and try again later.' });

    const hourAgo = this.now() - 3600_000;
    this.stamps = this.stamps.filter((t) => t > hourAgo);
    if (this.stamps.length >= this.cfg.maxPerHour) return err('rate_limited', 'Too many requests in the last hour.', { retryable: true });
    this.stamps.push(this.now());

    // one batched "is this number on WhatsApp" check; numbers missing from the answer stay in (unverified)
    let verified = null;
    const people = recips.filter((c) => !c.group);
    if (this.cfg.verifyNumbers && people.length) {
      try {
        const sock = await withTimeout(this.api.conn.waitOpen(5000), 6000, 'connection');
        const hits = (await withTimeout(sock.onWhatsApp(...people.map((c) => c.jid)), 20_000, 'number check')) || [];
        const gone = new Set(hits.filter((h) => h.exists === false).map((h) => digitsOf(h.jid)));
        recips = recips.filter((c) => { if (!c.group && gone.has(c.number)) { skipped.push({ name: c.name || display(c), reason: 'not on WhatsApp' }); return false; } return true; });
        verified = true;
      } catch { verified = false; }
      if (!recips.length) return err('no_recipients', 'None of those numbers are on WhatsApp.', { skipped });
    }

    const delaySec = pickDelaySec(req.delay_sec, { def: this.cfg.bulkDelaySec });
    const n = recips.length;
    const label = `${n} ${n === 1 ? 'person' : 'people'}`;
    const ttl = this.cfg.ttlSec;
    const a = {
      id: this.#newId(), type: 'bulk', status: 'pending', query: label, verified, text, delaySec, skipped,
      recips: recips.map((c) => ({ jid: c.jid, number: c.number, name: c.name, group: !!c.group, status: 'queued' })),
      to: { name: label, number: null, jid: self, group: false, display: label, hint: '' },
      selfJid: self, createdAt: this.now(), expiresAt: this.now() + ttl * 1000, source: String(req.source || '').slice(0, 40),
    };
    this.actions.set(a.id, a);
    await this.#audit('proposed', a, { text, recipients: n, names: a.recips.map((r) => r.name || r.number), delaySec, skipped: skipped.length, source: a.source });
    try {
      a.prompt = bulkPrompt(a, ttl);
      const res = await this.api.send(self, { text: a.prompt });
      a.msgId = res?.key?.id;
      if (!a.msgId) throw new Error('no message id returned');
      this.byMsg.set(a.msgId, a.id);
    } catch (e) {
      this.actions.delete(a.id);
      await this.#audit('failed', a, { error: e.message });
      return err('send_failed', `Could not reach the owner's WhatsApp: ${e.message}`, { retryable: true });
    }
    await this.#save();
    this.log.info({ id: a.id, recipients: n }, 'agent: broadcast approval requested');
    return { ok: true, ...this.#view(a), message: `Waiting for the owner to approve on WhatsApp (nothing has been sent yet). It goes to ${label}, one at a time. Tell them to check their phone.` };
  }

  #startBulk(a) {
    a.status = 'sending'; a.startedAt = this.now();
    const run = { id: a.id, stop: false, reason: '', wake: null, done: null };
    this.bulkRun = run;
    run.done = this.#runBulk(a, run)
      .catch((e) => this.log.error({ err: e.message, id: a.id }, 'broadcast crashed'))
      .finally(() => { if (this.bulkRun === run) this.bulkRun = null; });
  }

  #pace(ms, run) {
    if (this.sleepFn) return this.sleepFn(ms);
    return new Promise((res) => { const t = setTimeout(res, ms); run.wake = () => { clearTimeout(t); res(); }; });
  }

  async #runBulk(a, run) {
    const total = a.recips.length;
    await this.#save();
    await this.#note(a, `*Sending to ${total} ${total === 1 ? 'person' : 'people'}*\\nOne every ${a.delaySec}s (about ${humanDuration(estimateSec(total, a.delaySec))}).\\n_Stop any time:_ *Lohra --agent stop*`);
    let streak = 0;
    let why = '';
    for (let i = 0; i < total; i++) {
      const r = a.recips[i];
      if (r.status !== 'queued') continue;
      if (run.stop || this.paused) { why = run.reason || (this.paused ? 'agent paused' : 'stopped'); break; }
      try {
        const res = await this.api.send(r.jid, { text: personalize(a.text, r) });
        r.status = 'sent'; r.sentId = res?.key?.id; r.at = this.now(); streak = 0;
      } catch (e) {
        r.status = 'failed'; r.error = String(e.message || e).slice(0, 100); streak++;
        if (streak >= this.cfg.bulkFailStreak) { why = `${streak} failures in a row, last: ${r.error}`; await this.#save(); break; }
      }
      await this.#save();
      const sent = counts(a).sent;
      if (total > 25 && r.status === 'sent' && sent % 20 === 0 && i < total - 1) await this.#note(a, `_${sent} of ${total} sent..._`);
      if (a.recips.slice(i + 1).some((x) => x.status === 'queued')) await this.#pace(gapMs(a.delaySec, this.cfg.bulkJitter), run);
    }
    for (const r of a.recips) if (r.status === 'queued') r.status = 'skipped';
    const c = counts(a);
    a.decidedAt = this.now();
    if (why) { a.status = c.sent ? 'cancelled' : 'failed'; a.error = why; } else a.status = c.sent ? 'sent' : 'failed';
    if (!why && !c.sent) a.error = 'every message failed';
    await this.#save();
    await this.#audit('bulk_done', a, { sent: c.sent, failed: c.failed, notSent: c.skipped, why });
    await this.#note(a, finalNote(a, why));
    this.log.info({ id: a.id, sent: c.sent, failed: c.failed, why }, 'agent: broadcast finished');
  }

  /** "Lohra agent stop": ends the running broadcast after the message in flight. Nobody after that gets it. */
  async stopBulk(id) {
    const run = this.bulkRun;
    const want = String(id || '').toLowerCase();
    if (!run || (want && want !== run.id)) {
      const waiting = this.#pending().find((x) => x.type === 'bulk' && (!want || x.id === want));
      if (waiting) return await this.cancel(waiting.id, 'owner');
      return err('not_running', 'No broadcast is sending right now.');
    }
    run.stop = true; run.reason = 'stopped by owner'; run.wake?.();
    return { ok: true, ...this.#view(this.actions.get(run.id)), message: 'Stopping after the message that is going out now. Nobody else will get it.' };
  }

  #prompt(a, ttl) {
    const who = a.to.name ? `*${a.to.name}* (${a.to.display})` : `*${a.to.display}*`;
    const how = a.matchedBy === 'fuzzy' || a.matchedBy === 'partial' ? ` · matched from “${a.query}”` : '';
    const warn = a.verified === false ? '\n⚠️ Could not check this number on WhatsApp.' : '';
    return [
      '📤 *Send this message?*',
      `To: ${who}${how}${warn}`,
      '',
      ...a.text.split('\n').map((l) => `> ${l}`),
      '',
      '👍 send now   🙏 draft it   😢 decline',
      `#${a.id} · expires in ${human(Math.round((a.expiresAt - a.createdAt) / 1000))}`,
    ].join('\n');
  }

  async #deliverDraft(a) {
    if (a.type === 'bulk') {
      await this.api.send(a.selfJid, { text: `*Draft for ${a.recips.length} people*\\n_Copy or forward the message below:_` });
      await this.api.send(a.selfJid, { text: a.text });
      return;
    }
    const who = a.to.name ? `*${a.to.name}* (${a.to.display})` : `*${a.to.display}*`;
    const link = !a.to.group && a.to.number ? `https://wa.me/${a.to.number}?text=${encodeURIComponent(a.text)}` : null;
    const head = link && link.length <= 1800
      ? `*Draft for* ${who}\n_Tap to open their chat with this text filled in, or copy the message below:_\n${link}`
      : `*Draft for* ${who}\n_Copy or forward the message below:_`;
    await this.api.send(a.selfJid, { text: head });
    await this.api.send(a.selfJid, { text: a.text });
  }

  async #notify(text) {
    const t = typeof text === 'string' ? text.trim().slice(0, 1000) : '';
    if (!t) return err('invalid_text', 'The note is empty.');
    if (this.paused) return err('paused', 'The owner has paused agent actions.');
    const self = this.#self();
    if (!self) return err('bot_offline', 'The WhatsApp bot is not connected right now.', { retryable: true });
    const hourAgo = this.now() - 3600_000;
    this.stamps = this.stamps.filter((x) => x > hourAgo);
    if (this.stamps.length >= this.cfg.maxPerHour) return err('rate_limited', 'Too many requests in the last hour.', { retryable: true });
    this.stamps.push(this.now());
    await this.api.send(self, { text: t });
    await this.#audit('notify', null, { chars: t.length });
    return { ok: true, message: 'Note delivered to the owner\'s chat.' };
  }

  #get(id) {
    const a = this.actions.get(String(id || '').toLowerCase());
    return a ? { ok: true, ...this.#view(a) } : err('not_found', `No action with id "${id}".`);
  }

  #list() {
    const all = [...this.actions.values()].sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, sending: all.filter((a) => a.status === 'sending').map((a) => this.#view(a)), pending: all.filter((a) => a.status === 'pending').map((a) => this.#view(a)), recent: all.filter((a) => a.status !== 'pending' && a.status !== 'sending').slice(0, 10).map((a) => this.#view(a)) };
  }

  async cancel(id, via = 'agent') {
    const a = this.actions.get(String(id || '').toLowerCase());
    if (!a) return err('not_found', `No action with id "${id}".`);
    if (a.type === 'bulk' && a.status === 'sending') return await this.stopBulk(a.id);
    if (a.status !== 'pending') return err('not_pending', `That action is already ${a.status}.`, { status: a.status });
    a.status = 'cancelled'; a.decidedAt = this.now(); a.via = via;
    await this.#save();
    await this.#audit('cancelled', a, { via });
    await this.#note(a, `_Cancelled (#${a.id}). Nothing was sent._`);
    return { ok: true, ...this.#view(a) };
  }

  // ---------- owner decisions ----------
  async decide(id, decision, via) {
    const a = this.actions.get(id);
    if (!a) return err('not_found', `No action with id "${id}".`);
    if (a.status !== 'pending') return err('not_pending', `That request is already ${a.status}.`, { status: a.status });
    if (a.expiresAt <= this.now()) { await this.#expire(a); return err('expired', 'That request expired.'); }
    a.decidedAt = this.now(); a.via = via;
    const name = a.to.name ?? a.to.display;
    if (decision === 'decline') {
      a.status = 'declined';
      await this.#save(); await this.#audit('declined', a, { via });
      await this.#note(a, '_Declined. Nothing was sent._');
    } else if (decision === 'draft') {
      a.status = 'drafting';
      try {
        await this.#deliverDraft(a);
        a.status = 'drafted';
      } catch (e) { a.status = 'failed'; a.error = e.message; await this.#note(a, `_Could not drop the draft:_ ${e.message}`); }
      await this.#save(); await this.#audit(a.status, a, { via, error: a.error });
    } else if (a.type === 'bulk') {
      if (this.bulkRun) return err('bulk_busy', 'Another broadcast is still sending.');
      this.#startBulk(a);
      await this.#audit('bulk_approved', a, { via, recipients: a.recips.length });
    } else {
      a.status = 'sending';
      await this.#save();
      try {
        const res = await this.api.send(a.to.jid, { text: a.text });
        a.status = 'sent'; a.sentId = res?.key?.id;
        await this.#note(a, `*Sent to ${name}.*`);
      } catch (e) {
        a.status = 'failed'; a.error = e.message;
        await this.#note(a, `_Not sent to ${name}:_ ${e.message}`);
      }
      await this.#save(); await this.#audit(a.status, a, { via, error: a.error });
    }
    this.log.info({ id: a.id, status: a.status, via }, 'agent: decision');
    return { ok: true, ...this.#view(a) };
  }

  async #expire(a) {
    a.status = 'expired'; a.decidedAt = this.now();
    await this.#save(); await this.#audit('expired', a);
    await this.#note(a, `_Expired (#${a.id}). Nothing was sent._`);
  }

  async sweep() {
    for (const a of this.#pending()) if (a.expiresAt <= this.now()) await this.#expire(a);
    for (const a of this.actions.values()) {
      if (a.type === 'bulk' && a.interrupted && !a.notified && this.#self()) {
        a.notified = true; await this.#save();
        await this.#note(a, finalNote(a, 'the bot restarted')).catch(() => {});
      }
    }
    this.#prune();
  }

  async setPaused(on, via = 'owner') {
    this.paused = on;
    let n = 0;
    if (on) for (const a of this.#pending()) { await this.cancel(a.id, via); n++; }
    if (on && this.bulkRun) { this.bulkRun.stop = true; this.bulkRun.reason = 'agent paused'; this.bulkRun.wake?.(); }
    await this.#save(); await this.#audit(on ? 'paused' : 'resumed', null, { via, cancelled: n });
    return n;
  }

  /** Reactions and plain replies from the owner on a confirmation message. */
  async onUpsert({ messages } = {}) {
    for (const m of messages || []) {
      if (!m?.message || !this.#isOwner(m)) continue;
      if (m.key?.id && this.api.store?.isSent?.(m.key.id)) continue;
      const content = normalizeMessageContent(m.message);
      const react = content?.reactionMessage;
      if (react) {
        const id = this.byMsg.get(react.key?.id);
        const d = classifyEmoji(react.text);
        if (id && d) await this.decide(id, d, 'reaction');
        continue;
      }
      const ci = content && Object.values(content).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;
      const id = ci?.stanzaId && this.byMsg.get(ci.stanzaId);
      const d = id && classifyWord(extractText(content));
      if (id && d) await this.decide(id, d, 'reply');
    }
  }

  async listContacts() {
    const { contacts, error } = await this.#contacts();
    if (error) return [];
    return contacts.map((c) => ({
      name: c.name || c.display,
      number: c.number,
      jid: c.jid,
      display: display(c),
      aliases: c.aliases,
      note: c.note,
      group: c.group,
    }));
  }

  async findContact(query) {
    return this.#contactsFind(query);
  }

  async addContact({ name, number, aliases = [], note = '' } = {}) {
    const defaultCc = this.cfg.defaultCountryCode || (digitsOf(this.api.conn?.sock?.user?.id).startsWith('234') ? '234' : '234');
    return saveContact(this.contactsFile, { name, number, aliases, note, defaultCc });
  }

  async removeContact(name) {
    return deleteContact(this.contactsFile, name);
  }

  isPaused() { return this.paused; }

  /** Run one owner command (from a voice note) through Gemini 3.8 Live with the tool surface. Returns { text, trace }. */
  async runCommand(text, { key, WS, timeoutMs } = {}) {
    const apiKey = key || process.env.GEMINI_API_KEY || '';
    const summary = (trace) => (trace || []).map((x) => `${x.tool}:${x.status || x.error || (x.ok ? 'ok' : 'err')}`);
    try {
      const r = await runAgentCommand(text, { key: apiKey, WS, timeoutMs, decls: TOOL_DECLS, system: SYSTEM_PROMPT, dispatch: makeDispatch(this), log: this.log });
      await this.#audit('voice_command', null, { text: String(text).slice(0, 500), calls: summary(r.trace) });
      return r;
    } catch (e) {
      await this.#audit('voice_command_failed', null, { text: String(text).slice(0, 500), calls: summary(e.trace), error: String(e.code || e.message).slice(0, 80) });
      throw e;
    }
  }

  summary() {
    const p = this.#pending();
    const run = this.bulkRun && this.actions.get(this.bulkRun.id);
    const live = run ? `*Sending #${run.id}:* ${counts(run).sent}/${run.recips.length} done. _Stop:_ *Lohra --agent stop*\\n` : '';
    return [live + `Agent channel: ${this.paused ? 'PAUSED' : 'active'}`, p.length ? p.map((a) => `#${a.id} to ${a.to.name ?? a.to.display}: "${a.text.slice(0, 40)}${a.text.length > 40 ? '…' : ''}"`).join('\n') : 'Nothing waiting for you.'].join('\n');
  }
  pendingIds() { return this.#pending().map((a) => a.id); }
}

let current = null;
let apiRef = null;

export default {
  name: 'agent',
  version: '1.0.0',
  description: 'Agent channel: wabctl proposes, you approve on WhatsApp',
  init: async (api) => { apiRef = api; current = new Agent(api); await current.start(); api.agent = current; },
  dispose: async () => { const a = current; current = null; if (apiRef?.agent === a) delete apiRef.agent; await a?.stop(); },
  on: { 'messages.upsert': (data) => current?.onUpsert(data) },
  commands: {
    agent: {
      description: 'Agent requests: status | yes|draft|no [id] | stop | pause | resume',
      ownerOnly: true,
      run: async (ctx) => {
        const ag = current;
        if (!ag) return void (await ctx.reply('Agent channel is not running.'));
        const sub = (ctx.args[0] || 'status').toLowerCase();
        if (sub === 'status' || sub === 'pending') return void (await ctx.reply(ag.summary()));
        if (sub === 'pause' || sub === 'resume') {
          const n = await ag.setPaused(sub === 'pause', 'owner-command');
          return void (await ctx.reply(sub === 'pause' ? `Agent paused. ${n} waiting request(s) cancelled.` : 'Agent resumed.'));
        }
        if (sub === 'stop') {
          const r = await ag.stopBulk(ctx.args[1]);
          return void (await ctx.reply(r.ok ? 'Stopped. ' + r.message : r.message));
        }
        const d = { yes: 'approve', approve: 'approve', send: 'approve', draft: 'draft', no: 'decline', decline: 'decline' }[sub];
        if (!d) return void (await ctx.reply('Use: agent status | yes [id] | draft [id] | no [id] | stop | pause | resume'));
        const ids = ag.pendingIds();
        const id = (ctx.args[1] || (ids.length === 1 ? ids[0] : '')).toLowerCase();
        if (!id) return void (await ctx.reply(ids.length ? `Which one? ${ids.map((i) => `#${i}`).join(' ')}` : 'Nothing is waiting.'));
        const r = await ag.decide(id, d, 'command');
        if (!r.ok) await ctx.reply(r.message);
      },
    },
    contact: {
      aliases: ['contacts', 'add'],
      description: 'Add or view contacts: Lohra add contact <number> as <name> [alias <alias>]',
      ownerOnly: true,
      run: async (ctx) => {
        const ag = current;
        if (!ag) return void (await ctx.reply('Agent channel is not running.'));
        const text = (ctx.argText || '').trim();
        const cmd = (ctx.command || '').toLowerCase();

        // 1. List contacts: "Lohra contacts", "Lohra contact", "Lohra contact list", or "Lohra contacts list"
        if (!text || text.toLowerCase() === 'list') {
          if (cmd === 'add') {
            return void (await ctx.reply('Usage:\n• Lohra add contact 090... as Thomas alias Mr. T\n• Lohra add contact +234... as Mum'));
          }
          const list = await ag.listContacts();
          if (!list.length) return void (await ctx.reply('Contact book is empty. Add someone with:\nLohra add contact 090... as Thomas alias Mr. T'));
          const lines = list.map((c) => `• *${c.name}*: ${c.display}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}${c.note ? ` [${c.note}]` : ''}`);
          return void (await ctx.reply(`*Contacts (${list.length})*\n${lines.join('\n')}`));
        }

        // 2. Remove contact: "Lohra contact remove <name>" or "Lohra contact delete <name>"
        const mRemove = text.match(/^(?:remove|delete|del|rm)\s+([^]+)$/i);
        if (mRemove) {
          const name = mRemove[1].trim();
          const r = await ag.removeContact(name);
          if (!r.ok) return void (await ctx.reply(r.message || `No contact named "${name}".`));
          return void (await ctx.reply(`Removed contact "${r.removed}".`));
        }

        // 3. Find contact: "Lohra contact find <name>" or "Lohra contact search <name>"
        const mFind = text.match(/^(?:find|search)\s+([^]+)$/i);
        if (mFind) {
          const q = mFind[1].trim();
          const r = await ag.findContact(q);
          if (!r.ok || !r.match) return void (await ctx.reply(r.message || `No contact matching "${q}".`));
          const m = r.match;
          return void (await ctx.reply(`Found: *${m.name}* (${m.hint || m.number || 'matched'})`));
        }

        // 4. Add or update contact:
        const parsed = parseContactInput(text);
        if (!parsed) {
          return void (await ctx.reply(
            'Usage:\n' +
            '• Lohra add contact 090... as Thomas alias Mr. T\n' +
            '• Lohra add contact 234... as Thomas alias Mr. T\n' +
            '• Lohra add contact +234... as Thomas\n' +
            '• Lohra contact list\n' +
            '• Lohra contact remove <name>'
          ));
        }

        const r = await ag.addContact(parsed);
        if (!r.ok) return void (await ctx.reply(`Could not save contact: ${r.error || r.message}`));
        const alText = r.aliases?.length ? ` (alias: ${r.aliases.map((a) => `"${a}"`).join(', ')})` : '';
        const noteText = r.note ? ` [Note: ${r.note}]` : '';
        await ctx.reply(`${r.updated ? 'Updated' : 'Saved'} contact *${r.name}*: ${r.display}${alText}${noteText}`);
      },
    },
  },
};
