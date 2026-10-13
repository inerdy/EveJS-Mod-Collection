"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createBridgeState,
  withActiveShipOverride,
} = require("../lib/npcMiningWingDroneState");

test("drone active-ship overrides restore after overlapping async work", async () => {
  const state = createBridgeState();
  let releaseFirst;
  let releaseSecond;
  const first = withActiveShipOverride(
    state,
    42,
    {itemID: 100},
    () => new Promise((resolve) => {
      releaseFirst = resolve;
    }),
  );
  const second = withActiveShipOverride(
    state,
    42,
    {itemID: 200},
    () => new Promise((resolve) => {
      releaseSecond = resolve;
    }),
  );

  assert.equal(state.activeShipOverrides.get("42").itemID, 200);
  releaseFirst("first");
  assert.equal(await first, "first");
  assert.equal(state.activeShipOverrides.get("42").itemID, 200);
  releaseSecond("second");
  assert.equal(await second, "second");
  assert.equal(state.activeShipOverrides.has("42"), false);
  assert.equal(state.activeShipOverrideStacks.has("42"), false);
});

test("drone active-ship overrides restore after callback errors", () => {
  const state = createBridgeState();
  assert.throws(
    () => withActiveShipOverride(state, 42, {itemID: 100}, () => {
      throw new Error("expected");
    }),
    /expected/u,
  );
  assert.equal(state.activeShipOverrides.has("42"), false);
  assert.equal(state.activeShipOverrideStacks.has("42"), false);
});
