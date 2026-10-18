"use strict";

const log = require(require("./runtime").serverPath("utils", "logger"));
const {getRuntimeDependencies, serverPath} = require("./runtime");
const {isHaulerProfile} = require("./routeEngine");
const {loadHaulerCargo, storeHaulerCargo} = require("./cargoOps");
const {depositWreckLoot, recordForShip} = require("./wreckLoot");
const {MOD_ID, WARP_OVERVIEW_HIDE_METERS} = require("./constants");
const {finite, positive} = require("./util");

function ensureHaulerCargoStored(service, shipEntity) {
  if (!shipEntity || shipEntity.ambientNpcTraffic !== true) {
    return;
  }
  const record = recordForShip(service, shipEntity);
  if (!record || !isHaulerProfile(record.profileID)) {
    return;
  }
  const dependencies = getRuntimeDependencies();
  if (!Array.isArray(record.pendingWreckCargo) || record.pendingWreckCargo.length === 0) {
    loadHaulerCargo(service, shipEntity, record, dependencies);
  }
  storeHaulerCargo(shipEntity, record, dependencies);
}

function lootDestroyedHauler(service, shipEntity, destroyResult) {
  if (!shipEntity || shipEntity.ambientNpcTraffic !== true) {
    return;
  }
  if (!destroyResult || destroyResult.success !== true || !destroyResult.data) {
    return;
  }
  const record = recordForShip(service, shipEntity);
  const wreck = destroyResult.data.wreck;
  if (!record || !wreck) {
    return;
  }
  depositWreckLoot(
    record,
    null,
    positive(shipEntity.itemID, 0),
    getRuntimeDependencies(),
    wreck,
  );
}

function installWreckLootHook(service) {
  if (service._wreckLootHookInstalled) {
    return;
  }
  let wreckService;
  try {
    wreckService = require(serverPath("space", "npc", "nativeNpcWreckService"));
  } catch (error) {
    log.debug(`[${MOD_ID}] wreck service unavailable: ${error.message}`);
    return;
  }
  const original = wreckService.destroyNativeNpcEntityWithWreck;
  if (typeof original !== "function") {
    return;
  }
  const installed = Symbol.for("evejs.ambientNpcTraffic.wreckLoot");
  if (original[installed] === true) {
    service._wreckLootHookInstalled = true;
    return;
  }
  const destroyWithTrafficLoot = function destroyWithTrafficLoot(systemID, shipEntity, options) {
    try {
      ensureHaulerCargoStored(service, shipEntity);
    } catch (error) {
      log.warn(`[${MOD_ID}] cargo store before wreck failed: ${error.message}`);
    }
    const result = original.call(this, systemID, shipEntity, options);
    try {
      lootDestroyedHauler(service, shipEntity, result);
    } catch (error) {
      log.warn(`[${MOD_ID}] wreck loot hook failed: ${error.message}`);
    }
    return result;
  };
  destroyWithTrafficLoot[installed] = true;
  wreckService.destroyNativeNpcEntityWithWreck = destroyWithTrafficLoot;
  service._wreckLootHookInstalled = true;
}

function installWarpOverviewHook(service) {
  if (service._warpOverviewHookInstalled) {
    return;
  }
  let SolarSystemScene;
  try {
    ({SolarSystemScene} = require(serverPath("space", "runtime", "solarSystemScene")));
  } catch (error) {
    log.debug(`[${MOD_ID}] warp overview hook unavailable: ${error.message}`);
    return;
  }
  const prototype = SolarSystemScene && SolarSystemScene.prototype;
  const original = prototype && prototype.canSessionSeeWarpingDynamicEntity;
  if (typeof original !== "function") {
    return;
  }
  const installed = Symbol.for("evejs.ambientNpcTraffic.warpOverview");
  if (original[installed] === true) {
    service._warpOverviewHookInstalled = true;
    return;
  }
  const hideDistanceSquared = WARP_OVERVIEW_HIDE_METERS * WARP_OVERVIEW_HIDE_METERS;
  function canSeeWarpingShip(session, entity, now, options) {
    const visible = original.call(this, session, entity, now, options);
    if (visible !== true || !entity || entity.ambientNpcTraffic !== true) {
      return visible;
    }
    const ego = typeof this.getShipEntityForSession === "function"
      ? this.getShipEntityForSession(session)
      : null;
    if (!ego || !ego.position || !entity.position) {
      return visible;
    }
    const dx = finite(ego.position.x, 0) - finite(entity.position.x, 0);
    const dy = finite(ego.position.y, 0) - finite(entity.position.y, 0);
    const dz = finite(ego.position.z, 0) - finite(entity.position.z, 0);
    if ((dx * dx) + (dy * dy) + (dz * dz) > hideDistanceSquared) {
      return false;
    }
    return visible;
  }
  canSeeWarpingShip[installed] = true;
  prototype.canSessionSeeWarpingDynamicEntity = canSeeWarpingShip;
  service._warpOverviewHookInstalled = true;
}

module.exports = {
  ensureHaulerCargoStored,
  installWarpOverviewHook,
  installWreckLootHook,
  lootDestroyedHauler,
};
