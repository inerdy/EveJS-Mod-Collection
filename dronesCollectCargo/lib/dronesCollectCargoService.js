"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const invBrokerItemCustody = require(serverPath(
  "services",
  "inventory",
  "invBrokerItemCustody",
));
const deliveryItemCustody = require(serverPath(
  "services",
  "inventory",
  "deliveryItemCustody",
));
const itemCustody = require(serverPath("services", "inventory", "itemCustody"));
const lootEntitlement = require(serverPath(
  "services",
  "_shared",
  "spaceLootEntitlement",
));
const {findSessionByCharacterID} = require(serverPath(
  "services",
  "chat",
  "sessionRegistry",
));
const {resolveSessionCharacterID} = require(serverPath(
  "services",
  "_shared",
  "sessionIdentity",
));
const log = require(serverPath("utils", "logger"));

const SERVICE_NAME = "dronesCollectCargo";
const CARGO_HOLD_FLAG = itemStore.ITEM_FLAGS.CARGO_HOLD;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function characterIDFromSession(session) {
  return toInt(resolveSessionCharacterID(session), 0);
}

function quantityOf(item) {
  return Math.max(1, toInt(item && (item.stacksize || item.quantity), 1));
}

function volumeOf(item) {
  return Math.max(0, toNumber(item && item.volume, 0)) * quantityOf(item);
}

function entityID(entity) {
  return toInt(entity && entity.itemID, 0);
}

function controllerIDForDrone(droneEntity) {
  return toInt(droneEntity && droneEntity.controllerID, 0);
}

function isSameOwner(item, ownerID) {
  return toInt(item && item.ownerID, 0) === toInt(ownerID, 0);
}

class DronesCollectCargoService extends BaseService {
  constructor() {
    super(SERVICE_NAME);
    this.enabled = true;
    this._droneRuntime = null;
    this._contextDepth = 0;
    this._activeTick = null;
    this._blockedDrones = new Set();
  }

  Handle_GetState() {
    return JSON.stringify({
      schemaVersion: 1,
      enabled: this.enabled === true,
    });
  }

  attachDroneRuntime(droneRuntime) {
    if (droneRuntime && typeof droneRuntime === "object") {
      this._droneRuntime = droneRuntime;
    }
  }

  isEnabled() {
    return this.enabled === true;
  }

  isDroneSalvageContextActive() {
    return this.isEnabled() && this._contextDepth > 0;
  }

  withDroneSalvageContext(callback) {
    if (typeof callback !== "function") {
      return undefined;
    }
    this._contextDepth += 1;
    try {
      return callback();
    } finally {
      this._contextDepth = Math.max(0, this._contextDepth - 1);
    }
  }

  resolveTarget(args = {}) {
    const scene = args && args.scene;
    const effectState = args && args.effectState;
    if (args && args.targetEntity) {
      return args.targetEntity;
    }
    const targetID = toInt(effectState && effectState.targetID, 0);
    return scene && targetID > 0 && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(targetID)
      : null;
  }

  isCargoContainerTarget(targetEntity) {
    if (!this.isEnabled() || !targetEntity || targetEntity.kind !== "container") {
      return false;
    }
    if (
      targetEntity.nativeNpcWreck === true ||
      targetEntity.cargoContainerAnchorable === true ||
      targetEntity.isAnchored === true
    ) {
      return false;
    }
    const targetID = entityID(targetEntity);
    const item = targetID > 0 ? itemStore.findItemById(targetID) : null;
    const systemID = toInt(targetEntity.systemID, 0);
    if (
      !item ||
      !itemStore.isCargoContainerInventoryItem(item) ||
      toInt(item.flagID, -1) !== 0 ||
      toInt(item.locationID, 0) <= 0 ||
      (systemID > 0 && toInt(item.locationID, 0) !== systemID)
    ) {
      return false;
    }
    return itemStore.listContainerItems(null, targetID, null).length > 0;
  }

