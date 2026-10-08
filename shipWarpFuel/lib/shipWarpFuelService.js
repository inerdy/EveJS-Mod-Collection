"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const {resolveDataRootPath} = require(serverPath("config", "dataRoot"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const {resolveSessionCharacterID} = require(serverPath("services", "_shared", "sessionIdentity"));
const log = require(serverPath("utils", "logger"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {
  createStateStore,
  normalizeCharacter,
  normalizeShip,
} = require(path.join(__dirname, "state"));

const MOD_ID = "shipWarpFuel";
const SERVICE_NAME = MOD_ID;
const AU_METERS = 149597870700;
const FUEL_BAY_FLAG = itemStore.ITEM_FLAGS.FUEL_BAY;
const CARGO_HOLD_FLAG = itemStore.ITEM_FLAGS.CARGO_HOLD;
const MAX_MONEY_DECIMALS = 2;
const GROUP_CAPSULE = 29;

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function nonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round(nonNegative(value) * 100) / 100;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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

function stationIDFromSession(session) {
  return positive(
    session && (
      session.stationid ||
      session.stationID ||
      session.structureid ||
      session.structureID
    ),
    0,
  );
}

function isInSpaceSession(session) {
  return Boolean(
    session &&
    session._space &&
    positive(session._space.shipID) &&
    positive(session._space.systemID) &&
    !stationIDFromSession(session),
  );
}

function requestObject(args) {
  const request = Array.isArray(args) ? args[0] : args;
  return request && typeof request === "object" ? request : {};
}

function vector(value) {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x, NaN);
  const y = finite(value.y, NaN);
  const z = finite(value.z, NaN);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    ? {x, y, z}
    : null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function classifyShip(activeShip, metadata = null, capsuleChecker = itemStore) {
  const typeID = positive(activeShip && activeShip.typeID, 0);
  const groupID = positive(
    activeShip && activeShip.groupID,
    positive(metadata && metadata.groupID, 0),
  );
  const capsule = typeof capsuleChecker.isCapsuleTypeID === "function" &&
    capsuleChecker.isCapsuleTypeID(typeID);
  const text = [
    activeShip && activeShip.groupName,
    activeShip && activeShip.name,
    metadata && metadata.groupName,
    metadata && metadata.name,
  ].map(normalizeText).filter(Boolean).join(" ");

  if (capsule || groupID === GROUP_CAPSULE || text.includes("capsule")) {
    return "capsule";
  }
  if (
    text.includes("titan") ||
    text.includes("supercarrier") ||
    text.includes("carrier") ||
    text.includes("dreadnought") ||
    text.includes("force auxiliary") ||
    text.includes("capital industrial") ||
    text.includes("jump freighter") ||
    text.includes("freighter")
  ) {
    return "capitalFreighter";
  }
  if (
    text.includes("industrial") ||
    text.includes("hauler") ||
    text.includes("transport ship") ||
    text.includes("mining barge") ||
    text.includes("exhumer") ||
    text.includes("blockade runner")
  ) {
    return "industrialTransport";
  }
  if (
    text.includes("battleship") ||
    text.includes("marauder") ||
    text.includes("black ops")
  ) {
    return "battleship";
  }
  if (text.includes("battlecruiser") || text.includes("command ship")) {
    return "battlecruiser";
  }
  if (
    text.includes("cruiser") ||
    text.includes("heavy interdictor") ||
    text.includes("strategic cruiser") ||
    text.includes("logistics") ||
    text.includes("recon ship")
  ) {
    return "cruiser";
  }
  if (text.includes("destroyer") || text.includes("interdictor")) {
    return "destroyer";
  }
  if (text.includes("corvette")) return "corvette";
  if (text.includes("shuttle")) return "shuttle";
  if (text.includes("frigate")) return "frigate";
  return "fallback";
}

function distanceMeters(left, right) {
  const a = vector(left);
  const b = vector(right);
  if (!a || !b) return 0;
  return Math.max(0, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
}

function quantityOf(item) {
  if (!item) return 0;
  return Number(item.singleton) === 1
    ? 1
    : Math.max(0, Math.trunc(Number(item.quantity ?? item.stacksize) || 0));
}

function marshal(value) {
  return JSON.stringify(value);
}

class ShipWarpFuelService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._database = options.database || database;
    this._stateStore = options.stateStore || createStateStore(
      resolveDataRootPath("gameStore", MOD_ID, "state.json"),
    );
    this._state = this._stateStore.load();
    this._dependencies = options.dependencies || null;
    this._debtTimer = null;
    this._settlingEmergency = new Set();
    if (this._config.enabled && options.autoStart !== false) this._start();
  }

  _start() {
    if (this._debtTimer) return;
    this._debtTimer = setInterval(() => {
      void this._collectDebts();
    }, this._config.debtPollMs);
    this._debtTimer.unref?.();
  }

  stop() {
    if (this._debtTimer) clearInterval(this._debtTimer);
    this._debtTimer = null;
    return true;
  }

  _getDependencies() {
    if (this._dependencies) return this._dependencies;
    this._dependencies = {
      itemStore,
      characterState: require(serverPath("services", "character", "characterState")),
      walletState: require(serverPath("services", "account", "walletState")),
      chatHub: require(serverPath("services", "chat", "chatHub")),
      sessionRegistry: require(serverPath("services", "chat", "sessionRegistry")),
      spaceRuntime: require(serverPath("space", "runtime")),
    };
    return this._dependencies;
  }

  _saveState() {
    this._stateStore.save(this._state);
  }

  _character(characterID) {
    const key = String(positive(characterID));
    if (!this._state.characters[key]) this._state.characters[key] = normalizeCharacter({});
    return this._state.characters[key];
  }

  _ship(shipID, characterID) {
    const key = String(positive(shipID));
    if (!this._state.ships[key]) {
      this._state.ships[key] = normalizeShip({characterID});
    }
    if (characterID > 0) this._state.ships[key].characterID = characterID;
    return this._state.ships[key];
  }

  _activeShip(characterID, session = null) {
    const requestedShipID = shipIDFromSession(session);
    if (requestedShipID > 0) {
      return this._getDependencies().itemStore.findCharacterShipItem(characterID, requestedShipID) ||
        this._getDependencies().itemStore.findShipItemById(requestedShipID) || null;
    }
    const store = this._getDependencies().itemStore;
    return typeof store.getActiveShipItem === "function"
      ? store.getActiveShipItem(characterID) || null
      : null;
  }

  _fuelDefinition(typeID) {
    const normalizedTypeID = positive(typeID, this._config.fuelTypeID);
    return (this._config.fuelTypes || []).find((entry) =>
      positive(entry && entry.typeID) === normalizedTypeID,
    ) || {
      typeID: normalizedTypeID,
      name: "Fuel",
      burnMultiplier: 1,
    };
  }

  _selectedFuelTypeID(shipID) {
    const ship = this._state.ships[String(positive(shipID))];
    const configuredTypeID = positive(ship && ship.fuelTypeID, this._config.fuelTypeID);
    return (this._config.fuelTypes || []).some((entry) => positive(entry && entry.typeID) === configuredTypeID)
      ? configuredTypeID
      : this._config.fuelTypeID;
  }

  _allFuelTypeIDs() {
    return new Set((this._config.fuelTypes || []).map((entry) => positive(entry && entry.typeID)));
  }

  _allFuelRows(characterID, shipID) {
    const fuelTypeIDs = this._allFuelTypeIDs();
    return this._getDependencies().itemStore
      .listContainerItems(characterID, shipID, FUEL_BAY_FLAG)
      .filter((item) => fuelTypeIDs.has(positive(item && item.typeID)));
  }

  _fuelRows(characterID, shipID, fuelTypeID = this._selectedFuelTypeID(shipID)) {
    return this._getDependencies().itemStore
      .listContainerItems(characterID, shipID, FUEL_BAY_FLAG)
      .filter((item) => positive(item && item.typeID) === positive(fuelTypeID));
  }

  _cargoFuelRows(characterID, shipID, fuelTypeID = this._selectedFuelTypeID(shipID)) {
    return this._getDependencies().itemStore
      .listContainerItems(characterID, shipID, CARGO_HOLD_FLAG)
      .filter((item) => positive(item && item.typeID) === positive(fuelTypeID));
  }

  _shipFuelProfile(characterID, session = null) {
    const ship = this._activeShip(characterID, session);
    const store = this._getDependencies().itemStore;
    const metadata = ship && store && typeof store.getItemMetadata === "function"
      ? store.getItemMetadata(ship.typeID)
      : null;
    const shipClass = classifyShip(
      ship,
      metadata,
      store,
    );
    const configuredRate = this._config.fuelUnitsPerAUByClass &&
      this._config.fuelUnitsPerAUByClass[shipClass];
    const fuelTypeID = this._selectedFuelTypeID(ship && ship.itemID);
    const fuel = this._fuelDefinition(fuelTypeID);
    const baseFuelUnitsPerAU = Math.max(
      0.000001,
      finite(configuredRate, this._config.fuelUnitsPerAU),
    );
    return {
      ship,
      shipClass,
      fuelTypeID,
      fuelName: fuel.name,
      fuelMultiplier: Math.max(0.000001, finite(fuel.burnMultiplier, 1)),
      baseFuelUnitsPerAU,
      fuelUnitsPerAU: baseFuelUnitsPerAU * Math.max(0.000001, finite(fuel.burnMultiplier, 1)),
    };
  }

  _inventoryRow(item) {
    const metadata = this._getDependencies().itemStore.getItemMetadata(item && item.typeID);
    return {
      itemID: positive(item && item.itemID),
      typeID: positive(item && item.typeID),
      name: String(item && (item.name || item.itemName) || metadata && metadata.name || "Item"),
      quantity: quantityOf(item),
      volume: Math.max(0, finite(item && item.volume, finite(metadata && metadata.volume, 0))),
      flagID: positive(item && item.flagID),
    };
  }

  _fuelBayState(characterID, session = null) {
    const ship = this._activeShip(characterID, session);
    const shipID = positive(ship && ship.itemID, shipIDFromSession(session));
    const fuelTypeID = this._selectedFuelTypeID(shipID);
    const fuelDefinition = this._fuelDefinition(fuelTypeID);
    const fuelRows = shipID ? this._fuelRows(characterID, shipID, fuelTypeID) : [];
    const cargoRows = shipID ? this._cargoFuelRows(characterID, shipID, fuelTypeID) : [];
    const fuelUnits = fuelRows.reduce((sum, item) => sum + quantityOf(item), 0);
    const cargoFuelUnits = cargoRows.reduce((sum, item) => sum + quantityOf(item), 0);
    const fuelTypes = (this._config.fuelTypes || []).map((entry) => {
      const entryTypeID = positive(entry.typeID);
      return {
        typeID: entryTypeID,
        name: entry.name,
        burnMultiplier: entry.burnMultiplier,
        fuelUnits: shipID ? this.fuelQuantity(characterID, shipID, entryTypeID) : 0,
        cargoFuelUnits: shipID ? this._cargoFuelRows(characterID, shipID, entryTypeID).reduce((sum, item) => sum + quantityOf(item), 0) : 0,
      };
    });
    return {
      shipID,
      shipName: String(ship && (ship.itemName || ship.name) || "Current Ship"),
      fuelTypeID,
      fuelName: fuelDefinition.name,
      fuelMultiplier: fuelDefinition.burnMultiplier,
      fuelBayFlagID: FUEL_BAY_FLAG,
      cargoHoldFlagID: CARGO_HOLD_FLAG,
      fuelUnits,
      fuelCapacityUnits: this._config.fuelCapacityUnits,
      cargoFuelUnits,
      fuelTypes,
      fuelBayItems: fuelRows.map((item) => this._inventoryRow(item)),
      cargoFuelItems: cargoRows.map((item) => this._inventoryRow(item)),
    };
  }

  _nextInventoryMoveKey(characterID, shipID, direction) {
    const sequence = Math.max(1, Math.trunc(Number(this._state.nextInventoryMoveID) || 1));
    this._state.nextInventoryMoveID = sequence + 1;
    this._saveState();
    return `${MOD_ID}:inventory:${direction}:${characterID}:${shipID}:${sequence}`;
  }

  _moveFuelBetweenBays(session, direction, requestedQuantity) {
    const characterID = characterIDFromSession(session);
    const shipID = shipIDFromSession(session);
    const ship = this._activeShip(characterID, session);
    if (!characterID || !shipID || !ship) throw new Error("SHIP_WARP_FUEL_SHIP_REQUIRED");

    const sourceFlag = direction === "load" ? CARGO_HOLD_FLAG : FUEL_BAY_FLAG;
    const destinationFlag = direction === "load" ? FUEL_BAY_FLAG : CARGO_HOLD_FLAG;
    const fuelTypeID = this._selectedFuelTypeID(shipID);
    const sourceRows = direction === "load"
      ? this._cargoFuelRows(characterID, shipID, fuelTypeID)
      : this._fuelRows(characterID, shipID, fuelTypeID);
    const currentFuel = direction === "load"
      ? this._allFuelRows(characterID, shipID).reduce((sum, item) => sum + quantityOf(item), 0)
      : this.fuelQuantity(characterID, shipID, fuelTypeID);
    const defaultQuantity = direction === "load"
      ? Math.max(0, this._config.fuelCapacityUnits - currentFuel)
      : currentFuel;
    let remaining = Math.min(
      Math.max(0, Math.trunc(Number(requestedQuantity) || 0)) || defaultQuantity,
      direction === "load" ? Math.max(0, this._config.fuelCapacityUnits - currentFuel) : currentFuel,
    );
    let moved = 0;
    const changes = [];
    for (const item of sourceRows.sort((left, right) => positive(left.itemID) - positive(right.itemID))) {
      if (remaining <= 0) break;
      if (
        positive(item.ownerID) !== characterID ||
        positive(item.locationID) !== shipID ||
        positive(item.flagID) !== sourceFlag ||
        positive(item.typeID) !== fuelTypeID
      ) continue;
      const take = Math.min(remaining, quantityOf(item));
      if (take <= 0) continue;
      const receiptKey = this._nextInventoryMoveKey(characterID, shipID, direction);
      const result = this._getDependencies().itemStore.moveItemToLocationIdempotent(
        item.itemID,
        shipID,
        destinationFlag,
        take,
        {
          receiptKey,
          fingerprint: {
            itemID: item.itemID,
            sourceFlag,
            destinationFlag,
            quantity: take,
          },
        },
      );
      if (!result || result.success !== true) {
        log.warn(
          `[${MOD_ID}] fuel bay ${direction} failed ship=${shipID} item=${item.itemID} ` +
          `error=${result && result.errorMsg || "unknown"}`,
        );
        continue;
      }
      moved += take;
      remaining -= take;
      changes.push(...(result.data && result.data.changes || result.changes || []));
    }
    if (moved > 0) this._saveState();
    return {
      success: moved > 0,
      moved,
      requested: Math.max(0, Math.trunc(Number(requestedQuantity) || 0)) || defaultQuantity,
      changes,
      state: this._fuelBayState(characterID, session),
    };
  }

  fuelQuantity(characterID, shipID, fuelTypeID = this._selectedFuelTypeID(shipID)) {
    return this._fuelRows(characterID, shipID, fuelTypeID).reduce(
      (sum, item) => sum + quantityOf(item),
      0,
    );
  }

  fuelUnitVolumeM3(fuelTypeID = this._config.fuelTypeID) {
    const metadata = this._getDependencies().itemStore.getItemMetadata(fuelTypeID);
    return Math.max(0.000001, finite(metadata && metadata.volume, 0.03));
  }

  fuelCapacityM3() {
    return this._config.fuelCapacityUnits * this.fuelUnitVolumeM3();
  }

  _fuelBayUsedVolume(characterID, shipID) {
    return this._getDependencies().itemStore
      .listContainerItems(characterID, shipID, FUEL_BAY_FLAG)
      .reduce((sum, item) => {
        const quantity = quantityOf(item);
        const volume = Math.max(
          0,
          finite(item && item.volume, this.fuelUnitVolumeM3()),
        );
        return sum + quantity * volume;
      }, 0);
  }

  decorateResourceState(resourceState) {
    if (!this._config.enabled || !resourceState || typeof resourceState !== "object") return resourceState;
    const capacity = this.fuelCapacityM3();
    resourceState.specialFuelBayCapacity = capacity;
    resourceState.attributes = resourceState.attributes && typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : {};
    resourceState.attributes[1549] = capacity;
    return resourceState;
  }

  decorateFittingSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    this.decorateResourceState(snapshot.resourceState);
    this.decorateResourceState(snapshot.snapshot && snapshot.snapshot.resourceState);
    if (snapshot.shipAttributes && typeof snapshot.shipAttributes === "object") {
      snapshot.shipAttributes[1549] = this.fuelCapacityM3();
    }
    if (snapshot.trackedShipAttributes && typeof snapshot.trackedShipAttributes === "object") {
      snapshot.trackedShipAttributes[1549] = this.fuelCapacityM3();
    }
    if (snapshot.snapshot && snapshot.snapshot.shipAttributes) {
      snapshot.snapshot.shipAttributes[1549] = this.fuelCapacityM3();
    }
    return snapshot;
  }

  _send(session, message) {
    if (!session || !message) return;
    try {
      this._getDependencies().chatHub.sendSystemMessage(session, `[Warp Fuel] ${message}`);
    } catch (error) {
      log.debug(`[${MOD_ID}] chat notification failed: ${error.message}`);
    }
  }

  _emitInventoryChanges(session, changes = []) {
    if (!session || !Array.isArray(changes) || changes.length === 0) return;
    const characterState = this._getDependencies().characterState;
    if (
      characterState &&
      typeof characterState.emitItemsChangedBatchForSession === "function"
    ) {
      characterState.emitItemsChangedBatchForSession(session, changes, {
        idType: "charid",
      });
    }
  }

  ensureInitialFuel(session, shipItem = null) {
    if (!this._config.enabled || !this._config.initialFillActiveShips) return null;
    const characterID = characterIDFromSession(session);
    const ship = shipItem || this._activeShip(characterID, session);
    const shipID = positive(ship && ship.itemID, shipIDFromSession(session));
    if (!characterID || !shipID) return null;
    const fuelTypeID = this._selectedFuelTypeID(shipID);
    const fuelDefinition = this._fuelDefinition(fuelTypeID);
    const character = this._character(characterID);
    const fillKey = String(shipID);
    const existingMarker = character.initialFills[fillKey];
    const currentFuel = this.fuelQuantity(characterID, shipID);
    if (existingMarker && existingMarker.completed === true) return currentFuel;
    if (currentFuel >= this._config.fuelCapacityUnits) {
      character.initialFills[fillKey] = {
        completed: true,
        quantity: currentFuel,
        atMs: Date.now(),
      };
      this._ship(shipID, characterID);
      this._saveState();
      return currentFuel;
    }

    const freeVolume = Math.max(
      0,
      this.fuelCapacityM3() - this._fuelBayUsedVolume(characterID, shipID),
    );
    const freeUnits = Math.floor(freeVolume / this.fuelUnitVolumeM3() + 1e-9);
    const requested = Math.min(
      this._config.fuelCapacityUnits - currentFuel,
      freeUnits,
    );
    if (requested <= 0) return currentFuel;

    const result = this._getDependencies().itemStore.grantItemToOwnerLocationIdempotent(
      characterID,
      shipID,
      FUEL_BAY_FLAG,
      fuelTypeID,
      requested,
      {
        receiptKey: `${MOD_ID}:initial-fill:${characterID}:${shipID}`,
        receiptMetadata: {characterID, shipID, kind: "initial-fill"},
      },
    );
    if (!result || result.success !== true) {
      log.warn(
        `[${MOD_ID}] initial fuel failed char=${characterID} ship=${shipID} ` +
        `error=${result && result.errorMsg || "unknown"}`,
      );
      return currentFuel;
    }
    const afterFuel = this.fuelQuantity(characterID, shipID);
    character.initialFills[fillKey] = {
      completed: afterFuel >= this._config.fuelCapacityUnits,
      quantity: afterFuel,
      atMs: Date.now(),
    };
    this._ship(shipID, characterID);
    this._saveState();
    this._send(session, `Initial fuel service loaded ${requested} ${fuelDefinition.name}.`);
    return afterFuel;
  }

  _resolveWarpDestination(session, kind, target) {
    const runtime = this._getDependencies().spaceRuntime;
    const scene = runtime && runtime.getSceneForSession ? runtime.getSceneForSession(session) : null;
    const source = scene && scene.getShipEntityForSession ? scene.getShipEntityForSession(session) : null;
    const destination = kind === "entity"
      ? scene && scene.getEntityByID ? scene.getEntityByID(target) : null
      : null;
    return {
      source,
      destination,
      sourcePosition: source && source.position,
      destinationPosition: kind === "entity" ? destination && destination.position : target,
    };
  }

  _nextWarpKey(characterID, shipID) {
    const sequence = Math.max(1, Math.trunc(Number(this._state.nextWarpID) || 1));
    this._state.nextWarpID = sequence + 1;
    return `${MOD_ID}:warp:${characterID}:${shipID}:${sequence}`;
  }

  _consumeFuel(characterID, shipID, quantity, idempotencyKey, fuelTypeID = this._selectedFuelTypeID(shipID)) {
    let remaining = quantity;
    const requests = [];
    for (const item of this._fuelRows(characterID, shipID, fuelTypeID).sort((left, right) => positive(left.itemID) - positive(right.itemID))) {
      if (remaining <= 0) break;
      const available = quantityOf(item);
      const take = Math.min(remaining, available);
      if (take <= 0) continue;
      requests.push({
        itemID: item.itemID,
        quantity: take,
        expectedTypeID: fuelTypeID,
        expectedOwnerID: characterID,
        expectedLocationID: shipID,
        expectedFlagID: FUEL_BAY_FLAG,
        expectedQuantity: available,
      });
      remaining -= take;
    }
    if (remaining > 0) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_WARP_FUEL",
        data: {available: quantity - remaining, requested: quantity},
      };
    }
    const result = this._getDependencies().itemStore.consumeInventoryItemStacksAtomic(requests, {
      idempotencyKey,
    });
    return result && result.success === true
      ? {success: true, changes: result.changes || result.data && result.data.changes || []}
      : {success: false, errorMsg: result && result.errorMsg || "FUEL_CONSUMPTION_FAILED"};
  }

  prepareWarp(session, kind, target) {
    if (!this._config.enabled) return null;
    const characterID = characterIDFromSession(session);
    const shipID = shipIDFromSession(session);
    if (!characterID || !shipID || !session || !session._space) return null;
    const destination = this._resolveWarpDestination(session, kind, target);
    const meters = distanceMeters(destination.sourcePosition, destination.destinationPosition);
    const distanceAU = meters / AU_METERS;
    const fuelProfile = this._shipFuelProfile(characterID, session);
    const fuelUnits = Math.max(
      this._config.minimumWarpFuel,
      Math.ceil(distanceAU * fuelProfile.fuelUnitsPerAU),
    );
    const available = this.fuelQuantity(characterID, shipID, fuelProfile.fuelTypeID);
    if (available < fuelUnits) {
      this._send(session, `Warp blocked: ${fuelUnits} fuel units required, ${available} available.`);
      return {
        blocked: true,
        result: {
          success: false,
          errorMsg: "INSUFFICIENT_WARP_FUEL",
          data: {
            available,
            required: fuelUnits,
            distanceAU,
            shipClass: fuelProfile.shipClass,
            fuelTypeID: fuelProfile.fuelTypeID,
            fuelName: fuelProfile.fuelName,
            fuelMultiplier: fuelProfile.fuelMultiplier,
            fuelUnitsPerAU: fuelProfile.fuelUnitsPerAU,
          },
        },
      };
    }
    const key = this._nextWarpKey(characterID, shipID);
    const consumed = this._consumeFuel(characterID, shipID, fuelUnits, key, fuelProfile.fuelTypeID);
    if (!consumed.success) {
      return {
        blocked: true,
        result: {
          success: false,
          errorMsg: consumed.errorMsg || "INSUFFICIENT_WARP_FUEL",
          data: {
            available,
            required: fuelUnits,
            distanceAU,
            shipClass: fuelProfile.shipClass,
            fuelTypeID: fuelProfile.fuelTypeID,
            fuelName: fuelProfile.fuelName,
            fuelMultiplier: fuelProfile.fuelMultiplier,
            fuelUnitsPerAU: fuelProfile.fuelUnitsPerAU,
          },
        },
      };
    }
    this._saveState();
    return {
      characterID,
      shipID,
      distanceAU,
      fuelUnits,
      shipClass: fuelProfile.shipClass,
      fuelTypeID: fuelProfile.fuelTypeID,
      fuelName: fuelProfile.fuelName,
      fuelMultiplier: fuelProfile.fuelMultiplier,
      fuelUnitsPerAU: fuelProfile.fuelUnitsPerAU,
      changes: consumed.changes,
      key,
    };
  }

  finishWarp(plan, result) {
    if (!plan) return result;
    const successful = result === true || Boolean(result && result.success === true);
    if (!successful) {
      const rollback = this._getDependencies().itemStore.restoreInventoryItemChangesAtomic(plan.changes || []);
      if (!rollback || rollback.success !== true) {
        log.error(`[${MOD_ID}] failed to restore fuel after rejected warp ship=${plan.shipID}`);
      }
      this._saveState();
      return result;
    }
    const ship = this._ship(plan.shipID, plan.characterID);
    if (this._config.trackWarpOdometer) {
      ship.totalWarpAU += plan.distanceAU;
      ship.warpCount += 1;
      ship.lastWarpAtMs = Date.now();
      ship.recentWarps.unshift({
        distanceAU: plan.distanceAU,
        fuelUnits: plan.fuelUnits,
        atMs: ship.lastWarpAtMs,
      });
      ship.recentWarps = ship.recentWarps.slice(0, this._config.recentWarpLimit);
    }
    this._saveState();
    const sessionRegistry = this._getDependencies().sessionRegistry;
    const session = sessionRegistry && typeof sessionRegistry.findSessionByCharacterID === "function"
      ? sessionRegistry.findSessionByCharacterID(plan.characterID)
      : null;
    this._send(
      session,
      `Warp fuel used: ${plan.fuelUnits} units (${plan.distanceAU.toFixed(3)} AU).`,
    );
    return result;
  }

  _statusFor(characterID, session = null) {
    const ship = this._activeShip(characterID, session);
    const shipID = positive(ship && ship.itemID, shipIDFromSession(session));
    const character = this._character(characterID);
    const tracked = this._ship(shipID, characterID);
    const fuelProfile = this._shipFuelProfile(characterID, session);
    const fuel = shipID ? this.fuelQuantity(characterID, shipID, fuelProfile.fuelTypeID) : 0;
    const fuelDefinition = this._fuelDefinition(fuelProfile.fuelTypeID);
    const now = Date.now();
    return {
      schemaVersion: 2,
      enabled: this._config.enabled,
      characterID,
      shipID,
      shipName: String(ship && (ship.itemName || ship.name) || "Current Ship"),
      fuelTypeID: fuelProfile.fuelTypeID,
      fuelName: fuelProfile.fuelName,
      fuelMultiplier: fuelDefinition.burnMultiplier,
      fuelUnits: fuel,
      fuelCapacityUnits: this._config.fuelCapacityUnits,
      shipClass: fuelProfile.shipClass,
      fuelUnitsPerAU: fuelProfile.fuelUnitsPerAU,
      rangeAU: fuel / fuelProfile.fuelUnitsPerAU,
      inSpace: isInSpaceSession(session),
      totalWarpAU: tracked.totalWarpAU,
      warpCount: tracked.warpCount,
      recentWarps: tracked.recentWarps,
      emergencyCooldownSeconds: Math.max(0, Math.ceil((character.cooldownUntilMs - now) / 1000)),
      emergencyFuelUnits: this._config.emergencyFuelUnits,
      emergencyFeeISK: this._config.emergencyFeeISK,
      debtISK: character.debtISK,
      fuelTypes: this._config.fuelTypes,
    };
  }

  getStatus() {
    return {
      enabled: this._config.enabled,
      fuelTypeID: this._config.fuelTypeID,
      fuelTypes: this._config.fuelTypes,
      fuelCapacityUnits: this._config.fuelCapacityUnits,
      waypointEstimateEnabled: this._config.waypointEstimateEnabled,
      estimatedWarpAUPerGateJump: this._config.estimatedWarpAUPerGateJump,
      characters: Object.keys(this._state.characters).length,
      ships: Object.keys(this._state.ships).length,
      statePath: this._stateStore.filePath,
    };
  }

  Handle_GetStatus() {
    return marshal(this.getStatus());
  }

  Handle_GetState(_args, session) {
    const characterID = characterIDFromSession(session);
    if (!characterID) throw new Error("SHIP_WARP_FUEL_CHARACTER_REQUIRED");
    this.ensureInitialFuel(session);
    return marshal(this._statusFor(characterID, session));
  }

  Handle_GetFuelBayState(_args, session) {
    const characterID = characterIDFromSession(session);
    if (!characterID) throw new Error("SHIP_WARP_FUEL_CHARACTER_REQUIRED");
    this.ensureInitialFuel(session);
    return marshal(this._fuelBayState(characterID, session));
  }

  Handle_SetFuelType(args, session) {
    const characterID = characterIDFromSession(session);
    const ship = characterID ? this._activeShip(characterID, session) : null;
    const shipID = positive(ship && ship.itemID, shipIDFromSession(session));
    const requestedTypeID = positive(requestObject(args).fuelTypeID);
    const fuelDefinition = this._fuelDefinition(requestedTypeID);
    const isConfigured = (this._config.fuelTypes || []).some((entry) =>
      positive(entry && entry.typeID) === requestedTypeID,
    );
    if (!characterID || !shipID) throw new Error("SHIP_WARP_FUEL_SHIP_REQUIRED");
    if (!isConfigured) throw new Error("SHIP_WARP_FUEL_TYPE_NOT_SUPPORTED");
    const tracked = this._ship(shipID, characterID);
    tracked.fuelTypeID = requestedTypeID;
    this._saveState();
    this._send(session, `Active warp fuel changed to ${fuelDefinition.name}.`);
    return marshal(this._statusFor(characterID, session));
  }

  Handle_GetWaypointFuelEstimate(args, session) {
    const characterID = characterIDFromSession(session);
    const ship = characterID ? this._activeShip(characterID, session) : null;
    const shipID = positive(ship && ship.itemID, shipIDFromSession(session));
    if (!characterID || !shipID) throw new Error("SHIP_WARP_FUEL_SHIP_REQUIRED");
    const request = requestObject(args);
    const profile = this._shipFuelProfile(characterID, session);
    const hasRoute = request.hasRoute === true;
    const jumps = Math.max(0, Math.trunc(Number(request.jumps) || 0));
    const requestedAU = Number(request.estimatedWarpAU);
    const estimatedWarpAU = Number.isFinite(requestedAU) && requestedAU >= 0
      ? requestedAU
      : jumps * this._config.estimatedWarpAUPerGateJump;
    const fuelRequired = hasRoute
      ? Math.max(0, Math.ceil(estimatedWarpAU * profile.fuelUnitsPerAU))
      : 0;
    const fuelAvailable = this.fuelQuantity(characterID, shipID, profile.fuelTypeID);
    return marshal({
      enabled: this._config.enabled && this._config.waypointEstimateEnabled,
      hasRoute,
      jumps,
      estimatedWarpAU,
      fuelRequired,
      fuelAvailable,
      fuelAfterRoute: fuelAvailable - fuelRequired,
      deficit: Math.max(0, fuelRequired - fuelAvailable),
      shipClass: profile.shipClass,
      fuelTypeID: profile.fuelTypeID,
      fuelName: profile.fuelName,
      fuelMultiplier: profile.fuelMultiplier,
      fuelUnitsPerAU: profile.fuelUnitsPerAU,
      estimatePerGateJump: this._config.estimatedWarpAUPerGateJump,
    });
  }

  Handle_LoadFuel(args, session) {
    const request = requestObject(args);
    const fuelTypeID = this._selectedFuelTypeID(shipIDFromSession(session));
    const result = this._moveFuelBetweenBays(session, "load", request.quantity);
    if (result.moved > 0) {
      this._emitInventoryChanges(session, result.changes);
      this._send(session, `Loaded ${result.moved} ${this._fuelDefinition(fuelTypeID).name} into the fuel bay.`);
    }
    return marshal({...result, fuelTypeID, fuelName: this._fuelDefinition(fuelTypeID).name});
  }

  Handle_UnloadFuel(args, session) {
    const request = requestObject(args);
    const fuelTypeID = this._selectedFuelTypeID(shipIDFromSession(session));
    const result = this._moveFuelBetweenBays(session, "unload", request.quantity);
    if (result.moved > 0) {
      this._emitInventoryChanges(session, result.changes);
      this._send(session, `Moved ${result.moved} ${this._fuelDefinition(fuelTypeID).name} from the fuel bay into cargo.`);
    }
    return marshal({...result, fuelTypeID, fuelName: this._fuelDefinition(fuelTypeID).name});
  }

  _serviceShipScene(serviceShip) {
    if (serviceShip && serviceShip.scene) return serviceShip.scene;
    const runtime = this._getDependencies().spaceRuntime;
    if (
      runtime &&
      typeof runtime.findSceneContainingDynamicEntity === "function" &&
      serviceShip
    ) {
      return runtime.findSceneContainingDynamicEntity(serviceShip.serviceShipID) || null;
    }
    return null;
  }

  async _bringServiceShipToPlayer(serviceShip) {
    const scene = this._serviceShipScene(serviceShip);
    if (
      !scene ||
      typeof scene.startSessionlessWarpIngress !== "function" ||
      typeof scene.getEntityByID !== "function"
    ) {
      return false;
    }

    const target = scene.getEntityByID(serviceShip.targetShipID);
    const targetPoint = vector(target && target.position) || serviceShip.arrivalPoint;
    if (!targetPoint) return false;

    const range = this._config.serviceShipApproachRangeMeters;
    const warpStopDistance = Math.max(range * 4, 20000);
    const warpResult = scene.startSessionlessWarpIngress(
      serviceShip.serviceShipID,
      targetPoint,
      {
        // Land outside the delivery range so the service ship visibly flies
        // the final distance instead of appearing beside the player.
        stopDistance: warpStopDistance,
        forceImmediateStart: true,
        ingressDurationMs: 2500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!warpResult || warpResult.success !== true) {
      log.warn(
        `[${MOD_ID}] service ship warp-in failed request=${serviceShip.requestID} ` +
        `error=${warpResult && warpResult.errorMsg || "unknown"}`,
      );
      return false;
    }

    const deadline = Date.now() + this._config.serviceShipApproachTimeoutMs;
    while (Date.now() < deadline) {
      const current = scene.getEntityByID(serviceShip.serviceShipID);
      const currentTarget = scene.getEntityByID(serviceShip.targetShipID);
      if (!current || !currentTarget) return false;
      const currentDistance = distanceMeters(current.position, currentTarget.position);
      const stillWarping =
        current.mode === "WARP" ||
        current.pendingWarp ||
        current.warpState ||
        current.sessionlessWarpIngress;
      if (!stillWarping) {
        if (currentDistance <= range) return true;
        if (typeof scene.followShipEntity === "function") {
          const followResult = scene.followShipEntity(
            serviceShip.serviceShipID,
            serviceShip.targetShipID,
            range,
          );
          if (followResult === false) return false;
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    while (Date.now() < deadline) {
      const current = scene.getEntityByID(serviceShip.serviceShipID);
      const currentTarget = scene.getEntityByID(serviceShip.targetShipID);
      if (!current || !currentTarget) return false;
      if (distanceMeters(current.position, currentTarget.position) <= range) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  async _cleanupServiceShipAfterDeparture(serviceShip) {
    if (this._config.serviceShipDepartureDelayMs > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        this._config.serviceShipDepartureDelayMs,
      ));
    }
    const scene = this._serviceShipScene(serviceShip);
    const deadline = Date.now() + this._config.serviceShipApproachTimeoutMs;
    while (
      scene &&
      typeof scene.getEntityByID === "function" &&
      Date.now() < deadline
    ) {
      const current = scene.getEntityByID(serviceShip.serviceShipID);
      if (!current) return;
      const stillWarping =
        current.mode === "WARP" ||
        current.pendingWarp ||
        current.warpState ||
        current.sessionlessWarpIngress;
      if (!stillWarping) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this._removeServiceShip(serviceShip);
  }

  _sendServiceShipAway(serviceShip) {
    const scene = this._serviceShipScene(serviceShip);
    if (
      !scene ||
      typeof scene.startSessionlessWarpIngress !== "function" ||
      !serviceShip.departurePoint
    ) {
      this._removeServiceShip(serviceShip);
      return;
    }

    const warpResult = scene.startSessionlessWarpIngress(
      serviceShip.serviceShipID,
      serviceShip.departurePoint,
      {
        forceImmediateStart: true,
        ingressDurationMs: 2500,
        visibilitySuppressMs: 250,
        broadcastWarpStartToVisibleSessions: true,
      },
    );
    if (!warpResult || warpResult.success !== true) {
      log.debug(
        `[${MOD_ID}] service ship warp-out failed request=${serviceShip.requestID}; removing it`,
      );
      this._removeServiceShip(serviceShip);
      return;
    }

    void this._cleanupServiceShipAfterDeparture(serviceShip).catch((error) => {
      log.debug(`[${MOD_ID}] service ship departure cleanup failed: ${error.message}`);
      this._removeServiceShip(serviceShip);
    });
  }

  async _spawnServiceShip(session, characterID, requestID) {
    const runtime = this._getDependencies().spaceRuntime;
    const ship = this._activeShip(characterID, session);
    const systemID = positive(session && session._space && session._space.systemID, 0);
    const scene = runtime && runtime.getSceneForSession ? runtime.getSceneForSession(session) : null;
    const entity = scene && scene.getShipEntityForSession ? scene.getShipEntityForSession(session) : null;
    if (!systemID || !ship || !entity) return null;
    const origin = vector(entity.position) || {x: 0, y: 0, z: 0};
    const rawDirection = vector(entity.direction) || {x: 1, y: 0, z: 0};
    const directionLength = Math.hypot(rawDirection.x, rawDirection.y, rawDirection.z) || 1;
    const spawnDistance = this._config.serviceShipSpawnDistanceAU * AU_METERS;
    const position = {
      x: origin.x + (rawDirection.x / directionLength) * spawnDistance,
      y: origin.y + (rawDirection.y / directionLength) * spawnDistance,
      z: origin.z + (rawDirection.z / directionLength) * spawnDistance,
    };
    const created = this._getDependencies().itemStore.createSpaceItemForCharacter(
      characterID,
      systemID,
      this._config.serviceShipTypeID,
      {
        position,
        mode: "STOP",
        customInfo: `${MOD_ID}:${requestID}`,
        expiresAtMs: Date.now() + this._config.serviceShipLifetimeMs,
      },
    );
    if (!created || created.success !== true || !created.data) return null;
    const serviceShipID = positive(created.data.itemID);
    const spawned = runtime.spawnDynamicInventoryEntity(
      scene.sceneDescriptor || systemID,
      serviceShipID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
        broadcast: true,
        broadcastOptions: {freshAcquire: true},
      },
    );
    if (!spawned || spawned.success !== true) {
      log.warn(`[${MOD_ID}] service ship spawn failed request=${requestID}`);
      return null;
    }
    return {
      serviceShipID,
      systemID,
      requestID,
      scene,
      targetShipID: positive(entity.itemID, shipIDFromSession(session)),
      arrivalPoint: origin,
      departurePoint: position,
    };
  }

  _removeServiceShip(serviceShip) {
    if (!serviceShip) return;
    try {
      this._getDependencies().spaceRuntime.destroyDynamicInventoryEntity(
        serviceShip.systemID,
        serviceShip.serviceShipID,
        {broadcast: true},
      );
    } catch (error) {
      log.debug(`[${MOD_ID}] service ship cleanup failed: ${error.message}`);
    }
  }

  async _chargeEmergency(characterID, request, shipID) {
    const fee = roundMoney(request.feeISK);
    if (fee <= 0) return {chargedISK: 0, debtISK: 0};
    const walletState = this._getDependencies().walletState;
    const wallet = walletState && typeof walletState.getCharacterWallet === "function"
      ? walletState.getCharacterWallet(characterID)
      : null;
    const available = Math.max(0, finite(wallet && wallet.balance, 0));
    const requested = Math.min(fee, available);
    let chargedISK = 0;
    if (requested > 0 && walletState && typeof walletState.adjustCharacterBalanceAsync === "function") {
      const key = `${MOD_ID}:emergency:${characterID}:${request.id}:fee`;
      try {
        const result = await walletState.adjustCharacterBalanceAsync(
          characterID,
          -requested,
          {
            idempotencyKey: key,
            description: "Emergency warp fuel service",
            entryTypeID: walletState.JOURNAL_ENTRY_TYPE && walletState.JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
            ownerID1: characterID,
            ownerID2: shipID,
            referenceID: shipID,
          },
          {commandID: key, source: MOD_ID},
        );
        if (result && result.success === true) chargedISK = requested;
      } catch (error) {
        log.warn(`[${MOD_ID}] emergency fuel charge failed char=${characterID}: ${error.message}`);
      }
    }
    return {chargedISK, debtISK: roundMoney(fee - chargedISK)};
  }

  async _requestEmergencyFuel(session) {
    if (!this._config.enabled) throw new Error("SHIP_WARP_FUEL_DISABLED");
    const characterID = characterIDFromSession(session);
    const shipID = shipIDFromSession(session);
    if (!characterID || !shipID || !isInSpaceSession(session)) {
      throw new Error("EMERGENCY_FUEL_REQUIRES_SPACE");
    }
    const character = this._character(characterID);
    const now = Date.now();
    if (character.cooldownUntilMs > now) {
      throw new Error("EMERGENCY_FUEL_COOLDOWN");
    }
    const fuelTypeID = this._selectedFuelTypeID(shipID);
    const fuelDefinition = this._fuelDefinition(fuelTypeID);
    if (this.fuelQuantity(characterID, shipID, fuelTypeID) > 0) {
      throw new Error("EMERGENCY_FUEL_NOT_NEEDED");
    }
    const requestID = Math.max(1, Math.trunc(Number(this._state.nextEmergencyID) || 1));
    this._state.nextEmergencyID = requestID + 1;
    character.cooldownUntilMs = now + this._config.emergencyCooldownSeconds * 1000;
    const request = {
      id: requestID,
      status: "pending",
      shipID,
      systemID: positive(session._space.systemID),
      fuelTypeID,
      fuelUnits: this._config.emergencyFuelUnits,
      feeISK: this._config.emergencyFeeISK,
      chargedISK: 0,
      debtISK: 0,
      createdAtMs: now,
      completedAtMs: 0,
    };
    character.emergencyRequests[String(requestID)] = request;
    this._saveState();

    const serviceShip = await this._spawnServiceShip(session, characterID, requestID);
    if (serviceShip) {
      this._send(session, "Emergency fuel ship is on the way.");
      await this._bringServiceShipToPlayer(serviceShip);
    }
    if (this._config.serviceShipDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this._config.serviceShipDelayMs));
    }
    const grant = this._getDependencies().itemStore.grantItemToOwnerLocationIdempotent(
      characterID,
      shipID,
      FUEL_BAY_FLAG,
      fuelTypeID,
      this._config.emergencyFuelUnits,
      {
        receiptKey: `${MOD_ID}:emergency:${characterID}:${requestID}:fuel`,
        receiptMetadata: {characterID, shipID, requestID, kind: "emergency-fuel"},
      },
    );
    if (!grant || grant.success !== true) {
      request.status = "failed";
      character.cooldownUntilMs = 0;
      this._saveState();
      this._removeServiceShip(serviceShip);
      throw new Error(`EMERGENCY_FUEL_DELIVERY_FAILED:${grant && grant.errorMsg || "unknown"}`);
    }

    const charge = await this._chargeEmergency(characterID, request, shipID);
    request.status = "claimed";
    request.chargedISK = charge.chargedISK;
    request.debtISK = charge.debtISK;
    request.completedAtMs = Date.now();
    character.debtISK = roundMoney(character.debtISK + charge.debtISK);
    this._saveState();
    this._send(
      session,
      `Emergency fuel delivered: ${request.fuelUnits} ${fuelDefinition.name}. ` +
      `Charged ${charge.chargedISK.toFixed(MAX_MONEY_DECIMALS)} ISK` +
      (charge.debtISK > 0 ? `; ${charge.debtISK.toFixed(MAX_MONEY_DECIMALS)} ISK added to fuel-service debt.` : "."),
    );
    if (serviceShip) {
      this._sendServiceShipAway(serviceShip);
    }
    return this._statusFor(characterID, session);
  }

  Handle_RequestEmergencyFuel(_args, session) {
    const characterID = characterIDFromSession(session);
    if (this._settlingEmergency.has(characterID)) throw new Error("EMERGENCY_FUEL_REQUEST_IN_PROGRESS");
    this._settlingEmergency.add(characterID);
    return this._requestEmergencyFuel(session)
      .then((state) => marshal(state))
      .finally(() => this._settlingEmergency.delete(characterID));
  }

  async _collectDebts() {
    if (!this._config.enabled) return;
    const walletState = this._getDependencies().walletState;
    if (!walletState || typeof walletState.getCharacterWallet !== "function" ||
        typeof walletState.adjustCharacterBalanceAsync !== "function") return;
    for (const [characterID, character] of Object.entries(this._state.characters)) {
      if (!(character.debtISK > 0)) continue;
      const wallet = walletState.getCharacterWallet(Number(characterID));
      const available = Math.max(0, finite(wallet && wallet.balance, 0));
      if (!(available > 0)) continue;
      const pending = character.pendingDebtCollection;
      const sequence = Math.max(1, character.debtSequence + 1);
      const pendingAmount = pending && pending.amount > 0 ? pending.amount : 0;
      const amount = pendingAmount > 0
        ? pendingAmount
        : Math.min(available, character.debtISK);
      if (pendingAmount > available) continue;
      const key = pending && pending.key
        ? pending.key
        : `${MOD_ID}:debt:${characterID}:${sequence}`;
      character.pendingDebtCollection = {key, amount: roundMoney(amount)};
      this._saveState();
      try {
        const result = await walletState.adjustCharacterBalanceAsync(
          Number(characterID),
          -amount,
          {
            idempotencyKey: key,
            description: "Emergency warp fuel debt collection",
            entryTypeID: walletState.JOURNAL_ENTRY_TYPE && walletState.JOURNAL_ENTRY_TYPE.ADMIN_ADJUSTMENT,
            ownerID1: Number(characterID),
            referenceID: Number(characterID),
          },
          {commandID: key, source: MOD_ID},
        );
        if (result && result.success === true) {
          character.debtISK = roundMoney(character.debtISK - amount);
          character.debtSequence = sequence;
          character.pendingDebtCollection = null;
          this._saveState();
          const sessionRegistry = this._getDependencies().sessionRegistry;
          const session = sessionRegistry && sessionRegistry.findSessionByCharacterID
            ? sessionRegistry.findSessionByCharacterID(Number(characterID))
            : null;
          this._send(session, `Collected ${amount.toFixed(MAX_MONEY_DECIMALS)} ISK of emergency fuel debt.`);
        }
      } catch (error) {
        log.warn(`[${MOD_ID}] debt collection failed char=${characterID}: ${error.message}`);
      }
    }
  }
}

module.exports = ShipWarpFuelService;
module.exports._testing = {
  AU_METERS,
  classifyShip,
  distanceMeters,
  quantityOf,
  characterIDFromSession,
  shipIDFromSession,
  stationIDFromSession,
  isInSpaceSession,
};
