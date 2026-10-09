"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "salvagebuddy";
const MOD_VERSION = "0.2.10";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const ENTITY_SERVICE_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}drone${path.sep}entityService.js`;
const INSTALLED = Symbol.for("evejs.salvageBuddy.loaderInstalled");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installHooks() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  const entityServices = new WeakMap();
  let service = null;

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

  function isTemporarySalvageDrone(entity) {
    return Boolean(
      entity &&
      entity.kind === "drone" &&
      String(entity.customInfo || "").includes(`${MOD_ID}:`) &&
      String(entity.customInfo || "").includes(":player-drone"),
    );
  }

  function wrapEntityService(exported) {
    if (entityServices.has(exported)) return entityServices.get(exported);
    class SalvageBuddyEntityService extends exported {
      Handle_CmdReturnBay(args, session) {
        const requested = args && Array.isArray(args[0]) ? args[0] : [];
        if (requested.length <= 0) return super.Handle_CmdReturnBay(args, session);

        let scene = null;
        try {
          const spaceRuntime = require(path.join(__dirname, "..", "..", "server", "src", "space", "runtime"));
          scene = spaceRuntime.getSceneForSession(session);
        } catch (error) {
          log(`unable to inspect drone return request: ${error.message}`);
          return super.Handle_CmdReturnBay(args, session);
        }

        const allowed = [];
        let blocked = 0;
        for (const droneID of requested) {
          const entity = scene && typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(droneID)
            : null;
          if (isTemporarySalvageDrone(entity)) {
            blocked += 1;
          } else {
            allowed.push(droneID);
          }
        }

        if (blocked > 0) {
          log(`blocked Return to Drone Bay for ${blocked} temporary SalvageBuddy drone(s)`);
        }
        if (allowed.length <= 0) return {type: "dict", entries: []};
        return super.Handle_CmdReturnBay([allowed], session);
      }
    }
    Object.setPrototypeOf(SalvageBuddyEntityService, exported);
    entityServices.set(exported, SalvageBuddyEntityService);
    return SalvageBuddyEntityService;
  }

  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    if (String(resolved).endsWith(ENTITY_SERVICE_SUFFIX)) {
      return wrapEntityService(exported);
    }
    return exported;
  };
  Module._load[INSTALLED] = true;
}

installHooks();
log(`v${MOD_VERSION} active — temporary Salvage Drone II service enabled`);

module.exports = Object.freeze({active: true, id: MOD_ID, version: MOD_VERSION});
