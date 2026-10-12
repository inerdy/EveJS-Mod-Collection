"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "npcmarketliquidity";
const MOD_VERSION = "0.6.3";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const INSTALLED = Symbol.for("evejs.npcMarketLiquidity.loaderInstalled");

function installServiceRegistrationHook() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagerCache = new WeakMap();
  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return exported;
    }
    // The launcher preloads this file before server/index.js runs. Do not
    // import any EveJS service at preload time: those imports can initialize
    // the game store before the server establishes its world-owner role.
    // By the time serviceManager is loaded, server/index.js has initialized
    // the role and we can safely load the service dependencies.
    if (serviceManagerCache.has(exported)) {
      return serviceManagerCache.get(exported);
    }
    const Service = require(path.join(__dirname, "lib", "npcMarketLiquidityService"));
    class NpcMarketLiquidityServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("npcMarketLiquidity")) {
          this.register(new Service());
        }
      }
    }
    Object.setPrototypeOf(NpcMarketLiquidityServiceManager, exported);
    serviceManagerCache.set(exported, NpcMarketLiquidityServiceManager);
    return NpcMarketLiquidityServiceManager;
  };
  Module._load[INSTALLED] = true;
}

installServiceRegistrationHook();
console.log(`[${MOD_ID}] v${MOD_VERSION} active — passive NPC market liquidity enabled`);
module.exports = Object.freeze({active: true, id: MOD_ID, version: MOD_VERSION});
