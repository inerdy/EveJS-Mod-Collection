# Ship Warp Fuel

Ship Warp Fuel adds a server-authoritative isotope fuel system to EveJS 0.12.9
without modifying EveJS source files.

Every ship exposes a 1,000-unit universal fuel bay. Warp commands consume the
currently selected isotope based on ship class and fuel burn rate, rounded up
with a one-unit minimum. Manual and autopilot warps are covered; stargate
travel, docking, undocking, subwarp movement, login, and reconnects do not
consume fuel. The mod also records each ship's warp odometer in AU.

The selectable fuel types and default burn multipliers are:

| Fuel | Multiplier |
| --- | ---: |
| Hydrogen Isotopes | 0.75x |
| Helium Isotopes | 0.90x |
| Nitrogen Isotopes | 1.05x |
| Oxygen Isotopes | 1.25x |

Oxygen Isotopes remain the default fuel, but have the highest consumption.
The active fuel can be changed from the Mods-menu window and is saved per
ship. Fuel is consumed only from the selected isotope's fuel-bay stacks.

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

The launcher Mods-menu window includes a Fuel Bay inventory section and a
waypoint estimate. Put the selected isotope in the ship's normal cargo hold,
choose **Load Fuel from Cargo**, and the server moves it into the distinct
fuel-bay inventory flag (133). The active fuel can be cycled from the same
window, and **Move Fuel to Cargo** moves that isotope back out. This management
panel is provided because the EVE client may not display a dynamic fuel-bay
tab for ship types whose static client data does not advertise one.

When a waypoint route is set, the window displays an estimated jump count,
estimated warp distance, required fuel, and projected fuel remaining. The
estimate uses `estimatedWarpAUPerGateJump` (50 AU by default) and the same
ship-class and isotope multipliers used by actual warp consumption. It is an
estimate because the exact gate-to-gate warp distances are only known as the
autopilot performs them.

The first time a character's active ship attaches, the mod tops it up to a
full fuel bay. The migration is idempotent and does not repeatedly refill the
ship after relogs.

When a ship has no fuel of the selected type, the Mods-menu window offers an
emergency fuel ship. It delivers 25 units of the selected isotope, charges
1,000,000 ISK, and has a 15-minute character cooldown. The service ship warps
in from 1 AU, approaches the player, delivers the fuel, and then warps away
before it is removed. The emergency button is only shown when the active ship
has no fuel of the selected type. If the wallet is short, the available
balance is charged and the remainder is tracked as debt for later collection.

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

`npcMarketLiquidity` includes one-time seeds for Hydrogen, Helium, Nitrogen,
and Oxygen Isotopes in Jita, Amarr, Dodixie, Rens, and Hek. It creates one
100,000-unit NPC sell order for each isotope per hub at that hub's current
average market reference or the bundled market manifest fallback. The seeds
are idempotent, do not continuously replenish sold stock, and can repair a
missing order after the market daemon restarts.
