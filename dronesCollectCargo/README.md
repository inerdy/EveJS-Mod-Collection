# Drones Collect Cargo

Loader-only EveJS 0.12.9 mod. It extends salvage-drone assignments so drones can collect contents from legal, unanchored cargo containers in space. Cargo is moved into the drone's cargo hold, then EveJS's normal drone delivery path transfers it into the active ship's cargo hold.

When no salvage wrecks or eligible containers remain, the mod recalls the drones directly to the ship's drone bay. If the ship's cargo hold is full, the drone stays out with the undelivered rows so cargo is not lost.

The mod respects EveJS loot rights and does not collect anchored secure containers or containers the player cannot legally loot. It hooks the server loader only; no original EveJS source files are modified.

Install the folder or package through the launcher Mods menu and restart the game server after changing the mod.
