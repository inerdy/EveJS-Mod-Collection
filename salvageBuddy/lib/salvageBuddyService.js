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
const worldData = require(serverPath("space", "worldData"));
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
const {unwrapMarshalValue} = require(serverPath(
  "services", "_shared", "serviceHelpers",
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
const droneRuntime = require(serverPath("services", "drone", "droneRuntime"));
const droneDogma = require(serverPath("services", "drone", "droneDogma"));
const log = require(serverPath("utils", "logger"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {createStateStore, normalizeCharacter} = require(path.join(__dirname, "state"));

const MOD_ID = "salvageBuddy";
const SERVICE_NAME = MOD_ID;
const AU_METERS = 149597870700;
const CARGO_HOLD_FLAG = itemStore.ITEM_FLAGS.CARGO_HOLD;
const DRONE_BAY_FLAG = itemStore.ITEM_FLAGS.DRONE_BAY;
const MEDIUM_SLOT_FLAGS = [19, 20, 21, 22, 23, 24, 25, 26];
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

function stationIDFromSession(session) {
  return positive(session && (session.stationid || session.stationID), 0);
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

  _stationShips(characterID, session) {
    const stationID = stationIDFromSession(session);
    if (!stationID) return [];
    const station = worldData.getStationByID(stationID);
    const stationName = String(station && (
      station.stationName || station.itemName || station.name || station.locationName
    ) || "Station hangar");
    const activeShipID = shipIDFromSession(session) ||
      positive(itemStore.getActiveShipItem(characterID) && itemStore.getActiveShipItem(characterID).itemID);
    return itemStore.getCharacterHangarShipItems(characterID, stationID)
      .filter((ship) => positive(ship.itemID) !== activeShipID)
      .filter((ship) => worldData.getStationByID(positive(ship.locationID)))
      .map((ship) => {
        const metadata = itemStore.getItemMetadata(ship.typeID, ship.itemName);
        let cargoVolume = 0;
        let cargoQuantity = 0;
        try {
          for (const item of itemStore.listContainerItems(characterID, ship.itemID, CARGO_HOLD_FLAG)) {
            const quantity = quantityOf(item);
            cargoQuantity += quantity;
            cargoVolume += Math.max(0, finite(itemStore.getInventoryItemUnitVolume(item), 0)) * quantity;
          }
        } catch (_) {
          cargoVolume = 0;
          cargoQuantity = 0;
        }
        return {
          shipID: positive(ship.itemID),
          name: String(ship.itemName || metadata && metadata.name || "Ship"),
          typeID: positive(ship.typeID),
          typeName: String(metadata && metadata.name || "Ship"),
          stationName,
          cargo: {
            quantity: cargoQuantity,
            volume: Math.round(cargoVolume * 1000) / 1000,
            capacity: Math.max(0, Number(ship.capacity || metadata && metadata.capacity) || 0),
          },
        };
      });
  }

  _selectedCollectionShip(characterID) {
    const character = this._character(characterID);
    const shipID = positive(character.collectionShipID);
    if (!shipID) return null;
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    const stationID = positive(ship && ship.locationID);
    const activeRequest = this._active.get(characterID);
    const deployed = activeRequest && activeRequest.collectionShip &&
      positive(activeRequest.collectionShip.shipID) === shipID
      ? activeRequest.collectionShip
      : null;
    if (!ship || (!deployed && (positive(ship.flagID) !== itemStore.ITEM_FLAGS.HANGAR ||
        !worldData.getStationByID(stationID)))) {
      return null;
    }
    const metadata = itemStore.getItemMetadata(ship.typeID, ship.itemName);
    return {
      shipID,
      name: String(ship.itemName || metadata && metadata.name || "Ship"),
      stationID: deployed ? positive(deployed.stationID) : stationID,
    };
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
    const collectionShip = request && request.collectionShip || null;
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
      canSendAway: Boolean(request),
      isDocked: stationIDFromSession(session) > 0,
      collectionShip: this._selectedCollectionShip(characterID),
      availableCollectionShips: this._stationShips(characterID, session),
      collectionShipInSpace: Boolean(collectionShip && collectionShip.inSpace),
      collectionShipReturning: Boolean(collectionShip && collectionShip.returning),
      collectionShipRecallRequested: Boolean(request && request.collectionRecallRequested),
      canRecallCollectionShip: Boolean(collectionShip && collectionShip.inSpace &&
        !collectionShip.returning && !(request && request.collectionRecallRequested)),
      stage: request ? request.stage : "idle",
      targetsProcessed: request ? request.targetsProcessed : 0,
      targetsFound: request ? request.targetsFound : 0,
      targetsRemaining: request ? request.targetsRemaining : 0,
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

  Handle_SetCollectionShip(args, session) {
    const characterID = characterIDFromSession(session);
    if (!characterID) throw new Error("SALVAGE_BUDDY_CHARACTER_REQUIRED");
    const request = unwrapMarshalValue(Array.isArray(args) ? args[0] : args) || {};
    const shipID = positive(request.shipID);
    const character = this._character(characterID);
    if (this._active.has(characterID)) {
      throw new Error("SALVAGE_BUDDY_ACTIVE");
    }
    if (!shipID) {
      character.collectionShipID = 0;
      this._saveState();
      return this._stateForSession(session);
    }
    const stationID = stationIDFromSession(session);
    if (!stationID) throw new Error("SALVAGE_BUDDY_MUST_BE_DOCKED");
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    if (!ship || positive(ship.locationID) !== stationID ||
        positive(ship.flagID) !== itemStore.ITEM_FLAGS.HANGAR ||
        !worldData.getStationByID(stationID)) {
      throw new Error("SALVAGE_BUDDY_COLLECTION_SHIP_NOT_IN_STATION_HANGAR");
    }
    const activeShipID = shipIDFromSession(session) ||
      positive(itemStore.getActiveShipItem(characterID) && itemStore.getActiveShipItem(characterID).itemID);
    if (shipID === activeShipID) {
      throw new Error("SALVAGE_BUDDY_ACTIVE_SHIP_CANNOT_BE_COLLECTION_SHIP");
    }
    character.collectionShipID = shipID;
    this._saveState();
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
    this._validateType(config.afterburnerTypeID, "afterburner");
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
    grant(config.afterburnerTypeID, 1, MEDIUM_SLOT_FLAGS[0], "afterburner", online);
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

  async _spawnCollectionShip(session, request) {
    const character = this._character(request.characterID);
    const shipID = positive(character.collectionShipID);
    if (!shipID || shipID === request.playerShipID) return null;
    const ship = itemStore.findCharacterShipItem(request.characterID, shipID);
    const stationID = positive(ship && ship.locationID);
    if (!ship || positive(ship.flagID) !== itemStore.ITEM_FLAGS.HANGAR ||
        !worldData.getStationByID(stationID)) {
      return null;
    }
    const systemID = systemIDFromSession(session);
    const scene = this._sceneForSession(session);
    const playerEntity = scene && scene.getShipEntityForSession
      ? scene.getShipEntityForSession(session)
      : null;
    if (!systemID || !scene || !playerEntity) return null;
    const origin = vector(playerEntity.position) || {x: 0, y: 0, z: 0};
    const direction = vector(playerEntity.direction) || {x: 1, y: 0, z: 0};
    const directionLength = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const farPoint = {
      x: origin.x + direction.x / directionLength * this._config.spawnDistanceAU * AU_METERS,
      y: origin.y + direction.y / directionLength * this._config.spawnDistanceAU * AU_METERS,
      z: origin.z + direction.z / directionLength * this._config.spawnDistanceAU * AU_METERS,
    };
    const moveResult = itemStore.moveShipToSpace(shipID, systemID, {
      systemID,
      position: farPoint,
      targetPoint: farPoint,
      velocity: {x: 0, y: 0, z: 0},
      direction,
      speedFraction: 0,
      mode: "STOP",
      targetEntityID: null,
      followRange: 0,
      orbitDistance: 0,
    });
    if (!moveResult || moveResult.success !== true) return null;
    let spawned;
    try {
      spawned = spaceRuntime.spawnDynamicInventoryEntity(
        scene.sceneDescriptor || systemID,
        shipID,
        {
          sceneDescriptor: scene.sceneDescriptor || undefined,
          broadcast: true,
          broadcastOptions: {freshAcquire: true},
        },
      );
    } catch (error) {
      itemStore.dockShipToLocation(shipID, stationID);
      log.warn(`[${MOD_ID}] collection ship spawn failed ship=${shipID}: ${error.message}`);
      return null;
    }
    if (!spawned || spawned.success !== true || !spawned.data || !spawned.data.entity) {
      itemStore.dockShipToLocation(shipID, stationID);
      return null;
    }
    const collectionShip = {
      shipID,
      stationID,
      systemID,
      scene,
      departurePoint: farPoint,
      arrivalPoint: origin,
      inSpace: true,
      returning: false,
      initialCargoItemIDs: new Set(
        itemStore.listContainerItems(request.characterID, shipID, CARGO_HOLD_FLAG)
          .map((item) => positive(item.itemID)),
      ),
    };
    request.collectionShip = collectionShip;
    if (typeof scene.startSessionlessWarpIngress !== "function") {
      await this._returnCollectionShip(request, session, {immediate: true, notify: false});
      return null;
    }
    const warpResult = scene.startSessionlessWarpIngress(
      shipID,
      origin,
      {
        stopDistance: 10000,
        forceImmediateStart: true,
        ingressDurationMs: 2500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!warpResult || warpResult.success !== true) {
      await this._returnCollectionShip(request, session, {immediate: true, notify: false});
      return null;
    }
    const deadline = Date.now() + this._config.approachTimeoutMs;
    while (Date.now() < deadline) {
      const entity = scene.getEntityByID(shipID);
      const player = scene.getEntityByID(request.playerShipID);
      if (!entity || !player) break;
      if (!this._isEntityWarping(entity) && distanceMeters(entity.position, player.position) <= 11000) {
        return collectionShip;
      }
      await delay(this._config.pollIntervalMs);
    }
    await this._returnCollectionShip(request, session, {immediate: true, notify: false});
    return null;
  }

  async _returnCollectionShip(request, session = null, options = {}) {
    const collectionShip = request && request.collectionShip;
    if (!collectionShip || collectionShip.returned === true) return true;
    if (collectionShip.returnPromise) return collectionShip.returnPromise;
    if (collectionShip.returning === true) return true;
    collectionShip.returning = true;
    const returnPromise = this._performCollectionShipReturn(
      request,
      session,
      options,
      collectionShip,
    );
    collectionShip.returnPromise = returnPromise;
    try {
      return await returnPromise;
    } catch (error) {
      collectionShip.returning = false;
      log.warn(`[${MOD_ID}] collection ship return failed ship=${collectionShip.shipID}: ${error.message}`);
      return false;
    } finally {
      if (collectionShip.returnPromise === returnPromise) collectionShip.returnPromise = null;
    }
  }

  async _performCollectionShipReturn(request, session, options, collectionShip) {
    if (options.flushCargo !== false) {
      await this._transferSalvageToDestination(request, session);
    }
    const shipID = positive(collectionShip.shipID);
    const stationID = positive(collectionShip.stationID);
    const scene = collectionShip.scene || this._serviceShipScene(request);
    const cargoChanges = [];
    const excluded = collectionShip.initialCargoItemIDs instanceof Set
      ? collectionShip.initialCargoItemIDs
      : new Set();
    for (const item of itemStore.listContainerItems(request.characterID, shipID, CARGO_HOLD_FLAG)) {
      if (excluded.has(positive(item.itemID))) continue;
      const result = invBrokerItemCustody.moveItem({
        item,
        ownerID: request.characterID,
        locationID: stationID,
        flagID: itemStore.ITEM_FLAGS.HANGAR,
        actor: request.characterID,
        idempotencyKey: `${MOD_ID}:${request.id}:station-delivery:${shipID}:${item.itemID}`,
      });
      if (result && result.success === true) {
        cargoChanges.push(...((result.data && result.data.changes) || result.changes || []));
      }
    }
    this._syncChanges(session, cargoChanges, stationID, ["Station", stationID, "Hangar"]);

    if (!options.immediate && scene && scene.getEntityByID(shipID) &&
        typeof scene.startSessionlessWarpIngress === "function") {
      const warpResult = scene.startSessionlessWarpIngress(
        shipID,
        collectionShip.departurePoint,
        {
          forceImmediateStart: true,
          ingressDurationMs: 2500,
          visibilitySuppressMs: 250,
          broadcastWarpStartToVisibleSessions: true,
        },
      );
      if (warpResult && warpResult.success === true) {
        if (this._config.departureDelayMs > 0) await delay(this._config.departureDelayMs);
        await delay(2500);
      }
    }
    let removed = true;
    if (scene && scene.getEntityByID(shipID) && typeof scene.removeDynamicEntity === "function") {
      const removeResult = scene.removeDynamicEntity(shipID, {
        broadcast: true,
        persistSpaceState: false,
        allowSessionOwned: true,
      });
      removed = Boolean(removeResult && removeResult.success === true);
    }
    if (!removed && typeof spaceRuntime.removeDynamicEntity === "function") {
      const removeResult = spaceRuntime.removeDynamicEntity(
        collectionShip.systemID,
        shipID,
        {sceneDescriptor: scene && scene.sceneDescriptor, broadcast: true, persistSpaceState: false},
      );
      removed = Boolean(removeResult && removeResult.success === true);
    }
    if (!removed) {
      collectionShip.returning = false;
      log.warn(`[${MOD_ID}] collection ship scene removal failed ship=${shipID}`);
      return false;
    }
    const dockResult = itemStore.dockShipToLocation(shipID, stationID);
    if (!dockResult || dockResult.success !== true) {
      collectionShip.returning = false;
      log.warn(`[${MOD_ID}] could not dock collection ship=${shipID} at station=${stationID}`);
      return false;
    }
    collectionShip.inSpace = false;
    collectionShip.returned = true;
    request.collectionShip = null;
    if (options.notify !== false) {
      this._send(session, `Collection ship returned to station ${stationID}; recovered loot was deposited in the station hangar.`);
    }
    return true;
  }

  _serviceShipEntity(request) {
    if (request && request.droneOnly === true) {
      const scene = this._serviceShipScene(request);
      return scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(request.playerShipID)
        : null;
    }
    const scene = this._serviceShipScene(request);
    return request.serviceShip && scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(request.serviceShip.serviceShipID)
      : null;
  }

  _serviceShipScene(request) {
    if (request && request.droneOnly === true) {
      return request.droneScene || null;
    }
    const serviceShip = request && request.serviceShip;
    if (
      serviceShip &&
      serviceShip.scene &&
      typeof serviceShip.scene.getEntityByID === "function" &&
      serviceShip.scene.getEntityByID(serviceShip.serviceShipID)
    ) {
      return serviceShip.scene;
    }
    if (
      serviceShip &&
      typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
    ) {
      const scene = spaceRuntime.findSceneContainingDynamicEntity(serviceShip.serviceShipID);
      if (scene) serviceShip.scene = scene;
      return scene || null;
    }
    return null;
  }

  _isEntityWarping(entity) {
    return Boolean(
      entity && (
        entity.mode === "WARP" ||
        entity.pendingWarp ||
        entity.warpState ||
        entity.sessionlessWarpIngress
      ),
    );
  }

  _approachTimeoutMs(source, target, rangeMeters) {
    const configured = this._config.approachTimeoutMs;
    const remainingDistance = Math.max(
      0,
      distanceMeters(source && source.position, target && target.position) - rangeMeters,
    );
    const maxVelocity = Math.max(0, finite(source && source.maxVelocity, 0));
    if (remainingDistance <= 0 || maxVelocity <= 0) return configured;

    // Leave room for acceleration, turning, and a slow final approach. This is
    // especially important for the Noctis: the ship lands about 20 km out and
    // only then begins its ordinary subwarp approach.
    const estimated = Math.ceil((remainingDistance / maxVelocity) * 1000 * 1.75 + 10000);
    return Math.min(300000, Math.max(configured, estimated));
  }

  async _bringToPlayer(request) {
    const serviceShip = request.serviceShip;
    const scene = this._serviceShipScene(request);
    if (!scene || typeof scene.startSessionlessWarpIngress !== "function") return false;
    const target = scene.getEntityByID(serviceShip.targetShipID);
    const targetPoint = vector(target && target.position) || serviceShip.arrivalPoint;
    if (!targetPoint) return false;
    const warpStopDistance = Math.max(
      this._config.approachRangeMeters * 2,
      this._config.approachRangeMeters + 5000,
    );
    const warpResult = scene.startSessionlessWarpIngress(
      serviceShip.serviceShipID,
      targetPoint,
      {
        // Keep the final approach visible, but do not strand a slow Noctis
        // twenty kilometres away after it exits warp.
        stopDistance: warpStopDistance,
        forceImmediateStart: true,
        ingressDurationMs: 2500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!warpResult || warpResult.success !== true) return false;
    // The client presents rounded/edge distances, while the scene check uses
    // entity-center distance. Allow a small buffer so a ship shown at roughly
    // 5 km is not held in the warping-in stage at 5,022 m.
    return this._waitNear(
      request,
      serviceShip.targetShipID,
      this._config.approachRangeMeters + 500,
    );
  }

  async _waitNear(request, targetID, rangeMeters, timeoutMs = this._config.approachTimeoutMs) {
    const scene = this._serviceShipScene(request);
    let deadline = Date.now() + timeoutMs;
    let followStarted = false;
    while (Date.now() < deadline) {
      if (request.cancelRequested === true) return false;
      const source = scene && scene.getEntityByID(request.serviceShip.serviceShipID);
      const target = scene && scene.getEntityByID(targetID);
      if (!source || !target) return false;
      if (distanceMeters(source.position, target.position) <= rangeMeters) return true;
      if (!this._isEntityWarping(source)) {
        if (!followStarted && typeof scene.followShipEntity === "function") {
          const followResult = scene.followShipEntity(
            request.serviceShipID,
            targetID,
            rangeMeters,
            {
              queueHistorySafeContract: true,
              suppressFreshAcquireReplay: true,
            },
          );
          if (followResult !== false) {
            followStarted = true;
          } else if (typeof scene.startSessionlessWarpIngress === "function") {
            const warpResult = scene.startSessionlessWarpIngress(
              request.serviceShipID,
              target.position,
              {
                stopDistance: Math.max(rangeMeters, this._config.approachRangeMeters),
                forceImmediateStart: true,
                ingressDurationMs: 1500,
                visibilitySuppressMs: 250,
                broadcastWarpStartToVisibleSessions: true,
              },
            );
            if (!warpResult || warpResult.success !== true) return false;
            followStarted = true;
          } else {
            return false;
          }
          deadline = Math.max(deadline, Date.now() + this._approachTimeoutMs(source, target, rangeMeters));
        }
      }
      await delay(this._config.pollIntervalMs);
    }
    return false;
  }

  async _positionForTractor(request, targetID, rangeMeters, timeoutMs = this._config.approachTimeoutMs) {
    const scene = this._serviceShipScene(request);
    const source = scene && scene.getEntityByID(request.serviceShip.serviceShipID);
    const target = scene && scene.getEntityByID(targetID);
    if (!scene || !source || !target) return false;
    if (this._surfaceDistance(scene, source, target) <= rangeMeters) return true;
    if (typeof scene.startSessionlessWarpIngress !== "function") return false;

    const warpResult = scene.startSessionlessWarpIngress(
      request.serviceShip.serviceShipID,
      target.position,
      {
        // Tractor beams work at range. Warp to just inside that envelope so
        // the slow Noctis never has to fly all the way to each wreck.
        stopDistance: Math.max(1000, rangeMeters - 1000),
        forceImmediateStart: true,
        ingressDurationMs: 1500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!warpResult || warpResult.success !== true) return false;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (request.cancelRequested === true) return false;
      const currentSource = scene.getEntityByID(request.serviceShip.serviceShipID);
      const currentTarget = scene.getEntityByID(targetID);
      if (!currentSource || !currentTarget) return false;
      if (this._surfaceDistance(scene, currentSource, currentTarget) <= rangeMeters) {
        return true;
      }
      if (!this._isEntityWarping(currentSource)) return false;
      await delay(this._config.pollIntervalMs);
    }
    return false;
  }

  _activateAfterburner(request) {
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    if (!scene || !source || typeof scene.activatePropulsionModule !== "function") return false;
    const afterburner = listFittedItemsForLocation(source.itemID)
      .find((item) => positive(item.typeID) === this._config.afterburnerTypeID);
    if (!afterburner) return false;
    const serviceSession = {
      characterID: request.characterID,
      charid: request.characterID,
      _space: {
        shipID: source.itemID,
        systemID: source.systemID,
        initialStateSent: false,
      },
    };
    const result = scene.activatePropulsionModule(
      serviceSession,
      afterburner,
      "moduleBonusAfterburner",
      {repeat: null},
    );
    if (!result || result.success !== true) {
      log.debug(`[${MOD_ID}] afterburner activation failed: ${result && result.errorMsg || "unknown"}`);
      return false;
    }
    return true;
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

  _collectionShipHasCapacity(collectionShipID, incomingItem) {
    const ship = itemStore.findShipItemById(collectionShipID);
    if (!ship) return false;
    const metadata = itemStore.getItemMetadata(ship.typeID, ship.itemName);
    const capacity = Math.max(0, Number(ship.capacity || metadata && metadata.capacity) || 0);
    if (capacity <= 0) return true;
    const used = itemStore.listContainerItems(null, collectionShipID, CARGO_HOLD_FLAG)
      .reduce((sum, item) => sum + itemStore.getInventoryItemUnitVolume(item) * quantityOf(item), 0);
    const incoming = itemStore.getInventoryItemUnitVolume(incomingItem) * quantityOf(incomingItem);
    return used + incoming <= capacity + 0.000001;
  }

  _moveLootItem(request, session, item, destinationID, destinationFlagID, key) {
    if (!item || positive(destinationID) <= 0) return {success: false};
    const result = sameOwner(item, request.characterID)
      ? invBrokerItemCustody.moveItem({
          item,
          ownerID: request.characterID,
          locationID: destinationID,
          flagID: destinationFlagID,
          actor: request.characterID,
          idempotencyKey: key,
        })
      : deliveryItemCustody.transferItem({
          item,
          ownerID: request.characterID,
          locationID: destinationID,
          flagID: destinationFlagID,
          actor: request.characterID,
          reason: itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
          idempotencyKey: key,
        });
    if (!result || result.success !== true) return result || {success: false};
    const changes = (result.data && result.data.changes) || result.changes || [];
    const isShipCargo = destinationFlagID === CARGO_HOLD_FLAG;
    this._syncChanges(
      session,
      changes,
      destinationID,
      isShipCargo
        ? ["Ship", destinationID, "ShipCargo"]
        : ["Station", destinationID, "Hangar"],
    );
    if (isShipCargo) this._refreshPlayerCargo(session, request.characterID, destinationID);
    return result;
  }

  _deliverLootItem(request, session, item, key) {
    const collectionShip = request.collectionShip && !request.collectionShip.returning
      ? request.collectionShip
      : null;
    if (collectionShip && this._collectionShipHasCapacity(collectionShip.shipID, item)) {
      const result = this._moveLootItem(
        request, session, item, collectionShip.shipID, CARGO_HOLD_FLAG, `${key}:collector`,
      );
      if (result && result.success === true) return {success: true, destination: "collector"};
    }
    if (collectionShip) {
      if (!request.collectionHoldFullNotified) {
        this._send(session, "The collection ship cargo hold is full; additional loot is going to your active ship.");
        request.collectionHoldFullNotified = true;
      }
    }
    const playerResult = this._moveLootItem(
      request, session, item, request.playerShipID, CARGO_HOLD_FLAG, `${key}:player`,
    );
    if (playerResult && playerResult.success === true) return {success: true, destination: "player"};
    if (collectionShip && positive(collectionShip.stationID) > 0) {
      const stationResult = this._moveLootItem(
        request, session, item, collectionShip.stationID, itemStore.ITEM_FLAGS.HANGAR,
        `${key}:station-overflow`,
      );
      if (stationResult && stationResult.success === true) {
        if (!request.collectionOverflowNotified) {
          this._send(session, "Loot that fit in neither ship was delivered directly to the collection ship's station hangar.");
          request.collectionOverflowNotified = true;
        }
        return {success: true, destination: "station"};
      }
    }
    return {success: false, stopReason: "cargo"};
  }

  async _transferSalvageToDestination(request, session = null) {
    // Drone salvage remains in each temporary drone's cargo until SalvageBuddy
    // unloads it. Route it at each completed target and again during recall.
    if (!request || positive(request.playerShipID) <= 0) return 0;
    const sourceIDs = [
      positive(request.serviceShipID),
      ...(request.deployedDroneIDs || []).map((itemID) => positive(itemID)),
    ].filter(Boolean);
    let moved = 0;
    for (const sourceID of [...new Set(sourceIDs)]) {
      const contents = itemStore.listContainerItems(null, sourceID, CARGO_HOLD_FLAG);
      for (const content of contents) {
        const idempotencyKey = `${MOD_ID}:${request.id}:service-cargo:${sourceID}:${content.itemID}`;
        const result = this._deliverLootItem(request, session, content, idempotencyKey);
        if (result.success) moved += quantityOf(content);
      }
    }
    return moved;
  }

  async _transferSalvageToPlayer(request, session = null) {
    return this._transferSalvageToDestination(request, session);
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
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    if (!scene || !source) return [];
    const entities = typeof scene.getAllVisibleEntities === "function"
      ? scene.getAllVisibleEntities()
      : [
        ...(Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
        ...(scene.dynamicEntities instanceof Map ? [...scene.dynamicEntities.values()] : []),
      ];
    return [...new Map(entities.filter(Boolean).map((target) => [String(target.itemID), target])).values()]
      .filter((target) => target && target.itemID !== source.itemID)
      .filter((target) =>
        salvagerRuntime.isSalvageableTarget(target) ||
        this._isCargoContainerTarget(target, session),
      )
      .sort((left, right) =>
        distanceMeters(source.position, left.position) - distanceMeters(source.position, right.position));
  }

  _recordTargetProgress(request, targets) {
    if (!(request.discoveredTargetIDs instanceof Set)) {
      request.discoveredTargetIDs = new Set(
        Array.isArray(request.discoveredTargetIDs)
          ? request.discoveredTargetIDs.map((itemID) => positive(itemID)).filter(Boolean)
          : [],
      );
    }
    for (const target of targets || []) {
      const targetID = positive(target && target.itemID);
      if (targetID > 0) request.discoveredTargetIDs.add(targetID);
    }
    request.targetsFound = request.discoveredTargetIDs.size;
    request.targetsRemaining = Array.isArray(targets) ? targets.length : 0;
  }

  _syncChanges(session, changes, locationID, locationContext = null) {
    if (!session || !Array.isArray(changes)) return;
    for (const change of changes) {
      const item = change && (change.item || change.previousData);
      if (!item || typeof characterState.emitItemsChangedForSession !== "function") continue;
      characterState.emitItemsChangedForSession(
        session,
        item,
        change.previousData || change.previousState || {},
        {locationContext: locationContext || ["Ship", locationID, "ShipCargo"]},
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
    const targetID = positive(targetEntity.itemID);
    const contents = itemStore.listContainerItems(null, targetID, null);
    let moved = 0;
    for (const content of contents) {
      const idempotencyKey = `${MOD_ID}:${request.id}:container:${targetID}:${content.itemID}`;
      const result = this._deliverLootItem(request, session, content, idempotencyKey);
      if (result.success) moved += quantityOf(content);
    }
    return {success: moved > 0, moved};
  }

  _salvagerEffectRecord() {
    return getTypeEffectRecords(this._config.salvagerTypeID)
      .find((entry) => String(entry && entry.name) === "salvaging") || null;
  }

  _fittedWorkers(serviceShipID, request = null) {
    const fitting = listFittedItemsForLocation(serviceShipID);
    const salvagers = fitting.filter((item) => positive(item.typeID) === this._config.salvagerTypeID);
    const tractors = fitting.filter((item) => positive(item.typeID) === this._config.tractorBeamTypeID);
    const deployedDrones = request && Array.isArray(request.deployedDrones)
      ? request.deployedDrones
      : [];
    const drones = deployedDrones.length > 0
      ? deployedDrones
      : itemStore.listContainerItems(null, serviceShipID, DRONE_BAY_FLAG)
        .filter((item) => positive(item.typeID) === this._config.salvageDroneTypeID);
    return {fitting, salvagers, tractors, drones};
  }

  _persistDroneEntity(droneEntity) {
    if (!droneEntity || positive(droneEntity.itemID) <= 0) return false;
    const spaceState = {
      systemID: positive(droneEntity.systemID),
      position: vector(droneEntity.position),
      velocity: vector(droneEntity.velocity) || {x: 0, y: 0, z: 0},
      direction: vector(droneEntity.direction) || {x: 1, y: 0, z: 0},
      targetPoint: vector(droneEntity.targetPoint) || vector(droneEntity.position),
      speedFraction: finite(droneEntity.speedFraction),
      mode: droneEntity.mode || "STOP",
      targetEntityID: positive(droneEntity.targetEntityID) || null,
      followRange: finite(droneEntity.followRange),
      orbitDistance: finite(droneEntity.orbitDistance),
      orbitNormal: vector(droneEntity.orbitNormal),
      orbitSign: finite(droneEntity.orbitSign, 1),
    };
    const result = itemStore.updateInventoryItem(droneEntity.itemID, (currentItem) => ({
      ...currentItem,
      locationID: positive(droneEntity.systemID) || currentItem.locationID,
      flagID: 0,
      singleton: 1,
      quantity: null,
      stacksize: 1,
      launcherID: positive(droneEntity.launcherID || droneEntity.controllerID) || null,
      spaceState,
    }));
    return Boolean(result && result.success === true);
  }

  _emitDroneState(droneEntity) {
    if (typeof droneRuntime.emitDroneStateChange === "function") {
      droneRuntime.emitDroneStateChange(droneEntity);
    }
  }

  _clearDroneClientState(droneEntity, session) {
    if (
      !droneEntity ||
      !session ||
      typeof session.sendNotification !== "function" ||
      typeof droneRuntime.buildDroneStateNotificationTuple !== "function"
    ) {
      return false;
    }
    try {
      const payload = droneRuntime.buildDroneStateNotificationTuple(droneEntity, {
        ownerID: null,
        controllerID: null,
        activityState: null,
        typeID: null,
        controllerOwnerID: null,
        targetID: null,
      });
      session.sendNotification("OnDroneStateChange", "charid", payload);
      return true;
    } catch (error) {
      log.debug(`[${MOD_ID}] drone state cleanup notification failed: ${error.message}`);
      return false;
    }
  }

  async _deployServiceDrones(request) {
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    if (!scene || !source) return [];
    const bayItems = itemStore.listContainerItems(null, source.itemID, DRONE_BAY_FLAG)
      .filter((item) => positive(item.typeID) === this._config.salvageDroneTypeID)
      .slice(0, this._config.salvageDroneCount);
    const deployed = [];

    for (let index = 0; index < bayItems.length; index += 1) {
      const item = itemStore.findItemById(bayItems[index].itemID);
      if (!item) continue;
      const moveResult = itemCustody.transfer({
        items: {itemID: item.itemID, quantity: 1},
        from: itemCustody.custodyRef.shipBay(
          positive(item.ownerID) || request.characterID,
          source.itemID,
          DRONE_BAY_FLAG,
        ),
        to: itemCustody.custodyRef.inSpace(
          positive(item.ownerID) || request.characterID,
          source.systemID,
        ),
        reason: itemCustody.CUSTODY_REASON.DRONE_LAUNCH,
        actor: request.characterID,
        idempotencyKey: `${MOD_ID}:${request.id}:drone-launch:${item.itemID}`,
      });
      if (!moveResult || moveResult.success !== true) continue;

      const sourceDirection = vector(source.direction) || {x: 1, y: 0, z: 0};
      const launchPosition = {
        x: finite(source.position && source.position.x) + sourceDirection.x * (100 + index * 30),
        y: finite(source.position && source.position.y) + sourceDirection.y * (100 + index * 30),
        z: finite(source.position && source.position.z) + sourceDirection.z * (100 + index * 30),
      };
      const updateResult = itemStore.updateInventoryItem(item.itemID, (currentItem) => ({
        ...currentItem,
        locationID: source.systemID,
        flagID: 0,
        singleton: 1,
        quantity: null,
        stacksize: 1,
        launcherID: source.itemID,
        spaceState: {
          systemID: source.systemID,
          position: launchPosition,
          velocity: {x: 0, y: 0, z: 0},
          direction: sourceDirection,
          targetPoint: launchPosition,
          speedFraction: 0,
          mode: "STOP",
          targetEntityID: null,
          followRange: 0,
          orbitDistance: 0,
          orbitNormal: {x: 0, y: 0, z: 1},
          orbitSign: 1,
        },
      }));
      if (!updateResult || updateResult.success !== true) {
        itemStore.removeInventoryItem(item.itemID, {removeContents: true});
        continue;
      }

      const spawned = spaceRuntime.spawnDynamicInventoryEntity(
        scene.sceneDescriptor || source.systemID,
        item.itemID,
        {
          sceneDescriptor: scene.sceneDescriptor || undefined,
          broadcast: true,
          broadcastOptions: {freshAcquire: true},
        },
      );
      if (!spawned || spawned.success !== true || !spawned.data || !spawned.data.entity) {
        itemStore.removeInventoryItem(item.itemID, {removeContents: true});
        continue;
      }
      const drone = droneRuntime.hydrateDroneEntityFromItem(
        spawned.data.entity,
        itemStore.findItemById(item.itemID),
      );
      drone.launcherID = source.itemID;
      drone.controllerID = source.itemID;
      drone.controllerOwnerID = request.characterID;
      drone.ownerID = request.characterID;
      drone.droneStateVisible = true;
      drone.activityState = droneRuntime.STATE_IDLE;
      drone.targetID = null;
      drone.droneCommand = null;
      drone.droneCombat = null;
      drone.droneMining = null;
      drone.droneSalvage = null;
      drone.droneRepair = null;
      drone.droneHomeOrbitDistance = droneRuntime.resolveDroneOrbitDistance(drone);
      scene.orbitShipEntity(
        drone.itemID,
        source.itemID,
        drone.droneHomeOrbitDistance,
        {broadcast: false, speedFraction: 0.5},
      );
      this._persistDroneEntity(drone);
      this._emitDroneState(drone);
      deployed.push(drone);
    }

    request.deployedDrones = deployed;
    request.deployedDroneIDs = deployed.map((drone) => positive(drone.itemID));
    return deployed;
  }

  async _spawnPlayerServiceDrones(request, session) {
    const scene = this._serviceShipScene(request);
    const source = scene && scene.getShipEntityForSession
      ? scene.getShipEntityForSession(session)
      : this._serviceShipEntity(request);
    if (!scene || !source) return [];
    const deployed = [];
    const sourceDirection = vector(source.direction) || {x: 1, y: 0, z: 0};
    const sourcePosition = vector(source.position) || {x: 0, y: 0, z: 0};

    for (let index = 0; index < this._config.salvageDroneCount; index += 1) {
      const distance = Math.max(100, finite(source.radius, 50) + 100 + index * 30);
      const position = {
        x: sourcePosition.x + sourceDirection.x * distance,
        y: sourcePosition.y + sourceDirection.y * distance,
        z: sourcePosition.z + sourceDirection.z * distance,
      };
      const created = itemStore.createSpaceItemForCharacter(
        request.characterID,
        request.systemID,
        this._config.salvageDroneTypeID,
        {
          position,
          mode: "STOP",
          customInfo: `${MOD_ID}:${request.id}:player-drone`,
          launcherID: source.itemID,
          expiresAtMs: Date.now() + this._config.serviceLifetimeMs,
          transient: true,
        },
      );
      if (!created || created.success !== true || !created.data) continue;
      const droneID = positive(created.data.itemID);
      const spawned = spaceRuntime.spawnDynamicInventoryEntity(
        scene.sceneDescriptor || request.systemID,
        droneID,
        {
          sceneDescriptor: scene.sceneDescriptor || undefined,
          broadcast: true,
          broadcastOptions: {freshAcquire: true},
        },
      );
      if (!spawned || spawned.success !== true || !spawned.data || !spawned.data.entity) {
        itemStore.removeInventoryItem(droneID, {removeContents: true});
        continue;
      }
      const drone = droneRuntime.hydrateDroneEntityFromItem(
        spawned.data.entity,
        itemStore.findItemById(droneID),
      );
      drone.launcherID = source.itemID;
      drone.controllerID = source.itemID;
      drone.controllerOwnerID = request.characterID;
      drone.ownerID = request.characterID;
      drone.droneStateVisible = true;
      drone.activityState = droneRuntime.STATE_IDLE;
      drone.targetID = null;
      drone.droneCommand = null;
      drone.droneCombat = null;
      drone.droneMining = null;
      drone.droneSalvage = null;
      drone.droneRepair = null;
      drone.droneHomeOrbitDistance = droneRuntime.resolveDroneOrbitDistance(drone);
      scene.orbitShipEntity(
        drone.itemID,
        source.itemID,
        drone.droneHomeOrbitDistance,
        {broadcast: false, speedFraction: 0.5},
      );
      this._persistDroneEntity(drone);
      this._emitDroneState(drone);
      deployed.push(drone);
    }

    request.deployedDrones = deployed;
    request.deployedDroneIDs = deployed.map((drone) => positive(drone.itemID));
    return deployed;
  }

  _assignDronesToTarget(request, targetEntity) {
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    if (!scene || !source || !targetEntity) return 0;
    let assigned = 0;
    const now = typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now();

    for (const drone of request.deployedDrones || []) {
      const liveDrone = scene.getEntityByID(drone.itemID);
      if (!liveDrone) continue;
      if (droneRuntime._testing && typeof droneRuntime._testing.resetDroneToIdle === "function") {
        droneRuntime._testing.resetDroneToIdle(liveDrone, source, {
          scene,
          stopMovement: true,
        });
      }
      const snapshot = droneDogma.resolveDroneSalvageSnapshot(liveDrone, source);
      if (!snapshot) continue;
      const chanceSnapshot = salvagerRuntime.buildSalvageChanceSnapshot(
        targetEntity,
        snapshot.accessBonusPercent,
      );
      const orbitDistance = Math.max(200, finite(snapshot.orbitDistanceMeters, 500));
      const maxRange = Math.max(orbitDistance, finite(snapshot.maxRangeMeters, orbitDistance));
      const distance = this._surfaceDistance(scene, liveDrone, targetEntity);
      liveDrone.launcherID = source.itemID;
      liveDrone.controllerID = source.itemID;
      liveDrone.controllerOwnerID = request.characterID;
      liveDrone.targetID = targetEntity.itemID;
      liveDrone.droneCommand = droneRuntime.DRONE_COMMAND_SALVAGE;
      liveDrone.droneSalvage = {
        targetID: targetEntity.itemID,
        nextCycleAtMs: now + Math.max(1, finite(snapshot.durationMs, 1000)),
        snapshot,
        chanceSnapshot,
      };
      liveDrone.droneCombat = null;
      liveDrone.droneMining = null;
      liveDrone.droneRepair = null;
      if (distance > maxRange + 1) {
        scene.orbitShipEntity(liveDrone.itemID, targetEntity.itemID, orbitDistance, {
          broadcast: true,
          speedFraction: 1,
        });
        liveDrone.activityState = droneRuntime.STATE_APPROACHING;
      } else {
        scene.orbitShipEntity(liveDrone.itemID, targetEntity.itemID, orbitDistance, {
          broadcast: true,
          speedFraction: 0.5,
        });
        liveDrone.activityState = droneRuntime.STATE_SALVAGING;
      }
      this._persistDroneEntity(liveDrone);
      this._emitDroneState(liveDrone);
      assigned += 1;
    }
    return assigned;
  }

  async _waitForDroneSalvage(request, targetEntity) {
    const scene = this._serviceShipScene(request);
    if (!scene || !request.deployedDrones || request.deployedDrones.length <= 0) {
      return {success: false, stopReason: "no-drones"};
    }
    const assigned = this._assignDronesToTarget(request, targetEntity);
    if (assigned <= 0) return {success: false, stopReason: "drone-assignment"};
    const durations = (request.deployedDrones || [])
      .map((drone) => finite(drone.droneSalvage && drone.droneSalvage.snapshot && drone.droneSalvage.snapshot.durationMs, 1000));
    const timeout = Math.min(
      180000,
      Math.max(15000, Math.max(...durations, 1000) * this._config.maxSalvageCyclesPerTarget + 10000),
    );
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (request.cancelRequested === true) return {cancelled: true};
      const currentTarget = scene.getEntityByID(targetEntity.itemID);
      if (!currentTarget || !salvagerRuntime.isSalvageableTarget(currentTarget)) {
        await this._waitForDroneCargo(request, 30000);
        if (request.droneOnly !== true) await this._transferSalvageToPlayer(request);
        return {success: true, salvaged: true};
      }
      await delay(this._config.pollIntervalMs);
    }
    return {success: false, stopReason: "drone-cycle-limit"};
  }

  async _waitForDroneCargo(request, timeoutMs) {
    const scene = this._serviceShipScene(request);
    const deadline = Date.now() + timeoutMs;
    while (scene && Date.now() < deadline) {
      let carrying = false;
      for (const drone of request.deployedDrones || []) {
        const liveDrone = scene.getEntityByID(drone.itemID);
        if (!liveDrone) continue;
        const cargo = itemStore.listContainerItems(null, liveDrone.itemID, CARGO_HOLD_FLAG);
        if (cargo.length > 0) {
          carrying = true;
          continue;
        }
        if (liveDrone.droneCommand === droneRuntime.DRONE_COMMAND_SALVAGE &&
            droneRuntime._testing && typeof droneRuntime._testing.resetDroneToIdle === "function") {
          droneRuntime._testing.resetDroneToIdle(liveDrone, this._serviceShipEntity(request), {
            scene,
            stopMovement: true,
          });
          this._persistDroneEntity(liveDrone);
        }
      }
      if (!carrying) return;
      await delay(this._config.pollIntervalMs);
    }
  }

  _sendDroneHome(scene, source, liveDrone) {
    if (!scene || !source || !liveDrone) return false;
    liveDrone.droneCommand = droneRuntime.DRONE_COMMAND_RETURN_HOME;
    liveDrone.droneCombat = null;
    liveDrone.droneMining = null;
    liveDrone.droneSalvage = null;
    liveDrone.droneRepair = null;
    liveDrone.activityState = droneRuntime.STATE_DEPARTING;
    liveDrone.targetID = source.itemID;
    if (typeof scene.orbitShipEntity === "function") {
      scene.orbitShipEntity(liveDrone.itemID, source.itemID, 250, {
        broadcast: true,
        speedFraction: 1,
      });
    }
    this._persistDroneEntity(liveDrone);
    this._emitDroneState(liveDrone);
    return true;
  }

  async _waitForDroneReturn(request, timeoutMs) {
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    const deadline = Date.now() + timeoutMs;
    if (!scene || !source) return false;
    while (Date.now() < deadline) {
      let pending = false;
      for (const drone of request.deployedDrones || []) {
        const liveDrone = scene.getEntityByID(drone.itemID);
        if (!liveDrone) continue;
        const cargo = itemStore.listContainerItems(null, liveDrone.itemID, CARGO_HOLD_FLAG);
        const orbitDistance = Math.max(
          250,
          finite(liveDrone.droneHomeOrbitDistance, droneRuntime.resolveDroneOrbitDistance(liveDrone)),
        );
        const distance = this._surfaceDistance(scene, liveDrone, source);
        if (
          cargo.length > 0 ||
          distance > orbitDistance + 100 ||
          liveDrone.droneCommand === droneRuntime.DRONE_COMMAND_RETURN_HOME ||
          liveDrone.activityState === droneRuntime.STATE_DEPARTING
        ) {
          pending = true;
        }
      }
      if (!pending) return true;
      await delay(this._config.pollIntervalMs);
    }
    return false;
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
    if (request.cancelRequested === true) return false;
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    if (!source || workers.tractors.length <= 0 || !targetEntity) return false;
    const skillMap = getCachedCharacterSkillMap(request.characterID);
    const states = [];
    if (!(source.activeModuleEffects instanceof Map)) source.activeModuleEffects = new Map();
    for (const tractor of workers.tractors) {
      const effectRecord = getTypeEffectRecords(tractor.typeID)
        .find((entry) => String(entry && entry.name) === "tractorBeamCan");
      if (!effectRecord) continue;
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
      if (!activation || activation.success !== true) continue;
      const state = {
        moduleID: tractor.itemID,
        moduleFlagID: tractor.flagID,
        typeID: tractor.typeID,
        targetID: targetEntity.itemID,
        startedAtMs: Date.now(),
        lastTractorTickAtMs: Date.now(),
        ...activation.data.effectStatePatch,
      };
      states.push(state);
      source.activeModuleEffects.set(tractor.itemID, state);
      tractorBeamRuntime.broadcastTractorBeamActivationBootstrap(
        scene,
        source,
        state,
        typeof scene.getCurrentSimTimeMs === "function" ? scene.getCurrentSimTimeMs() : Date.now(),
      );
    }
    if (states.length <= 0) return false;
    const holdDistance = Math.max(
      2500,
      ...states.map((state) => finite(state.tractorBeamHoldDistanceMeters, 2500)),
    );
    const deadline = Date.now() + Math.min(this._config.approachTimeoutMs, 10000);
    let pulled = false;
    while (Date.now() < deadline) {
      if (request.cancelRequested === true) break;
      const currentSource = scene.getEntityByID(source.itemID);
      const currentTarget = scene.getEntityByID(targetEntity.itemID);
      if (!currentSource || !currentTarget) break;
      if (this._surfaceDistance(scene, currentSource, currentTarget) <= holdDistance) {
        pulled = true;
        break;
      }
      await delay(this._config.pollIntervalMs);
    }
    for (const state of states) {
      tractorBeamRuntime.handleTractorBeamDeactivation(scene, state, Date.now());
      source.activeModuleEffects.delete(state.moduleID);
    }
    return pulled;
  }

  async _salvageTarget(request, session, targetEntity, workers) {
    const scene = this._serviceShipScene(request);
    const source = this._serviceShipEntity(request);
    const serviceShipItem = itemStore.findItemById(request.serviceShip.serviceShipID);
    const playerShip = itemStore.findItemById(request.playerShipID);
    const collectionShip = request.collectionShip && !request.collectionShip.returning
      ? request.collectionShip
      : null;
    const rewardLocationID = collectionShip ? collectionShip.shipID : request.playerShipID;
    const effectRecord = this._salvagerEffectRecord();
    if (!source || !serviceShipItem || !playerShip || !effectRecord || workers.salvagers.length <= 0) {
      return {success: false, stopReason: "module"};
    }
    const skillMap = getCachedCharacterSkillMap(request.characterID);
    const workerItems = workers.salvagers;
    for (let cycle = 0; cycle < this._config.maxSalvageCyclesPerTarget; cycle += 1) {
      if (request.cancelRequested === true) return {cancelled: true};
      const currentTarget = scene.getEntityByID(targetEntity.itemID);
      if (!currentTarget || !salvagerRuntime.isSalvageableTarget(currentTarget)) {
        return {success: true, salvaged: true};
      }
      let durationMs = 1000;
      for (const worker of workerItems) {
        if (request.cancelRequested === true) return {cancelled: true};
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
            salvageRewardLocationID: rewardLocationID,
            syncInventoryChangesToSession: (ownerSession, changes) =>
              this._syncChanges(ownerSession, changes, rewardLocationID),
          },
        });
        if (result && result.stopReason === "cargo") {
          return {success: false, stopReason: "cargo", data: result.data};
        }
        if (result && result.data && result.data.salvaged === true) {
          this._refreshPlayerCargo(session, request.characterID, rewardLocationID);
          return {success: true, salvaged: true, data: result.data};
        }
      }
      await delay(Math.min(Math.max(250, durationMs), 5000));
    }
    return {success: false, stopReason: "cycle-limit"};
  }

  async _sendAway(request, session = null) {
    const serviceShip = request.serviceShip;
    const scene = this._serviceShipScene(request);
    if (request.departureStarted === true) return;
    request.departureStarted = true;
    const source = this._serviceShipEntity(request);
    if (request.droneOnly === true) {
      if (scene && source) {
        for (const drone of request.deployedDrones || []) {
          const liveDrone = scene.getEntityByID(drone.itemID);
          if (!liveDrone) continue;
          this._sendDroneHome(scene, source, liveDrone);
        }
        await this._waitForDroneReturn(request, 30000);
      }
      await this._transferSalvageToDestination(request, session);
      await this._removeServiceDrones(request, session);
      await this._returnCollectionShip(request, session);
      return;
    }
    if (scene && source) {
      await this._transferSalvageToDestination(request, session);
      for (const drone of request.deployedDrones || []) {
        const liveDrone = scene.getEntityByID(drone.itemID);
        if (!liveDrone) continue;
        this._sendDroneHome(scene, source, liveDrone);
      }
      await this._waitForDroneReturn(request, 30000);
      await this._transferSalvageToDestination(request, session);
    }
    if (!scene || !serviceShip.departurePoint || typeof scene.startSessionlessWarpIngress !== "function") {
      await this._removeServiceShip(request, session);
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
      await this._removeServiceShip(request, session);
      return;
    }
    if (this._config.departureDelayMs > 0) await delay(this._config.departureDelayMs);
    await delay(2500);
    await this._removeServiceShip(request, session);
    await this._returnCollectionShip(request, session);
  }

  async _removeServiceDrones(request, session = null) {
    const serviceShip = request && request.serviceShip;
    const scene = this._serviceShipScene(request);
    if (!serviceShip && request && request.droneOnly !== true) return;
    const fallbackSystemID = serviceShip ? serviceShip.systemID : request.systemID;
    for (const droneID of [...new Set((request.deployedDroneIDs || []).filter(Boolean))]) {
      try {
        const droneScene = typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
          ? spaceRuntime.findSceneContainingDynamicEntity(droneID) || scene
          : scene;
        const liveDrone = droneScene && typeof droneScene.getEntityByID === "function"
          ? droneScene.getEntityByID(droneID)
          : null;
        const clientDrone = liveDrone ||
          (request.deployedDrones || []).find((drone) => positive(drone && drone.itemID) === positive(droneID));
        this._clearDroneClientState(clientDrone, session);
        const systemID = droneScene && droneScene.systemID || fallbackSystemID;
        const result = spaceRuntime.destroyDynamicInventoryEntity(
          systemID,
          droneID,
          {
            sceneDescriptor: droneScene && droneScene.sceneDescriptor,
            broadcast: true,
            actor: request.characterID,
            removeContents: true,
          },
        );
        if (!result || result.success !== true) {
          if (droneScene && typeof droneScene.removeDynamicEntity === "function") {
            droneScene.removeDynamicEntity(droneID, {
              broadcast: true,
              persistSpaceState: false,
              allowSessionOwned: true,
            });
          }
          itemStore.removeInventoryItem(droneID, {removeContents: true});
        }
        const residualScene = typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
          ? spaceRuntime.findSceneContainingDynamicEntity(droneID)
          : null;
        if (residualScene && typeof residualScene.removeDynamicEntity === "function") {
          residualScene.removeDynamicEntity(droneID, {
            broadcast: true,
            persistSpaceState: false,
            allowSessionOwned: true,
          });
        }
        if (itemStore.findItemById(droneID)) {
          itemStore.removeInventoryItem(droneID, {removeContents: true});
        }
      } catch (error) {
        log.warn(`[${MOD_ID}] drone cleanup failed id=${droneID}: ${error.message}`);
        itemStore.removeInventoryItem(droneID, {removeContents: true});
      }
    }
    request.deployedDrones = [];
    request.deployedDroneIDs = [];
  }

  async _removeServiceShip(request, session = null) {
    const serviceShip = request && request.serviceShip;
    if (request && request.droneOnly === true) {
      await this._waitForDroneCargo(request, 5000);
      await this._transferSalvageToDestination(request, session);
      await this._removeServiceDrones(request, session);
      await this._returnCollectionShip(request, session);
      return true;
    }
    if (!serviceShip) {
      await this._returnCollectionShip(request, session);
      return true;
    }
    const scene = this._serviceShipScene(request);
    await this._waitForDroneCargo(request, 5000);
    await this._transferSalvageToPlayer(request, session);
    await this._removeServiceDrones(request, session);
    let removed = false;
    let removedFromScene = false;
    try {
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(serviceShip.serviceShipID)
        : null;
      if (entity && typeof scene.stopShipEntity === "function") {
        scene.stopShipEntity(entity, {
          allowSessionlessWarpAbort: true,
          reason: "salvage-buddy-cleanup",
        });
      }
      const result = spaceRuntime.destroyDynamicInventoryEntity(
        serviceShip.systemID,
        serviceShip.serviceShipID,
        {
          sceneDescriptor: scene && scene.sceneDescriptor,
          broadcast: true,
          actor: request.characterID,
        },
      );
      removed = Boolean(result && result.success === true);
      if (!removed && scene && typeof scene.removeDynamicEntity === "function") {
        const sceneResult = scene.removeDynamicEntity(serviceShip.serviceShipID, {
          broadcast: true,
          persistSpaceState: false,
          allowSessionOwned: true,
        });
        removed = Boolean(sceneResult && sceneResult.success === true);
        removedFromScene = removed;
      }
    } catch (error) {
      log.debug(`[${MOD_ID}] service ship cleanup failed: ${error.message}`);
    }
    if (!removed || removedFromScene) {
      itemStore.removeInventoryItem(serviceShip.serviceShipID, {removeContents: true});
    }
    request.serviceShip = null;
    await this._returnCollectionShip(request, session);
    return removed;
  }

  async _cancelRequest(request, session) {
    request.stage = "departing";
    await this._sendAway(request, session);
    request.status = "cancelled";
    request.stage = "cancelled";
    this._send(session, "SalvageBuddy is returning to base.");
  }

  async _runDroneOnlyRequest(request, session) {
    request.droneOnly = true;
    request.droneScene = this._sceneForSession(session);
    request.systemID = systemIDFromSession(session);
    try {
      request.stage = "spawning";
      if (request.cancelRequested === true) return await this._cancelRequest(request, session);
      if (!request.droneScene || !request.systemID) throw new Error("PLAYER_SCENE_NOT_FOUND");
      if (positive(this._character(request.characterID).collectionShipID) > 0) {
        request.collectionShip = await this._spawnCollectionShip(session, request);
        if (!request.collectionShip) {
          this._send(session, "The selected collection ship is unavailable; SalvageBuddy will deliver loot to your active ship.");
        }
      }
      request.deployedDrones = await this._spawnPlayerServiceDrones(request, session);
      request.deployedDroneIDs = request.deployedDrones.map((drone) => positive(drone.itemID));
      if (request.deployedDrones.length <= 0) throw new Error("SALVAGE_DRONE_SPAWN_FAILED");
      request.deliveryStarted = true;
      request.stage = "servicing";
      const deadline = Date.now() + this._config.maxServiceDurationMs;
      while (Date.now() < deadline) {
        if (request.cancelRequested === true) return await this._cancelRequest(request, session);
        if (request.collectionRecallRequested === true && request.collectionShip) {
          await this._returnCollectionShip(request, session);
        }
        const targets = this._eligibleTargets(request, session);
        this._recordTargetProgress(request, targets);
        if (targets.length <= 0) break;
        const target = targets[0];
        request.targetID = positive(target.itemID);
        let result;
        if (this._isCargoContainerTarget(target, session)) {
          result = await this._collectContainer(request, session, target);
        } else {
          result = await this._waitForDroneSalvage(request, target);
        }
        if (request.cancelRequested === true || (result && result.cancelled === true)) {
          return await this._cancelRequest(request, session);
        }
        if (!result || result.success !== true) {
          this._send(session, "SalvageBuddy could not complete a target and is returning.");
          break;
        }
        await this._transferSalvageToDestination(request, session);
        if (request.collectionRecallRequested === true && request.collectionShip) {
          await this._returnCollectionShip(request, session);
        }
        request.targetsProcessed += 1;
        request.targetID = 0;
      }
      if (request.cancelRequested === true) return await this._cancelRequest(request, session);
      request.stage = "departing";
      await this._sendAway(request, session);
      request.status = "completed";
      request.stage = "complete";
      this._send(session, `Service complete. SalvageBuddy processed ${request.targetsProcessed} target(s).`);
    } catch (error) {
      request.status = "failed";
      request.stage = "failed";
      await this._removeServiceShip(request, session);
      if (!request.deliveryStarted) await this._refund(request);
      this._send(
        session,
        request.refunded
          ? `Service failed before deployment; ${request.chargedISK.toFixed(0)} ISK was refunded.`
          : `Service ended: ${error.message}`,
      );
      log.warn(`[${MOD_ID}] drone-only request=${request.id} failed: ${error.stack || error.message}`);
    } finally {
      const character = this._character(request.characterID);
      character.lastRequestID = request.id;
      character.lastCompletedAtMs = Date.now();
      character.lastStatus = request.status || "failed";
      this._active.delete(request.characterID);
      this._saveState();
    }
  }

  async _runRequest(request, session) {
    if (this._config.droneOnly === true) {
      return this._runDroneOnlyRequest(request, session);
    }
    try {
      request.stage = "spawning";
      if (request.cancelRequested === true) return await this._cancelRequest(request, session);
      if (positive(this._character(request.characterID).collectionShipID) > 0) {
        request.collectionShip = await this._spawnCollectionShip(session, request);
        if (!request.collectionShip) {
          this._send(session, "The selected collection ship is unavailable; SalvageBuddy will deliver loot to your active ship.");
        }
      }
      request.serviceShip = await this._spawnServiceShip(session, request);
      if (!request.serviceShip) throw new Error("SERVICE_SHIP_SPAWN_FAILED");
      request.serviceShipID = request.serviceShip.serviceShipID;
      if (request.cancelRequested === true) return await this._cancelRequest(request, session);
      request.stage = "warping-in";
      const arrived = await this._bringToPlayer(request);
      if (!arrived) {
        if (request.cancelRequested === true) return await this._cancelRequest(request, session);
        throw new Error("SERVICE_SHIP_ARRIVAL_FAILED");
      }
      this._activateAfterburner(request);
      request.deployedDrones = await this._deployServiceDrones(request);
      request.deployedDroneIDs = request.deployedDrones.map((drone) => positive(drone.itemID));
      request.deliveryStarted = true;
      request.stage = "servicing";
      const deadline = Date.now() + this._config.maxServiceDurationMs;
      while (Date.now() < deadline) {
        if (request.cancelRequested === true) return await this._cancelRequest(request, session);
        if (request.collectionRecallRequested === true && request.collectionShip) {
          await this._returnCollectionShip(request, session);
        }
        const targets = this._eligibleTargets(request, session);
        this._recordTargetProgress(request, targets);
        if (targets.length <= 0) break;
        const target = targets[0];
        request.targetID = positive(target.itemID);
        const workers = this._fittedWorkers(request.serviceShipID, request);
        const tractorRange = workers.tractors.length > 0 ? 20000 : this._config.approachRangeMeters;
        const reachedTarget = await this._positionForTractor(
          request,
          target.itemID,
          tractorRange,
          this._config.approachTimeoutMs,
        );
        if (request.cancelRequested === true) return await this._cancelRequest(request, session);
        if (!reachedTarget) {
          this._send(session, "SalvageBuddy could not reach a salvage target and is returning.");
          break;
        }
        await this._useTractor(request, session, target, workers);
        if (request.cancelRequested === true) return await this._cancelRequest(request, session);
        const currentTarget = request.serviceShip.scene.getEntityByID(target.itemID);
        if (!currentTarget) continue;
        let result;
        if (this._isCargoContainerTarget(currentTarget, session)) {
          result = await this._collectContainer(request, session, currentTarget);
        } else if (request.deployedDrones.length > 0) {
          result = await this._waitForDroneSalvage(request, currentTarget);
          if (result && result.success !== true && result.cancelled !== true) {
            result = await this._salvageTarget(request, session, currentTarget, workers);
          }
        } else {
          result = await this._salvageTarget(request, session, currentTarget, workers);
        }
        await this._transferSalvageToPlayer(request, session);
        if (request.cancelRequested === true || result && result.cancelled === true) {
          return await this._cancelRequest(request, session);
        }
        if (request.collectionRecallRequested === true && request.collectionShip) {
          await this._returnCollectionShip(request, session);
        }
        if (result && result.stopReason === "cargo") {
          this._send(session, "The player ship cargo hold is full; SalvageBuddy is returning.");
          break;
        }
        request.targetsProcessed += 1;
        request.targetID = 0;
      }
      if (request.cancelRequested === true) return await this._cancelRequest(request, session);
      request.stage = "departing";
      await this._sendAway(request, session);
      request.status = "completed";
      request.stage = "complete";
      this._send(session, `Service complete. SalvageBuddy processed ${request.targetsProcessed} target(s).`);
    } catch (error) {
      request.status = "failed";
      request.stage = "failed";
      await this._removeServiceShip(request, session);
      if (!request.deliveryStarted) await this._refund(request);
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
      targetsRemaining: 0,
      discoveredTargetIDs: new Set(),
      deployedDrones: [],
      deployedDroneIDs: [],
      collectionShip: null,
      collectionRecallRequested: false,
      collectionHoldFullNotified: false,
      cancelRequested: false,
      departureStarted: false,
    };
    this._active.set(characterID, request);
    this._saveState();
    this._send(session, `SalvageBuddy accepted the request for ${charge.amount.toFixed(0)} ISK.`);
    void this._runRequest(request, session);
    return this._stateForSession(session);
  }

  async Handle_SendAway(_args, session) {
    const characterID = characterIDFromSession(session);
    const request = this._active.get(characterID);
    if (!request) throw new Error("SALVAGE_BUDDY_NOT_ACTIVE");
    request.cancelRequested = true;
    request.stage = "returning";
    this._saveState();
    this._send(session, "SalvageBuddy will stop working and depart shortly.");
    return this._stateForSession(session);
  }

  async Handle_RecallCollectionShip(_args, session) {
    const characterID = characterIDFromSession(session);
    const request = this._active.get(characterID);
    if (!request || !request.collectionShip || !request.collectionShip.inSpace) {
      throw new Error("SALVAGE_BUDDY_COLLECTION_SHIP_NOT_ACTIVE");
    }
    if (request.collectionRecallRequested === true) return this._stateForSession(session);
    request.collectionRecallRequested = true;
    this._saveState();
    this._send(session, "The collection ship will return to its station with recovered loot. SalvageBuddy will continue working.");
    void this._returnCollectionShip(request, session).then((returned) => {
      if (returned || !request.collectionShip) return;
      request.collectionRecallRequested = false;
      this._saveState();
      this._send(session, "The collection ship could not return to its station. You can try recalling it again.");
    });
    return this._stateForSession(session);
  }

  stop() {
    return true;
  }
}

module.exports = SalvageBuddyService;
