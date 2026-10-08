"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "serverhealthmonitor";
const MOD_VERSION = "0.2.0";
const SERVICE_MANAGER_SUFFIX = "/server/src/services/servicemanager.js";
const BEYONCE_SERVICE_SUFFIX = "/server/src/services/ship/beyonceservice.js";
const INSTALLED = Symbol.for("evejs.serverHealthMonitor.loaderInstalled");

function normalizedPath(value) {
  return String(value || "").replace(/[\\/]+/gu, "/").toLowerCase();
}

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  const beyonceServices = new WeakMap();
  let service = null;

  function getService() {
    if (!service) {
      const HealthMonitorService = require(path.join(
        __dirname,
        "lib",
        "healthMonitorService",
      ));
      service = new HealthMonitorService();
    }
    return service;
  }

  function wrapServiceManager(exported) {
    if (!exported) return exported;
    if (serviceManagers.has(exported)) return serviceManagers.get(exported);
    class ServerHealthMonitorServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("serverHealthMonitor")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(ServerHealthMonitorServiceManager, exported);
    serviceManagers.set(exported, ServerHealthMonitorServiceManager);
    return ServerHealthMonitorServiceManager;
  }

  function wrapBeyonceService(exported) {
    if (!exported || typeof exported !== "function") return exported;
    if (beyonceServices.has(exported)) return beyonceServices.get(exported);
    class ServerHealthBeyonceService extends exported {
      Handle_CmdStargateJump(args, session) {
        const sourceSystemID = session && session._space && session._space.systemID;
        const destinationSystemID = args && args[1] || 0;
        const monitor = getService();
        monitor.beginTransition("stargate-jump", {
          sourceSystemID,
          destinationSystemID,
        });
        try {
          return super.Handle_CmdStargateJump(args, session);
        } catch (error) {
          monitor.cancelTransition("stargate-jump");
          throw error;
        }
      }
    }
    Object.setPrototypeOf(ServerHealthBeyonceService, exported);
    beyonceServices.set(exported, ServerHealthBeyonceService);
    return ServerHealthBeyonceService;
  }

  function patchCachedServiceManager() {
    try {
      const resolved = require.resolve(path.join(
        __dirname,
        "..",
        "..",
        "server",
        "src",
        "services",
        "serviceManager",
      ));
      const cached = require.cache[resolved];
      if (cached) cached.exports = wrapServiceManager(cached.exports);
    } catch (_error) {
      // The normal Module._load path handles serviceManager when it loads later.
    }
  }

  function patchCachedBeyonceService() {
    try {
      const resolved = require.resolve(path.join(
        __dirname,
        "..",
        "..",
        "server",
        "src",
        "services",
        "ship",
        "beyonceService",
      ));
      const cached = require.cache[resolved];
      if (cached) cached.exports = wrapBeyonceService(cached.exports);
    } catch (_error) {
      // The normal Module._load path handles Beyonce when it loads later.
    }
  }

  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (normalizedPath(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    if (normalizedPath(resolved).endsWith(BEYONCE_SERVICE_SUFFIX)) {
      return wrapBeyonceService(exported);
    }
    return exported;
  };
  Module._load[INSTALLED] = true;
  patchCachedServiceManager();
  patchCachedBeyonceService();
}

installHooks();
log(`v${MOD_VERSION} active — live server health monitoring and transition diagnostics enabled`);

module.exports = Object.freeze({
  id: MOD_ID,
  version: MOD_VERSION,
  active: true,
});
