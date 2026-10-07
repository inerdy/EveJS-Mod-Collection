"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "temppatches");
assert.equal(manifest.version, "0.1.4");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const tempPatches = require(path.join(modRoot, "loader.js"));
assert.equal(tempPatches.active, true);
assert.equal(tempPatches.id, "temppatches");

const {
  ensureSceneMaterializedSiteMarker,
  DUNGEON_DIAGNOSTICS_ENABLED,
  CLEARED_ANOMALY_COOLDOWN_MS,
  getAnomalyCooldownDeadline,
  isCooldownEligibleAnomaly,
  buildContainerOutOfRangeMessage,
  isDungeonScopedEntity,
  matchedDungeonInstanceCount,
  patchInvBrokerService,
  patchDungeonService,
  patchDungeonTrackingRuntime,
  shouldReconcile,
} =
  tempPatches._testing;
assert.equal(DUNGEON_DIAGNOSTICS_ENABLED, true);
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
assert.equal(isDungeonScopedEntity({dungeonMaterializedSiteContent: true}), true);
assert.equal(isDungeonScopedEntity({dungeonSiteInstanceID: 42}), true);
assert.equal(isDungeonScopedEntity({nativeNpc: true}), false);
assert.equal(matchedDungeonInstanceCount({data: {matchedInstanceIDs: [1, 2]}}), 2);
assert.equal(shouldReconcile({nativeNpc: true}, {data: {matchedInstanceIDs: [9]}}), true);
assert.equal(shouldReconcile({nativeNpc: true}, {data: {matchedInstanceIDs: []}}), false);
const scene = {};
assert.equal(
  ensureSceneMaterializedSiteMarker(scene, {
    dungeonSiteID: 7001,
    dungeonSiteInstanceID: 8001,
  }),
  true,
);
assert.equal(scene._dungeonUniverseMaterializedSiteIDs.has(7001), true);
assert.equal(scene._dungeonUniverseMaterializedInstanceIDsBySiteID.get(7001), 8001);
assert.equal(
  buildContainerOutOfRangeMessage(2500),
  "That container is too far away. Move within 2,500 meters to open or access it.",
);

let originalHandleCalls = 0;
const fakeService = {
  handleEncounterEntityDestroyed() {
    originalHandleCalls += 1;
    return {success: true, data: {matchedInstanceIDs: [8001]}};
  },
  tickSceneSiteBehaviors() {
    return {encountersSpawned: 0};
  },
};
assert.equal(patchDungeonService(fakeService), true);
const patchedResult = fakeService.handleEncounterEntityDestroyed(
  {getCurrentSimTimeMs: () => 1},
  {dungeonSiteID: 7001, dungeonSiteInstanceID: 8001},
  {nowMs: 1},
);
assert.equal(originalHandleCalls, 1);
assert.deepEqual(patchedResult.data.matchedInstanceIDs, [8001]);

const trackingSession = {shipID: 9101};
const trackingShip = {dungeonCurrentDungeonID: 2048};
const trackingNotifications = [];
const fakeTrackingScene = {
  sessions: [trackingSession],
  getShipEntityForSession() {
    return trackingShip;
  },
};
const fakeTrackingRuntime = {
  notifyDungeonCompletedForScene(sceneForCompletion, instance) {
    for (const session of sceneForCompletion.sessions) {
      const ship = sceneForCompletion.getShipEntityForSession(session);
      ship.dungeonCompletedNotifiedInstanceID = instance.instanceID;
    }
    return 1;
  },
  resolveDungeonID(instance) {
    return instance.sourceDungeonID;
  },
  sendExitingDungeonNotification(session, dungeonID) {
    trackingNotifications.push({session, dungeonID});
    return true;
  },
};
assert.equal(patchDungeonTrackingRuntime(fakeTrackingRuntime), true);
assert.equal(
  fakeTrackingRuntime.notifyDungeonCompletedForScene(
    fakeTrackingScene,
    {instanceID: 9102, sourceDungeonID: 2048},
  ),
  1,
);
assert.equal(trackingNotifications.length, 1);
assert.equal(trackingNotifications[0].dungeonID, 2048);
assert.equal(
  fakeTrackingRuntime.notifyDungeonCompletedForScene(
    fakeTrackingScene,
    {instanceID: 9102, sourceDungeonID: 2048},
  ),
  1,
);
assert.equal(trackingNotifications.length, 1);

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
  tempPatches._testing.patchDungeonUniverseRuntime(fakeUniverseRuntime, {
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
  tempPatches._testing.patchDungeonSiteAdapter(fakeSiteAdapter, {
    runtime: fakeAdapterRuntime,
  }),
  true,
);
const suppressedSite = fakeSiteAdapter.enrichSiteWithDungeonRuntime({
  siteID: 9001,
  instanceID: 9001,
  solarSystemID: 30000142,
});
assert.equal(suppressedSite.instanceID, null);
assert.equal(suppressedSite.tempPatchesAnomalyCooldown, true);

const fakeSignatureRuntime = {
  listSystemAnomalySites() {
    return [
      suppressedSite,
      {siteID: 9002, tempPatchesAnomalyCooldown: false},
    ];
  },
};
assert.equal(tempPatches._testing.patchSignatureRuntime(fakeSignatureRuntime), true);
assert.deepEqual(
  fakeSignatureRuntime.listSystemAnomalySites().map((site) => site.siteID),
  [9002],
);

class FakeInvBrokerService {}
FakeInvBrokerService.prototype._throwSpaceContainerScopeAccessError = function original(errorMsg) {
  return errorMsg;
};
assert.equal(patchInvBrokerService(FakeInvBrokerService), true);
assert.equal(
  new FakeInvBrokerService()._throwSpaceContainerScopeAccessError("OTHER_ERROR"),
  "OTHER_ERROR",
);
assert.throws(
  () => new FakeInvBrokerService()._throwSpaceContainerScopeAccessError("CONTAINER_TOO_FAR"),
  (error) => {
    const entries = error.machoErrorResponse.payload.header[1][1].entries;
    return entries.some((entry) => (
      Array.isArray(entry) &&
      entry[0] === "notify" &&
      entry[1] === "That container is too far away. Move within 2,500 meters to open or access it."
    ));
  },
);

const readme = fs.readFileSync(path.join(modRoot, "README.md"), "utf8");
assert.match(readme, /native-only/u);
assert.match(readme, /Docker/u);
assert.match(readme, /game-server restart/u);
assert.match(readme, /wave_cleared/u);
assert.match(readme, /30-minute cooldown/u);

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

console.log("Temporary Patches manifest, loader, and package checks passed.");
