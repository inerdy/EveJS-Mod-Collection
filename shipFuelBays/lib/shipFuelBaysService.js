"use strict";

const path = require("node:path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "src",
  "services",
  "_shared",
  "referenceData",
));
const itemStore = require(path.join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "src",
  "services",
  "inventory",
  "itemStore",
));
const {loadConfig} = require("./config");

const SHIP_CATEGORY_ID = 6;
const FUEL_BAY_ATTRIBUTE_ID = 1549;
const DECORATION_MARKER = Symbol.for("evejs.shipFuelBays.decoration");

function finite(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function positive(value) {
  const result = finite(value, 0);
  return result > 0 ? result : 0;
}

function typeIDFrom(value) {
  return Math.max(
    0,
    Math.trunc(
      finite(
        value && typeof value === "object"
          ? value.typeID || value.itemTypeID
          : value,
        0,
      ),
    ),
  );
}

function attributesForType(root, typeID) {
  if (!root || typeof root !== "object") return null;
  const numericTypeID = String(typeID);
  const record =
    (root.shipAttributesByTypeID && root.shipAttributesByTypeID[numericTypeID]) ||
    (root.typesByTypeID && root.typesByTypeID[numericTypeID]);
  return record && record.attributes && typeof record.attributes === "object"
    ? record.attributes
    : null;
}

class ShipFuelBaysService {
  constructor(config = loadConfig()) {
    this.config = config;
    this._infoCache = new Map();
  }

  nativeFuelBayCapacity(typeID) {
    const numericTypeID = typeIDFrom(typeID);
    if (!numericTypeID) return 0;

    const shipDogma = attributesForType(
      readStaticTable(TABLE.SHIP_DOGMA_ATTRIBUTES),
      numericTypeID,
    );
    const shipCapacity = positive(shipDogma && shipDogma["1549"]);
    if (shipCapacity > 0) return shipCapacity;

    const typeDogma = attributesForType(
      readStaticTable(TABLE.TYPE_DOGMA),
      numericTypeID,
    );
    return positive(typeDogma && typeDogma["1549"]);
  }

  baseCargoCapacity(shipItem) {
    const numericTypeID = typeIDFrom(shipItem);
    if (!numericTypeID) return 0;

    const metadata = itemStore.getItemMetadata(numericTypeID);
    const metadataCapacity = positive(metadata && metadata.capacity);
    if (metadataCapacity > 0) return metadataCapacity;

    return positive(shipItem && shipItem.capacity);
  }

  getFuelBayInfo(shipItem) {
    const numericTypeID = typeIDFrom(shipItem);
    if (!numericTypeID) return null;
    if (this._infoCache.has(numericTypeID)) {
      return this._infoCache.get(numericTypeID);
    }

    const metadata = itemStore.getItemMetadata(numericTypeID);
    const categoryID = Math.trunc(
      finite(
        shipItem && shipItem.categoryID !== undefined
          ? shipItem.categoryID
          : metadata && metadata.categoryID,
        0,
      ),
    );
    if (categoryID !== SHIP_CATEGORY_ID) {
      this._infoCache.set(numericTypeID, null);
      return null;
    }

    const nativeCapacity = this.nativeFuelBayCapacity(numericTypeID);
    const baseCargoCapacity = this.baseCargoCapacity(shipItem);
    const info = {
      typeID: numericTypeID,
      name: String((shipItem && shipItem.name) || (metadata && metadata.name) || "Ship"),
      nativeCapacity,
      baseCargoCapacity,
      added: nativeCapacity <= 0 && baseCargoCapacity >= this.config.minimumCapacityM3,
      capacityM3: baseCargoCapacity,
    };
    this._infoCache.set(numericTypeID, info);
    return info;
  }

  _applyCapacity(resourceState, info) {
    if (!resourceState || typeof resourceState !== "object" || !info || !info.added) {
      return resourceState;
    }

    const attributes = resourceState.attributes && typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : {};
    attributes["1549"] = info.capacityM3;
    resourceState.attributes = attributes;
    resourceState.specialFuelBayCapacity = info.capacityM3;
    Object.defineProperty(resourceState, DECORATION_MARKER, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: info,
    });
    return resourceState;
  }

  reapplyMarkedResourceState(resourceState) {
    if (!this.config.enabled || !resourceState || typeof resourceState !== "object") {
      return resourceState;
    }
    return this._applyCapacity(resourceState, resourceState[DECORATION_MARKER] || null);
  }

  decorateResourceState(resourceState, shipItem) {
    if (!this.config.enabled || !resourceState || typeof resourceState !== "object") {
      return resourceState;
    }

    const info = this.getFuelBayInfo(shipItem);
    return this._applyCapacity(resourceState, info);
  }

  _decorateAttributes(attributes, info) {
    if (!attributes || typeof attributes !== "object" || !info || !info.added) {
      return attributes;
    }
    attributes["1549"] = info.capacityM3;
    return attributes;
  }

  decorateFittingSnapshot(snapshot) {
    if (!this.config.enabled || !snapshot || typeof snapshot !== "object") {
      return snapshot;
    }

    const roots = [snapshot];
    if (snapshot.snapshot && typeof snapshot.snapshot === "object") {
      roots.push(snapshot.snapshot);
    }
    for (const root of roots) {
      const shipItem = root.shipItem || snapshot.shipItem;
      const info = this.getFuelBayInfo(shipItem);
      this.decorateResourceState(root.resourceState, shipItem);
      this._decorateAttributes(root.shipAttributes, info);
      this._decorateAttributes(root.trackedShipAttributes, info);
    }
    return snapshot;
  }
}

module.exports = {
  DECORATION_MARKER,
  FUEL_BAY_ATTRIBUTE_ID,
  SHIP_CATEGORY_ID,
  ShipFuelBaysService,
};
