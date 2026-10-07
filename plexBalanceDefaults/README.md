# PLEX Balance Defaults

PLEX Balance Defaults keeps the PLEX starting amount at **100** without
editing the EveJS source tree.

Release: `0.1.0`
Compatibility: EveJS `0.12.9`, native backend, EveJS Launcher manifest schema
version 3.

## What it does

On Game server startup it:

- sets every existing character wallet to 100 PLEX;
- gives new characters 100 PLEX;
- stores a migration marker so a later earned, spent, or purchased balance is
  not reset on a future restart; and
- mirrors the wallet-authority projection back into character login state so a
  spent balance is not replaced by the starting default after relogging; and
- keeps the persisted character wallet as the source used after relogging.

PLEX is stored per character in EveJS, so “account balance” here means the
characters belonging to that account. The existing-character migration is
intentional: every current character is initialized to exactly 100 PLEX.

The initialization runs once per character. After the migration marker is
written, the mod does not reset that character's balance when the server or
client restarts.

This mod does not create a PLEX reward system, change store prices, or grant
PLEX on every login.

## Installation

Install `mods/plexBalanceDefaults` through the EveJS Launcher, enable it, and
restart the **Game server**. Existing characters are migrated once during that
restart; new characters receive 100 PLEX at creation.

This is a native-only EveJS mod. Docker deployments are not supported.

For a GitHub release, download the versioned ZIP from the repository's
**Releases** page and extract the `plexBalanceDefaults` folder directly under
the EveJS `mods` directory. The manifest must remain at:

```text
mods/plexBalanceDefaults/evejs-launcher.mod.json
```

Do not extract it into an extra nested directory. Back up the GameStore data
before enabling the mod, especially when installing it on an existing save.

## Updating and removal

Stop the Game server before replacing the mod folder. Keep the existing
manifest directory name, enable the updated version in the Launcher, and
restart the Game server.

To remove the mod, disable it in the Launcher and restart the Game server.
Existing balances and migration markers remain in the GameStore; disabling
the mod does not roll them back.

## Validation

From the mod directory, run:

```powershell
node test/validate.js
```

The validation is self-contained and does not require a running server.

## License

Released under the MIT License. See [LICENSE](LICENSE).
