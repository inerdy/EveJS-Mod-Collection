"use strict";

const Module = require("node:module");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const CHARACTER_STATE_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}character${path.sep}characterState.js`;
const DRONE_RUNTIME_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}drone${path.sep}droneRuntime.js`;
const INSTALL_MARKER = Symbol.for("evejs.npcMiningWing.droneBridgeInstalled");
const CHARACTER_PATCH_MARKER = Symbol.for("evejs.npcMiningWing.droneBridgeCharacterPatched");
const DRONE_PATCH_MARKER = Symbol.for("evejs.npcMiningWing.droneBridgeRuntimePatched");

const DRONE_AGGRESSION_RETENTION_MS = 30_000;

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function nowMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function controllerCharacterID(controllerEntity, shipRecord) {
  return positive(
    controllerEntity && (
      controllerEntity.runtimeOwnerCharacterID ||
      controllerEntity.npcMiningWingCharacterID ||
      controllerEntity.characterID ||
      controllerEntity.pilotCharacterID ||
      controllerEntity.ownerID
    ) || shipRecord && shipRecord.ownerID,
  );
}

function hiveCharacterID(entity) {
  return positive(
    entity && (
      entity.npcMiningWingCharacterID ||
      entity.npcMiningWingLeaderCharacterID ||
      entity.runtimeOwnerCharacterID
    ),
  );
}

function isHiveMember(entity) {
  return Boolean(
    entity && (
      entity.npcMiningWingController === true ||
      entity.npcMiningWingLeader === true ||
      entity.npcMiningWingHiveMember === true
    ),
  );
}

function buildControllerSession(baseSession, controllerEntity, shipRecord) {
  const session = baseSession && typeof baseSession === "object"
    ? Object.create(baseSession)
    : {};
  const characterID = controllerCharacterID(controllerEntity, shipRecord);
  const shipID = positive(
    controllerEntity && controllerEntity.itemID ||
    shipRecord && shipRecord.itemID,
  );
  const systemID = positive(
    controllerEntity && controllerEntity.systemID ||
    shipRecord && shipRecord.spaceState && shipRecord.spaceState.systemID ||
    baseSession && baseSession._space && baseSession._space.systemID,
  );
  const baseSpace = baseSession && baseSession._space &&
    typeof baseSession._space === "object"
    ? baseSession._space
    : {};

  session.characterID = characterID;
  session.charid = characterID;
  session.charID = characterID;
  session.shipID = shipID;
  session.activeShipID = shipID;
  session.solarsystemid2 = systemID;
  session._space = {
    ...baseSpace,
    systemID,
    shipID,
    sceneKey: controllerEntity && controllerEntity.sceneKey || baseSpace.sceneKey,
    sceneKind: controllerEntity && controllerEntity.sceneKind || baseSpace.sceneKind,
    instanceID: controllerEntity && controllerEntity.instanceID || baseSpace.instanceID,
    sceneDescriptor: controllerEntity && controllerEntity.sceneDescriptor || baseSpace.sceneDescriptor,
  };
  return session;
}

function normalizeShipRecord(shipRecord, controllerEntity) {
  if (shipRecord && typeof shipRecord === "object") {
    return shipRecord;
  }
  return controllerEntity && typeof controllerEntity === "object"
    ? {
        ...controllerEntity,
        itemID: positive(controllerEntity.itemID),
      }
    : null;
}

function createBridgeState() {
  return {
    activeShipOverrides: new Map(),
    aggressionByShip: new Map(),
    aggressionByCharacter: new Map(),
  };
}

function withActiveShipOverride(state, characterID, shipRecord, callback) {
  const key = String(positive(characterID));
  const previous = state.activeShipOverrides.get(key);
  state.activeShipOverrides.set(key, shipRecord);
  try {
    return callback();
  } finally {
    if (previous) {
      state.activeShipOverrides.set(key, previous);
    } else {
      state.activeShipOverrides.delete(key);
    }
  }
}

function patchCharacterState(exports, state) {
  if (
    !exports ||
    typeof exports.getActiveShipRecord !== "function" ||
    exports[CHARACTER_PATCH_MARKER]
  ) {
    return exports;
  }

  const original = exports.getActiveShipRecord;
  exports.getActiveShipRecord = function getActiveShipRecordWithWingOverride(characterID) {
    const override = state.activeShipOverrides.get(String(positive(characterID)));
    return override || original.apply(this, arguments);
  };
  exports[CHARACTER_PATCH_MARKER] = true;
  return exports;
}

