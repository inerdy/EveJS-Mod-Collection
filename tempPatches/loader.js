"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "temppatches";
const MOD_VERSION = "0.2.4";
const INSTALL_FLAG = Symbol.for("evejs.tempPatches.loaderInstalled");
const LOAD_HOOK_FLAG = Symbol.for("evejs.tempPatches.loadHookInstalled");
const PATCH_FLAG = Symbol.for("evejs.tempPatches.dungeonWavePatchInstalled");
const INV_BROKER_PATCH_FLAG = Symbol.for("evejs.tempPatches.invBrokerPatchInstalled");
const DUNGEON_TRACKING_PATCH_FLAG = Symbol.for(
  "evejs.tempPatches.dungeonTrackingPatchInstalled",
);
const DUNGEON_CACHE_MGR_SERVICE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "dungeon",
  "dungeonInstanceCacheMgrService.js",
);
const DUNGEON_SERVICE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "dungeon",
  "dungeonUniverseSiteService.js",
);
const INV_BROKER_SERVICE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "inventory",
  "invBrokerService.js",
);
const DUNGEON_RUNTIME_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "dungeon",
  "dungeonRuntime.js",
);
const DUNGEON_TRACKING_RUNTIME_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "dungeon",
  "dungeonTrackingRuntime.js",
);
const RECONCILE_DELAYS_MS = Object.freeze([0, 75, 300]);
const DEFAULT_CONTAINER_RANGE_METERS = 2_500;
const DUNGEON_DIAGNOSTICS_ENABLED = String(
  process.env.EVEJS_TEMP_PATCHES_DIAGNOSTICS || "1",
).trim() !== "0";
const TERMINAL_SITE_MARKER_CLEANUP_ENABLED = String(
  process.env.EVEJS_TEMP_PATCHES_TERMINAL_SITE_CLEANUP || "0",
).trim() === "1";

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function normalizeLowerText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return normalized || fallback;
}

function isDungeonScopedEntity(entityOrID) {
  if (!entityOrID || typeof entityOrID !== "object") {
    return false;
  }
  return (
    entityOrID.dungeonMaterializedSiteContent === true ||
    toPositiveInt(entityOrID.dungeonSiteInstanceID) > 0 ||
    String(entityOrID.dungeonEncounterKey || "").trim().length > 0
  );
}

function matchedDungeonInstanceCount(result) {
  return Array.isArray(
    result && result.data && result.data.matchedInstanceIDs,
  )
    ? result.data.matchedInstanceIDs.length
    : 0;
}

function shouldReconcile(entityOrID, result) {
  return isDungeonScopedEntity(entityOrID) || matchedDungeonInstanceCount(result) > 0;
}

function buildContainerOutOfRangeMessage(maximumDistanceMeters = DEFAULT_CONTAINER_RANGE_METERS) {
  const distance = Number(maximumDistanceMeters);
  const normalizedDistance = Number.isFinite(distance) && distance > 0
    ? Math.round(distance)
    : DEFAULT_CONTAINER_RANGE_METERS;
  return `That container is too far away. Move within ${normalizedDistance.toLocaleString("en-US")} meters to open or access it.`;
}

function resolveNowMs(scene, options = {}) {
  const explicitNowMs = Number(options && options.nowMs);
  if (Number.isFinite(explicitNowMs) && explicitNowMs > 0) {
    return Math.trunc(explicitNowMs);
  }
  if (scene && typeof scene.getCurrentSimTimeMs === "function") {
    const sceneNowMs = Number(scene.getCurrentSimTimeMs());
    if (Number.isFinite(sceneNowMs) && sceneNowMs > 0) {
      return Math.trunc(sceneNowMs);
    }
  }
  return Date.now();
}

