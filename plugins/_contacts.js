// Contact book + recipient resolution for the agent channel. Pure functions, except loadContacts (reads one file).
// data/contacts.json accepts:  { "Thomas": "+234 801 234 5678", "Mum": { "number": "...", "aliases": ["mom"], "note": "" },
//                                "Family": { "jid": "12036302...@g.us" } }   or a list of { name, number, aliases }.
// Keys starting with "_" are ignored (use them for notes).
import fs from 'node:fs/promises';
import { atomicWrite } from '../src/util.js';

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export function normalizeNumber(input, { defaultCc = '' } = {}) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) {
    const cc = String(defaultCc).replace(/\D/g, '');
    if (!cc) return { ok: false, error: 'needs_country_code' };
    d = cc + d.slice(1);
  }
  if (d.length < 8 || d.length > 15) return { ok: false, error: 'invalid_number' };
  return { ok: true, number: d };
}

const JID_RE = /^[\d-]+@(s\.whatsapp\.net|g\.us)$/;
const NUMBERISH = /^\+?[\d\s().-]{7,}$/;
export const mask = (c) => (c?.group ? 'group' : c?.number ? `••••${c.number.slice(-4)}` : '');
export const display = (c) => (c.group ? 'group' : `+${c.number}`);

function build(name, number, jid, aliases, note) {
  const group = jid.endsWith('@g.us');
  return { name, aliases, number: group ? null : number, jid, group, note: note || '', names: [norm(name), ...aliases.map(norm)].filter(Boolean) };
}

export function parseContacts(raw, { defaultCc = '' } = {}) {
  const contacts = [];
  const warnings = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.contacts && typeof raw.contacts === 'object' ? raw.contacts : raw;
  const entries = Array.isArray(src) ? src.map((v) => [v?.name, v]) : src && typeof src === 'object' ? Object.entries(src) : [];
  for (const [rawName, v] of entries) {
    const name = String(rawName ?? '').trim();
    if (!name || name.startsWith('_')) continue;
    const o = typeof v === 'string' || typeof v === 'number' ? { number: v } : v && typeof v === 'object' ? v : null;
    if (!o) { warnings.push(`${name}: not a number or object`); continue; }
    const aliases = (Array.isArray(o.aliases) ? o.aliases : String(o.aliases ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (typeof o.jid === 'string' && JID_RE.test(o.jid.trim())) {
      const jid = o.jid.trim();
      contacts.push(build(name, jid.split('@')[0], jid, aliases, o.note));
      continue;
    }
    const n = normalizeNumber(o.number ?? o.phone, { defaultCc });
    if (!n.ok) { warnings.push(`${name}: ${n.error}`); continue; }
    contacts.push(build(name, n.number, `${n.number}@s.whatsapp.net`, aliases, o.note));
  }
  const seen = new Map();
  for (const c of contacts) for (const n of c.names) {
    if (seen.has(n) && seen.get(n) !== c.name) warnings.push(`"${n}" is used by both ${seen.get(n)} and ${c.name}`);
    seen.set(n, c.name);
  }
  return { contacts, warnings };
}

/** Names and aliases in a parsed contacts.json (for speech-recognition hints). Tolerant: never throws, ignores numbers. */
export function contactNames(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.contacts && typeof raw.contacts === 'object' ? raw.contacts : raw;
  const entries = Array.isArray(src) ? src.map((v) => [v?.name, v]) : src && typeof src === 'object' ? Object.entries(src) : [];
  const out = [];
  for (const [n, v] of entries) {
    const name = String(n ?? '').trim();
    if (!name || name.startsWith('_')) continue;
    out.push(name);
    const al = v && typeof v === 'object' ? (Array.isArray(v.aliases) ? v.aliases : String(v.aliases ?? '').split(',')) : [];
    for (const a of al) { const t = String(a).trim(); if (t) out.push(t); }
  }
  return out;
}

export async function loadContacts(file, opts) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { contacts: [], warnings: [], missing: true };
    return { contacts: [], warnings: [], error: e.message };
  }
  try { return parseContacts(JSON.parse(text || '{}'), opts); } catch (e) {
    return { contacts: [], warnings: [], error: `contacts.json is not valid JSON: ${e.message}` };
  }
}

/** Damerau-Levenshtein (adjacent swaps count as one edit). */
export function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

