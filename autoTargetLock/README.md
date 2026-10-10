# Auto Target Lock

Auto Target Lock adds a toggle to the Launcher-provided in-game `Mods` menu.
When enabled, it scans the player's current ballpark and asks the native EVE
targeting service to lock hostile NPC combatants.

The mod uses the player's live effective targeting range, so sensor boosters,
scripts, ship bonuses, skills, and other targeting-range modifiers are honored.
It also respects the ship's available target slots and leaves existing locks
alone when the toggle is disabled.

Only entities that the client identifies as both NPC and hostile are selected.
Players, friendly entities, structures, wrecks, and entities outside the
current ballpark are ignored. The client will naturally reject a lock request
while a target is unavailable, out of range, or otherwise not lockable.

## Use

1. Enable the mod in the EveJS Launcher.
2. Restart the EveJS game server.
3. Restart the EVE client through the EveJS Launcher.
4. Open the in-game `Mods` icon and open `Auto Target Lock`.
5. Toggle the feature on or off.

The feature is off by default and does not automatically unlock targets when
disabled.
