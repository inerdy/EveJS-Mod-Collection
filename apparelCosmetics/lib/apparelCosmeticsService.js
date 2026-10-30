"use strict";

const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(process.env.EVEJS_ROOT || path.resolve(__dirname, "..", "..", ".."));
const SERVER_ROOT = fs.existsSync(path.join(REPO_ROOT, "server", "src"))
  ? path.join(REPO_ROOT, "server", "src")
  : path.join(REPO_ROOT, "EveJS-261028.1", "server", "src");
const serverPath = (...segments) => path.join(SERVER_ROOT, ...segments);
const BaseService = require(serverPath("services", "baseService"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const characterState = require(serverPath("services", "character", "characterState"));
const chatHub = require(serverPath("services", "chat", "chatHub"));
const {resolveSessionCharacterID} = require(serverPath("services", "_shared", "sessionIdentity"));
const {resolveDataRootPath} = require(serverPath("config", "dataRoot"));
const {createStateStore, normalizeCharacter} = require("./state");
const {loadConfig} = require("./config");

const SERVICE_NAME = "apparelCosmetics";
const MOD_ID = "apparelCosmetics";

function positive(value, fallback = 0) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return positive(value.value, fallback);
  }
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : fallback;
}

function characterID(session) {
  return positive(resolveSessionCharacterID(session));
}

function sameOwner(item, ownerID) {
  return positive(item && item.ownerID) === positive(ownerID);
}

