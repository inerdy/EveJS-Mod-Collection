# Station Container Storage

Station Container Storage removes the practical volume limit from the exact
EVE **Station Container** type (`typeID 17366`) while it is stored in a station.
It works for personal station hangars and corporation hangar divisions.

The native inventory service still performs its normal access, role,
container-nesting, pending-structure, and used-volume checks. Other container
types and containers in space are not changed.

Install `mods/stationContainerStorage` through the EveJS Launcher, enable it,
restart the **Game server**, and reconnect the client.

## GitHub installation

Clone this repository into the EveJS `mods` directory, enable it in the EveJS
Launcher, and restart the Game server:

```powershell
git clone <repository-url> mods/stationContainerStorage
```

Replace `<repository-url>` with the GitHub URL for this project. To update an
existing checkout, run `git pull` from `mods/stationContainerStorage`. Keep
`evejs-launcher.mod.json` directly inside that directory.

This is a native-only EveJS mod. Docker deployments are not supported.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

If the project becomes unmaintained, you may continue working on it, modify
it, and release your own version. Please keep the original author credit to
**Troublesum** in the documentation and source distribution.

## What this mod is

Station Container Storage removes the practical volume limit from EVE Station
Containers while they are stored in a station. It keeps EveJS's normal access,
role, nesting, and inventory checks in place.
