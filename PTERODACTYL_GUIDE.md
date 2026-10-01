# 🦖 Pterodactyl Deployment & Setup Guide for Wabot

This guide explains how to deploy **Wabot** to any Pterodactyl-based panel (including Exaroton, game hosts, or private panels) using a standard Node.js container with **zero root/system packages required**.

---

## 📋 Features in this Pterodactyl Build
- **Self-contained FFmpeg**: Uses `ffmpeg-static` bundled in `node_modules` — no `apt-get` or host-level installations needed.
- **Auto-Bootstrapping (`start.js`)**: Automatically installs `node_modules` if missing and sets up paths on first boot.
- **Dual-Mode Pairing**:
  - Pre-configure `PHONE_NUMBER` in `.env`, **OR**
  - Leave it blank and type your number directly in the Pterodactyl web console when prompted.
- **Pure Cloud AI**: Powered entirely by Google Gemini Live API — no heavy local Phonon or LLM containers needed (runs smoothly on 512MB–1GB RAM).

---

## 🛠️ Step 1: Prepare the Zip Package

On your machine or VPS, create a clean zip of the bot (excluding local auth credentials and existing node modules):

```bash
cd /path/to/wabot
zip -r wabot.zip . -x "node_modules/*" ".git/*" "data/auth/*" "data/statuses/media/*"
```

---

## 🥚 Step 2: Choose Your Egg Setup

### Option A: Import the Custom Wabot Egg (Recommended)
1. Go to your Pterodactyl Admin Panel > **Nests**.
2. Select or create a Nest (e.g., *NodeJS* or *Bots*).
3. Click **Import Egg** and select [`egg-wabot.json`](./egg-wabot.json).
4. Create a new server using this egg:
   - **Memory**: 512 MB – 1024 MB
   - **Disk**: 2048 MB
   - **CPU**: 100% (1 core)
   - Fill in your `GEMINI_API_KEY` in the server variable fields.

### Option B: Use Any Generic Node.js Egg (e.g., ParkerVCP Yolks / Exaroton)
If you are using an existing generic Node.js egg:
- **Docker Image**: `ghcr.io/parkervcp/yolks:nodejs_20` (or standard `node:20-slim`).
- **Startup Command**: Set to `node start.js`.

---

## 📂 Step 3: Upload and Configure Files

1. Open your server's **File Manager** in Pterodactyl.
2. Upload `wabot.zip`.
3. Click the three dots next to `wabot.zip` and select **Unarchive**.
4. Rename or copy `.env.example` to `.env`.
5. Edit `.env` with your settings:
   ```env
   PREFIX=Lohra
   GEMINI_API_KEY=AIzaSyYourGeminiApiKeyHere
   DEFAULT_CC=234
   PHONE_NUMBER=
   ```
   > 💡 **Tip**: Leave `PHONE_NUMBER=` empty if you want to enter your number interactively in the console on first launch.

---

## 🚀 Step 4: Boot & Pair with WhatsApp

1. Navigate to the **Console** tab in Pterodactyl.
2. Click **Start**.
3. `start.js` will initialize:
   - If `node_modules` is not uploaded, it automatically runs `npm install`.
   - It configures the static FFmpeg binary.
4. When prompted:
   ```text
   ====================================================
     📱 WHATSAPP PAIRING SETUP
     PHONE_NUMBER is not set in .env.

     Enter your WhatsApp number with country code
     (e.g., 2348012345678 or +2349012345678):
   ====================================================
   Phone number:
   ```
5. Type your WhatsApp phone number into the bottom command input box in the Pterodactyl console and press **Enter**.
6. The console will display your 8-digit **PAIRING CODE**:
   ```text
   ====================================================
     🔑 PAIRING CODE:  ABCD-1234

     1. Open WhatsApp on your phone
     2. Tap Settings > Linked devices > Link a device
     3. Tap "Link with phone number instead"
     4. Enter the pairing code above: ABCD-1234
   ====================================================
   ```
7. On your phone, enter the pairing code.
8. The console will log: `INFO: connected to WhatsApp`!

---

## 🔄 Daily Maintenance & Restarts
- Once paired, auth tokens are saved in `/home/container/data/auth/`. Subsequent server restarts will reconnect automatically without needing a new pairing code.
- If you ever want to re-link or change numbers, delete the `data/auth/` folder and restart the server.