function resolveDungeonInstanceIDs(entityOrID, result = null) {
  const candidates = [];
  if (entityOrID && typeof entityOrID === "object") {
    candidates.push(
      entityOrID.dungeonSiteInstanceID,
      entityOrID.dungeonInstanceID,
      entityOrID.instanceID,
    );
  }
  const matchedInstanceIDs = result && result.data && result.data.matchedInstanceIDs;
  if (Array.isArray(matchedInstanceIDs)) {
    candidates.push(...matchedInstanceIDs);
  }
  return [...new Set(candidates.map((entry) => toPositiveInt(entry)).filter((entry) => entry > 0))];
}

function summarizeDungeonInstance(instance) {
  if (!instance) {
    return null;
  }
  const spawnState = instance.spawnState && typeof instance.spawnState === "object"
    ? instance.spawnState
    : {};
  const encounterStates = spawnState.encounterStatesByKey &&
    typeof spawnState.encounterStatesByKey === "object"
    ? spawnState.encounterStatesByKey
    : {};
  const populationHints = spawnState.populationHints &&
    typeof spawnState.populationHints === "object"
    ? spawnState.populationHints
    : {};
  const plans = Array.isArray(populationHints.encounters)
    ? populationHints.encounters
    : populationHints.encounter && typeof populationHints.encounter === "object"
      ? [populationHints.encounter]
      : [];
  return {
    instanceID: toPositiveInt(instance.instanceID),
    solarSystemID: toPositiveInt(instance.solarSystemID),
    lifecycleState: normalizeLowerText(instance.lifecycleState, ""),
    lifecycleReason: normalizeLowerText(instance.lifecycleReason, ""),
    plannedWaves: plans.map((plan, index) => ({
      key: String(plan && plan.key || `encounter_${index + 1}`),
      wave: Math.max(1, Math.trunc(Number(plan && plan.waveIndex) || index + 1)),
      trigger: String(plan && plan.trigger || "on_load"),
      prerequisiteKey: String(plan && plan.prerequisiteKey || "") || null,
    })),
    encounterStates: Object.entries(encounterStates).map(([key, state]) => ({
      key,
      wave: Math.max(1, Math.trunc(Number(state && state.waveIndex) || 1)),
      trigger: String(state && state.trigger || ""),
      prerequisiteKey: String(state && state.prerequisiteKey || "") || null,
      spawned: toPositiveInt(state && state.spawnedAtMs) > 0,
      completed: toPositiveInt(state && state.completedAtMs) > 0,
      remainingEntityIDs: Array.isArray(state && state.remainingEntityIDs)
        ? state.remainingEntityIDs.map((entry) => toPositiveInt(entry)).filter((entry) => entry > 0)
        : [],
    })),
  };
}

function logDungeonDiagnostics(label, payload = {}) {
  if (!DUNGEON_DIAGNOSTICS_ENABLED) {
    return;
  }
  log(`dungeon diagnostic ${label} ${JSON.stringify(payload)}`);
}

function logDungeonInstanceDiagnostics(label, instanceIDs, extra = {}) {
  if (!DUNGEON_DIAGNOSTICS_ENABLED) {
    return;
  }
  let runtime = null;
  try {
    runtime = require(DUNGEON_RUNTIME_PATH);
  } catch (error) {
    logDungeonDiagnostics(label, {
      ...extra,
      instanceIDs,
      runtimeError: error.message,
    });
    return;
  }
  const instances = instanceIDs
    .map((instanceID) => summarizeDungeonInstance(
      runtime && typeof runtime.getInstance === "function"
        ? runtime.getInstance(instanceID)
        : null,
    ))
    .filter(Boolean);
  logDungeonDiagnostics(label, {
    ...extra,
    instanceIDs,
    instances,
  });
}

