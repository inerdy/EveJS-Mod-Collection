const path = require("node:path");

const INSTALL_FLAG = Symbol.for("evejs.tempPatches.dungeonTerminalSiteTickPatchInstalled");
const DEFAULT_INTERVAL_MS = 1_000;
const TERMINAL_STATES = new Set(["completed", "failed", "despawned"]);
const SERVER_SRC_PATH = path.resolve(__dirname, "..", "..", "..", "server", "src");
const SPACE_RUNTIME_PATH = path.join(SERVER_SRC_PATH, "space", "runtime.js");
const DUNGEON_RUNTIME_PATH = path.join(
  SERVER_SRC_PATH,
  "services",
  "dungeon",
  "dungeonRuntime.js",
);

function log(message) {
  console.log(`[temppatches] ${message}`);
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeState(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function resolveLoadedExport(modulePath) {
  const cachedModule = require.cache[modulePath];
  return cachedModule && cachedModule.loaded ? cachedModule.exports : null;
}

function resolveInstanceID(scene, siteID, instanceIDsBySiteID) {
  const trackedID = toInt(
    instanceIDsBySiteID && typeof instanceIDsBySiteID.get === "function"
      ? instanceIDsBySiteID.get(siteID)
      : 0,
    0,
  );
  if (trackedID > 0) {
    return trackedID;
  }

  const staticEntity = scene && scene.staticEntitiesByID instanceof Map
    ? scene.staticEntitiesByID.get(siteID)
    : null;
  return Math.max(0, toInt(staticEntity && staticEntity.dungeonSiteInstanceID, 0));
}

function sweepTerminalSiteMarkers(runtime, dungeonRuntime) {
  const scenes = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.values()
    : [];
  let removedCount = 0;

  for (const scene of scenes) {
    const siteIDs = scene && scene._dungeonUniverseMaterializedSiteIDs;
    if (!(siteIDs instanceof Set) || siteIDs.size <= 0) {
      continue;
    }
    const instanceIDsBySiteID = scene._dungeonUniverseMaterializedInstanceIDsBySiteID;
    for (const siteID of [...siteIDs]) {
      const instanceID = resolveInstanceID(scene, siteID, instanceIDsBySiteID);
      if (instanceID <= 0 || !dungeonRuntime || typeof dungeonRuntime.getInstanceSummary !== "function") {
        continue;
      }
      const summary = dungeonRuntime.getInstanceSummary(instanceID);
      if (!summary || !TERMINAL_STATES.has(normalizeState(summary.lifecycleState))) {
        continue;
      }
      siteIDs.delete(siteID);
      if (instanceIDsBySiteID && typeof instanceIDsBySiteID.delete === "function") {
        instanceIDsBySiteID.delete(siteID);
      }
      removedCount += 1;
    }
  }

  return removedCount;
}

function installTerminalSiteMarkerCleanup(options = {}) {
  if (globalThis[INSTALL_FLAG]) {
    return globalThis[INSTALL_FLAG];
  }
  const intervalMs = Math.max(
    250,
    toInt(options.intervalMs, DEFAULT_INTERVAL_MS),
  );
  // Do not require these modules during loader initialization. They are large
  // runtime graphs and the server loads them naturally during startup. Waiting
  // for their cache entries avoids duplicating the startup memory peak and
  // avoids changing module initialization order.
  let runtime = options.runtime || null;
  let dungeonRuntime = options.dungeonRuntime || null;
  const sweep = () => {
    try {
      runtime = runtime || resolveLoadedExport(SPACE_RUNTIME_PATH);
      dungeonRuntime = dungeonRuntime || resolveLoadedExport(DUNGEON_RUNTIME_PATH);
      if (!runtime || !dungeonRuntime) {
        return;
      }
      const removedCount = sweepTerminalSiteMarkers(runtime, dungeonRuntime);
      if (removedCount > 0) {
        log(`removed ${removedCount} terminal dungeon site marker(s) from active scene processing`);
      }
    } catch (error) {
      log(`terminal dungeon site marker cleanup failed: ${error.message}`);
    }
  };
  const timer = setInterval(sweep, intervalMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  const state = Object.freeze({
    active: true,
    intervalMs,
    timer,
  });
  globalThis[INSTALL_FLAG] = state;
  sweep();
  return state;
}

module.exports = Object.freeze({
  DEFAULT_INTERVAL_MS,
  TERMINAL_STATES,
  installTerminalSiteMarkerCleanup,
  _testing: Object.freeze({
    resolveLoadedExport,
    resolveInstanceID,
    sweepTerminalSiteMarkers,
  }),
});
