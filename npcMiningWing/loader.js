"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "npcminingwing";
const MOD_VERSION = "0.10.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const INSTALLED = Symbol.for("evejs.npcMiningWing.loaderInstalled");

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

    const WingService = require(path.join(__dirname, "lib", "npcMiningWingService"));
    class MiningWingServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("npcMiningWing")) {
          this.register(new WingService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(MiningWingServiceManager, exported);
    serviceManagerCache.set(exported, MiningWingServiceManager);
    return MiningWingServiceManager;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

const droneBridge = require(path.join(
  __dirname,
  "lib",
  "npcMiningWingDroneBridge",
));

droneBridge.install();
installServiceRegistrationHook();
log(
  `v${MOD_VERSION} active — server service, client menu, and automatic drone ` +
    `management enabled`,
);

module.exports = Object.freeze({
  id: MOD_ID,
  version: MOD_VERSION,
  active: true,
});
