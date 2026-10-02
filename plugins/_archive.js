// Chat archive: remembers the messages the bot SEES, so an agent can look back ("the last voice note Precious sent").
// WhatsApp gives a linked device no way to read old chats on demand, so only messages that arrived (or were sent) while the bot was
// connected are kept, for ARCHIVE_DAYS (default 30). Media is not copied: only what is needed to download it again from WhatsApp
// while it is still there (usually a few weeks). Files: data/archive/<chat>.jsonl (0700). Nothing here is ever sent to a contact.
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeMessageContent, downloadMediaMessage, BufferJSON } from 'baileys';
import { digitsOf } from '../src/bot.js';
import { atomicWrite } from '../src/util.js';

export const KINDS = ['any', 'text', 'voice', 'image', 'video', 'document', 'sticker'];
const MAX_TEXT = 2000;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const SKIP = new Set(['jpegThumbnail', 'streamingSidecar', 'thumbnailSha256', 'thumbnailEncSha256', 'midQualityFileSha256']);
const replacer = (k, v) => (SKIP.has(k) ? undefined : BufferJSON.replacer(k, v));
const safe = (s) => String(s).replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 80);
const ICON = { text: '💬', voice: '🎙️', audio: '🎧', image: '🖼️', video: '🎬', document: '📄', sticker: '🏷️' };

