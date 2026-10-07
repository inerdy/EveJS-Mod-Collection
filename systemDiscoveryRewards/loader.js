"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "systemdiscoveryrewards";
const MOD_VERSION = "0.2.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const SPACE_RUNTIME_SESSIONS_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}runtime${path.sep}spaceRuntime${path.sep}sessions.js`;
const INSTALLED = Symbol.for("evejs.systemDiscoveryRewards.loaderInstalled");

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
      const SystemDiscoveryRewardsService = require(path.join(
        __dirname,
        "lib",
        "systemDiscoveryRewardsService",
      ));
      service = new SystemDiscoveryRewardsService();
    }
    return service;
  }

  function wrapServiceManager(exported) {
    if (serviceManagers.has(exported)) {
      return serviceManagers.get(exported);
    }
    class SystemDiscoveryRewardsServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("systemDiscoveryRewards")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(SystemDiscoveryRewardsServiceManager, exported);
    serviceManagers.set(exported, SystemDiscoveryRewardsServiceManager);
    return SystemDiscoveryRewardsServiceManager;
  }

  function wrapSpaceRuntimeSessions(exported) {
    if (sessionModules.has(exported)) {
      return sessionModules.get(exported);
    }
    const wrapped = Object.assign({}, exported, {
      attachSession(...args) {
        const session = args[0];
        const options = args[2] || {};
        let candidate = null;
        try {
          candidate = getService().prepareArrival(session, options);
        } catch (error) {
          log(`arrival preparation failed safely: ${error.message}`);
        }

        const result = exported.attachSession.apply(this, args);
        if (result && candidate) {
          try {
            void getService().handleArrival(candidate, session).catch((error) => {
              log(`arrival reward failed safely: ${error.message}`);
            });
          } catch (error) {
            log(`arrival reward failed safely: ${error.message}`);
          }
        }
        return result;
      },
    });
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
log(`v${MOD_VERSION} active — system discovery rewards enabled`);

module.exports = Object.freeze({
  active: true,
  id: MOD_ID,
  version: MOD_VERSION,
});
