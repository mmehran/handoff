# Setup: quick tunnel (random URL)

The fastest way to get going: free, with no Cloudflare account and no domain. Cloudflare gives you a random address like `https://plain-river-lamp.trycloudflare.com`.

**Trade-off:** the address changes every time Handoff (or the tunnel) restarts. Check `data/public-url.txt` for the current one. When you want an address that never changes, follow [your own domain](setup-own-domain.md) instead.

## 1. Requirements

- **Node.js 20 or newer:** `node -v`
- **Claude Code CLI**, installed and signed in:
  ```bash
  claude --version
  claude auth login
  ```
  Claude Desktop has its own login. Handoff starts the `claude` CLI, so the CLI needs to be signed in too. Alternatively, run `claude setup-token` and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`; it's then used only for sessions that Handoff starts.
- **cloudflared:**
  ```bash
  winget install --id Cloudflare.cloudflared    # Windows
  ```
  ```bash
  brew install cloudflared                      # macOS
  ```
  For Linux, use the packages on the [cloudflared releases page](https://github.com/cloudflare/cloudflared/releases). If you just installed it, open a new terminal so it's on your PATH. Handoff also checks the usual install folders on Windows.

## 2. Install and set a password

```bash
git clone https://github.com/mmehran/handoff.git
cd handoff
npm run setup
```

`npm run setup` creates `.env` from `.env.example`, then:
1. asks for a password (12+ characters; it's typed hidden), or generates one if you just press Enter
2. offers 2FA. **Say yes.** Your server will be on the internet. Add the key it shows to Google Authenticator, Microsoft Authenticator, Authy or 1Password, then type the 6-digit code to confirm.

Only a scrypt hash of the password and the 2FA secret are saved, in `.env`. Running `npm run setup` again replaces them and signs out every device.

## 3. Choose the quick tunnel

`.env.example` already has this, so check that `.env` says:

```ini
HANDOFF_TUNNEL=quick
```

## 4. Start

```bash
npm start
```

You'll see something like:

```
Handoff listening on http://127.0.0.1:7860
claude CLI: C:\Users\you\.local\bin\claude.exe   2FA: on
[tunnel] starting cloudflared -> http://127.0.0.1:7860

  Public URL (cloudflared): https://plain-river-lamp.trycloudflare.com
  Open it on your phone and sign in.
```

Open that address on your phone, sign in with your password and 2FA code, and use **Add to Home Screen** to install it like an app.

## Good to know

- **Current address:** `data/public-url.txt`. The file is deleted while the tunnel reconnects and rewritten with the new address.
- **Reconnects by itself:** if the tunnel drops (Wi-Fi change, sleep, Cloudflare expiring it), Handoff starts a new one. It waits 30 s first, then longer between tries, up to 10 min. The new tunnel has a new address.
- **Live updates:** quick tunnels buffer event streams, so the page switches to polling every 2 s. The dot in the top bar turns yellow when that happens. Everything still works. A named tunnel on your own domain doesn't have this problem.
- **ngrok instead:** install ngrok, run `ngrok config add-authtoken <token>` once, and set `HANDOFF_TUNNEL=ngrok`.
- **Start at logon:** see [autostart](autostart.md).
- **WhatsApp alerts:** see [WhatsApp notifications](whatsapp.md). Each message includes a link only if `HANDOFF_PUBLIC_HOSTNAME` is set, and a quick tunnel has no fixed hostname, so with a quick tunnel the messages come without links.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No password configured` | Run `npm run setup`. |
| `neither cloudflared nor ngrok found` | Install cloudflared and open a new terminal. |
| Sign-in works but prompts fail with a login error | Run `claude auth login`, or set `CLAUDE_CODE_OAUTH_TOKEN`. |
| Address stopped working | It changed. Check `data/public-url.txt` or the console. |
| `Too many attempts` | Login throttling: wait 15 minutes. |
