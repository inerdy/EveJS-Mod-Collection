"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const config = JSON.parse(
  fs.readFileSync(path.join(modRoot, "config", "mining.json"), "utf8"),
);
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const serviceClass = require(path.join(modRoot, "lib", "ambientNpcMiningService"));

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
  "config/mining.json",
  "evejs-launcher.mod.json",
  "lib/ambientNpcMiningService.js",
  "lib/config.js",
  "loader.js",
  "test/validate.js",
]);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "ambientnpcmining");
assert.equal(manifest.displayName, "Ambient NPC Mining");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const normalizedConfig = normalizeConfig(config);
assert.equal(normalizedConfig.enabled, true);
assert.equal(normalizedConfig.tickIntervalMs, 300000);
assert.equal(normalizedConfig.initialDelayMs, 30000);
assert.equal(normalizedConfig.spawnChance, 0.15);
assert.equal(normalizedConfig.respawnCooldownMs, 2700000);
assert.equal(normalizedConfig.maxFleetsPerSystem, 1);
assert.equal(normalizedConfig.maxFleetsGlobal, 10);
assert.deepEqual(normalizedConfig.allowedSystemIDs, []);

assert.equal(
  serviceClass._testing.shouldSpawnForRoll(0.1499, normalizedConfig.spawnChance),
  true,
);
assert.equal(
  serviceClass._testing.shouldSpawnForRoll(0.15, normalizedConfig.spawnChance),
  false,
);
assert.equal(
  serviceClass._testing.isActiveScene({
    systemID: 30000142,
    sceneKind: "solarSystem",
    sessions: new Map([[1, {}]]),
  }),
  true,
);
assert.equal(
  serviceClass._testing.isActiveScene({
    systemID: 30000142,
    sceneKind: "solarSystem",
    sessions: new Map(),
  }),
  false,
);
assert.equal(
  serviceClass._testing.hasAsteroidField({
    staticEntities: [{kind: "asteroid", position: {x: 1, y: 2, z: 3}}],
  }),
  true,
);
assert.equal(
  serviceClass._testing.hasAsteroidField({
    staticEntities: [{kind: "planet", position: {x: 1, y: 2, z: 3}}],
  }),
  false,
);

const sourceSession = {
  characterID: 42,
  _space: {
    systemID: 30000142,
    sceneKey: "solar-system:30000142",
    shipID: 99001,
  },
};
const ambientSession = serviceClass._testing.buildAmbientSession(sourceSession);
assert.equal(ambientSession.characterID, 42);
assert.equal(ambientSession._space.systemID, 30000142);
assert.equal(ambientSession._space.shipID, 0);
assert.equal(sourceSession._space.shipID, 99001);

console.log("Ambient NPC Mining manifest, configuration, lifecycle, and package checks passed.");
