"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "dungeonrespawncooldown";
const MOD_VERSION = "0.1.0";
const INSTALL_FLAG = Symbol.for("evejs.dungeonRespawnCooldown.loaderInstalled");
const LOAD_HOOK_FLAG = Symbol.for("evejs.dungeonRespawnCooldown.loadHookInstalled");
const UNIVERSE_RUNTIME_PATCH_FLAG = Symbol.for(
  "evejs.dungeonRespawnCooldown.universeRuntimePatchInstalled",
);
const SITE_ADAPTER_PATCH_FLAG = Symbol.for(
  "evejs.dungeonRespawnCooldown.siteAdapterPatchInstalled",
);
const SIGNATURE_RUNTIME_PATCH_FLAG = Symbol.for(
  "evejs.dungeonRespawnCooldown.signatureRuntimePatchInstalled",
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
  return listTerminals.call(runtime, {full: true})
    .filter((instance) => (
      isCooldownEligibleAnomaly(instance) &&
      (!scopedSystemIDs || scopedSystemIDs.has(toPositiveInt(instance.solarSystemID)))
    ));
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

  service.getUniversePersistentLifecycleBoundary = function dungeonRespawnCooldownGetLifecycleBoundary(
    nowMs = Date.now(),
    boundaryOptions = {},
  ) {
    const normalizedNowMs = toPositiveInt(nowMs) || Date.now();
    let boundary = originalGetBoundary.call(this, normalizedNowMs, boundaryOptions);
    for (const instance of listCooldownAnomalies(runtime, boundaryOptions)) {
      if (isSiteTeardownParked(instance, options)) {
        continue;
      }
      boundary = compareBoundary(boundary, {
        boundaryAtMs: getAnomalyCooldownDeadline(instance),
        instanceID: toPositiveInt(instance.instanceID),
        phase: "rotation",
      });
    }
    return boundary;
  };

  service.advanceUniversePersistentSites = function dungeonRespawnCooldownAdvanceUniversePersistentSites(
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

    runtime.listUniversePersistentTerminalInstances = function dungeonRespawnCooldownListTerminalInstances(...args) {
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
  service.enrichSiteWithDungeonRuntime = function dungeonRespawnCooldownEnrichSiteWithDungeonRuntime(
    site,
    enrichOptions = {},
  ) {
    const instance = findCooldownAnomalyForSite(runtime, site, enrichOptions);
    if (instance && getAnomalyCooldownDeadline(instance) > Date.now()) {
      return {
        ...cloneValue(site),
        instanceID: null,
        dungeonID: null,
        templateID: null,
        dungeonRespawnCooldownActive: true,
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
  service.listSystemAnomalySites = function dungeonRespawnCooldownListSystemAnomalySites(...args) {
    return originalListAnomalySites.apply(this, args)
      .filter((site) => site && site.dungeonRespawnCooldownActive !== true);
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
  if (resolvedPath === DUNGEON_UNIVERSE_RUNTIME_PATH) {
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
  Module._load = function dungeonRespawnCooldownLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    return applyRuntimePatch(resolved, exported);
  };
  Module._load[LOAD_HOOK_FLAG] = true;

  for (const modulePath of [
    DUNGEON_UNIVERSE_RUNTIME_PATH,
    DUNGEON_SITE_ADAPTER_PATH,
    SIGNATURE_RUNTIME_PATH,
  ]) {
    const cachedModule = Module._cache[modulePath];
    if (cachedModule) {
      applyRuntimePatch(modulePath, cachedModule.exports);
    }
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
  log(`v${MOD_VERSION} active — 30-minute cleared-anomaly cooldown installed`);
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
    DUNGEON_RUNTIME_PATH,
    DUNGEON_UNIVERSE_RUNTIME_PATH,
    DUNGEON_SITE_ADAPTER_PATH,
    SIGNATURE_RUNTIME_PATH,
    CLEARED_ANOMALY_COOLDOWN_MS,
    getAnomalyCooldownDeadline,
    isCooldownEligibleAnomaly,
    findCooldownAnomalyForSite,
    listBlockedCooldownAnomalies,
    patchDungeonUniverseRuntime,
    patchDungeonSiteAdapter,
    patchSignatureRuntime,
  }),
});
