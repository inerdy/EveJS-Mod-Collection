[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# Auto Deposit Ore

Auto Deposit Ore moves mining output from the active ship into the character's
personal hangar after a successful docking operation. It handles general
mining, asteroid, gas, and ice holds while leaving ordinary cargo and fitted
equipment alone.

## Features

- Deposits mining-hold contents at the station or structure where the ship docks.
- Supports ore, gas, ice, and general mining holds.
- Enables the feature per character by default.
- Provides an in-game Mods menu toggle and chat summary after docking.
- Uses EveJS inventory custody transfers and does not bypass ownership checks.
- Leaves ordinary cargo, fittings, drones, and fuel in the ship.

## Requirements

- Native EveJS `0.12.9` — [EveJS Discord](https://discord.gg/WpYh9zpNrx)
- [EveJS Launcher `1.0.69`](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer
- Native backend only. Docker deployments are not supported.

## Installation

Copy this folder to the EveJS `mods` directory:

```text
<EveJS root>/mods/autoDepositOre
```

Enable `Auto Deposit Ore` in the EveJS Launcher, restart the **Game server**,
and reconnect the client. Open **Mods > Auto Deposit Ore** to change the
setting.

## Settings and storage

There is no separate configuration file. The per-character setting is stored at:

```text
<EveJS data root>/gameStore/autoDepositOre/state.json
```

The feature defaults to enabled for new characters. Use the in-game Mods menu
to disable or re-enable it. The state file is the only persistent data created
by this mod; no ship, cargo, market, or character inventory records are
rewritten outside the normal inventory transfer.

## Removal

Disable the mod in the Launcher and restart the Game server. The saved toggle
state can remain in `gameStore/autoDepositOre`; delete it only if you want to
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
