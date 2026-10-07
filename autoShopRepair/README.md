[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# Auto Shop Repair

Auto Shop Repair automatically repairs the active ship, its fitted modules,
and drones stored in its drone bay after a successful docking at an NPC
station. It uses EveJS's normal station repair pricing and settlement,
including the regular ISK check.

## Features

- Repairs the active ship, fitted modules, and active ship drone-bay drones
  after docking at an NPC station.
- Uses the native repair price and payment system.
- Skips the repair without charging when the character lacks sufficient ISK.
- Enables the feature per character by default.
- Provides an in-game Mods menu toggle and completion or failure notices.
- Applies only to future dockings; it does not repair ships already in station.
- Does not repair cargo, charges, or ships in structures.

## Requirements

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer
- Native backend only. Docker deployments are not supported.

## Installation

Copy this folder to the EveJS `mods` directory:

```text
<EveJS root>/mods/autoShopRepair
```

Enable `Auto Shop Repair` in the EveJS Launcher, restart the **Game server**,
and reconnect the client. Open **Mods > Auto Shop Repair** to change the
setting.

## Settings and storage

There is no separate configuration file. The per-character setting is stored at:

```text
<EveJS data root>/gameStore/autoShopRepair/state.json
```

The feature defaults to enabled for new characters. Use the in-game Mods menu
to disable or re-enable it. The mod keeps only this preference; repair costs,
damage, and item changes continue to use EveJS's native station repair service.

## Removal

Disable the mod in the Launcher and restart the Game server. The saved toggle
state can remain in `gameStore/autoShopRepair`; delete it only if you want to
reset all character preferences.

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
