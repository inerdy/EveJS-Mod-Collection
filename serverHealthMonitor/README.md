# Server Health Monitor

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Server Health Monitor shows whether the game server is healthy, degraded,
stalled, or briefly changing systems.

It samples the Node event loop and the native space-runtime tick summary. The
in-game window displays current and peak lag, average and worst tick duration,
event-loop delay, heartbeat age, a short rolling history, and a separate Scene
Diagnostics tab. The diagnostics tab lists loaded systems, sessions, total
entities, NPCs, ships, drones, wrecks, and containers. It does not record every
tick to disk.

## Features

- Shows Healthy, Degraded, Stalled, and Transition states.
- Displays current and peak lag, tick timing, event-loop delay, and heartbeat age.
- Keeps a one-to-five-minute live history in the in-game window.
- Logs status changes and recovery durations to JSONL.
- Provides a GM-only Scene Diagnostics tab.
- Tracks loaded scenes, sessions, dynamic entities, wrecks, and containers.

The client hides the Mods entry for ordinary characters, and the server rejects
health-data requests unless the session carries a GM or administrator role.

## Requirements

- Native EveJS 0.12.9
- [EveJS Launcher 1.0.69](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy serverHealthMonitor into the EveJS mods directory.
2. Keep the manifest at mods/serverHealthMonitor/evejs-launcher.mod.json.
3. Enable **Server Health Monitor** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.
5. Open **Server Health Monitor** from the in-game Mods window.

The window refreshes every two seconds and keeps up to five minutes of live
samples in memory.

## Configuration

Edit config/health-monitor.json while the Game server is stopped, then restart
the server.

- sampleIntervalMs controls sampling frequency.
- historyMinutes controls the rolling dashboard history from one to five minutes.
- transitionGraceMs controls how long a successful stargate jump is shown as
  TRANSITION; the default is 3,000 ms.
- thresholds controls when event-loop delay or runtime ticks become degraded or stalled.
- logging.enabled controls incident logging.
- logging.maxBytes limits the active log file before it is rotated to .1.

## Incident log

When the status changes to degraded or stalled, the mod writes one JSON line to:

```text
<EveJS data root>/serverHealthMonitor/health-events.jsonl
```

When the server returns to healthy, it writes a recovery record with the
incident duration. Each record includes timestamps, lag, event-loop delay, tick
duration, CPU, memory, scene count, and active sessions when available.

The monitor keeps logging status changes only, so normal operation does not
produce a large log stream. A normal gate jump may produce a short transition
and recovery pair. If the measured delay remains above the configured stalled
threshold after the grace window, it is recorded as stalled.

## Scene diagnostics

The Scene Diagnostics tab is GM-only, like the rest of the monitor. It is
intended to show whether a lag spike correlates with a large combat scene or a
growing number of wrecks and other dynamic entities.

## Removal

Disable the mod in the Launcher and restart the Game server. Existing health
logs can remain in the data root or be archived separately.

## License and maintenance

This project is released under the [MIT License](LICENSE).

Troublesum is the original author. Others may modify or re-release the mod if it
becomes unmaintained, provided credit to Troublesum is retained.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
