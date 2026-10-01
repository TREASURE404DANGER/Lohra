#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('====================================================');
  console.log('  🚀 Wabot Starting (Pterodactyl / Node Environment)');
  console.log('====================================================');

  // 1. Auto-install dependencies if node_modules is missing
  const nmPath = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    console.log('📦 node_modules missing. Installing dependencies...');
    await runCommand('npm', ['install', '--omit=dev']);
    console.log('✅ Dependencies successfully installed.\n');
  }

  // 2. Resolve ffmpeg path (prefer ffmpeg-static, fallback to system PATH)
  let ffmpegPath = process.env.FFMPEG_PATH;
  if (!ffmpegPath) {
    try {
      const pkg = await import('ffmpeg-static');
      if (pkg?.default && fs.existsSync(pkg.default)) {
        ffmpegPath = pkg.default;
      }
    } catch {
      // ffmpeg-static not available yet
    }
  }

  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log(`🎬 Audio Engine: Static FFmpeg (${ffmpegPath})`);
  } else {
    console.log('🎬 Audio Engine: System FFmpeg (from PATH)');
  }

  // 3. Launch main bot daemon
  console.log('▶️ Launching bot daemon...\n');
  const child = spawn(process.execPath, [path.join(__dirname, 'src', 'index.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  const forwardSignal = (sig) => {
    if (child && !child.killed) {
      child.kill(sig);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', (code, signal) => {
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
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, cwd: __dirname });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

main().catch((err) => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
