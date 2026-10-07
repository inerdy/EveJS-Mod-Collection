"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "autoshoprepair";
const MOD_VERSION = "0.1.2";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const TRANSITIONS_SUFFIX = `${path.sep}server${path.sep}src${path.sep}space${path.sep}transitions.js`;
const INSTALLED = Symbol.for("evejs.autoShopRepair.loaderInstalled");
const API_SYMBOL = "evejs.autoShopRepair";

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function install() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagerCache = new WeakMap();
  const transitionModuleCache = new WeakMap();
  let serviceInstance = null;
  let AutoShopRepairService = null;

  globalThis[Symbol.for(API_SYMBOL)] = Object.freeze({
    version: MOD_VERSION,
    onDocked(...args) {
      return serviceInstance ? serviceInstance.onDocked(...args) : Promise.resolve({success: false, skipped: true});
    },
  });

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (String(resolved).endsWith(TRANSITIONS_SUFFIX)) {
      if (transitionModuleCache.has(exported)) return transitionModuleCache.get(exported);
      const wrapped = Object.assign({}, exported, {
        dockSession(...args) {
          const result = exported.dockSession(...args);
          if (result && result.success === true) {
            getService().onDocked(args[0], args[1]).catch((error) => {
              log(`post-dock repair failed safely: ${error.message}`);
            });
          }
          return result;
        },
      });
      transitionModuleCache.set(exported, wrapped);
      return wrapped;
    }
    if (!String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) return exported;
    if (serviceManagerCache.has(exported)) return serviceManagerCache.get(exported);

    class AutoShopRepairServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("autoShopRepair")) {
          serviceInstance = getService();
          this.register(serviceInstance);
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(AutoShopRepairServiceManager, exported);
    serviceManagerCache.set(exported, AutoShopRepairServiceManager);
    return AutoShopRepairServiceManager;
  }

  function getService() {
    if (!AutoShopRepairService) {
      AutoShopRepairService = require(path.join(__dirname, "lib", "autoShopRepairService"));
    }
    if (!serviceInstance) {
      serviceInstance = new AutoShopRepairService();
    }
    return serviceInstance;
  }

  load[INSTALLED] = true;
  Module._load = load;
  log(`v${MOD_VERSION} active — automatic NPC-station repair enabled`);
}

install();

module.exports = Object.freeze({id: MOD_ID, version: MOD_VERSION, active: true});
