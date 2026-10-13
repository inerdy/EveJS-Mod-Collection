"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const bridge = require("../lib/npcMiningWingDroneBridge");

test("runtime export is explicitly patched even if the module-load hook is bypassed", () => {
  const originalLoad = Module._load;
  const originalConsoleLog = console.log;
  const originalTraceSetting = process.env.NPC_MINING_WING_DEFENSE_TRACE;
  const emitted = [];
  const runtime = {
    launchDronesForSession() {},
    commandEngage() {},
    commandMineRepeatedly() {},
    commandReturnBay() {},
    noteIncomingAggression() {},
  };

  try {
    delete process.env.NPC_MINING_WING_DEFENSE_TRACE;
    console.log = (line) => emitted.push(String(line));
    bridge.install();
    // Simulate another loader replacing Module._load after bridge installation.
    Module._load = originalLoad;

    assert.equal(
      bridge.patchDroneRuntime(runtime, "server/src/services/drone/droneRuntime.js"),
      runtime,
    );
    assert.equal(
      runtime[Symbol.for("evejs.npcMiningWing.droneBridgeRuntimePatched")],
      true,
    );
    assert.equal(typeof runtime.launchDronesForWingShip, "function");
    assert.equal(typeof runtime.commandMineForWingShip, "function");

    // Repeated service access must not wrap the native runtime a second time.
    const patchedMineCommand = runtime.commandMineForWingShip;
    bridge.patchDroneRuntime(runtime, "server/src/services/drone/droneRuntime.js");
    assert.equal(runtime.commandMineForWingShip, patchedMineCommand);
    assert.equal(emitted.length, 0, "defense diagnostics should default off");

    process.env.NPC_MINING_WING_DEFENSE_TRACE = "1";
    const tracedRuntime = {
      launchDronesForSession() {},
      commandEngage() {},
      commandMineRepeatedly() {},
      commandReturnBay() {},
      noteIncomingAggression() {},
    };
    bridge.patchDroneRuntime(tracedRuntime, "server/src/services/drone/droneRuntime.js");
    assert.ok(emitted.some((line) => line.includes('"status":"attached"')));
  } finally {
    Module._load = originalLoad;
    console.log = originalConsoleLog;
    if (originalTraceSetting === undefined) {
      delete process.env.NPC_MINING_WING_DEFENSE_TRACE;
    } else {
      process.env.NPC_MINING_WING_DEFENSE_TRACE = originalTraceSetting;
    }
  }
});
