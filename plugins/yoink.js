// yoink: "Lohra yoink <link>" downloads media with yt-dlp (the engine behind Pablo Stanley's "yoinks") and sends it back.
// Owner only. Hardened: URL/SSRF checks, no shell, queue + cooldown, retry ladder, self-updating yt-dlp, size caps, cleanup.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import https from 'node:https';

const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const MAX_MB = num(process.env.YOINK_MAX_MB, 95);          // biggest file we will send
const MAX_BYTES = MAX_MB * 1024 * 1024;
const CONCURRENCY = Math.max(1, num(process.env.YOINK_CONCURRENCY, 1));
const MAX_QUEUE = num(process.env.YOINK_MAX_QUEUE, 6);
const MAX_URLS = 3;                                         // links handled per message
const MAX_ATTEMPTS = 3;                                     // per quality tier
const RUN_TIMEOUT_MS = num(process.env.YOINK_TIMEOUT_S, 420) * 1000;   // one yt-dlp run
const JOB_DEADLINE_MS = 12 * 60_000;                        // whole job
const SEND_TIMEOUT_MS = 6 * 60_000;
const COOLDOWN_MS = 4000;
const TRANSCODE_MAX_S = 600;                                // only re-encode clips up to 10 min
const UPDATE_EVERY_MS = 12 * 3600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => {
  let t;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(t));
};

export class UserError extends Error {}

// ---------- pure helpers (exported for tests) ----------
export function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const u = m[0].replace(/[.,;:!?)\]}>'"*_~]+$/g, '');
    if (u && !out.includes(u)) out.push(u);
  }
  return out.slice(0, MAX_URLS);
}

export function parseUrl(raw) {
  if (!raw || raw.length > 2048) throw new UserError('That link is empty or too long.');
  let u;
  try { u = new URL(raw); } catch { throw new UserError("That doesn't look like a valid link."); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('Only http(s) links are supported.');
  if (u.username || u.password) throw new UserError('Links with embedded credentials are refused.');
  if (!u.hostname) throw new UserError("That doesn't look like a valid link.");
  return u;
}

const privV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
};

export function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return privV4(ip);
  if (v === 6) {
    const x = ip.toLowerCase();
    const dotted = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return privV4(dotted[1]);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const a = parseInt(hex[1], 16); const b = parseInt(hex[2], 16); return privV4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** Best effort SSRF guard (yt-dlp follows redirects itself, so container isolation is the real backstop). */
export async function assertPublicUrl(raw, lookup = (h) => dns.lookup(h, { all: true, verbatim: true })) {
  const u = parseUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UserError('That link points to a private address, refusing.');
    return u.href;
  }
  if (!host.includes('.') || host === 'localhost' || /\.(local|localhost|internal|lan|home|localdomain|intranet|corp)$/.test(host)) {
    throw new UserError("That isn't a public website address, refusing.");
  }
  let addrs;
  try { addrs = await withTimeout(lookup(host), 8000, 'dns'); } catch { throw new UserError("Couldn't resolve that domain."); }
  if (!addrs?.length || addrs.some((a) => isPrivateIp(a.address))) throw new UserError('That link points to a private address, refusing.');
  return u.href;
}

