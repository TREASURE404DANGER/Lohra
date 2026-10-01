# 🤖 Wabot (Lohra) — Autonomous WhatsApp AI Assistant

A fast, lightweight, autonomous WhatsApp AI assistant powered by **Baileys**, **Google Gemini Live API**, and self-contained static **FFmpeg**.

Designed to run seamlessly in **Pterodactyl Node.js (v22+)** environments, standard VPS servers, or local machines with **zero root/system packages required**.

---

## ✨ Features

- 🎙️ **Voice Note Transcription & Polish**: Real-time speech-to-text using Google Gemini Live with custom vocabulary injection and PIDGIN English awareness. Handles audio notes of any duration through dynamic silence-aware segmentation.
- 🤖 **Natural Language & Voice Agent**:
  - Send text instructions: `Lohra command tell Thomas I'm running 15 minutes late`.
  - Speak naturally: Record a voice note ending with *"this is a command"*.
- 👍 **Human-in-the-Loop Safe Approvals**: The agent never sends messages autonomously. Outgoing requests create an approval card in your chat:
  - React **`👍`** — Send now.
  - React **`🙏`** — Drop as an editable draft in your chat.
  - React **`😢`** — Decline and cancel.
- 📱 **WhatsApp Status (Story) Downloader**:
  - Live background listener for `status@broadcast`.
  - Download contacts' latest photo/video memes or text statuses directly into your chat:
    `Lohra status Precious` or `Lohra command download the last status from Thomas`.
  - List recent contact statuses: `Lohra status list`.
- 📇 **In-Chat Contact Book**:
  - Add contacts on the fly: `Lohra add contact 09012345678 as Thomas alias Mr. T`.
  - Smart normalization for Nigerian (`090...`, `080...` -> `+234...`) and international numbers.
  - Fuzzy and alias matching (speech-to-text hints are fed directly into Gemini).
- 🦖 **Pterodactyl & Node 22 Native**:
  - Self-contained FFmpeg via `ffmpeg-static` (no `apt-get` or root required).
  - Self-bootstraps via `node start.js` (automatically runs `npm install` if `node_modules` is missing).
  - Dual-mode terminal pairing: type your number into the Pterodactyl console to receive an 8-digit pairing code.

---

## 🚀 Quick Start (Pterodactyl / Game Host Node 22+)

Most users on Pterodactyl hosts (like Exaroton, FalixNodes, or private panels) are assigned a standard **Node.js 22 container**. Wabot is pre-configured to run directly on it without needing administrative egg permissions.

### 1. Upload to Server
1. Download or zip the repository files (excluding `node_modules`).
2. In your Pterodactyl **File Manager**, upload the zip file and click **Unarchive**.

### 2. Configure Environment
1. Copy or rename `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` with your settings:
   ```env
   PREFIX=Lohra
   GEMINI_API_KEY=AIzaSy...YourGeminiKeyHere
   DEFAULT_CC=234
   PHONE_NUMBER=
   ```
   > 💡 **Tip**: Leave `PHONE_NUMBER=` empty to enter your number interactively in the terminal console upon first boot.

### 3. Start & Pair
1. Ensure your server's startup command is set to:
   ```bash
   node start.js
   ```
2. Click **Start** in the Pterodactyl Console.
3. On first boot, the console will prompt:
   ```text
   ====================================================
     📱 WHATSAPP PAIRING SETUP
     PHONE_NUMBER is not set in .env.

     Enter your WhatsApp number with country code
     (e.g., 2348012345678 or +2349012345678):
   ====================================================
   Phone number:
   ```
4. Enter your phone number in the console command bar at the bottom.
5. The console will display your 8-digit pairing code:
   ```text
   ====================================================
     🔑 PAIRING CODE:  ABCD-1234
     WhatsApp > Linked devices > Link a device
     > "Link with phone number instead" > enter code
   ====================================================
   ```
