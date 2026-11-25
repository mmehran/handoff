# Changelog

## 1.4.0 (2026-11-26)

### Added
- **Choose what to run.** The web app (`HANDOFF_WEB`, on by default) and WhatsApp alerts (`HANDOFF_WHATSAPP_ENABLED`) can each be used on their own or together. `npm start` starts only the parts that are on; with WhatsApp alerts alone nothing listens on a port and no password or tunnel is needed. See docs/services.md.
- **`npm run setup` asks which parts you want** and sets up only what they need: a password and 2FA for the web app, the receiving number for WhatsApp alerts. Enter keeps each current answer; `--services web,whatsapp` skips the questions; nothing is written if setup stops halfway.
- `npm start` stops with the command to run when a part that is on isn't set up yet, or when nothing is on.

### Changed
- `npm run whatsapp-only` and `autostart … -WhatsAppOnly` still work, as `npm start` with the web app off. The autostart task otherwise just follows `.env`.
- Turning WhatsApp alerts off in setup keeps their number and token for later.
- For contributors: the server is split into a shared core (`src/core.js`), the web app (`src/web.js`) and the HTTP server (`src/server.js`); the parts are listed in `src/services.js`.

## 1.3.0 (2026-11-26)

### Added
- **Commit and push from the Changes tab**: tick the files, write the message or let Claude write it (a quick one-off call: no tools, nothing saved as a chat), commit just those files, and push. A branch without an upstream gets one, and the pull request link the hosting site prints is shown.
- **Discard one file's changes** from its diff, after a confirm. A copy of the file is kept in `data/discarded` for 30 days.
- **Comments on diff lines**: the diff has line numbers; tap a line to comment, then send every comment to Claude as one message with the file, line and code of each.
- **Folder picker** on the New session page: the home folder and every drive (or only `HANDOFF_ALLOWED_ROOTS`), git projects marked, and a new folder (optionally a new git repository) for a new project. Recent project folders are one tap away.
- **Sessions in their own git worktree**: a new folder and branch (`handoff/<name>`) under `.claude/worktrees`, made from the last commit and kept out of the main checkout's git status. Remove the worktree from its Changes tab once its work is committed; the branch stays.
- `HANDOFF_GIT_ACTIONS` (on by default) turns commit, push, discard and worktrees off.

### Changed
- Worktree projects are named "project · worktree" in the lists.
- On phones, the file path sits on its own line above a diff.

## 1.2.0 (2026-11-25)

### Added
- **New look**: light and dark themes (Auto follows the system), a compact message box, and a chat header that stays pinned with the status, folder, search, mute and tabs.
- **Sidebar layout** on tablets and computers (1000px and wider): live sessions and projects next to the open chat.
- **Live to-do list**: Claude's checklist (TaskCreate/TaskUpdate, or TodoWrite) pinned in the chat header.
- **Plan approval**: Claude's plan (ExitPlanMode) as a card; approve, approve and accept edits, or send it back with what to change.
- **Overview tab**: time, your messages, tool calls, files changed, commands run, plan, to-do list and sub-agents (`GET /api/sessions/:id/activity`).
- **Sub-agent runs**: open what each sub-agent did, from the chat or the overview (`GET /api/sessions/:id/agents`).
- **Quick replies** above the message box, editable.
- **Allow / Deny on approval notifications** (where the phone shows notification buttons).
- **Share to Handoff** from other apps on Android, and **home-screen shortcuts** (New session, Search all chats).
- **Mute a single chat**, besides whole projects; a project's mute also covers its worktrees.

### Changed
- Markdown is rendered properly: tables (scrolling sideways on a phone), links, numbered/nested/task lists, quotes, and code blocks with a language label and a Copy button.
- Tool rows show paths from the project folder; to-do updates are one quiet line; search rows show the pattern.
- The page loads its script and styles by versioned addresses, so a CDN or browser cache can't serve old ones after an update.
- Resetting the password keeps the 2FA you already set up.

### Fixed
- A muted project still got alerts from chats that had moved to another folder or ran in a worktree.
- The sign-in page said "missing header" after an update until the page was reloaded; it now says to reload.

## 1.1.0 (2026-11-25)

### Added
- **Phone push notifications**: each device turns them on from the menu and gets the same alerts as WhatsApp, even with the app closed. Web Push is implemented on `node:crypto` (RFC 8291 / 8292), with no libraries.
- **Search** across every chat, inside one chat, and a hit shown in context. Only prompts and replies are indexed (`data/search/`).
- **Changes tab**: the project's uncommitted git changes, with a coloured diff per file.
- **Files tab** (`HANDOFF_FILE_BROWSER=true`): browse the session's folder, find files by name, code colouring, Markdown preview, view images, download any file.
- **Photos** attached to a prompt (up to 4, scaled down on the phone).
- **Quiet hours** for alerts (`HANDOFF_WHATSAPP_QUIET`), with one summary afterwards, and **per-project mute**.
- **Remember me** on the sign-in page (`HANDOFF_REMEMBER_DAYS`, 30 days).
- A warning at the top of the page while WhatsApp alerts can't be delivered.
- The page reloads itself after an update (unless there's unsent text).
- `scripts/autostart.sh` for Linux (systemd) and macOS (launchd).
- CI on Windows, macOS and Linux, running the autostart scripts for real; screenshots in the README.

### Changed
- Transcripts are read without blocking the server, so a busy disk delays only the request that needs it.
- The tunnel switches from QUIC to HTTP/2 for a while when QUIC keeps failing, as on some VPNs (`HANDOFF_TUNNEL_PROTOCOL`).
- The WhatsApp sender follows the maintained Baileys 6.7 line; `npm run update:whatsapp` rebuilds it.
- Phone numbers are masked in the logs; the audit log rotates at 5 MB and can leave prompt text out (`HANDOFF_AUDIT_TEXT=false`).

### Fixed
- The tunnel watchdog restarted `cloudflared` again and again on a busy machine, mistaking stalls for sleep.

## 1.0.0 (2026-11-02)

First release: browse every Claude Code project and session from a phone, watch live, send prompts into running sessions, answer questions and approve tools, with optional WhatsApp alerts and a WhatsApp-only mode.
