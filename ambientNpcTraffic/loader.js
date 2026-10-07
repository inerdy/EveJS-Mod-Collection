"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "ambientnpctraffic";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const INSTALLED = Symbol.for("evejs.ambientNpcTraffic.loaderInstalled");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installServiceRegistrationHook() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagerCache = new WeakMap();

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return exported;
    }
    if (serviceManagerCache.has(exported)) {
      return serviceManagerCache.get(exported);
    }

    const AmbientNpcTrafficService = require(path.join(
      __dirname,
      "lib",
      "ambientNpcTrafficService",
    ));
    class AmbientNpcTrafficServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("ambientNpcTraffic")) {
          this.register(new AmbientNpcTrafficService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(AmbientNpcTrafficServiceManager, exported);
    serviceManagerCache.set(exported, AmbientNpcTrafficServiceManager);
    return AmbientNpcTrafficServiceManager;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

installServiceRegistrationHook();
log(
  `v${MOD_VERSION} active — cosmetic ambient traffic service enabled`,
);

module.exports = Object.freeze({
  active: true,
  id: MOD_ID,
  version: MOD_VERSION,
});
