"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "starterregionbelts";
const MOD_VERSION = "0.1.1";
const INSTALL_FLAG = Symbol.for("evejs.starterRegionBelts.loaderInstalled");
const LOAD_HOOK_FLAG = Symbol.for("evejs.starterRegionBelts.loadHookInstalled");
const PATCH_NAMESPACE = "evejs.starterRegionBelts.patch";

const registry = require(path.join(__dirname, "lib", "beltRegistry"));

const TARGETS = Object.freeze({
  asteroidData: path.resolve(
    __dirname,
    "..",
    "..",
    "server",
    "src",
    "space",
    "asteroids",
    "asteroidData.js",
  ),
  configService: path.resolve(
    __dirname,
    "..",
    "..",
    "server",
    "src",
    "services",
    "config",
    "configService.js",
  ),
  worldData: path.resolve(
    __dirname,
    "..",
    "..",
    "server",
    "src",
    "space",
    "worldData.js",
  ),
});

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function patchMethod(target, methodName, wrapperFactory) {
  if (!target || typeof target[methodName] !== "function") {
    throw new Error(`Cannot patch missing method ${methodName}`);
  }
  const marker = Symbol.for(`${PATCH_NAMESPACE}.${methodName}`);
  if (target[marker] === true) {
    return false;
  }
  const original = target[methodName];
  const replacement = wrapperFactory(original);
  if (typeof replacement !== "function") {
    throw new Error(`Patch for ${methodName} did not return a function`);
  }
  target[methodName] = replacement;
  Object.defineProperty(target, marker, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}

function installBeltDataOverlay(asteroidData, worldData) {
  if (asteroidData) {
    patchMethod(asteroidData, "getBeltsForSystem", (original) => function getBeltsForSystem(systemID) {
      return registry.mergeBelts(
        original.call(this, systemID),
        registry.getBeltsForSystem(systemID),
      );
    });
    patchMethod(asteroidData, "getBeltByID", (original) => function getBeltByID(itemID) {
      return original.call(this, itemID) || registry.getBeltByID(itemID);
    });
  }

  if (worldData) {
    patchMethod(worldData, "getAsteroidBeltsForSystem", (original) => function getAsteroidBeltsForSystem(systemID) {
      return registry.mergeBelts(
        original.call(this, systemID),
        registry.getBeltsForSystem(systemID),
      );
    });
    patchMethod(worldData, "getAsteroidBeltByID", (original) => function getAsteroidBeltByID(itemID) {
      return original.call(this, itemID) || registry.getBeltByID(itemID);
    });
    patchMethod(worldData, "getCelestialsForSystem", (original) => function getCelestialsForSystem(systemID) {
      return registry.mergeBelts(
        original.call(this, systemID),
        registry.getBeltsForSystem(systemID),
      );
    });
    patchMethod(worldData, "getCelestialByID", (original) => function getCelestialByID(itemID) {
      return original.call(this, itemID) || registry.getBeltByID(itemID);
    });
    patchMethod(worldData, "getStaticSceneForSystem", (original) => function getStaticSceneForSystem(systemID) {
      return registry.mergeBelts(
        original.call(this, systemID),
        registry.getBeltsForSystem(systemID),
      );
    });
  }
}

function installLocationOverlay(configService) {
  const prototype = configService && configService.prototype;
  if (!prototype) {
    throw new Error("ConfigService prototype is unavailable");
  }
  patchMethod(
    prototype,
    "Handle_GetMultiLocationsEx",
    (original) => function Handle_GetMultiLocationsEx(args, session) {
      const result = original.call(this, args, session);
      return registry.augmentLocationTuple(result, args);
    },
  );
}

function applyRuntimeOverlay(resolved, exported) {
  if (resolved === TARGETS.asteroidData) {
    installBeltDataOverlay(exported, null);
  } else if (resolved === TARGETS.worldData) {
    installBeltDataOverlay(null, exported);
  } else if (resolved === TARGETS.configService) {
    installLocationOverlay(exported);
  }
  return exported;
}

function installLazyRuntimeHook() {
  if (Module._load[LOAD_HOOK_FLAG]) {
    return;
  }

  const originalLoad = Module._load;
  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    return applyRuntimeOverlay(resolved, exported);
  }

  load[LOAD_HOOK_FLAG] = true;
  Module._load = load;

  for (const filename of Object.keys(Module._cache)) {
    if (!Object.values(TARGETS).includes(path.resolve(filename))) {
      continue;
    }
    applyRuntimeOverlay(path.resolve(filename), Module._cache[filename].exports);
  }
}

function getCachedRuntimeCounts() {
  const worldModule = Module._cache[TARGETS.worldData];
  if (!worldModule || !worldModule.exports) {
    return {beltCount: null, targetSystemCount: null};
  }
  return {
    beltCount: registry.getAllBelts().length,
    targetSystemCount: registry.getTargetSystemIDs().length,
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) {
    return globalThis[INSTALL_FLAG];
  }

  installLazyRuntimeHook();
  const cachedCounts = getCachedRuntimeCounts();
  const expectedSystemCount = Number(registry.CONFIG.expectedSystemCount) || 0;
  if (
    expectedSystemCount > 0 &&
    cachedCounts.targetSystemCount !== null &&
    cachedCounts.targetSystemCount !== expectedSystemCount
  ) {
    log(
      `warning: expected ${expectedSystemCount} target systems, found ${cachedCounts.targetSystemCount}`,
    );
  }

  const state = Object.freeze({
    active: true,
    beltCount: cachedCounts.beltCount,
    id: MOD_ID,
    targetSystemCount: cachedCounts.targetSystemCount,
    version: MOD_VERSION,
  });
  globalThis[INSTALL_FLAG] = state;
  if (cachedCounts.beltCount === null) {
    log(`v${MOD_VERSION} active — lazy runtime overlays installed`);
  } else {
    log(
      `v${MOD_VERSION} active — ${cachedCounts.beltCount} deterministic belt(s) added to ` +
        `${cachedCounts.targetSystemCount} system(s)`,
    );
  }
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
  CONFIG: registry.CONFIG,
  MOD_VERSION,
  _testing: Object.freeze({
    installBeltDataOverlay,
    installLocationOverlay,
    patchMethod,
  }),
});
