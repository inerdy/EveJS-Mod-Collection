"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const {createTrace, install} = require("../lib/npcMiningWingMiningTrace");
const {createCompatibility} = require("../lib/npcMiningWingMiningCompatibility");

function fixture() {
  let time = 10000;
  const records = [];
  const trace = createTrace({now: () => time, emit: (line) => records.push(JSON.parse(line.slice(line.indexOf("{"))))});
  const entity = {itemID: 200, ownerID: 42, pilotCharacterID: 42,
    kind: "ship", npcMiningWingController: true, activeModuleEffects: new Map()};
  return {trace, entity, records, advance: () => { time += 11000; }};
}

test("preparation failure logs both sides even when execution and grant never run", () => {
  const {trace, entity, records} = fixture();
  const failure = {success: false, stopReason: "module"};
  const runtime = {prepareMiningCycleBoundary: () => failure, executeMiningCycle: () => assert.fail("must not execute")};
  trace.patch("services/mining/miningRuntime.js", runtime);
  assert.equal(runtime.prepareMiningCycleBoundary(entity, {moduleID: 10}, 123), failure);
  trace.heartbeat();
  assert.deepEqual(records.filter((r) => r.event.startsWith("prepare.")).map((r) => r.event), ["prepare.before", "prepare.after"]);
  assert.equal(records.find((r) => r.event === "prepare.after").stopReason, "module");
  assert.deepEqual(records.find((r) => r.event === "heartbeat").calls, {prepare: 1, cycle: 0, grant: 0});
});

test("raw missing, null and zero identities remain distinguishable", () => {
  const {trace, entity, records} = fixture();
  const runtime = {prepareMiningCycleBoundary: () => ({success: true}), executeMiningCycle: () => ({success: true})};
  trace.patch("services/mining/miningRuntime.js", runtime);
  for (const value of [undefined, null, 0]) {
    entity.characterID = value;
    runtime.prepareMiningCycleBoundary(entity, {}, 123);
  }
  const ids = records.filter((r) => r.event === "prepare.before").map((r) => r.identity);
  assert.deepEqual(ids.map((r) => r.characterID), ["<undefined>", "<null>", 0]);
  assert.deepEqual(ids.map((r) => r.predictedNativeCharacterID), [42, 42, 0]);
});

test("captured native dependencies report actual selected ship and failed grant", () => {
  const {trace, entity, records} = fixture();
  const store = {
    grantItemsToCharacterLocation: () => ({success: false, errorMsg: "CHARACTER_NOT_FOUND"}),
    moveItemToLocation: () => ({}), listContainerItems: () => [],
  };
  const character = {getActiveShipRecord: () => ({itemID: 999, ownerID: 42})};
  trace.patch("services/inventory/itemStore.js", store);
  trace.patch("services/character/characterState.js", character);
  // Native modules destructure these functions at load: patch them first.
  const {grantItemsToCharacterLocation} = store;
  const {getActiveShipRecord} = character;
  const response = {success: false, stopReason: "cargo"};
  const runtime = {
    prepareMiningCycleBoundary: () => ({}),
    executeMiningCycle() {
      getActiveShipRecord(42);
      grantItemsToCharacterLocation(0, 200, 134, [{itemType: 1230, quantity: 828}]);
      return response;
    },
  };
  trace.patch("services/mining/miningRuntime.js", runtime);
  assert.equal(runtime.executeMiningCycle({}, entity, {moduleID: 10}, 123), response);
  const before = records.find((r) => r.event === "cycle.before");
  const after = records.find((r) => r.event === "cycle.after");
  assert.equal(before.trace, after.trace);
  assert.equal(records.find((r) => r.event === "grant.before").parent, before.trace);
  assert.equal(records.find((r) => r.event === "activeShipLookup.after").item.itemID, 999);
  assert.equal(records.find((r) => r.event === "grant.after").error, "CHARACTER_NOT_FOUND");
  assert.deepEqual(after.inventory, {count: 0, rows: []});
});

test("successful grant shows unfiltered inventory changes without changing result", () => {
  const {trace, entity, records} = fixture();
  const rows = [];
  const store = {
    listContainerItems(owner, ship) { assert.equal(owner, null); assert.equal(ship, 200); return rows; },
    moveItemToLocation: () => ({}),
    grantItemsToCharacterLocation() {
      rows.push({itemID: 300, ownerID: 42, locationID: 200, flagID: 134, typeID: 1230, quantity: 828});
      return {success: true, data: {changes: [{item: rows[0]}]}};
    },
  };
  trace.patch("services/inventory/itemStore.js", store);
  const runtime = {prepareMiningCycleBoundary: () => ({}), executeMiningCycle() {
    store.grantItemsToCharacterLocation(42, 200, 134, []);
    return {success: true, data: {transferredQuantity: 828}};
  }};
  trace.patch("services/mining/miningRuntime.js", runtime);
  assert.equal(runtime.executeMiningCycle({}, entity, {}, 123).data.transferredQuantity, 828);
  assert.equal(records.find((r) => r.event === "cycle.before").inventory.count, 0);
  assert.equal(records.find((r) => r.event === "cycle.after").inventory.rows[0].quantity, 828);
});

