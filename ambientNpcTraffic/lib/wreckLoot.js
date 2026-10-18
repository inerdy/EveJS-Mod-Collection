"use strict";

const log = require(require("./runtime").serverPath("utils", "logger"));
const {serverPath} = require("./runtime");
const {buildWreckLootRecord} = require("./haulerCargo");
const {MOD_ID, WRECK_LOOT_WAIT_MS} = require("./constants");
const {currentEntityID, normalizeSystemID, positive} = require("./util");

function recordForShip(service, shipEntity) {
  const trafficID = shipEntity && shipEntity.ambientNpcTrafficID;
  if (trafficID && service._records.has(trafficID)) {
    return service._records.get(trafficID);
  }
  const entityID = positive(shipEntity && shipEntity.itemID, 0);
  for (const record of service._records.values()) {
    if (currentEntityID(record) === entityID) {
      return record;
    }
  }
  return null;
}

function findShipWreck(scene, entityID, dependencies) {
  const shipID = positive(entityID, 0);
  if (!shipID) {
    return null;
  }
  const listWrecks = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.listNativeWrecks;
  const wrecks = typeof listWrecks === "function" ? listWrecks() : [];
  const stored = wrecks.find((row) => (
    positive(row && row.launcherID, 0) === shipID ||
    positive(row && row.sourceEntityID, 0) === shipID
  ));
  if (stored) {
    const wreckID = positive(stored.wreckID, 0);
    const entity = wreckID && scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(wreckID)
      : null;
    return {
      wreckID,
      ownerID: positive(stored.ownerID, 0),
      systemID: positive(stored.systemID, 0),
      transient: stored.transient === true,
      entity,
    };
  }
  if (!scene || !(scene.dynamicEntities instanceof Map)) {
    return null;
  }
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity || entity.nativeNpcWreck !== true) {
      continue;
    }
    if (positive(entity.launcherID, 0) !== shipID) {
      continue;
    }
    return {
      wreckID: positive(entity.itemID, 0),
      ownerID: positive(entity.ownerID, 0),
      systemID: normalizeSystemID(scene.systemID),
      transient: entity.transient === true,
      entity,
    };
  }
  return null;
}

function wreckTarget(scene, entityID, dependencies, wreckHint = null) {
  const hintedID = positive(wreckHint && wreckHint.wreckID, 0);
  if (hintedID > 0) {
    return {
      wreckID: hintedID,
      ownerID: positive(wreckHint.ownerID, 0),
      systemID: positive(wreckHint.systemID, scene && scene.systemID),
      transient: wreckHint.transient === true,
      entity: scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(hintedID)
        : null,
    };
  }
  return findShipWreck(scene, entityID, dependencies);
}

function refreshWreck(scene, wreck) {
  const wreckID = positive(wreck && wreck.wreckID, 0);
  const systemID = normalizeSystemID(
    (wreck && wreck.systemID) || (scene && scene.systemID),
  );
  if (!wreckID || !systemID) {
    return;
  }
  try {
    const wreckService = require(serverPath("space", "npc", "nativeNpcWreckService"));
    if (typeof wreckService.refreshNativeWreckRuntimeEntity === "function") {
      const refreshed = wreckService.refreshNativeWreckRuntimeEntity(systemID, wreckID, {
        broadcast: true,
        scene,
      });
      if (refreshed && refreshed.success === true) {
        return;
      }
    }
  } catch (error) {
    log.debug(`[${MOD_ID}] wreck refresh failed wreck=${wreckID}: ${error.message}`);
  }
  if (wreck.entity && scene && typeof scene.broadcastSlimItemChanges === "function") {
    wreck.entity.isEmpty = false;
    scene.broadcastSlimItemChanges([wreck.entity]);
  }
}

function depositWreckLoot(record, scene, entityID, dependencies, wreckHint = null) {
  if (!record || record.wreckLootDeposited === true) {
    return record && record.wreckLootDeposited === true;
  }
  const stacks = Array.isArray(record.pendingWreckCargo) ? record.pendingWreckCargo : [];
  if (stacks.length === 0) {
    return false;
  }
  const wreck = wreckTarget(scene, entityID, dependencies, wreckHint);
  if (!wreck) {
    return false;
  }
  const listItems = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.listNativeWreckItemsForWreck;
  const existing = typeof listItems === "function" ? listItems(wreck.wreckID) : [];
  const existingTypes = new Set((Array.isArray(existing) ? existing : []).map((row) => (
    positive(row && row.typeID, 0)
  )));
  if (stacks.every((stack) => existingTypes.has(positive(stack && stack.typeID, 0)))) {
    record.wreckLootDeposited = true;
    record.pendingWreckCargo = null;
    refreshWreck(scene, wreck);
    return true;
  }
  const allocate = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.allocateWreckItemID;
  const upsert = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.upsertNativeWreckItem;
  if (typeof allocate !== "function" || typeof upsert !== "function") {
    return false;
  }
  let storedCount = 0;
  for (const stack of stacks) {
    const allocated = allocate({transient: wreck.transient === true});
    const wreckItemID = allocated && allocated.success === true
      ? positive(allocated.data, 0)
      : 0;
    if (!wreckItemID) {
      continue;
    }
    const writeResult = upsert(
      buildWreckLootRecord(wreck, stack, wreckItemID),
      {transient: wreck.transient === true},
    );
    if (writeResult && writeResult.success === true) {
      storedCount += 1;
    } else {
      log.warn(
        `[${MOD_ID}] wreck loot failed wreck=${wreck.wreckID} type=${stack.typeID} ` +
        `reason=${writeResult && writeResult.errorMsg || "UNKNOWN"}`,
      );
    }
  }
  if (storedCount <= 0) {
    return false;
  }
  record.wreckLootDeposited = true;
  record.pendingWreckCargo = null;
  refreshWreck(scene, wreck);
  log.info(
    `[${MOD_ID}] wreck loot wreck=${wreck.wreckID} ship=${entityID} stacks=${storedCount}`,
  );
  return true;
}

function noteMissingEntity(record, scene, entityID, nowMs, dependencies) {
  if (record && record.removedByTraffic === true) {
    return "gone";
  }
  if (depositWreckLoot(record, scene, entityID, dependencies)) {
    return "gone";
  }
  const stacks = record && Array.isArray(record.pendingWreckCargo)
    ? record.pendingWreckCargo
    : [];
  if (stacks.length === 0 || record.wreckLootDeposited === true) {
    return "gone";
  }
  if (!record.wreckWaitUntilMs) {
    record.wreckWaitUntilMs = nowMs + WRECK_LOOT_WAIT_MS;
  }
  return nowMs < record.wreckWaitUntilMs ? "wait" : "gone";
}

module.exports = {
  depositWreckLoot,
  findShipWreck,
  noteMissingEntity,
  recordForShip,
  refreshWreck,
  wreckTarget,
};