const RULES = [ // order matters
  ['botcheck', /confirm you.?re not a bot|captcha|verify you are human/i, "The site is bot-checking the server's IP right now. Try again later.", false],
  ['toolarge', /larger than max-filesize/i, 'File too large.', false],
  ['live', /does not pass filter|is live|live event|premieres in|will begin in|is a live stream/i, "That's a live stream or an upcoming premiere. Try again once it has finished.", false],
  ['private', /private video|sign in to (view|confirm)|log ?in (is )?required|requires (authentication|login)|members[- ]only|only available to (members|subscribers)|need to log in|use --cookies|account credentials|rate-limit reached or login required/i, "That needs a login (private, members-only or login-walled).", false],
  ['age', /confirm your age|age[- ]restricted|inappropriate for some users/i, 'That one is age-restricted and needs a logged-in account.', false],
  ['geo', /not available in your country|geo.?restrict|blocked (it )?in your country|not made this video available/i, "That's geo-blocked from the server's location.", false],
  ['gone', /video unavailable|this video is (not available|unavailable)|has been removed|no longer available|does not exist|been deleted|http error 404|http error 410|copyright/i, "That video is unavailable (deleted, removed or region/copyright blocked).", false],
  ['unsupported', /unsupported url/i, "That site or link type isn't supported.", false],
  ['novideo', /no video formats found|requested format is not available|no video could be found|there is no video in this post|no media found|no formats? (found|available)/i, 'No downloadable media found at that link.', false],
  ['ratelimit', /http error 429|too many requests|rate.?limit/i, 'The site is rate-limiting the server. Try again in a few minutes.', true],
  ['broken', /http error 403|forbidden/i, 'The extractor for that site seems broken right now.', true],
  ['network', /http error 5\d\d|timed out|timeout|connection (reset|refused|aborted)|temporary failure|network is unreachable|remote end closed|incomplete read|urlopen error|unable to download (webpage|json|video data)|ssl|eof occurred|transporterror|read error|name resolution/i, 'Network trouble reaching the site.', true],
  ['broken', /unable to extract|unable to find|cannot parse|extractor error|please report this issue|nsig|signature|player response|http error 403|forbidden/i, 'The extractor for that site seems broken right now.', true],
];
export function classify(text) {
  const s = String(text || '');
  for (const [kind, re, msg, retry] of RULES) if (re.test(s)) return { kind, msg, retry };
  return { kind: 'unknown', msg: "Couldn't download that link.", retry: true };
}

// ---------- process runner ----------
const S = { dataDir: './data', log: console, queue: [], active: new Set(), children: new Set(), timers: [], disposed: false, updating: null, lastUpdate: 0, lastBy: new Map() };
const isWin = process.platform === 'win32';
const BIN = () => path.join(S.dataDir, 'bin', isWin ? 'yt-dlp.exe' : 'yt-dlp');
const ENV = () => ({ ...process.env, HOME: path.join(S.dataDir, 'home'), XDG_CACHE_HOME: path.join(S.dataDir, 'cache'), PYTHONDONTWRITEBYTECODE: '1' });
const tail = (s, n) => (s.length > n ? s.slice(-n) : s);

export function exec(bin, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    let child;
    try { child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: ENV() }); } catch (err) { return resolve({ code: -1, stdout, stderr: err.message, timedOut }); }
    S.children.add(child);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const t = setTimeout(() => { timedOut = true; kill(); }, Math.max(1000, timeoutMs));
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); S.children.delete(child); resolve({ code, stdout, stderr, timedOut }); };
    child.stdout.on('data', (d) => { stdout = tail(stdout + d, 262_144); });
    child.stderr.on('data', (d) => { stderr = tail(stderr + d, 16_384); });
    child.on('error', (err) => { stderr += `\n${err.message}`; finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

import fsSync from 'node:fs';

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
      const file = fsSync.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(dest).catch(()=>{}); reject(err); });
    }).on('error', reject);
  });
}