/** 100 exact, 90 every query word is a word of the name, 80 prefix, ~52-70 fuzzy (spelling / mishearing), 0 no match. */
export function scoreName(n, q) {
  if (!n || !q) return 0;
  if (n === q) return 100;
  const nt = n.split(' ');
  const qt = q.split(' ');
  if (qt.every((t) => nt.includes(t))) return 90;
  if (qt.every((t) => t.length >= 2 && nt.some((x) => x.startsWith(t)))) return 80;
  if (q.length < 3) return 0;
  let best = sim(n, q);
  if (qt.length === 1) for (const t of nt) best = Math.max(best, sim(t, q));
  return best >= 0.74 ? Math.round(best * 70) : 0;
}

/**
 * -> { status: 'ok', contact, matchedBy: 'exact'|'partial'|'fuzzy'|'number'|'jid' }
 *  | { status: 'ambiguous', candidates } | { status: 'none', suggestions } | { status: 'invalid'|'blocked', error }
 */
export function resolveRecipient(contacts, query, { allowRaw = true, defaultCc = '' } = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return { status: 'invalid', error: 'empty_recipient' };

  if (JID_RE.test(raw)) {
    if (!allowRaw) return { status: 'blocked', error: 'raw_numbers_disabled' };
    const known = contacts.find((c) => c.jid === raw);
    return { status: 'ok', matchedBy: 'jid', contact: known ?? build(null, raw.split('@')[0], raw, [], '') };
  }
  if (NUMBERISH.test(raw)) {
    const n = normalizeNumber(raw, { defaultCc });
    if (!n.ok) return { status: 'invalid', error: n.error };
    const known = contacts.find((c) => c.number === n.number);
    if (!known && !allowRaw) return { status: 'blocked', error: 'raw_numbers_disabled' };
    return { status: 'ok', matchedBy: 'number', contact: known ?? build(null, n.number, `${n.number}@s.whatsapp.net`, [], '') };
  }

  const q = norm(raw);
  if (!q) return { status: 'invalid', error: 'empty_recipient' };
  const scored = contacts.map((c) => ({ c, score: Math.max(0, ...c.names.map((n) => scoreName(n, q))) }));
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (!hits.length) {
    const near = contacts.map((c) => ({ c, s: Math.max(0, ...c.names.map((n) => sim(n, q))) })).sort((a, b) => b.s - a.s).slice(0, 3).filter((x) => x.s > 0.4);
    return { status: 'none', suggestions: near.map((x) => x.c) };
  }
  const top = hits[0].score;
  const tied = hits.filter((h) => h.score >= top - 5);
  const uniq = [...new Map(tied.map((h) => [h.c.jid, h.c])).values()];
  if (uniq.length > 1) return { status: 'ambiguous', candidates: uniq };
  return { status: 'ok', contact: hits[0].c, matchedBy: top === 100 ? 'exact' : top >= 75 ? 'partial' : 'fuzzy' };
}

// ---- reaction / reply classification ----
const clean = (e) => String(e ?? '').replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '').trim();
// Exactly three reactions are accepted on a request (skin tones ignored): 👍 send, 🙏 draft, 😢 decline.
const APPROVE = new Set(['👍']);
const DRAFT = new Set(['🙏']);
const DECLINE = new Set(['😢']);
export function classifyEmoji(e) {
  const c = clean(e);
  return APPROVE.has(c) ? 'approve' : DRAFT.has(c) ? 'draft' : DECLINE.has(c) ? 'decline' : null;
}
const WORDS = {
  approve: /^(yes|y|yep|yeah|send|ok|okay|approve|go|👍)$/i,
  draft: /^(draft|d|edit|drop|🙏)$/i,
  decline: /^(no|n|nope|cancel|decline|stop|😢)$/i,
};
export function classifyWord(text) {
  const t = String(text ?? '').trim().replace(/[.!]+$/, '');
  return Object.entries(WORDS).find(([, re]) => re.test(t))?.[0] ?? null;
}


