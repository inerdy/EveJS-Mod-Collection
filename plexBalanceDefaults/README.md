# PLEX Balance Defaults

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

PLEX Balance Defaults keeps the PLEX starting amount at 100 without editing
the EveJS source tree.

## Features

On Game server startup it:

- Sets every existing character wallet to 100 PLEX.
- Gives new characters 100 PLEX.
- Stores a migration marker so a later earned, spent, or purchased balance is
  not reset on a future restart.
- Mirrors the wallet-authority projection back into character login state so a
  spent balance is not replaced by the starting default after relogging.
- Keeps the persisted character wallet as the source used after relogging.

PLEX is stored per character in EveJS, so “account balance” here means the
characters belonging to that account. The existing-character migration is
intentional: every current character is initialized to exactly 100 PLEX.

The initialization runs once per character. After the migration marker is
written, the mod does not reset that character's balance when the server or
client restarts.

This mod does not create a PLEX reward system, change store prices, or grant
PLEX on every login.

## Requirements

- Native EveJS 0.12.9
- [EveJS Launcher 1.0.69](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy plexBalanceDefaults into the EveJS mods directory.
2. Keep the manifest at mods/plexBalanceDefaults/evejs-launcher.mod.json.
3. Enable **PLEX Balance Defaults** in the EveJS Launcher.
4. Restart the **Game server**.

Existing characters are migrated once during that restart; new characters
receive 100 PLEX at creation. Back up the GameStore data before enabling the
mod on an existing save.

## Updating and removal

Stop the Game server before replacing the mod folder. Keep the existing
manifest directory name, enable the updated version in the Launcher, and
restart the Game server.

To remove the mod, disable it in the Launcher and restart the Game server.
Existing balances and migration markers remain in the GameStore; disabling the
mod does not roll them back.

## Validation

From the mod directory, run:

```powershell
node test/validate.js
```

The validation is self-contained and does not require a running server.

## License and maintenance

Released under the [MIT License](LICENSE).

If this project becomes unmaintained, you may continue working on it, modify
it, and release your own version. Keep credit to the original author,
**Troublesum**, in the documentation and source distribution.