6. Enter the code on your phone to link your WhatsApp account.
7. Done! Auth tokens are saved to `./data/auth/`, so future restarts reconnect automatically.

---

## 💻 Local / VPS Quick Start

```bash
# Clone the repository
git clone https://github.com/your-username/wabot.git
cd wabot

# Configure your environment
cp .env.example .env
# Edit .env with your GEMINI_API_KEY

# Launch via self-bootstrapping runner
node start.js
```

---

## 💬 Command Reference

All commands use your configured prefix (default: `Lohra`):

### 🤖 Agent & AI Commands
| Command | Description |
| :--- | :--- |
| `Lohra command <instruction>` | Run a natural language command (alias: `Lohra cmd`, `Lohra do`) |
| `Lohra agent status` | View pending approval requests |
| `Lohra agent yes [id]` | Approve a pending send request |
| `Lohra agent draft [id]` | Drop pending request as a draft in your chat |
| `Lohra agent no [id]` | Decline and cancel pending request |
| `Lohra agent pause` | Temporarily pause external agent actions |
| `Lohra agent resume` | Resume agent actions |

### 📱 WhatsApp Status (Story) Commands
| Command | Description |
| :--- | :--- |
| `Lohra status <contact>` | Download and view the latest status posted by a contact (alias: `Lohra story`) |
| `Lohra status list` | View recent contacts who posted statuses and update counts |

### 📇 Contact Management
| Command | Description |
| :--- | :--- |
| `Lohra add contact <number> as <name> alias <alias>` | Save or update a contact |
| `Lohra contacts` / `Lohra contact list` | List all saved contacts |
| `Lohra contact find <name>` | Search for a contact |
| `Lohra contact remove <name>` | Delete a contact |

### ⚙️ Core & Health Commands
| Command | Description |
| :--- | :--- |
| `Lohra ping` | Check bot connectivity and latency |
| `Lohra status` | View bot uptime, memory, and plugin health (when called without args) |
| `Lohra voice status` | View voice transcription engine status |
| `Lohra voice commands on\|off` | Toggle voice note command execution |
| `Lohra reload` | Hot-reload plugins without restarting the process |

---

## 📁 Project Architecture

```text
├── start.js              # Pterodactyl-friendly self-bootstrapping runner
├── package.json          # Dependencies (including ffmpeg-static)
├── .env.example          # Environment variables template
├── PTERODACTYL_GUIDE.md  # Detailed step-by-step Pterodactyl hosting guide
├── src/
│   ├── index.js          # Bot entrypoint & lifecycle
│   ├── connection.js     # Baileys WhatsApp socket & dual-mode pairing
│   ├── bot.js            # Message router & command dispatcher
│   ├── config.js         # Configuration loader
│   ├── store.js          # LRU message & group cache
│   ├── send.js           # Rate-limited outgoing message queue
│   ├── auth.js           # Atomic credentials persistence
│   └── plugins.js        # Dynamic plugin manager with hot-reloading
├── plugins/
│   ├── agent.js          # Natural language commands & reaction approval
│   ├── _agenttools.js    # Gemini tool surface & dispatch tables
│   ├── _agentlive.js     # Gemini 3.8 Live WebSocket agent engine
│   ├── _contacts.js      # Contact book & fuzzy phonetic matcher
│   ├── status.js         # WhatsApp status commands
│   ├── _status.js        # Real-time status@broadcast capture & media cache
│   ├── voice.js          # Voice note transcriber & silence-aware chunker
│   ├── _audio.js         # PCM/WAV manipulation & energy analysis
│   └── _gemini.js        # Gemini Live audio streaming client
├── cli/
│   └── wabctl            # Terminal CLI tool for external AI agents & scripts
└── test/                 # Automated test suite (120+ tests)
```

---

## 🧪 Testing

Run the automated test suite locally:

```bash
npm test
```

---

## 📄 License
ISC License.
