# Ambient NPC Traffic

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Ambient NPC Traffic adds temporary cosmetic ship traffic to occupied solar
systems. It uses native EveJS NPC profiles to make stations, gates, and planets
feel active without changing the economy or player data.

## Features

- Spawns shuttles and industrial ships near stations, gates, and planets.
- Moves ships between local anchors and occasionally across system gates.
- Removes traffic from systems with no players and restores it when they return.
- Keeps all traffic temporary and in memory. A server restart clears it.
- Does not trade, mine, fight, create missions, carry player cargo, or belong to players.

Default limits are four ships per active system, eight per system, and 100
across the server. New systems start with three ships, then replacements arrive
over time.

## Requirements

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy `ambientNpcTraffic` into the EveJS `mods` directory.
2. Keep the manifest at `mods/ambientNpcTraffic/evejs-launcher.mod.json`.
3. Enable **Ambient NPC Traffic** in the EveJS Launcher.
4. Restart the **Game server**.

## Configuration

Edit this file while the Game server is stopped, then restart the server:

```text
mods/ambientNpcTraffic/config/traffic.json
```

Common settings:

- `enabled`: turns the service on or off.
- `shipsPerActiveSystem`: normal target population.
- `maxShipsPerSystem` and `maxShipsGlobal`: safety limits.
- `spawnIntervalMs`: delay between replacement spawns.
- `shipLifetimeMs`: maximum route lifetime.
- `virtualTravelMs`: off-screen travel delay.
- `crossSystemChance`: chance of a stargate handoff.
- `profileIDs`: native NPC profiles used for ship variety.

The mod does not modify databases, static data, market data, player records, or
the NPC Market and NPC Mining Wing mods.

## Removal

Disable the mod in the Launcher and restart the Game server. No database
cleanup is required because traffic is temporary.

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