function ensureSceneMaterializedSiteMarker(scene, entityOrID) {
  if (!scene || !entityOrID || typeof entityOrID !== "object") {
    return false;
  }
  const siteID = toPositiveInt(entityOrID.dungeonSiteID);
  if (siteID <= 0) {
    return false;
  }
  if (!(scene._dungeonUniverseMaterializedSiteIDs instanceof Set)) {
    scene._dungeonUniverseMaterializedSiteIDs = new Set();
  }
  scene._dungeonUniverseMaterializedSiteIDs.add(siteID);
  const instanceID = toPositiveInt(entityOrID.dungeonSiteInstanceID);
  if (instanceID > 0) {
    if (!(scene._dungeonUniverseMaterializedInstanceIDsBySiteID instanceof Map)) {
      scene._dungeonUniverseMaterializedInstanceIDsBySiteID = new Map();
    }
    scene._dungeonUniverseMaterializedInstanceIDsBySiteID.set(siteID, instanceID);
  }
  return true;
}

function scheduleWaveReconciliation(service, scene, entityOrID, options = {}, destructionResult = null) {
  if (!scene || typeof service.tickSceneSiteBehaviors !== "function") {
    return false;
  }

  ensureSceneMaterializedSiteMarker(scene, entityOrID);
  const instanceIDs = resolveDungeonInstanceIDs(entityOrID, destructionResult);

  const pendingByScene = scheduleWaveReconciliation.pendingByScene;
  if (pendingByScene.has(scene)) {
    logDungeonInstanceDiagnostics("reconcile-coalesced", instanceIDs, {
      dungeonSiteID: toPositiveInt(entityOrID && entityOrID.dungeonSiteID),
      dungeonEncounterKey: String(entityOrID && entityOrID.dungeonEncounterKey || "") || null,
    });
    return false;
  }

  const state = {attempt: 0, timer: null};
  pendingByScene.set(scene, state);
  logDungeonDiagnostics("reconcile-scheduled", {
    instanceIDs,
    delaysMs: RECONCILE_DELAYS_MS,
  });

  const run = () => {
    const attempt = state.attempt + 1;
    const nowMs = resolveNowMs(scene, options);
    logDungeonInstanceDiagnostics("reconcile-before", instanceIDs, {
      attempt,
      nowMs,
    });
    try {
      const progression = service.tickSceneSiteBehaviors(scene, {
        nowMs,
        session: options.session || null,
      });
      const spawned = toPositiveInt(progression && progression.encountersSpawned);
      logDungeonInstanceDiagnostics("reconcile-after", instanceIDs, {
        attempt,
        nowMs,
        encountersSpawned: spawned,
        encounterCompletions: toPositiveInt(progression && progression.encounterCompletions),
        gatesUnlocked: toPositiveInt(progression && progression.gatesUnlocked),
      });
      if (spawned > 0) log(`dungeon wave reconciliation spawned ${spawned} encounter(s)`);
    } catch (error) {
      log(`dungeon wave reconciliation failed: ${error.message}`);
      logDungeonInstanceDiagnostics("reconcile-error", instanceIDs, {
        attempt,
        nowMs,
        error: error.message,
      });
    }

    state.attempt += 1;
    if (state.attempt >= RECONCILE_DELAYS_MS.length) {
      pendingByScene.delete(scene);
      return;
    }
    state.timer = setTimeout(run, RECONCILE_DELAYS_MS[state.attempt]);
    if (state.timer && typeof state.timer.unref === "function") {
      state.timer.unref();
    }
  };

  state.timer = setTimeout(run, RECONCILE_DELAYS_MS[0]);
  if (state.timer && typeof state.timer.unref === "function") {
    state.timer.unref();
  }
  return true;
}

scheduleWaveReconciliation.pendingByScene = new WeakMap();

