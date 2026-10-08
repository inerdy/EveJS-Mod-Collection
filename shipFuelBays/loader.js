"use strict";

const Module = require("node:module");
const path = require("node:path");

const {loadConfig} = require("./lib/config");
const {ShipFuelBaysService} = require("./lib/shipFuelBaysService");

const MOD_ID = "shipfuelbays";
const MOD_VERSION = "0.1.2";
const LIVE_FITTING_SUFFIX = path.join(
  "server",
  "src",
  "services",
  "fitting",
  "liveFittingState.js",
);
const FITTING_RUNTIME_SUFFIX = path.join(
  "server",
  "src",
  "_secondary",
  "fitting",
  "fittingRuntime.js",
);
const DOGMA_SERVICE_SUFFIX = path.join(
  "server",
  "src",
  "services",
  "dogma",
  "dogmaService.js",
);
const SHIP_WARP_FUEL_SERVICE_SUFFIX = path.join(
  "mods",
  "shipWarpFuel",
  "lib",
  "shipWarpFuelService.js",
);
const INSTALLED = Symbol.for("evejs.shipFuelBays.loaderInstalled");
const LIVE_WRAPPED = Symbol.for("evejs.shipFuelBays.liveWrapped");
const FITTING_WRAPPED = Symbol.for("evejs.shipFuelBays.fittingWrapped");
const DOGMA_WRAPPED = Symbol.for("evejs.shipFuelBays.dogmaWrapped");
const WARP_FUEL_WRAPPED = Symbol.for("evejs.shipFuelBays.warpFuelWrapped");

const config = loadConfig();
const service = new ShipFuelBaysService(config);

function log(message) {
  console.log("[" + MOD_ID + "] " + message);
}

function normalized(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function matchesSuffix(filename, suffix) {
  return normalized(filename).endsWith(normalized(suffix));
}

function wrapLiveFittingState(exported) {
  if (!exported || exported[LIVE_WRAPPED]) return exported;
  const original = exported.buildShipResourceState;
  if (typeof original === "function") {
    exported.buildShipResourceState = function shipFuelBaysResourceState(...args) {
      const result = original.apply(this, args);
      return service.decorateResourceState(result, args[1]);
    };
  }
  Object.defineProperty(exported, LIVE_WRAPPED, {
    configurable: true,
    value: true,
  });
  return exported;
}

function wrapFittingRuntime(exported) {
  if (!exported || exported[FITTING_WRAPPED]) return exported;
  for (const methodName of [
    "getShipFittingSnapshot",
    "refreshShipFittingSnapshot",
    "peekShipFittingSnapshot",
  ]) {
    const original = exported[methodName];
    if (typeof original !== "function") continue;
    exported[methodName] = function shipFuelBaysFittingSnapshot(...args) {
      return service.decorateFittingSnapshot(original.apply(this, args));
    };
  }
  Object.defineProperty(exported, FITTING_WRAPPED, {
    configurable: true,
    value: true,
  });
  return exported;
}

function wrapDogmaService(exported) {
  const prototype = exported && exported.prototype;
  if (!prototype || prototype[DOGMA_WRAPPED]) return exported;

  const originalShipAttributes = prototype._buildShipAttributes;
  if (typeof originalShipAttributes === "function") {
    prototype._buildShipAttributes = function shipFuelBaysDogmaAttributes(...args) {
      const attributes = originalShipAttributes.apply(this, args);
      return service.decorateShipAttributes(attributes, args[1]);
    };
  }

  const originalShipBaseAttributes = prototype._buildShipBaseAttributes;
  if (typeof originalShipBaseAttributes === "function") {
    prototype._buildShipBaseAttributes = function shipFuelBaysDogmaBaseAttributes(...args) {
      const attributes = originalShipBaseAttributes.apply(this, args);
      return service.decorateShipBaseAttributes(attributes, args[0]);
    };
  }

  const originalInventoryAttributes = prototype._buildInventoryItemAttributes;
  if (typeof originalInventoryAttributes === "function") {
    prototype._buildInventoryItemAttributes = function shipFuelBaysInventoryAttributes(...args) {
      const attributes = originalInventoryAttributes.apply(this, args);
      return service.decorateShipAttributes(attributes, args[0]);
    };
  }

  const originalShipAttributeDict = prototype._buildShipAttributeDict;
  if (typeof originalShipAttributeDict === "function") {
    prototype._buildShipAttributeDict = function shipFuelBaysShipAttributeDict(...args) {
      const attributeDict = originalShipAttributeDict.apply(this, args);
      return service.decorateShipAttributeDict(attributeDict, args[1]);
    };
  }
  Object.defineProperty(prototype, DOGMA_WRAPPED, {
    configurable: true,
    value: true,
  });
  return exported;
}

function wrapWarpFuelService(exported) {
  const prototype = exported && exported.prototype;
  if (!prototype || prototype[WARP_FUEL_WRAPPED]) return exported;

  const originalResourceDecorator = prototype.decorateResourceState;
  if (typeof originalResourceDecorator === "function") {
    prototype.decorateResourceState = function shipFuelBaysAfterWarpFuel(resourceState) {
      const result = originalResourceDecorator.call(this, resourceState);
      return service.reapplyMarkedResourceState(result);
    };
  }

  const originalSnapshotDecorator = prototype.decorateFittingSnapshot;
  if (typeof originalSnapshotDecorator === "function") {
    prototype.decorateFittingSnapshot = function shipFuelBaysAfterWarpFuelSnapshot(snapshot) {
      const result = originalSnapshotDecorator.call(this, snapshot);
      return service.decorateFittingSnapshot(result);
    };
  }

  Object.defineProperty(prototype, WARP_FUEL_WRAPPED, {
    configurable: true,
    value: true,
  });
  return exported;
}

function patchModule(filename, exported) {
  if (matchesSuffix(filename, LIVE_FITTING_SUFFIX)) {
    return wrapLiveFittingState(exported);
  }
  if (matchesSuffix(filename, FITTING_RUNTIME_SUFFIX)) {
    return wrapFittingRuntime(exported);
  }
  if (matchesSuffix(filename, DOGMA_SERVICE_SUFFIX)) {
    return wrapDogmaService(exported);
  }
  if (matchesSuffix(filename, SHIP_WARP_FUEL_SERVICE_SUFFIX)) {
    return wrapWarpFuelService(exported);
  }
  return exported;
}

function patchCachedModules() {
  for (const [filename, record] of Object.entries(require.cache)) {
    if (record && record.exports) {
      patchModule(filename, record.exports);
    }
  }
}

function installHooks() {
  if (Module._load[INSTALLED]) return;
  patchCachedModules();
  const originalLoad = Module._load;
  Module._load = function shipFuelBaysLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    return patchModule(resolved, exported);
  };
  Object.defineProperty(Module._load, INSTALLED, {
    configurable: true,
    value: true,
  });
}

installHooks();
log(
  "v" + MOD_VERSION +
  (config.enabled
    ? " active — adding base-cargo fuel bays to ships without native fuel bays"
    : " loaded but disabled"),
);

module.exports = Object.freeze({
  MOD_ID,
  MOD_VERSION,
  active: config.enabled,
  _testing: {
    config,
    service,
    patchModule,
    wrapLiveFittingState,
    wrapFittingRuntime,
    wrapDogmaService,
  },
});
