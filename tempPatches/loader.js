"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "temppatches";
const MOD_VERSION = "0.1.2";
const INSTALL_FLAG = Symbol.for("evejs.tempPatches.loaderInstalled");
const LOAD_HOOK_FLAG = Symbol.for("evejs.tempPatches.loadHookInstalled");
const PATCH_FLAG = Symbol.for("evejs.tempPatches.dungeonWavePatchInstalled");
const INV_BROKER_PATCH_FLAG = Symbol.for("evejs.tempPatches.invBrokerPatchInstalled");
const UNIVERSE_RUNTIME_PATCH_FLAG = Symbol.for(
  "evejs.tempPatches.universeRuntimePatchInstalled",
);
const SITE_ADAPTER_PATCH_FLAG = Symbol.for(
  "evejs.tempPatches.siteAdapterPatchInstalled",
);
const SIGNATURE_RUNTIME_PATCH_FLAG = Symbol.for(
  "evejs.tempPatches.signatureRuntimePatchInstalled",
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
const DUNGEON_UNIVERSE_RUNTIME_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "dungeon",
  "dungeonUniverseRuntime.js",
);
const DUNGEON_SITE_ADAPTER_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "dungeon",
  "dungeonSiteAdapter.js",
);
const SIGNATURE_RUNTIME_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "server",
  "src",
  "services",
  "exploration",
  "signatures",
  "signatureRuntime.js",
);
const RECONCILE_DELAYS_MS = Object.freeze([0, 75, 300]);
const DEFAULT_CONTAINER_RANGE_METERS = 2_500;
const CLEARED_ANOMALY_COOLDOWN_MS = 30 * 60 * 1000;

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLowerText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return normalized || fallback;
}

function normalizeSystemIDs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => toPositiveInt(entry)).filter((entry) => entry > 0))];
}

function isCooldownEligibleAnomaly(instance) {
  if (!instance || normalizeLowerText(instance.lifecycleState, "") !== "completed") {
    return false;
  }
  if (normalizeLowerText(instance.siteKind, "") !== "anomaly") {
    return false;
  }
  // Generated mining sites already have their own respawn timer and must not receive
  // the combat-anomaly cooldown.
  return (
    normalizeLowerText(instance.siteOrigin, "") !== "generatedmining" &&
    normalizeLowerText(instance.lifecycleReason, "") !== "depleted"
  );
}

function getAnomalyCooldownDeadline(instance, cooldownMs = CLEARED_ANOMALY_COOLDOWN_MS) {
  if (!isCooldownEligibleAnomaly(instance)) {
    return 0;
  }
  const timers = instance.timers && typeof instance.timers === "object"
    ? instance.timers
    : {};
  const completedAtMs = toPositiveInt(timers.completedAtMs);
  if (completedAtMs <= 0) {
    return 0;
  }
  const existingExpiryMs = toPositiveInt(timers.expiresAtMs);
  return Math.max(
    completedAtMs + Math.max(0, Number(cooldownMs) || 0),
    existingExpiryMs,
  );
}

function isSiteTeardownParked(instance, options = {}) {
  if (typeof options.isSiteTeardownParked === "function") {
    return options.isSiteTeardownParked(instance) === true;
  }
  try {
    const siteService = require(path.join(
      __dirname,
      "..",
      "..",
      "server",
      "src",
      "services",
      "dungeon",
      "dungeonUniverseSiteService",
    ));
    return Boolean(
      siteService &&
      typeof siteService.isUniverseSiteTeardownParked === "function" &&
      siteService.isUniverseSiteTeardownParked(
        toPositiveInt(instance && instance.solarSystemID),
        toPositiveInt(instance && instance.instanceID),
      ) === true,
    );
  } catch (_error) {
    return false;
  }
}

function listCooldownAnomalies(runtime, options = {}) {
  const listTerminals = typeof options.listTerminalInstances === "function"
    ? options.listTerminalInstances
    : runtime && runtime.listUniversePersistentTerminalInstances;
  if (!runtime || typeof listTerminals !== "function") {
    return [];
  }
  const scopedSystemIDs = Array.isArray(options.systemIDs)
    ? new Set(normalizeSystemIDs(options.systemIDs))
    : null;
  return runtime
    ? listTerminals.call(runtime, {full: true})
    .filter((instance) => (
      isCooldownEligibleAnomaly(instance) &&
      (!scopedSystemIDs || scopedSystemIDs.has(toPositiveInt(instance.solarSystemID)))
    ))
    : [];
}

function listBlockedCooldownAnomalies(runtime, nowMs, options = {}) {
  const normalizedNowMs = toPositiveInt(nowMs) || Date.now();
  return listCooldownAnomalies(runtime, options).filter((instance) => (
    !isSiteTeardownParked(instance, options) &&
    getAnomalyCooldownDeadline(instance) > normalizedNowMs
  ));
}

