# Dungeon Respawn Cooldown

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](#requirements)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)

Dungeon Respawn Cooldown prevents a cleared combat anomaly from immediately
appearing again when the player leaves and returns. The default cooldown is
30 minutes.

It is separate from tempPatches, which is reserved for temporary EveJS bug
fixes. This mod only controls the respawn delay for cleared combat anomalies.

## Features

- Applies a 30-minute default cooldown to cleared combat anomalies.
- Keeps normal mining-site and depleted-site timers unchanged.
- Leaves ordinary sites and other dungeon content untouched.
- Works independently from tempPatches.

## Requirements

- Native EveJS 0.12.9
- [EveJS Launcher 1.0.69](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69) or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy dungeonRespawnCooldown into the EveJS mods directory.
2. Keep the manifest at mods/dungeonRespawnCooldown/evejs-launcher.mod.json.
3. Enable the mod in the EveJS Launcher.
4. Restart the **Game server**.

The cooldown is applied only after a combat anomaly reaches the completed state.
Generated mining sites and sites using the normal depleted-site timer are not
changed.

## Configuration

The cooldown is currently defined in loader.js as 30 minutes. A game-server
restart is required after installing, updating, enabling, or disabling the mod.

## Removal

Disable the mod in the Launcher and restart the Game server. No persistent
cleanup is required.
