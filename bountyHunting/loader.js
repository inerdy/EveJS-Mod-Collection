"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "bountyhunting";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const KILLMAIL_TRACKER_SUFFIX = `${path.sep}server${path.sep}space${path.sep}combat${path.sep}killmailTracker.js`;
const SPACE_RUNTIME_SUFFIX = `${path.sep}server${path.sep}space${path.sep}runtime.js`;
const BOUNTY_RUNTIME_SUFFIX = `${path.sep}server${path.sep}services${path.sep}bounty${path.sep}bountyRuntime.js`;
const INSTALLED = Symbol.for("evejs.bountyHunting.loaderInstalled");
const TRACKER_HOOKED = Symbol.for("evejs.bountyHunting.killmailTrackerHooked");
const TRACKER_WRAPPED = Symbol.for("evejs.bountyHunting.killmailTrackerWrapped");
const RUNTIME_HOOKED = Symbol.for("evejs.bountyHunting.runtimeInteropHooked");
const BOUNTY_HOOKED = Symbol.for("evejs.bountyHunting.bountyRuntimeHooked");
const DAMAGE_WRAPPED = Symbol.for("evejs.bountyHunting.damageInteropWrapped");

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function endsWithModulePath(value, suffix) {
  return normalizedPath(value).endsWith(normalizedPath(suffix));
}

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

function eventKeyForTarget(targetEntity, killID = 0) {
  const itemID = positive(targetEntity && targetEntity.itemID, 0);
  const systemID = positive(
    targetEntity && (targetEntity.systemID || targetEntity.solarSystemID),
    0,
  );
  if (itemID > 0) {
    return `npc:${systemID}:${itemID}`;
  }
  return killID > 0 ? `killmail:${killID}` : "";
}

