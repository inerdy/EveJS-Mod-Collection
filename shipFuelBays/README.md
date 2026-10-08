# Ship Fuel Bays

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Ship Fuel Bays adds dedicated fuel-bay inventory capacity to ships that do not
have a native fuel bay. It uses each hull's base cargo capacity as the fuel-bay
capacity and leaves native fuel-bay ships unchanged.

This mod only adds the bay and its capacity metadata. It does not implement
fuel selection, fuel consumption, emergency refueling, market seeding, or a
client window. Those behaviors remain separate, including in the
`shipWarpFuel` mod.

## Features

- Adds the native fuel-bay attribute to eligible ship resource states.
- Uses the hull's default cargo capacity in cubic meters.
- Preserves the native fuel-bay capacity of ships that already have one.
- Uses EveJS's existing dedicated fuel-bay inventory flag.
- Patches both cached and future-loaded fitting modules.
- Keeps the change server-side and does not edit EveJS core files.

## Requirements

- Native EveJS 0.12.9
- [EveJS Launcher 1.0.69](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer
- A server-side mod that manages fuel is optional. For example,
  `shipWarpFuel` can consume fuel from the resulting bay.

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy `shipFuelBays` into the EveJS `mods` directory.
2. Keep `evejs-launcher.mod.json` directly inside the mod folder.
3. Enable **Ship Fuel Bays** in the EveJS Launcher.
4. Restart the **Game server**.

The restart is required after installation, updates, configuration changes,
and enabling or disabling the mod.

## Basic use

No in-game setup is required. Once the Game server restarts, a ship without a
native fuel bay receives a fuel bay whose capacity matches its base cargo
capacity. A hull with a native fuel bay keeps its existing capacity.

The capacity is measured in cubic meters. The number of fuel units that fit
depends on the volume of the fuel item being stored.

## Configuration

Edit `config/fuel-bays.json`:

```json
{
  "enabled": true,
  "capacityMode": "baseCargo",
  "minimumCapacityM3": 0.01
}
```

- `enabled`: enables or disables the mod.
- `capacityMode`: currently supports `baseCargo`.
- `minimumCapacityM3`: prevents zero-capacity hulls from receiving a bay.

Changes take effect after a Game server restart.

## Compatibility

This mod does not replace `shipWarpFuel` or alter its reward, burn-rate,
emergency-fuel, or market logic. It only supplies fuel-bay capacity metadata.
When both mods are enabled, `shipWarpFuel` can use the dedicated fuel-bay
inventory, while its own configured fuel-management limits remain separate.

## Removal

Disable **Ship Fuel Bays** in the EveJS Launcher and restart the Game server.
It does not delete fuel items or modify existing ship records.

## License and maintenance

Released under the [MIT License](LICENSE).

If this project becomes unmaintained, you may continue working on it, modify
it, and release your own version. Keep credit to the original author,
**Troublesum**, in the documentation and source distribution.

## AI disclosure

This mod was created with AI-assisted development and reviewed for use in the
local EveJS server environment.