/** WhatsApp message content -> { kind, text, seconds, mime, fileName } or null for things we do not keep (reactions, protocol, calls...). */
export function classify(message) {
  const c = normalizeMessageContent(message);
  if (!c) return null;
  const num = (x) => Number(x) || 0;
  if (c.audioMessage) return { kind: c.audioMessage.ptt ? 'voice' : 'audio', text: '', seconds: num(c.audioMessage.seconds), mime: c.audioMessage.mimetype || '', media: true };
  if (c.imageMessage) return { kind: 'image', text: c.imageMessage.caption || '', mime: c.imageMessage.mimetype || '', media: true };
  if (c.videoMessage) return { kind: 'video', text: c.videoMessage.caption || '', seconds: num(c.videoMessage.seconds), mime: c.videoMessage.mimetype || '', media: true };
  if (c.documentMessage) return { kind: 'document', text: c.documentMessage.caption || '', fileName: c.documentMessage.fileName || '', mime: c.documentMessage.mimetype || '', media: true };
  if (c.stickerMessage) return { kind: 'sticker', text: '', mime: c.stickerMessage.mimetype || '', media: true };
  const text = c.conversation || c.extendedTextMessage?.text || '';
  return text ? { kind: 'text', text } : null;
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export class Archive {
  constructor({ dataDir, log, conn, retentionDays = 30, maxPerChat = 2000, now = Date.now }) {
    this.dir = path.join(dataDir, 'archive');
    Object.assign(this, { log, conn, now });
    this.retentionMs = Math.max(1, retentionDays) * 86400_000;
    this.maxPerChat = maxPerChat;
    this.enabled = true;
    this.chats = new Map();   // chatKey -> records (oldest first)
    this.keyOf = new Map();   // any id of a chat (phone digits, lid digits, group jid) -> chatKey
    this.byId = new Map();    // message id -> record
    this.firstSeen = null;
    this.timer = null;
    this.chain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { this.enabled = JSON.parse(await fs.readFile(path.join(this.dir, 'settings.json'), 'utf8')).enabled !== false; } catch { /* default on */ }
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const recs = [];
      for (const line of (await fs.readFile(path.join(this.dir, f), 'utf8').catch(() => '')).split('\n')) {
        if (!line) continue;
        try { recs.push(JSON.parse(line)); } catch { /* skip a torn line */ }
      }
      for (const r of recs) this.#index(f.slice(0, -6), r);
    }
    await this.prune();
    this.timer = setInterval(() => this.prune().catch(() => {}), 6 * 3600_000);
    this.timer.unref?.();
    this.log.info({ chats: this.chats.size, messages: this.byId.size, enabled: this.enabled }, 'archive ready');
  }

  stop() { clearInterval(this.timer); return this.chain.catch(() => {}); }

  #index(file, r) {
    const key = file;
    let list = this.chats.get(key);
    if (!list) this.chats.set(key, (list = []));
    list.push(r);
    this.byId.set(r.id, r);
    for (const id of r.group ? [r.chat] : r.nums) this.keyOf.set(id, key);
    if (!this.firstSeen || r.ts < this.firstSeen) this.firstSeen = r.ts;
  }

  async #setEnabled(on) { this.enabled = on; await atomicWrite(path.join(this.dir, 'settings.json'), JSON.stringify({ enabled: on })); }
  setEnabled(on) { return this.#setEnabled(!!on); }

  /** Remember one WhatsApp message (called for every upsert). Never throws. */
  async record(m) {
    try {
      if (!this.enabled) return null;
      const key = m?.key;
      const chat = key?.remoteJid;
      if (!chat || !key.id || chat === 'status@broadcast' || chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) return null;
      if (this.byId.has(key.id)) return null;
      const c = classify(m.message);
      if (!c) return null;
      const ts = (Number(m.messageTimestamp) || Math.floor(this.now() / 1000)) * 1000;
      if (this.now() - ts > this.retentionMs) return null;

      const group = chat.endsWith('@g.us');
      let nums = [];
      if (!group) {
        nums = [...new Set([key.remoteJidAlt, chat].filter((j) => j && j.endsWith('@s.whatsapp.net')).concat([key.remoteJidAlt, chat].filter((j) => j && j.endsWith('@lid'))).map(digitsOf).filter(Boolean))];
        if (chat.endsWith('@lid') && !key.remoteJidAlt) {
          try { const pn = await this.conn?.sock?.signalRepository?.lidMapping?.getPNForLID?.(chat); if (pn) nums.unshift(digitsOf(pn)); } catch { /* unknown */ }
          nums = [...new Set(nums)];
        }
        if (!nums.length) return null;
      }
      const ids = group ? [chat] : nums;
      const chatKey = ids.map((i) => this.keyOf.get(i)).find(Boolean) || safe(ids[0]);

      const rec = {
        id: key.id, chat, group, nums, fromMe: !!key.fromMe, sender: key.participant || chat,
        name: key.fromMe ? '' : String(m.pushName || '').slice(0, 60), ts, kind: c.kind,
        text: String(c.text || '').slice(0, MAX_TEXT), seconds: c.seconds || 0, mime: c.mime || '', fileName: c.fileName || '',
      };
      if (c.media) rec.raw = JSON.stringify({ key, message: m.message }, replacer);
      this.#index(chatKey, rec);
      const list = this.chats.get(chatKey);
      if (list.length > this.maxPerChat + 100) await this.prune();
      this.chain = this.chain.then(() => fs.appendFile(path.join(this.dir, `${chatKey}.jsonl`), JSON.stringify(rec) + '\n', { mode: 0o600 })).catch((e) => this.log.warn({ err: e.message }, 'archive write failed'));
      return rec;
    } catch (e) {
      this.log.debug?.({ err: e.message }, 'archive record failed');
      return null;
    }
  }

  /** Drop records past the retention window / per-chat cap, and rewrite the affected files. */
  async prune() {
    const cut = this.now() - this.retentionMs;
    for (const [key, list] of [...this.chats]) {
      let keep = list.filter((r) => r.ts >= cut);
      if (keep.length > this.maxPerChat) keep = keep.slice(-this.maxPerChat);
      if (keep.length === list.length) continue;
      for (const r of list) if (!keep.includes(r)) this.byId.delete(r.id);
      const file = path.join(this.dir, `${key}.jsonl`);
      if (keep.length) { this.chats.set(key, keep); await atomicWrite(file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n'); }
      else { this.chats.delete(key); await fs.rm(file, { force: true }); }
    }
    this.firstSeen = null;
    for (const r of this.byId.values()) if (!this.firstSeen || r.ts < this.firstSeen) this.firstSeen = r.ts;
  }

  async clear() {
    this.chats.clear(); this.keyOf.clear(); this.byId.clear(); this.firstSeen = null;
    await this.chain.catch(() => {});
    for (const f of await fs.readdir(this.dir).catch(() => [])) if (f.endsWith('.jsonl')) await fs.rm(path.join(this.dir, f), { force: true });
  }

  stats() { return { enabled: this.enabled, chats: this.chats.size, messages: this.byId.size, since: this.firstSeen, retention_days: Math.round(this.retentionMs / 86400_000) }; }

  get(id) { return this.byId.get(String(id)) || null; }

  async #idsFor(number) {
    const ids = new Set(number ? [String(number)] : []);
    try {
      const lid = await this.conn?.sock?.signalRepository?.lidMapping?.getLIDForPN?.(`${number}@s.whatsapp.net`);
      if (lid) ids.add(digitsOf(lid));
    } catch { /* no mapping known */ }
    return ids;
  }

  /** Newest first. Filter by person (number) or group (jid), kind, direction, text and age. Returns public views (no raw media info). */
  async find({ number, jid, kind = 'any', from = 'any', query = '', limit = 5, sinceHours = 0 } = {}) {
    limit = Math.min(10, Math.max(1, Number(limit) || 5));
    const group = jid && jid.endsWith('@g.us') ? jid : null;
    const ids = group ? null : await this.#idsFor(number);
    const q = String(query || '').trim().toLowerCase();
    const since = sinceHours > 0 ? this.now() - sinceHours * 3600_000 : 0;
    const out = [];
    for (const r of this.byId.values()) {
      if (group ? r.chat !== group : !r.nums.some((n) => ids.has(n))) continue;
      if (kind === 'voice' ? !(r.kind === 'voice' || r.kind === 'audio') : kind !== 'any' && r.kind !== kind) continue;
      if (from === 'them' && r.fromMe) continue;
      if (from === 'me' && !r.fromMe) continue;
      if (since && r.ts < since) continue;
      if (q && !`${r.text} ${r.fileName}`.toLowerCase().includes(q)) continue;
      out.push(r);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, limit).map((r) => this.view(r));
  }

  view(r) {
    return {
      id: r.id, when: timeAgo(r.ts, this.now()), at: new Date(r.ts).toISOString(), from: r.fromMe ? 'you' : 'them', kind: r.kind,
      seconds: r.seconds || undefined, file_name: r.fileName || undefined, text: r.text ? r.text.slice(0, 200) : undefined,
      sender: r.group ? (r.name || undefined) : undefined,
    };
  }

  /** Send one saved message into the OWNER's own chat (never to the contact). send(jid, content) is the bot's send queue. */
  async deliver(r, selfJid, { send, who = '', download = this.download || downloadMediaMessage } = {}) {
    const name = who || (r.fromMe ? 'You' : r.name || 'them');
    const label = `${ICON[r.kind] || '💬'} *${r.fromMe ? `You to ${who || 'them'}` : name}* · ${timeAgo(r.ts, this.now())}${r.kind === 'text' ? '' : r.text ? `\n"${r.text.slice(0, 500)}"` : ''}`;
    if (r.kind === 'text') { await send(selfJid, { text: `${label}\n\n${r.text}` }); return { ok: true, kind: 'text', delivered: true }; }
    if (!r.raw) return { ok: false, error: 'media_unavailable', message: 'That message has no media information saved.' };
    const sock = this.conn?.sock;
    if (!sock) return { ok: false, error: 'bot_offline', message: 'The WhatsApp bot is not connected right now.', retryable: true };
    let buf;
    try {
      const msg = JSON.parse(r.raw, BufferJSON.reviver);
      buf = await download(msg, 'buffer', {}, { logger: this.log, reuploadRequest: sock.updateMediaMessage });
    } catch (e) {
      return { ok: false, error: 'media_expired', message: `WhatsApp no longer has that ${r.kind === 'voice' ? 'voice note' : r.kind} (${String(e.message).slice(0, 80)}).` };
    }
    if (!buf?.length) return { ok: false, error: 'media_expired', message: 'WhatsApp returned no data for that media; it has probably expired.' };
    if (buf.length > MAX_MEDIA_BYTES) return { ok: false, error: 'too_large', message: 'That file is too large to forward.' };
    const cap = r.text ? `${label}` : label;
    if (r.kind === 'voice' || r.kind === 'audio') {
      await send(selfJid, { audio: buf, mimetype: r.mime || 'audio/ogg; codecs=opus', ptt: r.kind === 'voice', seconds: r.seconds || undefined });
      await send(selfJid, { text: label });
    } else if (r.kind === 'image') await send(selfJid, { image: buf, caption: cap });
    else if (r.kind === 'video') await send(selfJid, { video: buf, caption: cap });
    else if (r.kind === 'document') await send(selfJid, { document: buf, mimetype: r.mime || 'application/octet-stream', fileName: r.fileName || 'file', caption: cap });
    else { await send(selfJid, { sticker: buf }); await send(selfJid, { text: label }); }
    return { ok: true, kind: r.kind, delivered: true, bytes: buf.length };
  }
}
