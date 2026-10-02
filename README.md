# Lohra — Autonomous WhatsApp AI Assistant

Lohra is a lightweight, autonomous WhatsApp AI assistant powered by **Baileys**, **Google Gemini Live API**, and self-contained static **FFmpeg**.

Designed to run on VPS servers, container environments, or local machines with zero root or system dependencies required.

---

## Features

- **Voice Note Transcription & Polish**: Real-time speech-to-text using Google Gemini Live with custom vocabulary injection and Nigerian Pidgin awareness. Handles audio notes of any duration through dynamic silence-aware segmentation.
- **Natural Language & Voice Agent**:
  - Naturally typed messages without a command prefix route directly to the Gemini AI agent.
  - End any voice note with *"this is a command"* to run it as an instruction, or *"this is not a command"* to enforce plain transcription.
- **Human-in-the-Loop Safe Approvals**: The agent never sends messages autonomously. Outgoing requests create an approval card in your chat:
  - React **👍** — Send now.
  - React **🙏** — Drop as an editable draft in your chat.
  - React **😢** — Decline and cancel.
- **Media Downloader (Yoink)**:
  - Fast, self-updating `yt-dlp` integration for downloading videos, audio, and media from YouTube, Twitter/X, TikTok, Instagram, and more.
- **WhatsApp Status (Story) Downloader**:
  - Live background listener for `status@broadcast`.
  - Download contacts' latest photo/video statuses directly into your chat: `Lohra --status <contact>` or `Lohra --story <contact>`.
  - List recent contact statuses: `Lohra --status list`.
- **In-Chat Contact Book**:
  - Add contacts on the fly: `Lohra --add contact 09012345678 as Thomas alias Mr. T`.
  - Smart normalization for Nigerian (`090...`, `080...` -> `+234...`) and international numbers.
  - Fuzzy and phonetic alias matching.
- **Zero-Dependency Startup**:
  - Self-contained FFmpeg via `ffmpeg-static` with automated startup binary validation.
  - Self-bootstraps via `node start.js` (automatically runs `npm install` if dependencies are missing).
  - Terminal pairing code generator: enter your number in the console to receive an 8-digit WhatsApp pairing code.

---

## Quick Start

### 1. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
PREFIX=Lohra
GEMINI_API_KEY=AIzaSy...YourGeminiKeyHere
DEFAULT_CC=234
PHONE_NUMBER=
```
> *Tip*: Leave `PHONE_NUMBER=` empty to enter your number interactively in the terminal console upon first boot.

### 2. Start & Pair
```bash
node start.js
```

1. On first boot, the console will prompt for your WhatsApp number (with country code, e.g. `2348012345678`).
2. An 8-digit pairing code will appear in your console.
3. Open WhatsApp on your phone: **Settings > Linked Devices > Link a Device > Link with phone number instead**.
4. Enter the 8-digit code.
5. Auth tokens are saved to `./data/auth/`, so future restarts reconnect automatically.

---

## Docker Deployment

Run Lohra via Docker Compose:

```bash
docker compose up -d
```

View live logs:
```bash
docker compose logs -f lohra
```

---

## Command Reference

Commands use the `--` prefix convention. Any message sent to Lohra without `--` is treated as a natural language instruction for the Gemini AI agent.

### Core Messaging
- `Lohra --ping`: Check bot connectivity and latency.
- `Lohra --help`: View available commands organized by category.
- `Lohra --guide` [dev]: In-chat manual and architecture guide.

### Status
- `Lohra --status`: View bot uptime, memory, and plugin health.
- `Lohra --status <name>`: Download the latest status from a contact (alias: `--story`).
- `Lohra --status list`: List recent contacts who posted statuses.

### Utility
- `Lohra --yoink <url>`: Download video or audio from supported sites.
- `Lohra --archive`: Search or retrieve past WhatsApp messages and media.
- `Lohra --contacts`: Manage saved contacts and aliases.

### Agent & Live
- `Lohra --agent`: Check agent channel status and pending approvals.
- `Lohra --voice`: View voice transcription and engine status.

---

## Project Architecture

```text
├── start.js          # Self-bootstrapping launcher & binary validator
├── package.json      # Dependencies and configuration
├── .env.example      # Environment variables template
├── docker-compose.yml# Docker deployment definition
├── Dockerfile        # Container image build definition
├── src/
│   ├── index.js      # Entrypoint & process lifecycle
│   ├── connection.js # Baileys WhatsApp connection & pairing
│   ├── bot.js        # Message router & command dispatcher
│   ├── config.js     # Environment configuration loader
│   ├── store.js      # LRU message & group cache
│   ├── send.js       # Outgoing message rate limiter
│   ├── auth.js       # Atomic credentials persistence
│   └── plugins.js    # Dynamic plugin manager with hot reloading
├── plugins/
│   ├── agent.js      # Gemini Live agent & approval workflow
│   ├── voice.js      # Voice note transcription & dynamic chunker
│   ├── status.js     # WhatsApp status commands
│   ├── yoink.js      # Media downloader via yt-dlp
│   ├── archive.js    # Message archiver & search
│   ├── watch.js      # Real-time contact activity watcher
│   ├── guide.js      # Interactive in-chat manual
│   └── didyoumean.js # Typo tolerance and command suggestions
├── cli/
│   └── wabctl        # Terminal & agent CLI management tool
└── test/             # Automated test suite (183 passing tests)
```

---

## Testing

Run the automated test suite:

```bash
npm test
```

---

## License
ISC
