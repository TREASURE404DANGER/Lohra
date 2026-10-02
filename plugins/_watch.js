// Watch engine for plugins/watch.js (not a plugin: the leading underscore keeps the loader away).
// A task = a target contact + what to wait for (their next status / message) + an optional AI check (rubric) + what to do on a match
// (notify the owner in their own chat, with the media). Tasks live in data/watch/tasks.json and survive restarts.
// A 30s sweep loop handles expiry, retries of failed AI checks, and re-sending notifications that failed to go out.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { downloadMediaMessage, normalizeMessageContent } from 'baileys';
import { atomicWrite } from '../src/util.js';
import { judgeItem, cleanText } from './_judge.js';

const num = (jid) => String(jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
const bare = (jid) => String(jid ?? '').replace(/:\d+@/, '@');
export const MAX_ACTIVE = 25;
const RECENT = 10;
const SEEN_MAX = 300;
const JUDGE_MAX_BYTES = 14 * 1024 * 1024;
const KEEP_ENDED_MS = 30 * 24 * 3600e3;

export const fmtDur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** Normalise a Baileys message into a watch item, or null if it can't be one (own message, reaction, protocol, ...). */
export function extractItem(m) {
  const key = m?.key;
  const chat = key?.remoteJid;
  if (!key?.id || !chat || key.fromMe || !m.message) return null;
  const c = normalizeMessageContent(m.message);
  if (!c) return null;
  let type, text = '', mime = '', size = 0;
  if (c.imageMessage) { type = 'image'; text = c.imageMessage.caption || ''; mime = c.imageMessage.mimetype || 'image/jpeg'; size = Number(c.imageMessage.fileLength) || 0; }
  else if (c.videoMessage) { type = 'video'; text = c.videoMessage.caption || ''; mime = c.videoMessage.mimetype || 'video/mp4'; size = Number(c.videoMessage.fileLength) || 0; }
  else if (c.audioMessage) { type = 'audio'; mime = c.audioMessage.mimetype || 'audio/ogg'; size = Number(c.audioMessage.fileLength) || 0; }
  else if (c.stickerMessage) { type = 'sticker'; mime = c.stickerMessage.mimetype || 'image/webp'; size = Number(c.stickerMessage.fileLength) || 0; }
  else if (c.documentMessage) { type = 'document'; text = c.documentMessage.caption || c.documentMessage.fileName || ''; }
  else if (c.extendedTextMessage?.text) { type = 'text'; text = c.extendedTextMessage.text; }
  else if (c.conversation) { type = 'text'; text = c.conversation; }
  else return null;
  return {
    id: key.id,
    kind: chat === 'status@broadcast' ? 'status' : 'message',
    group: chat.endsWith('@g.us'),
    type, text, mime, size,
    ts: Number(m.messageTimestamp) ? Number(m.messageTimestamp) * 1000 : Date.now(),
    pushName: m.pushName || '',
    ids: [key.participant, key.participantAlt, chat, key.remoteJidAlt].filter(Boolean),
    chat,
    message: m,
  };
}

export function notifyText(task, item, verdict, { media = false, tooBig = false } = {}) {
  const who = task.target.name;
  const head = item.kind === 'status'
    ? `*${who}* posted a status${item.type !== 'text' ? ` (${item.type})` : ''}`
    : `*${who}* sent a message${item.group ? ' in a group' : ''}${item.type !== 'text' ? ` (${item.type})` : ''}`;
  const lines = [`${head}${task.condition ? ` matching “${task.condition}”` : ''}.`];
  const body = cleanText(item.text, 400).trim();
  if (body) lines.push(`“${body}${item.text.length > 400 ? '…' : ''}”`);
  if (task.rubric && verdict.reason) lines.push(`Reason: ${verdict.reason}`);
  if (item.type !== 'text' && item.type !== 'document' && !media) lines.push(tooBig ? '(media too large to forward)' : '(media could not be fetched)');
  lines.push(`Watch #${task.id} · ${task.once ? 'done' : 'still watching'}`);
  return lines.join('\n');
}

export class Watcher {
  constructor({
    dataDir, log, getSock, send, apiKey = () => process.env.GEMINI_API_KEY || '', judge = judgeItem, download, now = Date.now,
    maxEvals = Number(process.env.WATCH_MAX_EVALS || 150), minConf = Number(process.env.WATCH_MIN_CONF || 0.6), tickMs = 30_000, concurrency = 2,
  }) {
    Object.assign(this, { log, getSock, send, apiKey, judge, now, maxEvals, minConf, tickMs, concurrency });
    this.download = download || ((item) => downloadMediaMessage(item.message, 'buffer', {}, { logger: log, reuploadRequest: this.getSock()?.updateMediaMessage }));
    this.dir = path.join(dataDir, 'watch');
    this.file = path.join(this.dir, 'tasks.json');
    this.tasks = []; this.outbox = [];
    this.queue = []; this.retry = []; this.running = 0; this.inflight = new Set();
    this.saveChain = Promise.resolve(); this.timer = null; this.waiters = [];
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.tasks = (data.tasks || []).filter((t) => t?.id && t.target?.number);
      this.outbox = data.outbox || [];
    } catch { /* first run or unreadable: start empty */ }
    this.timer = setInterval(() => this.tick().catch((e) => this.log.warn({ err: e.message }, 'watch tick failed')), this.tickMs);
    this.timer.unref?.();
    this.log.info({ active: this.tasks.filter((t) => t.state === 'active').length }, 'watch engine ready');
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  save() {
    this.saveChain = this.saveChain
      .then(() => atomicWrite(this.file, JSON.stringify({ version: 1, tasks: this.tasks, outbox: this.outbox }, null, 2) + '\n'))
      .catch((e) => this.log.warn({ err: e.message }, 'watch save failed'));
    return this.saveChain;
  }

  idle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  list() { return this.tasks; }
  active() { return this.tasks.filter((t) => t.state === 'active'); }
  get(id) { const k = String(id || '').replace(/^#/, '').toLowerCase(); return this.tasks.find((t) => t.id === k); }

  async add(spec) {
    if (this.active().length >= MAX_ACTIVE) throw new Error(`Too many active watches (${MAX_ACTIVE}). Cancel one first.`);
    const dup = this.active().find((t) => t.target.number === spec.target.number && t.kind === spec.kind && t.condition === (spec.condition || '') && !!t.anywhere === !!spec.anywhere);
    if (dup) { const e = new Error(`Already watching that (#${dup.id}).`); e.existing = dup; throw e; }
    let id; do { id = randomBytes(2).toString('hex'); } while (this.get(id));
    const t = this.now();
    const task = {
      id, state: 'active', createdAt: t, expiresAt: t + Math.min(720, Math.max(1, spec.ttlHours || 168)) * 3600e3,
      kind: spec.kind, anywhere: !!spec.anywhere, once: spec.once !== false,
      condition: spec.condition || '', rubric: spec.condition ? spec.rubric || '' : '', instruction: String(spec.instruction || '').slice(0, 300),
      target: { name: spec.target.name, number: spec.target.number, jid: spec.target.jid || '', lids: [] },
      stats: { seen: 0, evaluated: 0, matches: 0, errors: 0 }, seenIds: [], recent: [], consecutiveErrors: 0,
    };
    this.tasks.push(task);
    await this.save();
    return task;
  }

  async cancel(which) {
    const hit = String(which).toLowerCase() === 'all' ? this.active() : [this.get(which)].filter((t) => t?.state === 'active');
    for (const t of hit) { t.state = 'cancelled'; t.endedAt = this.now(); }
    if (hit.length) await this.save();
    return hit;
  }

  // ------------------------------------------------------------ incoming events
  async #isTarget(task, item) {
    const t = task.target;
    if (item.ids.map(num).includes(t.number)) return true;
    const lids = item.ids.filter((i) => i.endsWith('@lid')).map(bare);
    if (lids.some((l) => t.lids.includes(l))) return true;
    for (const lid of lids) {
      try {
        const pn = await this.getSock()?.signalRepository?.lidMapping?.getPNForLID?.(lid);
        if (pn && num(pn) === t.number) { t.lids.push(lid); return true; }
      } catch { /* mapping unavailable: not a match */ }
    }
    return false;
  }

  async onUpsert(data) {
    if (data?.type && data.type !== 'notify') return;
    if (!this.active().length) return;
    for (const m of data?.messages || []) {
      const item = extractItem(m);
      if (!item) continue;
      for (const task of this.active()) {
        if (item.kind !== task.kind || (item.group && !task.anywhere)) continue;
        if (item.ts < task.createdAt - 5000 || task.seenIds.includes(item.id)) continue;
        const k = `${task.id}:${item.id}`;
        if (this.inflight.has(k)) continue;
        this.inflight.add(k);
        let ok = false;
        try { ok = await this.#isTarget(task, item); } finally { this.inflight.delete(k); }
        if (!ok || task.seenIds.includes(item.id)) continue;
        task.seenIds.push(item.id);
        if (task.seenIds.length > SEEN_MAX) task.seenIds.shift();
        task.stats.seen++;
        this.queue.push({ task, item, attempt: 0 });
      }
    }
    this.#pump();
  }

  // ------------------------------------------------------------ evaluation
  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      this.#run(job).finally(() => {
        this.running--;
        this.#pump();
        if (!this.running && !this.queue.length) this.waiters.splice(0).forEach((r) => r());
      });
    }
  }

  async #run(job) {
    const { task, item } = job;
    if (task.state !== 'active') return;
    try {
      await this.#evaluate(task, item);
      task.consecutiveErrors = 0;
    } catch (err) {
      task.stats.errors++; task.consecutiveErrors++;
      this.log.warn({ watch: task.id, err: err.message, attempt: job.attempt }, 'watch check failed');
      if (err.retryable && job.attempt < 3) { job.attempt++; job.at = this.now() + 30_000 * job.attempt; this.retry.push(job); }
      else this.#record(task, item, { match: false, confidence: 0, reason: `not checked: ${err.message}`.slice(0, 160) });
      if (task.consecutiveErrors >= 5 && !task.errorNotified) {
        task.errorNotified = true;
        await this.#note(`Watch #${task.id} on *${task.target.name}* keeps failing its AI check (${err.message}). It is still active.`);
      }
    }
    await this.save();
  }

  #record(task, item, v) {
    task.recent.unshift({ at: this.now(), id: item.id, type: item.type, match: !!v.match, confidence: v.confidence, reason: v.reason });
    task.recent.length = Math.min(task.recent.length, RECENT);
  }

  async #media(item, { required }) {
    if (!['image', 'video', 'audio', 'sticker'].includes(item.type)) return null;
    if (item.size > JUDGE_MAX_BYTES) return null;
    try {
      const buffer = await this.download(item);
      if (buffer?.length && buffer.length <= JUDGE_MAX_BYTES) return { buffer, mime: item.mime };
    } catch (e) { this.log.warn({ err: e.message, id: item.id }, 'watch media download failed'); }
    if (required) { const e = new Error('media download failed'); e.retryable = true; throw e; }
    return null;
  }

  async #evaluate(task, item) {
    if (this.now() >= task.expiresAt) return;
    const media = await this.#media(item, { required: !!task.rubric });
    let verdict;
    if (!task.rubric) verdict = { match: true, confidence: 1, reason: '' };
    else {
      if (task.stats.evaluated >= this.maxEvals) {
        task.state = 'done'; task.endedAt = this.now(); task.endReason = 'limit';
        return void (await this.#note(`⏹ Watch #${task.id} on *${task.target.name}* stopped: it reached its limit of ${this.maxEvals} AI checks.`));
      }
      verdict = await this.judge({ rubric: task.rubric, item, media, key: this.apiKey() });
      task.stats.evaluated++;
    }
    this.#record(task, item, verdict);
    if (!verdict.match || verdict.confidence < this.minConf) return;
    task.stats.matches++;
    if (task.once) { task.state = 'done'; task.endedAt = this.now(); task.endReason = 'matched'; }
    await this.#deliver(item, notifyText(task, item, verdict, { media: !!media, tooBig: item.size > JUDGE_MAX_BYTES }), media);
  }

  // ------------------------------------------------------------ delivery to the owner's own chat
  selfJid() { const id = this.getSock()?.user?.id; return id ? `${num(id)}@s.whatsapp.net` : null; }

  async #deliver(item, caption, media) {
    try {
      const jid = this.selfJid();
      if (!jid) throw new Error('not connected');
      if (media && item.type === 'image') await this.send(jid, { image: media.buffer, caption });
      else if (media && item.type === 'video') await this.send(jid, { video: media.buffer, caption });
      else if (media && item.type === 'audio') { await this.send(jid, { text: caption }); await this.send(jid, { audio: media.buffer, mimetype: media.mime }); }
      else if (media && item.type === 'sticker') { await this.send(jid, { text: caption }); await this.send(jid, { sticker: media.buffer }); }
      else await this.send(jid, { text: caption });
    } catch (err) {
      this.log.warn({ err: err.message }, 'watch notification queued for retry');
      this.outbox.push({ text: caption, at: this.now(), tries: 0 });
    }
  }

  #note(text) { return this.#deliver({ type: 'text' }, text, null); }

  // ------------------------------------------------------------ periodic sweep (the "cron" loop)
  async tick() {
    const now = this.now();
    let changed = false;
    for (const t of this.active()) {
      if (now < t.expiresAt) continue;
      t.state = 'expired'; t.endedAt = now; t.endReason = 'expired'; changed = true;
      const what = t.kind === 'status' ? 'statuses' : 'messages';
      await this.#note(`⏱ Watch #${t.id} on *${t.target.name}* ended after ${fmtDur(now - t.createdAt)}: ${t.stats.matches ? `${t.stats.matches} match${t.stats.matches > 1 ? 'es' : ''}` : 'no match'} (${t.stats.seen} ${what} seen).`);
    }
    const due = this.retry.filter((j) => j.at <= now);
    if (due.length) { this.retry = this.retry.filter((j) => j.at > now); this.queue.push(...due); this.#pump(); }
    if (this.outbox.length && this.selfJid()) {
      const pending = this.outbox.splice(0);
      for (const o of pending) {
        try { await this.send(this.selfJid(), { text: o.text }); }
        catch { if (++o.tries < 10) this.outbox.push(o); }
      }
      changed = true;
    }
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.state === 'active' || now - (t.endedAt || now) < KEEP_ENDED_MS);
    if (changed || before !== this.tasks.length) await this.save();
  }
}
