#!/bin/sh
# Start Handoff automatically on Linux (systemd user service) or macOS (launchd agent), and manage it.
# The same commands as scripts\autostart.ps1 on Windows:
#
#   scripts/autostart.sh install                     set it up (starts at every login from then on)
#                                                    it runs the parts turned on in .env (see docs/services.md);
#                                                    --whatsapp-only (older setups) runs it with the web app off
#   scripts/autostart.sh start | stop | restart | status | uninstall
#
# "stop" keeps it off, also after the next login, until "start". Settings come from .env as usual;
# output goes to data/server.log (or data/whatsapp-only.log). HANDOFF_SERVICE_NAME changes the name.
set -eu

ACTION=${1:-install}
ENTRY=index.js
[ "${2:-}" = "--whatsapp-only" ] && ENTRY=whatsapp-only.js
NAME=${HANDOFF_SERVICE_NAME:-handoff}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node || true)

die() { echo "$*" >&2; exit 1; }
[ -n "$NODE" ] || die "node not found on PATH. Install Node.js 20 or newer."

address() {
  [ -f "$ROOT/data/public-url.txt" ] && echo "Address: $(head -n 1 "$ROOT/data/public-url.txt")" || true
}

case "$(uname -s)" in
Linux)
  command -v systemctl >/dev/null || die "systemctl not found: this script needs systemd."
  UNIT="$HOME/.config/systemd/user/$NAME.service"
  sc() { systemctl --user "$@"; }
  installed() { [ -f "$UNIT" ]; }
  case "$ACTION" in
  install)
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<EOF
[Unit]
Description=Handoff ($ENTRY) - remote control for Claude Code
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/src/$ENTRY --log-file
Restart=always
RestartSec=10
# the PATH from install time, so claude and cloudflared are found
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF
    sc daemon-reload
    sc enable "$NAME" >/dev/null 2>&1
    echo "Installed $UNIT. It starts at every login from now on, with the parts turned on in .env."
    echo "Start it now with: scripts/autostart.sh start"
    echo "To keep it running while you're logged out: loginctl enable-linger \"\$USER\""
    ;;
  start)   installed || die "Not installed. Run: scripts/autostart.sh install"; sc enable --now "$NAME" >/dev/null 2>&1; echo "Started." ;;
  stop)    installed || die "Not installed."; sc disable --now "$NAME" >/dev/null 2>&1; echo "Stopped. It stays off (also after login) until: scripts/autostart.sh start" ;;
  restart) installed || die "Not installed. Run: scripts/autostart.sh install"; sc enable "$NAME" >/dev/null 2>&1; sc restart "$NAME"; echo "Restarted." ;;
  status)
    if ! installed; then echo "Service: not installed"; exit 0; fi
    echo "Service: $(sc is-enabled "$NAME" 2>/dev/null || true), $(sc is-active "$NAME" 2>/dev/null || true)"
    pid=$(sc show -p MainPID --value "$NAME" 2>/dev/null || echo 0)
    if [ "${pid:-0}" != 0 ]; then echo "Process: running (pid $pid)"; address; else echo "Process: not running"; fi
    ;;
  uninstall)
    if installed; then sc disable --now "$NAME" >/dev/null 2>&1 || true; rm -f "$UNIT"; sc daemon-reload; fi
    echo "Removed $NAME."
    ;;
  *) die "usage: scripts/autostart.sh install [--whatsapp-only] | start | stop | restart | status | uninstall" ;;
  esac
  ;;

Darwin)
  LABEL="com.handoff.$NAME"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  # the GUI session normally; a user session over SSH or on a CI machine
  DOMAIN="gui/$(id -u)"; launchctl print "$DOMAIN" >/dev/null 2>&1 || DOMAIN="user/$(id -u)"
  installed() { [ -f "$PLIST" ]; }
  loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
  load() {
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
    loaded || launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  }
  unload() {
    # bootout ends Handoff and everything it started (launchd stops the whole process group)
    loaded && { launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true; }
    return 0
  }
  case "$ACTION" in
  install)
    mkdir -p "$(dirname "$PLIST")" "$ROOT/data"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/src/$ENTRY</string><string>--log-file</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$ROOT/data/launchd.log</string>
</dict>
</plist>
EOF
    plutil -lint "$PLIST" >/dev/null
    echo "Installed $PLIST. It starts at every login from now on, with the parts turned on in .env."
    echo "Start it now with: scripts/autostart.sh start"
    ;;
  start)   installed || die "Not installed. Run: scripts/autostart.sh install"; load; echo "Started." ;;
  stop)    installed || die "Not installed."; unload; launchctl disable "$DOMAIN/$LABEL" 2>/dev/null || true; echo "Stopped. It stays off (also after login) until: scripts/autostart.sh start" ;;
  restart) installed || die "Not installed. Run: scripts/autostart.sh install"; unload; sleep 1; load; echo "Restarted." ;;
  status)
    if ! installed; then echo "Agent: not installed"; exit 0; fi
    pid=$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = / { print $3; exit }')
    if [ -n "$pid" ]; then echo "Agent: loaded"; echo "Process: running (pid $pid)"; address
    elif loaded; then echo "Agent: loaded"; echo "Process: not running (restarting?)"
    else echo "Agent: installed, stopped"; echo "Process: not running"; fi
    ;;
  uninstall) unload; rm -f "$PLIST"; echo "Removed $LABEL." ;;
  *) die "usage: scripts/autostart.sh install [--whatsapp-only] | start | stop | restart | status | uninstall" ;;
  esac
  ;;

*) die "Use scripts/autostart.ps1 on Windows. This script is for Linux and macOS." ;;
esac
