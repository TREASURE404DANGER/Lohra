# Lohra — Autonomous WhatsApp AI Assistant

Lohra is a lightweight, autonomous WhatsApp assistant designed to run on VPS servers, container environments, or local machines with zero root or system dependencies required.

---

## Features

- **Voice Note Transcription & Polish**: Real-time speech-to-text using with custom vocabulary injection and Nigerian Pidgin awareness. Handles audio notes of any duration through dynamic silence-aware segmentation.
- **Natural Language & Voice Agent**:
  - Naturally typed messages and voicenotes route directly as a command.
- **Human-in-the-Loop Safe Approvals**: The agent never sends messages autonomously. Outgoing requests create an approval
- **Media Downloader (Yoink)**:
  - Fast integration for downloading videos, audio, and media from YouTube, Twitter/X, TikTok, Instagram, and more.

---

## Quick Start

### 1. Start & Pair

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

Run the automated test suite:

```bash
npm test
```

---

## License

ISC
