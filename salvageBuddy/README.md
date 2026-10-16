# SalvageBuddy

SalvageBuddy deploys five temporary, server-controlled Salvage Drone IIs around
the player's active ship. The drones use the player's ship as their controller
and salvage eligible wrecks. Recovered loot goes to the player's active ship
unless a dedicated collection ship is selected.

The service scans the active combat-site scene for salvageable wrecks and legal,
unanchored cargo containers. It deploys the drones beside the player, assigns
them eligible wrecks, waits for them to return their salvage, collects legal
cargo containers, and removes the temporary drones when finished.

While docked, choose a stored ship from the Mods-menu window as the dedicated
collection ship. It warps in when SalvageBuddy is summoned. **Recall Collection
Ship** returns it to the station where it was stored, deposits recovered loot
into that station's hangar, and lets SalvageBuddy continue with later loot going
to the player's active ship. When SalvageBuddy completes or is sent away, the
collection ship returns and deposits its recovered loot in the same hangar.

Each request costs 120,000 ISK. The fee is charged when the request is accepted;
if the temporary drones cannot be deployed, the fee is refunded. A character
may have only one active request and receives a two-minute cooldown after each
accepted request.

While the service is active, the Mods-menu window includes **Send SalvageBuddy
Away**. This stops additional work and recalls/removes the drones and collection
ship without refunding the already accepted service fee. The temporary drones
cannot be returned to the player's drone bay through the normal drone command.

## Installation

Enable `salvagebuddy` in the EveJS Launcher and restart the Game server. The
service is available from the Mods menu.

## Configuration

Configuration is in `config/salvageBuddy.json`. Local overrides may be placed
in the ignored `config/salvageBuddy.local.json` file. The fit and service fee
are configurable, including:

- `serviceFeeISK`
- `cooldownSeconds`
- `salvageDroneTypeID` / `salvageDroneCount`
- `droneOnly`
- service timeouts

Runtime request history is stored outside the mod package at:

```text
<EVEJS data root>/gameStore/salvageBuddy/state.json
```

## Compact window (0.2.14)

The window keeps its 430 x 330 default size (minimum 400 x 300). Service shows
labeled progress, fee, cooldown and loot destination, with Summon and Send Away
always reachable. Collection Ship keeps long ship names separate from Select
buttons and explains docking or service restrictions. Requests run in background
tasklets, disable duplicate actions and preserve error feedback across refreshes.


Collection ship choices use compact cards with the native ship icon, ship and
type names, docked station, cargo usage, and a capacity bar. The Select action
stays alongside the ship details, and long labels expand the row inside the
scrolling list.
