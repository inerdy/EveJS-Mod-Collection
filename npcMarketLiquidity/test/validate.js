"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {normalizeConfig} = require(path.join(__dirname, "..", "lib", "config"));
const {normalizeState} = require(path.join(__dirname, "..", "lib", "state"));
const pricing = require(path.join(__dirname, "..", "lib", "pricing"));
const discord = require(path.join(__dirname, "..", "lib", "discord"));
const service = require(path.join(__dirname, "..", "lib", "npcMarketLiquidityService"));

const config = normalizeConfig({});
assert.equal(config.hubStationIDs.length, 5);
assert.equal(config.ordersPerSide, 3);
assert.equal(config.oreLiquidity.enabled, true);
assert.equal(config.oreLiquidity.tickIntervalMs, 900000);
assert.equal(config.oreLiquidity.ordersPerItem, 5);
assert.equal(config.oreLiquidity.typeIDs.length, 16);
assert.equal(config.fuelSeeds.length, 4);
assert.deepEqual(config.fuelSeeds.map((seed) => seed.typeID), [17889, 16274, 17888, 17887]);
assert.equal(config.hubFuelSeed.typeID, 17887);
assert.equal(config.fuelSeeds.every((seed) => seed.enabled && seed.quantity === 100000 && seed.sellOnly), true);
assert.equal(config.fuelSeeds.every((seed) => seed.hubStationIDs.length === 5), true);
const migratedState = normalizeState({fuelSeedByStation: {
  "60003760": {orderID: "41", typeID: 17887, quantity: 100000},
  "60003760:17889": {orderID: "42", typeID: 17889, quantity: 100000},
}});
assert.equal(migratedState.fuelSeedByStation["60003760"].orderID, "41");
assert.equal(migratedState.fuelSeedByStation["60003760:17889"].orderID, "42");
const marketManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "evejs-launcher.mod.json"), "utf8"));
assert.equal(marketManifest.version, "0.5.0");
assert.equal(config.priceManifestEnabled, true);
assert.equal(config.allowCalculatedManifestPrices, true);
assert.equal(config.priceManifestPath.endsWith(path.join("mods", "npcMarketLiquidity", "data", "price-manifest.json")), true);
assert.equal(service._testing.eligibleItem({typeID: 34, published: true, marketGroupID: 18, volume: 0.01, portionSize: 1}), true);
assert.equal(service._testing.eligibleItem({typeID: 34, published: true, marketGroupID: null, volume: 0.01, portionSize: 1}), false);
assert.equal(service._testing.quantityForItem({volume: 0.01}, config), 500000);
assert.equal(
  service._testing.quantityForItem({volume: 0.1}, config, config.oreLiquidity),
  250000,
);
assert.equal(service._testing.orderSource(60003760, 34, "buy", 0), "npc-passive:60003760:34:buy:0");

const reference = pricing.buildReference({
  sells: [{price: 100, bid: false, source: "seed"}],
  buys: [{price: 80, bid: true, source: "seed"}],
}, 0.02);
assert.deepEqual(reference, {bestAsk: 100, bestBid: 80, askReference: 100, bidReference: 80});
assert.equal(pricing.buildPrice("buy", {multiplier: 0.95}, reference, 0.02), 76);
assert.equal(pricing.buildPrice("sell", {multiplier: 1.05}, reference, 0.02), 105);
assert.equal(pricing.buildAveragePrice(reference), 90);
assert.equal(pricing.buildReference({sells: [{price: 1, bid: false, source: "npc-passive"}], buys: []}), null);
const manifest = pricing.loadPriceManifest(config.priceManifestPath, {allowCalculated: true});
assert.equal(manifest.loaded, true);
assert.ok(manifest.entries.size > 0);
assert.ok(manifest.realEntries > 0);
assert.ok(manifest.calculatedEntries > 0);
const manifestReference = pricing.buildManifestReference(manifest.entries.get(34));
assert.equal(manifestReference.bestAsk, null);
assert.equal(manifestReference.bestBid, null);
assert.equal(manifestReference.askReference, manifest.entries.get(34).price);
assert.equal(manifestReference.bidReference, manifest.entries.get(34).price);
assert.equal(pricing.isRealMarketSource(manifest.entries.get(34).source), true);
const realOnlyManifest = pricing.loadPriceManifest(config.priceManifestPath, {allowCalculated: false});
assert.equal(realOnlyManifest.loaded, true);
assert.equal(realOnlyManifest.calculatedEntries, 0);
assert.ok(realOnlyManifest.entries.size < manifest.entries.size);
assert.equal(discord.isConfigured("https://discord.com/api/webhooks/example/token"), true);
assert.equal(discord.isConfigured("https://example.com/webhook"), false);
service._testing.registerManagedOrderID("42");
const bridgedBook = service._testing.rewriteLegacyOrderSources({
  sells: [{order_id: "42", source: "player"}],
  buys: [{order_id: "43", source: "player"}],
});
assert.equal(bridgedBook.sells[0].source, "npc-passive");
assert.equal(bridgedBook.buys[0].source, "player");

console.log("npcMarketLiquidity validation passed");
