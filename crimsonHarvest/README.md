[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# Crimson Harvest

Crimson Harvest adds a seasonal mixed combat-site event to EveJS. It runs each
year from October 1 through November 3, using UTC boundaries.

During the event, eligible highsec, lowsec, and nullsec systems receive one
site when a player enters the system:

- 30% are public anomalies using Crimson Gauntlet or Tetrimon Base templates.
- 70% are combat signatures using Class 1, 2, or 3 Biocybernetic Incident
  templates and must be scanned before they can be warped to.

The pool is selected from a stable system-and-year hash, so a system does not
switch between public and scan-required behavior during one event. Normal
EveJS combat sites are not modified. Wormholes and Pochven are excluded.

## Requirements and installation

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer
- Native backend only. Docker deployments are not supported.

Copy this folder to `<EveJS root>/mods/crimsonHarvest`, enable **Crimson
Harvest** in the launcher, and restart the **Game server**. The event is
created on demand as systems are entered; it does not pre-populate every system
at startup.

## Scope and limitations

Sites use EveJS's existing dungeon waves, NPCs, environments, loot, scanning,
and completion handling. The current mod does not add Criterion of Fitness,
Hollow Outbreak, Pochven wormholes, hacking sites, or the current live-event
reward track. The connection notification is sent once per connection while
the event is active.

## License and maintenance

Released under the [MIT License](LICENSE). If this project becomes unmaintained,
you may modify and re-release it as long as credit to the original author,
**Troublesum**, remains in the documentation and source distribution.

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum.
