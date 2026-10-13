"use strict";

const Module = require("node:module");
const path = require("node:path");

const {serverPath} = require("./npcMiningWingHost");
const MOD_VERSION = require("../evejs-launcher.mod.json").version;
const {withActiveShipOverride} = require("./npcMiningWingDroneState");
const SINGLETON = Symbol.for("evejs.npcMiningWing.miningCompatibility.v1");
const WRAPPED = Symbol.for("evejs.npcMiningWing.miningCompatibilityWrapped.v1");
const IDENTITY_TRACE_ENV = "NPC_MINING_WING_IDENTITY_TRACE";

function identityTraceEnabled() {
  return ["1", "true", "on", "enabled"].includes(
    String(process.env[IDENTITY_TRACE_ENV] || "").trim().toLowerCase(),
  );
}

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function createCompatibility({
  bridgeState,
  findCharacterShipItem,
  overrideActiveShip = withActiveShipOverride,
  emit = (line) => console.log(line),
  now = Date.now,
}) {
  const hooks = {};
  const patched = new WeakMap();

  function log(event, fields = {}) {
    if (!identityTraceEnabled()) return;
    try {
      emit(`[NPCMiningWing:MiningIdentity] ${JSON.stringify({
        event, at: now(), pid: process.pid, ...fields,
      })}`);
    } catch (_) { /* identity diagnostics must not affect the mining cycle */ }
  }

  function ownerCharacterID(entity) {
    for (const key of [
      "npcMiningWingSkillOwnerID", "npcMiningWingCharacterID",
      "runtimeOwnerCharacterID", "characterID", "pilotCharacterID", "ownerID",
    ]) {
      const characterID = positive(entity && entity[key]);
      if (characterID) return characterID;
    }
    return positive(entity && entity.session && entity.session.characterID);
  }

  function failure(stage, entity, reason, fields = {}) {
    log("identity.unavailable", {
      stage, reason, shipID: positive(entity && entity.itemID),
      characterID: entity && entity.characterID,
      runtimeOwnerCharacterID: positive(entity && entity.runtimeOwnerCharacterID),
      pilotCharacterID: positive(entity && entity.pilotCharacterID),
      ...fields,
    });
    return {success: false, stopReason: "identity", errorMsg: reason};
  }

  function runForWingShip(stage, entity, callback) {
    const characterID = ownerCharacterID(entity);
    const shipID = positive(entity && entity.itemID);
    if (!characterID || !shipID) {
      return failure(stage, entity, "NPC_WING_OWNER_OR_SHIP_ID_MISSING", {characterID, shipID});
    }

    const sessionCharacterID = positive(entity.session && entity.session.characterID);
    if (sessionCharacterID && sessionCharacterID !== characterID) {
      return failure(stage, entity, "NPC_WING_SESSION_OWNER_MISMATCH", {
        characterID, sessionCharacterID, shipID,
      });
    }

    let shipRecord;
    try {
      shipRecord = findCharacterShipItem(characterID, shipID);
    } catch (error) {
      return failure(stage, entity, "NPC_WING_SHIP_LOOKUP_FAILED", {
        characterID, shipID, error: String(error && error.message || error),
      });
    }
    if (
      !shipRecord ||
      positive(shipRecord.itemID) !== shipID ||
      positive(shipRecord.ownerID) !== characterID
    ) {
      return failure(stage, entity, "NPC_WING_SHIP_RECORD_MISMATCH", {
        characterID, shipID,
        recordShipID: positive(shipRecord && shipRecord.itemID),
        recordOwnerID: positive(shipRecord && shipRecord.ownerID),
      });
    }
    if (
      !bridgeState ||
      !(bridgeState.activeShipOverrides instanceof Map) ||
      !(bridgeState.activeShipOverrideStacks instanceof Map)
    ) {
      return failure(stage, entity, "NPC_WING_ACTIVE_SHIP_BRIDGE_UNAVAILABLE", {
        characterID, shipID,
      });
    }

    const hadOwnCharacterID = Object.prototype.hasOwnProperty.call(entity, "characterID");
    const previousCharacterID = entity.characterID;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try {
        if (hadOwnCharacterID) entity.characterID = previousCharacterID;
        else delete entity.characterID;
      } catch (error) {
        log("identity.restoreFailed", {
          stage, characterID, shipID,
          error: String(error && error.message || error),
        });
      }
    };

    try {
      // The host's sessionless mining resolver treats an explicit 0 as a real
      // character ID. Set the validated owner only for this synchronous native
      // operation, then restore the entity's presentation fields.
      entity.characterID = characterID;
    } catch (error) {
      restore();
      return failure(stage, entity, "NPC_WING_CHARACTER_ID_NOT_WRITABLE", {
        characterID, shipID, error: String(error && error.message || error),
      });
    }
    if (positive(entity.characterID) !== characterID) {
      restore();
      return failure(stage, entity, "NPC_WING_CHARACTER_ID_NOT_WRITABLE", {
        characterID, shipID,
      });
    }

    try {
      log("identity.bound", {
        stage, shipID, characterID,
        previousCharacterID: previousCharacterID === undefined
          ? "<undefined>" : previousCharacterID === null ? "<null>" : previousCharacterID,
        shipRecordID: positive(shipRecord.itemID),
        shipRecordOwnerID: positive(shipRecord.ownerID),
      });

      const result = overrideActiveShip(
        bridgeState,
        characterID,
        shipRecord,
        callback,
      );
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(restore);
      }
      restore();
      return result;
    } catch (error) {
      restore();
      log("identity.throw", {
        stage, characterID, shipID,
        error: String(error && error.message || error),
      });
      throw error;
    }
  }

  function patch(exports) {
    if (!exports || typeof exports !== "object") return;
    if (!patched.has(exports)) patched.set(exports, new Set());
    const names = patched.get(exports);
    for (const [name, entityIndex] of [
      ["prepareMiningCycleBoundary", 0],
      ["executeMiningCycle", 1],
    ]) {
      if (names.has(name)) continue;
      const original = exports[name];
      if (typeof original !== "function") {
        hooks[name] = "missing";
        log("hook.missing", {stage: name});
        names.add(name);
        continue;
      }
      if (original[WRAPPED]) {
        hooks[name] = "attached";
        names.add(name);
        continue;
      }

      function withWingIdentity(...args) {
        const entity = args[entityIndex];
        if (!entity || entity.npcMiningWingController !== true) {
          return original.apply(this, args);
        }
        return runForWingShip(name, entity, () => original.apply(this, args));
      }
      withWingIdentity[WRAPPED] = true;
      try {
        exports[name] = withWingIdentity;
        hooks[name] = exports[name] === withWingIdentity ? "attached" : "failed";
        if (hooks[name] === "failed") {
          log("hook.failed", {stage: name, reason: "export_not_replaceable"});
        } else {
          names.add(name);
          log("hook.attached", {stage: name});
        }
      } catch (error) {
        hooks[name] = "failed";
        log("hook.failed", {stage: name, error: String(error && error.message || error)});
      }
    }
  }

  return {patch, log, hooks};
}

function install(bridgeState) {
  if (globalThis[SINGLETON]) return globalThis[SINGLETON];

  if (!bridgeState) {
    bridgeState = require("./npcMiningWingDroneBridge").install();
  }
  const compatibility = createCompatibility({
    bridgeState,
    findCharacterShipItem: (characterID, shipID) =>
      require(serverPath("services", "inventory", "itemStore"))
        .findCharacterShipItem(characterID, shipID),
  });
  globalThis[SINGLETON] = compatibility;

  const relative = "services/mining/miningRuntime.js";
  const filename = serverPath(...relative.split("/"));
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.apply(this, arguments);
    if (resolved === filename) compatibility.patch(exported);
    return exported;
  };

  const cached = Boolean(require.cache[filename]);
  if (cached) compatibility.patch(require.cache[filename].exports);
  compatibility.log("installed", {
    version: MOD_VERSION, hostRoot: path.dirname(serverPath()),
    cachedAtInstall: cached,
    coverage: cached
      ? "late-install: previously captured imports may bypass hooks; restart game server"
      : "early-install",
    hooks: {...compatibility.hooks},
  });
  return compatibility;
}

module.exports = {createCompatibility, install};
