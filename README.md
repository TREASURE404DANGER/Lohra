# Lohra — Autonomous WhatsApp AI Assistant

**Try it free:** [lohra.dpdns.org](https://lohra.dpdns.org/): link Lohra to your own WhatsApp number in one minute, no install.

Popular features: [anti-delete for WhatsApp](https://lohra.dpdns.org/anti-delete-whatsapp) · [WhatsApp status viewer](https://lohra.dpdns.org/whatsapp-status-viewer) · [save view-once media](https://lohra.dpdns.org/view-once-whatsapp) · [WhatsApp group bot](https://lohra.dpdns.org/whatsapp-group-bot) · [WhatsApp scam checker](https://lohra.dpdns.org/whatsapp-scam-checker)

Lohra is a lightweight, autonomous WhatsApp assistant designed to run on VPS servers, container environments, or local machines with zero root or system dependencies required.

---

## Features

- **Anti-Delete**: See messages and media people delete, sent privately to you.
- **Status Viewer**: Auto-view and save WhatsApp statuses.
- **View-Once Saver**: Keep view-once photos, videos and voice notes.
- **Scam Shield**: Warns you about scam links and fake offers in your chats.
- **Group Tools**: Catch up on busy groups, lock and unlock groups on a schedule, welcome messages and moderation.
- **AI Pictures**: Create images from a description, or reply to a photo to edit it.
- **Voice Note Transcription & Polish**: Real-time speech-to-text with custom vocabulary injection and Nigerian Pidgin awareness. Handles audio notes of any duration through dynamic silence-aware segmentation.
- **Natural Language & Voice Agent**: Naturally typed messages and voice notes route directly as a command.
- **Human-in-the-Loop Safe Approvals**: The agent never sends messages autonomously. Outgoing requests create an approval you confirm first.
- **Media Downloader (Yoink)**: Fast downloads of videos, audio and media from YouTube, Twitter/X, TikTok, Instagram and more.
- **Extras**: Stickers, song and lyrics search, reminders and games.

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

Don't want to host it yourself? Get a ready-to-use Lohra at [lohra.dpdns.org](https://lohra.dpdns.org/).

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