class ApparelCosmeticsService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._stateStore = options.stateStore || createStateStore(
      resolveDataRootPath("gameStore", MOD_ID, "state.json"),
    );
    this._state = this._stateStore.load();
  }

  _character(characterIDValue) {
    const key = String(positive(characterIDValue));
    if (!this._state.characters[key]) {
      this._state.characters[key] = normalizeCharacter({});
    }
    return this._state.characters[key];
  }

  _save() {
    this._stateStore.save(this._state);
  }

  isEligibleType(typeID) {
    if (!this._config.enabled) return false;
    const metadata = itemStore.getItemMetadata(typeID);
    return Boolean(
      metadata &&
      positive(metadata.typeID) === positive(typeID) &&
      positive(metadata.categoryID) === this._config.apparelCategoryID &&
      this._config.apparelGroupIDs.includes(positive(metadata.groupID)),
    );
  }

  isUnlocked(characterIDValue, typeID) {
    const character = this._state.characters[String(positive(characterIDValue))];
    return Boolean(character && character.unlockedByTypeID[String(positive(typeID))]);
  }

  _collectEligibleTypeIDs(payload) {
    const typeIDs = new Set();
    const visited = new Set();
    const walk = (value) => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        if (/typeid|type_id|typeid$/i.test(key)) {
          const typeID = positive(entry);
          if (typeID && this.isEligibleType(typeID)) typeIDs.add(typeID);
        }
        walk(entry);
      }
    };
    walk(payload);
    return [...typeIDs];
  }

  migrateLegacyAppearance(characterIDValue) {
    const characterIDValueNormalized = positive(characterIDValue);
    if (!characterIDValueNormalized || typeof characterState.getCharacterRecord !== "function") return [];

    const record = this._character(characterIDValueNormalized);
    if (record.legacyMigratedAt > 0) return [];

    const characterRecord = characterState.getCharacterRecord(characterIDValueNormalized);
    const payload = characterRecord && (
      characterRecord.appearanceInfo ??
      characterRecord.charInfo ??
      characterRecord.paperDollData ??
      null
    );
    const typeIDs = this._collectEligibleTypeIDs(payload);
    const migratedAt = Date.now();
    for (const typeID of typeIDs) {
      const key = String(typeID);
      if (!record.unlockedByTypeID[key]) {
        record.unlockedByTypeID[key] = {activatedAt: migratedAt, sourceItemID: 0};
      }
    }
    this._ensurePhysicalApparel(characterIDValueNormalized, typeIDs, characterRecord);
    record.legacyMigratedAt = migratedAt;
    this._save();
    return typeIDs;
  }

  _ensurePhysicalApparel(characterIDValue, typeIDs, characterRecord = null) {
    if (typeof itemStore.grantItemToCharacterStationHangar !== "function") return [];
    const stationID = positive(
      characterRecord && (
        characterRecord.stationID ??
        characterRecord.homeStationID ??
        characterRecord.cloneStationID
      ),
    );
    if (!stationID) return [];

    const ownedItems = itemStore.listCharacterItems(characterIDValue, {
      categoryID: this._config.apparelCategoryID,
    });
    const existingAtStation = new Set(
      ownedItems
        .filter((item) =>
          positive(item && item.locationID) === stationID &&
          positive(item && item.flagID) === 4,
        )
        .map((item) => positive(item.typeID)),
    );
    const createdTypeIDs = [];
    for (const typeID of typeIDs) {
      if (!this.isUnlocked(characterIDValue, typeID) || existingAtStation.has(typeID)) continue;
      const result = itemStore.grantItemToCharacterStationHangar(
        characterIDValue,
        stationID,
        typeID,
        1,
      );
      if (result && result.success === true) {
        existingAtStation.add(typeID);
        createdTypeIDs.push(typeID);
      }
    }
    return createdTypeIDs;
  }

  repairSavedAppearance(characterIDValue) {
    const characterIDValueNormalized = positive(characterIDValue);
    if (!characterIDValueNormalized || typeof characterState.getCharacterRecord !== "function") return [];
    this.migrateLegacyAppearance(characterIDValueNormalized);
    const characterRecord = characterState.getCharacterRecord(characterIDValueNormalized);
    const payload = characterRecord && (
      characterRecord.appearanceInfo ??
      characterRecord.charInfo ??
      characterRecord.paperDollData ??
      null
    );
    const typeIDs = this._collectEligibleTypeIDs(payload)
      .filter((typeID) => this.isUnlocked(characterIDValueNormalized, typeID));
    return this._ensurePhysicalApparel(
      characterIDValueNormalized,
      typeIDs,
      characterRecord,
    );
  }

  validateAppearance(characterIDValue, payload) {
    if (positive(characterIDValue)) this.migrateLegacyAppearance(characterIDValue);
    const lockedTypeIDs = [];
    for (const typeID of this._collectEligibleTypeIDs(payload)) {
      if (!this.isUnlocked(characterIDValue, typeID)) {
        lockedTypeIDs.push(typeID);
        continue;
      }
      this._ensurePhysicalApparel(
        positive(characterIDValue),
        [typeID],
        characterState.getCharacterRecord(positive(characterIDValue)),
      );
    }
    return [...new Set(lockedTypeIDs)];
  }

  listOwnedApparel(session) {
    const characterIDValue = characterID(session);
    const items = itemStore.listCharacterItems(characterIDValue, {
      categoryID: this._config.apparelCategoryID,
    });
    return items
      .filter((item) => this.isEligibleType(item.typeID) && !this.isUnlocked(characterIDValue, item.typeID))
      .sort((left, right) => positive(left.itemID) - positive(right.itemID));
  }

  _notify(session, message) {
    try {
      chatHub.sendSystemMessage(session, `[Apparel] ${message}`);
    } catch (_error) {
      // A notification failure must not undo a committed activation.
    }
  }

  listCommand(session) {
    const items = this.listOwnedApparel(session);
    if (items.length === 0) return "You have no unactivated apparel items.";
    return [
      "Unactivated apparel:",
      ...items.map((item) => {
        const metadata = itemStore.getItemMetadata(item.typeID);
        return `${item.itemID}: ${metadata.name || item.itemName || `Type ${item.typeID}`} (type ${item.typeID})`;
      }),
      "Use /apparel activate <itemID> to activate one.",
    ].join("\n");
  }

  activateCommand(session, rawItemID) {
    const itemID = positive(rawItemID);
    const characterIDValue = characterID(session);
    if (!itemID || !characterIDValue) return {success: false, message: "A valid inventory item ID is required."};

    const item = itemStore.findItemById(itemID);
    if (!item || !sameOwner(item, characterIDValue)) {
      return {success: false, message: "That inventory item does not belong to this character."};
    }
    if (!this.isEligibleType(item.typeID)) {
      return {success: false, message: "That item is not an eligible apparel cosmetic."};
    }
    if (this.isUnlocked(characterIDValue, item.typeID)) {
      return {success: false, message: "That apparel cosmetic is already activated."};
    }

    const consumed = itemStore.consumeInventoryItemQuantity(itemID, 1);
    if (!consumed || consumed.success !== true) {
      return {success: false, message: `The apparel item could not be consumed (${consumed && consumed.errorMsg || "unknown error"}).`};
    }

    const record = this._character(characterIDValue);
    record.unlockedByTypeID[String(positive(item.typeID))] = {
      activatedAt: Date.now(),
      sourceItemID: itemID,
    };
    this._save();

    if (consumed.data && Array.isArray(consumed.data.changes)) {
      characterState.emitItemsChangedBatchForSession(session, consumed.data.changes);
    }
    const metadata = itemStore.getItemMetadata(item.typeID);
    const name = metadata.name || item.itemName || `Type ${item.typeID}`;
    this._notify(session, `${name} activated permanently.`);
    return {success: true, message: `${name} activated permanently.`};
  }

  getUnlockedTypeIDs(characterIDValue) {
    const character = this._state.characters[String(positive(characterIDValue))];
    return character ? Object.keys(character.unlockedByTypeID).map(Number) : [];
  }
}

module.exports = ApparelCosmeticsService;
