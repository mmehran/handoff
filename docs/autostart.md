# Start automatically

Handoff is a normal Node.js process: `node src/index.js` for the full app, or `node src/whatsapp-only.js` for WhatsApp-only mode. It reads `.env` from its own folder, so the working directory doesn't matter. `--log-file` sends its output to `data/server.log` (or `data/whatsapp-only.log`) instead of the console.

## Windows (tested)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 install
```

For WhatsApp-only mode:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 install -WhatsAppOnly
```

This registers a per-user scheduled task named **Handoff** that:
- starts 30 s after you sign in to Windows, hidden (no console window)
- runs on battery too, with no time limit
- also fires every 5 minutes as a safety net. If Handoff is already running this does nothing; if it ever stopped, Windows starts it again.

Manage it with the same script. Run these from the Handoff folder, each with `powershell -ExecutionPolicy Bypass -File` in front as above:

| Command | What it does |
|---|---|
| `scripts\autostart.ps1 start` | Starts Handoff now and re-enables the task. |
| `scripts\autostart.ps1 stop` | Disables the task, so neither the 5-minute check nor your next logon brings Handoff back, then ends Handoff and everything it started (cloudflared, any `claude` sessions it was running). It stays off until `start`. |
| `scripts\autostart.ps1 restart` | Stop, then start. Use it after editing `.env` or pulling new code. |
| `scripts\autostart.ps1 status` | Shows the task state, whether Handoff is running, and the current address. |
| `scripts\autostart.ps1 uninstall` | Stops Handoff and removes the task. |

> Don't use `Stop-ScheduledTask` on its own to stop Handoff. It only ends the hidden console window and leaves Node and cloudflared running. Even after that, the 5-minute check would start the task again.

It runs after you sign in, not at the Windows lock screen before sign-in, because Claude Code and its sessions belong to your user account. With a quick tunnel, the current address is in `data\public-url.txt`.

## Linux: systemd user service (untested)

`~/.config/systemd/user/handoff.service`:

```ini
[Unit]
Description=Handoff (remote control for Claude Code)
After=network-online.target

[Service]
WorkingDirectory=%h/handoff
ExecStart=/usr/bin/node %h/handoff/src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
```

```bash
systemctl --user enable --now handoff
```

```bash
loginctl enable-linger "$USER"     # keep it running when you're logged out
```

Logs: `journalctl --user -u handoff -f`. For WhatsApp-only mode, use `src/whatsapp-only.js` in `ExecStart`. Check the node path with `which node`.

## macOS: launchd agent (untested)

`~/Library/LaunchAgents/com.handoff.plist` (replace `/Users/you/handoff` and the node path from `which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.handoff</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/handoff/src/index.js</string>
    <string>--log-file</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/handoff</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.handoff.plist
```

`PATH` must include the folders where `claude` and `cloudflared` are installed.

## The WhatsApp sender

The Docker container has `restart: unless-stopped`, so it comes back whenever Docker starts. Set Docker Desktop to start when you sign in.
