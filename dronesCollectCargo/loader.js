"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "dronescollectcargo";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const DRONE_RUNTIME_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}drone${path.sep}droneRuntime.js`;
const SALVAGER_RUNTIME_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}modules${path.sep}salvagerRuntime.js`;
const INSTALLED = Symbol.for("evejs.dronesCollectCargo.loaderInstalled");
const DRONE_PATCHED = Symbol.for("evejs.dronesCollectCargo.dronePatched");
const SALVAGER_PATCHED = Symbol.for("evejs.dronesCollectCargo.salvagerPatched");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  let service = null;
  let serviceManagerReady = false;

  function getService() {
    if (!service) {
      const DronesCollectCargoService = require(path.join(
        __dirname,
        "lib",
        "dronesCollectCargoService",
      ));
      service = new DronesCollectCargoService();
    }
    return service;
  }

  function tryGetService() {
    if (!service && !serviceManagerReady) {
      return null;
    }
    try {
      return getService();
    } catch (error) {
      log(`service unavailable during startup: ${error.message}`);
      return null;
    }
  }

  function wrapServiceManager(exported) {
    if (serviceManagers.has(exported)) {
      return serviceManagers.get(exported);
    }
    class DronesCollectCargoServiceManager extends exported {
      constructor(...args) {
        super(...args);
        serviceManagerReady = true;
        if (!this.lookup("dronesCollectCargo")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(DronesCollectCargoServiceManager, exported);
    serviceManagers.set(exported, DronesCollectCargoServiceManager);
    return DronesCollectCargoServiceManager;
  }

  function patchSalvagerRuntime(exported) {
    if (!exported || exported[SALVAGER_PATCHED]) {
      return exported;
    }
    const originalIsSalvageableTarget = exported.isSalvageableTarget;
    const originalExecuteSalvagerCycle = exported.executeSalvagerCycle;
    if (typeof originalIsSalvageableTarget === "function") {
      exported.isSalvageableTarget = function patchedIsSalvageableTarget(...args) {
        const serviceInstance = tryGetService();
        return (
          originalIsSalvageableTarget.apply(this, args) ||
          Boolean(
            serviceInstance &&
            serviceInstance.isDroneSalvageContextActive() &&
            serviceInstance.isCargoContainerTarget(args[0]),
          )
        );
      };
    }
    if (typeof originalExecuteSalvagerCycle === "function") {
      exported.executeSalvagerCycle = function patchedExecuteSalvagerCycle(...args) {
        const request = args[0] || {};
        const serviceInstance = tryGetService();
        if (
          serviceInstance &&
          serviceInstance.isDroneSalvageContextActive() &&
          request.callbacks &&
          request.callbacks.salvageRewardLocationID &&
          serviceInstance.isCargoContainerTarget(serviceInstance.resolveTarget(request))
        ) {
          return serviceInstance.collectContainer(request);
        }
        return originalExecuteSalvagerCycle.apply(this, args);
      };
    }
    exported[SALVAGER_PATCHED] = true;
    return exported;
  }

  function patchDroneRuntime(exported) {
    if (!exported || exported[DRONE_PATCHED]) {
      return exported;
    }
    const originalTickScene = exported.tickScene;
    const originalCommandSalvage = exported.commandSalvage;
    if (typeof originalTickScene === "function") {
      exported.tickScene = function patchedTickScene(...args) {
        const serviceInstance = tryGetService();
        if (!serviceInstance) {
          return originalTickScene.apply(this, args);
        }
        return serviceInstance.runDroneTick(
          exported,
          args[0],
          args[1],
          () => originalTickScene.apply(this, args),
        );
      };
    }
    if (typeof originalCommandSalvage === "function") {
      exported.commandSalvage = function patchedCommandSalvage(...args) {
        const serviceInstance = tryGetService() || getService();
        return serviceInstance
          ? serviceInstance.withDroneSalvageContext(
            () => originalCommandSalvage.apply(this, args),
          )
          : originalCommandSalvage.apply(this, args);
      };
    }
    const serviceInstance = tryGetService();
    if (serviceInstance) {
      serviceInstance.attachDroneRuntime(exported);
    }
    exported[DRONE_PATCHED] = true;
    return exported;
  }

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    const resolvedText = String(resolved);
    if (resolvedText.endsWith(SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    if (resolvedText.endsWith(SALVAGER_RUNTIME_SUFFIX)) {
      return patchSalvagerRuntime(exported);
    }
    if (resolvedText.endsWith(DRONE_RUNTIME_SUFFIX)) {
      return patchDroneRuntime(exported);
    }
    return exported;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

installHooks();
log(`v${MOD_VERSION} active — salvage drones collect legal cargo containers and return to bay`);

module.exports = Object.freeze({
  active: true,
  id: MOD_ID,
  version: MOD_VERSION,
});
