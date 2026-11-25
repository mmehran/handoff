# Choosing what to run

Handoff has three parts. Use any one of them on its own, or any mix:

| Part | What you get | What it needs | Turned on by |
|---|---|---|---|
| **Web app** | Browse and drive Claude Code from your phone or any browser: every project and session, live updates, prompts, approvals, questions, files and changes. Phone notifications too, for devices that turn them on. | A password (and ideally 2FA): `npm run setup`. To reach it from your phone, a tunnel: a [quick tunnel](setup-quick-tunnel.md) or [your own domain](setup-own-domain.md). | `HANDOFF_WEB=true` (the default) |
| **WhatsApp alerts** | A WhatsApp message when a session needs approval, asks a question, is waiting, finishes or fails. Reply `yes`/`no` or an option number to answer straight from WhatsApp. | Docker, and a second WhatsApp number for the sender: `npm run setup:whatsapp`. See [WhatsApp](whatsapp.md). | `HANDOFF_WHATSAPP_ENABLED=true` |
| **API** | Your own programs, scripts and phone shortcuts send prompts and get answers, pick sessions, attach files, and more; an OpenAI-compatible endpoint for chat apps. See [the API](api.md). | API keys: `node scripts/api-key.js create`, or the web app's menu → API access. To reach it from elsewhere, a tunnel. | `HANDOFF_API=true` |

`npm run setup` asks which parts you want, then sets up only what they need: a password and 2FA for the web app, the receiving number for WhatsApp alerts, a first key for the API. To pick without the questions, use `npm run setup -- --services web,whatsapp,api` (any of them).

`npm start` starts the parts that are turned on in `.env`, and nothing else.

## Combinations

| You want | In `.env` | Listens on a port? | Tunnel? | Password? |
|---|---|---|---|---|
| The web app only | `HANDOFF_WEB=true` | yes (`127.0.0.1` only) | to reach it from your phone | yes |
| WhatsApp alerts only | `HANDOFF_WEB=false`<br>`HANDOFF_WHATSAPP_ENABLED=true` | **no** | **no** | **no** |
| The API only | `HANDOFF_WEB=false`<br>`HANDOFF_API=true` | yes (`127.0.0.1` only) | to reach it from elsewhere | no (API keys instead) |
| The web app and WhatsApp alerts | `HANDOFF_WEB=true`<br>`HANDOFF_WHATSAPP_ENABLED=true` | yes | to reach it from your phone | yes |
| The API and WhatsApp alerts | `HANDOFF_WEB=false`<br>`HANDOFF_WHATSAPP_ENABLED=true`<br>`HANDOFF_API=true` | yes | to reach it from elsewhere | no |
| All three | all three `true` | yes | yes | yes |

If nothing is on, or a part that is on isn't set up yet (the web app without a password, WhatsApp without its number and token), `npm start` stops and says which command sets it up. The API without any keys starts, with a warning saying how to make one.

## What changes when a part is off

**Web app off:**
- No sign-in, no pages. With only WhatsApp alerts, nothing listens on a port, so `HANDOFF_TUNNEL` is ignored.
- Phone notifications are off too: phones sign up for them in the web app.
- WhatsApp messages leave out the "Open:" link, and API answers leave out `webUrl`, as there is nothing to open.
- With no web app and no API, nothing starts Claude: a WhatsApp reply answers a question in a session that is open on the computer, but a session that has closed in the meantime can't be answered.
- API keys are made with `node scripts/api-key.js`, and the API is turned on in `.env` (or `npm run setup`).

**WhatsApp alerts off:** alerts go only to phones that turned on notifications in the web app (⋮ menu → Phone notifications).

**API off:** `/api/v1/*` answers `404 api_off`. Keys are kept, and work again once it's back on.

## Switching later

Run `npm run setup` again (Enter keeps each current answer), or change the settings in `.env` yourself. Turning WhatsApp alerts off keeps their number and token, so turning them back on needs no new setup. The web app can also turn the API on and off (menu → API access), with no restart. Otherwise restart Handoff: `npm start`, or with autostart:

```bash
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 restart   # Windows
sh scripts/autostart.sh restart                                         # macOS, Linux
```

The autostart task runs the same thing as `npm start`, so it follows `.env` too; there is nothing else to change. The older `npm run whatsapp-only` and `autostart … -WhatsAppOnly` still work: they run Handoff with the web app turned off, whatever `.env` says.

## For contributors

Each part is listed in [`src/services.js`](../src/services.js), with what it needs and whether it answers HTTP requests. They share one core ([`src/core.js`](../src/core.js)): Claude Code's history, the processes Handoff runs, alerts, the audit log, API keys. The web app's routes are in [`src/web.js`](../src/web.js) and the API's in [`src/api.js`](../src/api.js); [`src/server.js`](../src/server.js) puts the parts that answer requests behind one HTTP server and the tunnel's health check. A new part is a new entry in `services.js`, plus its own module on top of the core.
