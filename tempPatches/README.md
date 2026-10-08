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

It also replaces the expensive combat-anomaly cache projection with a compact
projection built directly from EveJS's in-memory dungeon runtime state. This
avoids cloning the full dungeon summary collection whenever the Probe Scanner
requests combat anomalies. If the projection cannot be built, the native
handler is used as a fallback.

It also stops the one-second dungeon behavior loop from repeatedly processing a
site that has already reached a terminal state while the player is still inside
the occupancy-grace window. The normal teardown and grace period remain
unchanged; only the completed site's active-processing marker is removed. This
patch is currently disabled by default because it needs more startup testing.
Enable it explicitly with `EVEJS_TEMP_PATCHES_TERMINAL_SITE_CLEANUP=1` after
the server startup issue is resolved.

The cleared-anomaly respawn cooldown is provided by the separate
`dungeonRespawnCooldown` mod. Keeping that behavior separate makes it possible
to disable this temporary bug-fix package without changing anomaly respawn
timers.

It is intended for EveJS `0.12.9` and requires a game-server restart after
installation or replacement. It does not change dungeon content packs and does
not support Docker.

The patch only schedules reconciliation for dungeon-scoped encounter entities.
Normal open-space NPC destruction is unaffected. Dungeon diagnostics are enabled
by default and record encounter state before and after each reconciliation pass
in the server log. Set `EVEJS_TEMP_PATCHES_DIAGNOSTICS=0` in the server
environment to silence them after testing. If a dungeon run was already stuck
before the mod was installed, leave and re-enter the site before testing.
