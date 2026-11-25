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
- **Session cookie:** a random 256-bit token, sent as `HttpOnly; Secure; SameSite=Strict`. Only its SHA-256 is stored, in `data/sessions.json`. It expires after 24 h idle or 7 days at most, and both are configurable. Without **Remember me** the cookie also ends when the browser closes. With it, the cookie lasts `HANDOFF_REMEMBER_DAYS` (30 by default) whether or not the device is used, so only tick it on your own devices.
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

## Files tab

Off by default. With `HANDOFF_FILE_BROWSER=true`, every session gets a read-only **Files** tab for its project folder.

- Anyone signed in can read **every file in that folder**, `.env` files included. That's no more than they could already ask Claude to show them, but only turn it on if that's fine for you.
- Paths are resolved with symlinks and junctions followed, so nothing outside the session's folder can be listed or opened. Links that point outside it are left out of the listing.
- Handoff's own `.env` and `data/` folder, Claude Code's `~/.claude/.credentials.json` and the session inbox tokens are never shown, even when a session runs in a folder that contains them.
- Nothing can be changed, uploaded or deleted. Text is shown up to 1 MB and images up to 20 MB. Videos and binary files can't be previewed, only downloaded (up to 100 MB, served as an attachment with a sandboxing CSP).
- Find by name doesn't follow links and never searches `.git` or `node_modules`.
- The **Changes** tab runs `git status` and `git diff` in the folder: no shell, fixed arguments, and file paths go through the same checks as the Files tab. Files hidden from the Files tab are left out of it too.
- Images are served with `Content-Security-Policy: default-src 'none'; sandbox`, so an SVG opened on its own can't run scripts on the site.
- Every file opened, downloaded or diffed is recorded in the audit log (`file_view`, `file_download`, `diff_view`).
- `HANDOFF_ALLOWED_ROOTS` limits the Files tab too.

## Git from the Changes tab

On by default when the Changes tab is on; `HANDOFF_GIT_ACTIONS=false` turns it off.

- **Commit** commits only the files the Changes tab lists and you ticked: hidden files (`.env` and the like) and anything outside the session's folder can't be picked. Paths reach git as literal pathspecs on standard input, never as arguments it could read as options. The message goes through a temporary file.
- **Write with Claude** sends the diff of the ticked files (cut down to about 40 KB) to a one-off `claude -p` call with no tools, no settings files or hooks (`--restricted` where Claude Code supports it) and nothing saved as a chat.
- **Push** uses the laptop's own git and the sign-in it has saved. git is told never to ask for a password or open a sign-in window, so a push that would need one fails with a message instead of hanging. Handoff never sees or stores git credentials, and the pull request link is read from the hosting site's own reply.
- **Discard** keeps a copy of the file first in `data/discarded` (removed after 30 days), then puts it back as it was at the last commit, or deletes it if it is new. Files with merge conflicts are left alone.
- **Worktrees** are made with `git worktree add` under `<project>/.claude/worktrees/<name>` on a new branch, from the last commit; `.claude/worktrees/` goes in the repository's `.git/info/exclude` (never committed). Removing one refuses while its session runs or while it has uncommitted changes, and keeps the branch.
- Every commit, push, discard and worktree removal is in the audit log (`git_commit`, `git_push`, `git_discard`, `worktree_remove`).

## New session folder picker

- Lists folders only, never files, starting from the home folder and the drives. With `HANDOFF_ALLOWED_ROOTS` set it starts from those folders and lists nothing outside them.
- Folder names that start with `.` or `$`, and system folders like `System Volume Information`, are left out.
- **New folder** makes one folder (with an optional `git init`) inside the folder you are in; names with path separators, `..` or Windows' reserved names are refused. It is in the audit log as `folder_create`.

## Phone notifications

- Handoff signs each push with its own key pair (VAPID, RFC 8292), made on first start and kept in `data/push-keys.json`.
- Every message is encrypted for the receiving device (RFC 8291, aes128gcm). The push service (Google, Apple, Mozilla or Microsoft) carries it but can't read it.
- Subscriptions are only accepted for those push services (an allow-list of their hostnames, HTTPS only), so a stored subscription can't make the server call other addresses. They're kept in `data/push-subscriptions.json`, and devices the push service reports as gone are removed.
- Turning notifications on or off is recorded in the audit log.

## Photos

Photos sent with a prompt are checked (JPEG, PNG, GIF or WebP, the bytes must match, at most 4 of 5 MB each). Sessions Handoff runs get them as image blocks in the prompt, and they aren't stored anywhere else. For a session open on the computer they're saved in its project folder under `.handoff-uploads/`, which has its own `.gitignore` so git ignores it, and are deleted after a week.

