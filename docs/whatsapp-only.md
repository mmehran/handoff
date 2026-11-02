# WhatsApp-only mode

Just want a WhatsApp ping when Claude Code needs you, and nothing else? WhatsApp-only mode runs **without** the web UI, the password, the tunnel, or any listening port. It watches the Claude Code sessions on your computer (Claude Desktop, terminal, IDEs) and messages you when:

- ❓ a session **asks a question** (numbered options; reply `2` or type an answer, and it's delivered into the session)
- ⏳ a session is **waiting** for you (e.g. a permission prompt; the message says what it needs)
- ✅ a session **finished** (with the end of Claude's last reply)

There is no public endpoint at all. The only network traffic is to the WhatsApp sender container on `127.0.0.1` and from that container to WhatsApp.

## Setup

You need Node.js 20+ and Docker. Claude Code must be installed, but this mode doesn't run the `claude` CLI, so it doesn't need to be signed in separately.

```bash
git clone https://github.com/mmehran/handoff.git
cd handoff
```

1. **Configure:**
   ```bash
   npm run setup:whatsapp
   ```
   It asks for the number that should *receive* the alerts, with its country code (e.g. `+15551234567`). You can also pass it directly: `npm run setup:whatsapp -- --to +15551234567`. This creates `.env` and fills in `HANDOFF_WHATSAPP_ENABLED`, `HANDOFF_WHATSAPP_TO` and `HANDOFF_WHATSAPP_TOKEN`. You don't need `npm run setup`; there's no password in this mode.

2. **Start the sender:**
   ```bash
   docker compose up -d --build
   ```

3. **Link the sending phone.** Open http://127.0.0.1:7870/qr and scan it from WhatsApp → Settings → Linked devices on the phone that should **send** the messages. Use a spare number; see the risk note in [whatsapp.md](whatsapp.md).

4. **Run it:**
   ```bash
   npm run whatsapp-only
   ```
   ```
   [notify] WhatsApp notifications on -> +15551234567
   Handoff (WhatsApp only) watching C:\Users\you\.claude
   WhatsApp sender linked as 15550000000; notifications go to +15551234567
   ```

Leave it running, or install it to [start automatically](autostart.md):
- Windows: `scripts\autostart.ps1 install -WhatsAppOnly`
- Linux/macOS: use `src/whatsapp-only.js` in the service file

## How it knows

Claude Code keeps a small status file for every running session in `~/.claude/sessions/<pid>.json` (`busy`, `waiting`, `idle`, plus what it's waiting for). Handoff reads those every 3 seconds. It sends a message:
- when a session turns `waiting`
- when it goes from `busy`/`waiting` to `idle`, which means it finished
- when an unanswered `AskUserQuestion` appears in the session's transcript

All of this is read-only. Nothing in Claude Code's settings or sessions is changed.

When you reply with an option number (or text), the answer is delivered into that running session through Claude Code's own local messaging inbox, the same mechanism the full Handoff app uses. In Claude Desktop the question's picker stays open on screen. Your answer runs as soon as it's closed there (Esc), and the confirmation message tells you so.

## Limits

- **No approvals.** Tool permission prompts in Desktop/terminal sessions can only be answered on the computer. You get a ⏳ message saying what's needed, but replying `yes` does nothing in this mode. The full Handoff app can approve tools for sessions it starts itself.
- **No links.** There's no web UI, so messages don't include an "Open" link.
- The limits from [whatsapp.md](whatsapp.md) apply: one message per kind per session every 20 s, and 12 messages per minute in total. Choose kinds with `HANDOFF_WHATSAPP_EVENTS`.

Want the web UI later? Run `npm run setup` (password + 2FA), pick a tunnel, and use `npm start` instead. Your WhatsApp settings carry over.
