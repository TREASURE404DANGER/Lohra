import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadMediaMessage, normalizeMessageContent, extensionForMediaMessage } from 'baileys';
import { digitsOf } from '../src/bot.js';
import { resolveRecipient } from './_contacts.js';
import { atomicWrite } from '../src/util.js';

const STATUS_MAX_AGE_MS = 24 * 3600 * 1000; // 24 hours
const MAX_STATUSES_PER_CONTACT = 15;

export function extractStatusInfo(m) {
  if (m?.key?.remoteJid !== 'status@broadcast') return null;
  const participant = m.key?.participant || m.participant || '';
  if (!participant) return null;

  const content = normalizeMessageContent(m.message);
  if (!content) return null;

  let type = 'unknown';
  let caption = '';
  let text = '';
  let duration = 0;

  if (content.imageMessage) {
    type = 'image';
    caption = content.imageMessage.caption || '';
  } else if (content.videoMessage) {
    type = 'video';
    caption = content.videoMessage.caption || '';
    duration = content.videoMessage.seconds || 0;
  } else if (content.audioMessage) {
    type = 'audio';
    duration = content.audioMessage.seconds || 0;
  } else if (content.extendedTextMessage) {
    type = 'text';
    text = content.extendedTextMessage.text || '';
  } else if (content.conversation) {
    type = 'text';
    text = content.conversation || '';
  }

  const id = m.key?.id || '';
  const timestamp = Number(m.messageTimestamp) ? Number(m.messageTimestamp) * 1000 : Date.now();
  const senderNumber = digitsOf(participant);
  const senderJid = participant.replace(/:\d+@/, '@');
  const pushName = m.pushName || '';

  return {
    id,
    senderJid,
    senderNumber,
    pushName,
    type,
    text: text || caption,
    caption,
    duration,
    timestamp,
    message: m,
  };
}

export class StatusStore {
  constructor({ dataDir, log, conn, send }) {
    this.dir = path.join(dataDir, 'statuses');
    this.mediaDir = path.join(this.dir, 'media');
    this.indexFile = path.join(this.dir, 'index.json');
    this.log = log;
    this.conn = conn;
    this.send = send;
    // Map: senderNumber (or senderJid) -> array of status records (newest first)
    this.bySender = new Map();
  }

  async init() {
    await fs.mkdir(this.mediaDir, { recursive: true });
    await this.#loadIndex();
  }

