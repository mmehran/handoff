# Handoff

**Self-hosted remote control for Claude Code.** Handoff runs on the computer where you use Claude Code and lets you reach it from your phone or any other browser. You can browse every project and session, watch Claude work live, send prompts, answer its questions, and approve tools. Optionally, it also sends you WhatsApp messages when a session needs you.

It's a small Node.js server with no npm dependencies. It listens on `127.0.0.1` only and reaches the internet through a Cloudflare tunnel.

> Handoff is an independent open-source project. It is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## What it does

- **Browse everything.** See every project and session from Claude Desktop, the CLI and IDEs, with full history: messages, tool calls and results.
- **Watch live.** Sessions open on your computer show up with busy, waiting or idle status, and messages stream in as Claude works. No refreshing.
- **Send prompts anywhere:**
  - type into a session that's open on your computer and it appears there in real time
  - continue an old session in place, or fork it
  - start a new session in any folder
- **Same choices as Claude Desktop.** The model list comes from your installed Claude Code, with each model's effort levels and the permission modes (Ask, Accept edits, Plan, Auto; Bypass only if you allow it).
- **Approve tools from your phone.** Requests like "Allow Bash: npm test?" pop up with Allow and Deny buttons.
- **Answer Claude's questions.** When Claude asks a multiple-choice question, you see the options and tap one.
- **WhatsApp alerts (optional).** Get a message when a session needs approval, asks a question, is waiting, finishes or fails. Reply `yes`/`no` or an option number to answer straight from WhatsApp. This uses a self-hosted sender built on the open-source [Baileys](https://github.com/WhiskeySockets/Baileys) library, so there's no paid API.
- **Works on a phone.** The layout is responsive and touch-friendly, and you can install it to the home screen as a PWA.

## Pick your setup

| You want | Guide | Needs |
|---|---|---|
| Try it now, free, no domain | [Quick tunnel (random URL)](docs/setup-quick-tunnel.md) | `cloudflared` |
| A permanent address like `https://claude.example.com` | [Your own domain on Cloudflare](docs/setup-own-domain.md) | A domain on Cloudflare (free plan is fine) |
| WhatsApp alerts as well | [WhatsApp notifications](docs/whatsapp.md) | Docker, a second WhatsApp number |
| **Only** WhatsApp alerts, no web UI or tunnel | [WhatsApp-only mode](docs/whatsapp-only.md) | Docker, a second WhatsApp number |

Also useful:
- [Configuration reference](docs/configuration.md): every `.env` setting
- [Start automatically](docs/autostart.md) on Windows, macOS or Linux
- [Security model](docs/security.md)

## Quick start

You need [Node.js 20+](https://nodejs.org) and [Claude Code](https://github.com/anthropics/claude-code) installed and signed in (`claude auth login`).

```bash
git clone https://github.com/mmehran/handoff.git
cd handoff
npm run setup        # creates .env, asks for a password and sets up 2FA
```

Install `cloudflared` (other systems: [releases](https://github.com/cloudflare/cloudflared/releases)):

```bash
winget install --id Cloudflare.cloudflared      # Windows
```

```bash
brew install cloudflared                        # macOS
```

Then start it:

```bash
npm start
```

The console prints a `https://<random-words>.trycloudflare.com` address, and also saves it to `data/public-url.txt`. Open it on your phone and sign in. That's it.

For a local-only test without a tunnel, run `npm run start:local` and open http://127.0.0.1:7860.

There are no runtime npm packages to install. The WhatsApp sender is the only part with dependencies, and it runs in its own Docker container.

## How it works

```
 phone / other PC ──HTTPS──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ Handoff (127.0.0.1:7860)
                                                                      │
                     reads ~/.claude/projects/*.jsonl (history) ◀─────┤
                     reads ~/.claude/sessions/*.json (what's live) ◀──┤
                     runs `claude -p --input-format stream-json` ◀────┤  sessions it drives
                     writes to a running session's local inbox ◀──────┘  sessions open on your computer
```

- **History** is read straight from Claude Code's own files, and only read. Handoff never changes your Claude settings or rewrites transcripts.
- **Sending a prompt** depends on where the session is:

  | Session | What happens |
  |---|---|
  | Open on your computer right now (Desktop/CLI) | Delivered live into that session through Claude Code's local messaging inbox, so it appears on screen in real time. Its tool approvals stay on your computer. |
  | Not running anywhere | Resumed in place (same session ID) with `claude -p --resume`. Next time you open it in Claude Desktop, the new turns are there. |
  | Started from Handoff and still running | Sent straight to that process. Tool approvals come to your phone. |
  | "Fork" ticked | `--fork-session`: a new copy with the full history; the original is untouched. |

- **Live updates** use Server-Sent Events. Cloudflare quick tunnels buffer event streams, so when a stream stalls the page falls back to polling for new lines every 2 s and the status dot turns yellow.

## Settings

All settings live in `.env`; see [`.env.example`](.env.example) and the [configuration reference](docs/configuration.md). `.env` is git-ignored, and nothing secret is stored anywhere else. The setup commands write it for you:

| Command | Writes |
|---|---|
| `npm run setup` | `HANDOFF_PASSWORD_HASH`, `HANDOFF_TOTP_SECRET` |
| `npm run setup:domain` | `HANDOFF_TUNNEL=cloudflare`, `HANDOFF_PUBLIC_HOSTNAME`, `HANDOFF_CLOUDFLARE_TUNNEL_TOKEN` |
| `npm run setup:whatsapp -- --to +15551234567` | `HANDOFF_WHATSAPP_ENABLED`, `HANDOFF_WHATSAPP_TO`, `HANDOFF_WHATSAPP_TOKEN` |

## Commands

| Command | |
|---|---|
| `npm start` | Server, plus the tunnel chosen by `HANDOFF_TUNNEL` |
| `npm run start:local` | Server only, at http://127.0.0.1:7860 |
| `npm run whatsapp-only` | WhatsApp alerts only, with no server |
| `npm test` | Tests. They use a fake `~/.claude` and a fake `claude` CLI, so they never touch your data. |
| `docker compose up -d --build` | WhatsApp sender (optional) |

## Platform support

Developed and used daily on **Windows 11**: Claude Desktop, Claude Code CLI, cloudflared and Docker Desktop. The code is cross-platform Node.js, and live delivery into running sessions uses Unix sockets on macOS/Linux. But macOS and Linux are **not tested yet**, so reports and fixes are welcome.

## Claude's built-in Remote Control

Claude Code also has an official Remote Control feature (`claude --remote-control`, or the toggle in Claude Desktop). It drives one running session from claude.ai or the Claude app, with no tunnel. Handoff is self-hosted and covers all projects and history: you can start sessions in any folder, approve tools from any browser, and get WhatsApp alerts. Use whichever fits, or both.

## License

[MIT](LICENSE)
