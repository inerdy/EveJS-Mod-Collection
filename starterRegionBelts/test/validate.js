"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const config = JSON.parse(
  fs.readFileSync(path.join(modRoot, "config", "belts.json"), "utf8"),
);
const registry = require(path.join(modRoot, "lib", "beltRegistry"));
const worldData = require(path.resolve(
  modRoot,
  "..",
  "..",
  "server",
  "src",
  "space",
  "worldData",
));

const packageFiles = [];
function collectFiles(directory, prefix) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
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
  "README.md",
  "config/belts.json",
  "evejs-launcher.mod.json",
  "lib/beltRegistry.js",
  "loader.js",
  "test/validate.js",
]);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "starterregionbelts");
assert.equal(manifest.version, "0.1.1");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const targetSystemIDs = registry.getTargetSystemIDs();
const belts = registry.getAllBelts();
assert.equal(config.regionID, 10001004);
assert.equal(targetSystemIDs.length, 53);
assert.equal(belts.length, 53);
assert.equal(new Set(targetSystemIDs).size, 53);
assert.equal(new Set(belts.map((belt) => belt.itemID)).size, 53);
assert.equal(new Set(belts.map((belt) => belt.fieldSeed)).size, 53);

const nativeBeltSystem = worldData
  .getSolarSystems()
  .find((system) => worldData.getAsteroidBeltsForSystem(system.solarSystemID).length > 0);
assert.ok(nativeBeltSystem);
const nativeBeltSystemID = nativeBeltSystem.solarSystemID;
const nativeBeltSnapshot = worldData
  .getAsteroidBeltsForSystem(nativeBeltSystemID)
  .map((belt) => ({...belt}));

const staticBeltIDs = new Set(
  worldData
    .getAsteroidBeltsForSystem(30000001)
    .map((belt) => Number(belt.itemID)),
);
for (const belt of belts) {
  assert.equal(Number(belt.regionID), config.regionID);
  assert.ok(Number(belt.itemID) > 40350399);
  assert.ok(Number(belt.itemID) < 2_147_483_648);
  assert.equal(belt.typeID, 15);
  assert.equal(belt.groupID, 9);
  assert.equal(belt.fieldStyleID, "empire_highsec_standard");
  assert.equal(belt.asteroidCount, 24);
  assert.ok(!staticBeltIDs.has(belt.itemID));
  assert.ok(Number.isSafeInteger(belt.itemID));
  assert.ok(Number.isSafeInteger(registry.buildAsteroidItemID(belt.itemID, 24)));
  assert.ok(belt.position && Number.isFinite(belt.position.x));
  assert.ok(belt.position && Number.isFinite(belt.position.y));
  assert.ok(belt.position && Number.isFinite(belt.position.z));
  assert.equal(registry.getBeltByID(belt.itemID).itemName, belt.itemName);
  assert.equal(registry.getBeltsForSystem(belt.solarSystemID).length, 1);
}

const firstSystemID = targetSystemIDs[0];
const firstBelt = registry.getBeltsForSystem(firstSystemID)[0];
const repeatedBelt = registry.getBeltsForSystem(firstSystemID)[0];
assert.deepEqual(repeatedBelt, firstBelt);
assert.equal(
  registry.buildAsteroidItemID(firstBelt.itemID, 1),
  5_000_000_000_000 + (firstBelt.itemID * 512) + 1,
);

const targetStaticBeltIDs = worldData
  .getAsteroidBeltsForSystem(firstSystemID)
  .map((belt) => Number(belt.itemID));
assert.deepEqual(targetStaticBeltIDs, []);

const loader = require(path.join(modRoot, "loader.js"));
assert.equal(loader.active, true);
assert.equal(loader.beltCount, 53);
const asteroidData = require(path.resolve(
  modRoot,
  "..",
  "..",
  "server",
  "src",
  "space",
  "asteroids",
  "asteroidData",
));
assert.equal(asteroidData.getBeltByID(firstBelt.itemID).itemName, firstBelt.itemName);
assert.deepEqual(
  worldData.getAsteroidBeltsForSystem(nativeBeltSystemID),
  nativeBeltSnapshot,
);
for (const systemID of targetSystemIDs) {
  assert.equal(worldData.getAsteroidBeltsForSystem(systemID).length, 1);
  assert.equal(
    worldData.getCelestialsForSystem(systemID)
      .filter((entry) => Number(entry && entry.itemID) === Number(registry.getBeltsForSystem(systemID)[0].itemID))
      .length,
    1,
  );
}
assert.equal(worldData.getAsteroidBeltsForSystem(firstSystemID).length, 1);
require(path.resolve(
  modRoot,
  "..",
  "..",
  "server",
  "src",
  "services",
  "structure",
  "structureState",
));
assert.equal(
  worldData.getStaticSceneForSystem(firstSystemID)
    .filter((entry) => Number(entry.itemID) === firstBelt.itemID).length,
  1,
);

const MapService = require(path.resolve(
  modRoot,
  "..",
  "..",
  "server",
  "src",
  "services",
  "map",
  "mapService",
));
const mapResult = new MapService().Handle_GetSolarsystemItems([firstSystemID]);
const mapLines = mapResult.args.entries.find((entry) => entry[0] === "lines")[1].items;
assert.ok(mapLines.some((row) => Number(row[2]) === firstBelt.itemID));

const ConfigService = require(path.resolve(
  modRoot,
  "..",
  "..",
  "server",
  "src",
  "services",
  "config",
  "configService",
));
const locationResult = new ConfigService().Handle_GetMultiLocationsEx([[firstBelt.itemID]], {});
assert.ok(locationResult[1].some((row) => (
  Number(row[0]) === firstBelt.itemID &&
  row[1] === firstBelt.itemName &&
  Number(row[2]) === firstBelt.solarSystemID
)));

const asteroidService = require(path.resolve(
  modRoot,
  "..",
  "..",
  "server",
  "src",
  "space",
  "asteroids",
  "asteroidService",
));
const generatedScene = {
  systemID: firstSystemID,
  staticEntities: [],
  addStaticEntity(entity) {
    this.staticEntities.push(entity);
    return true;
  },
};
const generatedResult = asteroidService.handleSceneCreated(generatedScene);
const generatedAsteroids = generatedResult.data.spawned.filter((entity) => (
  entity && entity.beltID === firstBelt.itemID
));
assert.equal(generatedAsteroids.length, config.asteroidCount);
assert.equal(
  new Set(generatedAsteroids.map((entity) => entity.itemID)).size,
  generatedAsteroids.length,
);

console.log("Starter Region Asteroid Belts manifest, registry, and overlay checks passed.");
