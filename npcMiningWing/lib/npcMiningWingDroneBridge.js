"use strict";

const Module = require("node:module");
const path = require("node:path");

const {serverPath} = require("./npcMiningWingHost");
const {
  createBridgeState,
  withActiveShipOverride,
} = require("./npcMiningWingDroneState");
const CHARACTER_STATE_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}character${path.sep}characterState.js`;
const DRONE_RUNTIME_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}drone${path.sep}droneRuntime.js`;
const INSTALL_MARKER = Symbol.for("evejs.npcMiningWing.droneBridgeInstalled");
const CHARACTER_PATCH_MARKER = Symbol.for("evejs.npcMiningWing.droneBridgeCharacterPatched");
const DRONE_PATCH_MARKER = Symbol.for("evejs.npcMiningWing.droneBridgeRuntimePatched");
let installedBridgeState = null;

const DRONE_AGGRESSION_RETENTION_MS = 30_000;
const HIVE_SHIP_OWNER_RETENTION_MS = 30_000;
const DEFENSE_TRACE_THROTTLE_MS = 2_000;
const DEFENSE_TRACE_ENV = "NPC_MINING_WING_DEFENSE_TRACE";
const DEFENSE_TRACE_MAX_LINES_PER_SECOND = 300;
let defenseTraceWindowAtMs = 0;
let defenseTraceWindowLines = 0;
let defenseTraceSuppressed = 0;

function defenseTraceEnabled() {
  return ["1", "true", "on", "enabled"].includes(
    String(process.env[DEFENSE_TRACE_ENV] || "").trim().toLowerCase(),
  );
}

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function firstPositive(...values) {
  for (const value of values) {
    const number = positive(value);
    if (number > 0) {
      return number;
    }
  }
  return 0;
}

function nowMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function controllerCharacterID(
  controllerEntity,
  shipRecord,
  expectedCharacterID,
) {
  const shipID = positive(shipRecord && shipRecord.itemID);
  const entityShipID = positive(controllerEntity && controllerEntity.itemID);
  // Persisted ship ownership is authoritative; a zero caller ID is missing,
  // not an owner identity.
  const recordOwnerID = positive(shipRecord && shipRecord.ownerID);
  const expectedOwnerID = positive(expectedCharacterID);
  if (
    !shipID ||
    shipID !== entityShipID ||
    !recordOwnerID ||
    (expectedOwnerID > 0 && expectedOwnerID !== recordOwnerID)
  ) {
    return 0;
  }
  return recordOwnerID;
}

