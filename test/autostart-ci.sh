#!/bin/sh
# Runs scripts/autostart.sh for real (CI on Linux and macOS): every command, checking the server
# answers, or doesn't, after each one.
set -eu
cd "$(dirname "$0")/.."
health() { curl -fsS --max-time 2 http://127.0.0.1:7860/api/health >/dev/null 2>&1; }
logs() { tail -n 40 data/*.log 2>/dev/null || true; }
up() { for i in $(seq 1 40); do health && return 0; sleep 1; done; echo "FAIL: not answering"; logs; exit 1; }
down() { for i in $(seq 1 20); do health || return 0; sleep 1; done; echo "FAIL: still answering"; exit 1; }
leftovers() { pgrep -f "$PWD/src/index.js" >/dev/null && { echo "FAIL: a Handoff process is still running"; exit 1; } || true; }

sh scripts/autostart.sh install
sh scripts/autostart.sh start;   up;   echo "OK: start"
sh scripts/autostart.sh status | tee /dev/stderr | grep -q "running (pid" && echo "OK: status shows it running"
sh scripts/autostart.sh stop;    down; leftovers; echo "OK: stop"
sleep 15  # longer than the restart delays: a stopped service must stay stopped
health && { echo "FAIL: it came back after stop"; exit 1; }
echo "OK: stays off"
sh scripts/autostart.sh status | grep -q "not running" && echo "OK: status shows it stopped"
sh scripts/autostart.sh start;   up;   echo "OK: start again"
sh scripts/autostart.sh restart; up;   echo "OK: restart"
sh scripts/autostart.sh uninstall; down; leftovers; echo "OK: uninstall"
sh scripts/autostart.sh status | grep -q "not installed" && echo "OK: gone"
