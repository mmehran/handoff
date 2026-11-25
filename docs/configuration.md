# Configuration

Every setting is an environment variable. Handoff reads them from `.env` in the project folder, and real environment variables override the file. Start from [`.env.example`](../.env.example). `npm run setup` copies it to `.env` for you.

- `.env` is git-ignored. It's the only place secrets live: the password hash, the 2FA secret and tokens.
- Values from `.env` are **not** copied into the environment of the `claude` processes Handoff starts. Any `HANDOFF_*` variables set in the real environment are stripped from those processes too.
- Wrap a value in `'single quotes'` to keep it exactly as written. The setup scripts do this for the password hash.
- To use a different file: `HANDOFF_ENV_FILE=/path/to/file npm start`.

## What to run

Handoff's parts can be used on their own or together; see [Choosing what to run](services.md). `npm run setup` asks which ones you want and writes these for you.

| Variable | Default | |
|---|---|---|
| `HANDOFF_WEB` | `true` | The web app: browse and drive Claude Code from a browser, with phone notifications. `false` turns it off: no sign-in, no pages, and (unless another part needs it) no listening port and no tunnel. |
| `HANDOFF_WHATSAPP_ENABLED` | `false` | WhatsApp alerts. See [WhatsApp](#whatsapp-optional) below. |
| `HANDOFF_API` | `false` | The API at `/api/v1`, for your own programs. See [the API](#the-api) below and [docs/api.md](api.md). The web app can also turn it on and off (menu → API access). |

## The API

| Variable | Default | |
|---|---|---|
| `HANDOFF_API_DIR` | `~/Handoff chats` | Where sessions started without a project run, one folder per key, so they never land inside your projects. Made if missing; it must be inside `HANDOFF_ALLOWED_ROOTS` if that is set. |
| `HANDOFF_API_IDLE_SECONDS` | `60` | Idle Claude processes the API started stop after this long, so they don't fill `HANDOFF_MAX_RUNS`. The next prompt resumes the session. |
| `HANDOFF_API_UPLOAD_MB` | `20` | Largest file per upload (photos stay at 5 MB, as Claude accepts). |
| `HANDOFF_API_CORS_ORIGINS` | empty | Websites allowed to call the API from a browser, comma-separated. Empty: none. |

API keys aren't settings: make them with `node scripts/api-key.js create --name "…"` or in the web app (menu → API access). Only a hash of each key is kept, in `data/api-keys.json`.

## Sign-in

| Variable | Default | |
|---|---|---|
| `HANDOFF_PASSWORD_HASH` | — | **Required** for the web app. Written by `npm run setup` (scrypt). |
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
| `HANDOFF_PUSH` | `true` | Phone push notifications. Each device turns them on from the ⋮ menu → **Phone notifications**; nothing is sent until one does. `false` removes the option. |
| `HANDOFF_PUSH_CONTACT` | `https://<public hostname>` | Contact (`mailto:` or `https:` URL) given to the browsers' push services with each message, as Web Push requires. |
| `HANDOFF_SEARCH` | `true` | Full-text search across chats. Keeps a text-only index of prompts and replies in `data/search/` (about 1% of the transcripts' size). `false` turns search off. |
| `HANDOFF_AUDIT_TEXT` | `true` | Record the first 200 characters of each prompt and typed answer in `data/audit.log`. `false` keeps only who did what and when. |
| `HANDOFF_FILE_BROWSER` | `false` | Adds **Files** and **Changes** tabs to every session: browse and search its project folder, open text, code (coloured) and images, download files, and see uncommitted git changes with diffs. The Files tab is read-only. See [security](security.md#files-tab). |
| `HANDOFF_GIT_ACTIONS` | `true` | In the Changes tab: commit (Claude can write the message), push and discard one file's changes; and new sessions in their own git worktree. `false` = the Changes tab only shows what changed, and no worktrees. See [security](security.md#git-from-the-changes-tab). |
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
| `data/server.log` | Output when started with `--log-file` (autostart). `npm run whatsapp-only` writes `data/whatsapp-only.log` instead. |
| `data/public-url.txt` | The current public address. |
| `data/api-keys.json` | API keys: a SHA-256 of each key (never the key itself) and its settings. Mode `600`. |
| `data/api-usage.json`, `data/api-sessions.json`, `data/api-turns.json` | Per key: use per day, the sessions it started, and a short note per turn. |

Handoff never writes to `~/.claude`. The only exception is Claude Code itself, which records the sessions Handoff starts or resumes, just as it does for any session.