test("original exceptions propagate and diagnostics failures cannot break gameplay", () => {
  const {trace, entity, records} = fixture();
  const failure = new Error("native failure");
  const runtime = {prepareMiningCycleBoundary() { throw failure; }, executeMiningCycle: () => true};
  trace.patch("services/mining/miningRuntime.js", runtime);
  assert.throws(() => runtime.prepareMiningCycleBoundary(entity, {}, 123), (e) => e === failure);
  assert.equal(records.find((r) => r.event === "prepare.throw").error, failure.message);
  trace.heartbeat();
  assert.equal(records.at(-1).trace, null);
  const brokenLogger = createTrace({emit() { throw new Error("logger broken"); }});
  const result = {};
  assert.equal(brokenLogger.run("test", entity, () => { throw new Error("inspection"); }, () => result), result);
});

test("heartbeat reports no callbacks; observation detects disappearing effects and missing hive flags", () => {
  const {trace, entity, records, advance} = fixture();
  trace.heartbeat();
  assert.equal(records[0].lastRuntimeTickAt, null);
  assert.deepEqual(records[0].calls, {prepare: 0, cycle: 0, grant: 0});
  entity.activeModuleEffects.set(10, {moduleID: 10, miningEffect: true, nextCycleAtMs: 5000});
  trace.observe(null, entity);
  delete entity.npcMiningWingController;
  entity.activeModuleEffects.clear();
  trace.observe(null, entity);
  const observations = records.filter((r) => r.event === "ship.observe");
  assert.equal(observations[0].effects[0].overdueMs, 5000);
  assert.equal(observations.at(-1).effects.length, 0);
  assert.equal(trace.known(entity), true);
  advance();
  trace.heartbeat(() => ({sessions: 0}));
  assert.equal(records.at(-1).sessions, 0);
});

test("repeat installation does not duplicate logging and unrelated ships stay untraced", () => {
  const {trace, entity, records} = fixture();
  const runtime = {prepareMiningCycleBoundary: () => true, executeMiningCycle: () => true};
  trace.patch("services/mining/miningRuntime.js", runtime);
  trace.patch("services/mining/miningRuntime.js", runtime);
  runtime.prepareMiningCycleBoundary(entity, {}, 123);
  runtime.prepareMiningCycleBoundary({itemID: 999}, {}, 123);
  assert.equal(records.filter((r) => r.event === "prepare.before").length, 1);
});

test("sessionless shutdown records native stop reason before effect removal", () => {
  const {trace, entity, records} = fixture();
  const effect = {moduleID: 10, miningEffect: true};
  entity.activeModuleEffects.set(10, effect);
  const shutdown = {finalizeGenericModuleDeactivationWithoutSession(scene, ship, state) {
    ship.activeModuleEffects.delete(state.moduleID);
    return {success: true};
  }};
  trace.patch("space/runtime/moduleEffectShutdown.js", shutdown);
  shutdown.finalizeGenericModuleDeactivationWithoutSession({}, entity, effect, {reason: "capacitor", nowMs: 123});
  assert.equal(records.find((r) => r.event === "sessionlessStop.before").reason, "capacitor");
  assert.equal(records.find((r) => r.event === "sessionlessStop.after").success, true);
});

test("mining diagnostics default off without wrapping runtime modules", () => {
  const envName = "NPC_MINING_WING_MINING_TRACE";
  const previousSetting = process.env[envName];
  const originalLoad = Module._load;
  const originalConsoleLog = console.log;
  let emitted = 0;
  let detailsEvaluated = false;
  try {
    delete process.env[envName];
    console.log = () => { emitted += 1; };
    const trace = install();
    assert.equal(trace.enabled, false);
    assert.equal(Module._load, originalLoad);
    trace.log("test.event");
    trace.patch("miningRuntime", {});
    trace.heartbeat(() => { detailsEvaluated = true; return {}; });
    assert.equal(trace.run("test", {}, () => {}, () => "run-result"), "run-result");
    assert.equal(trace.shipTick({}, {}, () => {}, () => "tick-result"), "tick-result");
    assert.equal(detailsEvaluated, false);
    assert.equal(emitted, 0);
  } finally {
    console.log = originalConsoleLog;
    if (previousSetting === undefined) delete process.env[envName];
    else process.env[envName] = previousSetting;
  }
});

test("mining identity diagnostics are opt-in without disabling compatibility", () => {
  const envName = "NPC_MINING_WING_IDENTITY_TRACE";
  const previousSetting = process.env[envName];
  const emitted = [];
  try {
    delete process.env[envName];
    const compatibility = createCompatibility({
      bridgeState: {},
      findCharacterShipItem: () => null,
      emit: (line) => emitted.push(line),
    });
    compatibility.log("identity.test");
    assert.equal(emitted.length, 0);

    process.env[envName] = "1";
    compatibility.log("identity.test");
    assert.equal(emitted.length, 1);
    assert.match(emitted[0], /NPCMiningWing:MiningIdentity/u);
  } finally {
    if (previousSetting === undefined) delete process.env[envName];
    else process.env[envName] = previousSetting;
  }
});
