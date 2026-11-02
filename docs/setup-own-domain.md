# Setup: your own domain on Cloudflare (permanent address)

This gives Handoff a fixed address like `https://claude.example.com`, through a named Cloudflare Tunnel. It costs nothing beyond the domain itself (Cloudflare's free plan is enough) and needs no open ports on your router.

Compared with the [quick tunnel](setup-quick-tunnel.md):
- the address never changes
- live updates stream properly, with no polling fallback
- WhatsApp messages include an **Open** link to the session
- a watchdog keeps the tunnel up through sleep, Wi-Fi changes and restarts

## 1. Requirements

- Everything from the quick-tunnel guide: Node.js 20+, the Claude Code CLI signed in, and `cloudflared` installed.
- A domain whose DNS is managed by Cloudflare. The domain must be added to your Cloudflare account and its nameservers pointed at Cloudflare.
- A subdomain to use, for example `claude.example.com`. It must not already be in use. The setup script refuses to touch existing records that aren't a tunnel.

## 2. Install and set a password

```bash
git clone https://github.com/mmehran/handoff.git
cd handoff
npm run setup        # password + 2FA, written to .env
```

## 3. Create a Cloudflare API token (temporary)

The setup script uses this token once to create the tunnel and DNS record. **It's never saved anywhere**, so you can delete it right afterwards.

1. Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**
2. Permissions:
   - **Account** → **Cloudflare Tunnel** → **Edit**
   - **Zone** → **DNS** → **Edit**
3. Account resources: your account. Zone resources: the zone (domain) you'll use.
4. Create it and copy the token.

You also need your **Account ID**, a 32-character hex string. It's shown on your domain's **Overview** page in the right-hand column, or in the dashboard URL.

## 4. Run the domain setup

```bash
npm run setup:domain
```

It asks for the hostname, the account ID, and the API token (typed hidden). You can also pass them in:

```bash
npm run setup:domain -- --hostname claude.example.com --account 0123456789abcdef0123456789abcdef
```

To skip the token prompt, set the token for this one command only.

PowerShell:

```powershell
$env:CLOUDFLARE_API_TOKEN = '<token>'; npm run setup:domain -- --hostname claude.example.com --account <account id>; Remove-Item Env:CLOUDFLARE_API_TOKEN
```

macOS / Linux (the leading space keeps it out of shell history in most setups):

```bash
 CLOUDFLARE_API_TOKEN='<token>' npm run setup:domain -- --hostname claude.example.com --account <account id>
```

The script:
1. finds the zone that owns the hostname
2. creates a tunnel named `handoff`, or reuses it if it already exists
3. routes `claude.example.com` → `http://127.0.0.1:<HANDOFF_PORT>`, and everything else on that tunnel → 404
4. adds a proxied `CNAME claude.example.com → <tunnel-id>.cfargotunnel.com`. It never overwrites a record that points somewhere else.
5. writes three values to `.env`:
   ```ini
   HANDOFF_TUNNEL=cloudflare
   HANDOFF_PUBLIC_HOSTNAME=claude.example.com
   HANDOFF_CLOUDFLARE_TUNNEL_TOKEN=<the tunnel's run token>
   ```

It's safe to run again, for example after changing `HANDOFF_PORT`. Afterwards you can delete the API token in the Cloudflare dashboard.

> The tunnel run token in `.env` lets whoever has it serve traffic for that tunnel. Keep `.env` private. If it ever leaks, delete the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels) and run `npm run setup:domain` again.

## 5. Start

```bash
npm start
```

```
Handoff listening on http://127.0.0.1:7860
  Public URL (cloudflare tunnel): https://claude.example.com
[tunnel] starting cloudflared (startup); allowing 90s to connect
[tunnel] connected to Cloudflare (lhr01) after 3s
```

Open `https://claude.example.com` on your phone, sign in, and add it to your home screen.

## The tunnel watchdog

Handoff runs `cloudflared` itself and checks on it every 5 s:

- **Starting up:** a fresh `cloudflared` gets 90 s to register its first connection. On a slow network right after waking it gets more time on each retry, up to 5 min. A `cloudflared` that is still connecting is never killed.
- **Connected:** `cloudflared` reconnects by itself after a drop. Handoff steps in only if its `/ready` check has failed continuously for 30 s.
- **`cloudflared` exited:** it's restarted after 5 s, backing off to 60 s if it keeps crashing.
- **After sleep:** a 5 s check that arrives more than 20 s late means the computer slept, so `cloudflared` is restarted at once.
- **End to end:** every 60 s, Handoff fetches `https://<hostname>/api/health` from outside and checks that the answer comes from *this* process. After 3 misses in a row it restarts `cloudflared`.

Everything is logged to the console, or to `data/server.log` with [autostart](autostart.md).

## Extra protection (optional)

You can put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the hostname, for example to allow only your email address, as a second login before Handoff's own password + 2FA. If you do, add a bypass policy for the path `/api/health`, or the end-to-end check will count every request as a miss and keep restarting the tunnel.

## Troubleshooting

| Problem | Fix |
|---|---|
| `no zone in this account covers ...` | The domain isn't in this Cloudflare account, or the account ID is wrong. |
| `already has DNS records that are not a tunnel` | Pick another subdomain, or delete that record yourself first. |
| `Authentication error` / `10000` | The token is missing a permission (Tunnel: Edit, DNS: Edit) or isn't scoped to this zone. |
| `HANDOFF_TUNNEL=cloudflare needs ...` | Run `npm run setup:domain`. |
| Works on Wi-Fi, not on mobile data (or the other way round) | DNS caching. Wait a few minutes after the first setup. |
| Error 1033 in the browser | `cloudflared` isn't connected. Check that Handoff is running and look at its log. |
