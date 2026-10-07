"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "crimsonharvest";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const SPACE_RUNTIME_SESSIONS_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}runtime${path.sep}spaceRuntime${path.sep}sessions.js`;
const INSTALLED = Symbol.for("evejs.crimsonHarvest.loaderInstalled");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  const sessionModules = new WeakMap();
  let service = null;

  function getService() {
    if (!service) {
      const CrimsonHarvestService = require(path.join(
        __dirname,
        "lib",
        "crimsonHarvestService",
      ));
      service = new CrimsonHarvestService();
    }
    return service;
  }

  function wrapServiceManager(exported) {
    if (serviceManagers.has(exported)) {
      return serviceManagers.get(exported);
    }
    class CrimsonHarvestServiceManager extends exported {
      constructor(...args) {
        super(...args);
        const eventService = getService();
        if (!this.lookup("crimsonHarvest")) {
          this.register(eventService);
          log("server service registered");
        }
        void eventService.start();
      }
    }
    Object.setPrototypeOf(CrimsonHarvestServiceManager, exported);
    serviceManagers.set(exported, CrimsonHarvestServiceManager);
    return CrimsonHarvestServiceManager;
  }

  function wrapSpaceRuntimeSessions(exported) {
    if (sessionModules.has(exported)) {
      return sessionModules.get(exported);
    }
    const wrapped = Object.assign({}, exported);
    for (const methodName of ["attachSession", "attachSessionToExistingEntity"]) {
      if (typeof exported[methodName] !== "function") {
        continue;
      }
      wrapped[methodName] = function wrappedSessionAttachment(...args) {
        const result = exported[methodName].apply(this, args);
        if (result) {
          try {
            void getService().handleSessionAttached(
              args[0],
              result,
              args[2] || {},
            ).catch((error) => {
              log(`${methodName} reconciliation failed safely: ${error.message}`);
            });
          } catch (error) {
            log(`${methodName} reconciliation failed safely: ${error.message}`);
          }
        }
        return result;
      };
    }
    sessionModules.set(exported, wrapped);
    return wrapped;
  }

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    const resolvedText = String(resolved);
    if (resolvedText.endsWith(SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    if (resolvedText.endsWith(SPACE_RUNTIME_SESSIONS_SUFFIX)) {
      return wrapSpaceRuntimeSessions(exported);
    }
    return exported;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

installHooks();
log(`v${MOD_VERSION} active — Crimson Harvest mixed site event enabled`);

module.exports = Object.freeze({
  active: true,
  id: MOD_ID,
  version: MOD_VERSION,
});