async function ensureBinary() {
  await fs.mkdir(path.join(S.dataDir, 'bin'), { recursive: true });
  await fs.mkdir(path.join(S.dataDir, 'cache'), { recursive: true });
  await fs.mkdir(path.join(S.dataDir, 'home'), { recursive: true });
  const ok = await fs.stat(BIN()).then((s) => s.size > 100_000, () => false);
  if (!ok) {
    try {
      // Try to copy from Docker global location first
      await fs.copyFile('/usr/local/bin/yt-dlp', BIN());
      await fs.chmod(BIN(), 0o755);
    } catch {
      // If it fails (e.g. running on local Windows machine), download directly
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp${isWin ? '.exe' : ''}`;
      S.log.info(`Downloading yt-dlp from ${url}`);
      await downloadFile(url, BIN());
      if (!isWin) await fs.chmod(BIN(), 0o755);
    }
  }
}

export async function ytVersion() {
  const r = await exec(BIN(), ['--version'], { timeoutMs: 20_000 });
  return r.code === 0 ? r.stdout.trim() : 'unknown';
}

function updateYtdlp() {
  if (S.updating) return S.updating;
  S.updating = (async () => {
    try {
      await ensureBinary();
      const before = await ytVersion();
      const r = await exec(BIN(), ['-U'], { timeoutMs: 120_000 });
      const after = await ytVersion();
      S.lastUpdate = Date.now();
      S.log.info({ before, after, code: r.code }, 'yt-dlp update check');
      if (after === 'unknown') {
        try {
          await fs.copyFile('/usr/local/bin/yt-dlp', BIN());
          await fs.chmod(BIN(), 0o755);
        } catch {
          // Ignore copy errors on local fallback
        }
      } // corrupt update -> restore
      return { before, after };
    } catch (err) {
      S.log.warn({ err: err.message }, 'yt-dlp update failed');
      return null;
    } finally { S.updating = null; }
  })();
  return S.updating;
}

// ---------- download ----------
const COMMON = ['--ignore-config', '--no-warnings', '--no-progress', '--no-playlist', '--playlist-items', '1', '--js-runtimes', 'node',
  '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '5', '--extractor-retries', '2', '--concurrent-fragments', '2',
  '--match-filter', '!is_live', '--no-mtime', '--restrict-filenames'];

export function buildArgs(url, dir, tier, cacheDir = path.join(S.dataDir, 'cache', 'yt-dlp')) {
  const a = [...COMMON, '--cache-dir', cacheDir, '--max-filesize', `${MAX_MB}M`, '-P', dir, '-o', '%(id).60B.%(ext)s'];
  if (tier.audio) a.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '5');
  else a.push('-f', 'bv*+ba/b', '-S', `res:${tier.h},vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4');
  a.push('--print', 'before_dl:META\t%(title).150B\t%(duration)s', '--print', 'after_move:FILE\t%(filepath)s', '--no-simulate', '--no-quiet', '--', url);
  return a;
}

function parsePrinted(stdout) {
  const meta = { title: '', file: null };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('META\t')) meta.title = line.split('\t')[1] || '';
    else if (line.startsWith('FILE\t')) meta.file = line.slice(5).trim();
  }
  return meta;
}

async function findFile(dir, printed) {
  const cand = printed ? path.resolve(dir, printed) : null;
  if (cand && await fs.stat(cand).then((s) => s.isFile(), () => false)) return cand;
  let best = null;
  for (const n of await fs.readdir(dir).catch(() => [])) {
    if (/\.(part|ytdl|tmp)$/i.test(n) || n.startsWith('.')) continue;
    const p = path.join(dir, n); const st = await fs.stat(p).catch(() => null);
    if (st?.isFile() && (!best || st.size > best.size)) best = { p, size: st.size };
  }
  return best?.p || null;
}
const cleanDir = async (dir) => { for (const n of await fs.readdir(dir).catch(() => [])) await fs.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {}); };

async function download(job, dir, deadline) {
  const tiers = job.audio ? [{ audio: true }] : [{ h: 720 }, { h: 480 }, { h: 360 }, { h: 240 }, { audio: true, fallback: true }];
  let updated = false; let last = null;
  for (const tier of tiers) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (S.disposed || job.cancelled) throw new UserError('Cancelled because the bot reloaded. Send it again.');
      if (Date.now() > deadline) throw new UserError('That took too long, gave up.');
      await cleanDir(dir);
      const r = await exec(BIN(), buildArgs(job.url, dir, tier), { timeoutMs: Math.min(RUN_TIMEOUT_MS, deadline - Date.now()) });
      const printed = parsePrinted(r.stdout);
      const file = r.code === 0 ? await findFile(dir, printed.file) : null;
      if (file) {
        const st = await fs.stat(file);
        if (st.size <= MAX_BYTES) return { file, size: st.size, title: printed.title, tier };
        last = { kind: 'toolarge', msg: `Too big to send (over ${MAX_MB} MB) even at low quality.` };
        break;
      }
      const c = r.timedOut ? { kind: 'timeout', msg: 'The download timed out.', retry: true } : classify(`${r.stderr}\n${r.stdout}`);
      S.log.warn({ host: hostOf(job.url), kind: c.kind, attempt, tier: tier.h || 'audio', err: tail(r.stderr.trim(), 300) }, 'yoink attempt failed');
      last = c;
      if (c.kind === 'toolarge' || c.kind === 'novideo') break;         // try the next tier
      if (!c.retry) throw new UserError(c.msg);                          // permanent
      if (c.kind === 'broken' && !updated) { updated = true; await updateYtdlp(); continue; }
      if (c.kind === 'broken' || attempt === MAX_ATTEMPTS) { if (c.kind === 'broken') throw new UserError(c.msg); break; }
      const base = c.kind === 'ratelimit' ? 10_000 : 2_000;
      await sleep(base * 3 ** (attempt - 1) + Math.random() * 1000);
    }
    if (last?.retry) throw new UserError(last.msg); // transient failures never shrink the quality
  }
  throw new UserError(last?.msg || "Couldn't download that link.");
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };

