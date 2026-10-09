"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const characterState = require(serverPath("services", "character", "characterState"));
const walletState = require(serverPath("services", "account", "walletState"));
const chatHub = require(serverPath("services", "chat", "chatHub"));
const spaceRuntime = require(serverPath("space", "runtime"));
const lootEntitlement = require(serverPath("services", "_shared", "spaceLootEntitlement"));
const invBrokerItemCustody = require(serverPath(
  "services", "inventory", "invBrokerItemCustody",
));
const deliveryItemCustody = require(serverPath(
  "services", "inventory", "deliveryItemCustody",
));
const itemCustody = require(serverPath("services", "inventory", "itemCustody"));
const {resolveSessionCharacterID} = require(serverPath(
  "services", "_shared", "sessionIdentity",
));
const {resolveDataRootPath} = require(serverPath("config", "dataRoot"));
const {getTypeEffectRecords, listFittedItemsForLocation} = require(serverPath(
  "services", "fitting", "liveFittingState",
));
const {getCachedCharacterSkillMap} = require(serverPath(
  "services", "skills", "skillState",
));
const salvagerRuntime = require(serverPath("space", "modules", "salvagerRuntime"));
const tractorBeamRuntime = require(serverPath("space", "modules", "tractorBeamRuntime"));
const log = require(serverPath("utils", "logger"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {createStateStore, normalizeCharacter} = require(path.join(__dirname, "state"));

const MOD_ID = "salvageBuddy";
const SERVICE_NAME = MOD_ID;
const AU_METERS = 149597870700;
const CARGO_HOLD_FLAG = itemStore.ITEM_FLAGS.CARGO_HOLD;
const DRONE_BAY_FLAG = itemStore.ITEM_FLAGS.DRONE_BAY;
const HIGH_SLOT_FLAGS = [27, 28, 29, 30, 31, 32, 33, 34];

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function quantityOf(item) {
  return Math.max(1, Math.trunc(Number(item && (item.stacksize || item.quantity)) || 1));
}

function vector(value) {
  if (!value || typeof value !== "object") return null;
  const result = {x: finite(value.x, NaN), y: finite(value.y, NaN), z: finite(value.z, NaN)};
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function distanceMeters(left, right) {
  const a = vector(left);
  const b = vector(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function characterIDFromSession(session) {
  return positive(resolveSessionCharacterID(session), 0);
}

function shipIDFromSession(session) {
  return positive(
    session && session._space && session._space.shipID ||
      session && (session.shipID || session.shipid || session.activeShipID),
    0,
  );
}

function systemIDFromSession(session) {
  return positive(session && session._space && session._space.systemID, 0);
}

function isInSpaceSession(session) {
  return Boolean(session && shipIDFromSession(session) && systemIDFromSession(session) &&
    !(
      session.stationid || session.stationID || session.structureid || session.structureID
    ));
}

function sameOwner(item, ownerID) {
  return positive(item && item.ownerID) === positive(ownerID);
}

class SalvageBuddyService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._stateStore = options.stateStore || createStateStore(
      resolveDataRootPath("gameStore", MOD_ID, "state.json"),
    );
    this._state = this._stateStore.load();
    this._active = new Map();
  }

  _saveState() {
    this._stateStore.save(this._state);
  }

  _character(characterID) {
    const key = String(positive(characterID));
    if (!this._state.characters[key]) {
      this._state.characters[key] = normalizeCharacter({});
    }
    return this._state.characters[key];
  }

  _nextRequestID() {
    const requestID = Math.max(1, Math.trunc(Number(this._state.nextRequestID) || 1));
    this._state.nextRequestID = requestID + 1;
    return requestID;
  }

  _activeShip(characterID, session) {
    const requestedID = shipIDFromSession(session);
    if (requestedID > 0) {
      return itemStore.findCharacterShipItem(characterID, requestedID) ||
        itemStore.findShipItemById(requestedID) || null;
    }
    return itemStore.getActiveShipItem(characterID) || null;
  }

  _sceneForSession(session) {
    return typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  }

  _send(session, message) {
    if (!session || !message) return;
    try {
      chatHub.sendSystemMessage(session, `[SalvageBuddy] ${message}`);
    } catch (error) {
      log.debug(`[${MOD_ID}] notification failed: ${error.message}`);
    }
  }

  _stateForSession(session) {
    const characterID = characterIDFromSession(session);
    const character = this._character(characterID);
    const request = this._active.get(characterID) || null;
    const now = Date.now();
    return JSON.stringify({
      enabled: this._config.enabled === true,
      serviceFeeISK: this._config.serviceFeeISK,
      cooldownSeconds: this._config.cooldownSeconds,
      cooldownRemainingSeconds: Math.max(
        0,
        Math.ceil((Math.max(0, character.cooldownUntilMs - now)) / 1000),
      ),
      active: Boolean(request),
      stage: request ? request.stage : "idle",
      targetsProcessed: request ? request.targetsProcessed : 0,
      targetsFound: request ? request.targetsFound : 0,
      lastStatus: character.lastStatus || "",
      canRequest: this._config.enabled === true &&
        isInSpaceSession(session) &&
        !request &&
        character.cooldownUntilMs <= now,
    });
  }

  Handle_GetState(_args, session) {
    return this._stateForSession(session);
  }

  async _charge(characterID, requestID) {
    const amount = Math.max(0, Number(this._config.serviceFeeISK) || 0);
    if (amount <= 0) return {success: true, amount: 0};
    const wallet = walletState.getCharacterWallet(characterID);
    if (!wallet || Number(wallet.balance) < amount) {
      return {success: false, errorMsg: "INSUFFICIENT_ISK"};
    }
    const key = `${MOD_ID}:${characterID}:${requestID}:charge`;
    const result = await walletState.adjustCharacterBalanceAsync(
      characterID,
      -amount,
      {
        idempotencyKey: key,
        description: "SalvageBuddy service",
        entryTypeID: walletState.JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
        ownerID1: characterID,
        referenceID: requestID,
      },
      {commandID: key, source: MOD_ID},
    );
    return result && result.success === true
      ? {success: true, amount}
      : {success: false, errorMsg: result && result.errorMsg || "CHARGE_FAILED"};
  }

  async _refund(request) {
    if (!request || request.refunded === true || request.chargedISK <= 0) return false;
    const key = `${MOD_ID}:${request.characterID}:${request.id}:refund`;
    const result = await walletState.adjustCharacterBalanceAsync(
      request.characterID,
      request.chargedISK,
      {
        idempotencyKey: key,
        description: "SalvageBuddy failed-service refund",
        entryTypeID: walletState.JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
        ownerID1: request.characterID,
        referenceID: request.id,
      },
      {commandID: key, source: MOD_ID},
    );
    if (result && result.success === true) {
      request.refunded = true;
      return true;
    }
    return false;
  }

  _validateType(typeID, label) {
    const metadata = itemStore.getItemMetadata(typeID);
    if (!metadata || positive(metadata.typeID) !== positive(typeID)) {
      throw new Error(`${label.toUpperCase()}_TYPE_NOT_FOUND`);
    }
    return metadata;
  }

  _installFit(characterID, shipID) {
    const config = this._config;
    this._validateType(config.noctisTypeID, "noctis");
    this._validateType(config.tractorBeamTypeID, "tractor beam");
    this._validateType(config.salvagerTypeID, "salvager");
    this._validateType(config.salvageDroneTypeID, "salvage drone");
    const createdItems = [];
    const grant = (typeID, quantity, flagID, label, moduleState = undefined) => {
      for (let index = 0; index < quantity; index += 1) {
        const result = itemStore.grantItemToCharacterLocation(
          characterID,
          shipID,
          flagID,
          typeID,
          1,
          {
            singleton: 1,
            transient: true,
            customInfo: `${MOD_ID}:temporary-fit`,
            moduleState,
          },
        );
        if (!result || result.success !== true || !result.data || !result.data.items[0]) {
          throw new Error(`${label.toUpperCase()}_FIT_FAILED`);
        }
        createdItems.push(result.data.items[0]);
      }
    };

    const online = {online: true, damage: 0, armorDamage: 0, shieldCharge: 0, incapacitated: false};
    for (let index = 0; index < config.tractorBeamCount; index += 1) {
      grant(config.tractorBeamTypeID, 1, HIGH_SLOT_FLAGS[index], "tractor beam", online);
    }
    for (let index = 0; index < config.salvagerCount; index += 1) {
      grant(
        config.salvagerTypeID,
        1,
        HIGH_SLOT_FLAGS[config.tractorBeamCount + index],
        "salvager",
        online,
      );
    }
    for (let index = 0; index < config.salvageDroneCount; index += 1) {
      grant(config.salvageDroneTypeID, 1, DRONE_BAY_FLAG, "salvage drone");
    }
    return createdItems;
  }

  async _spawnServiceShip(session, request) {
    const characterID = request.characterID;
    const systemID = systemIDFromSession(session);
    const scene = this._sceneForSession(session);
    const playerEntity = scene && scene.getShipEntityForSession
      ? scene.getShipEntityForSession(session)
      : null;
    if (!systemID || !scene || !playerEntity) return null;
    const origin = vector(playerEntity.position) || {x: 0, y: 0, z: 0};
    const rawDirection = vector(playerEntity.direction) || {x: 1, y: 0, z: 0};
    const directionLength = Math.hypot(rawDirection.x, rawDirection.y, rawDirection.z) || 1;
    const spawnDistance = this._config.spawnDistanceAU * AU_METERS;
    const position = {
      x: origin.x + rawDirection.x / directionLength * spawnDistance,
      y: origin.y + rawDirection.y / directionLength * spawnDistance,
      z: origin.z + rawDirection.z / directionLength * spawnDistance,
    };
    const created = itemStore.createSpaceItemForCharacter(
      characterID,
      systemID,
      this._config.noctisTypeID,
      {
        position,
        mode: "STOP",
        customInfo: `${MOD_ID}:${request.id}`,
        expiresAtMs: Date.now() + this._config.serviceLifetimeMs,
        transient: true,
      },
    );
    if (!created || created.success !== true || !created.data) return null;
    const serviceShipID = positive(created.data.itemID);
    try {
      this._installFit(characterID, serviceShipID);
    } catch (error) {
      itemStore.removeInventoryItem(serviceShipID, {removeContents: true});
      throw error;
    }
    const spawned = spaceRuntime.spawnDynamicInventoryEntity(
      scene.sceneDescriptor || systemID,
      serviceShipID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
        broadcast: true,
        broadcastOptions: {freshAcquire: true},
      },
    );
    if (!spawned || spawned.success !== true) {
      itemStore.removeInventoryItem(serviceShipID, {removeContents: true});
      return null;
    }
    return {
      serviceShipID,
      systemID,
      scene,
      targetShipID: positive(playerEntity.itemID, shipIDFromSession(session)),
      arrivalPoint: origin,
      departurePoint: position,
    };
  }

  _serviceShipEntity(request) {
    return request.serviceShip && request.scene
      ? request.scene.getEntityByID(request.serviceShip.serviceShipID)
      : null;
  }

  async _bringToPlayer(request) {
    const serviceShip = request.serviceShip;
    const scene = serviceShip && serviceShip.scene;
    if (!scene || typeof scene.startSessionlessWarpIngress !== "function") return false;
    const target = scene.getEntityByID(serviceShip.targetShipID);
    const targetPoint = vector(target && target.position) || serviceShip.arrivalPoint;
    if (!targetPoint) return false;
    const warpResult = scene.startSessionlessWarpIngress(
      serviceShip.serviceShipID,
      targetPoint,
      {
        stopDistance: Math.max(this._config.approachRangeMeters * 4, 20000),
        forceImmediateStart: true,
        ingressDurationMs: 2500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!warpResult || warpResult.success !== true) return false;
    return this._waitNear(request, serviceShip.targetShipID, this._config.approachRangeMeters);
  }

  async _waitNear(request, targetID, rangeMeters, timeoutMs = this._config.approachTimeoutMs) {
    const scene = request.serviceShip && request.serviceShip.scene;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const source = scene && scene.getEntityByID(request.serviceShip.serviceShipID);
      const target = scene && scene.getEntityByID(targetID);
      if (!source || !target) return false;
      if (distanceMeters(source.position, target.position) <= rangeMeters) return true;
      if (
        source.mode !== "WARP" && !source.pendingWarp && !source.warpState &&
        !source.sessionlessWarpIngress && typeof scene.followShipEntity === "function"
      ) {
        scene.followShipEntity(request.serviceShipID, targetID, rangeMeters, {
          queueHistorySafeContract: true,
          suppressFreshAcquireReplay: true,
        });
      }
      await delay(this._config.pollIntervalMs);
    }
    return false;
  }

  _hasContainerLootRight(session, targetEntity) {
    const item = itemStore.findItemById(positive(targetEntity && targetEntity.itemID));
    return Boolean(
      item && lootEntitlement.sessionHasSpaceLootRight(
        session,
        lootEntitlement.buildSpaceLootSourceFromItem(item),
      ),
    );
  }

  _isCargoContainerTarget(targetEntity, session) {
    if (!targetEntity || targetEntity.kind !== "container") return false;
    if (targetEntity.nativeNpcWreck === true || targetEntity.cargoContainerAnchorable === true || targetEntity.isAnchored === true) {
      return false;
    }
    const targetID = positive(targetEntity.itemID);
    const item = targetID > 0 ? itemStore.findItemById(targetID) : null;
    const systemID = positive(targetEntity.systemID);
    return Boolean(
      item && itemStore.isCargoContainerInventoryItem(item) &&
      positive(item.flagID) === 0 && positive(item.locationID) === systemID &&
      itemStore.listContainerItems(null, targetID, null).length > 0 &&
      this._hasContainerLootRight(session, targetEntity),
    );
  }

  _eligibleTargets(request, session) {
    const scene = request.serviceShip && request.serviceShip.scene;
    const source = this._serviceShipEntity(request);
    if (!scene || !source || !(scene.dynamicEntities instanceof Map)) return [];
    return [...scene.dynamicEntities.values()]
      .filter((target) => target && target.itemID !== source.itemID)
      .filter((target) =>
        salvagerRuntime.isSalvageableTarget(target) ||
        this._isCargoContainerTarget(target, session),
      )
      .sort((left, right) =>
        distanceMeters(source.position, left.position) - distanceMeters(source.position, right.position));
  }

  _syncChanges(session, changes, shipID) {
    if (!session || !Array.isArray(changes)) return;
    for (const change of changes) {
      const item = change && (change.item || change.previousData);
      if (!item || typeof characterState.emitItemsChangedForSession !== "function") continue;
      characterState.emitItemsChangedForSession(
        session,
        item,
        change.previousData || change.previousState || {},
        {locationContext: ["Ship", shipID, "ShipCargo"]},
      );
    }
  }

  _refreshPlayerCargo(session, characterID, shipID) {
    if (!session || typeof characterState.emitItemsChangedForSession !== "function") return;
    for (const item of itemStore.listContainerItems(characterID, shipID, CARGO_HOLD_FLAG)) {
      characterState.emitItemsChangedForSession(
        session,
        item,
        {},
        {locationContext: ["Ship", shipID, "ShipCargo"]},
      );
    }
  }

  async _collectContainer(request, session, targetEntity) {
    const characterID = request.characterID;
    const playerShipID = request.playerShipID;
    const targetID = positive(targetEntity.itemID);
    const contents = itemStore.listContainerItems(null, targetID, null);
    let moved = 0;
    const changes = [];
    for (const content of contents) {
      const idempotencyKey = `${MOD_ID}:${request.id}:container:${targetID}:${content.itemID}`;
      const result = sameOwner(content, characterID)
        ? invBrokerItemCustody.moveItem({
            item: content,
            ownerID: characterID,
            locationID: playerShipID,
            flagID: CARGO_HOLD_FLAG,
            actor: characterID,
            idempotencyKey,
          })
        : deliveryItemCustody.transferItem({
            item: content,
            ownerID: characterID,
            locationID: playerShipID,
            flagID: CARGO_HOLD_FLAG,
            actor: characterID,
            reason: itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
            idempotencyKey,
          });
      if (!result || result.success !== true) continue;
      moved += quantityOf(content);
      changes.push(...((result.data && result.data.changes) || result.changes || []));
    }
    this._syncChanges(session, changes, playerShipID);
    this._refreshPlayerCargo(session, characterID, playerShipID);
    return {success: moved > 0, moved, changes};
  }

  _salvagerEffectRecord() {
    return getTypeEffectRecords(this._config.salvagerTypeID)
      .find((entry) => String(entry && entry.name) === "salvaging") || null;
  }

  _fittedWorkers(serviceShipID) {
    const fitting = listFittedItemsForLocation(serviceShipID);
    const salvagers = fitting.filter((item) => positive(item.typeID) === this._config.salvagerTypeID);
    const tractors = fitting.filter((item) => positive(item.typeID) === this._config.tractorBeamTypeID);
    const drones = itemStore.listContainerItems(null, serviceShipID, DRONE_BAY_FLAG)
      .filter((item) => positive(item.typeID) === this._config.salvageDroneTypeID);
    return {fitting, salvagers, tractors, drones};
  }

  _surfaceDistance(scene, source, target) {
    if (scene && typeof scene.getCommandTimeEntitySurfaceDistance === "function") {
      const value = scene.getCommandTimeEntitySurfaceDistance(
        source,
        target,
        typeof scene.getCurrentSimTimeMs === "function" ? scene.getCurrentSimTimeMs() : Date.now(),
      );
      if (Number.isFinite(Number(value))) return Number(value);
    }
    return distanceMeters(source && source.position, target && target.position);
  }

  async _useTractor(request, session, targetEntity, workers) {
    const scene = request.serviceShip.scene;
    const source = this._serviceShipEntity(request);
    const tractor = workers.tractors[0];
    if (!source || !tractor || !targetEntity) return false;
    const effectRecord = getTypeEffectRecords(tractor.typeID)
      .find((entry) => String(entry && entry.name) === "tractorBeamCan");
    if (!effectRecord) return false;
    const skillMap = getCachedCharacterSkillMap(request.characterID);
    const activation = tractorBeamRuntime.resolveTractorBeamActivation({
      scene,
      entity: source,
      moduleItem: tractor,
      effectRecord,
      shipItem: itemStore.findItemById(source.itemID),
      skillMap,
      fittedItems: workers.fitting,
      options: {targetID: targetEntity.itemID},
      callbacks: {
        getEntitySurfaceDistance: (left, right) => this._surfaceDistance(scene, left, right),
        hasLootRightForTarget: (_source, target) =>
          salvagerRuntime.isSalvageableTarget(target) || this._hasContainerLootRight(session, target),
      },
    });
    if (!activation || activation.success !== true) return false;
    const state = {
      moduleID: tractor.itemID,
      moduleFlagID: tractor.flagID,
      typeID: tractor.typeID,
      targetID: targetEntity.itemID,
      startedAtMs: Date.now(),
      lastTractorTickAtMs: Date.now(),
      ...activation.data.effectStatePatch,
    };
    if (!(source.activeModuleEffects instanceof Map)) source.activeModuleEffects = new Map();
    source.activeModuleEffects.set(tractor.itemID, state);
    tractorBeamRuntime.broadcastTractorBeamActivationBootstrap(
      scene,
      source,
      state,
      typeof scene.getCurrentSimTimeMs === "function" ? scene.getCurrentSimTimeMs() : Date.now(),
    );
    const holdDistance = Math.max(2500, finite(state.tractorBeamHoldDistanceMeters, 2500));
    const deadline = Date.now() + Math.min(this._config.approachTimeoutMs, 10000);
    let pulled = false;
    while (Date.now() < deadline) {
      const currentSource = scene.getEntityByID(source.itemID);
      const currentTarget = scene.getEntityByID(targetEntity.itemID);
      if (!currentSource || !currentTarget) break;
      if (this._surfaceDistance(scene, currentSource, currentTarget) <= holdDistance) {
        pulled = true;
        break;
      }
      await delay(this._config.pollIntervalMs);
    }
    tractorBeamRuntime.handleTractorBeamDeactivation(scene, state, Date.now());
    source.activeModuleEffects.delete(tractor.itemID);
    return pulled;
  }

  async _salvageTarget(request, session, targetEntity, workers) {
    const scene = request.serviceShip.scene;
    const source = this._serviceShipEntity(request);
    const serviceShipItem = itemStore.findItemById(request.serviceShip.serviceShipID);
    const playerShip = itemStore.findItemById(request.playerShipID);
    const effectRecord = this._salvagerEffectRecord();
    if (!source || !serviceShipItem || !playerShip || !effectRecord || workers.salvagers.length <= 0) {
      return {success: false, stopReason: "module"};
    }
    const skillMap = getCachedCharacterSkillMap(request.characterID);
    const workerItems = [...workers.salvagers, ...workers.drones];
    for (let cycle = 0; cycle < this._config.maxSalvageCyclesPerTarget; cycle += 1) {
      const currentTarget = scene.getEntityByID(targetEntity.itemID);
      if (!currentTarget || !salvagerRuntime.isSalvageableTarget(currentTarget)) {
        return {success: true, salvaged: true};
      }
      let durationMs = 1000;
      for (const worker of workerItems) {
        const current = scene.getEntityByID(targetEntity.itemID);
        if (!current || !salvagerRuntime.isSalvageableTarget(current)) {
          return {success: true, salvaged: true};
        }
        const activation = salvagerRuntime.resolveSalvagerActivation({
          scene,
          entity: source,
          moduleItem: workers.salvagers[0],
          effectRecord,
          shipItem: serviceShipItem,
          skillMap,
          fittedItems: workers.fitting,
          options: {targetID: current.itemID},
          callbacks: {
            getEntitySurfaceDistance: (left, right) => this._surfaceDistance(scene, left, right),
          },
        });
        if (!activation || activation.success !== true) continue;
        durationMs = Math.max(durationMs, finite(activation.data.runtimeAttrs.durationMs, 1000));
        const effectState = {
          moduleID: worker.itemID,
          moduleFlagID: worker.flagID,
          typeID: worker.typeID,
          targetID: current.itemID,
          ...activation.data.effectStatePatch,
        };
        const result = salvagerRuntime.executeSalvagerCycle({
          scene,
          entity: source,
          effectState,
          nowMs: Date.now(),
          callbacks: {
            isEntityLockedTarget: () => true,
            getEntitySurfaceDistance: (left, right) => this._surfaceDistance(scene, left, right),
            resolveCharacterID: () => request.characterID,
            getEntityRuntimeShipItem: () => serviceShipItem,
            getEntityRuntimeFittedItems: () => workers.fitting,
            getEntityRuntimeSkillMap: () => skillMap,
            resolveSession: () => session,
            suppressSalvageMessages: true,
            salvageRewardLocationID: request.playerShipID,
            syncInventoryChangesToSession: (ownerSession, changes) =>
              this._syncChanges(ownerSession, changes, request.playerShipID),
          },
        });
        if (result && result.stopReason === "cargo") {
          return {success: false, stopReason: "cargo", data: result.data};
        }
        if (result && result.data && result.data.salvaged === true) {
          this._refreshPlayerCargo(session, request.characterID, request.playerShipID);
          return {success: true, salvaged: true, data: result.data};
        }
      }
      await delay(Math.min(Math.max(250, durationMs), 5000));
    }
    return {success: false, stopReason: "cycle-limit"};
  }

  async _sendAway(request) {
    const serviceShip = request.serviceShip;
    const scene = serviceShip && serviceShip.scene;
    if (!scene || !serviceShip.departurePoint || typeof scene.startSessionlessWarpIngress !== "function") {
      await this._removeServiceShip(request);
      return;
    }
    const result = scene.startSessionlessWarpIngress(
      serviceShip.serviceShipID,
      serviceShip.departurePoint,
      {
        forceImmediateStart: true,
        ingressDurationMs: 2500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!result || result.success !== true) {
      await this._removeServiceShip(request);
      return;
    }
    if (this._config.departureDelayMs > 0) await delay(this._config.departureDelayMs);
    await delay(2500);
    await this._removeServiceShip(request);
  }

  async _removeServiceShip(request) {
    const serviceShip = request && request.serviceShip;
    if (!serviceShip) return;
    try {
      const result = spaceRuntime.destroyDynamicInventoryEntity(
        serviceShip.systemID,
        serviceShip.serviceShipID,
        {
          sceneDescriptor: serviceShip.scene && serviceShip.scene.sceneDescriptor,
          broadcast: true,
          actor: request.characterID,
        },
      );
      if (!result || result.success !== true) {
        itemStore.removeInventoryItem(serviceShip.serviceShipID, {removeContents: true});
      }
    } catch (error) {
      log.debug(`[${MOD_ID}] service ship cleanup failed: ${error.message}`);
      itemStore.removeInventoryItem(serviceShip.serviceShipID, {removeContents: true});
    }
    request.serviceShip = null;
  }

  async _runRequest(request, session) {
    try {
      request.stage = "spawning";
      request.serviceShip = await this._spawnServiceShip(session, request);
      if (!request.serviceShip) throw new Error("SERVICE_SHIP_SPAWN_FAILED");
      request.serviceShipID = request.serviceShip.serviceShipID;
      request.stage = "warping-in";
      if (!(await this._bringToPlayer(request))) throw new Error("SERVICE_SHIP_ARRIVAL_FAILED");
      request.deliveryStarted = true;
      request.stage = "servicing";
      const deadline = Date.now() + this._config.maxServiceDurationMs;
      while (Date.now() < deadline) {
        const targets = this._eligibleTargets(request, session);
        request.targetsFound = targets.length;
        if (targets.length <= 0) break;
        const target = targets[0];
        request.targetID = positive(target.itemID);
        const workers = this._fittedWorkers(request.serviceShipID);
        const tractorRange = workers.tractors.length > 0 ? 20000 : this._config.approachRangeMeters;
        await this._waitNear(request, target.itemID, tractorRange, this._config.approachTimeoutMs);
        await this._useTractor(request, session, target, workers);
        const currentTarget = request.serviceShip.scene.getEntityByID(target.itemID);
        if (!currentTarget) continue;
        const result = this._isCargoContainerTarget(currentTarget, session)
          ? await this._collectContainer(request, session, currentTarget)
          : await this._salvageTarget(request, session, currentTarget, workers);
        if (result && result.stopReason === "cargo") {
          this._send(session, "The player ship cargo hold is full; SalvageBuddy is returning.");
          break;
        }
        request.targetsProcessed += 1;
        request.targetID = 0;
      }
      request.stage = "departing";
      await this._sendAway(request);
      request.status = "completed";
      request.stage = "complete";
      this._send(session, `Service complete. SalvageBuddy processed ${request.targetsProcessed} target(s).`);
    } catch (error) {
      request.status = "failed";
      request.stage = "failed";
      if (!request.deliveryStarted) await this._refund(request);
      await this._removeServiceShip(request);
      this._send(
        session,
        request.refunded
          ? `Service failed before arrival; ${request.chargedISK.toFixed(0)} ISK was refunded.`
          : `Service ended: ${error.message}`,
      );
      log.warn(`[${MOD_ID}] request=${request.id} failed: ${error.stack || error.message}`);
    } finally {
      const character = this._character(request.characterID);
      character.lastRequestID = request.id;
      character.lastCompletedAtMs = Date.now();
      character.lastStatus = request.status || "failed";
      this._active.delete(request.characterID);
      this._saveState();
    }
  }

  async Handle_RequestSalvage(_args, session) {
    if (this._config.enabled !== true) throw new Error("SALVAGE_BUDDY_DISABLED");
    const characterID = characterIDFromSession(session);
    const shipID = shipIDFromSession(session);
    if (!characterID || !shipID || !isInSpaceSession(session) || !this._activeShip(characterID, session)) {
      throw new Error("SALVAGE_BUDDY_REQUIRES_SPACE");
    }
    if (this._active.has(characterID)) throw new Error("SALVAGE_BUDDY_ACTIVE");
    const character = this._character(characterID);
    if (character.cooldownUntilMs > Date.now()) throw new Error("SALVAGE_BUDDY_COOLDOWN");
    const requestID = this._nextRequestID();
    const charge = await this._charge(characterID, requestID);
    if (!charge.success) throw new Error(charge.errorMsg || "CHARGE_FAILED");
    character.cooldownUntilMs = Date.now() + this._config.cooldownSeconds * 1000;
    character.lastRequestID = requestID;
    character.lastStatus = "accepted";
    const request = {
      id: requestID,
      characterID,
      playerShipID: shipID,
      chargedISK: charge.amount,
      refunded: false,
      deliveryStarted: false,
      status: "accepted",
      stage: "accepted",
      serviceShip: null,
      serviceShipID: 0,
      targetID: 0,
      targetsProcessed: 0,
      targetsFound: 0,
    };
    this._active.set(characterID, request);
    this._saveState();
    this._send(session, `SalvageBuddy accepted the request for ${charge.amount.toFixed(0)} ISK.`);
    void this._runRequest(request, session);
    return this._stateForSession(session);
  }

  stop() {
    return true;
  }
}

module.exports = SalvageBuddyService;
