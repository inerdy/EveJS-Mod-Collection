# System Clock

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

System Clock is a small native-only EveJS Launcher mod that displays the
player's local computer time in a movable native EVE window.

The mod is intentionally client-only. It does not modify EveJS source files,
install a Node module hook, change gameplay, write server settings, or modify
the EVE client archive. The Launcher delivers client/menu.py transiently
through the login handshake.

## Features

- Displays local computer time in h:MM:SS AM/PM format.
- Refreshes the clock once per second.
- Uses a movable native EVE window.
- Scopes the registration to the current character session.
- Disposes the window, timer, and registration on logout, character change,
  reconnect, or client-side replacement.

## Requirements

- EveJS 0.12.9
- Native EveJS backend
- EveJS Launcher 1.0.69 or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Add the mod ZIP in EveJS Launcher under Mods.
2. Enable **System Clock**.
3. Restart the **Game server** and reconnect the client.
4. Open the shared in-game **Mods** menu and select **System Clock**.

## Basic use

The entry toggles the window. Move it like any other EVE window. The clock uses
the local computer time configured by the operating system.

## Removal

Disable or remove the mod in EveJS Launcher, restart the Game server, and
reconnect the client. No client archive restoration is required.

## GitHub installation

Clone this repository into the EveJS mods directory, enable it in the EveJS
Launcher, and restart the Game server:

```powershell
git clone <repository-url> mods/systemClock
```

Replace <repository-url> with the GitHub URL for this project. To update an
existing checkout, run git pull from mods/systemClock. Keep
evejs-launcher.mod.json directly inside that directory.

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
