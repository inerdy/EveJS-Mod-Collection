# Starter Region Asteroid Belts

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Starter Region Asteroid Belts adds one deterministic, warpable asteroid belt to
every solar system in region 10001004. The region contains 53 systems and has
no static asteroid-belt records in the bundled EveJS data.

The mod merges its belt records into EveJS's existing asteroid generator,
static scene data, solar-system map data, and client location lookup. It does
not edit the EveJS server source, static game-store data, existing mods, or
server configuration files.

Custom belt IDs use a reserved range below the signed 32-bit boundary. This is
intentional: the legacy EVE client handles overview entity IDs as 64-bit values,
but its context-menu and solar-system map paths expect positive signed 32-bit
location IDs.

## Features

- Uses the standard high-security ore pool and empire_highsec_standard field style.
- Creates one belt per target system with a stable ID, seed, name, and deterministic position around the first available non-sun planet.
- Generates real mineable asteroid entities through the native asteroid field service.
- Persists mined quantities through normal EveJS mining runtime state.
- Follows the existing asteroidBeltStartupReset behavior: depleted belts repopulate after a Game server restart or downtime, not on a real-time timer.
- Does not add a Launcher settings page or an in-game Mods-menu window.

## Requirements

- Native EveJS 0.12.9
- EveJS Launcher 1.0.69 or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy starterRegionBelts into the EveJS mods directory.
2. Keep the manifest at mods/starterRegionBelts/evejs-launcher.mod.json.
3. Enable **Starter Region Asteroid Belts** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.

In a target system, open the solar-system map or overview and look for
the system name followed by `- Starter Asteroid Belt`. It is a normal warpable asteroid belt
and its generated rocks can be mined by player ships, NPC Mining Wing ships,
and the native mining runtime.

## Configuration

Edit mods/starterRegionBelts/config/belts.json while the Game server is stopped,
then restart the Game server.

- regionID: region where the belts are created.
- expectedSystemCount: safety check for the number of systems in the region.
- beltIDBase: starting ID for generated belts; keep it in the reserved custom-ID range.
- fieldStyleID: native asteroid field style to use.
- asteroidCount and clusterCount: number and grouping of asteroids in each belt.
- fieldRadiusMeters, clusterRadiusMeters, and verticalSpreadMeters: control the belt's physical layout.
- largeAsteroidCount: number of large asteroids per belt.
- placementDistanceMeters: distance from the system's reference planet.
- itemNameSuffix: text appended to the system name in the belt's label.

Changing regionID or expectedSystemCount can make safety validation fail if the
values do not describe the selected region. Depleted belts follow the native
startup reset behavior and repopulate after a restart or downtime.

## Removal

Close the client, disable the mod in the Launcher, restart the Game server, and
reconnect. Existing EveJS belts, server source, static data, and other mods are
not modified. Persisted mining rows for the reserved custom belt IDs are
harmless after removal because no custom belt records are injected.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

If the project becomes unmaintained, you may continue working on it, modify it,
and release your own version. Keep credit to the original author, **Troublesum**,
in the documentation and source distribution.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
