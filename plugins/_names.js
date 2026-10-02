// Fuzzy + phonetic name matching for mishearings (speech-to-text) and typos. Deterministic, offline, no AI.
//   "pressure" ~ "Precious", "Tomas" ~ "Thomas", "Jon" ~ "John", "Kemy" ~ "Kemi"
// Used only to SUGGEST ("did you mean ...?"): a sound-alike is never trusted enough to act on without a yes from the owner.

export const fold = (s) =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Damerau-Levenshtein distance (adjacent swaps count as one edit). */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const ratio = (a, b) => (a || b ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 1);

/** Jaro-Winkler similarity, 0..1 (rewards a shared start, which is what names usually share). */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/**
 * Coarse "how it sounds" key for ONE word: sibilants (s z sh ch j ci/ti before a vowel) collapse together, k/c/g/q together,
 * p/b, t/d, f/v, m/n together; vowels and h/w/y are dropped (they are what mishearing changes most); repeats collapse.
 *   precious -> PRS    pressure -> PRSR    thomas -> TMS    tomas -> TMS    john -> JN? (j counts as a sibilant) -> SN
 */
export function phonetic(word) {
  let s = fold(word).replace(/ /g, '');
  if (!s) return '';
  s = s
    .replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^ps/, 's').replace(/^wh/, 'w').replace(/^x/, 's').replace(/^th/, 't')
    .replace(/ph/g, 'f').replace(/gh(?=t)/g, '').replace(/ck/g, 'k').replace(/dg(?=[eiy])/g, 'j').replace(/tch/g, 'ch')
    .replace(/x/g, 'ks').replace(/qu?/g, 'k').replace(/th/g, 't').replace(/sch/g, 'sk')
    .replace(/(?:ti|ci|ssi|si)(?=[aou])/g, 'sh')
    .replace(/(?:sh|ch|zh)/g, 'S')
    .replace(/c(?=[eiy])/g, 's').replace(/g(?=[eiy])/g, 'j')
    .replace(/[szj]/g, 'S').replace(/[ckg]/g, 'K').replace(/[pb]/g, 'P').replace(/[td]/g, 'T').replace(/[fv]/g, 'F').replace(/[mn]/g, 'N');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[A-Z]/.test(ch) || /[0-9]/.test(ch)) out += ch;
    else if (ch === 'l') out += 'L';
    else if (ch === 'r') out += 'R';
    else if (i === 0 && 'aeiou'.includes(ch)) out += 'A';
  }
  return out.replace(/(.)\1+/g, '$1');
}

const phoneticSim = (a, b) => {
  const pa = phonetic(a);
  const pb = phonetic(b);
  if (!pa || !pb) return 0;
  if (Math.min(pa.length, pb.length) < 2) return Math.min(0.6, ratio(pa, pb)); // one-consonant keys ("mom" = "me") prove nothing
  if (pa === pb) return 1;
  let sim = ratio(pa, pb);
  if (Math.min(pa.length, pb.length) >= 3 && (pa.startsWith(pb) || pb.startsWith(pa))) sim = Math.max(sim, 0.85);
  return sim;
};

/** Similarity of two single (already folded) words, 0..1. */
export function wordScore(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return Math.max(ratio(a, b), 0.55 * jaroWinkler(a, b) + 0.45 * phoneticSim(a, b));
}

/** Similarity of a query to a full name ("Precious Okafor"): per-word best match, plus a no-spaces comparison ("test me" ~ "testme"). */
export function nameScore(query, name) {
  const q = fold(query);
  const n = fold(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const qt = q.split(' ');
  const nt = n.split(' ');
  const perWord = qt.map((t) => Math.max(...nt.map((x) => wordScore(t, x))));
  let tokens = perWord.reduce((a, b) => a + b, 0) / qt.length;
  if (qt.length > nt.length) tokens *= nt.length / qt.length; // extra words that match nothing
  // spelling-only comparison with the spaces removed ("testme" ~ "Test Me"); no phonetics here, or "pressure" would match "Precious Jr"
  const a = qt.join('');
  const b = nt.join('');
  const joined = Math.max(ratio(a, b), jaroWinkler(a, b) * 0.85);
  // tiny preference for the shorter name when the query is a single word ("Precious" over "Precious Jr")
  return Math.max(tokens, joined) - 0.01 * Math.max(0, nt.length - qt.length);
}

/**
 * Rank contacts ({ names: [...], ... }) against a query. -> [{ contact, score, name }] best first, only plausible ones.
 * min 0.66 is "worth asking about": it catches sound-alikes without suggesting unrelated people.
 */
export function suggest(query, contacts, { limit = 3, min = 0.66 } = {}) {
  const out = [];
  const seen = new Set();
  for (const c of contacts || []) {
    const names = c.names?.length ? c.names : [c.name, ...(c.aliases || [])].filter(Boolean);
    let best = 0;
    let via = '';
    for (const n of names) {
      const s = nameScore(query, n);
      if (s > best) { best = s; via = n; }
    }
    const id = c.jid || c.number || c.name;
    if (best >= min && !seen.has(id)) { seen.add(id); out.push({ contact: c, score: best, name: via }); }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** How to ask: one clear favourite -> yes/no; otherwise a short numbered list. */
export function askShape(ranked) {
  if (!ranked.length) return 'none';
  if (ranked.length === 1) return 'single';
  return ranked[0].score >= 0.8 && ranked[0].score - ranked[1].score >= 0.12 ? 'single' : 'list';
}
