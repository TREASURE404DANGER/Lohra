import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason as D,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import readline from 'node:readline';
import qrcode from 'qrcode-terminal';
import { archiveAuth, useAtomicAuthState } from './auth.js';
import { withTimeout } from './util.js';

const MAX_PAIRING_CYCLES = 5; // stop nagging WhatsApp if the code/QR is never used

export function backoff(attempt, { base = 2000, max = 60000, jitter = 0.2, rnd = Math.random } = {}) {
  const d = Math.min(max, base * 2 ** attempt);
  return Math.round(d * (1 - jitter + rnd() * jitter * 2));
}

/**
 * Owns the single WhatsApp socket. Guarantees: at most one live socket, automatic
 * reconnect with backoff, never fights another session, never loops on a dead login.
 * Re-emits every Baileys event by name (e.g. 'messages.upsert') plus 'open' / 'close' / 'state'.
 */
export class Connection extends EventEmitter {
  constructor({ config, store, log, baileysLog }) {
    super();
    this.setMaxListeners(100);
    Object.assign(this, { cfg: config, store, log, baileysLog });
    this.phoneNumber = config.phoneNumber || '';
    this.state = 'idle';
    this.stateSince = Date.now();
    this.sock = null;
    this.auth = null;
    this.gen = 0;
    this.attempts = 0;
    this.reconnects = 0;
    this.pairingCycles = 0;
    this.replacedCount = 0;
    this.openedAt = 0;
    this.stopped = true;
    this.timer = null;
    this.stableTimer = null;
    this.watchdog = null;
    this.versionCache = null;
  }

  get authDir() { return path.join(this.cfg.dataDir, 'auth'); }
  get pairingFile() { return path.join(this.cfg.dataDir, 'pairing-code.txt'); }

  async start() {
    this.stopped = false;
    this.watchdog = setInterval(() => this.#check(), 30_000);
    this.watchdog.unref?.();
    await this.#connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.stableTimer);
    clearInterval(this.watchdog);
    const sock = this.sock;
    if (sock) this.#detach(sock);
    await this.auth?.flush?.().catch(() => {});
    this.#setState('stopped');
  }

  /** Resolves with the socket once connected (or rejects after `ms`). */
  waitOpen(ms = 20_000) {
    if (this.state === 'open' && this.sock) return Promise.resolve(this.sock);
    return new Promise((resolve, reject) => {
      const on = (s) => { clearTimeout(t); resolve(s); };
      const t = setTimeout(() => { this.off('open', on); reject(new Error('not connected to WhatsApp')); }, ms);
      this.once('open', on);
    });
  }

  #setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.stateSince = Date.now();
    this.log.info({ state: s }, 'state');
    this.emit('state', s);
  }

