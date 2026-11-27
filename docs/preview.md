# App preview

See the app Claude is building from your phone. A dev server on the computer (`npm run dev` on
`localhost:3000`, a Vite app on `5173`, ...) opens on its own address, as if you were sitting at the
computer. Live reload keeps working.

## Turn it on

The preview needs a second hostname on the same Cloudflare tunnel, for example `preview.example.com`:

```
npm run setup:domain -- --preview preview.example.com
```

This adds the hostname to the tunnel and DNS (the same Cloudflare API token as before; it is not saved)
and writes `HANDOFF_PREVIEW_HOSTNAME` to `.env`. Restart Handoff. `--preview none` takes it away again.

## Use it

In a session, tap **⋯ → Preview the app** (or **Menu → Preview an app** anywhere). Handoff lists:

- ports the chat mentions (`http://localhost:5173`, ...), newest first
- web apps running on the computer right now, with their page titles
- other programs listening, folded away

Tap one, or type a port. It opens in a new tab on the preview hostname.

## How it's kept safe

- **Its own address.** The previewed app runs on the preview hostname, not on Handoff's. Its pages and
  scripts can't use your Handoff sign-in.
- **Its own sign-in.** The preview host lets nobody in by itself. Handoff hands out a link that works
  once, within 2 minutes. Opening it sets a cookie for that host only, good for 12 hours and one port.
  "Sign out all devices" ends every preview too.
- **Only what you pick.** Ports from 1024 to 65535 only, never Handoff's own ports or Docker's API (2375,
  2376). Every link handed out is in the audit log (`preview_open`).
- **Seen as local.** The dev server gets `Host: localhost:<port>`, so its host checks pass. The preview
  cookie is taken out of what it receives.

Because the app sees a normal local visit, anything it would show at the computer it shows on the phone.
Only preview apps you're developing.

## When it doesn't work

- **"Nothing is answering on port 3000"**: the dev server isn't running, or listens on another port. The
  page retries every 3 seconds, so start it (or ask Claude to) and wait.
- **Links point to `localhost:3000`**: an app that writes its own full address into pages. Redirects are
  fixed up, links inside pages aren't. Most frameworks use relative links and work as is.
- **Live reload doesn't connect**: a few tools pin the WebSocket port. For Vite, set `server.hmr.clientPort`
  to `443` while previewing.
