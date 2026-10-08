# Temporary Patches

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](#requirements)
[![Native only](https://img.shields.io/badge/backend-native--only-6f42c1)](#requirements)

tempPatches is a native-only EveJS loader mod for small server fixes. It keeps
the fixes separate from EveJS core files so each patch can be disabled or
removed independently.

## Features

- Reconciles dungeon encounter state after a dungeon NPC is destroyed so
  wave_cleared encounters can start.
- Sends the normal dungeon-exit notification when a dungeon is completed so the
  client's wave panel clears.
- Replaces EveJS's malformed generic TargetTooFar response for cargo containers
  with a readable range message. The native access range is not changed.
- Replaces the expensive combat-anomaly cache projection with a compact
  projection built directly from EveJS's in-memory dungeon runtime state.
- Contains an opt-in terminal-site cleanup patch that is currently disabled by
  default because it needs more startup testing.

The terminal-site patch would stop the one-second dungeon behavior loop from
repeatedly processing a site that has reached a terminal state while the player
is still inside the occupancy-grace window. The normal teardown and grace period
remain unchanged.

Cleared-anomaly respawn cooldown is provided by the separate
dungeonRespawnCooldown mod. Keeping that behavior separate makes it possible to
disable this temporary bug-fix package without changing anomaly respawn timers.

## Requirements

- Native EveJS 0.12.9
- EveJS Launcher 1.0.69 or newer

This mod is native-only. Docker deployments are not supported.

## Installation

1. Copy tempPatches into the EveJS mods directory.
2. Keep the manifest at mods/tempPatches/evejs-launcher.mod.json.
3. Enable **Temporary Patches** in the EveJS Launcher.
4. Restart the **Game server**.

The mod is intended for EveJS 0.12.9. It does not change dungeon content packs
and does not edit EveJS core files.

## Configuration

Dungeon diagnostics are enabled by default and record encounter state before and
after each reconciliation pass in the server log. Set
EVEJS_TEMP_PATCHES_DIAGNOSTICS=0 in the server environment to silence them after
testing.

The terminal-site cleanup patch is disabled by default. To opt in explicitly,
set EVEJS_TEMP_PATCHES_TERMINAL_SITE_CLEANUP=1 before starting the server. Leave
it unset while using the stable patch set.

The cleared-anomaly respawn timer is configured by the separate
dungeonRespawnCooldown mod.

## Basic use

The reconciliation patch only schedules work for dungeon-scoped encounter
entities. Normal open-space NPC destruction is unaffected. If a dungeon run
was already stuck before installation, leave and re-enter the site before
testing.

## Removal

Disable the mod in the Launcher and restart the Game server. Existing dungeon
state and ordinary content are not removed by this mod.

## Maintenance

This package is temporary by design. Prefer removing or disabling individual
patches after the corresponding issue is fixed in EveJS.
