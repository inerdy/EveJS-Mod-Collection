# NPC Market Liquidity

[![EveJS 0.12.9](https://img.shields.io/badge/EveJS-0.12.9-2f6f9f)](https://github.com/V0nCleef/evejs-launcher/releases/tag/v1.0.69)
[![Native and Docker](https://img.shields.io/badge/backend-native%20%2B%20Docker-6f42c1)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

NPC Market Liquidity gradually adds synthetic NPC buy and sell orders to the
major trade hubs. It uses the current hub market book when one exists. If a
hub has no local order for an item, it automatically uses the market-seederv3
price manifest instead of requiring a manually maintained price list.

The initial hubs are Jita, Amarr, Dodixie, Rens, and Hek. The mod processes a
bounded batch once per hour, so it does not try to create thousands of orders
in one server tick. Orders are synthetic NPC liquidity: they do not consume a
player’s inventory or wallet.

When `fuelSeeds` is enabled, the mod also creates one 100,000-unit sell order
for each configured isotope at each configured hub. The price uses that hub's
current average market reference or the bundled manifest fallback. These
dedicated seed orders are checked each normal tick and recreated when no open
mod fuel order remains, including after consumption or a market rebuild.

## Requirements

- EveJS `0.12.9`
- Market daemon RPC capability `idempotent-fill-v1`
- EveJS Launcher `1.0.69` or newer

Native and Docker backends are supported. The mod detects whether the daemon
supports native `npc-passive-orders-v1` orders and automatically uses the
compatible order path when it does not. Only `idempotent-fill-v1` is required.

## Installation

Copy `mods/npcMarketLiquidity` into the installation's `mods` directory, enable
it in the Launcher, and restart the Game server. The mod checks the market
server compatibility when its first tick runs. Docker is supported as long as
the market daemon exposes the standard order RPCs.

On daemons advertising `npc-passive-orders-v1`, managed orders are stored with
source `npc-passive` and use EveJS's native synthetic-fill path. Older daemons
store these orders with source `player`; the mod's compatibility bridge marks
only its tracked owner-0 order IDs as `npc-passive` in market-book responses.
The bridge gets its ID snapshot at startup and refreshes it once per scheduled
liquidity pass; it does not make an ownership RPC when someone opens a market
or buys an item. Genuine player orders are not rewritten. No machine-specific
path, market-server source edit, or market-seed rebuild is needed for this
compatibility mode.

## Configuration

Edit `mods/npcMarketLiquidity/config/liquidity.json` while the Game server is
stopped, then restart the Game server.

- `enabled`: turns the scheduler on or off.
- `dryRun`: logs planned orders without creating or replacing market orders.
- `tickIntervalMs`: delay between replenishment passes. The default is one hour.
- `oreLiquidity`: dedicated raw-ore buy-order settings. By default, the mod
  checks the standard ore types every 15 minutes and maintains five larger buy
  orders per ore at each configured hub.
- `resourceLiquidity`: larger quantity settings for configured ores, ice, and
  compressed ice types. The default 250,000 m³ target makes a White Glaze order
  250 units instead of 5. It applies to both normal buy and sell orders and
  refreshes smaller managed resource orders when they are encountered.
- `itemsPerHubPerTick`: limits how many eligible item types each hub processes
  per pass. The cursor is saved, so coverage continues after a restart.
- `ordersPerSide`: number of simultaneous buy and sell slots per item at each
  hub.
- `maxActiveOrdersPerHub`: safety cap for this mod's open orders at one hub.
- `targetOrderVolumeM3` and `maximumOrderQuantity`: determine the quantity of
  each generated order from the item's volume.
- `oreLiquidity.tickIntervalMs`, `oreLiquidity.ordersPerItem`,
  `oreLiquidity.targetOrderVolumeM3`, `oreLiquidity.maximumOrderQuantity`, and
  `oreLiquidity.typeIDs` control the faster ore-buy pass. It only creates buy
  orders and does not change the normal market pass for other items.
- `resourceLiquidity.targetOrderVolumeM3`,
  `resourceLiquidity.maximumOrderQuantity`, and `resourceLiquidity.typeIDs`
  control the larger resource order sizing overlay. Resource settings take
  precedence over the normal target and the faster ore-buy target for matching
  type IDs.
- `shipLiquidity` maintains a faster rotating ship catalog. It processes the
  configured number of eligible ship types per hub per normal tick and uses
  its own cursor, so T1/T2 and mining ships do not wait behind the full item
  catalog. T1 mining ships (Venture, Procurer, Retriever, and Covetor) are
  prioritized in that rotation. Each ship gets one buy and one sell order with
  the configured `quantityPerOrder` stack size.
- `playerSellBuyback` enables the NPC's periodic buyback of standing player
  sell orders. It is enabled for ores, ice, and compressed ice by default.
  `chancePerTick` is the maximum purchase chance for an especially good price;
  the chance decreases linearly from `minimumPriceRatio` to
  `maximumPriceRatio` against the current market/manifest reference. Orders
  above the maximum ratio are ignored. `maxOrdersPerHubPerTick` limits how
  many player orders a hub can attempt per pass, and
  `maximumQuantityPerOrder` caps one fill (`0` uses the configured resource
  order size). Set `resourceOnly` to `false` to enable the behavior for every
  eligible market item processed by the mod.
- `staleAfterMs`: how long an order can remain open before the next pass may
  replace it using a new market reference.
- `minimumSpreadRatio`: prevents generated orders from crossing the current
  book by default.
- `priceManifestEnabled`: enables the automatic market-seederv3 fallback.
- `priceManifestPath`: repository-relative or absolute path to
  `price-manifest.json`. The default bundled file is
  `mods/npcMarketLiquidity/data/price-manifest.json`, so the mod works when
  installed by itself.
- `allowCalculatedManifestPrices`: allows the manifest's calculated entries
  to seed items that have no live CCP or Jita reference. This is enabled by
  default so items without existing orders can still be populated.
- `fuelSeeds`: controls the isotope seed orders. Each normal liquidity tick
  verifies that the configured orders still exist and recreates any missing
  order. The default list contains
  Hydrogen `17889`, Helium `16274`, Nitrogen `17888`, and Oxygen `17887`, with
  100,000 sell units per configured hub and repair-after-restart enabled. Each
  entry has its own `hubStationIDs` list and uses that station's current market
  summary or the manifest fallback.
- `hubFuelSeed`: legacy single-seed compatibility. New configurations should
  use `fuelSeeds`.
- `discordWebhookUrl`: optional Discord webhook URL. Keep secrets in the
  ignored `config/liquidity.local.json` file or use the
  `NPC_MARKET_LIQUIDITY_DISCORD_WEBHOOK_URL` environment variable.
- `discordNotifyWhenEmpty`: sends a message for passes that created or
  replaced no orders. It is disabled by default.
- `hubStationIDs`: station IDs where orders are created.
- `buyTiers` and `sellTiers`: weighted price tiers. Each tier has an `id`, a
  price `multiplier`, and a `weight` used to assign the order slots.

The mod skips items that have no market group, no usable volume, or no entry in
the configured price manifest. It does not use the static SDE `basePrice` as a
silent fallback.

The manifest contains two kinds of references. `ccp-esi-average` and
`ccp-snapshot-jita-split` are captured from Tranquility market data. Entries
such as `cost-recursive`, `derived-compressed-twin`, and
`reprocessing-floor` are calculated references used only when no captured
market price exists. The loader logs how many real and calculated entries it
loaded, and each scheduler pass reports how many items used the fallback.
Refresh the manifest with market-seederv3 when current Tranquility prices are
desired, then replace the bundled `data/price-manifest.json` before packaging
the mod release.

When Discord is configured, one summary message is sent after each pass that
creates, replaces, or evaluates a dedicated hub fuel seed. A failed Discord
request is logged and does not roll back or prevent market orders.

## Market behavior

The scheduler reads `GetOwnerOrders` at startup and once per pass, unpacking
its nested `row` fields to check existing stock. On older daemons, only the
tracked owner-0 orders from this mod are presented to EveJS as `npc-passive`;
real player order IDs remain unchanged and retain their normal escrow checks.
Saved IDs are not trusted across a database rebuild. On each configured pass,
the optional buyback sweep evaluates standing player sell orders. A successful
buy consumes the escrowed items, credits the seller's wallet, and reduces the
player order through the same durable market-fill path used by normal market
transactions.

If the market database is rebuilt with V2, the passive orders disappear with
the replaced database and are recreated gradually on later scheduler passes.

## Validation

From the EveJS root:

```powershell
node mods/npcMarketLiquidity/test/validate.js
node mods/npcMarketLiquidity/test/marketCompatibility.js
# Optional: Node with node:sqlite support and an existing market executable.
node mods/npcMarketLiquidity/test/nativeMarketSmoke.js
```

The regression test uses in-memory RPC fixtures, including all five fuel hubs,
T1 mining-ship bids/asks, duplicate prevention after reload, saved state from a
replaced database, the temporary buyback bid, and unsupported daemon rejection.
It does not connect to or change the live market.

The optional native smoke test launches the existing release market executable
against a disposable SQLite fixture on temporary loopback ports. It runs the
actual EveJS purchase matching and fill saga with in-memory game-side wallet,
inventory, and escrow dependencies. It verifies a mod fuel order is stored as
`npc-passive`, buying delivers items/debits the wallet/decrements real daemon
stock, an NPC bid is visible, and a player-labelled order without escrow still
fails. It shuts down its daemon and removes only its disposable fixture. An
alternate existing executable can be supplied as the first argument. This is
not an in-client test against the deployed VPS.

## Removal

Set `enabled` to `false` and restart the Game server to stop creating new
orders. Existing `npc-passive` orders can be cancelled with the market
server's normal order administration tools before removing the mod. The mod's
cursor and counters live under the active EveJS data root in
`gameStore/npcMarketLiquidity/state.json`.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

If the project becomes unmaintained, you may continue working on it, modify
it, and release your own version. Please keep the original author credit to
**Troublesum** in the documentation and source distribution.

## AI disclosure

Parts of this project were developed with assistance from AI tools. The code,
behavior, testing, documentation, and releases are reviewed and maintained by
Troublesum. AI assistance does not change the license or ownership of this
project.