function findCooldownAnomalyForSite(runtime, site, options = {}) {
  const systemID = toPositiveInt(site && site.solarSystemID) ||
    toPositiveInt(options.solarSystemID);
  const siteID = toPositiveInt(site && site.siteID);
  if (systemID <= 0 || siteID <= 0) {
    return null;
  }
  return listCooldownAnomalies(runtime).find((instance) => (
    toPositiveInt(instance && instance.solarSystemID) === systemID &&
    (
      toPositiveInt(instance && instance.metadata && instance.metadata.siteID) === siteID ||
      toPositiveInt(instance && instance.instanceID) === toPositiveInt(site && site.instanceID)
    )
  )) || null;
}

function compareBoundary(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (right.boundaryAtMs < left.boundaryAtMs) return right;
  if (right.boundaryAtMs === left.boundaryAtMs && right.instanceID < left.instanceID) return right;
  return left;
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

function scheduleWaveReconciliation(service, scene, entityOrID, options = {}) {
  if (!scene || typeof service.tickSceneSiteBehaviors !== "function") {
    return false;
  }

  ensureSceneMaterializedSiteMarker(scene, entityOrID);

  const pendingByScene = scheduleWaveReconciliation.pendingByScene;
  if (pendingByScene.has(scene)) {
    return false;
  }

  const state = {attempt: 0, timer: null};
  pendingByScene.set(scene, state);

  const run = () => {
    try {
      const progression = service.tickSceneSiteBehaviors(scene, {
        nowMs: resolveNowMs(scene, options),
        session: options.session || null,
      });
      const spawned = toPositiveInt(progression && progression.encountersSpawned);
      if (spawned > 0) {
        log(`dungeon wave reconciliation spawned ${spawned} encounter(s)`);
      }
    } catch (error) {
      log(`dungeon wave reconciliation failed: ${error.message}`);
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
    if (shouldReconcile(entityOrID, result)) {
      scheduleWaveReconciliation(this, scene, entityOrID, options);
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

function patchDungeonUniverseRuntime(service, options = {}) {
  if (!service || service[UNIVERSE_RUNTIME_PATCH_FLAG]) {
    return false;
  }
  if (
    typeof service.getUniversePersistentLifecycleBoundary !== "function" ||
    typeof service.advanceUniversePersistentSites !== "function"
  ) {
    throw new Error("Dungeon universe runtime does not expose the expected lifecycle methods");
  }

  const runtime = options.runtime || require(DUNGEON_RUNTIME_PATH);
  const originalGetBoundary = service.getUniversePersistentLifecycleBoundary;
  const originalAdvance = service.advanceUniversePersistentSites;

  service.getUniversePersistentLifecycleBoundary = function tempPatchesGetLifecycleBoundary(
    nowMs = Date.now(),
    boundaryOptions = {},
  ) {
    const normalizedNowMs = toPositiveInt(nowMs) || Date.now();
    let boundary = originalGetBoundary.call(this, normalizedNowMs, boundaryOptions);
    for (const instance of listCooldownAnomalies(runtime, boundaryOptions)) {
      if (isSiteTeardownParked(instance, options)) {
        continue;
      }
      const cooldownBoundary = {
        boundaryAtMs: getAnomalyCooldownDeadline(instance),
        instanceID: toPositiveInt(instance.instanceID),
        phase: "rotation",
      };
      boundary = compareBoundary(boundary, cooldownBoundary);
    }
    return boundary;
  };

  service.advanceUniversePersistentSites = function tempPatchesAdvanceUniversePersistentSites(
    advanceOptions = {},
  ) {
    const nowMs = toPositiveInt(advanceOptions && advanceOptions.nowMs) || Date.now();
    const originalListTerminals = runtime && runtime.listUniversePersistentTerminalInstances;
    if (typeof originalListTerminals !== "function") {
      return originalAdvance.call(this, advanceOptions);
    }

    const blockedInstanceIDs = new Set(
      listBlockedCooldownAnomalies(runtime, nowMs, {
        ...advanceOptions,
        listTerminalInstances: originalListTerminals,
      })
        .map((instance) => toPositiveInt(instance.instanceID))
        .filter((instanceID) => instanceID > 0),
    );

    runtime.listUniversePersistentTerminalInstances = function tempPatchesListTerminalInstances(...args) {
      const instances = originalListTerminals.apply(this, args);
      return instances.filter((instance) => !blockedInstanceIDs.has(toPositiveInt(instance.instanceID)));
    };

    try {
      return originalAdvance.call(this, advanceOptions);
    } finally {
      runtime.listUniversePersistentTerminalInstances = originalListTerminals;
    }
  };

  Object.defineProperty(service, UNIVERSE_RUNTIME_PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log(`cleared anomaly cooldown patch installed (${CLEARED_ANOMALY_COOLDOWN_MS / 60_000} minutes)`);
  return true;
}

function patchDungeonSiteAdapter(service, options = {}) {
  if (!service || service[SITE_ADAPTER_PATCH_FLAG]) {
    return false;
  }
  if (typeof service.enrichSiteWithDungeonRuntime !== "function") {
    throw new Error("Dungeon site adapter does not expose the expected enrichment method");
  }
  const runtime = options.runtime || require(DUNGEON_RUNTIME_PATH);
  const originalEnrich = service.enrichSiteWithDungeonRuntime;
  service.enrichSiteWithDungeonRuntime = function tempPatchesEnrichSiteWithDungeonRuntime(
    site,
    enrichOptions = {},
  ) {
    const instance = findCooldownAnomalyForSite(runtime, site, enrichOptions);
    if (
      instance &&
      getAnomalyCooldownDeadline(instance) > (Date.now())
    ) {
      return {
        ...cloneValue(site),
        instanceID: null,
        dungeonID: null,
        templateID: null,
        tempPatchesAnomalyCooldown: true,
      };
    }
    return originalEnrich.call(this, site, enrichOptions);
  };
  Object.defineProperty(service, SITE_ADAPTER_PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log("completed anomaly discovery suppression patch installed");
  return true;
}

function patchSignatureRuntime(service) {
  if (!service || service[SIGNATURE_RUNTIME_PATCH_FLAG]) {
    return false;
  }
  if (typeof service.listSystemAnomalySites !== "function") {
    throw new Error("Signature runtime does not expose the expected anomaly listing method");
  }
  const originalListAnomalySites = service.listSystemAnomalySites;
  service.listSystemAnomalySites = function tempPatchesListSystemAnomalySites(...args) {
    return originalListAnomalySites.apply(this, args)
      .filter((site) => site && site.tempPatchesAnomalyCooldown !== true);
  };
  Object.defineProperty(service, SIGNATURE_RUNTIME_PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log("completed anomaly discovery suppression patch installed");
  return true;
}

function applyRuntimePatch(resolved, exported) {
  const resolvedPath = path.resolve(resolved);
  if (resolvedPath === DUNGEON_SERVICE_PATH) {
    patchDungeonService(exported);
  } else if (resolvedPath === INV_BROKER_SERVICE_PATH) {
    patchInvBrokerService(exported);
  } else if (resolvedPath === DUNGEON_UNIVERSE_RUNTIME_PATH) {
    patchDungeonUniverseRuntime(exported);
  } else if (resolvedPath === DUNGEON_SITE_ADAPTER_PATH) {
    patchDungeonSiteAdapter(exported);
  } else if (resolvedPath === SIGNATURE_RUNTIME_PATH) {
    patchSignatureRuntime(exported);
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
  const cachedUniverseRuntime = Module._cache[DUNGEON_UNIVERSE_RUNTIME_PATH];
  if (cachedUniverseRuntime) {
    applyRuntimePatch(DUNGEON_UNIVERSE_RUNTIME_PATH, cachedUniverseRuntime.exports);
  }
  const cachedSiteAdapter = Module._cache[DUNGEON_SITE_ADAPTER_PATH];
  if (cachedSiteAdapter) {
    applyRuntimePatch(DUNGEON_SITE_ADAPTER_PATH, cachedSiteAdapter.exports);
  }
  const cachedSignatureRuntime = Module._cache[SIGNATURE_RUNTIME_PATH];
  if (cachedSignatureRuntime) {
    applyRuntimePatch(SIGNATURE_RUNTIME_PATH, cachedSignatureRuntime.exports);
  }
}

function install() {
  if (globalThis[INSTALL_FLAG]) {
    return globalThis[INSTALL_FLAG];
  }
  installLazyRuntimeHook();
  const state = Object.freeze({
    active: true,
    id: MOD_ID,
    version: MOD_VERSION,
  });
  globalThis[INSTALL_FLAG] = state;
  log(`v${MOD_VERSION} active — dungeon wave reconciliation patch installed`);
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
    CLEARED_ANOMALY_COOLDOWN_MS,
    getAnomalyCooldownDeadline,
    isCooldownEligibleAnomaly,
    findCooldownAnomalyForSite,
    listBlockedCooldownAnomalies,
    buildContainerOutOfRangeMessage,
    isDungeonScopedEntity,
    matchedDungeonInstanceCount,
    patchInvBrokerService,
    patchDungeonUniverseRuntime,
    patchDungeonSiteAdapter,
    patchSignatureRuntime,
    ensureSceneMaterializedSiteMarker,
    shouldReconcile,
    patchDungeonService,
  }),
});
