const digits = (s) => String(s ?? '').replace(/\D/g, '');
const bool = (s, d = false) => (s == null || s === '' ? d : /^(1|true|yes|on)$/i.test(String(s).trim()));
const num = (s, d) => (s == null || s === '' || Number.isNaN(Number(s)) ? d : Number(s));

export function loadConfig(env = process.env) {
  return Object.freeze({
    dataDir: env.DATA_DIR || './data',
    pluginsDir: env.PLUGINS_DIR || './plugins',
    phoneNumber: digits(env.PHONE_NUMBER),
    prefix: env.PREFIX || '.',
    allowed: (env.ALLOWED || '').split(',').map(digits).filter(Boolean),
    public: bool(env.PUBLIC),
    logLevel: env.LOG_LEVEL || 'info',
    baileysLogLevel: env.BAILEYS_LOG_LEVEL || 'warn',
    pretty: bool(env.LOG_PRETTY, true),
    commandMaxAgeSec: num(env.COMMAND_MAX_AGE_SEC, 60), // ignore stale messages replayed after downtime
    sendGapMs: num(env.SEND_GAP_MS, 400), // minimum gap between outgoing messages
  });
}

export const config = loadConfig();
