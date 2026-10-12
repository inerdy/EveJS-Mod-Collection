"use strict";

const assert = require("node:assert/strict");
const {createCompatibleCall, normalizeOwnerOrders} = require("../lib/marketCompatibility");
const Service = require("../lib/npcMarketLiquidityService");
const {normalizeConfig} = require("../lib/config");
const {marketDaemonClient} = require("../../../server/src/services/market/marketDaemonClient");

async function main() {
  // Match the Rust OwnerOrderRow / OrderRow wire formats, including the lack
  // of owner_id on public book rows and nested station/type/volume fields.
  const row = {order_id: "62510", source: "player", station_id: 60008494,
    type_id: 17887, bid: false, vol_remaining: 100000, price: 591.05,
    issued_at: new Date().toISOString()};
  let owners = [{order_id: row.order_id, owner_id: 0, is_corp: false,
    state: "open", source: "player", row}];
  const player = {...row, order_id: "62511"};
  const book = {sells: [row, player], buys: [{...row, bid: true}]};
  const call = createCompatibleCall(async (method) => {
    if (method === "GetOwnerOrders") return owners;
    if (method === "GetOrders") return book;
    throw new Error(`Unexpected RPC ${method}`);
  });
  const result = await call("GetOrders", {});
  assert.equal(result.sells[0].source, "npc-passive");
  assert.equal(result.buys[0].source, "npc-passive");
  assert.equal(result.sells[1].source, "player");
  assert.equal(book.sells[0].source, "player");
  // Database rebuild / ID reuse must not grant synthetic fill privileges.
  owners = [{...owners[0], owner_id: 90000001}];
  assert.equal((await call("GetOrders", {})).sells[0].source, "player");
  owners = [{...owners[0], owner_id: 0, is_corp: true}];
  assert.equal((await call("GetOrders", {})).sells[0].source, "player");
  owners = [{...owners[0], is_corp: false}];
  assert.equal(normalizeOwnerOrders(owners)[0].station_id, 60008494);
  const service = new Service({autoStart: false, config: normalizeConfig({}),
    stateStore: {load: () => ({}), save: () => {}}});
  const original = marketDaemonClient.call;
  try {
    marketDaemonClient.call = async (method) => {
      assert.equal(method, "GetOwnerOrders");
      return owners;
    };
    const existing = await service._listExistingOrders();
    assert.equal(service._fuelSeedOrders(60008494, 17887, existing).length, 1);
    const seed = await service._processFuelSeed({stationID: 60008494},
      service._config.fuelSeeds.find((entry) => entry.typeID === 17887), existing, Date.now());
    assert.equal(seed.skipped, 1);
    assert.equal(seed.created, 0);
  } finally {
    marketDaemonClient.call = original;
    service.stop();
  }
  console.log("Market compatibility regression tests passed");
}

main().catch((error) => {console.error(error); process.exitCode = 1;});
