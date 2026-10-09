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
dedicated seed orders are idempotent, are not continuously replenished after
being sold, and can be repaired after the market daemon restarts.

## Requirements

- EveJS `0.12.9`
- Standard market server order RPCs (`idempotent-fill-v1`)
- EveJS Launcher `1.0.69` or newer

Native and Docker backends are supported when the market daemon exposes the
standard order RPCs.

## Installation

Copy `mods/npcMarketLiquidity` into the installation's `mods` directory, enable
it in the Launcher, and restart the Game server. The mod checks the market
server compatibility when its first tick runs. Docker is supported as long as
the market daemon exposes the standard order RPCs.

The mod is self-contained and does not require rebuilding the native market
server. It places its managed orders through the existing standard order RPC
as owner ID `0`, then its loader bridge marks only those known order IDs as
synthetic NPC orders while EveJS processes market fills. This keeps the
native market-server source and executable unchanged while preserving the
NPC wallet and inventory behavior in the Node market service.

## Configuration

Edit `mods/npcMarketLiquidity/config/liquidity.json` while the Game server is
stopped, then restart the Game server.

- `enabled`: turns the scheduler on or off.
- `dryRun`: logs planned orders without creating or replacing market orders.
- `tickIntervalMs`: delay between replenishment passes. The default is one hour.
- `oreLiquidity`: dedicated raw-ore buy-order settings. By default, the mod
  checks the standard ore types every 15 minutes and maintains five larger buy
  orders per ore at each configured hub.
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
- `fuelSeeds`: controls the one-time isotope seeds. The default list contains
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

The market server stores orders from this mod through its normal `player`
order path using reserved owner ID `0`. The mod bridge exposes only those
managed order IDs to EveJS as `npc-passive` orders, so they remain visible
alongside player and seeded orders, use the native synthetic fill path, and
are replenished after consumption. Existing seeded liquidity and player
orders are left in place.

If the market database is rebuilt with V2, the passive orders disappear with
the replaced database and are recreated gradually on later scheduler passes.

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
