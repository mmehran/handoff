# Changelog

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
