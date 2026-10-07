"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "bountyhunting";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const KILLMAIL_TRACKER_SUFFIX = `${path.sep}server${path.sep}space${path.sep}combat${path.sep}killmailTracker.js`;
const SPACE_RUNTIME_SUFFIX = `${path.sep}server${path.sep}space${path.sep}runtime.js`;
const INSTALLED = Symbol.for("evejs.bountyHunting.loaderInstalled");
const TRACKER_HOOKED = Symbol.for("evejs.bountyHunting.killmailTrackerHooked");
const TRACKER_WRAPPED = Symbol.for("evejs.bountyHunting.killmailTrackerWrapped");
const RUNTIME_HOOKED = Symbol.for("evejs.bountyHunting.runtimeInteropHooked");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function killIDFromResult(result) {
  return positive(
    result && (
      result.killID ||
      result.data && result.data.killID ||
      result.record && result.record.killID ||
      result.data && result.data.record && result.data.record.killID
    ),
    0,
  );
}

function notifyService(serviceFactory, targetEntity, destroyResult, options, result) {
  if (!destroyResult || destroyResult.success !== true || !targetEntity) {
    return;
  }
  const attacker = options && options.attackerEntity || null;
  const whenMs = options && options.whenMs || Date.now();
  const killID = killIDFromResult(result);
  const eventKey = killID > 0 ? `killmail:${killID}` : "";
  try {
    const work = serviceFactory().recordNpcKill({
      targetEntity,
      finalAttacker: attacker,
      killID,
      eventKey,
      whenMs,
    });
    if (work && typeof work.catch === "function") {
      work.catch((error) => {
        log(`NPC kill progression failed safely: ${error.message}`);
      });
    }
  } catch (error) {
    log(`NPC kill progression failed safely: ${error.message}`);
  }
}

function installHooks() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagers = new WeakMap();
  const trackerModules = new WeakMap();
  let service = null;

  function getService() {
    if (!service) {
      const BountyHuntingService = require(path.join(
        __dirname,
        "lib",
        "bountyHuntingService",
      ));
      service = new BountyHuntingService();
    }
    return service;
  }

  function wrapServiceManager(exported) {
    if (!exported || serviceManagers.has(exported)) {
      return serviceManagers.get(exported) || exported;
    }
    class BountyHuntingServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("bountyHunting")) {
          this.register(getService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(BountyHuntingServiceManager, exported);
    serviceManagers.set(exported, BountyHuntingServiceManager);
    return BountyHuntingServiceManager;
  }

  function wrapKillmailTracker(exported) {
    if (!exported || exported[TRACKER_HOOKED]) {
      return exported;
    }
    const originalRecord = exported.recordKillmailFromDestruction;
    const originalEnqueue = exported.enqueueKillmailFromDestruction;
    if (typeof originalRecord === "function") {
      const wrappedRecord = function bountyRecordKillmail(...args) {
        const result = originalRecord.apply(this, args);
        notifyService(getService, args[0], args[1], args[2] || {}, result);
        return result;
      };
      Object.defineProperty(wrappedRecord, TRACKER_WRAPPED, {value: true});
      exported.recordKillmailFromDestruction = wrappedRecord;
    }
    if (typeof originalEnqueue === "function") {
      const wrappedEnqueue = function bountyEnqueueKillmail(...args) {
        const result = originalEnqueue.apply(this, args);
        notifyService(getService, args[0], args[1], args[2] || {}, result);
        return result;
      };
      Object.defineProperty(wrappedEnqueue, TRACKER_WRAPPED, {value: true});
      exported.enqueueKillmailFromDestruction = wrappedEnqueue;
    }
    Object.defineProperty(exported, TRACKER_HOOKED, {value: true});
    return exported;
  }

  function wrapSpaceRuntime(exported) {
    if (!exported || exported[RUNTIME_HOOKED]) {
      return exported;
    }
    const interop = exported.droneInterop;
    const originalRecord = interop && interop.recordKillmailFromDestruction;
    if (interop && typeof originalRecord === "function" && !originalRecord[TRACKER_WRAPPED]) {
      const wrappedRecord = function bountyDroneRecordKillmail(...args) {
        const result = originalRecord.apply(this, args);
        notifyService(getService, args[0], args[1], args[2] || {}, result);
        return result;
      };
      interop.recordKillmailFromDestruction = wrappedRecord;
    }
    Object.defineProperty(exported, RUNTIME_HOOKED, {value: true});
    return exported;
  }

  function patchCachedModule(request, patcher) {
    try {
      const resolved = require.resolve(request);
      const cached = require.cache[resolved];
      if (cached) {
        const patched = patcher(cached.exports);
        if (patched && patched !== cached.exports) {
          cached.exports = patched;
        }
      }
    } catch (_error) {
      // Normal Module._load interception handles modules loaded later.
    }
  }

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    const resolvedText = String(resolved);
    if (resolvedText.endsWith(SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    if (resolvedText.endsWith(KILLMAIL_TRACKER_SUFFIX)) {
      if (trackerModules.has(exported)) {
        return trackerModules.get(exported);
      }
      const patched = wrapKillmailTracker(exported);
      trackerModules.set(exported, patched);
      return patched;
    }
    if (resolvedText.endsWith(SPACE_RUNTIME_SUFFIX)) {
      return wrapSpaceRuntime(exported);
    }
    return exported;
  }

  load[INSTALLED] = true;
  Module._load = load;

  patchCachedModule(
    path.join(__dirname, "..", "..", "server", "src", "space", "combat", "killmailTracker"),
    wrapKillmailTracker,
  );
  patchCachedModule(
    path.join(__dirname, "..", "..", "server", "src", "space", "runtime"),
    wrapSpaceRuntime,
  );
  patchCachedModule(
    path.join(__dirname, "..", "..", "server", "src", "services", "serviceManager"),
    wrapServiceManager,
  );
}

installHooks();
log(`v${MOD_VERSION} active — NPC bounty-hunting progression enabled`);

module.exports = Object.freeze({
  active: true,
  id: MOD_ID,
  version: MOD_VERSION,
});
