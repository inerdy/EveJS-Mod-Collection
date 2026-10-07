"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "npcmarketliquidity";
const MOD_VERSION = "0.3.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const INSTALLED = Symbol.for("evejs.npcMarketLiquidity.loaderInstalled");
const MARKET_BRIDGE_INSTALLED = Symbol.for("evejs.npcMarketLiquidity.marketBridgeInstalled");

function installLegacyMarketCompatibilityBridge() {
  const Service = require(path.join(__dirname, "lib", "npcMarketLiquidityService"));
  const marketDaemonClient = require(path.join(
    __dirname,
    "..",
    "..",
    "server",
    "src",
    "services",
    "market",
    "marketDaemonClient",
  )).marketDaemonClient;
  if (marketDaemonClient[MARKET_BRIDGE_INSTALLED]) return;
  const originalCall = marketDaemonClient.call.bind(marketDaemonClient);
  marketDaemonClient.call = async function legacyCompatibleCall(method, params, options) {
    const result = await originalCall(method, params, options);
    return method === "GetOrders"
      ? Service._testing.rewriteLegacyOrderSources(result)
      : result;
  };
  marketDaemonClient[MARKET_BRIDGE_INSTALLED] = true;
}

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
    // the role and the bridge can safely load the service dependencies.
    installLegacyMarketCompatibilityBridge();
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
