"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "dungeonrespawncooldown");
assert.equal(manifest.displayName, "Dungeon Respawn Cooldown");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const mod = require(path.join(modRoot, "loader.js"));
assert.equal(mod.active, true);
assert.equal(mod.id, "dungeonrespawncooldown");

const {
  CLEARED_ANOMALY_COOLDOWN_MS,
  getAnomalyCooldownDeadline,
  isCooldownEligibleAnomaly,
  patchDungeonUniverseRuntime,
  patchDungeonSiteAdapter,
  patchSignatureRuntime,
} = mod._testing;

assert.equal(CLEARED_ANOMALY_COOLDOWN_MS, 30 * 60 * 1000);
const completedAnomaly = {
  instanceID: 9001,
  lifecycleState: "completed",
  lifecycleReason: "encounters_cleared",
  siteKind: "anomaly",
  siteOrigin: "universe_dungeon",
  solarSystemID: 30000142,
  timers: {completedAtMs: 1_000_000, expiresAtMs: 1_000_000},
};
assert.equal(isCooldownEligibleAnomaly(completedAnomaly), true);
assert.equal(
  getAnomalyCooldownDeadline(completedAnomaly),
  1_000_000 + 30 * 60 * 1000,
);
assert.equal(
  isCooldownEligibleAnomaly({
    ...completedAnomaly,
    siteOrigin: "generatedMining",
    lifecycleReason: "depleted",
  }),
  false,
);

const fakeTerminalInstances = [completedAnomaly];
const fakeDungeonRuntime = {
  listUniversePersistentTerminalInstances() {
    return fakeTerminalInstances;
  },
};
const fakeUniverseRuntime = {
  getUniversePersistentLifecycleBoundary() {
    return null;
  },
  advanceUniversePersistentSites() {
    return {
      rotatedCount: fakeDungeonRuntime.listUniversePersistentTerminalInstances().length,
    };
  },
};
assert.equal(
  patchDungeonUniverseRuntime(fakeUniverseRuntime, {
    runtime: fakeDungeonRuntime,
    isSiteTeardownParked: () => false,
  }),
  true,
);
assert.equal(
  fakeUniverseRuntime.getUniversePersistentLifecycleBoundary(1_000_001).boundaryAtMs,
  1_000_000 + 30 * 60 * 1000,
);
assert.equal(
  fakeUniverseRuntime.advanceUniversePersistentSites({nowMs: 1_000_001}).rotatedCount,
  0,
);
assert.equal(
  fakeUniverseRuntime.advanceUniversePersistentSites({nowMs: 1_000_000 + 30 * 60 * 1000}).rotatedCount,
  1,
);

const fakeAdapterRuntime = {
  listUniversePersistentTerminalInstances() {
    const nowMs = Date.now();
    return [{
      ...completedAnomaly,
      timers: {completedAtMs: nowMs, expiresAtMs: nowMs},
    }];
  },
};
const fakeSiteAdapter = {
  enrichSiteWithDungeonRuntime(site) {
    return {...site, instanceID: 1234};
  },
};
assert.equal(
  patchDungeonSiteAdapter(fakeSiteAdapter, {runtime: fakeAdapterRuntime}),
  true,
);
const suppressedSite = fakeSiteAdapter.enrichSiteWithDungeonRuntime({
  siteID: 9001,
  instanceID: 9001,
  solarSystemID: 30000142,
});
assert.equal(suppressedSite.instanceID, null);
assert.equal(suppressedSite.dungeonRespawnCooldownActive, true);

const fakeSignatureRuntime = {
  listSystemAnomalySites() {
    return [
      suppressedSite,
      {siteID: 9002, dungeonRespawnCooldownActive: false},
    ];
  },
};
assert.equal(patchSignatureRuntime(fakeSignatureRuntime), true);
assert.deepEqual(
  fakeSignatureRuntime.listSystemAnomalySites().map((site) => site.siteID),
  [9002],
);

const readme = fs.readFileSync(path.join(modRoot, "README.md"), "utf8");
assert.match(readme, /native-only/u);
assert.match(readme, /30 minutes/u);
assert.match(readme, /Docker is not supported/u);

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

console.log("Dungeon Respawn Cooldown manifest, cooldown, patch, and package checks passed.");