## Search index

With `HANDOFF_SEARCH=true` (the default), Handoff keeps a copy of what your prompts and Claude's replies said in `data/search/`, so it can search them quickly. Tool output isn't copied. It's the same text that's already in `~/.claude`, git-ignored with the rest of `data/`, and never shown in the Files tab. Delete the folder at any time; it's rebuilt in the background.

## API

The API (`HANDOFF_API`, off by default) lets programs drive Claude Code on this computer, so it's built to give each program only what it needs. Details: [the API](api.md).

**Keys:**
- They're made in the web app (which asks for your 2FA code, or the password when 2FA is off) or with `node scripts/api-key.js` on the computer.
- A key is 32 random bytes. Only its SHA-256 is kept, in `data/api-keys.json` (mode 600).
- It's shown once, never logged, revocable at once, and can expire.
- "Sign out all devices" can revoke every key too, since a stolen browser cookie could have made one.
- Keys are sent as `Authorization: Bearer` or `X-Api-Key`, never in a URL.

**What a key may do:**
- Each key has scopes (read, chat, approve, files, git), project folders, permission modes, tools and limits, checked on every call.
- Sessions outside its projects look like they don't exist. The folder each session works in now is what counts.
- Auto and Bypass modes are only for keys with every project.

**Limited keys:**
- They never write into a session they didn't start, or one open on the computer; they answer in their own copy.
- Their `readOnly`/`none` tools come with `--strict-mcp-config`, so your MCP servers aren't reachable through them.

**Protected files:** processes the API starts get `--settings` rules that deny Claude's file tools Handoff's `.env` and `data/`, Claude's `.credentials.json` and the session inboxes. A Bash command still needs your Allow in "Ask me" mode. Auto and Bypass keys can do anything you can on the computer.

**Attachments and @mentions:**
- An `@path` outside the session's folder is refused, as Claude Code would read it into the prompt.
- Uploads are type- and size-checked and kept in a git-ignored `.handoff-uploads/`.
- Uploads are never written through a link or an existing file. Cleanup deletes only files Handoff named.
- Nothing is fetched from URLs.

**Webhooks:** HTTPS only, no redirects followed. Every resolved address is checked at connect time, so no address on this computer or a private network can be reached. Calls are signed with the key's webhook secret.

**Limits:**
- Each key has its own rate limit. Wrong keys are throttled per address, never for everyone.
- CORS is off unless you list sites.
- Cookies count for nothing on `/api/v1`, so there's no CSRF.
- Every call is in the audit log with the key's name.

**The Swagger page** (`/api/v1/docs`) and `/api/v1/openapi.json` are public, as no secrets are in them. The page loads Swagger UI from jsDelivr at a fixed version, under its own Content-Security-Policy.

## Secrets at rest

| Secret | Where | If it leaks |
|---|---|---|
| Password hash, 2FA secret | `.env` | Run `npm run setup` again. |
| Cloudflare tunnel run token | `.env` | Delete the tunnel in Cloudflare, then run `npm run setup:domain` again. |
| WhatsApp shared token | `.env` | Run `npm run setup:whatsapp` again, then `docker compose up -d`. |
| WhatsApp linked-device keys | Docker volume `wa-auth` | Remove the linked device on the phone; `docker compose down -v`. |
| Cloudflare API token | **never stored** | Delete it in Cloudflare after setup. |
| API keys | only their SHA-256, in `data/api-keys.json` | Revoke the key (web app or `node scripts/api-key.js revoke`). |
| Webhook secrets | `data/api-keys.json` | Revoke the key and make a new one. |

`.env` and `data/` are git-ignored. Don't commit them, paste them into issues, or include them in screenshots.

## Audit log

`data/audit.log` records sign-ins (successful, failed and blocked, and whether Remember me was ticked), prompts sent, approvals, interrupts, stops, files opened in the Files tab and WhatsApp tests, with the client IP from Cloudflare's `CF-Connecting-IP` header.

- It includes the first 200 characters of each prompt and typed answer. Set `HANDOFF_AUDIT_TEXT=false` to keep only who did what and when.
- Past 5 MB it becomes `audit.log.1`, replacing the previous one; `server.log` works the same way.
- Phone numbers are masked in the logs (`+92••••••4567`), in Handoff's and in the WhatsApp sender's.

## Reporting a vulnerability

Please report security issues privately to the maintainer instead of opening a public issue.
