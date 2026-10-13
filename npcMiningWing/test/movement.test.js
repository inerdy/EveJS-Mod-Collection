"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStationLaunchSpaceState,
} = require("../lib/npcMiningWingMovement");

test("station launch state uses EveJS undock geometry and separates wing lanes", () => {
  const calls = [];
  const runtime = {
    getStationUndockSpawnState(station, options) {
      calls.push({station, options});
      return {
        direction: {x: 0, y: 0, z: 2},
        position: {x: 100, y: 200, z: 300},
      };
    },
  };
  const station = {
    itemID: 600,
    solarSystemID: 30_000_142,
    position: {x: 1, y: 2, z: 3},
  };
  const ship = {itemID: 900, typeID: 1200};

  const state = buildStationLaunchSpaceState(runtime, station, ship, 2);

  assert.deepEqual(state.position, {x: 100, y: 1_200, z: 300});
  assert.deepEqual(state.targetPoint, state.position);
  assert.deepEqual(state.direction, {x: 0, y: 0, z: 1});
  assert.equal(state.systemID, 30_000_142);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    shipTypeID: 1200,
    selectionKey: 900,
    selectionStrategy: "hash",
  });
});

test("station launch state has a safe geometry fallback", () => {
  const state = buildStationLaunchSpaceState(
    null,
    {
      solarSystemID: 42,
      position: {x: 10, y: 20, z: 30},
      undockDirection: {x: 0, y: 1, z: 0},
    },
    {itemID: 9, typeID: 8},
  );

  assert.deepEqual(state.position, {x: 10, y: 8_020, z: 30});
  assert.deepEqual(state.direction, {x: 0, y: 1, z: 0});
});
