"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearCollectionTripRetry,
  deferCollectionTrip,
  markCollectionUnavailableStates,
  miningHandoffIsReady,
  nextRuntimeFailure,
  runtimeFailureIsCoolingDown,
  serializePersistentMiningStates,
  serializePersistentState,
} = require("../lib/npcMiningWingState");

test("collection-unavailable status is applied only to mining ships", () => {
  const character = {
    collectionShipID: 300,
    deployedShipIDs: [100, 200, 300],
    miningShipStates: {
      "100": {status: "mining", lastError: "", nextCycleAtMs: 0},
      "200": {status: "searching", lastError: "", nextCycleAtMs: 0},
      "300": {status: "mining", lastError: "", nextCycleAtMs: 0},
    },
  };

  assert.equal(markCollectionUnavailableStates(character, 1_000, 1_000), true);
  assert.deepEqual(character.miningShipStates["100"], {
    status: "cargo-waiting",
    lastError: "NPC_WING_COLLECTION_UNAVAILABLE",
    nextCycleAtMs: 2_000,
  });
  assert.deepEqual(character.miningShipStates["200"], {
    status: "cargo-waiting",
    lastError: "NPC_WING_COLLECTION_UNAVAILABLE",
    nextCycleAtMs: 2_000,
  });
  assert.deepEqual(character.miningShipStates["300"], {
    status: "mining",
    lastError: "",
    nextCycleAtMs: 0,
  });
  assert.equal(markCollectionUnavailableStates(character, 1_500, 1_000), false);
});

test("runtime failures use bounded exponential backoff and log throttling", () => {
  const first = nextRuntimeFailure(null, new Error("boom"), 1_000);
  assert.equal(first.count, 1);
  assert.equal(first.backoffMs, 1_000);
  assert.equal(first.shouldLog, true);
  assert.equal(runtimeFailureIsCoolingDown(first, 1_500), true);

  const second = nextRuntimeFailure(first, new Error("boom"), 1_500);
  assert.equal(second.count, 2);
  assert.equal(second.backoffMs, 2_000);
  assert.equal(second.shouldLog, false);

  const changed = nextRuntimeFailure(second, new Error("different"), 1_600);
  assert.equal(changed.count, 3);
  assert.equal(changed.shouldLog, true);
  assert.equal(runtimeFailureIsCoolingDown(changed, changed.nextRetryAtMs), false);
});

test("persistent state omits runtime-only mining deadlines", () => {
  const serialized = serializePersistentState({
    schemaVersion: 2,
    characters: {
      "42": {
        miningShipStates: {
          "100": {
            status: "mining",
            targetID: 200,
            nextCycleAtMs: 1234,
          },
        },
        followTransit: {
          "100": {readyAtMs: 5678},
        },
      },
    },
  });
  const snapshot = JSON.parse(serialized);
  assert.equal(snapshot.characters["42"].miningShipStates["100"].nextCycleAtMs, undefined);
  assert.equal(snapshot.characters["42"].followTransit["100"].readyAtMs, 5678);
});

test("persistent mining comparisons ignore scheduler deadlines", () => {
  const miningStates = {
    "100": {
      status: "mining",
      targetID: 200,
      nextCycleAtMs: 1234,
    },
  };
  const first = serializePersistentMiningStates(miningStates);
  miningStates["100"].nextCycleAtMs = 5678;
  assert.equal(serializePersistentMiningStates(miningStates), first);
  miningStates["100"].status = "cargo-waiting";
  assert.notEqual(serializePersistentMiningStates(miningStates), first);
});

test("collection-trip retries are durable and reset after progress", () => {
  const trip = {
    failureCount: 2,
    lastError: "OLD_ERROR",
    readyAtMs: 0,
  };
  assert.equal(
    deferCollectionTrip(trip, 10_000, 4_000, "NPC_WING_COLLECTION_ROUTE_UNAVAILABLE"),
    true,
  );
  assert.deepEqual(trip, {
    failureCount: 3,
    lastError: "NPC_WING_COLLECTION_ROUTE_UNAVAILABLE",
    readyAtMs: 14_000,
  });
  assert.equal(clearCollectionTripRetry(trip), true);
  assert.deepEqual(trip, {
    failureCount: 0,
    lastError: "",
    readyAtMs: 14_000,
  });
  assert.equal(clearCollectionTripRetry(trip), false);
});

test("mining cargo handoff honors its retry deadline", () => {
  assert.equal(
    miningHandoffIsReady({nextCycleAtMs: 5_000}, 4_999),
    false,
  );
  assert.equal(
    miningHandoffIsReady({nextCycleAtMs: 5_000}, 5_000),
    true,
  );
  assert.equal(miningHandoffIsReady({nextCycleAtMs: 0}, 4_999), true);
  assert.equal(miningHandoffIsReady(null, 4_999), true);
});
