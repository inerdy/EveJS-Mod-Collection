# Dungeon Respawn Cooldown

This native-only EveJS mod prevents a cleared combat anomaly from immediately
appearing again when the player leaves and returns. The default cooldown is 30
minutes.

It is separate from `tempPatches`, which is reserved for temporary EveJS bug
fixes. This mod only controls the respawn delay for cleared combat anomalies.

## Requirements

- EveJS `0.12.9`
- EveJS Launcher `1.0.69` or newer
- Native EveJS backend

Docker is not supported.

## Installation

Copy the `dungeonRespawnCooldown` folder into the EveJS installation's `mods`
directory and keep `evejs-launcher.mod.json` directly inside the folder. Enable
the mod in the EveJS Launcher, then restart the game server.

The cooldown is applied only after a combat anomaly reaches the completed state.
Generated mining sites and sites using the normal depleted-site timer are not
changed.

The cooldown is currently defined in `loader.js` as 30 minutes. A game-server
restart is required after installing, updating, enabling, or disabling the mod.