export function parseContactInput(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^(?:contact|contacts)\s+/i, '');
  t = t.replace(/^add\s+(?:contact\s+|contacts\s+)?/i, '').trim();

  let aliases = [];
  const aliasMatch = t.match(/\s+(?:aliases|alias)[:\s]+([^]+?)(?=\s+note[:\s]+|$)/i);
  if (aliasMatch) {
    const rawAliases = aliasMatch[1].trim();
    aliases = rawAliases.split(/[,/]|(?:\s+and\s+)/i).map((s) => s.trim()).filter(Boolean);
    t = (t.slice(0, aliasMatch.index) + ' ' + t.slice(aliasMatch.index + aliasMatch[0].length)).trim();
  }

  let note = '';
  const noteMatch = t.match(/\s+note[:\s]+([^]+)$/i);
  if (noteMatch) {
    note = noteMatch[1].trim();
    t = t.slice(0, noteMatch.index).trim();
  }

  const mAs1 = t.match(/^(\+?[\d\s().-]{7,}|[\d-]+@[\w.-]+)\s+as\s+([^]+)$/i);
  if (mAs1) return { number: mAs1[1].trim(), name: mAs1[2].trim(), aliases, note };

  const mAs2 = t.match(/^([^]+?)\s+as\s+(\+?[\d\s().-]{7,}|[\d-]+@[\w.-]+)$/i);
  if (mAs2) return { name: mAs2[1].trim(), number: mAs2[2].trim(), aliases, note };

  const mNameNum = t.match(/^([^]+?)\s+(\+?[\d\s().-]{7,}|[\d-]+@[\w.-]+)$/i);
  if (mNameNum) return { name: mNameNum[1].trim(), number: mNameNum[2].trim(), aliases, note };

  const mNumName = t.match(/^(\+?[\d\s().-]{7,}|[\d-]+@[\w.-]+)\s+([^]+)$/i);
  if (mNumName) return { number: mNumName[1].trim(), name: mNumName[2].trim(), aliases, note };

  return null;
}

export async function saveContact(file, { name, number, aliases = [], note = '', defaultCc = '234' } = {}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) return { ok: false, error: 'empty_name', message: 'Contact name cannot be empty.' };

  let raw = {};
  try {
    const text = await fs.readFile(file, 'utf8');
    raw = JSON.parse(text || '{}');
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: 'read_error', message: e.message };
  }

  if (Array.isArray(raw)) {
    return { ok: false, error: 'unsupported', message: 'contacts.json is an array; please convert to an object first.' };
  }

  const rawNum = String(number ?? '').trim();
  let val;
  let disp;
  if (rawNum.includes('@g.us') || rawNum.includes('@s.whatsapp.net')) {
    val = { jid: rawNum };
    disp = rawNum;
  } else {
    const norm = normalizeNumber(rawNum, { defaultCc });
    if (!norm.ok) return { ok: false, error: norm.error, message: norm.error === 'needs_country_code' ? 'Number needs a country code (e.g. +234...).' : `Invalid phone number (${norm.error}).` };
    val = { number: `+${norm.number}` };
    disp = `+${norm.number}`;
  }

  const al = (Array.isArray(aliases) ? aliases : String(aliases).split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (al.length) val.aliases = al;
  if (note && String(note).trim()) val.note = String(note).trim();

  const existingKey = Object.keys(raw).find((k) => k.toLowerCase() === cleanName.toLowerCase());
  const updated = !!existingKey;
  if (existingKey && existingKey !== cleanName) {
    delete raw[existingKey];
  }

  raw[cleanName] = (al.length || val.note || val.jid) ? val : val.number;

  await atomicWrite(file, JSON.stringify(raw, null, 2) + '\n');
  return { ok: true, name: cleanName, number: val.number, jid: val.jid, display: disp, aliases: al, note: val.note || '', updated };
}

export async function deleteContact(file, name) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) return { ok: false, error: 'empty_name', message: 'Please specify a contact name to remove.' };

  let raw = {};
  try {
    const text = await fs.readFile(file, 'utf8');
    raw = JSON.parse(text || '{}');
  } catch (e) {
    return { ok: false, error: 'read_error', message: e.message };
  }

  const existingKey = Object.keys(raw).find((k) => k.toLowerCase() === cleanName.toLowerCase());
  if (!existingKey) {
    return { ok: false, error: 'not_found', message: `No contact named "${cleanName}".` };
  }

  delete raw[existingKey];
  await atomicWrite(file, JSON.stringify(raw, null, 2) + '\n');
  return { ok: true, removed: existingKey };
}
