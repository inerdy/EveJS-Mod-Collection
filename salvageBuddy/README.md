# SalvageBuddy

SalvageBuddy deploys five temporary, server-controlled Salvage Drone IIs around
the player's active ship. The drones use the player's ship as their controller,
salvage eligible wrecks, and return the recovered materials to the player's
cargo hold.

The service scans the active combat-site scene for salvageable wrecks and legal,
unanchored cargo containers. It deploys the drones beside the player, assigns
them eligible wrecks, waits for them to return their salvage, collects legal
cargo containers, and removes the temporary drones when finished.

Each request costs 120,000 ISK. The fee is charged when the request is accepted;
if the temporary drones cannot be deployed, the fee is refunded. A character
may have only one active request and receives a two-minute cooldown after each
accepted request.

While the service is active, the Mods-menu window includes **Send SalvageBuddy
Away**. This stops additional work and recalls/removes the drones without
refunding the already accepted service fee. The temporary drones cannot be
returned to the player's drone bay through the normal drone command.

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