// ---------- deliver ----------
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', zip: 'application/zip' };

async function probe(file) {
  const r = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt:format=duration', '-of', 'json', file], { timeoutMs: 30_000 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}
const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';
const transcode = async (src, dst) => (await exec(ffmpegBin(), ['-y', '-v', 'error', '-i', src, '-vf', "scale='trunc(min(1280,iw)/2)*2':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst], { timeoutMs: 240_000 })).code === 0;

async function sendWithRetry(ctx, content) {
  let err;
  for (let i = 0; i < 2; i++) {
    try { return await withTimeout(ctx.send(content, { quoted: ctx.msg }), SEND_TIMEOUT_MS, 'upload'); } catch (e) { err = e; if (i === 0) await sleep(3000); }
  }
  throw err;
}

async function deliver(job, res, dir) {
  const { ctx } = job;
  const file = res.file;
  const ext = path.extname(file).slice(1).toLowerCase();
  const info = await probe(file);
  const streams = info?.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !['mjpeg', 'png', 'webp', 'gif', 'bmp'].includes(s.codec_name));
  const a = streams.find((s) => s.codec_type === 'audio');
  const caption = (res.title || '').trim().slice(0, 300) || undefined;
  const nice = (res.title || path.basename(file, `.${ext}`)).replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || 'file';
  let note = '';
  if (res.tier.fallback) note = '\n(audio only, the video was too large)';

  if (v) {
    const good = v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && (!a || ['aac', 'mp3'].includes(a.codec_name)) && ['mp4', 'm4v', 'mov'].includes(ext);
    let out = file;
    if (!good) {
      const dur = Number(info?.format?.duration) || 0;
      out = null;
      if (dur && dur <= TRANSCODE_MAX_S) {
        const dst = path.join(dir, 'wa.mp4');
        if (await transcode(file, dst)) { const st = await fs.stat(dst).catch(() => null); if (st && st.size <= MAX_BYTES) out = dst; }
      }
    }
    if (out) return void await sendWithRetry(ctx, { video: { url: out }, mimetype: 'video/mp4', caption: caption ? caption + note : undefined });
    return void await sendWithRetry(ctx, { document: { url: file }, mimetype: MIME[ext] || 'application/octet-stream', fileName: `${nice}.${ext}`, caption: 'Sent as a file (video format not playable in WhatsApp).' });
  }
  if (a || ['mp3', 'm4a', 'ogg', 'opus'].includes(ext)) return void await sendWithRetry(ctx, { audio: { url: file }, mimetype: MIME[ext] || 'audio/mpeg' });
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return void await sendWithRetry(ctx, { image: { url: file }, caption });
  return void await sendWithRetry(ctx, { document: { url: file }, mimetype: MIME[ext] || 'application/octet-stream', fileName: `${nice}.${ext || 'bin'}` });
}

// ---------- queue ----------
async function runJob(job) {
  const dir = path.join(S.dataDir, 'tmp', 'yoink', job.id);
  try {
    await fs.mkdir(dir, { recursive: true });
    const res = await download(job, dir, Date.now() + JOB_DEADLINE_MS);
    await deliver(job, res, dir);
    S.log.info({ host: hostOf(job.url), mb: Math.round(res.size / 1048576) }, 'yoink delivered');
  } catch (err) {
    const known = err instanceof UserError;
    if (!known) S.log.error({ host: hostOf(job.url), err: err.message }, 'yoink failed');
    await job.ctx.reply(`${known ? err.message : '_Something went wrong while yoinking. Try again in a bit..._'}`).catch(() => {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
function pump() {
  while (!S.disposed && S.active.size < CONCURRENCY && S.queue.length) {
    const job = S.queue.shift();
    S.active.add(job);
    runJob(job).catch(() => {}).finally(() => { S.active.delete(job); pump(); });
  }
}

function quotedText(msg) {
  const m = msg?.message;
  const inner = m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m;
  const ci = Object.values(inner || {}).find((x) => x && typeof x === 'object' && x.contextInfo)?.contextInfo;
  const q = ci?.quotedMessage;
  return q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || q?.videoMessage?.caption || '';
}

const USAGE = '*Usage: Lohra --yoink <link>*\n_Also: Lohra --yoink mp3 <link> (audio only), or reply to a message containing a link with "Lohra --yoink"._';

export default {
  name: 'yoink',
  version: '1.0.0',
  description: 'Download a video/audio/image from a link and send it back (yt-dlp, 1800+ sites)',
  async init(api) {
    S.dataDir = api.config.dataDir; S.log = api.log; S.disposed = false; S.queue = []; S.active = new Set();
    await fs.rm(path.join(S.dataDir, 'tmp', 'yoink'), { recursive: true, force: true }).catch(() => {});
    await ensureBinary().catch((err) => S.log.error({ err: err.message }, 'yoink: yt-dlp setup failed'));
    S.timers.push(setTimeout(() => updateYtdlp(), 30_000), setInterval(() => updateYtdlp(), UPDATE_EVERY_MS));
    for (const t of S.timers) t.unref?.();
  },
  async dispose() {
    S.disposed = true;
    S.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); S.timers = [];
    for (const j of [...S.queue, ...S.active]) j.cancelled = true;
    for (const c of S.children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
    S.queue = [];
  },
  commands: {
    yoink: {
      aliases: ['yoinks'],
      description: 'Grab a video/audio/image from a link and send it back',
      ownerOnly: true,
      run: async (ctx) => {
        const sub = (ctx.args[0] || '').toLowerCase();
        if (sub === 'status') {
          return void await ctx.reply(`yt-dlp ${await ytVersion()}\nActive: ${S.active.size}, queued: ${S.queue.length}\nMax size: ${MAX_MB} MB\nLast update check: ${S.lastUpdate ? new Date(S.lastUpdate).toISOString() : 'not yet'}`);
        }
        if (sub === 'update') {
          const r = await updateYtdlp();
          return void await ctx.reply(r ? (r.before === r.after ? `_yt-dlp is up to date_ (${r.after}).` : `*yt-dlp updated* ${r.before} -> ${r.after}.`) : '_Update failed, check the logs._');
        }
        let text = ctx.argText; let audio = false;
        if (/^(mp3|audio)(\s|$)/i.test(text)) { audio = true; text = text.replace(/^(mp3|audio)\s*/i, ''); }
        let urls = extractUrls(text);
        if (!urls.length) urls = extractUrls(quotedText(ctx.msg));
        if (!urls.length) return void await ctx.reply(USAGE);

        const now = Date.now();
        if (now - (S.lastBy.get(ctx.sender) || 0) < COOLDOWN_MS) return void await ctx.reply('_Easy there, give me a sec._');
        S.lastBy.set(ctx.sender, now);
        if (S.lastBy.size > 200) S.lastBy.clear();

        for (const raw of urls) {
          let href;
          try { href = await assertPublicUrl(raw); } catch (err) { await ctx.reply(`${err instanceof UserError ? err.message : "_That link doesn't look right._"}`); continue; }
          if ([...S.queue, ...S.active].some((j) => j.url === href && j.ctx.jid === ctx.jid)) { await ctx.reply("_I'm already working on that one!_"); continue; }
          if (S.queue.length >= MAX_QUEUE) { await ctx.reply('_Queue is packed right now. Try again in a bit._'); break; }
          const pos = S.queue.length + S.active.size;
          S.queue.push({ id: crypto.randomBytes(6).toString('hex'), url: href, audio, ctx, cancelled: false });
          await ctx.reply(pos ? `_Queued up!_ (#${pos + 1})` : '_Yoinking..._').catch(() => {});
          pump();
        }
      },
    },
  },
};
