// Helpers for sending ONE message to several people (broadcast). Pure functions: the Agent (agent.js) does the sending.
// Safety model: the owner approves the exact list and text first; messages then go out one at a time with a pause between them.
import { resolveRecipient, display } from './_contacts.js';

export const BULK = {
  delaySec: 2,        // default pause between two messages
  jitter: 0.25,       // up to +25% random extra, so the rhythm is not perfectly mechanical (never shorter than the pause)
  minDelaySec: 1,
  maxDelaySec: 60,
  maxRecipients: 50,  // per broadcast
  maxPerDay: 150,     // recipients per rolling 24 h
  failStreak: 3,      // stop after this many failures in a row (likely a connection problem or a block)
  listShown: 25,      // names shown in the approval request
};

export const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] || '';
export const hasPlaceholder = (t) => /\{name\}/i.test(String(t ?? ''));
/** "Hi {name}" -> "Hi Thomas" (first name; "there" when the person has no saved name). */
export const personalize = (text, who) => String(text ?? '').replace(/\{name\}/gi, () => firstName(who?.name) || 'there');

export function pickDelaySec(v, { def = BULK.delaySec, min = BULK.minDelaySec, max = BULK.maxDelaySec } = {}) {
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** Milliseconds to wait before the next message. Always at least the chosen pause. */
export const gapMs = (delaySec, jitter = BULK.jitter, rand = Math.random) => Math.round(delaySec * 1000 * (1 + rand() * jitter));

export function humanDuration(sec) {
  const s = Math.max(1, Math.round(sec));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round((m / 60) * 10) / 10} h`;
}

/** Rough total time: pauses plus a little sending time per message. */
export const estimateSec = (n, delaySec, jitter = BULK.jitter) => Math.max(0, n - 1) * (delaySec * (1 + jitter / 2) + 0.5);

export function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

/**
 * Who gets the message.
 *  req.to      : names / numbers (each must resolve to exactly one contact, else the caller asks the owner)
 *  req.all     : true = everyone in the contact book (people only, never groups)
 *  req.except  : names to leave out
 * -> { ok: true, recips: [contact], skipped: [{ name, reason }] } | { ok: false, bad: { query, result } }
 */
export function planRecipients(contacts, req, { selfDigits = '', allowRaw = true, defaultCc = '' } = {}) {
  const opts = { allowRaw, defaultCc };
  const picked = new Map();
  const skipped = [];
  const add = (c) => {
    if (picked.has(c.jid)) return;
    if (!c.group && selfDigits && c.number === selfDigits) { skipped.push({ name: c.name || display(c), reason: 'that is you' }); picked.set(c.jid, null); return; }
    picked.set(c.jid, c);
  };
  for (const q of toList(req.to)) {
    const r = resolveRecipient(contacts, q, opts);
    if (r.status !== 'ok') return { ok: false, bad: { query: q, result: r } };
    add(r.contact);
  }
  if (req.all === true || req.all === 'true') for (const c of contacts) if (!c.group && c.number) add(c);

  const out = new Set();
  for (const q of toList(req.except)) {
    const r = resolveRecipient(contacts, q, { allowRaw: false, defaultCc });
    if (r.status !== 'ok') return { ok: false, bad: { query: q, result: r, except: true } };
    out.add(r.contact.jid);
  }
  const recips = [...picked.values()].filter((c) => c && !out.has(c.jid));
  return { ok: true, recips, skipped, excluded: out.size };
}

/** The approval request shown in the owner's own chat. */
export function bulkPrompt(a, ttlSec) {
  const n = a.recips.length;
  const names = a.recips.map((r) => r.name || `+${r.number}`);
  const shown = names.slice(0, BULK.listShown).join(', ') + (names.length > BULK.listShown ? ` and ${names.length - BULK.listShown} more` : '');
  const lines = [`*Send to ${n} ${n === 1 ? 'person' : 'people'}?*`, shown];
  if (a.skipped?.length) lines.push('', `Skipping: ${a.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`);
  if (a.verified === false) lines.push('', 'Could not check these numbers on WhatsApp.');
  lines.push('', ...personalize(a.text, a.recips[0]).split('\n').map((l) => `> ${l}`));
  if (hasPlaceholder(a.text)) lines.push(`(Example for ${firstName(a.recips[0]?.name) || 'the first person'}; each person gets their own first name.)`);
  lines.push('', `${a.delaySec}s between messages · about ${humanDuration(estimateSec(n, a.delaySec))}`);
  lines.push('', '👍 send to all   🙏 draft only   😢 decline', `#${a.id} · expires in ${humanDuration(ttlSec)}`);
  return lines.join('\n');
}

export const counts = (a) => {
  const c = { sent: 0, failed: 0, queued: 0, skipped: 0 };
  for (const r of a.recips || []) c[r.status] = (c[r.status] || 0) + 1;
  return c;
};

const nameOf = (r) => r.name || `+${r.number}`;
const list = (rs, max = 15) => rs.slice(0, max).map(nameOf).join(', ') + (rs.length > max ? ` and ${rs.length - max} more` : '');

/** The closing message for the owner. */
export function finalNote(a, why = '') {
  const c = counts(a);
  const total = a.recips.length;
  const failed = a.recips.filter((r) => r.status === 'failed');
  const left = a.recips.filter((r) => r.status === 'skipped');
  if (why) {
    return [`Stopped (${why}): ${c.sent} of ${total} sent, ${left.length + failed.length} NOT sent.`,
      failed.length ? `Failed: ${list(failed)}` : '', left.length ? `Not sent: ${list(left)}` : ''].filter(Boolean).join('\n');
  }
  if (!failed.length) return `Done: sent to ${c.sent} of ${total}.`;
  return [`Done: ${c.sent} of ${total} sent, ${failed.length} failed.`, `Failed: ${failed.slice(0, 10).map((r) => `${nameOf(r)} (${r.error || 'error'})`).join(', ')}${failed.length > 10 ? ` and ${failed.length - 10} more` : ''}`].join('\n');
}