function withControllerOwnerIdentity(
  controllerEntity,
  characterID,
  ownerSession,
  callback,
) {
  const ownerCharacterID = positive(characterID);
  if (!controllerEntity || !ownerCharacterID || !ownerSession) {
    return {
      success: false,
      errorMsg: "NPC_WING_DRONE_OWNER_ID_UNAVAILABLE",
    };
  }

  const identityFields = ["characterID", "pilotCharacterID"];
  const previous = identityFields.map((key) => ({
    key,
    hadOwn: Object.prototype.hasOwnProperty.call(controllerEntity, key),
    value: controllerEntity[key],
  }));
  const previousSession = {
    hadOwn: Object.prototype.hasOwnProperty.call(controllerEntity, "session"),
    value: controllerEntity.session,
  };
  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    for (const entry of previous) {
      try {
        if (entry.hadOwn) {
          controllerEntity[entry.key] = entry.value;
        } else {
          delete controllerEntity[entry.key];
        }
      } catch (_) { /* preserve the runtime entity if a field is immutable */ }
    }
    try {
      if (previousSession.hadOwn) {
        controllerEntity.session = previousSession.value;
      } else {
        delete controllerEntity.session;
      }
    } catch (_) { /* preserve the runtime entity if the session is immutable */ }
  };

  try {
    for (const key of identityFields) {
      controllerEntity[key] = ownerCharacterID;
    }
    controllerEntity.session = ownerSession;
    if (
      identityFields.some((key) => positive(controllerEntity[key]) !== ownerCharacterID) ||
      positive(controllerEntity.session && controllerEntity.session.characterID) !== ownerCharacterID
    ) {
      restore();
      return {
        success: false,
        errorMsg: "NPC_WING_DRONE_OWNER_ID_NOT_WRITABLE",
      };
    }
  } catch (_) {
    restore();
    return {
      success: false,
      errorMsg: "NPC_WING_DRONE_OWNER_ID_NOT_WRITABLE",
    };
  }

  try {
    const result = callback();
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
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

function hasHiveMemberMarker(entity) {
  return Boolean(
    entity && (
      entity.npcMiningWingController === true ||
      entity.npcMiningWingLeader === true ||
      entity.npcMiningWingHiveMember === true
    ),
  );
}

function defenseTrace(event, fields = {}) {
  if (!defenseTraceEnabled()) {
    return;
  }
  const time = Date.now();
  if (time - defenseTraceWindowAtMs >= 1000) {
    const previouslySuppressed = defenseTraceSuppressed;
    defenseTraceWindowAtMs = time;
    defenseTraceWindowLines = 0;
    defenseTraceSuppressed = 0;
    if (previouslySuppressed > 0) {
      try {
        console.log(`[NPCMiningWing:DefenseTrace] ${JSON.stringify({
          event: "diagnostics.suppressed",
          at: time,
          pid: process.pid,
          count: previouslySuppressed,
        })}`);
      } catch (_) { /* defense diagnostics must never affect combat */ }
    }
  }
  if (defenseTraceWindowLines >= DEFENSE_TRACE_MAX_LINES_PER_SECOND) {
    defenseTraceSuppressed += 1;
    return;
  }
  defenseTraceWindowLines += 1;
  try {
    console.log(`[NPCMiningWing:DefenseTrace] ${JSON.stringify({
      event,
      at: time,
      pid: process.pid,
      ...fields,
    })}`);
  } catch (_) { /* defense diagnostics must never affect combat */ }
}

function droneResponseSummary(response) {
  if (response === null || response === undefined) {
    return {present: false};
  }
  try {
    return {
      present: true,
      success: typeof response.success === "boolean" ? response.success : null,
      errorMsg: String(response.errorMsg || "").slice(0, 300) || null,
      keys: typeof response === "object" ? Object.keys(response).slice(0, 12) : [],
    };
  } catch (error) {
    return {
      present: true,
      summaryError: String(error && error.message || error).slice(0, 300),
    };
  }
}

function pruneHiveShipOwners(state, when) {
  if (when - positive(state.lastHiveShipPruneAtMs) < HIVE_SHIP_OWNER_RETENTION_MS) {
    return;
  }
  state.lastHiveShipPruneAtMs = when;
  for (const [shipID, entry] of state.hiveShipOwners.entries()) {
    if (when - positive(entry && entry.lastSeenAtMs) > HIVE_SHIP_OWNER_RETENTION_MS) {
      state.hiveShipOwners.delete(shipID);
    }
  }
  for (const [key, timestamp] of state.defenseTraceAt.entries()) {
    if (when - positive(timestamp) > HIVE_SHIP_OWNER_RETENTION_MS) {
      state.defenseTraceAt.delete(key);
    }
  }
}

function registerHiveShip(state, entity, shipRecord) {
  const now = Date.now();
  pruneHiveShipOwners(state, now);
  const shipID = positive(entity && entity.itemID);
  const recordShipID = positive(shipRecord && shipRecord.itemID);
  const characterID = positive(shipRecord && shipRecord.ownerID);
  let reason = "";
  if (!shipID || shipID !== recordShipID) {
    reason = "NPC_WING_DEFENSE_SHIP_RECORD_MISMATCH";
  } else if (!characterID) {
    reason = "NPC_WING_DEFENSE_OWNER_MISSING";
  } else if (!hasHiveMemberMarker(entity)) {
    reason = "NPC_WING_DEFENSE_HIVE_MARKER_MISSING";
  } else {
    const markedOwnerID = hiveCharacterID(entity);
    if (markedOwnerID && markedOwnerID !== characterID) {
      reason = "NPC_WING_DEFENSE_OWNER_MISMATCH";
    }
  }
  if (reason) {
    if (shouldTraceDefenseEvent(state, `identity.rejected:${shipID}:${reason}`, now, 10_000)) {
      defenseTrace("identity.rejected", {
        shipID,
        recordShipID,
        characterID,
        entityCharacterID: positive(entity && entity.characterID),
        runtimeOwnerCharacterID: positive(entity && entity.runtimeOwnerCharacterID),
        markedOwnerID: hiveCharacterID(entity),
        reason,
      });
    }
    return {success: false, reason, shipID, characterID};
  }

  const isController = entity.npcMiningWingController === true;
  const previous = state.hiveShipOwners.get(String(shipID));
  const changed = !previous ||
    positive(previous.characterID) !== characterID ||
    previous.isController !== isController;
  state.hiveShipOwners.set(String(shipID), {
    characterID,
    isController,
    lastSeenAtMs: now,
  });
  if (changed) {
    defenseTrace("identity.registered", {
      shipID,
      characterID,
      isController,
      ownerSource: "validated_ship_record",
      entityCharacterID: entity.characterID === undefined
        ? "<undefined>" : entity.characterID,
      runtimeOwnerCharacterID: positive(entity.runtimeOwnerCharacterID),
    });
  }
  return {success: true, shipID, characterID, isController, changed};
}

function resolveHiveIdentity(state, entity, when) {
  const shipID = positive(entity && entity.itemID);
  const entityCharacterID = hiveCharacterID(entity);
  const hasMarker = hasHiveMemberMarker(entity);
  const registered = shipID
    ? state.hiveShipOwners.get(String(shipID))
    : null;
  if (
    registered &&
    when - positive(registered.lastSeenAtMs) <= HIVE_SHIP_OWNER_RETENTION_MS
  ) {
    return {
      characterID: positive(registered.characterID),
      isController: registered.isController === true,
      source: hasMarker ? "entity+ship_registry" : "ship_registry",
      entityOwnerMismatch: Boolean(
        entityCharacterID && entityCharacterID !== positive(registered.characterID)
      ),
    };
  }
  if (registered) {
    state.hiveShipOwners.delete(String(shipID));
  }
  if (hasMarker && entityCharacterID) {
    return {
      characterID: entityCharacterID,
      isController: entity.npcMiningWingController === true,
      source: "entity_markers",
      entityOwnerMismatch: false,
    };
  }
  return null;
}

function buildControllerSession(
  baseSession,
  controllerEntity,
  shipRecord,
  characterID,
) {
  const session = baseSession && typeof baseSession === "object"
    ? Object.create(baseSession)
    : {};
  const ownerCharacterID = positive(characterID);
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

  session.characterID = ownerCharacterID;
  session.charid = ownerCharacterID;
  session.charID = ownerCharacterID;
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
    !attackerEntity ||
    positive(attackerEntity.itemID) <= 0 ||
    positive(targetEntity.itemID) <= 0 ||
    positive(attackerEntity.itemID) === positive(targetEntity.itemID)
  ) {
    return {trace: false, recorded: false, reason: "invalid_entities"};
  }

  const targetID = positive(targetEntity.itemID);
  const attackerID = positive(attackerEntity.itemID);
  const timestamp = nowMs(when);
  const targetIdentity = resolveHiveIdentity(state, targetEntity, timestamp);
  if (!targetIdentity || !positive(targetIdentity.characterID)) {
    const marked = hasHiveMemberMarker(targetEntity);
    const trace = marked && shouldTraceDefenseEvent(
      state,
      `unresolved:${targetID}`,
      timestamp,
    );
    return {
      trace,
      recorded: false,
      reason: marked ? "target_owner_unresolved" : "target_not_registered",
      targetID,
      attackerID,
      entityCharacterID: positive(targetEntity.characterID),
      runtimeOwnerCharacterID: positive(targetEntity.runtimeOwnerCharacterID),
    };
  }

  const targetCharacterID = positive(targetIdentity.characterID);
  const attackerIdentity = resolveHiveIdentity(state, attackerEntity, timestamp);
  const attackerCharacterID = positive(attackerIdentity && attackerIdentity.characterID);
  const shouldTrace = shouldTraceDefenseEvent(
    state,
    `${targetID}:${attackerID}`,
    timestamp,
  );
  const traceFields = {
    targetID,
    attackerID,
    characterID: targetCharacterID,
    targetIdentitySource: targetIdentity.source,
    attackerCharacterID,
    attackerIdentitySource: attackerIdentity && attackerIdentity.source || "unowned_or_hostile",
    targetIsController: targetIdentity.isController,
    targetOwnerMismatch: targetIdentity.entityOwnerMismatch,
  };
  if (attackerCharacterID && attackerCharacterID === targetCharacterID) {
    return {
      trace: shouldTrace,
      recorded: false,
      reason: "same_hive_owner",
      ...traceFields,
    };
  }

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
  if (!targetIdentity.isController) {
    return {
      trace: shouldTrace,
      recorded: true,
      scope: "hive_group",
      ...traceFields,
    };
  }

  const shipKey = String(targetID);
  let threats = state.aggressionByShip.get(shipKey);
  if (!threats) {
    threats = new Map();
    state.aggressionByShip.set(shipKey, threats);
  }
  threats.set(String(attackerID), timestamp);
  return {
    trace: shouldTrace,
    recorded: true,
    scope: "ship_and_hive_group",
    ...traceFields,
  };
}