  async #getVersion() {
    if (this.versionCache && Date.now() - this.versionCache.at < 6 * 3600 * 1000) return this.versionCache.version;
    try {
      const { version, isLatest } = await withTimeout(fetchLatestBaileysVersion(), 6000, 'version check');
      this.versionCache = { version, at: Date.now() };
      this.log.debug({ version, isLatest }, 'WhatsApp web version');
      return version;
    } catch (err) {
      this.log.warn({ err: err.message }, 'version check failed, using bundled version');
      return undefined;
    }
  }

  async #connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const gen = ++this.gen;
    this.#setState('connecting');
    try {
      this.auth = await useAtomicAuthState(this.authDir, this.log);
      const { state, saveCreds } = this.auth;
      const version = await this.#getVersion();
      if (gen !== this.gen || this.stopped) return;

      const sock = makeWASocket({
        version,
        logger: this.baileysLog,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.baileysLog) },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false, // keep phone notifications working
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        retryRequestDelayMs: 350,
        maxMsgRetryCount: 5,
        msgRetryCounterCache: this.store.retryCache,
        cachedGroupMetadata: async (jid) => this.store.groups.get(jid),
        getMessage: (key) => this.store.getMessage(key),
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => {
        saveCreds().catch((err) => this.log.error({ err }, 'failed to save credentials'));
      });
      sock.ev.process(async (events) => {
        if (gen !== this.gen) return; // stale socket
        for (const [name, data] of Object.entries(events)) {
          try {
            if (name === 'connection.update') this.#onUpdate(sock, data);
            this.emit(name, data);
          } catch (err) {
            this.log.error({ err, event: name }, 'event handler failed');
          }
        }
      });
    } catch (err) {
      this.log.error({ err }, 'failed to start socket');
      this.#setState('closed');
      this.#schedule(backoff(this.attempts++));
    }
  }

  #onUpdate(sock, { connection, lastDisconnect, qr }) {
    if (qr) this.#onQr(sock, qr).catch((err) => this.log.error({ err }, 'pairing step failed'));

    if (connection === 'open') {
      this.openedAt = Date.now();
      this.pairingCycles = 0;
      this.replacedCount = 0;
      clearTimeout(this.stableTimer);
      // only forget failures after the link has stayed up for a while, so flapping keeps backing off
      this.stableTimer = setTimeout(() => { this.attempts = 0; }, 30_000);
      fs.rm(this.pairingFile, { force: true }).catch(() => {});
      this.#setState('open');
      this.log.info({ me: sock.user?.id }, 'connected to WhatsApp');
      this.emit('open', sock);
    } else if (connection === 'close') {
      this.#onClose(sock, lastDisconnect).catch((err) => this.log.error({ err }, 'close handler failed'));
    }
  }

  async #onQr(sock, qr) {
    if (sock.authState.creds.registered) return;
    this.#setState('awaiting-pairing');

    const requestPairing = async (phone) => {
      if (sock.__pairingRequested) return;
      sock.__pairingRequested = true;
      try {
        const raw = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join('-');
        await fs.writeFile(this.pairingFile, `${code}\n`);
        this.log.warn({ code }, 'PAIRING CODE ready');
        console.log(
          `\n====================================================\n` +
          `  🔑 PAIRING CODE:  ${code}\n\n` +
          `  1. Open WhatsApp on your phone\n` +
          `  2. Tap Settings > Linked devices > Link a device\n` +
          `  3. Tap "Link with phone number instead"\n` +
          `  4. Enter the pairing code above: ${code}\n` +
          `====================================================\n`,
        );
      } catch (err) {
        sock.__pairingRequested = false;
        this.log.error({ err: err.message }, 'Failed to request pairing code');
        throw err;
      }
    };

    if (this.phoneNumber) {
      await requestPairing(this.phoneNumber);
      return;
    }

    if (!sock.__prompting) {
      sock.__prompting = true;
      console.log(
        `\n====================================================\n` +
        `  📱 WHATSAPP PAIRING SETUP\n` +
        `  PHONE_NUMBER is not set in .env.\n\n` +
        `  Enter your WhatsApp number with country code\n` +
        `  (e.g., 2348012345678 or +2349012345678):\n` +
        `====================================================\n`,
      );

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const fallbackTimer = setTimeout(() => {
        if (!this.phoneNumber && !sock.__pairingRequested) {
          qrcode.generate(qr, { small: true }, (out) => {
            console.log(`\nScan this QR code with WhatsApp (Linked Devices), or enter phone number:\n${out}\n`);
          });
        }
      }, 60_000);
      fallbackTimer.unref?.();

      rl.question('Phone number: ', async (ans) => {
        clearTimeout(fallbackTimer);
        rl.close();
        let num = String(ans ?? '').replace(/\D/g, '');
        if (num.startsWith('0')) {
          const defaultCc = String(process.env.DEFAULT_CC || '234').replace(/\D/g, '');
          num = defaultCc + num.slice(1);
        }
        if (num.length >= 8 && num.length <= 15) {
          this.phoneNumber = num;
          console.log(`\n⏳ Requesting pairing code for +${num}...`);
          await requestPairing(num).catch((e) => {
            console.log(`❌ Pairing request failed: ${e.message}`);
          });
        } else {
          console.log('\n❌ Invalid phone number. Displaying QR code instead:\n');
          qrcode.generate(qr, { small: true }, (out) => console.log(out));
        }
      });
    }
  }

  async #onClose(sock, lastDisconnect) {
    const err = lastDisconnect?.error;
    const code = err?.output?.statusCode ?? err?.data?.statusCode;
    const registered = !!sock.authState?.creds?.registered;
    this.#detach(sock);
    clearTimeout(this.stableTimer);
    this.#setState('closed');
    this.log.warn({ code, reason: err?.message }, 'connection closed');
    this.emit('close', { code, reason: err?.message });
    if (this.stopped) return;
    this.reconnects++;

    if (code === D.restartRequired) return this.#schedule(300); // normal right after pairing

    if (code === D.loggedOut) {
      this.log.error('logged out (device unlinked on the phone). Starting a fresh pairing.');
      this.#setState('logged-out');
      if (registered) await archiveAuth(this.authDir, this.log);
      else await fs.rm(this.authDir, { recursive: true, force: true });
      this.attempts = 0;
      this.pairingCycles = 0;
      return this.#schedule(3000);
    }

    if (code === D.connectionReplaced) {
      const ms = Math.min(60_000 * 2 ** this.replacedCount++, 15 * 60_000);
      this.log.error({ retryInMs: ms }, 'session replaced by another login, not fighting it');
      return this.#schedule(ms);
    }

    if (code === D.forbidden) {
      this.log.error('403 forbidden: the account may be restricted. Backing off 30 min.');
      return this.#schedule(30 * 60_000);
    }

    if (!registered) {
      if (++this.pairingCycles >= MAX_PAIRING_CYCLES) {
        this.#setState('awaiting-manual');
        this.log.error(`Pairing not completed after ${MAX_PAIRING_CYCLES} attempts, stopped. Restart the container to try again.`);
        return;
      }
      return this.#schedule(3000);
    }

    this.#schedule(backoff(this.attempts++));
  }

  #schedule(ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.log.info({ inMs: ms }, 'reconnecting');
    this.timer = setTimeout(() => this.#connect(), ms);
  }

  #detach(sock) {
    try { sock.ev.removeAllListeners(); } catch { /* ignore */ }
    try { sock.end(undefined); } catch { /* ignore */ }
    if (this.sock === sock) this.sock = null;
  }

  #check() {
    const s = this.sock;
    if (this.state === 'open' && s?.ws && s.ws.isOpen === false) {
      this.log.warn('watchdog: websocket is down while marked open, forcing reconnect');
      s.end(new Error('watchdog: websocket not open'));
    }
  }
}