  async #loadIndex() {
    try {
      const data = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
      const now = Date.now();
      for (const [key, items] of Object.entries(data || {})) {
        const fresh = (items || []).filter((item) => now - item.timestamp < STATUS_MAX_AGE_MS);
        if (fresh.length) this.bySender.set(key, fresh);
      }
    } catch {
      // index missing or corrupt: start fresh
    }
  }

  async #saveIndex() {
    const obj = {};
    for (const [k, v] of this.bySender.entries()) {
      obj[k] = v.map(({ message, ...meta }) => meta);
    }
    await atomicWrite(this.indexFile, JSON.stringify(obj, null, 2) + '\n');
  }

  async record(m) {
    const info = extractStatusInfo(m);
    if (!info) return null;

    const senderKey = info.senderNumber || info.senderJid;
    const existing = this.bySender.get(senderKey) || [];

    // Avoid recording duplicate
    if (existing.some((x) => x.id === info.id)) return info;

    // Pre-download media in background so it's always ready
    if (['image', 'video', 'audio'].includes(info.type)) {
      this.#cacheMedia(info).catch((err) => {
        this.log?.warn?.({ err: err.message, id: info.id }, 'status media download deferred');
      });
    }

    const updated = [info, ...existing].slice(0, MAX_STATUSES_PER_CONTACT);
    this.bySender.set(senderKey, updated);
    await this.#saveIndex();
    this.log?.info?.({ sender: senderKey, pushName: info.pushName, type: info.type, id: info.id }, 'status captured');
    return info;
  }

  async #cacheMedia(info) {
    try {
      const sock = this.conn?.sock;
      if (!sock) return null;
      const buf = await downloadMediaMessage(info.message, 'buffer', {}, { logger: this.log, reuploadRequest: sock.updateMediaMessage });
      if (!buf) return null;
      const ext = extensionForMediaMessage(info.message?.message) || (info.type === 'video' ? 'mp4' : info.type === 'audio' ? 'ogg' : 'jpeg');
      const filename = `${info.id}.${ext}`;
      const filepath = path.join(this.mediaDir, filename);
      await fs.writeFile(filepath, buf);
      info.mediaPath = filepath;
      await this.#saveIndex();
      return filepath;
    } catch (e) {
      this.log?.debug?.({ err: e.message, id: info.id }, 'cacheMedia failed');
      return null;
    }
  }

  async getMediaBuffer(info) {
    if (info.mediaPath) {
      try {
        return await fs.readFile(info.mediaPath);
      } catch {
        // file missing: re-download
      }
    }
    const sock = this.conn?.sock;
    if (!sock || !info.message) return null;
    return await downloadMediaMessage(info.message, 'buffer', {}, { logger: this.log, reuploadRequest: sock.updateMediaMessage });
  }

  findStatuses(query, contacts = []) {
    const q = String(query ?? '').trim().toLowerCase();
    const qDigits = digitsOf(q);

    // 1. Check contacts.json resolution first
    if (contacts.length) {
      const resolved = resolveRecipient(contacts, q);
      if (resolved?.status === 'ok') {
        const num = resolved.contact.number;
        const jid = resolved.contact.jid;
        for (const [k, v] of this.bySender.entries()) {
          if ((num && k.includes(num)) || (jid && k.includes(jid))) {
            return { contact: resolved.contact, statuses: v };
          }
        }
      }
    }

    // 2. Direct match on senderNumber or senderJid
    for (const [k, v] of this.bySender.entries()) {
      if (qDigits && k.includes(qDigits)) {
        const contactName = v[0]?.pushName || k;
        return { contact: { name: contactName, number: k }, statuses: v };
      }
    }

    // 3. Match on pushName
    for (const [k, v] of this.bySender.entries()) {
      const push = (v[0]?.pushName || '').toLowerCase();
      if (push && (push.includes(q) || q.includes(push))) {
        return { contact: { name: v[0]?.pushName || k, number: k }, statuses: v };
      }
    }

    return null;
  }

  async deliverLatest(query, contacts = [], selfJid) {
    if (!selfJid) return { ok: false, error: 'no_self_jid', message: 'Bot connection is not open.' };
    const match = this.findStatuses(query, contacts);
    if (!match || !match.statuses.length) {
      return {
        ok: false,
        error: 'no_status',
        message: `No recent status updates found for "${query}". Note: WhatsApp statuses are captured live as contacts post them while Lohra is connected.`,
      };
    }

    const contactName = match.contact.name || query;
    const latest = match.statuses[0];
    const timeAgo = formatTimeAgo(latest.timestamp);
    const dateStr = new Date(latest.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let sent = false;
    let detail = '';

    if (latest.type === 'image' || latest.type === 'video') {
      const buf = await this.getMediaBuffer(latest);
      if (buf) {
        const cap = `📱 *Status from ${contactName}*\nPosted: ${dateStr} (${timeAgo})${latest.caption ? `\n\n"${latest.caption}"` : ''}`;
        await this.send(selfJid, latest.type === 'video' ? { video: buf, caption: cap } : { image: buf, caption: cap });
        sent = true;
        detail = `${latest.type} sent with caption`;
      }
    } else if (latest.type === 'audio') {
      const buf = await this.getMediaBuffer(latest);
      if (buf) {
        await this.send(selfJid, { audio: buf, mimetype: 'audio/mp4', ptt: true });
        await this.send(selfJid, { text: `📱 *Voice Status from ${contactName}* (Posted: ${dateStr}, ${timeAgo})` });
        sent = true;
        detail = 'voice status sent';
      }
    } else if (latest.type === 'text') {
      const text = `📱 *Status from ${contactName}* (Posted: ${dateStr}, ${timeAgo}):\n\n"${latest.text}"`;
      await this.send(selfJid, { text });
      sent = true;
      detail = 'text status sent';
    }

    if (!sent) {
      // Fallback if media download failed
      await this.send(selfJid, {
        text: `📱 *Status from ${contactName}* (Posted: ${dateStr}, ${timeAgo})\nType: ${latest.type}\nText: ${latest.text || '(media expired)'}`,
      });
      detail = 'metadata summary sent';
    }

    return {
      ok: true,
      contact: contactName,
      type: latest.type,
      caption: latest.caption || latest.text || '',
      posted: timeAgo,
      detail,
    };
  }

  listRecent(contacts = []) {
    const out = [];
    const now = Date.now();
    for (const [key, items] of this.bySender.entries()) {
      if (!items.length) continue;
      const latest = items[0];
      if (now - latest.timestamp > STATUS_MAX_AGE_MS) continue;

      // Find contact display name if known
      let name = latest.pushName || key;
      const matched = contacts.find((c) => c.number && key.includes(c.number));
      if (matched) name = matched.name;

      out.push({
        name,
        key,
        count: items.length,
        latestType: latest.type,
        timestamp: latest.timestamp,
        timeAgo: formatTimeAgo(latest.timestamp),
      });
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }
}

function formatTimeAgo(ts) {
  const diffSec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr}h ago`;
}
