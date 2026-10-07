# Temporary Patches

`tempPatches` is a native-only EveJS loader mod for a few small server fixes.
After a dungeon NPC is destroyed, it gives EveJS's encounter tracker a few
short reconciliation passes so `wave_cleared` encounters can start.

When the server marks a dungeon complete, it also sends the normal dungeon-exit
notification so the client's wave panel is cleared instead of remaining on a
stale wave count.

It also replaces EveJS's malformed generic `TargetTooFar` response for cargo
containers with a readable range message. The native container access range is
not changed.

Cleared combat anomalies are removed after the player leaves and remain on a
30-minute cooldown before the location can receive a replacement anomaly. This
prevents a cleared dungeon from immediately resetting when the player returns.

It is intended for EveJS `0.12.9` and requires a game-server restart after
installation or replacement. It does not change dungeon content packs and does
not support Docker.

The patch only schedules reconciliation for dungeon-scoped encounter entities.
Normal open-space NPC destruction is unaffected. Dungeon diagnostics are enabled
by default and record encounter state before and after each reconciliation pass
in the server log. Set `EVEJS_TEMP_PATCHES_DIAGNOSTICS=0` in the server
environment to silence them after testing. If a dungeon run was already stuck
before the mod was installed, leave and re-enter the site before testing.
