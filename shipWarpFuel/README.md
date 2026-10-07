# Ship Warp Fuel

Ship Warp Fuel adds a server-authoritative Oxygen Isotope fuel system to
EveJS 0.12.9 without modifying EveJS source files.

Every ship exposes a 1,000-unit universal fuel bay. Warp commands consume fuel
based on ship class, rounded up with a one-unit minimum. Manual and autopilot
warps are covered; stargate travel, docking, undocking, subwarp movement,
login, and reconnects do not consume fuel. The mod also records each ship's
warp odometer in AU.

The default fuel rates are measured in units per AU:

| Ship class | Rate |
| --- | ---: |
| Capsule, frigate, corvette, shuttle | 0.5 |
| Destroyer | 0.75 |
| Cruiser | 1.25 |
| Battlecruiser | 1.5 |
| Battleship | 2 |
| Industrial and transport | 2.5 |
| Capital and freighter | 4 |
| Unknown hull fallback | 0.5 |

Rates can be changed with `fuelUnitsPerAUByClass` in `config/fuel.json`.
Ship classes are resolved from the active ship's existing metadata using the
same broad hull categories as the Gate Taxes mod.

The launcher Mods-menu window now includes a Fuel Bay inventory section. Put
Oxygen Isotopes in the ship's normal cargo hold, then choose **Load Oxygen
from Cargo**. The server moves the item into the distinct fuel-bay inventory
flag (133); **Move Oxygen to Cargo** moves it back out. This management panel
is provided because the EVE client may not display a dynamic fuel-bay tab for
ship types whose static client data does not advertise one.

The first time a character's active ship attaches, the mod tops it up to a
full fuel bay. The migration is idempotent and does not repeatedly refill the
ship after relogs.

When a ship has no fuel, the Mods-menu window offers an emergency fuel ship.
It delivers 25 Oxygen Isotopes, charges 1,000,000 ISK, and has a 15-minute
character cooldown. The service ship warps in from 1 AU, approaches the
player, delivers the fuel, and then warps away before it is removed. The
emergency button is only shown when the active ship has no fuel. If the wallet
is short, the available balance is charged and the remainder is tracked as
debt for later collection.

## Installation

Enable `shipwarpfuel` in the EveJS Launcher and restart the Game server.
Configuration lives in `config/fuel.json`; optional local overrides can be
placed in the ignored `config/fuel.local.json` file.

The emergency service movement can be adjusted with these settings:

- `serviceShipSpawnDistanceAU`: distance from the player where the service
  ship begins its warp-in.
- `serviceShipApproachRangeMeters`: distance at which the service ship can
  deliver fuel.
- `serviceShipApproachTimeoutMs`: maximum time allowed for the service ship
  to arrive.
- `serviceShipDepartureDelayMs`: time the service ship remains after it warps
  away.
- `serviceShipLifetimeMs`: maximum lifetime of the temporary service ship.

Runtime state is stored outside the package at:

```text
<EVEJS data root>/gameStore/shipWarpFuel/state.json
```

## Market fuel seed

`npcMarketLiquidity` includes a dedicated Oxygen Isotope seed for Jita,
Amarr, Dodixie, Rens, and Hek. It creates one 100,000-unit NPC sell order per
hub at that hub's current average market reference. The seed is idempotent,
does not continuously replenish sold stock, and can repair a missing order
after the market daemon restarts.
