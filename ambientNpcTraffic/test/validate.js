"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
process.env.EVEJS_ROOT = process.env.EVEJS_ROOT || path.resolve(modRoot, "..", "..", "EveJS-v0.12.9");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const config = JSON.parse(
  fs.readFileSync(path.join(modRoot, "config", "traffic.json"), "utf8"),
);
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const routeEngine = require(path.join(modRoot, "lib", "routeEngine"));
const haulerCargo = require(path.join(modRoot, "lib", "haulerCargo"));
const runtime = require(path.join(modRoot, "lib", "runtime"));
assert.equal(runtime.REPO_ROOT, process.env.EVEJS_ROOT);
const serviceClass = require(path.join(modRoot, "lib", "ambientNpcTrafficService"));

const packageFiles = [];
function collectFiles(directory, prefix) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name === ".git") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    const entryPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(entryPath, entryPrefix);
    } else {
      packageFiles.push(entryPrefix.replace(/\\/gu, "/"));
    }
  }
}
collectFiles(modRoot, "");

assert.deepEqual(packageFiles.sort(), [
  "LICENSE",
  "README.md",
  "config/traffic.json",
  "evejs-launcher.mod.json",
  "lib/ambientNpcTrafficService.js",
  "lib/cargoOps.js",
  "lib/config.js",
  "lib/constants.js",
  "lib/haulerCargo.js",
  "lib/hooks.js",
  "lib/routeEngine.js",
  "lib/runtime.js",
  "lib/trafficFx.js",
  "lib/util.js",
  "lib/wreckLoot.js",
  "loader.js",
  "test/validate.js",
]);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "ambientnpctraffic");
assert.equal(manifest.displayName, "Ambient NPC Traffic");
assert.equal(manifest.version, "0.1.1");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["261018.1"]);

const normalizedConfig = normalizeConfig(config);
assert.equal(normalizedConfig.enabled, true);
assert.equal(normalizedConfig.shipsPerActiveSystem, 4);
assert.equal(normalizedConfig.initialShipsPerActiveSystem, 3);
assert.equal(normalizedConfig.maxShipsPerSystem, 8);
assert.equal(normalizedConfig.maxShipsGlobal, 100);
assert.ok(normalizedConfig.profileIDs.length >= 3);
assert.equal(
  normalizedConfig.profileIDs.includes("parity_mission_generic_40574_toms_shuttle"),
  false,
);
assert.equal(normalizedConfig.gateApproachDistanceMeters, 15000);
assert.equal(normalizedConfig.gateJumpRangeMeters, 2500);
assert.equal(normalizedConfig.gateExitDelayMs, 20000);
assert.ok(normalizedConfig.crossSystemChance > 0);
assert.equal(routeEngine.isHaulerProfile("ore_mining_bestower_hauler"), true);
assert.equal(routeEngine.isHaulerProfile("parity_mission_generic_40574_toms_shuttle"), false);
assert.equal(
  routeEngine.chooseGateLanding("ambient-test-gate"),
  routeEngine.chooseGateLanding("ambient-test-gate"),
);
const gateLandings = new Set();
for (let index = 0; index < 32; index += 1) {
  gateLandings.add(routeEngine.chooseGateLanding(`ambient-test-gate-${index}`));
}
assert.deepEqual([...gateLandings].sort(), ["approach", "jump"]);
assert.equal(
  routeEngine.canStartWarp({x: 0, y: 0, z: 0}, {x: 200000, y: 0, z: 0}),
  true,
);
assert.equal(
  routeEngine.canStartWarp({x: 0, y: 0, z: 0}, {x: 15000, y: 0, z: 0}),
  false,
);
assert.equal(
  routeEngine.isWithinGateJumpRange(
    {x: 16000, y: 0, z: 0},
    {x: 0, y: 0, z: 0},
    15000,
    2500,
  ),
  true,
);
assert.equal(
  routeEngine.isWithinGateJumpRange(
    {x: 40000, y: 0, z: 0},
    {x: 0, y: 0, z: 0},
    15000,
    2500,
  ),
  false,
);

const staticEntities = [
  {
    kind: "station",
    itemID: 1001,
    itemName: "Test Station",
    position: {x: 0, y: 0, z: 0},
  },
  {
    kind: "stargate",
    itemID: 2001,
    itemName: "Gate to Test",
    position: {x: 100000, y: 0, z: 0},
    destinationID: 3001,
    destinationSolarSystemID: 30000002,
  },
  {
    kind: "planet",
    itemID: 4001,
    itemName: "Test Planet",
    position: {x: 200000, y: 0, z: 0},
  },
];

