# Contributing

Thanks for helping. Bug reports, fixes and small features are all welcome.

## Getting started

You need Node.js 20 or newer and git. There's nothing to install: the app has no npm dependencies.

```bash
git clone https://github.com/mmehran/handoff.git
```

```bash
cd handoff
```

```bash
npm test
```

To run it while you work: `npm run setup` once (password and 2FA), then `npm run start:local` and open http://localhost:7860. The tests never touch your real `~/.claude`: they use a temporary one and a fake `claude` CLI (`test/fake-claude.js`).

## How the code is laid out

| Folder | What's in it |
|---|---|
| `src/services.js` | The parts you can turn on and off (web app, WhatsApp alerts), and what each needs |
| `src/index.js` | `npm start`: starts the parts that are on; the HTTP server and tunnel only if one needs them |
| `src/core.js` | What every part shares: history, the runner, alerts, the audit log, answering questions |
| `src/server.js` | The HTTP server: security headers, the health check, and the parts that answer requests |
| `src/web.js` | The web app's routes: sign-in, CSRF, pages and the `/api/*` they use |
| `src/api.js`, `src/api-*.js`, `src/turns.js` | The API (`/api/v1`): keys and reading, sending and answers (turns), files; `openai.js`, `compare.js`, `webhooks.js`, `openapi.js` for the rest; keys in `src/apikeys.js` |
| `clients/` | Ready-made API clients: Python, JavaScript and a `handoff` command |
| `src/store.js` | Reads Claude Code's transcripts and session registry (read-only) |
| `src/runner.js` | Starts and drives `claude` processes for sessions Handoff runs |
| `src/notify.js`, `src/push.js` | Alerts: WhatsApp and phone push notifications |
| `src/search.js`, `src/files.js`, `src/changes.js` | Search, the Files tab and the Changes tab |
| `src/tunnel.js` | cloudflared / ngrok and the tunnel watchdog |
| `public/` | The web app: plain JavaScript, no framework or build step |
| `whatsapp/` | The optional WhatsApp sender (Docker) |
| `scripts/` | Setup helpers and the autostart scripts |
| `test/` | `node:test` tests, plus the CI scripts for autostart |

## Ground rules

- **No npm dependencies in the app.** Use what Node ships with (`node:crypto`, `node:test`, …). The WhatsApp sender is the one exception and lives in its own container.
- **Read-only towards Claude Code.** Handoff never changes Claude's settings or rewrites transcripts.
- **Safe by default.** Anything that exposes more (the Files tab, bypass mode) is off until someone turns it on, and is documented in [docs/security.md](docs/security.md).
- **No HTML from data.** The web app inserts text with `textContent`, never `innerHTML`.
- **Plain language** in the UI and docs: say what happens, in short sentences.

## Pull requests

- Keep each pull request to one change, and add or update tests for it. `npm test` must pass; CI runs it on Windows, macOS and Linux with Node 20 and 22, and runs the autostart scripts for real.
- Update the docs and `.env.example` when you add a setting, and add a line to [CHANGELOG.md](CHANGELOG.md).
- Commit messages: a short summary line in the imperative ("Add …", "Fix …"), then a few lines on why.

## Security issues

Please don't open a public issue for a security problem. Report it privately to the maintainer; see [docs/security.md](docs/security.md#reporting-a-vulnerability).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
