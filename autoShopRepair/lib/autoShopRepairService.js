"use strict";

const fsPath = require("node:path");
const REPO_ROOT = fsPath.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => fsPath.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const repairRuntime = require(serverPath("services", "station", "repairRuntime"));
const liveFittingState = require(serverPath("services", "fitting", "liveFittingState"));
const {resolveSessionCharacterID} = require(serverPath("services", "_shared", "sessionIdentity"));
const {unwrapMarshalValue} = require(serverPath("services", "_shared", "serviceHelpers"));
const {syncDamageStateAttributesForSession} = require(serverPath("services", "character", "characterState"));
const log = require(serverPath("utils", "logger"));
const {createStore} = require("./state");

const store = createStore(fsPath.join(database._dataDir, "autoShopRepair", "state.json"));
const lanes = new Map();
let chatHub = null;

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function decodeArgs(args, kwargs) {
  const candidate = Array.isArray(args) ? args[0] : args;
  const value = unwrapMarshalValue(candidate || kwargs || {});
  return value && typeof value === "object" ? value : {};
}

function notify(session, message) {
  if (!session || !message) return;
  try {
    if (!chatHub) {
      chatHub = require(serverPath("services", "chat", "chatHub"));
    }
    chatHub.sendSystemMessage(session, `[Auto Shop Repair] ${String(message)}`);
  } catch (error) {
    log.warn(`[autoShopRepair] notification failed: ${error.message}`);
  }
}

function syncChanges(session, changes) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change && change.item) {
      syncDamageStateAttributesForSession(
        session,
        change.item,
        change.previousData || change.previousState || {},
      );
    }
  }
}

class AutoShopRepairService extends BaseService {
  constructor() {
    super("autoShopRepair");
  }

  Handle_GetSettings(args, session) {
    const characterID = positive(resolveSessionCharacterID(session));
    return JSON.stringify({enabled: characterID > 0 ? store.getEnabled(characterID) : true});
  }

  Handle_SetEnabled(args, session, kwargs) {
    const characterID = positive(resolveSessionCharacterID(session));
    if (!characterID) return JSON.stringify({enabled: true});
    const payload = decodeArgs(args, kwargs);
    const enabled = payload.enabled !== false;
    return JSON.stringify({enabled: store.setEnabled(characterID, enabled)});
  }

  onDocked(session, stationID) {
    const characterID = positive(resolveSessionCharacterID(session));
    const normalizedStationID = positive(stationID);
    if (!characterID || !normalizedStationID || !store.getEnabled(characterID)) {
      return Promise.resolve({success: false, skipped: true});
    }

    const previous = lanes.get(characterID) || Promise.resolve();
    const current = previous.then(() => this._repairAfterDocking(
      session,
      characterID,
      normalizedStationID,
    ));
    lanes.set(characterID, current.catch(() => undefined));
    return current;
  }

  async _repairAfterDocking(session, characterID, stationID) {
    const context = repairRuntime.resolveRepairContext(session);
    if (!context.success || !context.data || context.data.dockedKind !== "station" ||
        positive(context.data.dockedLocationID) !== stationID) {
      return {success: false, skipped: true};
    }

    const ship = itemStore.getActiveShipItem(characterID);
    const shipID = positive(ship && ship.itemID);
    if (!ship || positive(ship.locationID) !== stationID) {
      return {success: false, skipped: true};
    }

    const modules = liveFittingState.getFittedModuleItems(characterID, shipID);
    const references = [shipID, ...modules.map((item) => positive(item && item.itemID))]
      .filter((itemID, index, all) => itemID > 0 && all.indexOf(itemID) === index);
    const result = await repairRuntime.repairItemsInStation(session, references);
    if (!result || result.success !== true) {
      if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
        notify(session, "Auto repair skipped: you do not have enough ISK to repair this ship and its fitted modules.");
      } else if (result && result.errorMsg) {
        log.warn(`[autoShopRepair] repair failed for character=${characterID}: ${result.errorMsg}`);
      }
      return result || {success: false, errorMsg: "REPAIR_FAILED"};
    }

    syncChanges(session, result.data && result.data.changes);
    const charged = Number(result.data && (result.data.chargedAmount || result.data.totalCost) || 0);
    if (charged > 0) {
      notify(session, `Auto repair completed for ${references.length} item${references.length === 1 ? "" : "s"}. Cost: ${charged.toFixed(2)} ISK.`);
    }
    return result;
  }
}

module.exports = AutoShopRepairService;
