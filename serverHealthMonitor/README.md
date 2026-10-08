# Server Health Monitor

Server Health Monitor is a native-only EveJS mod that shows whether the game server is healthy, degraded, or stalled.

It samples the Node event loop and the native space-runtime tick summary. The in-game window displays current and peak lag, average and worst tick duration, event-loop delay, heartbeat age, and a short rolling history. It does not record every tick to disk.

## Installation

Copy this directory into the EveJS `mods` directory, enable **Server Health Monitor** in the EveJS Launcher, and restart the game server.

Docker deployments are not supported. This mod targets EveJS `0.12.9` with the native backend.

Open **Server Health Monitor** from the in-game Mods window. The window refreshes every two seconds and keeps up to five minutes of live samples in memory.

This tool is GM-only. The client hides the Mods entry for ordinary characters, and the server rejects health-data requests unless the session carries a GM or administrator role.

## Configuration

Edit `config/health-monitor.json` while the game server is stopped, then restart the server.

- `sampleIntervalMs` controls sampling frequency.
- `historyMinutes` controls the rolling dashboard history from one to five minutes.
- `thresholds` controls when event-loop delay or runtime ticks become degraded or stalled.
- `logging.enabled` controls incident logging.
- `logging.maxBytes` limits the active log file before it is rotated to `.1`.

## Incident log

When the status changes to degraded or stalled, the mod writes one JSON line to:

```text
<EVEJS data root>/serverHealthMonitor/health-events.jsonl
```

When the server returns to healthy, it writes a recovery record with the incident duration. Each record includes timestamps, lag, event-loop delay, tick duration, CPU, memory, scene count, and active sessions when available.

The monitor keeps logging transition-based events only, so normal operation does not produce a large log stream.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

Troublesum is the original author. Others may modify or re-release the mod if it becomes unmaintained, provided credit to Troublesum is retained.

This README and the source include an AI-use disclosure because portions of the implementation and documentation were prepared with AI assistance and reviewed for this project.
