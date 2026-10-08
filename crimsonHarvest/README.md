# Crimson Harvest

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Crimson Harvest adds a seasonal mixed combat-site event to EveJS. It runs each
year from October 1 through November 3, using UTC boundaries.

During the event, eligible highsec, lowsec, and nullsec systems receive one
site when a player enters the system:

- 30% are public anomalies using Crimson Gauntlet or Tetrimon Base templates.
- 70% are combat signatures using Class 1, 2, or 3 Biocybernetic Incident
  templates and must be scanned before they can be warped to.

The pool is selected from a stable system-and-year hash, so a system does not
switch between public and scan-required behavior during one event. Normal EveJS
combat sites are not modified. Wormholes and Pochven are excluded.

## Features

- Creates one event site on demand per eligible system.
- Uses stable yearly public-versus-scan pool assignment.
- Sends one connection notification while the event is active.
- Uses native dungeon waves, NPCs, environments, loot, scanning, and completion handling.
- Removes expired or previous-year event sites without touching ordinary sites.

## Requirements

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy `crimsonHarvest` into the EveJS `mods` directory.
2. Keep the manifest at `mods/crimsonHarvest/evejs-launcher.mod.json`.
3. Enable **Crimson Harvest** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.

The event is created on demand as systems are entered; it does not pre-populate
every system at startup.

## Basic use

While the event is active, public anomalies appear directly in the Probe Scanner
and overview. Scan-required sites must be resolved with combat probes before
they can be warped to. Each eligible system receives at most one event site.

## Scope and limitations

The current mod does not add Criterion of Fitness, Hollow Outbreak, Pochven
wormholes, hacking sites, or the current live-event reward track. The
connection notification is sent once per connection while the event is active.

## Removal

Disable the mod in the Launcher and restart the Game server. Expired event
instances are cleaned up by the mod; ordinary combat sites are not changed.

## License and maintenance

Released under the [MIT License](LICENSE). If this project becomes unmaintained,
you may modify and re-release it as long as credit to the original author,
**Troublesum**, remains in the documentation and source distribution.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
