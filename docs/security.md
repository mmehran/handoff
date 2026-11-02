# Security model

Handoff gives remote access to a machine that can run code. Anyone who signs in can make Claude run commands on your computer, within the permission mode they choose. Treat your Handoff password and 2FA like an SSH key.

## Network

- The server listens on **127.0.0.1 only**. The tunnel (`cloudflared` or `ngrok`) is the only way in, and it terminates HTTPS at Cloudflare/ngrok.
- No ports are opened on your router. The WhatsApp sender is also bound to `127.0.0.1`.
- Optional extra layer: [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or ngrok's `--oauth` in front of the hostname. See the own-domain guide for the `/api/health` exception.

## Sign-in

- The password is hashed with **scrypt** (N=16384, r=8, p=1, 16-byte salt). It must be at least 12 characters, or you can let the setup generate one.
- **TOTP 2FA** (RFC 6238) works with any authenticator app. Each code is accepted once (replay protection).
- **Throttling:** 5 failures per IP per 15 minutes, plus a global lock after 20 failures to stop attacks from rotating IPs. Failed attempts also get a random delay.
- The password and the 2FA code are always both checked, so the response time doesn't reveal which one was wrong.
- **Session cookie:** a random 256-bit token, sent as `HttpOnly; Secure; SameSite=Strict`. Only its SHA-256 is stored, in `data/sessions.json`. It expires after 24 h idle or 7 days at most, and both are configurable.
- **Sign out all devices** is in the ⋮ menu. Re-running `npm run setup` also signs out every device.

## Web app

- **CSRF:** state-changing requests need a custom `X-Handoff` header and a same-origin `Origin`.
- **Strict Content-Security-Policy:** no inline scripts, nothing loaded from third parties, and the page can't be framed. `X-Content-Type-Options: nosniff`, HSTS and `Referrer-Policy: no-referrer` are also set.
- All text from transcripts is inserted with `textContent`, never as HTML.
- **Inputs are validated:** session IDs must be UUIDs, project keys can't traverse paths, modes and model names come from an allow-list, and the working directory must exist (optionally restricted with `HANDOFF_ALLOWED_ROOTS`).
- Prompts reach `claude` as JSON over stdin, never on a command line, so they can't inject shell commands.

## Claude Code

- **Tool approvals default to "ask"**: sessions started from Handoff send every permission request to your phone. Unanswered requests are denied after 30 minutes.
- `bypassPermissions` is hidden unless you set `HANDOFF_ALLOW_BYPASS=true`.
- **Live delivery into running sessions:** Handoff uses Claude Code's own local messaging inbox. The per-session inbox token (`~/.claude/sessions/<pid>.<hash>.key`) is read only at the moment of sending. It is never stored, logged or sent to the browser.
- Handoff **reads** Claude Code's files and never changes Claude settings or rewrites transcripts.
- Secrets from `.env` are not passed to the `claude` processes Handoff starts, and `HANDOFF_*` variables are stripped from their environment.

## Secrets at rest

| Secret | Where | If it leaks |
|---|---|---|
| Password hash, 2FA secret | `.env` | Run `npm run setup` again. |
| Cloudflare tunnel run token | `.env` | Delete the tunnel in Cloudflare, then run `npm run setup:domain` again. |
| WhatsApp shared token | `.env` | Run `npm run setup:whatsapp` again, then `docker compose up -d`. |
| WhatsApp linked-device keys | Docker volume `wa-auth` | Remove the linked device on the phone; `docker compose down -v`. |
| Cloudflare API token | **never stored** | Delete it in Cloudflare after setup. |

`.env` and `data/` are git-ignored. Don't commit them, paste them into issues, or include them in screenshots.

## Audit log

`data/audit.log` records sign-ins (successful, failed and blocked), prompts sent, approvals, interrupts, stops and WhatsApp tests, with the client IP from Cloudflare's `CF-Connecting-IP` header.

## Reporting a vulnerability

Please report security issues privately to the maintainer instead of opening a public issue.