const localRoute = routeEngine.buildRoutePlan({
  systemID: 30000001,
  staticEntities,
  seed: "ambient-test-local",
  crossSystemChance: 0,
});
assert.ok(localRoute);
assert.equal(localRoute.routeKind, "local");
assert.equal(localRoute.systemID, 30000001);
assert.equal(localRoute.destinationSystemID, 30000001);

const crossRoute = routeEngine.buildRoutePlan({
  systemID: 30000001,
  staticEntities,
  seed: "ambient-test-cross",
  crossSystemChance: 1,
});
assert.ok(crossRoute);
assert.equal(crossRoute.routeKind, "cross-system");
assert.equal(crossRoute.destinationSystemID, 30000002);
assert.equal(crossRoute.destinationAnchorID, 2001);
assert.equal(crossRoute.destinationGateID, 3001);

const repeatedRoute = routeEngine.buildRoutePlan({
  systemID: 30000001,
  staticEntities,
  seed: "ambient-test-cross",
  crossSystemChance: 1,
});
assert.deepEqual(repeatedRoute, crossRoute);

const approachPoint = routeEngine.buildApproachPoint(
  staticEntities[0],
  "ambient-test-point",
  10000,
);
assert.ok(Number.isFinite(approachPoint.x));
assert.ok(Number.isFinite(approachPoint.y));
assert.ok(Number.isFinite(approachPoint.z));
assert.ok(routeEngine.distanceSquared(approachPoint, staticEntities[0].position) > 0);

const jumpOrigin = {x: 900000, y: -40000, z: 12000};
const jumpLandings = [];
for (let index = 0; index < 12; index += 1) {
  const gateRadius = 15000;
  const landing = routeEngine.buildGateJumpLandingPoint(
    {position: {x: 0, y: 0, z: 0}},
    `ambient-test-jump-${index}`,
    gateRadius,
    jumpOrigin,
  );
  jumpLandings.push(landing);
  const centerDistance = Math.hypot(landing.x, landing.y, landing.z);
  const surfaceDistance = centerDistance - gateRadius;
  assert.ok(surfaceDistance >= routeEngine.GATE_JUMP_LANDING_MIN_METERS);
  assert.ok(surfaceDistance <= routeEngine.GATE_JUMP_LANDING_MAX_METERS);
  assert.equal(
    routeEngine.isWithinGateJumpRange(landing, {x: 0, y: 0, z: 0}, gateRadius, 2500),
    true,
  );
  const cross = Math.hypot(
    (landing.y * jumpOrigin.z) - (landing.z * jumpOrigin.y),
    (landing.z * jumpOrigin.x) - (landing.x * jumpOrigin.z),
    (landing.x * jumpOrigin.y) - (landing.y * jumpOrigin.x),
  );
  assert.ok(cross / (centerDistance * Math.hypot(jumpOrigin.x, jumpOrigin.y, jumpOrigin.z)) < 0.000001);
  assert.ok((landing.x * jumpOrigin.x) + (landing.y * jumpOrigin.y) + (landing.z * jumpOrigin.z) > 0);
}
assert.equal(
  jumpLandings.some((landing, index) => (
    index > 0 && Math.hypot(
      landing.x - jumpLandings[0].x,
      landing.y - jumpLandings[0].y,
      landing.z - jumpLandings[0].z,
    ) > 1
  )),
  true,
);
const approachExits = [];
for (let index = 0; index < 8; index += 1) {
  const gateRadius = 15000;
  const exitPoint = routeEngine.buildInlineGateExitPoint(
    jumpOrigin,
    {x: 0, y: 0, z: 0},
    gateRadius,
    {
      chosenSurfaceMeters: 15000,
      minSurfaceMeters: 13000,
      maxSurfaceMeters: 15000,
      seed: `ambient-test-approach-exit-${index}`,
    },
  );
  approachExits.push(exitPoint);
  const surfaceDistance = Math.hypot(exitPoint.x, exitPoint.y, exitPoint.z) - gateRadius;
  const offsetFromChosen = 15000 - surfaceDistance;
  assert.ok(offsetFromChosen >= routeEngine.WARP_EXIT_SCATTER_MIN_METERS - 0.01);
  assert.ok(offsetFromChosen <= routeEngine.WARP_EXIT_SCATTER_MAX_METERS + 0.01);
  assert.ok(surfaceDistance <= 15000);
}
assert.equal(
  approachExits.some((exitPoint, index) => (
    index > 0 && Math.hypot(
      exitPoint.x - approachExits[0].x,
      exitPoint.y - approachExits[0].y,
      exitPoint.z - approachExits[0].z,
    ) > 1
  )),
  true,
);

