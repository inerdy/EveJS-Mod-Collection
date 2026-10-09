"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "salvagebuddy";
const MOD_VERSION = "0.2.6";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const INSTALLED = Symbol.for("evejs.salvageBuddy.loaderInstalled");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  let service = null;
  let serviceManagerReady = false;

  function getService() {
    if (!service) {
      const Service = require(path.join(__dirname, "lib", "salvageBuddyService"));
      service = new Service();
    }
    return service;
  }

  function wrapServiceManager(exported) {
    if (serviceManagers.has(exported)) return serviceManagers.get(exported);
    class SalvageBuddyServiceManager extends exported {
      constructor(...args) {
        super(...args);
        serviceManagerReady = true;
        if (!this.lookup("salvageBuddy")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(SalvageBuddyServiceManager, exported);
    serviceManagers.set(exported, SalvageBuddyServiceManager);
    return SalvageBuddyServiceManager;
  }

  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    return exported;
  };
  Module._load[INSTALLED] = true;
}

installHooks();
log(`v${MOD_VERSION} active — fitted Noctis salvage service enabled`);

module.exports = Object.freeze({active: true, id: MOD_ID, version: MOD_VERSION});
