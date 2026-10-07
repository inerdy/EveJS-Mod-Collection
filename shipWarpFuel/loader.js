"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "shipwarpfuel";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const SESSION_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}runtime${path.sep}spaceRuntime${path.sep}sessions.js`;
const RUNTIME_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}runtime.js`;
const FITTING_RUNTIME_SUFFIX = `${path.sep}server${path.sep}src${path.sep}_secondary${path.sep}fitting${path.sep}fittingRuntime.js`;
const LIVE_FITTING_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}fitting${path.sep}liveFittingState.js`;
const INSTALLED = Symbol.for("evejs.shipWarpFuel.loaderInstalled");
const RUNTIME_WRAPPED = Symbol.for("evejs.shipWarpFuel.runtimeWrapped");
const FITTING_WRAPPED = Symbol.for("evejs.shipWarpFuel.fittingWrapped");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  const sessionModules = new WeakMap();
  let service = null;
  let serviceManagerReady = false;

  function getService() {
    if (!service) {
      const Service = require(path.join(__dirname, "lib", "shipWarpFuelService"));
      service = new Service();
    }
    return service;
  }

  function tryGetService() {
    if (!service && !serviceManagerReady) return null;
    try {
      return getService();
    } catch (error) {
      log(`service unavailable during startup: ${error.message}`);
      return null;
    }
  }

  function wrapServiceManager(exported) {
    if (serviceManagers.has(exported)) return serviceManagers.get(exported);
    class ShipWarpFuelServiceManager extends exported {
      constructor(...args) {
        super(...args);
        serviceManagerReady = true;
        if (!this.lookup("shipWarpFuel")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(ShipWarpFuelServiceManager, exported);
    serviceManagers.set(exported, ShipWarpFuelServiceManager);
    return ShipWarpFuelServiceManager;
  }

  function wrapSessions(exported) {
    if (sessionModules.has(exported)) return sessionModules.get(exported);
    const wrapped = Object.assign({}, exported, {
      attachSession(...args) {
        const result = exported.attachSession.apply(this, args);
        if (result) {
          try {
            tryGetService()?.ensureInitialFuel(args[0], args[1]);
          } catch (error) {
            log(`initial active-ship fuel failed safely: ${error.message}`);
          }
        }
        return result;
      },
    });
    sessionModules.set(exported, wrapped);
    return wrapped;
  }

  function wrapWarpRuntime(exported) {
    if (!exported || exported[RUNTIME_WRAPPED]) return exported;
    for (const [methodName, kind] of [["warpToEntity", "entity"], ["warpToPoint", "point"]]) {
      const original = exported[methodName];
      if (typeof original !== "function") continue;
      exported[methodName] = function wrappedWarp(...args) {
        const serviceInstance = tryGetService();
        if (!serviceInstance) return original.apply(this, args);
        const plan = serviceInstance.prepareWarp(args[0], kind, args[1]);
        if (plan && plan.blocked) return plan.result;
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          if (plan) serviceInstance.finishWarp(plan, {success: false});
          throw error;
        }
        if (result && typeof result.then === "function") {
          return result.then(
            (resolved) => serviceInstance.finishWarp(plan, resolved),
            (error) => {
              if (plan) serviceInstance.finishWarp(plan, {success: false});
              throw error;
            },
          );
        }
        return serviceInstance.finishWarp(plan, result);
      };
    }
    exported[RUNTIME_WRAPPED] = true;
    return exported;
  }

  function wrapFittingRuntime(exported) {
    if (!exported || exported[FITTING_WRAPPED]) return exported;
    for (const methodName of ["getShipFittingSnapshot", "refreshShipFittingSnapshot", "peekShipFittingSnapshot"]) {
      const original = exported[methodName];
      if (typeof original !== "function") continue;
      exported[methodName] = function wrappedFittingSnapshot(...args) {
        const result = original.apply(this, args);
        const serviceInstance = tryGetService();
        return serviceInstance ? serviceInstance.decorateFittingSnapshot(result) : result;
      };
    }
    exported[FITTING_WRAPPED] = true;
    return exported;
  }

  function wrapLiveFittingState(exported) {
    if (!exported || exported[FITTING_WRAPPED]) return exported;
    const original = exported.buildShipResourceState;
    if (typeof original === "function") {
      exported.buildShipResourceState = function wrappedResourceState(...args) {
        const result = original.apply(this, args);
        const serviceInstance = tryGetService();
        return serviceInstance ? serviceInstance.decorateResourceState(result) : result;
      };
    }
    exported[FITTING_WRAPPED] = true;
    return exported;
  }

  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    const resolvedText = String(resolved);
    if (resolvedText.endsWith(SERVICE_MANAGER_SUFFIX)) return wrapServiceManager(exported);
    if (resolvedText.endsWith(SESSION_SUFFIX)) return wrapSessions(exported);
    if (resolvedText.endsWith(RUNTIME_SUFFIX)) return wrapWarpRuntime(exported);
    if (resolvedText.endsWith(FITTING_RUNTIME_SUFFIX)) return wrapFittingRuntime(exported);
    if (resolvedText.endsWith(LIVE_FITTING_SUFFIX)) return wrapLiveFittingState(exported);
    return exported;
  };
  Module._load[INSTALLED] = true;
}

installHooks();
log(`v${MOD_VERSION} active — warp fuel, odometer, and emergency fuel enabled`);

module.exports = Object.freeze({active: true, id: MOD_ID, version: MOD_VERSION});
