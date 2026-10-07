"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "npccouriercontracts";
const MOD_VERSION = "0.6.4";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const TRANSITIONS_SUFFIX = `${path.sep}server${path.sep}space${path.sep}transitions.js`;
const CONTRACT_PROXY_SUFFIX = `${path.sep}server${path.sep}services${path.sep}_other${path.sep}contractProxyService.js`;
const INSTALLED = Symbol.for("evejs.npcCourierContracts.loaderInstalled");
const DOCK_HOOKED = Symbol.for("evejs.npcCourierContracts.dockHooked");
const CONTRACT_PROXY_HOOKED = Symbol.for("evejs.npcCourierContracts.contractProxyHooked");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function contractIDFromArgs(args) {
  return positive(Array.isArray(args) ? args[0] : 0, 0);
}

function installHooks() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagerCache = new WeakMap();
  const transitionModuleCache = new WeakMap();
  const contractProxyCache = new WeakMap();
  let serviceInstance = null;
  let NpcCourierContractsService = null;

  function getService() {
    if (!NpcCourierContractsService) {
      NpcCourierContractsService = require(path.join(
        __dirname,
        "lib",
        "npcCourierContractsService",
      ));
    }
    if (!serviceInstance) {
      serviceInstance = new NpcCourierContractsService();
    }
    return serviceInstance;
  }

  function hookTransitions(exported) {
    if (!exported || typeof exported.dockSession !== "function") {
      return exported;
    }
    if (exported[DOCK_HOOKED]) {
      return exported;
    }
    const originalDockSession = exported.dockSession;
    function dockSessionWithAutomation(...args) {
      const result = originalDockSession.apply(this, args);
      if (result && result.success === true) {
        const session = args[0];
        const stationID = args[1] || (
          session && (
            session.stationID ||
            session.stationid ||
            session.stationid2 ||
            session.stationLocationID ||
            session.locationid
          )
        );
        getService().onDocked(session, 0, stationID).catch((error) => {
          log(`post-dock automation failed safely: ${error.message}`);
        });
      }
      return result;
    }
    Object.defineProperty(exported, DOCK_HOOKED, {value: true});
    exported.dockSession = dockSessionWithAutomation;
    return exported;
  }

  function hookContractProxy(exported) {
    if (!exported || !exported.prototype) {
      return exported;
    }
    const prototype = exported.prototype;
    if (prototype[CONTRACT_PROXY_HOOKED]) {
      return exported;
    }
    const originalAccept = prototype.Handle_AcceptContract;
    const originalComplete = prototype.Handle_CompleteContract;
    if (typeof originalAccept === "function") {
      prototype.Handle_AcceptContract = async function(...args) {
        const result = await originalAccept.apply(this, args);
        try {
          await getService().onContractAccepted(args[1], contractIDFromArgs(args[0]));
        } catch (error) {
          log(`contract acceptance automation failed safely: ${error.message}`);
        }
        return result;
      };
    }
    if (typeof originalComplete === "function") {
      prototype.Handle_CompleteContract = async function(...args) {
        const result = await originalComplete.apply(this, args);
        if (result === true) {
          try {
            await getService().onContractCompleted(args[1], contractIDFromArgs(args[0]));
          } catch (error) {
            log(`contract completion automation failed safely: ${error.message}`);
          }
        }
        return result;
      };
    }
    Object.defineProperty(prototype, CONTRACT_PROXY_HOOKED, {value: true});
    return exported;
  }

  function patchCachedModule(request, patcher) {
    try {
      const resolved = require.resolve(request);
      const cached = require.cache[resolved];
      if (cached) {
        patcher(cached.exports);
      }
    } catch (_error) {
      // The normal Module._load path will patch modules loaded later.
    }
  }

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    const resolvedString = String(resolved);

    if (resolvedString.endsWith(TRANSITIONS_SUFFIX)) {
      if (transitionModuleCache.has(exported)) {
        return transitionModuleCache.get(exported);
      }
      const patched = hookTransitions(exported);
      transitionModuleCache.set(exported, patched);
      return patched;
    }

    if (resolvedString.endsWith(CONTRACT_PROXY_SUFFIX)) {
      if (contractProxyCache.has(exported)) {
        return contractProxyCache.get(exported);
      }
      const patched = hookContractProxy(exported);
      contractProxyCache.set(exported, patched);
      return patched;
    }

    if (!resolvedString.endsWith(SERVICE_MANAGER_SUFFIX)) {
      return exported;
    }
    if (serviceManagerCache.has(exported)) {
      return serviceManagerCache.get(exported);
    }

    class NpcCourierContractsServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("npcCourierContracts")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(NpcCourierContractsServiceManager, exported);
    serviceManagerCache.set(exported, NpcCourierContractsServiceManager);
    return NpcCourierContractsServiceManager;
  }

  load[INSTALLED] = true;
  Module._load = load;

  // Launcher activation can happen after these modules were already loaded.
  // Patch their live exports as well as intercepting future loads.
  patchCachedModule(
    path.join(__dirname, "..", "..", "server", "src", "space", "transitions"),
    hookTransitions,
  );
  patchCachedModule(
    path.join(__dirname, "..", "..", "server", "src", "services", "_other", "contractProxyService"),
    hookContractProxy,
  );
}

installHooks();
log(`v${MOD_VERSION} active — native NPC courier generator and automation enabled`);

module.exports = Object.freeze({
  active: true,
  id: MOD_ID,
  version: MOD_VERSION,
});
