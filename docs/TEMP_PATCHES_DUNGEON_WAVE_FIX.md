# EveJS Dungeon Wave Fix: Technical Notes

This document describes the temporary `tempPatches` changes made to EveJS
`0.12.9` to diagnose and mitigate dungeon encounter waves that did not appear
until the player left the site or caused another scene update.

It is intended for the EveJS developers. The patch is implemented as a loader
mod so the original EveJS source remains unchanged in the local installation.

## Observed behavior

After the last NPC in a wave was destroyed, the client could continue showing a
stale dungeon panel such as `Current Wave 1/2`. In some tests, the next wave did
not appear until the player left the site. The same site could also appear to
reset after leaving and returning.

The important distinction is that the server's encounter state was sometimes
already correct while the client panel was stale. In the captured diagnostic
run, dungeon instance `2331` reported:

- four planned encounter waves: `initial`, `wave_1`, `wave_2`, and `wave_3`;
- all four waves spawned;
- all four waves completed;
- no remaining entity IDs;
- lifecycle state `completed` with reason `encounters_cleared`;
- an `OnDungeonCompleted` notification sent to the client.

That run proved the server had progressed beyond wave 1. The visible `1/2`
panel was not an authoritative representation of the encounter state.

## Files changed by the mod

The implementation is in:

```text
mods/tempPatches/loader.js
mods/tempPatches/test/validate.js
mods/tempPatches/README.md
mods/tempPatches/evejs-launcher.mod.json
```

The loader patches these EveJS services at runtime:

```text
server/src/services/dungeon/dungeonUniverseSiteService.js
server/src/services/dungeon/dungeonTrackingRuntime.js
```

No EveJS core source file is modified by the mod.

## Wave progression patch

The affected native service is `dungeonUniverseSiteService`. The patch wraps
`handleEncounterEntityDestroyed(scene, entityOrID, options)` and preserves the
native method's return value and behavior.

After the native handler returns, the wrapper:

1. Checks whether the destroyed entity is dungeon-scoped. An entity is treated
   as dungeon-scoped when it has `dungeonMaterializedSiteContent`, a positive
   `dungeonSiteInstanceID`, or a `dungeonEncounterKey`.
2. Also checks `result.data.matchedInstanceIDs`, because the native handler may
   identify the dungeon instance even when the entity object does not contain
   the full dungeon metadata.
3. Records the materialized site and instance on the scene through:

   ```text
   scene._dungeonUniverseMaterializedSiteIDs
   scene._dungeonUniverseMaterializedInstanceIDsBySiteID
   ```

4. Schedules short reconciliation passes through the native
   `tickSceneSiteBehaviors(scene, {nowMs, session})` method.

The current retry delays are:

```js
[0, 75, 300]
```

These are three delayed calls after the destruction handler returns. They give
the native encounter state time to record the cleared wave before the next
wave's `wave_cleared` prerequisite is evaluated.

The scheduler uses a `WeakMap` keyed by scene. This coalesces multiple entity
destructions in the same scene and prevents several simultaneous destruction
events from creating duplicate reconciliation loops.

The native progression method remains authoritative. The patch does not spawn
NPCs directly, alter encounter definitions, or bypass prerequisite checks. It
only causes the existing progression evaluator to run again after a relevant
destruction.

## Completion UI reset

The native tracking service already sends:

```text
OnDungeonCompleted
```

but the client overlay could remain visible with its old wave count. The patch
wraps `notifyDungeonCompletedForScene(scene, instanceOrID, options)` in
`dungeonTrackingRuntime`.

After the native completion method successfully marks a character as notified,
the wrapper sends the existing native dungeon-exit notification for that
session:

```text
OnExitingDungeon
```

The wrapper only sends this reset for a newly completed instance. It checks
`dungeonCompletedNotifiedInstanceID` before and after the native call, so a
repeated completion check does not repeatedly reset the client UI. The native
completion notification remains intact.

This part of the patch clears the stale panel after final completion. It does
not make the client display every intermediate wave transition. Intermediate
wave display updates remain a client synchronization concern.

## Module loading approach

The loader installs a `Module._load` hook and applies patches when the target
service is loaded. It also checks `Module._cache` during installation so the
patch works when a target service was loaded before the mod.

Each patched service has a non-enumerable `Symbol` flag. This prevents the same
patch from being installed twice if the loader is discovered more than once.

## Diagnostics

Dungeon diagnostics are enabled by default. They can be disabled with:

```text
EVEJS_TEMP_PATCHES_DIAGNOSTICS=0
```

The relevant log records are:

```text
dungeon diagnostic entity-destroyed
dungeon diagnostic reconcile-scheduled
dungeon diagnostic reconcile-before
dungeon diagnostic reconcile-after
dungeon diagnostic reconcile-error
```

Each snapshot includes the instance lifecycle, planned waves, encounter state,
spawned/completed flags, and remaining entity IDs. This makes it possible to
distinguish a real server progression failure from a stale client overlay.

## Suggested upstream fix

The permanent EveJS fix should keep the native encounter state as the single
authority, but ensure that a wave-clearing destruction schedules or directly
invokes the normal scene behavior tick after the destruction state has been
committed. The update should be serialized per scene and idempotent, rather
than spawning the next wave from the mod itself.

For the UI issue, the native client handler for `OnDungeonCompleted` should
clear or close the dungeon wave overlay. If `OnExitingDungeon` is the intended
native reset path, the server should send it as part of normal dungeon
completion, or the client should apply the same reset internally when it
receives `OnDungeonCompleted`.

## Validation

The temporary implementation is covered by:

```powershell
node tempPatches/test/validate.js
```

The test verifies dungeon entity matching, reconciliation scheduling, scene
coalescing behavior, completion UI reset behavior, duplicate protection, and
the existing cargo-container patch. The live diagnostic run described above
also confirmed that all planned waves reached the completed state.

The mod is native-only and requires a game-server restart after installation or
replacement. The separate `dungeonRespawnCooldown` mod is not required for the
wave fix.