function recordAggression(state, attackerEntity, targetEntity, when) {
  if (
    !targetEntity ||
    !isHiveMember(targetEntity) ||
    !attackerEntity ||
    positive(attackerEntity.itemID) <= 0 ||
    positive(targetEntity.itemID) <= 0 ||
    positive(attackerEntity.itemID) === positive(targetEntity.itemID)
  ) {
    return;
  }

  const targetCharacterID = hiveCharacterID(targetEntity);
  const attackerCharacterID = hiveCharacterID(attackerEntity);
  if (
    !targetCharacterID ||
    attackerCharacterID === targetCharacterID
  ) {
    return;
  }

  const attackerID = positive(attackerEntity.itemID);
  const targetID = positive(targetEntity.itemID);
  const timestamp = nowMs(when);

  let groupThreats = state.aggressionByCharacter.get(String(targetCharacterID));
  if (!groupThreats) {
    groupThreats = new Map();
    state.aggressionByCharacter.set(String(targetCharacterID), groupThreats);
  }
  groupThreats.set(String(attackerID), {
    targetID: attackerID,
    defendedShipID: targetID,
    lastAggressedAtMs: timestamp,
  });

  // The player ship participates in the hive response, but only deployed wing
  // hulls need the existing per-ship aggression view for their native drone
  // controller.
  if (targetEntity.npcMiningWingController !== true) {
    return;
  }

  const shipKey = String(targetID);
  let threats = state.aggressionByShip.get(shipKey);
  if (!threats) {
    threats = new Map();
    state.aggressionByShip.set(shipKey, threats);
  }
  threats.set(String(attackerID), timestamp);
}

function readAggression(state, shipID, when) {
  const threats = state.aggressionByShip.get(String(positive(shipID)));
  if (!threats) {
    return [];
  }
  const threshold = nowMs(when) - DRONE_AGGRESSION_RETENTION_MS;
  const result = [];
  for (const [targetID, lastAggressedAtMs] of threats.entries()) {
    if (Number(lastAggressedAtMs) < threshold) {
      threats.delete(targetID);
      continue;
    }
    result.push({
      targetID: positive(targetID),
      lastAggressedAtMs: Number(lastAggressedAtMs) || 0,
    });
  }
  if (threats.size <= 0) {
    state.aggressionByShip.delete(String(positive(shipID)));
  }
  return result;
}

function clearAggression(state, shipID, targetIDs = null) {
  const key = String(positive(shipID));
  const threats = state.aggressionByShip.get(key);
  if (!threats) {
    return;
  }
  if (!Array.isArray(targetIDs) || targetIDs.length <= 0) {
    state.aggressionByShip.delete(key);
    return;
  }
  for (const targetID of targetIDs) {
    threats.delete(String(positive(targetID)));
  }
  if (threats.size <= 0) {
    state.aggressionByShip.delete(key);
  }
}

function readGroupAggression(state, characterID, when) {
  const key = String(positive(characterID));
  const threats = state.aggressionByCharacter.get(key);
  if (!threats) {
    return [];
  }
  const threshold = nowMs(when) - DRONE_AGGRESSION_RETENTION_MS;
  const result = [];
  for (const [attackerID, entry] of threats.entries()) {
    const lastAggressedAtMs = Number(entry && entry.lastAggressedAtMs) || 0;
    if (lastAggressedAtMs < threshold) {
      threats.delete(attackerID);
      continue;
    }
    result.push({
      targetID: positive(entry && entry.targetID) || positive(attackerID),
      defendedShipID: positive(entry && entry.defendedShipID),
      lastAggressedAtMs,
    });
  }
  if (threats.size <= 0) {
    state.aggressionByCharacter.delete(key);
  }
  return result;
}

function clearGroupAggression(state, characterID, targetIDs = null) {
  const key = String(positive(characterID));
  const threats = state.aggressionByCharacter.get(key);
  if (!threats) {
    return;
  }
  if (!Array.isArray(targetIDs) || targetIDs.length <= 0) {
    state.aggressionByCharacter.delete(key);
    return;
  }
  const targetSet = new Set(targetIDs.map(positive).filter(Boolean));
  for (const [attackerID, entry] of threats.entries()) {
    if (targetSet.has(positive(entry && entry.targetID) || positive(attackerID))) {
      threats.delete(attackerID);
    }
  }
  if (threats.size <= 0) {
    state.aggressionByCharacter.delete(key);
  }
}

