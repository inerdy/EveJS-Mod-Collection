# Drones Collect Cargo

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](#requirements)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)

Drones Collect Cargo extends salvage-drone assignments so drones can collect
contents from legal, unanchored cargo containers in space. Cargo is moved into
the drone's cargo hold, then EveJS's normal drone delivery path transfers it
into the active ship's cargo hold.

When no salvage wrecks or eligible containers remain, the mod recalls the
drones directly to the ship's drone bay. If the ship's cargo hold is full, the
drone stays out with the undelivered rows so cargo is not lost.

The mod respects EveJS loot rights and does not collect anchored secure
containers or containers the player cannot legally loot. It hooks the server
loader only; no original EveJS source files are modified.

## Features

- Collects legal cargo-container contents with salvage drones.
- Preserves EveJS loot-right and ownership checks.
- Delivers collected cargo through the native drone path.
- Recalls drones when no eligible wrecks or containers remain.
- Keeps drones deployed when the ship cargo hold cannot accept the contents.

## Requirements

- Native EveJS 0.12.9
- EveJS Launcher 1.0.69 or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy dronesCollectCargo into the EveJS mods directory.
2. Keep the manifest at mods/dronesCollectCargo/evejs-launcher.mod.json.
3. Enable **Drones Collect Cargo** in the EveJS Launcher.
4. Restart the **Game server** and reconnect the client.

## Basic use

Assign salvage drones to wrecks or legal unanchored cargo containers through the
normal drone controls. The mod extends the existing assignment behavior and
does not add a separate configuration window.

## Removal

Disable or remove the mod in the Launcher and restart the Game server. No
database cleanup is required.

## Maintenance

This package is a small native loader extension. Keep the manifest directly
inside the mod folder when updating it.
