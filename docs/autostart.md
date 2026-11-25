# Start automatically

Handoff is a normal Node.js process: `node src/index.js`, the same as `npm start`. It starts the parts turned on in `.env` (the web app, WhatsApp alerts, or both; see [Choosing what to run](services.md)), so the autostart task needs no options: change `.env` and restart it. It reads `.env` from its own folder, so the working directory doesn't matter. `--log-file` sends its output to `data/server.log` instead of the console.

## Windows (tested)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 install
```

(`-WhatsAppOnly`, from before parts could be turned on one by one, still works: it runs Handoff with the web app off whatever `.env` says, and logs to `data\whatsapp-only.log`.)

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

## Linux and macOS

```bash
sh scripts/autostart.sh install
```

```bash
sh scripts/autostart.sh start
```

(`install --whatsapp-only`, from before parts could be turned on one by one, still works: it runs Handoff with the web app off whatever `.env` says.)

- **Linux:** a systemd user service, `~/.config/systemd/user/handoff.service`. To keep it running while you're logged out, also run `loginctl enable-linger "$USER"`. Logs: `data/server.log`, or `journalctl --user -u handoff`.
- **macOS:** a launchd agent, `~/Library/LaunchAgents/com.handoff.handoff.plist`.

Both start Handoff at every login and restart it if it stops. They use the `node` and `PATH` you have when you run `install`, so `claude` and `cloudflared` are found; run `install` again if those move.

The same commands as on Windows:

| Command | What it does |
|---|---|
| `sh scripts/autostart.sh start` | Starts Handoff (and keeps it starting at login). |
| `sh scripts/autostart.sh stop` | Ends Handoff and everything it started, and keeps it off, also after the next login, until `start`. |
| `sh scripts/autostart.sh restart` | Stop, then start. Use it after editing `.env` or pulling new code. |
| `sh scripts/autostart.sh status` | Shows whether it's set up and running, and the current address. |
| `sh scripts/autostart.sh uninstall` | Stops Handoff and removes the service. |

`HANDOFF_SERVICE_NAME=other sh scripts/autostart.sh install` installs a second copy under another name.

All three scripts (Windows, Linux, macOS) are run for real on every change by the project's CI: install, start, stop (it must stay off), start, restart and uninstall, checking after each step that the server answers or doesn't.

## The WhatsApp sender

The Docker container has `restart: unless-stopped`, so it comes back whenever Docker starts. Set Docker Desktop to start when you sign in.
