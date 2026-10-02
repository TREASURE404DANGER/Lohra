import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Plugin shape (default export of a .js file in plugins/, or plugins/<dir>/index.js):
 *   { name, version?, description?,
 *     init?(api), dispose?(),
 *     commands?: { <name>: { aliases?, description?, ownerOnly?, run(ctx) } },
 *     on?: { '<baileys event>': (data, api) => {} } }
 * Files starting with "_" or "." are ignored. Broken plugins are skipped, never crash the bot.
 */
export class PluginManager {
  #busy = Promise.resolve();
  #subscribed = new Set();
  #watcher = null;
  #debounce = null;

  constructor({ config, log, api, conn, builtinDir = path.join(HERE, 'builtin'), onHelperChanged = null }) {
    Object.assign(this, { cfg: config, log, api, conn, builtinDir, onHelperChanged });
    this.plugins = new Map();  // name -> { name, mod, source, file }
    this.commands = new Map(); // command or alias -> { command, plugin, name }
    this.failed = [];
  }

  resolve(name) { return this.commands.get(String(name).toLowerCase()); }

  reload() {
    const run = this.#busy.then(() => this.#load());
    this.#busy = run.catch(() => {});
    return run;
  }

  async #files(dir) {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      if (e.isFile() && /\.(m?js)$/.test(e.name)) out.push(path.join(dir, e.name));
      else if (e.isDirectory()) {
        const idx = path.join(dir, e.name, 'index.js');
        if (await fs.stat(idx).then(() => true, () => false)) out.push(idx);
      }
    }
    return out.sort();
  }

  async #load() {
    const plugins = new Map();
    const commands = new Map();
    const failed = [];
    const sources = [['builtin', this.builtinDir], ['plugin', this.cfg.pluginsDir]];

    for (const [source, dir] of sources) {
      for (const file of await this.#files(dir)) {
        try {
          const mod = (await import(`${pathToFileURL(path.resolve(file)).href}?v=${Date.now()}`)).default;
          if (!mod || typeof mod !== 'object' || !NAME_RE.test(mod.name || '')) throw new Error('invalid plugin: needs a default export with a valid "name"');
          if (plugins.has(mod.name)) throw new Error(`duplicate plugin name "${mod.name}"`);
          const mine = [];
          for (const [cname, command] of Object.entries(mod.commands || {})) {
            if (typeof command?.run !== 'function') throw new Error(`command "${cname}" has no run()`);
            for (const n of [cname, ...(command.aliases || [])].map((s) => String(s).toLowerCase())) {
              if (!NAME_RE.test(n)) throw new Error(`bad command name "${n}"`);
              if (commands.has(n) || mine.some(([k]) => k === n)) throw new Error(`command "${n}" already exists`);
              mine.push([n, { command, plugin: mod.name, name: cname }]);
            }
          }
          plugins.set(mod.name, { name: mod.name, mod, source, file });
          for (const [k, v] of mine) commands.set(k, v);
        } catch (err) {
          failed.push({ file: path.basename(file), error: err.message });
          this.log.error({ file, err: err.message }, 'plugin failed to load');
        }
      }
    }

    // swap in the new set, then tidy up the old one
    const old = this.plugins;
    this.plugins = plugins;
    this.commands = commands;
    this.failed = failed;
    for (const p of old.values()) {
      try { await p.mod.dispose?.(); } catch (err) { this.log.warn({ plugin: p.name, err: err.message }, 'dispose failed'); }
    }
    for (const p of plugins.values()) {
      try {
        await p.mod.init?.(this.api);
        for (const ev of Object.keys(p.mod.on || {})) this.#subscribe(ev);
      } catch (err) {
        this.log.error({ plugin: p.name, err: err.message }, 'plugin init failed');
        failed.push({ file: path.basename(p.file), error: `init: ${err.message}` });
      }
    }
    this.log.info({ plugins: plugins.size, commands: commands.size, failed: failed.length }, 'plugins loaded');
    return { loaded: plugins.size, commands: commands.size, failed };
  }

  #subscribe(event) {
    if (this.#subscribed.has(event) || !this.conn) return;
    this.#subscribed.add(event);
    this.conn.on(event, (data) => {
      for (const p of this.plugins.values()) {
        const fn = p.mod.on?.[event];
        if (typeof fn !== 'function') continue;
        Promise.resolve().then(() => fn(data, this.api)).catch((err) => this.log.error({ plugin: p.name, event, err: err.message }, 'plugin event handler failed'));
      }
    });
  }

  /**
   * Reload automatically when files in plugins/ change.
   * Helper modules (files starting with "_") are imported statically and cached by Node, so a plain reload would keep running
   * their OLD code. When one changes, onHelperChanged() is called after reloading so the process can restart and really pick it up.
   */
  watch() {
    let helper = false;
    try {
      this.#watcher = watch(this.cfg.pluginsDir, { recursive: true }, (_ev, file) => {
        if (file && /(^|[\\/])_[^\\/]*\.m?js$/.test(file) && !/\.test\.m?js$/.test(file)) helper = true;
        clearTimeout(this.#debounce);
        this.#debounce = setTimeout(async () => {
          await this.reload().catch((err) => this.log.error({ err: err.message }, 'auto-reload failed'));
          if (helper && this.onHelperChanged) {
            helper = false;
            this.log.warn('a helper file (_*.js) changed: restarting so the new code is used');
            this.onHelperChanged();
          }
        }, 1500);
      });
      this.#watcher.on('error', () => {});
    } catch (err) {
      this.log.warn({ err: err.message }, 'plugin auto-reload unavailable (use the reload command)');
    }
  }

  async stop() {
    clearTimeout(this.#debounce);
    this.#watcher?.close();
    for (const p of this.plugins.values()) await Promise.resolve(p.mod.dispose?.()).catch(() => {});
  }
}
