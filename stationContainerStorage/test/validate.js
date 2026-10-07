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
assert.equal(manifest.id, "stationcontainerstorage");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.equal(manifest.clientMenu, undefined);

const loader = read("loader.js");
assert.match(loader, /invBrokerService\.js/u);
assert.match(loader, /_calculateCapacity/u);
assert.match(loader, /17366/u);
assert.match(loader, /UNLIMITED_CAPACITY/u);
assert.doesNotMatch(loader, /server[\\/]src[\\/]services[\\/]inventory[\\/]invBrokerService\.js.*write/u);

const readme = read("README.md");
assert.match(readme, /Station Container/u);
assert.match(readme, /17366/u);
assert.match(readme, /corporation hangar/u);
assert.match(readme, /Game server/u);

const stationContainerStorage = require(path.join(modRoot, "loader.js"));
assert.equal(stationContainerStorage.id, "stationcontainerstorage");
assert.equal(stationContainerStorage.active, true);
assert.equal(
  stationContainerStorage._testing.STATION_CONTAINER_TYPE_ID,
  17366,
);

const {
  isStationContainerAtCurrentStation,
  rewriteCapacityResult,
  UNLIMITED_CAPACITY,
} = stationContainerStorage._testing;
const personalBroker = {
  _getStationId() {
    return 60000001;
  },
};
assert.equal(
  isStationContainerAtCurrentStation(
    personalBroker,
    {},
    {kind: "container", inventoryID: 9001},
    {typeID: 17366, flagID: 4, locationID: 60000001},
  ),
  true,
);
assert.equal(
  isStationContainerAtCurrentStation(
    personalBroker,
    {},
    {kind: "container", inventoryID: 9001},
    {typeID: 17366, flagID: 4, locationID: 60000002},
  ),
  false,
);
assert.equal(
  isStationContainerAtCurrentStation(
    personalBroker,
    {},
    {kind: "container", inventoryID: 9001},
    {typeID: 17365, flagID: 4, locationID: 60000001},
  ),
  false,
);

const corporateBroker = {
  _getStationId() {
    return 60000001;
  },
  _getCorporationOfficeDivisionAncestorContext() {
    return {accessAllowed: true, stationID: 60000001};
  },
};
assert.equal(
  isStationContainerAtCurrentStation(
    corporateBroker,
    {},
    {kind: "container", inventoryID: 9002},
    {typeID: 17366, flagID: 115, locationID: 60000001},
  ),
  true,
);

const originalCapacity = {
  type: "object",
  name: "util.KeyVal",
  args: {
    type: "dict",
    entries: [["capacity", 1000000], ["used", 987654]],
  },
};
const rewrittenCapacity = rewriteCapacityResult(originalCapacity);
assert.equal(rewrittenCapacity.args.entries[0][1], UNLIMITED_CAPACITY);
assert.equal(rewrittenCapacity.args.entries[1][1], 987654);
assert.equal(originalCapacity.args.entries[0][1], 1000000);

const packageFiles = [];
function collect(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name === ".git") continue;
    const entryPath = path.join(directory, entry.name);
    const entryPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(entryPath, entryPrefix);
    else packageFiles.push(entryPrefix.replace(/\\/g, "/"));
  }
}
collect(modRoot);
assert.deepEqual(packageFiles.sort(), [
  "README.md",
  "evejs-launcher.mod.json",
  "loader.js",
  "test/validate.js",
]);

console.log("Station Container Storage manifest, loader, and package checks passed.");