function addWingMethods(exports, state) {
  if (!exports || exports[DRONE_PATCH_MARKER]) {
    return exports;
  }

  const runForWingShip = (methodName, baseSession, controllerEntity, shipRecord, args) => {
    const normalizedShip = normalizeShipRecord(shipRecord, controllerEntity);
    const characterID = controllerCharacterID(controllerEntity, normalizedShip);
    const shipID = positive(controllerEntity && controllerEntity.itemID || normalizedShip && normalizedShip.itemID);
    if (!characterID || !shipID || typeof exports[methodName] !== "function") {
      return {
        success: false,
        errorMsg: "NPC_WING_DRONE_CONTROLLER_UNAVAILABLE",
      };
    }
    const pseudoSession = buildControllerSession(
      baseSession,
      controllerEntity,
      normalizedShip,
    );
    return withActiveShipOverride(
      state,
      characterID,
      normalizedShip,
      () => exports[methodName](pseudoSession, ...args),
    );
  };

  exports.launchDronesForWingShip = function launchDronesForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    requests,
  ) {
    return runForWingShip(
      "launchDronesForSession",
      baseSession,
      controllerEntity,
      shipRecord,
      [requests],
    );
  };

  exports.commandEngageForWingShip = function commandEngageForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    droneIDs,
    targetID,
  ) {
    return runForWingShip(
      "commandEngage",
      baseSession,
      controllerEntity,
      shipRecord,
      [droneIDs, targetID],
    );
  };

  exports.commandMineForWingShip = function commandMineForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    droneIDs,
    targetID,
  ) {
    return runForWingShip(
      "commandMineRepeatedly",
      baseSession,
      controllerEntity,
      shipRecord,
      [droneIDs, targetID],
    );
  };

  exports.commandReturnBayForWingShip = function commandReturnBayForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    droneIDs,
  ) {
    return runForWingShip(
      "commandReturnBay",
      baseSession,
      controllerEntity,
      shipRecord,
      [droneIDs],
    );
  };

  exports.getNpcMiningWingAggression = function getNpcMiningWingAggression(shipID, when) {
    return readAggression(state, shipID, when);
  };

  exports.getNpcMiningWingGroupAggression = function getNpcMiningWingGroupAggression(
    characterID,
    when,
  ) {
    return readGroupAggression(state, characterID, when);
  };

  exports.clearNpcMiningWingAggression = function clearNpcMiningWingAggression(
    shipID,
    targetIDs,
  ) {
    clearAggression(state, shipID, targetIDs);
  };

  exports.clearNpcMiningWingGroupAggression = function clearNpcMiningWingGroupAggression(
    characterID,
    targetIDs,
  ) {
    clearGroupAggression(state, characterID, targetIDs);
  };

  exports.resolveWingDroneCapabilities = function resolveWingDroneCapabilities(
    droneEntity,
    controllerEntity,
  ) {
    try {
      const droneDogma = require(serverPath("services", "drone", "droneDogma"));
      const probe = {
        ...(droneEntity || {}),
        kind: "drone",
      };
      return {
        combatSnapshot:
          typeof droneDogma.resolveDroneCombatSnapshot === "function"
            ? droneDogma.resolveDroneCombatSnapshot(probe, controllerEntity)
            : null,
        miningSnapshot:
          typeof droneDogma.resolveDroneMiningSnapshot === "function"
            ? droneDogma.resolveDroneMiningSnapshot(probe, controllerEntity)
            : null,
      };
    } catch (_) {
      return {combatSnapshot: null, miningSnapshot: null};
    }
  };

  const originalNoteIncomingAggression = exports.noteIncomingAggression;
  if (typeof originalNoteIncomingAggression === "function") {
    exports.noteIncomingAggression = function noteIncomingAggressionWithWingTracking(
      attackerEntity,
      targetEntity,
      when,
    ) {
      recordAggression(state, attackerEntity, targetEntity, when);
      return originalNoteIncomingAggression.apply(this, arguments);
    };
  }

  exports[DRONE_PATCH_MARKER] = true;
  return exports;
}

function createLoader(state) {
  const originalLoad = Module._load;
  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (String(resolved).endsWith(CHARACTER_STATE_SUFFIX)) {
      return patchCharacterState(exported, state);
    }
    if (String(resolved).endsWith(DRONE_RUNTIME_SUFFIX)) {
      return addWingMethods(exported, state);
    }
    return exported;
  }
  load[INSTALL_MARKER] = true;
  load.npcMiningWingDroneBridgeState = state;
  return load;
}

function patchLoadedModules(state) {
  for (const [filename, cached] of Object.entries(require.cache)) {
    if (!cached || !cached.exports) {
      continue;
    }
    if (filename.endsWith(CHARACTER_STATE_SUFFIX)) {
      patchCharacterState(cached.exports, state);
    } else if (filename.endsWith(DRONE_RUNTIME_SUFFIX)) {
      addWingMethods(cached.exports, state);
    }
  }
}

function install() {
  if (Module._load[INSTALL_MARKER]) {
    return Module._load.npcMiningWingDroneBridgeState;
  }
  const state = createBridgeState();
  Module._load = createLoader(state);
  patchLoadedModules(state);
  // Resolve the server path here only to keep the bridge's supported seam
  // explicit. The require remains lazy; no server subsystem is bootstrapped by
  // enabling the mod.
  void serverPath("services", "drone", "droneRuntime");
  return state;
}

module.exports = Object.freeze({install});