function notifyService(serviceFactory, targetEntity, destroyResult, options, result, duplicateEvents) {
  if (!destroyResult || destroyResult.success !== true || !targetEntity) {
    return;
  }
  const attacker = options && options.attackerEntity || null;
  const whenMs = options && options.whenMs || Date.now();
  const killID = killIDFromResult(result);
  const nativeBountyEligible = Boolean(result && result.nativeBountyEligible === true);
  const creditedCharacterID = positive(result && result.characterID, 0);
  const eventKey = eventKeyForTarget(targetEntity, killID);
  try {
    const service = serviceFactory();
    const attackerCharacterID = positive(
      creditedCharacterID ||
        attacker && (
          attacker.characterID ||
          attacker.pilotCharacterID ||
          attacker.ownerCharacterID ||
          attacker.controllerOwnerID ||
          attacker.session && attacker.session.characterID
        ),
      0,
    );
    if (duplicateEvents && eventKey && attackerCharacterID > 0) {
      if (duplicateEvents.has(eventKey)) {
        service.recordHookDiagnostic({
          source: options && options.source || "unknown",
          eventKey,
          characterID: attackerCharacterID,
          targetEntity,
          nativeBountyEligible,
          outcome: "duplicate-suppressed",
        });
        return;
      }
      duplicateEvents.set(eventKey, Date.now());
      if (duplicateEvents.size > 4096) {
        const oldest = duplicateEvents.keys().next().value;
        duplicateEvents.delete(oldest);
      }
    }
    service.recordHookDiagnostic({
      source: options && options.source || "unknown",
      eventKey,
      characterID: attackerCharacterID,
      targetEntity,
      nativeBountyEligible,
      outcome: "captured",
    });
    const work = service.recordNpcKill({
      targetEntity,
      finalAttacker: attacker,
      characterID: creditedCharacterID,
      nativeBountyEligible,
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
  const duplicateEvents = new Map();
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
        notifyService(
          getService,
          args[0],
          args[1],
          {...(args[2] || {}), source: "killmail-tracker"},
          result,
          duplicateEvents,
        );
        return result;
      };
      Object.defineProperty(wrappedRecord, TRACKER_WRAPPED, {value: true});
      exported.recordKillmailFromDestruction = wrappedRecord;
    }
    if (typeof originalEnqueue === "function") {
      const wrappedEnqueue = function bountyEnqueueKillmail(...args) {
        const result = originalEnqueue.apply(this, args);
        notifyService(
          getService,
          args[0],
          args[1],
          {...(args[2] || {}), source: "killmail-enqueue"},
          result,
          duplicateEvents,
        );
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
        notifyService(
          getService,
          args[0],
          args[1],
          {...(args[2] || {}), source: "drone-killmail"},
          result,
          duplicateEvents,
        );
        return result;
      };
      interop.recordKillmailFromDestruction = wrappedRecord;
    }
    const originalDamage = interop && interop.applyWeaponDamageToTarget;
    if (interop && typeof originalDamage === "function" && !originalDamage[DAMAGE_WRAPPED]) {
      const wrappedDamage = function bountyDroneApplyWeaponDamage(...args) {
        const result = originalDamage.apply(this, args);
        const destroyResult = result && result.destroyResult;
        if (destroyResult && destroyResult.success === true) {
          notifyService(
            getService,
            args[2] || null,
            destroyResult,
            {
              attackerEntity: args[1] || null,
              whenMs: args[4] || Date.now(),
              source: "drone-destruction",
            },
            null,
            duplicateEvents,
          );
        }
        return result;
      };
      Object.defineProperty(wrappedDamage, DAMAGE_WRAPPED, {value: true});
      interop.applyWeaponDamageToTarget = wrappedDamage;
    }
    Object.defineProperty(exported, RUNTIME_HOOKED, {value: true});
    return exported;
  }

  function wrapBountyRuntime(exported) {
    if (!exported || exported[BOUNTY_HOOKED]) {
      return exported;
    }
    const originalRecord = exported.recordNpcBountyKill;
    if (typeof originalRecord === "function") {
      exported.recordNpcBountyKill = function bountyRecordNpcKill(...args) {
        const result = originalRecord.apply(this, args);
        if (result && result.eligible === true && result.alreadyRecorded !== true) {
          const victimEntity = args[0] || null;
          const finalAttacker = args[1] || null;
          const context = args[2] || {};
          const creditedCharacterID = positive(
            result.characterID ||
              context.characterID ||
              finalAttacker && (
                finalAttacker.characterID ||
                finalAttacker.pilotCharacterID ||
                finalAttacker.ownerCharacterID
              ),
            0,
          );
          notifyService(
            getService,
            victimEntity,
            {success: true},
            {
              attackerEntity: {
                ...(finalAttacker || {}),
                characterID: creditedCharacterID || undefined,
                pilotCharacterID: creditedCharacterID || undefined,
              },
              whenMs: context.nowMs || Date.now(),
              source: "native-bounty",
            },
            {killID: 0, nativeBountyEligible: true, characterID: creditedCharacterID},
            duplicateEvents,
          );
        }
        return result;
      };
    }
    Object.defineProperty(exported, BOUNTY_HOOKED, {value: true});
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
    if (endsWithModulePath(resolvedText, SERVICE_MANAGER_SUFFIX)) {
      return wrapServiceManager(exported);
    }
    if (endsWithModulePath(resolvedText, KILLMAIL_TRACKER_SUFFIX)) {
      if (trackerModules.has(exported)) {
        return trackerModules.get(exported);
      }
      const patched = wrapKillmailTracker(exported);
      trackerModules.set(exported, patched);
      return patched;
    }
    if (endsWithModulePath(resolvedText, SPACE_RUNTIME_SUFFIX)) {
      return wrapSpaceRuntime(exported);
    }
    if (endsWithModulePath(resolvedText, BOUNTY_RUNTIME_SUFFIX)) {
      return wrapBountyRuntime(exported);
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
    path.join(__dirname, "..", "..", "server", "src", "services", "bounty", "bountyRuntime"),
    wrapBountyRuntime,
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
