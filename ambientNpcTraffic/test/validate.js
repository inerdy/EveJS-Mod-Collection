"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const config = JSON.parse(
  fs.readFileSync(path.join(modRoot, "config", "traffic.json"), "utf8"),
);
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const routeEngine = require(path.join(modRoot, "lib", "routeEngine"));
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
  "lib/config.js",
  "lib/routeEngine.js",
  "loader.js",
  "test/validate.js",
]);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "ambientnpctraffic");
assert.equal(manifest.displayName, "Ambient NPC Traffic");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const normalizedConfig = normalizeConfig(config);
assert.equal(normalizedConfig.enabled, true);
assert.equal(normalizedConfig.shipsPerActiveSystem, 4);
assert.equal(normalizedConfig.initialShipsPerActiveSystem, 3);
assert.equal(normalizedConfig.maxShipsPerSystem, 8);
assert.equal(normalizedConfig.maxShipsGlobal, 100);
assert.ok(normalizedConfig.profileIDs.length >= 3);
assert.ok(normalizedConfig.crossSystemChance > 0);

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
