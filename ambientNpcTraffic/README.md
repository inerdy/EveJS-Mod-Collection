# Ambient NPC Traffic

[![EveJS 261018.1](https://img.shields.io/badge/EveJS-261018.1-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Ambient NPC Traffic adds temporary cosmetic ship traffic to occupied solar
systems. It uses native EveJS NPC profiles to make stations, gates, and planets
feel active without changing the economy or player data.

## Features

- Spawns industrial haulers near stations, gates, and planets.
- Haulers turn and accelerate to warp speed before they enter warp.
- Each hauler carries either common high-sec minerals or P0/P1 planetary goods, never both. Mineral loads use one or two types. Time-limited items are not used. After the wreck appears, that cargo is placed in it.
- Moves ships between local anchors and occasionally across system gates.
- Gate trips stay on the line back toward where the ship warped from. A 15 km approach exits 1–2 km inside that point, and a jump exits somewhere in the 1–2 km band.
- A ship appears with the decloak effect. Gate jumps play jump-out on the ship, aimed at the gate. Arrival plays jump-in, then the ship waits before warping off.
- A warping ship leaves the overview once it is more than 500,000 km from the observer.
- A warp scramble or a warp bubble stops the ship from warping. A disruptor stops it unless that ship rolled a warp core stabilizer.
- Removes traffic from systems with no players and restores it when they return.
- Keeps all traffic temporary and in memory. A server restart clears it.
- Does not trade, mine, fight, create missions, carry player cargo, or belong to players.

Default limits are four ships per active system, eight per system, and 100
across the server. New systems start with three ships, then replacements arrive
over time.

## Requirements

- Native EveJS `261018.1` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
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
- `gateApproachDistanceMeters`: standoff used when a ship warps to a gate and approaches.
- `gateExitDelayMs`: how long a ship waits after jumping before it warps again.
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