const cargoTypes = haulerCargo.listCargoTypes([
  {typeID: 34, groupID: 18, categoryID: 4, name: "Tritanium", volume: 0.01, published: true},
  {typeID: 35, groupID: 18, categoryID: 4, name: "Pyerite", volume: 0.01, published: true},
  {typeID: 36, groupID: 18, categoryID: 4, name: "Mexallon", volume: 0.01, published: true},
  {typeID: 38, groupID: 18, categoryID: 4, name: "Nocxium", volume: 0.01, published: true},
  {typeID: 11399, groupID: 18, categoryID: 4, name: "Morphite", volume: 0.01, published: true},
  {typeID: 2267, groupID: 1032, categoryID: 42, name: "Base Metals", volume: 0.01, published: true},
  {typeID: 2268, groupID: 1033, categoryID: 42, name: "Aqueous Liquids", volume: 0.01, published: true},
  {typeID: 2393, groupID: 1042, categoryID: 43, name: "Bacteria", volume: 0.38, published: true},
  {typeID: 2312, groupID: 1034, categoryID: 43, name: "Supertensile Plastics", volume: 0.75, published: true},
  {typeID: 34, groupID: 18, categoryID: 4, name: "Limited Time Tritanium", volume: 0.01, published: true, metaGroupID: 14},
  {typeID: 999001, groupID: 18, categoryID: 4, name: "Unpublished Mineral", volume: 0.01, published: false},
]);
assert.equal(cargoTypes.minerals.length, 3);
assert.equal(cargoTypes.planetary.length, 3);
assert.equal(cargoTypes.minerals.some((entry) => entry.typeID === 38), false);
assert.equal(cargoTypes.planetary.some((entry) => entry.groupID === 1034), false);
assert.equal(haulerCargo.isTimeLimitedItem({name: "Tritanium", metaGroupID: 14}), true);
const cargo = haulerCargo.buildHaulerCargo({
  seed: "ambient-test-cargo",
  capacityM3: haulerCargo.resolveCargoCapacityM3([0, null], 4800),
  mineralTypes: cargoTypes.minerals,
  planetaryTypes: cargoTypes.planetary,
});
const mineralStacks = cargo.filter((stack) => stack.groupID === 18);
const planetaryStacks = cargo.filter((stack) => [42, 43].includes(stack.categoryID));
assert.equal(mineralStacks.length > 0 && planetaryStacks.length > 0, false);
assert.ok(mineralStacks.length > 0 || planetaryStacks.length > 0);
assert.ok(mineralStacks.length <= 2);
assert.ok(cargo.every((stack) => (
  haulerCargo.HIGH_SEC_MINERAL_TYPE_IDS.includes(stack.typeID) ||
  haulerCargo.isPlanetaryP0OrP1(stack)
)));
assert.ok(cargo.every((stack) => stack.quantity > 0 && stack.flagID === haulerCargo.CARGO_FLAG_ID));
assert.ok(haulerCargo.cargoVolumeM3(cargo) <= 4800);
assert.deepEqual(
  cargo,
  haulerCargo.buildHaulerCargo({
    seed: "ambient-test-cargo",
    capacityM3: 4800,
    mineralTypes: cargoTypes.minerals,
    planetaryTypes: cargoTypes.planetary,
  }),
);

assert.equal(routeEngine.isWarpEntryReady({
  position: {x: 0, y: 0, z: 0},
  maxVelocity: 100,
  velocity: {x: 80, y: 0, z: 0},
}, {x: 1000000, y: 0, z: 0}), true);
assert.equal(routeEngine.isWarpEntryReady({
  position: {x: 0, y: 0, z: 0},
  maxVelocity: 100,
  velocity: {x: 20, y: 0, z: 0},
}, {x: 1000000, y: 0, z: 0}), false);
assert.equal(routeEngine.isWarpEntryReady({
  position: {x: 0, y: 0, z: 0},
  maxVelocity: 100,
  velocity: {x: 0, y: 90, z: 0},
}, {x: 1000000, y: 0, z: 0}), false);

const gateCenter = {x: 1000, y: 2000, z: -500};
const warpOrigin = {x: 1000 + 800000, y: 2000 + 120000, z: -500 - 40000};
const gateRadius = 15000;
const inlineLanding = routeEngine.buildInlineApproachPoint(
  warpOrigin,
  gateCenter,
  gateRadius + 15000,
);
const inlineOffset = {
  x: inlineLanding.x - gateCenter.x,
  y: inlineLanding.y - gateCenter.y,
  z: inlineLanding.z - gateCenter.z,
};
const inbound = {
  x: warpOrigin.x - gateCenter.x,
  y: warpOrigin.y - gateCenter.y,
  z: warpOrigin.z - gateCenter.z,
};
const inboundLength = Math.hypot(inbound.x, inbound.y, inbound.z);
const offsetLength = Math.hypot(inlineOffset.x, inlineOffset.y, inlineOffset.z);
const cross = Math.hypot(
  (inlineOffset.y * inbound.z) - (inlineOffset.z * inbound.y),
  (inlineOffset.z * inbound.x) - (inlineOffset.x * inbound.z),
  (inlineOffset.x * inbound.y) - (inlineOffset.y * inbound.x),
);
assert.ok(Math.abs(offsetLength - (gateRadius + 15000)) < 0.01);
assert.ok(cross / (offsetLength * inboundLength) < 0.000001);
assert.ok((inlineOffset.x * inbound.x) + (inlineOffset.y * inbound.y) + (inlineOffset.z * inbound.z) > 0);

