# System Clock 0.3.0

System Clock is a small native-only EveJS Launcher mod that displays the
player's local computer time in a movable native EVE window.

The mod is intentionally client-only. It does not modify EveJS source files,
install a Node module hook, change gameplay, write server settings, or modify
the EVE client archive. The Launcher delivers `client/menu.py` transiently
through the login handshake.

## Requirements

- EveJS 0.12.9
- Native EveJS backend
- EVE client build 3396210 / Python 2.7
- EveJS Launcher 1.0.69 or newer

## Use

1. Add the mod ZIP in EveJS Launcher under Mods.
2. Enable **System Clock**.
3. Restart the game server and reconnect the client.
4. Open the shared in-game **Mods** menu and select **System Clock**.

The entry toggles the window. Move it like any other EVE window. The clock uses
local computer time in `h:MM:SS AM/PM` format and refreshes once per second.

## Removal

Disable or remove the mod in EveJS Launcher, restart the game server, and
reconnect the client. No client archive restoration is required.

## Compatibility behavior

The shared menu registration is scoped to the current character session. The
window, timer, and registration are disposed on
logout, character change, reconnect, or client-side replacement, so reconnecting
creates one fresh registration without duplicate windows or timers.

## GitHub installation

Clone this repository into the EveJS `mods` directory, enable it in the EveJS
Launcher, and restart the Game server:

```powershell
git clone <repository-url> mods/systemClock
```

Replace `<repository-url>` with the GitHub URL for this project. To update an
existing checkout, run `git pull` from `mods/systemClock`. Keep
`evejs-launcher.mod.json` directly inside that directory.

This is a native-only EveJS mod. Docker deployments are not supported.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

If the project becomes unmaintained, you may continue working on it, modify
it, and release your own version. Please keep the original author credit to
**Troublesum** in the documentation and source distribution.

## What this mod is

System Clock is a client-only native EveJS mod that displays the player's local
computer time in a movable in-game window. It does not change gameplay or edit
the EVE client archive.
