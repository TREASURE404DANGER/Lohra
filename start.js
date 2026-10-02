import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseEnv(text) {
  const env = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function serializeEnv(env) {
  const lines = [
    "# ==============================================================================",
    "# Lohra Configuration",
    "# ==============================================================================",
    "",
    "# WhatsApp phone number with country code (e.g. 2348012345678):",
    `PHONE_NUMBER=${env.PHONE_NUMBER || ""}`,
    "",
    "# Default international country code for numbers starting with 0:",
    `DEFAULT_CC=${env.DEFAULT_CC || "234"}`,
    "",
    "# Command prefix:",
    `PREFIX=${env.PREFIX || "Lohra"}`,
    "",
    "# Comma-separated list of additional phone numbers allowed to use admin commands:",
    `ALLOWED=${env.ALLOWED || ""}`,
    "",
    "# Whether public users can use non-admin commands (true/false):",
    `PUBLIC=${env.PUBLIC || "false"}`,
    "",
    "# Google Gemini API key (for voice transcription, voice commands, agent):",
    `GEMINI_API_KEY=${env.GEMINI_API_KEY || ""}`,
    "",
    "# Gemini STT audio pacing multiplier (do not tamper with this if you do not understand it):",
    `GEMINI_STT_SPEEDUP=${env.GEMINI_STT_SPEEDUP || "2"}`,
    "",
    "# Primary language code for speech recognition:",
    `GEMINI_STT_LANG=${env.GEMINI_STT_LANG || "en-US"}`,
    "",
    "# Data and plugins directories:",
    `DATA_DIR=${env.DATA_DIR || "./data"}`,
    `PLUGINS_DIR=${env.PLUGINS_DIR || "./plugins"}`,
    "",
    "# Logging:",
    `LOG_LEVEL=${env.LOG_LEVEL || "info"}`,
    `LOG_PRETTY=${env.LOG_PRETTY || "true"}`,
    "",
  ];
  return lines.join("\n");
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans)));
}

function digits(s) {
  return String(s ?? "").replace(/\D/g, "");
}

// ─── Onboarding wizard ───────────────────────────────────────────────────────

