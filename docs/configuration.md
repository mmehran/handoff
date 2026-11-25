# Configuration

Every setting is an environment variable. Handoff reads them from `.env` in the project folder, and real environment variables override the file. Start from [`.env.example`](../.env.example). `npm run setup` copies it to `.env` for you.

- `.env` is git-ignored. It's the only place secrets live: the password hash, the 2FA secret and tokens.
- Values from `.env` are **not** copied into the environment of the `claude` processes Handoff starts. Any `HANDOFF_*` variables set in the real environment are stripped from those processes too.
- Wrap a value in `'single quotes'` to keep it exactly as written. The setup scripts do this for the password hash.
- To use a different file: `HANDOFF_ENV_FILE=/path/to/file npm start`.

## Sign-in

| Variable | Default | |
|---|---|---|
| `HANDOFF_PASSWORD_HASH` | — | **Required** for the web UI. Written by `npm run setup` (scrypt). |
| `HANDOFF_TOTP_SECRET` | empty | Base32 secret for authenticator-app 2FA. Empty = 2FA off. Written by `npm run setup`. |
| `HANDOFF_LOGIN_IDLE_HOURS` | `24` | A sign-in expires after this much inactivity. |
| `HANDOFF_LOGIN_MAX_DAYS` | `7` | A sign-in expires after this long regardless. |
| `HANDOFF_REMEMBER_DAYS` | `30` | Ticking **Remember me** on the sign-in page keeps that device signed in for this many days, even when it's idle or the browser is closed. `0` removes the option. Without it, a sign-in also ends when the browser is closed. |

## Server

| Variable | Default | |
|---|---|---|
| `HANDOFF_PORT` | `7860` | Local port. If you change it with a named tunnel, re-run `npm run setup:domain`. |
| `HANDOFF_HOST` | `127.0.0.1` | Keep it on loopback; the tunnel is the way in. Anything else prints a warning. |
| `HANDOFF_DATA_DIR` | `./data` | Runtime files: hashed sign-in tokens, `audit.log`, `server.log`, `public-url.txt`. |

## Tunnel

| Variable | Default | |
|---|---|---|
| `HANDOFF_TUNNEL` | `none` (`.env.example` sets `quick`) | `none`, `quick` (Cloudflare quick tunnel, random URL), `cloudflare` (your own domain), or `ngrok`. `npm run start:local` ignores it. |
| `HANDOFF_PUBLIC_HOSTNAME` | empty | Your hostname, e.g. `claude.example.com`. Used for the named tunnel and for links in WhatsApp messages. |
| `HANDOFF_CLOUDFLARE_TUNNEL_TOKEN` | empty | Run token of the named tunnel. Written by `npm run setup:domain`. |
| `HANDOFF_TUNNEL_PROTOCOL` | `auto` | How `cloudflared` connects: `auto` (QUIC, switching to HTTP/2 for 6 hours when QUIC keeps failing, as it can on VPNs or strict networks), `quic` or `http2`. |

The Cloudflare **API** token is never stored. `npm run setup:domain` reads it from a prompt, or from `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) for that one command.

## Claude Code

| Variable | Default | |
|---|---|---|
| `HANDOFF_CLAUDE_HOME` | `~/.claude` | Where Claude Code keeps projects and sessions. |
| `HANDOFF_CLAUDE_PATH` | found on `PATH` | Full path to the `claude` CLI. |
| `CLAUDE_CODE_OAUTH_TOKEN` | empty | Optional token from `claude setup-token`, used only for sessions Handoff starts. Empty = your normal CLI login. |
| `HANDOFF_DEFAULT_MODE` | `manual` | Permission mode for sessions started from the phone: `manual` (ask before tools), `acceptEdits`, `plan`, `auto`, `dontAsk`. |
| `HANDOFF_ALLOW_BYPASS` | `false` | Offer `bypassPermissions` (no approvals at all) in the mode menu. |
| `HANDOFF_ALLOWED_ROOTS` | empty | Only allow new sessions inside these folders, and only browse files inside them. Separator: `;` on Windows, `:` on macOS/Linux. Empty = any existing folder. |
| `HANDOFF_SEARCH` | `true` | Full-text search across chats. Keeps a text-only index of prompts and replies in `data/search/` (about 1% of the transcripts' size). `false` turns search off. |
| `HANDOFF_AUDIT_TEXT` | `true` | Record the first 200 characters of each prompt and typed answer in `data/audit.log`. `false` keeps only who did what and when. |
| `HANDOFF_FILE_BROWSER` | `false` | Adds **Files** and **Changes** tabs to every session: browse and search its project folder, open text, code (coloured) and images, download files, and see uncommitted git changes with diffs. All read-only. See [security](security.md#files-tab). |
| `HANDOFF_MAX_RUNS` | `3` | Most Claude processes Handoff runs at once. |
| `HANDOFF_IDLE_KILL_MINUTES` | `15` | Stop an idle process Handoff started. It resumes on the next message. |
| `HANDOFF_PERMISSION_TIMEOUT_MINUTES` | `30` | Auto-deny a tool approval nobody answered. |

## WhatsApp (optional)

| Variable | Default | |
|---|---|---|
| `HANDOFF_WHATSAPP_ENABLED` | `false` | Turn notifications on. |
| `HANDOFF_WHATSAPP_TO` | empty | Number that receives the messages, with country code. Also the sender's allow-list. |
| `HANDOFF_WHATSAPP_TOKEN` | empty | Shared secret between Handoff and the sender container, 24+ characters. Written by `npm run setup:whatsapp`. |
| `HANDOFF_WHATSAPP_PORT` | `7870` | Port the sender is published on (`127.0.0.1` only). |
| `HANDOFF_WHATSAPP_URL` | `http://127.0.0.1:<port>` | Only if the sender runs elsewhere. |
| `HANDOFF_WHATSAPP_EVENTS` | all | Comma-separated: `approval`, `question`, `waiting`, `done`, `error`. |
| `HANDOFF_WHATSAPP_QUIET` | empty | Quiet hours in the computer's local time, e.g. `23:00-07:00`. Alerts in that window are held, then summed up in one message when it ends. |
| `HANDOFF_WHATSAPP_QUIET_ALLOW` | empty | Kinds still sent during quiet hours, comma-separated, e.g. `approval,question`. |

`docker-compose.yml` reads `HANDOFF_WHATSAPP_TOKEN`, `HANDOFF_WHATSAPP_TO` and `HANDOFF_WHATSAPP_PORT` from the same `.env`.

## Files Handoff writes

| Path | What |
|---|---|
| `.env` | Settings and secrets (mode `600` where the filesystem supports it). Written only by the setup scripts. |
| `data/sessions.json` | SHA-256 hashes of sign-in tokens, never the tokens themselves. |
| `data/audit.log` | Sign-ins, prompts, approvals and stops, one JSON object per line. |
| `data/server.log`, `data/whatsapp-only.log` | Output when started with `--log-file` (autostart). |
| `data/public-url.txt` | The current public address. |

Handoff never writes to `~/.claude`. The only exception is Claude Code itself, which records the sessions Handoff starts or resumes, just as it does for any session.
