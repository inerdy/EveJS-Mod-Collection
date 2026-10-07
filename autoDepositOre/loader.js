"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "autodepositore";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const TRANSITIONS_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}transitions.js`;
const INSTALLED = Symbol.for("evejs.autoDepositOre.loaderInstalled");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  const transitionModules = new WeakMap();
  let service = null;

  function getService() {
    if (!service) {
      const AutoDepositOreService = require(path.join(
        __dirname,
        "lib",
        "autoDepositOreService",
      ));
      service = new AutoDepositOreService();
    }
    return service;
  }

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);

    if (String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      if (serviceManagers.has(exported)) {
        return serviceManagers.get(exported);
      }
      class AutoDepositOreServiceManager extends exported {
        constructor(...args) {
          super(...args);
          if (!this.lookup("autoDepositOre")) {
            this.register(getService());
            log("server service registered");
          }
        }
      }
      Object.setPrototypeOf(AutoDepositOreServiceManager, exported);
      serviceManagers.set(exported, AutoDepositOreServiceManager);
      return AutoDepositOreServiceManager;
    }

    if (!String(resolved).endsWith(TRANSITIONS_SUFFIX)) {
      return exported;
    }
    if (transitionModules.has(exported)) {
      return transitionModules.get(exported);
    }

      const wrapped = Object.assign({}, exported, {
        dockSession(...args) {
          const result = exported.dockSession(...args);
          try {
            getService().handleDockSuccess(args[0], args[1], result);
          } catch (error) {
            log(`post-dock deposit failed safely: ${error.message}`);
        }
        return result;
      },
    });
    transitionModules.set(exported, wrapped);
    return wrapped;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

installHooks();

log(`v${MOD_VERSION} active — docking deposit and client toggle enabled`);

module.exports = Object.freeze({
  id: MOD_ID,
  version: MOD_VERSION,
  active: true,
});
