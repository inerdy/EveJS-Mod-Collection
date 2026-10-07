# EveJS Mod Collection

This repository is a collection of independent mods for EveJS `0.12.9`.
Each folder is a separate package with its own launcher manifest, README,
configuration files, and version number. Install only the mods you want; the
collection does not require every mod to be enabled.

The root README covers installation and general use. Detailed feature guides,
configuration references, screenshots, and troubleshooting for each mod will
be added to the GitHub wiki.

## Requirements

- EveJS `0.12.9`.
- EveJS Launcher `1.0.69` or newer: [download the launcher](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69).
- A compatible EveJS client build configured for the local server.

Backend support is declared in each mod's `evejs-launcher.mod.json` file. Most
mods in this collection are native-only. Check the manifest before using a mod
with Docker; a native-only mod will not run in a Docker backend.

## Installation

1. Stop the EveJS game server.
2. Download or clone this repository.
3. Copy the mod folders you want into the EveJS installation's `mods` folder.
   The final layout should look like this:

   ```text
   EveJS/
   └── mods/
       ├── npcMiningWing/
       │   ├── evejs-launcher.mod.json
       │   ├── README.md
       │   └── ...
       └── anotherMod/
   ```

4. Keep each `evejs-launcher.mod.json` directly inside its mod folder. Do not
   copy only the loader file or place the manifest one directory deeper.
5. Open the EveJS Launcher and let it discover the packages.
6. Enable the mods you want. The launcher uses each manifest to check the
   EveJS version, backend, and activation method.
7. Start the game server again.

The server must be restarted after installing, updating, enabling, disabling,
or changing a server-side mod. Client-menu mods may also require restarting the
EVE client before their menu entry appears.

## Configuration

Not every mod has a configuration file. When one exists, it is normally under
the mod's `config/` directory. For example:

```text
mods/<mod-name>/config/<settings-file>.json
```

Read the README inside the individual mod folder before editing its settings.
Use valid JSON and restart the game server after changing server-side options.
Some mods store persistent data in the EveJS database; their individual
documentation will call this out before installation or removal.

## Updating or removing a mod

1. Stop the EveJS game server.
2. Replace the old mod folder with the new version, or remove it if you no
   longer want the mod.
3. Reopen the launcher and enable or disable the package as needed.
4. Start the game server.

Keep a backup of the mod's configuration and server data before removing a mod
that changes the database.

## Included packages

The available packages are listed in this directory. They include NPC
activity, mining, courier contracts, market behavior, ship utilities, starter
content, progression, station storage, client utilities, and temporary EveJS
patches. Each package is independent and has its own version and compatibility
manifest.

For a complete description of a specific package, open its `README.md`. The
GitHub wiki will later provide a central feature reference and installation
notes for every mod.
