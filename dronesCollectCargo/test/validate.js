"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);

function read(relativePath) {
  return fs.readFileSync(path.join(modRoot, relativePath), "utf8");
}

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "dronescollectcargo");
assert.equal(manifest.displayName, "Drones Collect Cargo");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const loader = read("loader.js");
const service = read("lib/dronesCollectCargoService.js");
const readme = read("README.md");
assert.match(loader, /serviceManager\.js/u);
assert.match(loader, /droneRuntime\.js/u);
assert.match(loader, /salvagerRuntime\.js/u);
assert.match(loader, /commandSalvage/u);
assert.match(loader, /tickScene/u);
assert.match(service, /isCargoContainerInventoryItem/u);
assert.match(service, /sessionHasSpaceLootRight/u);
assert.match(service, /INV_BROKER_OWNER_TRANSFER/u);
assert.match(service, /recallDronesToShipBay/u);
assert.match(service, /DRONE_BAY/u);
assert.match(service, /syncInventoryChangesToSession/u);
assert.match(readme, /no original EveJS source files are modified/u);

for (const relativePath of ["loader.js", "lib/dronesCollectCargoService.js"]) {
  const source = read(relativePath);
  assert.doesNotMatch(source, /OnRemoteMessage/u);
}

console.log("dronesCollectCargo validation passed");