const nullVolumeTypes = haulerCargo.listCargoTypes([
  {typeID: 34, groupID: 18, categoryID: 4, name: "Tritanium", volume: null, published: true},
  {typeID: 2267, groupID: 1032, categoryID: 42, name: "Base Metals", published: true},
]);
assert.equal(nullVolumeTypes.minerals.length, 1);
assert.equal(nullVolumeTypes.planetary.length, 1);
const nullVolumeCargo = haulerCargo.buildHaulerCargo({
  seed: "ambient-test-null-volume",
  capacityM3: 4800,
  mineralTypes: nullVolumeTypes.minerals,
  planetaryTypes: nullVolumeTypes.planetary,
});
assert.ok(nullVolumeCargo.length > 0);
assert.ok(haulerCargo.cargoVolumeM3(nullVolumeCargo) <= 4800);
const wreckLoot = haulerCargo.buildWreckLootRecord({
  wreckID: 77,
  ownerID: 5,
  transient: true,
}, nullVolumeCargo[0], 88001);
assert.equal(wreckLoot.wreckItemID, 88001);
assert.equal(wreckLoot.wreckID, 77);
assert.equal(wreckLoot.locationID, 77);
assert.equal(wreckLoot.flagID, haulerCargo.WRECK_HANGAR_FLAG_ID);
assert.equal(wreckLoot.quantity, nullVolumeCargo[0].quantity);
assert.equal(wreckLoot.singleton, false);
assert.equal(wreckLoot.transient, true);

const pointEffects = new Map([
  ["scram", {family: routeEngine.WARP_SCRAMBLER_FAMILY, rangeMultiplier: 1, scrambleStrength: 2}],
  ["disrupt", {family: routeEngine.WARP_DISRUPTOR_FAMILY, rangeMultiplier: 1, scrambleStrength: 1}],
  ["out", {family: routeEngine.WARP_DISRUPTOR_FAMILY, rangeMultiplier: 0, scrambleStrength: 1}],
]);
assert.deepEqual(
  routeEngine.listActiveWarpPointFamilies(pointEffects),
  [routeEngine.WARP_SCRAMBLER_FAMILY, routeEngine.WARP_DISRUPTOR_FAMILY],
);
assert.equal(routeEngine.warpDepartureDenial({
  families: [routeEngine.WARP_SCRAMBLER_FAMILY],
  hasWarpCoreStabilizer: true,
}), "scram");
assert.equal(routeEngine.warpDepartureDenial({
  families: [routeEngine.WARP_DISRUPTOR_FAMILY],
  hasWarpCoreStabilizer: false,
}), "disrupt");
assert.equal(routeEngine.warpDepartureDenial({
  families: [routeEngine.WARP_DISRUPTOR_FAMILY],
  hasWarpCoreStabilizer: true,
}), null);
assert.equal(routeEngine.warpDepartureDenial({
  families: [routeEngine.WARP_DISRUPTOR_FAMILY],
  hasWarpCoreStabilizer: true,
  inBubble: true,
}), "bubble");
assert.equal(routeEngine.warpDepartureDenial({
  microwarpdriveBlocked: true,
  hasWarpCoreStabilizer: true,
}), "scram");
const stabilizerRolls = new Set();
for (let index = 0; index < 32; index += 1) {
  const roll = routeEngine.shipHasWarpCoreStabilizer(`ambient-stab-${index}`);
  assert.equal(roll, routeEngine.shipHasWarpCoreStabilizer(`ambient-stab-${index}`));
  stabilizerRolls.add(roll);
}
assert.deepEqual([...stabilizerRolls].sort(), [false, true]);

assert.equal(serviceClass._testing.entityIsWarping({mode: "WARP"}), true);
assert.equal(serviceClass._testing.entityIsWarping({mode: "STOP"}), false);
assert.equal(
  serviceClass._testing.isActiveScene({
    systemID: 30000001,
    sceneKind: "solarSystem",
    sessions: new Map([[1, {}]]),
  }),
  true,
);

console.log("Ambient NPC Traffic manifest, configuration, route, and package checks passed.");
