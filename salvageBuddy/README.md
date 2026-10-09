# SalvageBuddy

SalvageBuddy summons a temporary, server-controlled Noctis to the player's
current location. The default fit is a 10MN Afterburner II, four Large Tractor
Beam I modules, four Salvager II modules, and five Salvage Drone II workers.

The service scans the current solar system for salvageable wrecks and legal,
unanchored cargo containers. It warps in from one AU, activates its afterburner,
warps to tractor-beam range instead of flying to each wreck, pulls targets in
with all four tractors, deploys its Salvage Drone IIs, and transfers recovered
items directly into the player's active ship cargo hold before warping away.

Each request costs 120,000 ISK. The fee is charged when the request is accepted;
if the temporary Noctis cannot spawn or cannot arrive, the fee is refunded. A
character may have only one active request and receives a five-minute cooldown
after each accepted request.

While the service is active, the Mods-menu window includes **Send SalvageBuddy
Away**. This stops additional work and sends the Noctis away without refunding
the already accepted service fee.

## Installation

Enable `salvagebuddy` in the EveJS Launcher and restart the Game server. The
service is available from the Mods menu.

## Configuration

Configuration is in `config/salvageBuddy.json`. Local overrides may be placed
in the ignored `config/salvageBuddy.local.json` file. The fit and service fee
are configurable, including:

- `serviceFeeISK`
- `cooldownSeconds`
- `tractorBeamTypeID` / `tractorBeamCount`
- `salvagerTypeID` / `salvagerCount`
- `salvageDroneTypeID` / `salvageDroneCount`
- `spawnDistanceAU`, `approachRangeMeters`, and service timeouts

Runtime request history is stored outside the mod package at:

```text
<EVEJS data root>/gameStore/salvageBuddy/state.json
```
