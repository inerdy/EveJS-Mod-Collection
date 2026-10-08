# Station Container Storage

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Station Container Storage removes the practical volume limit from the exact
EVE Station Container type, typeID 17366, while it is stored in a station. It
works for personal station hangars and corporation hangar divisions.

The native inventory service still performs its normal access, role,
container-nesting, pending-structure, and used-volume checks. Other container
types and containers in space are not changed.

## Features

- Removes the practical volume limit for station containers only.
- Supports personal station hangars and corporation hangar divisions.
- Preserves normal EveJS access, role, nesting, and inventory checks.
- Does not change other container types or containers in space.

## Requirements

- Native EveJS 0.12.9
- EveJS Launcher 1.0.69 or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy stationContainerStorage into the EveJS mods directory.
2. Keep the manifest at mods/stationContainerStorage/evejs-launcher.mod.json.
3. Enable **Station Container Storage** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.

## Basic use

Store a Station Container in a personal or corporation station hangar. The
native inventory service continues to enforce access and nesting rules while
this mod removes the practical volume restriction for that container type.

## Removal

Disable or remove the mod in the Launcher and restart the Game server. Existing
inventory data is not rewritten.

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
