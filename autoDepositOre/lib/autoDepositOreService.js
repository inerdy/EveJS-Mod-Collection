"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const itemCustody = require(serverPath("services", "inventory", "itemCustody"));
const {resolveSessionCharacterID} = require(
  serverPath("services", "_shared", "sessionIdentity"),
);
const log = require(serverPath("utils", "logger"));

const STATE_VERSION = 1;
const MOD_STATE_DIR = path.join(database._dataDir, "autoDepositOre");
const STATE_PATH = path.join(MOD_STATE_DIR, "state.json");
const ITEM_FLAGS = itemStore.ITEM_FLAGS;
const MINING_HOLD_FLAGS = Object.freeze([
  ITEM_FLAGS.GENERAL_MINING_HOLD,
  ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD,
  ITEM_FLAGS.SPECIALIZED_GAS_HOLD,
  ITEM_FLAGS.SPECIALIZED_ICE_HOLD,
]);

let chatHub = null;

function getChatHub() {
  if (!chatHub) {
    chatHub = require(serverPath("services", "chat", "chatHub"));
  }
  return chatHub;
}

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (parsed && parsed.schemaVersion === STATE_VERSION && parsed.characters) {
      return parsed;
    }
  } catch (_) {
    // Missing or incomplete state starts with the documented default.
  }
  return {schemaVersion: STATE_VERSION, characters: {}};
}

function writeState(state) {
  fs.mkdirSync(MOD_STATE_DIR, {recursive: true});
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporaryPath, STATE_PATH);
}

function characterState(state, characterID) {
  const key = String(characterID);
  if (!state.characters[key] || typeof state.characters[key] !== "object") {
    state.characters[key] = {enabled: true};
  }
  const character = state.characters[key];
  if (typeof character.enabled !== "boolean") {
    character.enabled = true;
  }
  return character;
}

function requestObject(args) {
  const request = Array.isArray(args) ? args[0] : args;
  return request && typeof request === "object" ? request : {};
}

function sessionCharacterID(session) {
  return positive(resolveSessionCharacterID(session));
}

function dockLocationID(session, requestedLocationID, result) {
  const record = result && result.data && result.data.station;
  return positive(
    session && (
      session.stationID || session.stationid ||
      session.structureID || session.structureid
    ) ||
    record && (record.stationID || record.structureID || record.itemID) ||
    requestedLocationID,
  );
}

function dockLocationName(locationID, result) {
  const record = result && result.data && result.data.station;
  return String(
    record && (record.stationName || record.itemName || record.name) ||
    `Location ${locationID}`,
  );
}

function itemQuantity(item) {
  return Math.max(1, Math.trunc(Number(item && (item.quantity || item.stacksize)) || 1));
}

function itemVolume(item) {
  return Math.max(0, Number(item && item.volume) || 0) * itemQuantity(item);
}

class AutoDepositOreService extends BaseService {
  constructor() {
    super("autoDepositOre");
    this._state = readState();
  }

  _stateResponse(characterID) {
    const character = characterState(this._state, characterID);
    return JSON.stringify({
      schemaVersion: STATE_VERSION,
      characterID,
      enabled: character.enabled === true,
    });
  }

  Handle_GetState(args, session) {
    const characterID = sessionCharacterID(session);
    if (!characterID) {
      throw new Error("AUTO_DEPOSIT_ORE_CHARACTER_REQUIRED");
    }
    return this._stateResponse(characterID);
  }

  Handle_SetEnabled(args, session) {
    const characterID = sessionCharacterID(session);
    if (!characterID) {
      throw new Error("AUTO_DEPOSIT_ORE_CHARACTER_REQUIRED");
    }
    const request = requestObject(args);
    const character = characterState(this._state, characterID);
    character.enabled = request.enabled !== false;
    writeState(this._state);
    log.info(
      `[AutoDepositOre] char=${characterID} enabled=${character.enabled}`,
    );
    return this._stateResponse(characterID);
  }

  _sendSummary(session, message) {
    if (!session || !message) {
      return;
    }
    try {
      getChatHub().sendSystemMessage(session, `[Auto Deposit Ore] ${message}`);
    } catch (error) {
      log.debug(`[AutoDepositOre] chat summary failed: ${error.message}`);
    }
  }

  handleDockSuccess(session, requestedLocationID, result) {
    if (!result || result.success !== true) {
      return {success: false, skipped: true, reason: "dock-failed"};
    }
    const characterID = sessionCharacterID(session);
    if (!characterID) {
      return {success: false, skipped: true, reason: "character-missing"};
    }
    const character = characterState(this._state, characterID);
    if (character.enabled !== true) {
      return {success: true, skipped: true, reason: "disabled"};
    }

    const locationID = dockLocationID(session, requestedLocationID, result);
    const ship = itemStore.getActiveShipItem(characterID);
    if (!locationID || !ship || Number(ship.ownerID) !== characterID) {
      return {success: false, skipped: true, reason: "docked-ship-missing"};
    }

    const items = MINING_HOLD_FLAGS.flatMap((flagID) =>
      itemStore.listContainerItems(characterID, ship.itemID, flagID),
    );
    const summary = {
      movedStacks: 0,
      movedQuantity: 0,
      movedVolume: 0,
      failedStacks: 0,
    };
    const dockSequence = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const item of items) {
      const quantity = itemQuantity(item);
      const transferResult = itemCustody.transfer({
        items: [{itemID: item.itemID, quantity}],
        from: itemCustody.custodyRef.shipBay(
          characterID,
          ship.itemID,
          item.flagID,
        ),
        to: itemCustody.custodyRef.ownerLocation(
          characterID,
          locationID,
          ITEM_FLAGS.HANGAR,
        ),
        reason: itemCustody.CUSTODY_REASON.INV_BROKER_MOVE,
        actor: characterID,
        idempotencyKey: `auto-deposit-ore:${characterID}:${ship.itemID}:${locationID}:${dockSequence}:${item.itemID}`,
      });
      if (transferResult && transferResult.success === true) {
        summary.movedStacks += 1;
        summary.movedQuantity += quantity;
        summary.movedVolume += itemVolume(item);
      } else {
        summary.failedStacks += 1;
        log.warn(
          `[AutoDepositOre] char=${characterID} item=${item.itemID} ` +
            `deposit failed: ${transferResult && transferResult.errorMsg || "unknown error"}`,
        );
      }
    }

    const locationName = dockLocationName(locationID, result);
    if (summary.movedStacks || summary.failedStacks) {
      this._sendSummary(
        session,
        `Docked at ${locationName}: moved ${summary.movedQuantity} mining items ` +
          `(${summary.movedVolume.toFixed(1)} m3) to your personal hangar.` +
          (summary.failedStacks
            ? ` ${summary.failedStacks} stack(s) could not be moved.`
            : ""),
      );
    } else {
      this._sendSummary(session, `Docked at ${locationName}: no mining output to deposit.`);
    }
    return {success: summary.failedStacks === 0, ...summary};
  }
}

module.exports = AutoDepositOreService;
module.exports._testing = {
  MINING_HOLD_FLAGS,
  characterState,
  dockLocationID,
  itemQuantity,
};