function shouldTraceDefenseEvent(
  state,
  key,
  when,
  throttleMs = DEFENSE_TRACE_THROTTLE_MS,
) {
  if (!defenseTraceEnabled()) {
    return false;
  }
  const previousAt = positive(state.defenseTraceAt.get(key));
  if (when - previousAt < throttleMs) {
    return false;
  }
  state.defenseTraceAt.set(key, when);
  return true;
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

function addWingMethods(exports, state, modulePath = "<unknown>") {
  if (!exports) {
    defenseTrace("runtime.patch", {status: "exports_unavailable", modulePath});
    return exports;
  }
  if (exports[DRONE_PATCH_MARKER]) {
    defenseTrace("runtime.patch", {status: "already_patched", modulePath});
    return exports;
  }

  const nativeMethodTypes = Object.fromEntries([
    "launchDronesForSession",
    "commandEngage",
    "commandMineRepeatedly",
    "commandReturnBay",
    "noteIncomingAggression",
  ].map((method) => {
    try {
      return [method, typeof exports[method]];
    } catch (_) {
      return [method, "throws"];
    }
  }));

  const runForWingShip = (
    methodName,
    baseSession,
    controllerEntity,
    shipRecord,
    args,
    expectedCharacterID,
  ) => {
    const normalizedShip = normalizeShipRecord(shipRecord, controllerEntity);
    const characterID = controllerCharacterID(
      controllerEntity,
      normalizedShip,
      expectedCharacterID,
    );
    const shipID = positive(controllerEntity && controllerEntity.itemID || normalizedShip && normalizedShip.itemID);
    if (!characterID || !shipID || typeof exports[methodName] !== "function") {
      defenseTrace("drone.operation.rejected", {
        method: methodName,
        reason: !characterID
          ? "owner_or_ship_id_unavailable"
          : !shipID
            ? "ship_id_unavailable"
            : "native_method_unavailable",
        characterID: positive(expectedCharacterID),
        shipID,
        entityShipID: positive(controllerEntity && controllerEntity.itemID),
        recordOwnerID: positive(normalizedShip && normalizedShip.ownerID),
      });
      return {
        success: false,
        errorMsg: "NPC_WING_DRONE_OWNER_OR_SHIP_ID_UNAVAILABLE",
      };
    }
    const sessionCharacterID = firstPositive(
      baseSession && baseSession.characterID,
      baseSession && baseSession.charid,
      baseSession && baseSession.charID,
    );
    if (sessionCharacterID && sessionCharacterID !== characterID) {
      defenseTrace("drone.operation.rejected", {
        method: methodName,
        reason: "session_owner_mismatch",
        characterID,
        sessionCharacterID,
        shipID,
      });
      return {
        success: false,
        errorMsg: "NPC_WING_DRONE_SESSION_OWNER_MISMATCH",
      };
    }
    const launchRequests = methodName === "launchDronesForSession" &&
      Array.isArray(args[0])
      ? args[0]
      : [];
    const requestedDroneIDs = methodName === "launchDronesForSession"
      ? launchRequests.map((entry) => positive(Array.isArray(entry) && entry[0])).filter(Boolean)
      : Array.isArray(args[0])
        ? args[0].map(positive).filter(Boolean)
        : [];
    const traceFields = {
      method: methodName,
      characterID,
      sessionCharacterID,
      shipID,
      droneIDs: requestedDroneIDs.slice(0, 24),
      droneCount: requestedDroneIDs.length,
      launchRequests: launchRequests.slice(0, 24),
      targetID: positive(args[1]),
      sceneSystemID: positive(controllerEntity && controllerEntity.systemID),
    };
    const pseudoSession = buildControllerSession(
      baseSession,
      controllerEntity,
      normalizedShip,
      characterID,
    );
    defenseTrace("drone.operation.before", traceFields);
    try {
      const result = withActiveShipOverride(
        state,
        characterID,
        normalizedShip,
        () => withControllerOwnerIdentity(
          controllerEntity,
          characterID,
          pseudoSession,
          () => exports[methodName](pseudoSession, ...args),
        ),
      );
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).then(
          (value) => {
            defenseTrace("drone.operation.after", {
              ...traceFields,
              result: droneResponseSummary(value),
            });
            return value;
          },
          (error) => {
            defenseTrace("drone.operation.throw", {
              ...traceFields,
              error: String(error && error.message || error),
            });
            throw error;
          },
        );
      }
      defenseTrace("drone.operation.after", {
        ...traceFields,
        result: droneResponseSummary(result),
      });
      return result;
    } catch (error) {
      defenseTrace("drone.operation.throw", {
        ...traceFields,
        error: String(error && error.message || error),
      });
      throw error;
    }
  };

  exports.launchDronesForWingShip = function launchDronesForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    requests,
    characterID,
  ) {
    return runForWingShip(
      "launchDronesForSession",
      baseSession,
      controllerEntity,
      shipRecord,
      [requests],
      characterID,
    );
  };

  exports.commandEngageForWingShip = function commandEngageForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    droneIDs,
    targetID,
    characterID,
  ) {
    return runForWingShip(
      "commandEngage",
      baseSession,
      controllerEntity,
      shipRecord,
      [droneIDs, targetID],
      characterID,
    );
  };

  exports.commandMineForWingShip = function commandMineForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    droneIDs,
    targetID,
    characterID,
  ) {
    return runForWingShip(
      "commandMineRepeatedly",
      baseSession,
      controllerEntity,
      shipRecord,
      [droneIDs, targetID],
      characterID,
    );
  };

  exports.commandReturnBayForWingShip = function commandReturnBayForWingShip(
    baseSession,
    controllerEntity,
    shipRecord,
    droneIDs,
    characterID,
  ) {
    return runForWingShip(
      "commandReturnBay",
      baseSession,
      controllerEntity,
      shipRecord,
      [droneIDs],
      characterID,
    );
  };

  exports.registerNpcMiningWingHiveShip = function registerNpcMiningWingHiveShip(
    entity,
    shipRecord,
  ) {
    return registerHiveShip(state, entity, shipRecord);
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
    shipRecord,
    expectedCharacterID,
  ) {
    const characterID = controllerCharacterID(
      controllerEntity,
      shipRecord,
      expectedCharacterID,
    );
    if (!characterID) {
      const shipID = positive(shipRecord && shipRecord.itemID);
      const droneID = positive(droneEntity && droneEntity.itemID);
      if (shouldTraceDefenseEvent(
        state,
        `capability.owner_missing:${shipID}:${droneID}`,
        Date.now(),
        5_000,
      )) {
        defenseTrace("drone.capability.rejected", {
          reason: "owner_or_ship_record_invalid",
          shipID,
          entityShipID: positive(controllerEntity && controllerEntity.itemID),
          droneID,
          recordOwnerID: positive(shipRecord && shipRecord.ownerID),
          expectedCharacterID: positive(expectedCharacterID),
        });
      }
      return {combatSnapshot: null, miningSnapshot: null};
    }
    try {
      const droneDogma = require(serverPath("services", "drone", "droneDogma"));
      const probe = {
        ...(droneEntity || {}),
        kind: "drone",
      };
      const ownerSession = buildControllerSession(
        null,
        controllerEntity,
        shipRecord,
        characterID,
      );
      const result = withControllerOwnerIdentity(
        controllerEntity,
        characterID,
        ownerSession,
        () => ({
          combatSnapshot:
            typeof droneDogma.resolveDroneCombatSnapshot === "function"
              ? droneDogma.resolveDroneCombatSnapshot(probe, controllerEntity)
              : null,
          miningSnapshot:
            typeof droneDogma.resolveDroneMiningSnapshot === "function"
              ? droneDogma.resolveDroneMiningSnapshot(probe, controllerEntity)
              : null,
        }),
      );
      if (result && result.success === false) {
        if (shouldTraceDefenseEvent(
          state,
          `capability.owner_bind_failed:${positive(shipRecord.itemID)}:${positive(droneEntity && droneEntity.itemID)}`,
          Date.now(),
          5_000,
        )) {
          defenseTrace("drone.capability.rejected", {
            reason: result.errorMsg || "owner_identity_bind_failed",
            characterID,
            shipID: positive(shipRecord.itemID),
            droneID: positive(droneEntity && droneEntity.itemID),
          });
        }
        return {combatSnapshot: null, miningSnapshot: null};
      }
      return result || {combatSnapshot: null, miningSnapshot: null};
    } catch (error) {
      const shipID = positive(shipRecord && shipRecord.itemID);
      const droneID = positive(droneEntity && droneEntity.itemID);
      if (shouldTraceDefenseEvent(
        state,
        `capability.throw:${shipID}:${droneID}`,
        Date.now(),
        5_000,
      )) {
        defenseTrace("drone.capability.throw", {
          characterID,
          shipID,
          droneID,
          error: String(error && error.message || error),
        });
      }
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
      let tracking = {trace: false, recorded: false, reason: "tracking_failed"};
      try {
        tracking = recordAggression(state, attackerEntity, targetEntity, when);
      } catch (error) {
        defenseTrace("incoming.tracking_throw", {
          attackerID: positive(attackerEntity && attackerEntity.itemID),
          targetID: positive(targetEntity && targetEntity.itemID),
          error: String(error && error.message || error),
        });
      }
      if (tracking.trace) {
        defenseTrace("incoming.before", tracking);
      }
      try {
        const result = originalNoteIncomingAggression.apply(this, arguments);
        if (tracking.trace) {
          defenseTrace("incoming.after", {
            ...tracking,
            nativeResult: result,
          });
        }
        return result;
      } catch (error) {
        if (tracking.trace) {
          defenseTrace("incoming.throw", {
            ...tracking,
            error: String(error && error.message || error),
          });
        }
        throw error;
      }
    };
  }

  exports[DRONE_PATCH_MARKER] = true;
  defenseTrace("runtime.patch", {
    status: "attached",
    modulePath,
    incomingAggressionHook: typeof originalNoteIncomingAggression === "function"
      ? "attached"
      : "native_method_unavailable",
    nativeMethodTypes,
    wingMethods: [
      "launchDronesForWingShip",
      "commandEngageForWingShip",
      "commandMineForWingShip",
      "commandReturnBayForWingShip",
      "registerNpcMiningWingHiveShip",
      "getNpcMiningWingGroupAggression",
      "resolveWingDroneCapabilities",
    ],
  });
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
      return addWingMethods(exported, state, String(resolved));
    }
    return exported;
  }
  load[INSTALL_MARKER] = true;
  load.npcMiningWingDroneBridgeState = state;
  return load;
}

