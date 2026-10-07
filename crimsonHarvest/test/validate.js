"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.join(__dirname, "..");
const CrimsonHarvestService = require(path.join(modRoot, "lib", "crimsonHarvestService"));
const testing = CrimsonHarvestService._testing;

assert.equal(testing.isEventActive(Date.UTC(2026, 8, 30, 23, 59, 59)), false);
assert.equal(testing.isEventActive(Date.UTC(2026, 9, 1, 0, 0, 0)), true);
assert.equal(testing.isEventActive(Date.UTC(2026, 10, 3, 23, 59, 59)), true);
assert.equal(testing.isEventActive(Date.UTC(2026, 10, 4, 0, 0, 0)), false);

const sampleSystems = Array.from({ length: 1000 }, (_, index) => 30_000_000 + index);
const firstPools = sampleSystems.map((systemID) => testing.poolForSystem(systemID, 2026));
const secondPools = sampleSystems.map((systemID) => testing.poolForSystem(systemID, 2026));
assert.deepEqual(firstPools, secondPools);
const publicCount = firstPools.filter((pool) => pool === "public").length;
assert.ok(publicCount >= 250 && publicCount <= 350, `unexpected public pool size: ${publicCount}`);

assert.equal(testing.poolForSystem(30_000_000, 2026), testing.poolForSystem(30_000_000, 2026));
assert.notEqual(testing.templateIDForSystem(30_000_000, 2026, "public"), undefined);
assert.notEqual(testing.templateIDForSystem(30_000_000, 2026, "scan"), undefined);
assert.equal(testing.buildEventSiteID(30_000_000), 6_600_000_000_001);
assert.equal(testing.buildEventSiteID(0), 0);

assert.equal(testing.normalizeSecurityBand(30_000_001, { securityStatus: 1.0 }), "highsec");
assert.equal(testing.normalizeSecurityBand(30_000_002, { securityStatus: 0.1 }), "lowsec");
assert.equal(testing.normalizeSecurityBand(30_000_003, { securityStatus: -0.1 }), "nullsec");
assert.equal(testing.normalizeSecurityBand(31_000_001, { securityStatus: 1.0 }), "wormhole");
assert.equal(testing.isEligibleSystem(30_000_004, { securityStatus: 1.0, regionID: 10000001 }), true);
assert.equal(testing.isEligibleSystem(30_000_005, { securityStatus: 1.0, regionID: 10000070 }), false);
assert.equal(testing.isEligibleSystem(31_000_006, { securityStatus: 1.0, regionID: 10000001 }), false);

const worldData = require(path.join(modRoot, "..", "..", "server", "src", "space", "worldData"));
const definitionDeps = {
  dungeonAuthority: require(path.join(modRoot, "..", "..", "server", "src", "services", "dungeon", "dungeonAuthority")),
  dungeonRuntime: require(path.join(modRoot, "..", "..", "server", "src", "services", "dungeon", "dungeonRuntime")),
  dungeonSiteAdapter: require(path.join(modRoot, "..", "..", "server", "src", "services", "dungeon", "dungeonSiteAdapter")),
  dungeonUniverseRuntime: require(path.join(modRoot, "..", "..", "server", "src", "services", "dungeon", "dungeonUniverseRuntime")),
  worldData,
  pochvenPolicy: require(path.join(modRoot, "..", "..", "server", "src", "space", "pochvenPolicy")),
};
const activeAt = Date.UTC(2026, 9, 7, 12, 0, 0);
const publicDefinition = testing.buildEventDefinition(definitionDeps, 30000142, activeAt);
assert.equal(publicDefinition.siteKind, "anomaly");
assert.equal(publicDefinition.siteOrigin, "crimson_harvest");
assert.equal(publicDefinition.metadata.eventYear, 2026);
assert.equal(publicDefinition.spawnState.spawnFamilyKey, "crimson_harvest");
assert.match(publicDefinition.siteKey, /^sceneanomalysite:/);
assert.ok(testing.PUBLIC_TEMPLATE_IDS.includes(publicDefinition.templateID));

const scanSystem = worldData.getSolarSystems().find((system) => (
  system &&
  testing.isEligibleSystem(system.solarSystemID, system) &&
  testing.poolForSystem(system.solarSystemID, 2026) === "scan"
));
assert.ok(scanSystem, "an eligible scan-pool system should exist");
const scanDefinition = testing.buildEventDefinition(definitionDeps, scanSystem.solarSystemID, activeAt);
assert.equal(scanDefinition.siteKind, "signature");
assert.match(scanDefinition.siteKey, /^scenesignaturesite:/);
assert.ok(testing.SCAN_TEMPLATE_IDS.includes(scanDefinition.templateID));

const loaderText = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
assert.match(loaderText, /attachSessionToExistingEntity/);
assert.match(loaderText, /service registered/);
const serviceText = fs.readFileSync(path.join(modRoot, "lib", "crimsonHarvestService.js"), "utf8");
assert.match(serviceText, /reconcileUniverseSeededInstances/);
assert.match(serviceText, /siteOriginFilter/);
assert.match(serviceText, /purgeInstances/);
assert.match(serviceText, /sendSystemMessage/);
assert.match(serviceText, /CustomNotify/);
assert.match(serviceText, /setTimeout\(deliver, 750\)/);

console.log("Crimson Harvest validation passed.");
