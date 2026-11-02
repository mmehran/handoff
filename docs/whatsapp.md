# WhatsApp notifications (optional)

Get a WhatsApp message when any Claude Code session on your computer needs you. That covers Claude Desktop, the terminal, IDEs, and sessions started from Handoff. You can reply right in the chat.

WhatsApp is **off by default**. Handoff works without it, and nothing related to WhatsApp runs until you set it up.

> Want only the alerts, with no web UI and no tunnel? See [WhatsApp-only mode](whatsapp-only.md). It uses the same setup, steps 1 to 4 below.

## What you get

| Message | When | You can reply |
|---|---|---|
| 🔐 **Needs your approval** | A session started from Handoff wants to run a tool (e.g. `Bash: npm test`) | `yes` or `no` |
| ❓ **Claude is asking you** | Any session asks a multiple-choice question; the options are numbered | `2`, `1 3`, or your own text |
| ⏳ **Waiting for you** | A Desktop/terminal session is waiting for input or a permission, with what it needs | (approve it on the computer, or open the link) |
| ✅ **Finished** | A session finished its turn, with the end of Claude's last reply | |
| ⚠️ **Hit an error** | A session started from Handoff failed | |

- If `HANDOFF_PUBLIC_HOSTNAME` is set (own-domain setup), every message includes an **Open** link to that session.
- **Limits:** the same kind of message for the same session goes out at most once every 20 s, and no more than 12 messages per minute in total.
- Pick which kinds you want with `HANDOFF_WHATSAPP_EVENTS`, e.g. `question,waiting,done`.
- **A question in Claude Desktop:** the desktop shows its own picker for the question. Your WhatsApp answer goes into that session's queue and runs as soon as the picker is closed on the computer (Esc). The confirmation message tells you this.

## How it works

```
Handoff ──HTTP (127.0.0.1 only, token)──▶ sender container ──WhatsApp──▶ your phone
       ◀──── polls for your replies ─────
```

The sender (`whatsapp/`) is a small service built on the open-source [Baileys](https://github.com/WhiskeySockets/Baileys) library, which speaks the WhatsApp Web protocol. There's no paid API and no Meta business account. It runs in Docker and is linked to a WhatsApp account as a **linked device**, the same way WhatsApp Web is.

You need **two numbers**:
- a **sending** number. Its phone scans the QR code. A spare SIM or a WhatsApp Business number on a second phone is ideal.
- your **own** number, which **receives** the messages and sends the replies.

> **Risk:** Baileys is an unofficial client. Sending a few messages to your own number like this is low-risk, but WhatsApp can restrict accounts that use unofficial clients. Use a spare number as the sender, not your main one.

## Setup

### 1. Requirements

[Docker](https://docs.docker.com/get-docker/), with `docker compose`. Docker Desktop on Windows/macOS is fine.

### 2. Configure

Pass the number that should **receive** the messages, with its country code:

```bash
npm run setup:whatsapp -- --to +15551234567
```

This writes three values to `.env`:

```ini
HANDOFF_WHATSAPP_ENABLED=true
HANDOFF_WHATSAPP_TO=15551234567
HANDOFF_WHATSAPP_TOKEN=<random shared secret>
```

The token is a shared secret between Handoff and the sender. The sender refuses every request without it, and only ever sends to `HANDOFF_WHATSAPP_TO`.

### 3. Start the sender

From the Handoff folder (where `docker-compose.yml` is):

```bash
docker compose up -d --build
```

Compose reads `HANDOFF_WHATSAPP_TOKEN` and `HANDOFF_WHATSAPP_TO` from the same `.env`. The container is named `handoff-whatsapp`, and it is published on `127.0.0.1:7870` only (`HANDOFF_WHATSAPP_PORT`), never on your network. It restarts with Docker.

### 4. Link the sending phone

Open **http://127.0.0.1:7870/qr** on the computer. On the **sending** phone, go to WhatsApp → **Settings** → **Linked devices** → **Link a device**, and scan the code. The page switches to "Linked". The keys are kept in the Docker volume `wa-auth`, so this is a one-time step.

### 5. Restart Handoff and test

Restart `npm start`. The log shows `[notify] WhatsApp notifications on -> +15551234567`. In the web app, open the **⋮** menu → **Send test WhatsApp**.

## Day to day

| | |
|---|---|
| Sender logs | `docker logs -f handoff-whatsapp` |
| Status | `curl http://127.0.0.1:7870/status` |
| Stop / start | `docker compose stop` / `docker compose start` |
| Update after pulling new code | `docker compose up -d --build` |
| Unlink the sending phone | Remove the device on the phone (Linked devices), or wipe the keys: `docker compose down -v` |
| Turn notifications off | `HANDOFF_WHATSAPP_ENABLED=false`, then restart Handoff |
| Change the recipient | `npm run setup:whatsapp -- --to +<new number>`, then `docker compose up -d` (the container needs the new allow-list) and restart Handoff |

## Security notes

- The sender listens on `127.0.0.1` only. Every API call except `/qr` and `/status` needs the bearer token.
- It sends only to the allowed number(s), and accepts replies only from them. Messages from anyone else are ignored.
- Replies aren't pushed anywhere. Handoff polls the sender for them, so nothing inbound is exposed to the internet.
- Received replies are kept in memory only, at most 200, and are gone when the container restarts.
- Anyone who can read your WhatsApp chat can answer Claude's questions and approve tools for sessions started from Handoff. Keep your phone locked.

## Troubleshooting

| Problem | Fix |
|---|---|
| `required variable HANDOFF_WHATSAPP_TOKEN is missing a value` | Run `npm run setup:whatsapp -- --to ...` first, and run compose from the Handoff folder. |
| "WhatsApp service not running" in the app | `docker compose ps`; start it with `docker compose up -d`. |
| QR page keeps changing | That's normal. A new code appears every ~20 s until it's scanned. |
| Nothing arrives | Check `docker logs handoff-whatsapp`. Is the sending phone online? Is `HANDOFF_WHATSAPP_TO` correct, with country code? |
| `WA_TOKEN missing or too short` in the container log | The token in `.env` must be 24+ characters. Re-run `npm run setup:whatsapp`. |
| Port 7870 is already in use | Set `HANDOFF_WHATSAPP_PORT=7871` in `.env`, then `docker compose up -d` and restart Handoff. |
