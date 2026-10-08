# Ambient NPC Mining

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Ambient NPC Mining occasionally adds temporary NPC mining fleets to solar
systems with active players. It uses EveJS's native mining-fleet service for
fleet behavior and only controls when a new ambient fleet is requested.

## Features

- Checks active player systems every five minutes by default.
- Gives each eligible system a 15% chance of receiving a fleet per check.
- Uses EveJS's normal security-band mining groups and hauler behavior.
- Limits traffic to one fleet per system and ten fleets across the server.
- Waits 45 minutes after a fleet ends before trying that system again.
- Clears all ambient fleets on server restart.
- Works independently from Ambient NPC Traffic and NPC Mining Wing.

Ambient fleets are not player property, do not create market orders, and do not
write permanent fleet state to the database.

## Requirements

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy `ambientNpcMining` into the EveJS `mods` directory.
2. Keep the manifest at `mods/ambientNpcMining/evejs-launcher.mod.json`.
3. Enable **Ambient NPC Mining** in the EveJS Launcher.
4. Restart the **Game server**.

The existing `/npcminer` command remains available for manual testing. It is
separate from the automatic chance rolls in this mod.

## Configuration

Edit this file while the Game server is stopped, then restart the server:

```text
mods/ambientNpcMining/config/mining.json
```

Common settings:

- `enabled`: turns the service on or off.
- `tickIntervalMs`: delay between system checks; default is five minutes.
- `initialDelayMs`: delay before the first check after startup.
- `spawnChance`: per-system chance from `0` to `1`; default is `0.15`.
- `respawnCooldownMs`: quiet period after a fleet ends; default is 45 minutes.
- `maxFleetsPerSystem` and `maxFleetsGlobal`: fleet safety limits.
- `minerCommandQuery`: optional native mining profile, pool, or group query.
- `allowedSystemIDs`: optional numeric allow-list; empty allows all active systems.

The mod does not modify EveJS source, NPC profile data, NPC Mining Wing,
Ambient NPC Traffic, or permanent player records.

## Removal

Disable the mod in the Launcher and restart the Game server. Ambient fleets are
temporary, so no database cleanup is required.

## License and maintenance

Released under the [MIT License](LICENSE).

If this project becomes unmaintained, you may modify it and release your own
version. Keep credit to the original author, **Troublesum**, in the
documentation and source distribution.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