function patchDungeonService(service) {
  if (!service || service[PATCH_FLAG]) {
    return false;
  }
  if (
    typeof service.handleEncounterEntityDestroyed !== "function" ||
    typeof service.tickSceneSiteBehaviors !== "function"
  ) {
    throw new Error("Dungeon service does not expose the expected encounter methods");
  }

  const originalHandle = service.handleEncounterEntityDestroyed;
  service.handleEncounterEntityDestroyed = function tempPatchesHandleEncounterEntityDestroyed(
    scene,
    entityOrID,
    options = {},
  ) {
    const result = originalHandle.call(this, scene, entityOrID, options);
    const instanceIDs = resolveDungeonInstanceIDs(entityOrID, result);
    if (DUNGEON_DIAGNOSTICS_ENABLED && (isDungeonScopedEntity(entityOrID) || instanceIDs.length > 0)) {
      logDungeonInstanceDiagnostics("entity-destroyed", instanceIDs, {
        entityID: toPositiveInt(entityOrID && (
          entityOrID.itemID || entityOrID.entityID || entityOrID.id
        )),
        dungeonSiteID: toPositiveInt(entityOrID && entityOrID.dungeonSiteID),
        dungeonEncounterKey: String(entityOrID && entityOrID.dungeonEncounterKey || "") || null,
        matchedInstanceIDs: Array.isArray(result && result.data && result.data.matchedInstanceIDs)
          ? result.data.matchedInstanceIDs
          : [],
        success: result && result.success === true,
      });
    }
    const needsReconciliation = shouldReconcile(entityOrID, result);
    if (needsReconciliation) {
      scheduleWaveReconciliation(this, scene, entityOrID, options, result);
    } else if (DUNGEON_DIAGNOSTICS_ENABLED && isDungeonScopedEntity(entityOrID)) {
      logDungeonDiagnostics("reconcile-not-scheduled", {
        entityID: toPositiveInt(entityOrID && (
          entityOrID.itemID || entityOrID.entityID || entityOrID.id
        )),
        dungeonSiteID: toPositiveInt(entityOrID && entityOrID.dungeonSiteID),
        dungeonEncounterKey: String(entityOrID && entityOrID.dungeonEncounterKey || "") || null,
        matchedInstanceIDs: Array.isArray(result && result.data && result.data.matchedInstanceIDs)
          ? result.data.matchedInstanceIDs
          : [],
      });
    }
    return result;
  };

  Object.defineProperty(service, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log("dungeon encounter destruction patch installed");
  return true;
}

function listSceneSessions(scene) {
  if (!scene || !scene.sessions) {
    return [];
  }
  if (scene.sessions instanceof Map) {
    return Array.from(scene.sessions.values());
  }
  if (Array.isArray(scene.sessions)) {
    return scene.sessions;
  }
  if (typeof scene.sessions === "object") {
    return Object.values(scene.sessions);
  }
  return [];
}

function resolveTrackingShipEntity(scene, session) {
  if (!scene || !session) {
    return null;
  }
  if (typeof scene.getShipEntityForSession === "function") {
    return scene.getShipEntityForSession(session);
  }
  const shipID = toPositiveInt(session.shipID || session.shipid);
  return shipID > 0 && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
}

function resolveTrackingInstanceID(instanceOrID) {
  return typeof instanceOrID === "object" && instanceOrID
    ? toPositiveInt(instanceOrID.instanceID)
    : toPositiveInt(instanceOrID);
}

function resolveTrackingDungeonID(service, instanceOrID, shipEntity) {
  const instance = typeof instanceOrID === "object" && instanceOrID
    ? instanceOrID
    : null;
  const resolvedInstance = instance || (() => {
    try {
      const runtime = require(DUNGEON_RUNTIME_PATH);
      return runtime && typeof runtime.getInstance === "function"
        ? runtime.getInstance(toPositiveInt(instanceOrID))
        : null;
    } catch (_error) {
      return null;
    }
  })();
  const resolvedByService = resolvedInstance &&
    typeof service.resolveDungeonID === "function"
    ? service.resolveDungeonID(resolvedInstance)
    : 0;
  return Math.max(
    toPositiveInt(resolvedByService),
    toPositiveInt(shipEntity && shipEntity.dungeonCurrentDungeonID),
  );
}

function patchDungeonTrackingRuntime(service) {
  if (!service || service[DUNGEON_TRACKING_PATCH_FLAG]) {
    return false;
  }
  if (
    typeof service.notifyDungeonCompletedForScene !== "function" ||
    typeof service.sendExitingDungeonNotification !== "function"
  ) {
    throw new Error("Dungeon tracking runtime does not expose completion notification methods");
  }

  const originalNotifyDungeonCompletedForScene = service.notifyDungeonCompletedForScene;
  service.notifyDungeonCompletedForScene = function tempPatchesNotifyDungeonCompletedForScene(
    scene,
    instanceOrID,
    options = {},
  ) {
    const instanceID = resolveTrackingInstanceID(instanceOrID);
    const sessions = listSceneSessions(scene);
    const priorCompletionState = new Map(
      sessions.map((session) => {
        const shipEntity = resolveTrackingShipEntity(scene, session);
        return [
          session,
          toPositiveInt(shipEntity && shipEntity.dungeonCompletedNotifiedInstanceID),
        ];
      }),
    );

    const notifiedCount = originalNotifyDungeonCompletedForScene.call(
      this,
      scene,
      instanceOrID,
      options,
    );

    if (instanceID <= 0 || notifiedCount <= 0) {
      return notifiedCount;
    }

    for (const session of sessions) {
      const shipEntity = resolveTrackingShipEntity(scene, session);
      const completionState = toPositiveInt(
        shipEntity && shipEntity.dungeonCompletedNotifiedInstanceID,
      );
      const wasAlreadyNotified = priorCompletionState.get(session) === instanceID;
      if (completionState !== instanceID || (wasAlreadyNotified && options.forceNotify !== true)) {
        continue;
      }

      const dungeonID = resolveTrackingDungeonID(this, instanceOrID, shipEntity);
      if (dungeonID <= 0) {
        continue;
      }
      try {
        if (this.sendExitingDungeonNotification(session, dungeonID)) {
          log(`dungeon completion UI reset sent for instance ${instanceID}`);
        }
      } catch (error) {
        log(`dungeon completion UI reset failed for instance ${instanceID}: ${error.message}`);
      }
    }
    return notifiedCount;
  };

  Object.defineProperty(service, DUNGEON_TRACKING_PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log("dungeon completion UI reset patch installed");
  return true;
}

function patchInvBrokerService(service) {
  const prototype = service && service.prototype;
  if (!prototype || prototype[INV_BROKER_PATCH_FLAG]) {
    return false;
  }
  if (typeof prototype._throwSpaceContainerScopeAccessError !== "function") {
    throw new Error("Inventory broker does not expose the expected container access method");
  }

  const originalThrowSpaceContainerScopeAccessError =
    prototype._throwSpaceContainerScopeAccessError;
  prototype._throwSpaceContainerScopeAccessError = function tempPatchesContainerAccessError(
    errorMsg = "",
    ...args
  ) {
    if (String(errorMsg || "").trim() === "CONTAINER_TOO_FAR") {
      const {throwWrappedUserError} = require(path.join(
        __dirname,
        "..",
        "..",
        "server",
        "src",
        "common",
        "machoErrors",
      ));
      let maximumDistanceMeters = DEFAULT_CONTAINER_RANGE_METERS;
      try {
        const cargoContainerRuntime = require(path.join(
          __dirname,
          "..",
          "..",
          "server",
          "src",
          "services",
          "ship",
          "cargoContainerRuntime",
        ));
        maximumDistanceMeters = cargoContainerRuntime.MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS;
      } catch (error) {
        log(`container range lookup failed, using ${DEFAULT_CONTAINER_RANGE_METERS} meters: ${error.message}`);
      }
      throwWrappedUserError("CustomNotify", {
        notify: buildContainerOutOfRangeMessage(maximumDistanceMeters),
      });
    }
    return originalThrowSpaceContainerScopeAccessError.call(this, errorMsg, ...args);
  };

  Object.defineProperty(prototype, INV_BROKER_PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log("cargo-container range notification patch installed");
  return true;
}

const dungeonAnomalyCachePatch = require(path.join(
  __dirname,
  "patches",
  "dungeonAnomalyCachePatch.js",
));
const dungeonTerminalSiteTickPatch = require(path.join(
  __dirname,
  "patches",
  "dungeonTerminalSiteTickPatch.js",
));

function applyRuntimePatch(resolved, exported) {
  const resolvedPath = path.resolve(resolved);
  if (resolvedPath === DUNGEON_SERVICE_PATH) {
    patchDungeonService(exported);
  } else if (resolvedPath === INV_BROKER_SERVICE_PATH) {
    patchInvBrokerService(exported);
  } else if (resolvedPath === DUNGEON_TRACKING_RUNTIME_PATH) {
    patchDungeonTrackingRuntime(exported);
  } else if (resolvedPath === DUNGEON_CACHE_MGR_SERVICE_PATH) {
    dungeonAnomalyCachePatch.patchDungeonInstanceCacheMgrService(exported);
  }
  return exported;
}

function installLazyRuntimeHook() {
  if (Module._load[LOAD_HOOK_FLAG]) {
    return;
  }

  const originalLoad = Module._load;
  Module._load = function tempPatchesLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    return applyRuntimePatch(resolved, exported);
  };
  Module._load[LOAD_HOOK_FLAG] = true;

  const cachedModule = Module._cache[DUNGEON_SERVICE_PATH];
  if (cachedModule) {
    applyRuntimePatch(DUNGEON_SERVICE_PATH, cachedModule.exports);
  }
  const cachedDungeonTrackingRuntime = Module._cache[DUNGEON_TRACKING_RUNTIME_PATH];
  if (cachedDungeonTrackingRuntime) {
    applyRuntimePatch(
      DUNGEON_TRACKING_RUNTIME_PATH,
      cachedDungeonTrackingRuntime.exports,
    );
  }
  const cachedDungeonCacheMgr = Module._cache[DUNGEON_CACHE_MGR_SERVICE_PATH];
  if (cachedDungeonCacheMgr) {
    applyRuntimePatch(DUNGEON_CACHE_MGR_SERVICE_PATH, cachedDungeonCacheMgr.exports);
  }
}

function install() {
  if (globalThis[INSTALL_FLAG]) {
    return globalThis[INSTALL_FLAG];
  }
  installLazyRuntimeHook();
  if (TERMINAL_SITE_MARKER_CLEANUP_ENABLED) {
    dungeonTerminalSiteTickPatch.installTerminalSiteMarkerCleanup();
  }
  const state = Object.freeze({
    active: true,
    id: MOD_ID,
    version: MOD_VERSION,
  });
  globalThis[INSTALL_FLAG] = state;
  log(`v${MOD_VERSION} active — temporary dungeon and container patches installed`);
  return state;
}

let installResult;
try {
  installResult = install();
} catch (error) {
  log(`loader failed: ${error.message}`);
  throw error;
}

module.exports = Object.freeze({
  ...installResult,
  MOD_VERSION,
  _testing: Object.freeze({
    DUNGEON_SERVICE_PATH,
    INV_BROKER_SERVICE_PATH,
    RECONCILE_DELAYS_MS,
    DUNGEON_DIAGNOSTICS_ENABLED,
    TERMINAL_SITE_MARKER_CLEANUP_ENABLED,
    DUNGEON_TRACKING_RUNTIME_PATH,
    DUNGEON_CACHE_MGR_SERVICE_PATH,
    buildContainerOutOfRangeMessage,
    isDungeonScopedEntity,
    matchedDungeonInstanceCount,
    patchInvBrokerService,
    ensureSceneMaterializedSiteMarker,
    shouldReconcile,
    patchDungeonService,
    patchDungeonTrackingRuntime,
    patchDungeonInstanceCacheMgrService:
      dungeonAnomalyCachePatch.patchDungeonInstanceCacheMgrService,
    buildCombatProjection: dungeonAnomalyCachePatch._testing.buildCombatProjection,
    sweepTerminalSiteMarkers:
      dungeonTerminalSiteTickPatch._testing.sweepTerminalSiteMarkers,
    resolveTerminalSiteInstanceID:
      dungeonTerminalSiteTickPatch._testing.resolveInstanceID,
  }),
});