  _controllerSession(droneEntity, controllerEntity) {
    if (
      controllerEntity &&
      controllerEntity.session &&
      typeof controllerEntity.session.sendNotification === "function"
    ) {
      return controllerEntity.session;
    }
    const characterID = toInt(
      controllerEntity && (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
      toInt(droneEntity && droneEntity.controllerOwnerID, 0),
    );
    return characterID > 0 ? findSessionByCharacterID(characterID) || null : null;
  }

  _canDroneAct(scene, session, droneEntity, controllerEntity, targetEntity) {
    const runtime = this._droneRuntime;
    const tester = runtime && runtime._testing && runtime._testing.canPlayerCompanionActOnTarget;
    if (typeof tester !== "function") {
      return true;
    }
    try {
      return tester(scene, session, droneEntity, controllerEntity, targetEntity) === true;
    } catch (_error) {
      return false;
    }
  }

  _distance(scene, source, target) {
    if (
      scene &&
      typeof scene.getCommandTimeEntitySurfaceDistance === "function"
    ) {
      try {
        return toNumber(
          scene.getCommandTimeEntitySurfaceDistance(
            source,
            target,
            typeof scene.getCurrentSimTimeMs === "function"
              ? scene.getCurrentSimTimeMs()
              : scene.simTimeMs,
          ),
          Number.POSITIVE_INFINITY,
        );
      } catch (_error) {
        // Fall through to a simple center-distance estimate.
      }
    }
    const left = source && source.position;
    const right = target && target.position;
    if (!left || !right) {
      return Number.POSITIVE_INFINITY;
    }
    const dx = toNumber(left.x, 0) - toNumber(right.x, 0);
    const dy = toNumber(left.y, 0) - toNumber(right.y, 0);
    const dz = toNumber(left.z, 0) - toNumber(right.z, 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _eligibleContainerTargets(scene, droneEntity, controllerEntity, session) {
    if (!scene || !(scene.dynamicEntities instanceof Map)) {
      return [];
    }
    return [...scene.dynamicEntities.values()]
      .filter((targetEntity) => this.isCargoContainerTarget(targetEntity))
      .filter((targetEntity) => {
        const item = itemStore.findItemById(entityID(targetEntity));
        const source = lootEntitlement.buildSpaceLootSourceFromItem(item);
        return lootEntitlement.sessionHasSpaceLootRight(session, source);
      })
      .filter((targetEntity) => this._canDroneAct(
        scene,
        session,
        droneEntity,
        controllerEntity,
        targetEntity,
      ))
      .sort((left, right) => {
        const leftDistance = Math.min(
          this._distance(scene, droneEntity, left),
          this._distance(scene, controllerEntity, left),
        );
        const rightDistance = Math.min(
          this._distance(scene, droneEntity, right),
          this._distance(scene, controllerEntity, right),
        );
        return leftDistance - rightDistance;
      });
  }

  _sendMessage(session, message) {
    if (!session || !message) {
      return;
    }
    try {
      const chatHub = require(serverPath("services", "chat", "chatHub"));
      if (chatHub && typeof chatHub.sendSystemMessage === "function") {
        chatHub.sendSystemMessage(session, `[Drone Cargo] ${message}`);
      }
    } catch (error) {
      log.debug(`[${SERVICE_NAME}] notification failed: ${error.message}`);
    }
  }

  collectContainer(args = {}) {
    const scene = args.scene;
    const droneEntity = args.entity;
    const callbacks = args.callbacks || {};
    const targetEntity = this.resolveTarget(args);
    const targetID = entityID(targetEntity);
    const droneID = entityID(droneEntity);
    if (
      !this.isEnabled() ||
      !scene ||
      !droneEntity ||
      !targetEntity ||
      !this.isCargoContainerTarget(targetEntity) ||
      targetID <= 0 ||
      droneID <= 0
    ) {
      return {success: false, stopReason: "target"};
    }

    const session = typeof callbacks.resolveSession === "function"
      ? callbacks.resolveSession(droneEntity)
      : this._controllerSession(droneEntity, null);
    const characterID = toInt(
      typeof callbacks.resolveCharacterID === "function"
        ? callbacks.resolveCharacterID(droneEntity)
        : characterIDFromSession(session),
      0,
    );
    if (characterID <= 0 || !session) {
      this._blockedDrones.add(droneID);
      return {success: false, stopReason: "cargo"};
    }

    const item = itemStore.findItemById(targetID);
    const source = lootEntitlement.buildSpaceLootSourceFromItem(item);
    if (!lootEntitlement.sessionHasSpaceLootRight(session, source)) {
      this._blockedDrones.add(droneID);
      return {success: false, stopReason: "target"};
    }

    const surfaceDistance = typeof callbacks.getEntitySurfaceDistance === "function"
      ? toNumber(callbacks.getEntitySurfaceDistance(droneEntity, targetEntity), Infinity)
      : this._distance(scene, droneEntity, targetEntity);
    const range = Math.max(0, toNumber(args.effectState && args.effectState.salvagerRangeMeters, 0));
    if (surfaceDistance > range + 1) {
      return {success: false, stopReason: "range"};
    }

    const contents = itemStore.listContainerItems(null, targetID, null);
    if (contents.length === 0) {
      this._blockedDrones.add(droneID);
      return {
        success: false,
        stopReason: "cargo",
        data: {targetID, containerLoot: true, salvaged: false},
      };
    }

    const changes = [];
    let movedStacks = 0;
    let movedQuantity = 0;
    let movedVolume = 0;
    let blockedStacks = 0;
    for (const content of contents) {
      const idempotencyKey = `${SERVICE_NAME}:${droneID}:${targetID}:${entityID(content)}`;
      const result = isSameOwner(content, characterID)
        ? invBrokerItemCustody.moveItem({
          item: content,
          ownerID: characterID,
          locationID: droneID,
          flagID: CARGO_HOLD_FLAG,
          actor: characterID,
          idempotencyKey,
        })
        : deliveryItemCustody.transferItem({
          item: content,
          ownerID: characterID,
          locationID: droneID,
          flagID: CARGO_HOLD_FLAG,
          actor: characterID,
          reason: itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
          idempotencyKey,
        });
      if (!result || result.success !== true) {
        blockedStacks += 1;
        continue;
      }
      movedStacks += 1;
      movedQuantity += quantityOf(content);
      movedVolume += volumeOf(content);
      changes.push(...((result.data && result.data.changes) || []));
    }

    if (changes.length > 0 && typeof callbacks.syncInventoryChangesToSession === "function") {
      callbacks.syncInventoryChangesToSession(session, changes);
    }

    if (movedStacks <= 0) {
      this._blockedDrones.add(droneID);
      return {
        success: false,
        stopReason: "cargo",
        data: {
          targetID,
          containerLoot: true,
          salvaged: false,
          blockedStacks,
        },
      };
    }

    this._sendMessage(
      session,
      `Salvage drone collected ${movedQuantity} item(s) from container ${targetID}` +
        (blockedStacks > 0 ? `; ${blockedStacks} stack(s) could not fit.` : "."),
    );
    return {
      success: false,
      stopReason: "target",
      data: {
        targetID,
        containerLoot: true,
        salvaged: true,
        movedStacks,
        movedQuantity,
        movedVolume,
        blockedStacks,
      },
    };
  }

  _trackedSalvageDrones(scene) {
    const runtime = this._droneRuntime;
    if (!scene || !(scene.dynamicEntities instanceof Map) || !runtime) {
      return [];
    }
    return [...scene.dynamicEntities.values()]
      .filter((entity) => (
        runtime.isDroneEntity(entity) &&
        entity.droneCommand === runtime.DRONE_COMMAND_SALVAGE
      ))
      .map((droneEntity) => ({
        droneID: entityID(droneEntity),
        controllerID: controllerIDForDrone(droneEntity),
      }))
      .filter((entry) => entry.droneID > 0 && entry.controllerID > 0);
  }

  _recallToBay(scene, droneEntity, controllerEntity) {
    const runtime = this._droneRuntime;
    const testing = runtime && runtime._testing;
    const shipRecord = controllerEntity
      ? itemStore.findItemById(entityID(controllerEntity))
      : null;
    if (
      !runtime ||
      !testing ||
      typeof testing.recallDronesToShipBay !== "function" ||
      !shipRecord
    ) {
      return false;
    }
    try {
      const result = testing.recallDronesToShipBay(
        scene,
        shipRecord,
        [droneEntity],
        itemStore.ITEM_FLAGS.DRONE_BAY,
      );
      if (!result || result.success !== true) {
        log.debug(
          `[${SERVICE_NAME}] drone=${entityID(droneEntity)} bay recall deferred: ` +
            `${result && result.errorMsg || "UNKNOWN"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      log.warn(`[${SERVICE_NAME}] bay recall failed: ${error.message}`);
      return false;
    }
  }

  _finishTrackedSalvage(scene, tracked) {
    const runtime = this._droneRuntime;
    if (!runtime || !scene || !Array.isArray(tracked)) {
      return;
    }
    for (const entry of tracked) {
      const droneEntity = scene.getEntityByID(entry.droneID);
      const controllerEntity = scene.getEntityByID(entry.controllerID);
      if (!runtime.isDroneEntity(droneEntity) || !controllerEntity) {
        continue;
      }
      if (droneEntity.droneCommand === runtime.DRONE_COMMAND_SALVAGE) {
        continue;
      }
      if (this._blockedDrones.has(entry.droneID)) {
        this._recallToBay(scene, droneEntity, controllerEntity);
        continue;
      }

      const session = this._controllerSession(droneEntity, controllerEntity);
      const nextTarget = session
        ? this._eligibleContainerTargets(scene, droneEntity, controllerEntity, session)[0]
        : null;
      if (nextTarget && typeof runtime.commandSalvage === "function") {
        try {
          this.withDroneSalvageContext(() => runtime.commandSalvage(
            session,
            [entry.droneID],
            entityID(nextTarget),
          ));
        } catch (error) {
          log.debug(`[${SERVICE_NAME}] container assignment failed: ${error.message}`);
        }
      }
      const refreshedDrone = scene.getEntityByID(entry.droneID);
      if (
        refreshedDrone &&
        refreshedDrone.droneCommand === runtime.DRONE_COMMAND_SALVAGE
      ) {
        continue;
      }
      this._recallToBay(scene, droneEntity, controllerEntity);
    }
  }

  runDroneTick(droneRuntime, scene, now, callback) {
    if (!this.isEnabled() || typeof callback !== "function") {
      return callback();
    }
    this._droneRuntime = droneRuntime || this._droneRuntime;
    this._blockedDrones = new Set();
    const tracked = this._trackedSalvageDrones(scene);
    this._activeTick = {scene, now};
    this._contextDepth += 1;
    try {
      return callback();
    } finally {
      this._contextDepth = Math.max(0, this._contextDepth - 1);
      this._activeTick = null;
      try {
        this._finishTrackedSalvage(scene, tracked);
      } catch (error) {
        log.warn(`[${SERVICE_NAME}] salvage completion handling failed: ${error.message}`);
      }
    }
  }
}

module.exports = DronesCollectCargoService;
