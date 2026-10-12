"use strict";

// All RPCs and server dependencies are isolated in memory. Never connects to
// a running market daemon or opens the installation's GameStore.
const assert = require("node:assert/strict");
const path = require("node:path");
const {loadService, loadModule, serverPath} = require("./testHarness");
const {normalizeOwnerOrders} = require("../lib/marketCompatibility");
const {normalizeConfig} = require("../lib/config");
const {buildReference} = require("../lib/pricing");

async function main() {
  const config = normalizeConfig({});
  const calls = [];
  const orders = new Map();
  let capabilities = ["idempotent-fill-v1", "npc-passive-orders-v1"];
  let nextID = 1;
  const marketDaemonClient = {call: async (method, params) => {
    calls.push({method, params});
    if (method === "Health") return {capabilities, started_at: "new-market"};
    if (method === "GetOwnerOrders") return [...orders.values()].map((row) => ({
      order_id: row.order_id, owner_id: row.owner_id, is_corp: row.is_corp,
      state: row.state, source: row.source, row,
    }));
    if (method === "GetStationAsks") return config.fuelSeeds.map((fuel) => ({
      type_id: fuel.typeID, best_ask_price: 600, best_bid_price: 500,
    }));
    if (method === "PlaceOrder") {
      const order_id = String(nextID++);
      orders.set(order_id, {...params, order_id, vol_remaining: params.quantity,
        state: "open", issued_at: new Date().toISOString()});
      return {order_id};
    }
    if (method === "GetOrder") return orders.get(String(params.order_id));
    if (method === "GetOrders") {
      const matches = [...orders.values()].filter((row) => (
        String(row.state || "open").toLowerCase() === "open" &&
        (!params || !params.type_id || Number(row.type_id) === Number(params.type_id))
      ));
      return {
        sells: matches.filter((row) => !row.bid),
        buys: matches.filter((row) => Boolean(row.bid)),
      };
    }
    if (method === "CancelOrder") {
      orders.get(String(params.order_id)).state = "cancelled";
      return {};
    }
    throw new Error(`Unexpected RPC ${method}`);
  }};
  const items = [...config.fuelSeeds.map((fuel) => ({typeID: fuel.typeID})),
    ...[32880, 17476, 17478, 17480].map((typeID) => ({typeID, categoryID: 6}))]
    .map((item) => ({name: String(item.typeID), published: true, marketGroupID: 1,
      volume: 1000, portionSize: 1, ...item}));
  const crossingCalls = [];
  const {Service, imports} = loadService({marketDaemonClient, items, hooks: {
    applySellOrderCrossingAfterModify: async (_session, order) => {
      crossingCalls.push(order);
      return {};
    },
  }});
  const staleState = {
    managedOrderIDs: ["62510"], marketStartedAt: "old-market",
    fuelSeedByStation: Object.fromEntries(config.hubStationIDs.flatMap((stationID) =>
      config.fuelSeeds.map((fuel) => [`${stationID}:${fuel.typeID}`, {
        orderID: "62510", typeID: fuel.typeID, quantity: 100000,
      }]))),
  };
  const service = new Service({autoStart: false, config,
    stateStore: {load: () => staleState, save: () => {}}});

  // Recheck the required capability; native NPC order support is optional.
  await service._ensureDaemonSupport();
  for (const missing of ["idempotent-fill-v1"]) {
    capabilities = ["idempotent-fill-v1", "npc-passive-orders-v1"].filter((c) => c !== missing);
    calls.length = 0;
    const status = await service.tick();
    assert.equal(status.state, "error");
    assert.match(status.error, new RegExp(missing));
    assert.deepEqual(calls.map((call) => call.method), ["Health"]);
  }
  capabilities = ["idempotent-fill-v1"];
  await service._ensureDaemonSupport();
  assert.equal(service.getStatus().compatibilityMode, "cached-managed-order-bridge");
  capabilities = ["idempotent-fill-v1", "npc-passive-orders-v1"];
  await service._ensureDaemonSupport();
  const existing = await service._listExistingOrders();
  assert.equal(existing.length, 0);
  assert.equal(service.getStatus().managedOrderCount, 0, "saved IDs cannot survive a fresh book");

  // A rebuilt market must recreate all 20 fuel orders despite saved IDs.
  for (const stationID of config.hubStationIDs) {
    for (const fuel of config.fuelSeeds) {
      const result = await service._processFuelSeed({stationID}, fuel, existing, Date.now());
      assert.equal(result.created, 1);
      const saved = service._state.fuelSeedByStation[`${stationID}:${fuel.typeID}`];
      assert.notEqual(saved.orderID, "62510");
    }
  }
  assert.equal(orders.size, 20);
  const reference = buildReference({sells: [{price: 100, bid: false, source: "seed"}],
    buys: [{price: 80, bid: true, source: "seed"}]}, 0.02);
  for (const stationID of config.hubStationIDs) {
    for (const item of items.filter((entry) => entry.categoryID === 6)) {
      for (const side of ["buy", "sell"]) {
        const result = await service._placeOrder({stationID}, item, side, 0, reference,
          existing, {quantityPerOrder: 10});
        assert.equal(result.created, true);
      }
    }
  }
  assert.equal(orders.size, 60, "20 fuel plus one bid/ask per mining ship at five hubs");
  for (const row of orders.values()) {
    assert.equal(row.source, "npc-passive");
    assert.equal(row.owner_id, 0);
    assert.equal(row.is_corp, false);
    assert.equal(row.quantity, config.fuelSeeds.some((fuel) => fuel.typeID === row.type_id) ? 100000 : 10);
  }

  // Nested OwnerOrderRow wire format survives reload and prevents duplicates.
  const reloaded = new Service({autoStart: false, config,
    stateStore: {load: () => service._state, save: () => {}}});
  const live = await reloaded._listExistingOrders();
  assert.equal(live.length, 60);
  calls.length = 0;
  for (const stationID of config.hubStationIDs) {
    for (const fuel of config.fuelSeeds) {
      assert.equal((await reloaded._processFuelSeed({stationID}, fuel, live, Date.now())).skipped, 1);
    }
    for (const item of items.filter((entry) => entry.categoryID === 6)) {
      for (const side of ["buy", "sell"]) {
        assert.equal((await reloaded._placeOrder({stationID}, item, side, 0, reference,
          live, {quantityPerOrder: 10})).created, false);
      }
    }
  }
  assert.equal(calls.length, 0);

  // The generic/resource paths and temporary buyback bid also use native NPCs.
  const item = {typeID: 1230, volume: 0.1};
  for (const side of ["buy", "sell"]) {
    await service._placeOrder({stationID: 60003760}, item, side, 0, reference, existing);
    assert.equal([...orders.values()].at(-1).source, "npc-passive");
  }
  const playerOrder = {order_id: "62510", owner_id: 90000001, is_corp: false,
    source: "player", state: "open", bid: false, station_id: 60008494,
    region_id: 10000043, type_id: 1230, vol_remaining: 100, price: 90};
  orders.set(playerOrder.order_id, playerOrder);
  await service._settlePlayerSellOrderWithNpc({stationID: 60008494}, item, playerOrder, 5);
  assert.equal(crossingCalls.length, 1);
  const temporary = [...orders.values()].at(-1);
  assert.equal(temporary.source, "npc-passive");
  assert.equal(temporary.bid, true);
  assert.equal(temporary.state, "cancelled");
  assert.equal(playerOrder.source, "player");
  assert.equal((await service._listExistingOrders()).some((row) => row.order_id === "62510"), false,
    "reused IDs never adopt genuine player orders");

  // Older-daemon owner-0 player orders are adopted into the tracked snapshot.
  capabilities = ["idempotent-fill-v1"];
  await service._ensureDaemonSupport();
  const fallbackPlacement = await service._placeOrder(
    {stationID: 60003760},
    {typeID: 1231, name: "fallback item", volume: 1},
    "sell", 0, reference, [], {quantityPerOrder: 10},
  );
  assert.equal(fallbackPlacement.created, true);
  assert.equal([...orders.values()].at(-1).source, "player");
  orders.set("77", {...playerOrder, order_id: "77", owner_id: 0});
  const legacyManaged = await service._listExistingOrders();
  assert(legacyManaged.some((row) => row.order_id === "77"));
  assert.equal(service.getStatus().managedOrderCount, legacyManaged.length);
  assert.throws(() => normalizeOwnerOrders(null), /Invalid GetOwnerOrders/);

  // The loader bridges only cached managed IDs and adds no per-book owner scan.
  const managerPath = serverPath("services/serviceManager.js");
  class Manager {
    lookup() { return this.service; }
    register(value) { this.service = value; }
  }
  const fakeModule = {_resolveFilename: (request) => request, _load: () => Manager};
  const originalCall = marketDaemonClient.call;
  const loader = loadModule(path.resolve(__dirname, "../loader.js"), {
    ...imports, "node:module": fakeModule,
    [path.resolve(__dirname, "../lib/npcMarketLiquidityService.js")]: Service,
  });
  assert.equal(loader.version, "0.6.4");
  const HookedManager = fakeModule._load(managerPath);
  assert.equal(Object.getPrototypeOf(HookedManager), Manager);
  assert.notEqual(marketDaemonClient.call, originalCall);
  calls.length = 0;
  const book = await marketDaemonClient.call("GetOrders", {type_id: 1230});
  assert.deepEqual(calls.map((call) => call.method), ["GetOrders"]);
  assert.equal(book.sells.find((row) => row.order_id === "77").source, "npc-passive");
  assert.equal(book.sells.find((row) => row.order_id === "62510").source, "player");
  assert.equal(service.getStatus().compatibilityMode, "cached-managed-order-bridge");
  console.log("NPC market regressions passed: native/fallback capabilities, tracked-order bridge, hubs, ships, buyback, and reload");
}

main().catch((error) => {console.error(error); process.exitCode = 1;});