function patchDroneRuntime(runtime, modulePath = "<unknown>") {
  if (!installedBridgeState) {
    defenseTrace("runtime.patch", {status: "bridge_state_unavailable", modulePath});
    return runtime;
  }
  return addWingMethods(runtime, installedBridgeState, modulePath);
}

function patchLoadedModules(state) {
  for (const [filename, cached] of Object.entries(require.cache)) {
    if (!cached || !cached.exports) {
      continue;
    }
    if (filename.endsWith(CHARACTER_STATE_SUFFIX)) {
      patchCharacterState(cached.exports, state);
    } else if (filename.endsWith(DRONE_RUNTIME_SUFFIX)) {
      addWingMethods(cached.exports, state, filename);
    }
  }
}

function install() {
  if (Module._load[INSTALL_MARKER]) {
    installedBridgeState = Module._load.npcMiningWingDroneBridgeState;
    return installedBridgeState;
  }
  const state = createBridgeState();
  installedBridgeState = state;
  Module._load = createLoader(state);
  patchLoadedModules(state);
  // Resolve the server path here only to keep the bridge's supported seam
  // explicit. The require remains lazy; no server subsystem is bootstrapped by
  // enabling the mod.
  void serverPath("services", "drone", "droneRuntime");
  defenseTrace("diagnostics.enabled", {
    enabled: defenseTraceEnabled(),
    rateLimitPerSecond: DEFENSE_TRACE_MAX_LINES_PER_SECOND,
    optOutEnvironment: DEFENSE_TRACE_ENV,
  });
  return state;
}

module.exports = Object.freeze({install, patchDroneRuntime});