async function onboarding() {
  const existing = fs.existsSync(ENV_PATH)
    ? parseEnv(fs.readFileSync(ENV_PATH, "utf8"))
    : {};

  // Check if setup is already complete: phone number is set and at least one run happened
  const hasSession = fs.existsSync(
    path.join(__dirname, existing.DATA_DIR || "./data", "auth", "creds.json"),
  );
  const isConfigured = !!(
    existing.PHONE_NUMBER && digits(existing.PHONE_NUMBER).length >= 8
  );

  if (isConfigured && hasSession) {
    // Already set up — skip onboarding
    for (const [k, v] of Object.entries(existing)) {
      if (v) process.env[k] = v;
    }
    return existing;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log();
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║                                                      ║");
  console.log("║   L O H R A   S E T U P   W I Z A R D                ║");
  console.log("║                                                      ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();

  if (isConfigured && !hasSession) {
    console.log("  Config found but no active session yet.");
    console.log("  Let's verify your settings before pairing.\n");
  } else {
    console.log("  Welcome! Let's get Lohra configured.");
    console.log("  This only takes a minute.\n");
  }

  const env = { ...existing };

  // ── 1. Phone number ─────────────────────────────────────────────────────

  console.log("─── 📱 WhatsApp Number ───────────────────────────────");
  console.log("  Your number with country code (e.g. 2348012345678).");
  console.log("  Leave blank to scan a QR code instead.\n");

  let phoneInput = await ask(
    rl,
    `  Phone number${env.PHONE_NUMBER ? ` [${env.PHONE_NUMBER}]` : ""}: `,
  );
  phoneInput = phoneInput.trim();
  if (phoneInput) {
    let num = digits(phoneInput);
    if (num.startsWith("0")) {
      const cc = digits(env.DEFAULT_CC || "234");
      num = cc + num.slice(1);
      console.log(`  → Prepended country code: +${num}`);
    }
    env.PHONE_NUMBER = num;
  } else if (!env.PHONE_NUMBER) {
    env.PHONE_NUMBER = "";
    console.log("  → Will show QR code for pairing.");
  }
  console.log();

  // ── 2. Default country code ─────────────────────────────────────────────

  const ccInput = await ask(
    rl,
    `  Default country code [${env.DEFAULT_CC || "234"}]: `,
  );
  if (ccInput.trim()) env.DEFAULT_CC = digits(ccInput) || "234";
  else if (!env.DEFAULT_CC) env.DEFAULT_CC = "234";
  console.log();

  // ── 3. Gemini API key ───────────────────────────────────────────────────

  console.log("─── 🧠 Gemini API Key ────────────────────────────────");
  console.log("  Powers voice transcription, AI commands, and the");
  console.log("  agent. Get one free at:");
  console.log("  https://aistudio.google.com/apikey");
  console.log();

  const geminiDisplay = env.GEMINI_API_KEY
    ? `[${env.GEMINI_API_KEY.slice(0, 6)}...${env.GEMINI_API_KEY.slice(-4)}]`
    : "";
  const geminiInput = await ask(
    rl,
    `  API key${geminiDisplay ? ` ${geminiDisplay}` : ""}: `,
  );
  if (geminiInput.trim()) env.GEMINI_API_KEY = geminiInput.trim();
  else if (!env.GEMINI_API_KEY) env.GEMINI_API_KEY = "";
  console.log();

  // Fill defaults
  if (!env.PREFIX) env.PREFIX = "Lohra";
  if (!env.PUBLIC) env.PUBLIC = "false";
  if (!env.ALLOWED) env.ALLOWED = "";
  if (!env.GEMINI_STT_LANG) env.GEMINI_STT_LANG = "en-US";
  if (!env.GEMINI_STT_SPEEDUP) env.GEMINI_STT_SPEEDUP = "2";
  if (!env.DATA_DIR) env.DATA_DIR = "./data";
  if (!env.PLUGINS_DIR) env.PLUGINS_DIR = "./plugins";
  if (!env.LOG_LEVEL) env.LOG_LEVEL = "info";
  if (!env.LOG_PRETTY) env.LOG_PRETTY = "true";

  rl.close();

  // ── Write .env ──────────────────────────────────────────────────────────

  fs.writeFileSync(ENV_PATH, serializeEnv(env), "utf8");

  console.log();
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║      Configuration saved to .env                     ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();

  // Summary
  console.log("  Settings:");
  console.log(
    `    Phone number:   ${env.PHONE_NUMBER ? `+${env.PHONE_NUMBER}` : "(QR pairing)"}`,
  );
  console.log(`    Country code:   ${env.DEFAULT_CC}`);
  console.log(`    Prefix:         "${env.PREFIX}"`);
  console.log(
    `    Gemini:         ${env.GEMINI_API_KEY ? "configured" : "skipped"}`,
  );
  console.log(`    Public mode:    ${env.PUBLIC}`);
  console.log(`    Language:       ${env.GEMINI_STT_LANG}`);
  console.log();

  // Inject into process.env so the bot picks them up immediately
  for (const [k, v] of Object.entries(env)) {
    if (v) process.env[k] = v;
  }

  return env;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("====================================================");
  console.log("  Lohra is Starting");
  console.log("====================================================");

  // 0. Onboarding — interactive setup if not configured yet
  await onboarding();

  // 1. Auto-install dependencies if node_modules is missing
  const nmPath = path.join(__dirname, "node_modules");
  if (!fs.existsSync(nmPath)) {
    console.log("📦 node_modules missing. Installing dependencies...");
    try {
      await runCommand("npm", ["install", "--omit=dev"]);

      // Handle strict environments (like Pterodactyl panels or secure VPS)
      // that might leave scripts pending.
      console.log("🛡️ Approving install scripts...");
      await runCommand("npm", ["approve-scripts", "--all"]).catch(() => {
        // Ignored: Older npm versions or cases where no scripts were pending
      });
    } catch (err) {
      console.error("⚠️ There was an issue during installation:", err.message);
    }
    console.log("✅ Dependencies successfully installed.\n");
  }

  // 2. Resolve ffmpeg path (prefer ffmpeg-static, fallback to system PATH)
  let ffmpegPath = process.env.FFMPEG_PATH;
  if (!ffmpegPath) {
    try {
      const pkg = await import("ffmpeg-static");
      if (pkg?.default && fs.existsSync(pkg.default)) {
        ffmpegPath = pkg.default;
      }
    } catch {
      // ffmpeg-static not available yet
    }
  }

  // Validate resolved ffmpeg binary
  if (ffmpegPath) {
    const test = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" });
    if (test.error) {
      console.warn(`⚠️ Configured FFmpeg at ${ffmpegPath} cannot be executed: ${test.error.message}`);
      ffmpegPath = null;
    }
  }

  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log(`🎬 Audio Engine: Static FFmpeg (${ffmpegPath})`);
  } else {
    const sysTest = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (!sysTest.error) {
      console.log("🎬 Audio Engine: System FFmpeg (from PATH)");
    } else {
      console.warn("⚠️ No working FFmpeg binary found. Audio conversion and voice transcription will fail.");
    }
  }

  // 3. Launch main bot daemon
  console.log("Launching Lohra...\n");
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "src", "index.js")],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  const forwardSignal = (sig) => {
    if (child && !child.killed) {
      child.kill(sig);
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`\n🛑 Bot process terminated by ${signal}`);
      process.exit(0);
    } else {
      console.log(`\n🛑 Bot process exited with code ${code}`);
      process.exit(code || 0);
    }
  });
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: true,
      cwd: __dirname,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

main().catch((err) => {
  console.error("❌ Fatal startup error:", err);
  process.exit(1);
});
