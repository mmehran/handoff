# Laptop: battery and keep awake

**Menu → Laptop** (or the 💻 button on the home page) shows the computer Handoff runs on:

- **Battery**: how full, plugged in or not, charging, and (on battery) roughly how long it lasts.
- **Sleep**: after how long idle it sleeps or hibernates by itself, how long it has been idle, and so
  how soon it would sleep. And what closing the lid does.
- The computer's name, how long it has been on, and free memory.

## Keep awake

A sleeping computer can't run Claude or answer your phone. Pick one:

| | |
|---|---|
| **Off** | The computer sleeps as its power settings say. |
| **While Claude works** | Awake while any session is busy or waiting for you (in Handoff, Claude Desktop or a terminal), and for 10 minutes after, so you have time to reply. |
| **Always** | Awake until you turn this off. |

The choice is kept across restarts (`data/laptop.json`).

It uses the system's own "busy, don't sleep" request, the one video players use: on Windows a small
helper calls `SetThreadExecutionState`, on macOS `caffeinate`, on Linux `systemd-inhibit`. No power
setting is changed, the screen can still turn off, and the helper ends with Handoff.

It stops **sleeping when idle**. Closing the lid, pressing the power button or choosing Sleep still
sleeps; the page says what the lid does. To keep working with the lid closed, change "When I close the
lid" in the computer's power settings yourself.

Sleep timers and the lid are read on Windows. On macOS and Linux the page shows the battery only.
