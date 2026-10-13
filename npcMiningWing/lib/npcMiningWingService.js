"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {serverPath} = require("./npcMiningWingHost");
const miningTrace = require("./npcMiningWingMiningTrace").install();
const droneBridge = require("./npcMiningWingDroneBridge");
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const itemStore = require(serverPath("services", "inventory", "itemStore"));
const worldData = require(serverPath("space", "worldData"));
const {canEntitiesInteractLocally} = require(
  serverPath("space", "destiny", "identity", "interactionScope"),
);
const {canShipDockAtStation} = require(
  serverPath("space", "runtime", "stationDockingGeometry"),
);
const { resolveSessionCharacterID } = require(serverPath("services", "_shared", "sessionIdentity"));
const { unwrapMarshalValue } = require(serverPath("services", "_shared", "serviceHelpers"));
const log = require(serverPath("utils", "logger"));
const {
  clearCollectionTripRetry,
  deferCollectionTrip,
  markCollectionUnavailableStates,
  miningHandoffIsReady,
  nextRuntimeFailure,
  runtimeFailureIsCoolingDown,
  serializePersistentMiningStates,
  serializePersistentState,
} = require("./npcMiningWingState");
const {
  buildStationLaunchSpaceState,
} = require("./npcMiningWingMovement");
const WING_CHAT_DISPLAY_NAME = "Wing Comms";
const WING_CHAT_MOTD = "NPC Mining Wing communications.";
const WING_CHAT_BACKLOG_LIMIT = 50;

const STATE_VERSION = 2;
const MOD_STATE_DIR = path.join(database._dataDir, "npcMiningWing");
const STATE_PATH = path.join(MOD_STATE_DIR, "state.json");
let lastPersistedStateText = "";
let corruptStateBackupCreated = false;
const FOLLOW_RANGE_METERS = 2500;
const GATE_TRANSIT_MS = 4000;
const GATE_SPAWN_DISTANCE_METERS = 30000;
const MINING_RETRY_MS = 1000;
const MINING_RANGE_BUFFER_METERS = 500;
const MINING_ORBIT_DISTANCE_METERS = 1000;
const CARGO_TRANSFER_RANGE_METERS = 5000;
const CARGO_FOLLOW_RANGE_METERS = 2500;
// Six total ships are supported: five mining ships and one collection ship.
const MAX_WING_SHIPS = 6;
const MAX_MINING_SHIPS = 5;
const DRONE_RETRY_MS = 1000;
const DRONE_CATEGORY_ID = 18;
const DRONE_COMMAND_MINE = "MINE";
const DRONE_COMMAND_ENGAGE = "ENGAGE";
const DRONE_COMMAND_RETURN_BAY = "RETURN_BAY";
const DEFENSE_TRACE_ENV = "NPC_MINING_WING_DEFENSE_TRACE";
const WING_DRONE_MARKER_PREFIX = "npcMiningWing:ship=";
const COMMANDS = new Set([
  "follow",
  "hold",
  "mine",
]);
const STATE_COMMANDS = new Set(["follow", "hold", "mine", "return", "dock"]);
const SUPPORTED_ACTIONS = Object.freeze([
  "deploy",
  "setCollection",
  "sendCollection",
  "follow",
  "hold",
  "mine",
  "recall",
  "collect",
]);
const RUNTIME_TICK_MS = 500;

function defenseDiagnosticsEnabled() {
  return ["1", "true", "on", "enabled"].includes(
    String(process.env[DEFENSE_TRACE_ENV] || "").trim().toLowerCase(),
  );
}

let spaceRuntime = null;
let liveFittingState = null;
let miningDogma = null;
let miningRuntimeState = null;
let miningInventory = null;
let droneRuntime = null;
let droneRuntimeDiscoveryLogged = false;
let droneRuntimeLoadFailureLogged = false;
let itemCustody = null;
let skillState = null;
let characterStateService = null;
let sessionRegistry = null;
let chatHub = null;
let chatRuntime = null;
let nativeMiningCycleDiagnosticsAttempted = false;

const CHAT_COMMAND_METHODS = new Set([
  "SetShipMarked",
  "SetCollectionShip",
  "SetWingCommand",
  "DeployWing",
  "RecallWing",
  "SendCollectionShip",
  "TransferCargo",
]);
const MUTATING_COMMAND_METHODS = CHAT_COMMAND_METHODS;

const PILOT_FIRST_NAMES = Object.freeze([
  "Mira",
  "Jalen",
  "Tessa",
  "Kara",
  "Riven",
  "Sera",
  "Darius",
  "Nika",
]);

const PILOT_LAST_NAMES = Object.freeze([
  "Voss",
  "Cross",
  "Vale",
  "Rake",
  "Marek",
  "Quill",
  "Sato",
  "Drake",
]);

const CARGO_FLAGS = new Set([
  itemStore.ITEM_FLAGS.CARGO_HOLD,
  itemStore.ITEM_FLAGS.GENERAL_MINING_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_GAS_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_ICE_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_MINERAL_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_SALVAGE_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_SHIP_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_SMALL_SHIP_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_MEDIUM_SHIP_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_LARGE_SHIP_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_INDUSTRIAL_SHIP_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_AMMO_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_COMMAND_CENTER_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_PLANETARY_COMMODITIES_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_FUEL_BAY,
  itemStore.ITEM_FLAGS.SPECIALIZED_MATERIAL_BAY,
  itemStore.ITEM_FLAGS.FLEET_HANGAR,
  itemStore.ITEM_FLAGS.EXPEDITION_HOLD,
]);

const CARGO_STATUS_FLAGS = new Set([
  itemStore.ITEM_FLAGS.CARGO_HOLD,
  itemStore.ITEM_FLAGS.GENERAL_MINING_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_GAS_HOLD,
  itemStore.ITEM_FLAGS.SPECIALIZED_ICE_HOLD,
]);

function getSpaceRuntime() {
  if (!spaceRuntime) {
    // Load lazily so registering this optional service cannot participate in
    // the space-runtime startup dependency cycle.
    spaceRuntime = require(serverPath("space", "runtime"));
  }
  return spaceRuntime;
}

function getLiveFittingState() {
  if (!liveFittingState) {
    liveFittingState = require(
      serverPath("services", "fitting", "liveFittingState"),
    );
  }
  return liveFittingState;
}

function getMiningDogma() {
  if (!miningDogma) {
    miningDogma = require(serverPath("services", "mining", "miningDogma"));
  }
  return miningDogma;
}

function getMiningRuntimeState() {
  if (!miningRuntimeState) {
    miningRuntimeState = require(
      serverPath("services", "mining", "miningRuntimeState"),
    );
  }
  return miningRuntimeState;
}

function getMiningInventory() {
  if (!miningInventory) {
    miningInventory = require(serverPath("services", "mining", "miningInventory"));
  }
  return miningInventory;
}

function getDroneRuntime() {
  if (!droneRuntime) {
    const modulePath = serverPath("services", "drone", "droneRuntime");
    let loadedRuntime;
    try {
      loadedRuntime = require(modulePath);
    } catch (error) {
      if (!droneRuntimeLoadFailureLogged) {
        droneRuntimeLoadFailureLogged = true;
        miningTrace.log("drone.runtime.load_failed", {
          modulePath,
          error: String(error && error.message || error).slice(0, 300),
        });
      }
      throw error;
    }
    try {
      // Patch this exact export as a fallback when another module loader has
      // replaced the bridge's Module._load wrapper before EveJS loads it.
      droneRuntime = droneBridge.patchDroneRuntime(loadedRuntime, modulePath);
    } catch (error) {
      miningTrace.log("drone.runtime.patch_failed", {
        modulePath,
        error: String(error && error.message || error).slice(0, 300),
      });
      throw error;
    }
    if (!droneRuntimeDiscoveryLogged) {
      droneRuntimeDiscoveryLogged = true;
      if (miningTrace.enabled) {
        miningTrace.log("drone.runtime.discovery", summarizeDroneRuntime(droneRuntime, modulePath));
      }
    }
  }
  return droneRuntime;
}

function summarizeDroneRuntime(runtime, modulePath) {
  const wingMethods = [
    "launchDronesForWingShip",
    "commandEngageForWingShip",
    "commandMineForWingShip",
    "commandReturnBayForWingShip",
    "registerNpcMiningWingHiveShip",
    "getNpcMiningWingGroupAggression",
    "resolveWingDroneCapabilities",
  ];
  const nativeMethods = [
    "launchDronesForSession",
    "commandEngage",
    "commandMineRepeatedly",
    "commandReturnBay",
    "noteIncomingAggression",
  ];
  const summary = {
    modulePath,
    present: Boolean(runtime),
    bridgePatched: false,
    wingMethodTypes: {},
    nativeMethodTypes: {},
    exportKeys: [],
  };
  if (!runtime || !["object", "function"].includes(typeof runtime)) {
    return summary;
  }
  try {
    summary.bridgePatched = Boolean(
      runtime[Symbol.for("evejs.npcMiningWing.droneBridgeRuntimePatched")],
    );
  } catch (error) {
    summary.bridgeMarkerError = String(error && error.message || error).slice(0, 200);
  }
  for (const method of wingMethods) {
    try {
      summary.wingMethodTypes[method] = typeof runtime[method];
    } catch (_) {
      summary.wingMethodTypes[method] = "throws";
    }
  }
  for (const method of nativeMethods) {
    try {
      summary.nativeMethodTypes[method] = typeof runtime[method];
    } catch (_) {
      summary.nativeMethodTypes[method] = "throws";
    }
  }
  try {
    summary.exportKeys = Object.keys(runtime).sort().slice(0, 48);
  } catch (error) {
    summary.exportKeysError = String(error && error.message || error).slice(0, 200);
  }
  return summary;
}

function getItemCustody() {
  if (!itemCustody) {
    itemCustody = require(serverPath("services", "inventory", "itemCustody"));
  }
  return itemCustody;
}

function wingDroneMarker(shipID) {
  return `${WING_DRONE_MARKER_PREFIX}${positive(shipID)}`;
}

function wingDroneMarkerShipID(item) {
  const match = new RegExp(
    `(?:^|;)${WING_DRONE_MARKER_PREFIX}(\\d+)(?:;|$)`,
  ).exec(String(item && item.customInfo || ""));
  return positive(match && match[1]);
}

function markWingDroneCustomInfo(item, shipID) {
  const marker = wingDroneMarker(shipID);
  const current = String(item && item.customInfo || "");
  if (current.split(";").includes(marker)) {
    return current;
  }
  return current ? `${current};${marker}` : marker;
}

function getSkillState() {
  if (!skillState) {
    skillState = require(serverPath("services", "skills", "skillState"));
  }
  return skillState;
}

function getCharacterStateService() {
  if (!characterStateService) {
    characterStateService = require(
      serverPath("services", "character", "characterState"),
    );
  }
  return characterStateService;
}

function getSessionRegistry() {
  if (!sessionRegistry) {
    sessionRegistry = require(serverPath("services", "chat", "sessionRegistry"));
  }
  return sessionRegistry;
}

function getChatHub() {
  if (!chatHub) {
    chatHub = require(serverPath("services", "chat", "chatHub"));
  }
  return chatHub;
}

function getChatRuntime() {
  if (!chatRuntime) {
    chatRuntime = require(serverPath("_secondary", "chat", "chatRuntime"));
  }
  return chatRuntime;
}

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generatedPilotName(shipID) {
  const numericShipID = positive(shipID);
  const firstName = PILOT_FIRST_NAMES[numericShipID % PILOT_FIRST_NAMES.length];
  const lastName = PILOT_LAST_NAMES[
    Math.floor(numericShipID / PILOT_FIRST_NAMES.length) % PILOT_LAST_NAMES.length
  ];
  return `${firstName} ${lastName}`;
}

function pilotNameForShip(character, shipID) {
  const key = String(positive(shipID));
  const storedName = character && character.pilotNames && character.pilotNames[key];
  return String(storedName || generatedPilotName(shipID));
}

function holdName(flagID) {
  switch (Number(flagID)) {
    case itemStore.ITEM_FLAGS.GENERAL_MINING_HOLD:
      return "Mining Hold";
    case itemStore.ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD:
      return "Ore Hold";
    case itemStore.ITEM_FLAGS.SPECIALIZED_GAS_HOLD:
      return "Gas Hold";
    case itemStore.ITEM_FLAGS.SPECIALIZED_ICE_HOLD:
      return "Ice Hold";
    case itemStore.ITEM_FLAGS.CARGO_HOLD:
    default:
      return "Cargo Hold";
  }
}

const ERROR_MESSAGES = Object.freeze({
  NPC_WING_CHARACTER_REQUIRED: "No active character session is available.",
  NPC_WING_NOT_IN_SPACE: "You must be in space for this command.",
  NPC_WING_LEADER_NOT_FOUND: "Your active ship could not be found.",
  NPC_WING_COMMAND_NOT_READY: "That wing command is not available.",
  NPC_WING_NO_DEPLOYED_SHIPS: "No wing ships are currently deployed.",
  NPC_WING_MAX_SHIPS_EXCEEDED: `A wing can contain no more than ${MAX_WING_SHIPS} NPC ships.`,
  NPC_WING_NO_MARKED_SHIPS: "No ships are marked for wing duty.",
  NPC_WING_CANNOT_DEPLOY_DURING_WARP: "The wing cannot deploy while you are in warp.",
  NPC_WING_CANNOT_RECALL_DURING_WARP: "The wing cannot recall while you are in warp.",
  NPC_WING_SHIP_NOT_FOUND: "The requested ship could not be found.",
  NPC_WING_SHIP_NOT_DEPLOYED: "That ship is not deployed in the wing.",
  NPC_WING_SHIP_NOT_IN_CURRENT_SYSTEM: "The wing ship is not in your current system.",
  NPC_WING_SHIP_IN_OTHER_SYSTEM: "That ship is already deployed in another system.",
  NPC_WING_SHIP_NOT_IN_CHARACTER_HANGAR: "That ship must be in your station hangar first.",
  NPC_WING_ACTIVE_SHIP_CANNOT_JOIN_WING: "Your active ship cannot join its own wing.",
  NPC_WING_ACTIVE_SHIP_NOT_FOUND: "Your active ship could not be found.",
  NPC_WING_ENTITY_ID_COLLISION: "The wing ship could not be placed in space safely.",
  NPC_WING_SPAWN_FAILED: "The wing ship could not be spawned in space.",
  NPC_WING_COMMAND_FAILED: "The server could not apply that wing command.",
  NPC_WING_CARGO_DURING_WARP: "Cargo cannot be transferred while you are in warp.",
  NPC_WING_CARGO_ENTITY_NOT_FOUND: "The wing ship is not available for local cargo transfer.",
  NPC_WING_CARGO_OUT_OF_RANGE: "You are too far away from the wing ship.",
  NPC_WING_CARGO_EMPTY: "That wing ship has no transferable cargo.",
  NPC_WING_DESTINATION_HOLD_FULL: "The appropriate hold on your active ship is full.",
  NPC_WING_MINING_HOLD_FULL: "The mining hold has no room for another mining cycle.",
  NPC_WING_DESTINATION_HOLD_UNAVAILABLE: "Your active ship does not have a suitable hold for that item.",
  NPC_WING_RECALL_ENTITY_NOT_FOUND: "The wing ship could not be found for recall.",
  NPC_WING_RETURN_STATION_NOT_FOUND: "The wing ship has no saved return station.",
  NPC_WING_RETURN_STATION_UNKNOWN: "The wing ship's saved return station is unknown.",
  NPC_WING_RETURN_STATION_NOT_IN_CURRENT_SYSTEM: "The saved return station is not in the current system.",
  NPC_WING_RECALL_SYSTEM_UNKNOWN: "The wing ship's current system is unknown.",
  NPC_WING_RECALL_ROUTE_NOT_FOUND: "No stargate route to the return station could be found.",
  NPC_WING_COLLECTION_SHIP_REQUIRED: "Select a collection ship first.",
  NPC_WING_COLLECTION_SHIP_NOT_MARKED: "The collection ship must be marked for wing duty.",
  NPC_WING_COLLECTION_SHIP_NOT_DEPLOYED: "The collection ship is not deployed in the wing.",
  NPC_WING_COLLECTION_TRIP_ACTIVE: "The collection ship is already traveling to or from its station.",
  NPC_WING_COLLECTION_STATION_NOT_FOUND: "The collection ship has no valid station destination.",
  NPC_WING_COLLECTION_NOT_IN_SPACE: "The collection ship must be deployed in space first.",
  NPC_WING_COLLECTION_UNAVAILABLE: "The collection ship is not available for cargo transfer.",
  NPC_WING_COLLECTION_ROUTE_UNAVAILABLE: "No usable route is currently available for the collection ship.",
  NPC_WING_COLLECTION_SCENE_UNAVAILABLE: "The collection ship is waiting for its destination scene.",
  NPC_WING_COLLECTION_DOCK_PENDING: "The collection ship is still approaching its station.",
  NPC_WING_COLLECTION_RETURN_PENDING: "The collection ship is waiting for the wing to become available.",
  NPC_WING_OPERATION_IN_PROGRESS: "Another wing command is still being processed.",
  NPC_WING_COLLECTION_REQUIRED_FOR_FULL_WING: "A six-ship wing needs one ship assigned as the collection ship before mining.",
});

function friendlyErrorMessage(error) {
  const rawMessage = String(error && error.message || error || "Command failed");
  const separator = rawMessage.indexOf(":");
  const code = separator >= 0 ? rawMessage.slice(0, separator) : rawMessage;
  const detail = separator >= 0 ? rawMessage.slice(separator + 1).trim() : "";
  if (ERROR_MESSAGES[code]) {
    if (detail && code.endsWith("FAILED")) {
      return `${ERROR_MESSAGES[code]} (${detail}).`;
    }
    return ERROR_MESSAGES[code];
  }
  return rawMessage
    .replace(/^NPC_WING_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase()) + ".";
}

function preserveInvalidState(reason) {
  if (
    corruptStateBackupCreated ||
    !fs.existsSync(STATE_PATH)
  ) {
    return;
  }
  const backupPath = `${STATE_PATH}.corrupt-${Date.now()}-${process.pid}`;
  try {
    fs.copyFileSync(STATE_PATH, backupPath);
    corruptStateBackupCreated = true;
    log.warn(
      `[NPCMiningWing] invalid state preserved at ${backupPath}: ${reason}`,
    );
  } catch (backupError) {
    log.warn(
      `[NPCMiningWing] invalid state backup failed: ${backupError.message}`,
    );
  }
}

function readState() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (error) {
    if (
      error &&
      error.code !== "ENOENT"
    ) {
      preserveInvalidState(error.message);
    }
    return {schemaVersion: STATE_VERSION, characters: {}};
  }
  if (
    parsed &&
    parsed.characters &&
    (parsed.schemaVersion === STATE_VERSION || parsed.schemaVersion === 1)
  ) {
    // Version 2 only formalizes the migration boundary. characterState()
    // remains responsible for normalizing each character's fields.
    parsed.schemaVersion = STATE_VERSION;
    return parsed;
  }
  preserveInvalidState(`unsupported schema version ${String(parsed && parsed.schemaVersion || "unknown")}`);
  return {schemaVersion: STATE_VERSION, characters: {}};
}

function writeState(state) {
  fs.mkdirSync(MOD_STATE_DIR, {recursive: true});
  const serialized = serializePersistentState(state);
  if (serialized === lastPersistedStateText && fs.existsSync(STATE_PATH)) {
    return false;
  }
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, serialized, "utf8");
  try {
    fs.renameSync(temporaryPath, STATE_PATH);
  } catch (error) {
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error && error.code)) {
      throw error;
    }
    // Windows can reject a rename over an existing file. The copy fallback is
    // less atomic, but it preserves the newest complete JSON snapshot and
    // removes the temporary file after the destination is written.
    fs.copyFileSync(temporaryPath, STATE_PATH);
    fs.unlinkSync(temporaryPath);
  }
  lastPersistedStateText = serialized;
  return true;
}

function characterState(state, characterID) {
  const key = String(characterID);
  if (!state.characters[key] || typeof state.characters[key] !== "object") {
    state.characters[key] = {
      revision: 0,
      markedShipIDs: [],
      command: "hold",
      deployed: false,
      deployedShipIDs: [],
      collectionShipID: 0,
      collectionTrip: {
        active: false,
        phase: "idle",
        shipID: 0,
        stationID: 0,
        currentSystemID: 0,
        targetSystemID: 0,
        readyAtMs: 0,
        failureCount: 0,
        lastError: "",
      },
      returnLocationIDs: {},
      recallStationIDs: {},
      dockingStationIDs: {},
      recallTransit: {},
      followTransit: {},
      launchTransit: {},
      miningShipStates: {},
      hiveDefenseOverrides: {},
      pilotNames: {},
      wingChatRoomName: "",
      wingChatChannelID: 0,
      recalling: false,
      dockingWithLeader: false,
    };
  }
  const character = state.characters[key];
  if (!Array.isArray(character.markedShipIDs)) {
    character.markedShipIDs = [];
  }
  if (!Array.isArray(character.deployedShipIDs)) {
    character.deployedShipIDs = [];
  }
  character.collectionShipID = positive(character.collectionShipID);
  if (
    !character.collectionTrip ||
    typeof character.collectionTrip !== "object" ||
    Array.isArray(character.collectionTrip)
  ) {
    character.collectionTrip = {
      active: false,
      phase: "idle",
      shipID: 0,
      stationID: 0,
      currentSystemID: 0,
      targetSystemID: 0,
      readyAtMs: 0,
      failureCount: 0,
      lastError: "",
    };
  }
  character.collectionTrip.active = character.collectionTrip.active === true;
  character.collectionTrip.phase = String(
    character.collectionTrip.phase ||
      (character.collectionTrip.active ? "outbound" : "idle"),
  );
  character.collectionTrip.shipID = positive(character.collectionTrip.shipID);
  character.collectionTrip.stationID = positive(character.collectionTrip.stationID);
  character.collectionTrip.currentSystemID = positive(
    character.collectionTrip.currentSystemID,
  );
  character.collectionTrip.targetSystemID = positive(
    character.collectionTrip.targetSystemID,
  );
  character.collectionTrip.readyAtMs = Math.max(
    0,
    finite(character.collectionTrip.readyAtMs, 0),
  );
  character.collectionTrip.failureCount = Math.max(
    0,
    Math.trunc(Number(character.collectionTrip.failureCount) || 0),
  );
  character.collectionTrip.lastError = typeof character.collectionTrip.lastError === "string"
    ? character.collectionTrip.lastError
    : "";
  if (
    !character.returnLocationIDs ||
    typeof character.returnLocationIDs !== "object" ||
    Array.isArray(character.returnLocationIDs)
  ) {
    character.returnLocationIDs = {};
  }
  if (
    !character.recallStationIDs ||
    typeof character.recallStationIDs !== "object" ||
    Array.isArray(character.recallStationIDs)
  ) {
    character.recallStationIDs = {};
  }
  if (
    !character.dockingStationIDs ||
    typeof character.dockingStationIDs !== "object" ||
    Array.isArray(character.dockingStationIDs)
  ) {
    character.dockingStationIDs = {};
  }
  if (
    !character.recallTransit ||
    typeof character.recallTransit !== "object" ||
    Array.isArray(character.recallTransit)
  ) {
    character.recallTransit = {};
  }
  if (
    !character.followTransit ||
    typeof character.followTransit !== "object" ||
    Array.isArray(character.followTransit)
  ) {
    character.followTransit = {};
  }
  if (
    !character.launchTransit ||
    typeof character.launchTransit !== "object" ||
    Array.isArray(character.launchTransit)
  ) {
    character.launchTransit = {};
  }
  if (
    !character.miningShipStates ||
    typeof character.miningShipStates !== "object" ||
    Array.isArray(character.miningShipStates)
  ) {
    character.miningShipStates = {};
  }
  if (
    !character.hiveDefenseOverrides ||
    typeof character.hiveDefenseOverrides !== "object" ||
    Array.isArray(character.hiveDefenseOverrides)
  ) {
    character.hiveDefenseOverrides = {};
  }
  if (
    !character.pilotNames ||
    typeof character.pilotNames !== "object" ||
    Array.isArray(character.pilotNames)
  ) {
    character.pilotNames = {};
  }
  character.wingChatRoomName = typeof character.wingChatRoomName === "string"
    ? character.wingChatRoomName.trim()
    : "";
  character.wingChatChannelID = positive(character.wingChatChannelID);
  character.recalling = character.recalling === true;
  character.dockingWithLeader = character.dockingWithLeader === true;
  if (!STATE_COMMANDS.has(String(character.command || "").trim().toLowerCase())) {
    character.command = "hold";
  }
  return character;
}

function sessionCharacterID(session) {
  return positive(resolveSessionCharacterID(session));
}

function currentShipID(session) {
  return positive(
    session && session._space && session._space.shipID ||
      session && (session.shipID || session.shipid || session.activeShipID),
  );
}

function currentSystemID(session) {
  return positive(
    session && session._space && session._space.systemID ||
      session && (session.solarsystemid2 || session.solarsystemid),
  );
}

function currentSpaceSystemID(session) {
  return positive(session && session._space && session._space.systemID);
}

function dockedLocationID(session) {
  return positive(
    session && (
      session.stationid ||
      session.stationID ||
      session.structureid ||
      session.structureID
    ),
  );
}

function dockableLocation(locationID) {
  const numericLocationID = positive(locationID);
  if (!numericLocationID) {
    return null;
  }
  return worldData.getStationByID(numericLocationID) ||
    worldData.getStructureByID(numericLocationID) ||
    null;
}

function dockableSystemID(location) {
  return positive(
    location && (
      location.solarSystemID ||
      location.solarsystemid ||
      location.systemID
    ),
  );
}

function dockableLocationName(locationID) {
  const location = dockableLocation(locationID);
  return String(
    location && (
      location.stationName ||
      location.itemName ||
      location.name ||
      location.locationName
    ) || "",
  );
}

function dockableLocationSystemName(locationID) {
  const location = dockableLocation(locationID);
  return String(
    location && (
      location.solarSystemName ||
      solarSystemName(dockableSystemID(location))
    ) || "",
  );
}

function solarSystemName(systemID) {
  const system = worldData.getSolarSystemByID(positive(systemID));
  return String(system && system.solarSystemName || "");
}

function shipSystemID(item) {
  return positive(
    item && item.spaceState && item.spaceState.systemID ||
      item && Number(item.flagID) === 0 && item.locationID,
  );
}

function shipPosition(item) {
  return item && item.spaceState && item.spaceState.position
    ? vector(item.spaceState.position, {x: 0, y: 0, z: 0})
    : null;
}

function itemQuantity(item) {
  if (!item) {
    return 0;
  }
  return Number(item.singleton) === 1
    ? 1
    : Math.max(0, positive(item.stacksize || item.quantity));
}

function isCargoItem(item) {
  return Boolean(item && CARGO_FLAGS.has(Number(item.flagID)));
}

function isMiningOutputItem(item) {
  if (!item || !isCargoItem(item)) {
    return false;
  }
  if (
    Number(item.flagID) !== itemStore.ITEM_FLAGS.CARGO_HOLD &&
    CARGO_STATUS_FLAGS.has(Number(item.flagID))
  ) {
    return true;
  }
  try {
    return getMiningInventory().isMiningMaterialType(positive(item.typeID));
  } catch (_) {
    return false;
  }
}

function wingMembershipIDs(character) {
  return [...new Set([
    ...(character && Array.isArray(character.markedShipIDs)
      ? character.markedShipIDs
      : []),
    ...(character && Array.isArray(character.deployedShipIDs)
      ? character.deployedShipIDs
      : []),
  ].map(positive).filter(Boolean))];
}

function cargoItemsForShip(characterID, shipID) {
  return itemStore
    .listContainerItems(characterID, shipID, null)
    .filter(isCargoItem);
}

function cargoSummary(characterID, shipID, flags = CARGO_STATUS_FLAGS) {
  let quantity = 0;
  let volume = 0;
  for (const item of cargoItemsForShip(characterID, shipID)) {
    if (flags && !flags.has(Number(item.flagID))) {
      continue;
    }
    const units = itemQuantity(item);
    quantity += units;
    volume += units * Math.max(0, finite(
      itemStore.getInventoryItemUnitVolume(item),
      0,
    ));
  }
  let capacity = 0;
  try {
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    const fitting = getLiveFittingState();
    const fittedItems = fitting.getFittedModuleItems(characterID, shipID);
    const skillMap = getSkillState().getCachedCharacterSkillMap(characterID);
    const resourceState = fitting.buildShipResourceState(characterID, ship, {
      fittedItems,
      skillMap,
    });
    capacity = Math.max(0, finite(resourceState && resourceState.cargoCapacity, 0));
    const miningInventory = getMiningInventory();
    const holdDefinitions = Array.isArray(miningInventory.MINING_HOLD_DEFINITIONS)
      ? miningInventory.MINING_HOLD_DEFINITIONS
      : [];
    for (const definition of holdDefinitions) {
      capacity += Math.max(
        0,
        finite(
          miningInventory.getShipHoldCapacityByFlag(resourceState, definition.flagID),
          0,
        ),
      );
    }
  } catch (_) {
    capacity = 0;
  }
  return {
    quantity,
    volume: Math.round(volume * 1000) / 1000,
    capacity: Math.round(capacity * 1000) / 1000,
    percent: capacity > 0
      ? Math.min(100, Math.round((volume / capacity) * 1000) / 10)
      : 0,
  };
}

function distanceBetween(left, right) {
  const first = vector(left, {x: 0, y: 0, z: 0});
  const second = vector(right, {x: 0, y: 0, z: 0});
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  const dz = first.z - second.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function surfaceDistanceBetween(left, right) {
  const leftPosition = left && left.position ? left.position : left;
  const rightPosition = right && right.position ? right.position : right;
  return Math.max(
    0,
    distanceBetween(leftPosition, rightPosition) -
      Math.max(0, finite(left && left.radius, 0)) -
      Math.max(0, finite(right && right.radius, 0)),
  );
}

function buildGateSpaceState(systemID, gate, index = 0) {
  const gatePosition = vector(gate && gate.position, {x: 0, y: 0, z: 0});
  const direction = normalizedVector(
    gate && gate.position,
    {x: 1, y: 0, z: 0},
  );
  return {
    systemID,
    position: {
      x: gatePosition.x - direction.x * GATE_SPAWN_DISTANCE_METERS,
      y: gatePosition.y - direction.y * GATE_SPAWN_DISTANCE_METERS + index * 500,
      z: gatePosition.z - direction.z * GATE_SPAWN_DISTANCE_METERS,
    },
    velocity: {x: 0, y: 0, z: 0},
    direction,
    targetPoint: gatePosition,
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: FOLLOW_RANGE_METERS,
    orbitDistance: 0,
  };
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function vector(value, fallback) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: finite(source && source.x, fallback.x),
    y: finite(source && source.y, fallback.y),
    z: finite(source && source.z, fallback.z),
  };
}

function normalizedVector(value, fallback) {
  const candidate = vector(value, fallback);
  const length = Math.sqrt(
    candidate.x * candidate.x +
      candidate.y * candidate.y +
      candidate.z * candidate.z,
  );
  if (!Number.isFinite(length) || length < 0.0001) {
    return {...fallback};
  }
  return {
    x: candidate.x / length,
    y: candidate.y / length,
    z: candidate.z / length,
  };
}

function isShipInSystem(item, systemID) {
  return Boolean(
    item &&
      Number(item.flagID) === 0 &&
      positive(item.locationID) === systemID &&
      item.spaceState &&
      positive(item.spaceState.systemID) === systemID,
  );
}

function buildCompanionSpaceState(systemID, leader, index) {
  const fallbackDirection = {x: 1, y: 0, z: 0};
  const direction = normalizedVector(leader && leader.direction, fallbackDirection);
  const leaderPosition = vector(leader && leader.position, {x: 0, y: 0, z: 0});
  const distance = 2500 + index * 1000;
  const position = {
    x: leaderPosition.x - direction.x * distance,
    y: leaderPosition.y - direction.y * distance + index * 500,
    z: leaderPosition.z - direction.z * distance,
  };
  return {
    systemID,
    position,
    velocity: {x: 0, y: 0, z: 0},
    direction,
    targetPoint: position,
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: FOLLOW_RANGE_METERS,
    orbitDistance: 0,
  };
}

function serializeShip(
  item,
  markedShipIDs,
  deployedShipIDs,
  returningShipIDs,
  character,
  systemID,
) {
  const shipID = positive(item && item.itemID);
  const deployed = deployedShipIDs.has(shipID) && Number(item && item.flagID) === 0;
  const deployedSystemID = deployed ? shipSystemID(item) : 0;
  const miningState = character && character.miningShipStates
    ? character.miningShipStates[String(shipID)]
    : null;
  const collectionShipID = positive(character && character.collectionShipID);
  return {
    shipID,
    typeID: positive(item && item.typeID),
    typeName: String(item && (item.typeName || item.itemName) || "Ship"),
    locationID: positive(item && item.locationID),
    flagID: positive(item && item.flagID),
    marked: markedShipIDs.includes(shipID),
    collection: collectionShipID === shipID,
    deployed,
    launching: Boolean(
      character && character.launchTransit &&
        character.launchTransit[String(shipID)],
    ),
    deployedHere: deployed && isShipInSystem(item, systemID),
    returning: returningShipIDs.has(shipID),
    returnLocationID: positive(
      character && character.returnLocationIDs &&
        character.returnLocationIDs[String(shipID)],
    ),
    deployedSystemID,
    deployedSystemName: solarSystemName(deployedSystemID),
    deployedPosition: deployed ? shipPosition(item) : null,
    pilotName: pilotNameForShip(character, shipID),
    mining: Boolean(miningState),
    miningStatus: String(miningState && miningState.status || ""),
    cargo: cargoSummary(
      positive(item && item.ownerID),
      shipID,
    ),
    eligible: Number(item && item.flagID) === itemStore.ITEM_FLAGS.HANGAR || deployed,
  };
}

function requestObject(args) {
  const request = unwrapMarshalValue(args && args[0]);
  return request && typeof request === "object" && !Array.isArray(request)
    ? request
    : {};
}

function objectIDs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).map(positive).filter(Boolean);
}

function pointSignature(value) {
  const point = vector(value, {x: 0, y: 0, z: 0});
  return [point.x, point.y, point.z].map((entry) => Math.round(entry)).join(":");
}

function pointsNear(left, right, tolerance = 1000) {
  const first = vector(left, {x: 0, y: 0, z: 0});
  const second = vector(right, {x: 0, y: 0, z: 0});
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  const dz = first.z - second.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= tolerance;
}

class NpcMiningWingService extends BaseService {
  constructor() {
    super("npcMiningWing");
    this._state = readState();
    for (const characterID of Object.keys(this._state.characters || {})) {
      characterState(this._state, positive(characterID));
    }
    this._runtimeTimer = null;
    this._miningDiagnostics = new Map();
    this._droneTraceAt = new Map();
    this._warpTargets = new Map();
    this._sessionSystems = new Map();
    this._runtimeFailures = new Map();
    this._operationLocks = new Map();
    this._metrics = new Map();
    this._routeCache = new Map();
    this._recoverDockedWingDrones();
    if (this._hasRuntimeState()) {
      this._ensureRuntimeTicker();
    }
  }

  callMethod(method, args, session, kwargs, callContext = null) {
    const normalizedMethod = BaseService.normalizeMethodName(method);
    const notifyFailure = (error) => {
      if (CHAT_COMMAND_METHODS.has(normalizedMethod)) {
        this._notifyCommandFailure(normalizedMethod, args, session, error);
      }
      throw error;
    };
    const operationCharacterID = MUTATING_COMMAND_METHODS.has(normalizedMethod)
      ? positive(sessionCharacterID(session))
      : 0;
    const operationKey = operationCharacterID
      ? String(operationCharacterID)
      : "";
    if (operationKey && this._operationLocks.has(operationKey)) {
      return notifyFailure(new Error("NPC_WING_OPERATION_IN_PROGRESS"));
    }
    if (operationKey) {
      this._operationLocks.set(operationKey, normalizedMethod);
    }
    let released = false;
    const releaseOperation = () => {
      if (released || !operationKey) {
        return;
      }
      released = true;
      this._operationLocks.delete(operationKey);
    };
    try {
      const result = super.callMethod(
        method,
        args,
        session,
        kwargs,
        callContext,
      );
      if (result && typeof result.then === "function") {
        return result.catch(notifyFailure).finally(releaseOperation);
      }
      releaseOperation();
      return result;
    } catch (error) {
      releaseOperation();
      return notifyFailure(error);
    }
  }

  _ensurePilotNames(character, shipIDs) {
    if (!character || !character.pilotNames) {
      return false;
    }
    let changed = false;
    for (const shipID of Array.isArray(shipIDs) ? shipIDs : [shipIDs]) {
      const numericShipID = positive(shipID);
      if (!numericShipID) {
        continue;
      }
      const key = String(numericShipID);
      if (!character.pilotNames[key]) {
        character.pilotNames[key] = generatedPilotName(numericShipID);
        changed = true;
      }
    }
    return changed;
  }

  _shipSpeaker(characterID, shipID) {
    const numericShipID = positive(shipID);
    if (!numericShipID) {
      return "Wing Control";
    }
    const state = this._getState();
    const character = characterState(state, characterID);
    const ship = itemStore.findCharacterShipItem(characterID, numericShipID);
    const shipName = String(
      ship && (ship.typeName || ship.itemName) || "wing ship",
    );
    return `${pilotNameForShip(character, numericShipID)} (${shipName})`;
  }

  _ensureWingChatChannel(session, characterID) {
    const numericCharacterID = positive(characterID);
    if (!session || !numericCharacterID) {
      return null;
    }
    const state = this._getState();
    const character = characterState(state, numericCharacterID);
    const runtime = getChatRuntime();
    let record = null;
    if (character.wingChatRoomName) {
      try {
        const existing = runtime.getChannel(character.wingChatRoomName);
        if (
          existing &&
          existing.type === "player" &&
          positive(existing.ownerCharacterID) === numericCharacterID
        ) {
          record = existing;
        }
      } catch (error) {
        log.debug(
          `[NPCMiningWing] Wing Comms lookup failed char=${numericCharacterID}: ${error.message}`,
        );
      }
    }

    let created = false;
    if (!record) {
      const createdChannel = runtime.createPlayerChannel(session, {
        displayName: WING_CHAT_DISPLAY_NAME,
        motd: WING_CHAT_MOTD,
        inviteOnly: true,
        invitedCharacters: [numericCharacterID],
        destroyWhenEmpty: false,
        persistBacklog: true,
        backlogLimit: WING_CHAT_BACKLOG_LIMIT,
        metadata: {
          source: "npcMiningWing",
          purpose: "wing_comms",
        },
      });
      record = createdChannel && createdChannel.record;
      if (record) {
        character.wingChatRoomName = String(record.roomName || "");
        character.wingChatChannelID = positive(
          createdChannel.channelID || record.entityID,
        );
        character.revision = positive(character.revision) + 1;
        writeState(state);
        created = true;
      }
    }
    if (!record) {
      return null;
    }

    try {
      runtime.joinChannel(session, record.roomName);
    } catch (error) {
      log.debug(
        `[NPCMiningWing] Wing Comms join failed char=${numericCharacterID} ` +
          `room=${record.roomName}: ${error.message}`,
      );
    }
    if (created) {
      try {
        getChatHub().sendSystemMessage(
          session,
          `Wing Comms is ready: <url=joinChannel:${record.roomName}>Open Wing Comms</url>`,
        );
      } catch (error) {
        log.debug(
          `[NPCMiningWing] Wing Comms invite message failed char=${numericCharacterID}: ${error.message}`,
        );
      }
      log.info(
        `[NPCMiningWing] char=${numericCharacterID} Wing Comms channel ready ` +
          `room=${record.roomName}`,
      );
    }
    return record;
  }

  _sendWingChat(session, characterID, shipID, message) {
    if (!message) {
      return false;
    }
    let targetSession = session;
    if (!targetSession && positive(characterID)) {
      try {
        targetSession = getSessionRegistry().findSessionByCharacterID(characterID);
      } catch (_) {
        targetSession = null;
      }
    }
    if (!targetSession) {
      return false;
    }
    try {
      let wingChannel = null;
      try {
        wingChannel = this._ensureWingChatChannel(
          targetSession,
          characterID,
        );
      } catch (error) {
        log.warn(
          `[NPCMiningWing] Wing Comms channel unavailable char=${characterID}: ${error.message}`,
        );
      }
      const channel = wingChannel && wingChannel.roomName
        ? wingChannel.roomName
        : null;
      getChatHub().sendSystemMessage(
        targetSession,
        `[Wing Comms] ${this._shipSpeaker(characterID, shipID)}: ${message}`,
        channel,
      );
      return true;
    } catch (error) {
      log.debug(`[NPCMiningWing] chat notification failed: ${error.message}`);
      return false;
    }
  }

  _notifyCommandFailure(method, args, session, error) {
    const characterID = sessionCharacterID(session);
    if (!characterID) {
      return;
    }
    const request = requestObject(args);
    const shipID = positive(
      method === "SetShipMarked" ||
        method === "SetCollectionShip" ||
        method === "TransferCargo"
        ? request.shipID
        : 0,
    );
    const action = method === "SetShipMarked"
      ? "Roster update"
      : method === "SetCollectionShip"
        ? "Collection role update"
      : method === "SetWingCommand"
        ? `${String(request.command || "Wing").trim() || "Wing"} command`
        : method === "DeployWing"
          ? "Deploy command"
          : method === "RecallWing"
            ? "Recall command"
            : method === "SendCollectionShip"
              ? "Collection trip"
            : "Cargo transfer";
    this._sendWingChat(
      session,
      characterID,
      shipID,
      `${action} failed: ${friendlyErrorMessage(error)}`,
    );
  }

  _sendCommandAcknowledgement(session, characterID, shipIDs, command) {
    const messages = {
      follow: "Follow order received. I am moving to your ship.",
      hold: "Holding position and awaiting your next order.",
      mine: "Mining order received. I am checking my fitted equipment and searching for a target.",
    };
    const message = messages[command] || "Order received.";
    for (const shipID of shipIDs) {
      this._sendWingChat(session, characterID, shipID, message);
    }
  }

  _sendMiningStatusChat(session, characterID, shipID, previousState, miningState) {
    if (!miningState) {
      return;
    }
    const previousStatus = String(previousState && previousState.status || "");
    const status = String(miningState.status || "");
    const lastError = String(miningState.lastError || "");
    const previousError = String(previousState && previousState.lastError || "");
    if (status === previousStatus && lastError === previousError) {
      return;
    }
    const messages = {
      "no-mining-module": "I cannot mine because no online mining laser or strip miner is fitted.",
      "no-target": "I cannot find a mineable target nearby.",
      approaching: "I am approaching the mining target.",
      "out-of-range": "I am out of range and trying to approach the target.",
      locking: "I am locking the mining target.",
      "lock-failed": "I could not lock the mining target; I will retry.",
      "target-incompatible": "My fitted mining equipment cannot work on this target.",
      "switching-target": "I am switching to another mining target.",
      "cargo-full": "My mining hold is full. Please collect cargo.",
      "returning-for-cargo": "My mining hold is full. I am returning to you to unload.",
      "transferring-cargo": "I am transferring my mining cargo to the collection ship or your active ship.",
      "cargo-waiting": lastError === "NPC_WING_DESTINATION_HOLD_FULL"
        ? "Your active ship's appropriate hold is full. I am staying with you until I can unload."
        : lastError === "NPC_WING_COLLECTION_UNAVAILABLE"
          ? "The collection ship is unavailable. I am holding my cargo until it returns."
          : "I am staying with you while I wait to transfer mining cargo.",
      "capacity-blocked": "My mining hold has no room for another cycle. I am waiting for space before mining resumes.",
      "combat-defense": "I am under attack. Mining is paused while my combat drones defend the ship.",
      "combat-returning": "The threat is gone. My combat drones are returning before mining resumes.",
      "resuming-mining": "Cargo unloaded. I am returning to the asteroid and resuming mining.",
      mining: "Mining lasers are active.",
      "activation-failed": lastError
        ? `I could not activate the miner: ${friendlyErrorMessage(lastError).replace(/\.$/, "")}.`
        : "I could not activate the miner; I will retry.",
    };
    const message = messages[status];
    if (message) {
      this._sendWingChat(session, characterID, shipID, message);
    }
  }

  _getState() {
    if (!this._state || this._state.schemaVersion !== STATE_VERSION) {
      this._state = readState();
    }
    return this._state;
  }

  _reconcileCharacterShipIDs(characterID, character) {
    if (!character) {
      return false;
    }

    let ownedShipIDs;
    try {
      ownedShipIDs = new Set(
        itemStore
          .getCharacterShipItems(characterID)
          .map((item) => positive(item && item.itemID))
          .filter(Boolean),
      );
    } catch (error) {
      // A roster refresh must not make the wing unusable when the inventory
      // store is temporarily unavailable. The next request will retry.
      log.warn(
        `[NPCMiningWing] char=${characterID} ship roster reconciliation failed: ` +
          `${error.message}`,
      );
      return false;
    }

    const normalizeIDs = (value) => [...new Set(
      (Array.isArray(value) ? value : [])
        .map(positive)
        .filter(Boolean),
    )].sort((left, right) => left - right);
    const markedShipIDs = normalizeIDs(character.markedShipIDs);
    const deployedShipIDs = normalizeIDs(character.deployedShipIDs);
    const validMarkedShipIDs = markedShipIDs.filter((shipID) => ownedShipIDs.has(shipID));
    const validDeployedShipIDs = deployedShipIDs.filter((shipID) => ownedShipIDs.has(shipID));
    const previousCollectionShipID = positive(character.collectionShipID);
    const validCollectionShipID = previousCollectionShipID &&
      (validMarkedShipIDs.includes(previousCollectionShipID) ||
        validDeployedShipIDs.includes(previousCollectionShipID))
      ? previousCollectionShipID
      : 0;
    const changed =
      markedShipIDs.join(",") !== validMarkedShipIDs.join(",") ||
      deployedShipIDs.join(",") !== validDeployedShipIDs.join(",") ||
      previousCollectionShipID !== validCollectionShipID;
    if (!changed) {
      return false;
    }

    const removedShipIDs = [...new Set([
      ...markedShipIDs.filter((shipID) => !ownedShipIDs.has(shipID)),
      ...deployedShipIDs.filter((shipID) => !ownedShipIDs.has(shipID)),
    ])];
    character.markedShipIDs = validMarkedShipIDs;
    character.deployedShipIDs = validDeployedShipIDs;
    character.collectionShipID = validCollectionShipID;
    character.deployed = validDeployedShipIDs.length > 0;
    for (const shipID of removedShipIDs) {
      const key = String(shipID);
      delete character.returnLocationIDs[key];
      delete character.recallStationIDs[key];
      delete character.dockingStationIDs[key];
      delete character.recallTransit[key];
      delete character.followTransit[key];
      delete character.launchTransit[key];
      delete character.miningShipStates[key];
      delete character.pilotNames[key];
    }
    if (validDeployedShipIDs.length === 0) {
      character.recalling = false;
      character.dockingWithLeader = false;
      character.collectionTrip.active = false;
      character.collectionTrip.phase = "idle";
    }
    character.revision = positive(character.revision) + 1;
    writeState(this._getState());
    log.warn(
      `[NPCMiningWing] char=${characterID} removed missing wing ship IDs ` +
        `${removedShipIDs.join(",") || "none"}; ` +
        `marked=${validMarkedShipIDs.join(",") || "none"}`,
    );
    return true;
  }

  _requireCharacter(session) {
    const characterID = sessionCharacterID(session);
    if (!characterID) {
      throw new Error("NPC_WING_CHARACTER_REQUIRED");
    }
    return characterID;
  }

  _hasRuntimeState() {
    const state = this._getState();
    return Object.values(state.characters || {}).some((character) => {
      return Array.isArray(character && character.deployedShipIDs) &&
        character.deployedShipIDs.length > 0;
    });
  }

  _metricsFor(characterID) {
    const key = String(positive(characterID));
    let metrics = this._metrics.get(key);
    if (!metrics) {
      metrics = {
        runtimeTicks: 0,
        runtimeFailures: 0,
        collectionRetries: 0,
        miningActivations: 0,
        cargoMoves: 0,
        lastTickAtMs: 0,
        lastFailureAtMs: 0,
      };
      this._metrics.set(key, metrics);
    }
    return metrics;
  }

  _recordMetric(characterID, name, amount = 1) {
    const metrics = this._metricsFor(characterID);
    const numericAmount = Number(amount);
    metrics[name] = Math.max(
      0,
      (Number(metrics[name]) || 0) + (Number.isFinite(numericAmount) ? numericAmount : 0),
    );
    return metrics;
  }

  _metricsSnapshot(characterID) {
    const metrics = this._metrics.get(String(positive(characterID)));
    return metrics ? {...metrics} : {
      runtimeTicks: 0,
      runtimeFailures: 0,
      collectionRetries: 0,
      miningActivations: 0,
      cargoMoves: 0,
      lastTickAtMs: 0,
      lastFailureAtMs: 0,
    };
  }

  _ensureRuntimeTicker() {
    if (this._runtimeTimer) {
      return;
    }
    this._runtimeTimer = setInterval(() => {
      this._tickRuntime();
    }, RUNTIME_TICK_MS);
    if (this._runtimeTimer && typeof this._runtimeTimer.unref === "function") {
      this._runtimeTimer.unref();
    }
  }

  _maybeStopRuntimeTicker() {
    if (!this._runtimeTimer || this._hasRuntimeState()) {
      return;
    }
    clearInterval(this._runtimeTimer);
    this._runtimeTimer = null;
    this._warpTargets.clear();
    this._runtimeFailures.clear();
  }

  _deployedShipIDs(character) {
    return [...new Set(
      (character && Array.isArray(character.deployedShipIDs)
        ? character.deployedShipIDs
        : [])
        .map(positive)
        .filter(Boolean),
    )].sort((left, right) => left - right);
  }

  _eligibleShips(characterID, session) {
    const activeShipID = currentShipID(session);
    const state = this._getState();
    const character = characterState(state, characterID);
    const trackedShipIDs = new Set([
      ...character.markedShipIDs.map(positive).filter(Boolean),
      ...this._deployedShipIDs(character),
    ]);
    return itemStore
      .getCharacterShipItems(characterID)
      .filter((item) => positive(item && item.itemID) !== activeShipID)
      .filter((item) =>
        Number(item && item.flagID) === itemStore.ITEM_FLAGS.HANGAR ||
        trackedShipIDs.has(positive(item && item.itemID)),
      )
      .map((item) => clone(item));
  }

  _stateRuntimeContext(session) {
    if (!session || !session._space) {
      return {runtime: null, scene: null, leader: null};
    }
    try {
      const runtime = getSpaceRuntime();
      const scene = runtime.getSceneForSession(session);
      return {
        runtime,
        scene,
        leader: scene && scene.getShipEntityForSession(session),
      };
    } catch (_) {
      return {runtime: null, scene: null, leader: null};
    }
  }

  _registerHiveShipIdentity(entity, shipRecord, characterID) {
    const numericCharacterID = positive(characterID);
    let result;
    if (
      !entity ||
      !shipRecord ||
      positive(entity.itemID) !== positive(shipRecord.itemID) ||
      positive(shipRecord.ownerID) !== numericCharacterID ||
      !numericCharacterID
    ) {
      result = {success: false, reason: "NPC_WING_DEFENSE_SHIP_IDENTITY_INVALID"};
    } else {
      const droneAPI = getDroneRuntime();
      result = droneAPI && typeof droneAPI.registerNpcMiningWingHiveShip === "function"
        ? droneAPI.registerNpcMiningWingHiveShip(entity, shipRecord)
        : {success: false, reason: "NPC_WING_DEFENSE_IDENTITY_BRIDGE_UNAVAILABLE"};
    }
    if (!result || result.success !== true) {
      const reason = String(result && result.reason || "NPC_WING_DEFENSE_IDENTITY_UNAVAILABLE");
      if (
        defenseDiagnosticsEnabled() &&
        entity && entity.npcMiningWingDefenseIdentityFailure !== reason
      ) {
        entity.npcMiningWingDefenseIdentityFailure = reason;
        log.warn(
          `[NPCMiningWing] defense identity registration failed ` +
            `ship=${positive(entity.itemID)} character=${numericCharacterID} ` +
            `recordOwner=${positive(shipRecord && shipRecord.ownerID)} ` +
            `reason=${reason}`,
        );
      }
      return result || {success: false, reason};
    }
    if (
      defenseDiagnosticsEnabled() &&
      entity && entity.npcMiningWingDefenseIdentityFailure
    ) {
      delete entity.npcMiningWingDefenseIdentityFailure;
    }
    return result;
  }

  _markHiveMindLeader(entity, characterID, shipRecord = null) {
    const numericCharacterID = positive(characterID);
    if (!entity || !numericCharacterID) {
      return;
    }
    // The damage path is native and intentionally unaware of this mod. These
    // runtime-only fields let the drone bridge recognize the active player
    // ship as the same defensive group as its deployed wing hulls.
    entity.npcMiningWingHiveMember = true;
    entity.npcMiningWingLeader = true;
    entity.npcMiningWingController = false;
    entity.npcMiningWingCharacterID = numericCharacterID;
    entity.npcMiningWingLeaderCharacterID = numericCharacterID;
    entity.runtimeOwnerCharacterID = numericCharacterID;
    this._registerHiveShipIdentity(entity, shipRecord, numericCharacterID);
  }

  _hiveDefenseThreats(scene, characterID, character, whenMs = Date.now()) {
    const droneAPI = getDroneRuntime();
    if (
      !droneAPI ||
      typeof droneAPI.getNpcMiningWingGroupAggression !== "function"
    ) {
      this._traceWingDrone("defense.group_lookup.unavailable", {
        characterID: positive(characterID),
        reason: !droneAPI ? "drone_runtime_unavailable" : "group_aggression_api_missing",
      }, 5_000, `defense-group-api:${positive(characterID)}`);
      return [];
    }
    const overrides = character && character.hiveDefenseOverrides || {};
    const traceLookup = this._traceWingDrone("defense.group_lookup.before", {
      characterID: positive(characterID),
      sceneLoaded: Boolean(scene),
    }, 5_000, `defense-group:${positive(characterID)}`);
    let rawThreats;
    let threats;
    try {
      rawThreats = droneAPI.getNpcMiningWingGroupAggression(characterID, whenMs);
      threats = rawThreats
        .filter((entry) => (
          finite(entry && entry.lastAggressedAtMs, 0) >
            finite(overrides[String(positive(entry && entry.targetID))], 0)
        ))
        .map((entry) => ({
          ...entry,
          entity: scene && typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(positive(entry && entry.targetID))
            : null,
        }))
        .filter((entry) => (
          !scene || entry.entity && positive(entry.entity.itemID) > 0
        ));
    } catch (error) {
      if (traceLookup) {
        this._traceWingDrone("defense.group_lookup.throw", {
          characterID: positive(characterID),
          rawThreatCount: Array.isArray(rawThreats) ? rawThreats.length : null,
          error: String(error && error.message || error),
        });
      }
      throw error;
    }
    if (traceLookup) {
      this._traceWingDrone("defense.group_lookup.after", {
        characterID: positive(characterID),
        sceneLoaded: Boolean(scene),
        rawThreatCount: Array.isArray(rawThreats) ? rawThreats.length : null,
        resolvedThreatCount: threats.length,
        threats: threats.slice(0, 16).map((entry) => ({
          targetID: positive(entry && entry.targetID),
          defendedShipID: positive(entry && entry.defendedShipID),
          lastAggressedAtMs: finite(entry && entry.lastAggressedAtMs, 0),
          entityAvailable: Boolean(entry && entry.entity),
        })),
      });
    }
    return threats;
  }

  _suppressHiveDefenseForCharacter(characterID, character) {
    if (!character) {
      return false;
    }
    const threats = this._hiveDefenseThreats(null, characterID, character);
    if (!threats.length) {
      return false;
    }
    let changed = false;
    for (const threat of threats) {
      const key = String(positive(threat.targetID));
      const timestamp = finite(threat.lastAggressedAtMs, 0);
      if (timestamp > finite(character.hiveDefenseOverrides[key], 0)) {
        character.hiveDefenseOverrides[key] = timestamp;
        changed = true;
      }
    }
    return changed;
  }

  _shipTargetStationID(character, shipID) {
    if (!character) {
      return 0;
    }
    const key = String(shipID);
    if (character.dockingWithLeader === true) {
      return positive(character.dockingStationIDs && character.dockingStationIDs[key]);
    }
    if (character.recalling === true) {
      return positive(character.recallStationIDs && character.recallStationIDs[key]);
    }
    return positive(character.returnLocationIDs && character.returnLocationIDs[key]);
  }

  _buildWingDroneSummary(scene, characterID, shipRecord, entity = null) {
    const shipID = positive(shipRecord && shipRecord.itemID);
    const controller = entity || (scene && scene.getEntityByID(shipID));
    const drones = this._wingDroneEntities(scene, shipID);
    let combat = 0;
    let mining = 0;
    let engaging = 0;
    let miningActive = 0;
    for (const drone of drones) {
      const capabilities = this._wingDroneCapabilities(
        drone,
        controller,
        characterID,
        shipRecord,
      );
      if (capabilities.combatSnapshot) combat += 1;
      if (capabilities.miningSnapshot) mining += 1;
      if (drone.droneCommand === DRONE_COMMAND_ENGAGE) engaging += 1;
      if (drone.droneCommand === DRONE_COMMAND_MINE) miningActive += 1;
    }
    return {
      deployedDroneCount: drones.length,
      deployedCombatDroneCount: combat,
      deployedMiningDroneCount: mining,
      engagingDroneCount: engaging,
      miningDroneCount: miningActive,
      droneDefenseActive: Boolean(controller && controller.npcMiningWingDroneDefenseActive),
    };
  }

  _buildShipStatus(character, ship, runtimeContext, currentSystem) {
    const shipID = positive(ship && ship.itemID);
    const isHangar = Number(ship && ship.flagID) === itemStore.ITEM_FLAGS.HANGAR;
    const deployed = Boolean(
      character && this._deployedShipIDs(character).includes(shipID) &&
      !isHangar,
    );
    const targetStationID = this._shipTargetStationID(character, shipID);
    const targetStation = dockableLocation(targetStationID);
    const targetStationName = dockableLocationName(targetStationID);
    const targetSystemID = dockableSystemID(targetStation);
    const targetSystemName = dockableLocationSystemName(targetStationID);
    const deployedSystemID = shipSystemID(ship);
    const deployedSystemName = solarSystemName(deployedSystemID);
    const collectionShipID = positive(character && character.collectionShipID);
    const collectionTrip = character && character.collectionTrip;
    const entity = runtimeContext && runtimeContext.scene &&
      runtimeContext.scene.getEntityByID(shipID);
    const isLaunching = Boolean(
      character && character.launchTransit &&
        character.launchTransit[String(shipID)],
    );
    const leaderID = positive(runtimeContext && runtimeContext.leader && runtimeContext.leader.itemID);
    const mode = String(entity && entity.mode || "").toUpperCase();
    const pendingDock = entity && entity.pendingDock;
    const isWarping = Boolean(
      entity && (entity.pendingWarp || entity.warpState || mode === "WARP"),
    );
    const isDocking = Boolean(
      pendingDock || (
        entity && targetStationID &&
        targetStation && canShipDockAtStation(entity, targetStation)
      ),
    );
    let statusLabel = "AVAILABLE";
    let statusDetail = "Ready to deploy";

    if (isHangar) {
      statusLabel = "DOCKED";
      statusDetail = dockableLocationName(ship.locationID)
        ? `Station: ${dockableLocationName(ship.locationID)}`
        : "Station hangar";
    } else if (isLaunching) {
      statusLabel = "LAUNCHING";
      statusDetail = targetStationName
        ? `Launching from: ${targetStationName}`
        : "Launching from the saved station";
    } else if (
      collectionShipID === shipID &&
      collectionTrip &&
      collectionTrip.active
    ) {
      statusLabel = collectionTrip.lastError
        ? "COLLECTION WAITING"
        : collectionTrip.phase === "returning"
        ? "COLLECTION RETURN"
        : "COLLECTION RUN";
      statusDetail = collectionTrip.stationID
        ? `Station: ${dockableLocationName(collectionTrip.stationID) || "saved station"}`
        : "Traveling to station to unload";
      if (collectionTrip.lastError) {
        statusDetail += ` | ${friendlyErrorMessage(collectionTrip.lastError)}`;
      }
    } else if (character && character.dockingWithLeader === true && targetStationID) {
      if (isDocking) {
        statusLabel = "DOCKING";
      } else if (isWarping) {
        statusLabel = "WARPING";
      } else if (mode === "GOTO" || mode === "FOLLOW") {
        statusLabel = "APPROACHING STATION";
      } else {
        statusLabel = "DOCKING";
      }
      statusDetail = targetStationName
        ? `With pilot at: ${targetStationName}`
        : "With pilot at the current station";
    } else if (character && character.recalling === true && targetStationID) {
      if (isDocking) {
        statusLabel = "DOCKING";
      } else if (isWarping) {
        statusLabel = "WARPING";
      } else if (
        (mode === "GOTO" || mode === "FOLLOW") &&
        positive(entity && entity.targetEntityID) === targetStationID
      ) {
        statusLabel = "APPROACHING STATION";
      } else {
        statusLabel = "RETURNING";
      }
      statusDetail = targetStationName
        ? `To: ${targetStationName}`
        : "Returning to the saved station";
    } else if (
      character &&
      character.command === "follow" &&
      deployed &&
      deployedSystemID > 0 &&
      positive(currentSystem) !== deployedSystemID
    ) {
      const transit = character.followTransit[String(shipID)] || {};
      const destinationSystemID = positive(
        transit.targetSystemID || currentSystem,
      );
      statusLabel = "TRAVELING";
      statusDetail = destinationSystemID
        ? `To: ${solarSystemName(destinationSystemID)}`
        : "Traveling to your system";
    } else if (entity) {
      if (isDocking) {
        statusLabel = "DOCKING";
        statusDetail = "Docking request accepted";
      } else if (isWarping) {
        statusLabel = "WARPING";
        statusDetail = deployedSystemName
          ? `System: ${deployedSystemName}`
          : "In warp";
      } else if (entity && entity.npcMiningWingDroneDefenseActive === true) {
        const activeDrones = this._wingDroneEntities(
          runtimeContext && runtimeContext.scene,
          shipID,
        ).length;
        statusLabel = "COMBAT DEFENSE";
        statusDetail = activeDrones > 0
          ? `Combat drones deployed: ${activeDrones}`
          : "Returning mining drones and preparing defense";
      } else if (character && character.command === "mine" && character.miningShipStates &&
        character.miningShipStates[String(shipID)]) {
        const miningState = character.miningShipStates[String(shipID)];
        const miningStatus = String(miningState.status || "active");
        statusLabel = miningStatus === "combat-returning"
          ? "DRONES RETURNING"
          : miningStatus === "combat-defense"
            ? "COMBAT DEFENSE"
            : miningStatus === "cargo-full" || miningStatus === "returning-for-cargo"
          ? "RETURNING CARGO"
          : miningStatus === "transferring-cargo"
            ? "UNLOADING"
          : miningStatus === "capacity-blocked"
            ? "HOLD FULL"
            : miningStatus === "cargo-waiting"
              ? "WAITING FOR CARGO"
              : "MINING";
        statusDetail = `Mining: ${miningState.status || "active"}`;
        if (miningState.lastError) {
          statusDetail += ` (${miningState.lastError})`;
        }
      } else if (
        character && character.command === "follow" &&
        mode === "FOLLOW" &&
        (!leaderID || positive(entity.targetEntityID) === leaderID)
      ) {
        statusLabel = "FOLLOWING";
        statusDetail = "Following your active ship";
      } else if (mode === "GOTO") {
        statusLabel = "APPROACHING";
        statusDetail = deployedSystemName
          ? `System: ${deployedSystemName}`
          : "Moving to target";
      } else if (mode === "STOP") {
        statusLabel = "HOLDING";
        statusDetail = deployedSystemName
          ? `System: ${deployedSystemName}`
          : "Holding position";
      } else {
        statusLabel = "IN SPACE";
        statusDetail = deployedSystemName
          ? `System: ${deployedSystemName}`
          : "Deployed";
      }
    } else if (deployed) {
      statusLabel = deployedSystemID && positive(currentSystem) !== deployedSystemID
        ? "IN SPACE"
        : deployedSystemID
          ? "DEPLOYED"
          : "LOST";
      statusDetail = deployedSystemName
        ? `System: ${deployedSystemName}`
        : "Space position unavailable";
    } else if (ship && ship.marked) {
      statusLabel = "MARKED";
      statusDetail = "Ready to deploy";
    }

    return {
      statusLabel,
      statusDetail,
      returnStationID: targetStationID,
      returnStationName: targetStationName,
      returnSystemID: targetSystemID,
      returnSystemName: targetSystemName,
    };
  }

  _recallTargetSummary(character, deployedShipIDs) {
    if (!deployedShipIDs.length) {
      return "Not set";
    }
    const names = [];
    let unknownCount = 0;
    for (const shipID of deployedShipIDs) {
      const stationID = this._shipTargetStationID(character, shipID);
      const name = dockableLocationName(stationID);
      if (!name) {
        unknownCount += 1;
      } else if (!names.includes(name)) {
        names.push(name);
      }
    }
    const visibleNames = names.slice(0, 2);
    if (names.length > visibleNames.length) {
      visibleNames.push(`+${names.length - visibleNames.length} more`);
    }
    if (unknownCount > 0) {
      visibleNames.push(
        unknownCount === 1 ? "Unknown station" : `${unknownCount} unknown stations`,
      );
    }
    return visibleNames.length > 0
      ? visibleNames.join(", ")
      : "Unknown (legacy deployment)";
  }

  _stateResponse(characterID, session, extra = null) {
    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    const markedShipIDs = character.markedShipIDs.map(positive).filter(Boolean);
    const deployedShipIDs = this._deployedShipIDs(character);
    const deployedSet = new Set(deployedShipIDs);
    const returningSet = new Set(objectIDs(character.recallStationIDs));
    const systemID = currentSystemID(session);
    const inSpace = Boolean(session && session._space);
    const runtimeContext = this._stateRuntimeContext(session);
    const ships = this._eligibleShips(characterID, session);
    const available = ships.map((ship) => {
      const serialized = serializeShip(
        ship,
        markedShipIDs,
        deployedSet,
        returningSet,
        character,
        systemID,
      );
      Object.assign(
        serialized,
        this._buildShipStatus(character, ship, runtimeContext, systemID),
        this._buildWingDroneSummary(
          runtimeContext && runtimeContext.scene,
          characterID,
          ship,
          runtimeContext && runtimeContext.scene &&
            runtimeContext.scene.getEntityByID(ship.itemID),
        ),
      );
      return serialized;
    });
    const deployedHere = available.filter((ship) => ship.deployedHere).length;
    const deployedElsewhere = available.filter((ship) =>
      ship.deployed && !ship.deployedHere && ship.deployedSystemID > 0,
    ).length;
    const recallTargetSummary = this._recallTargetSummary(character, deployedShipIDs);
    const collectionTripWaiting = character.collectionTrip &&
      character.collectionTrip.active === true &&
      Boolean(character.collectionTrip.lastError);
    const runtimeMetrics = this._metricsSnapshot(characterID);
    const isLaunching = Object.keys(character.launchTransit || {}).length > 0;
    const runtimeStatus = character.dockingWithLeader === true
      ? "docking-with-pilot"
      : !inSpace
      ? "docked"
      : character.recalling
        ? "returning"
      : isLaunching
        ? "launching"
      : collectionTripWaiting
        ? "collection-waiting"
      : deployedHere > 0
        ? "deployed"
        : deployedElsewhere > 0
          ? "deployed-elsewhere"
        : "roster-ready";
    const runtimeMessage = character.dockingWithLeader === true
      ? `Wing docking with you at ${recallTargetSummary}.`
      : !inSpace
      ? deployedShipIDs.length > 0
        ? `Docked. Recall target: ${recallTargetSummary}. Choose Recall Wing to return deployed ships.`
        : "Undock, then choose Deploy Wing to launch marked ships."
      : character.recalling
        ? `Wing returning to ${recallTargetSummary}.`
      : isLaunching
        ? "Wing ships are launching from their saved station and joining you."
      : collectionTripWaiting
        ? `Collection ship retrying: ${friendlyErrorMessage(character.collectionTrip.lastError)}`
      : deployedHere > 0
        ? "Wing deployed in this system. Follow and Hold are active."
        : deployedElsewhere > 0
          ? "Wing ships are in another system. Use Follow, Recall, or Find."
        : "Mark ships in a station, undock, then choose Deploy Wing.";
    // EveJS's native Macho marshal encoder does not accept ordinary JS
    // objects. Return a JSON string across the service boundary instead;
    // the client menu decodes it back into the state object.
    const response = {
      schemaVersion: STATE_VERSION,
      revision: positive(character.revision),
      command: character.command,
      deployed: deployedShipIDs.length > 0,
      deployedShipIDs,
      recalling: character.recalling === true,
      dockingWithLeader: character.dockingWithLeader === true,
      ships: available,
      supportedCommands: [...SUPPORTED_ACTIONS],
      runtimeStatus,
      runtimeMessage,
      runtimeMetrics,
      recallTargetSummary,
      currentSystemID: systemID,
      collectionShipID: positive(character.collectionShipID),
      collectionShipName: character.collectionShipID
        ? String(
          itemStore.findCharacterShipItem(characterID, character.collectionShipID) &&
            (itemStore.findCharacterShipItem(characterID, character.collectionShipID).typeName ||
              itemStore.findCharacterShipItem(characterID, character.collectionShipID).itemName) ||
            "",
        )
        : "",
      collectionTrip: clone(character.collectionTrip),
    };
    if (extra && typeof extra === "object") {
      Object.assign(response, extra);
    }
    return JSON.stringify(response);
  }

  _spaceContext(session) {
    const systemID = currentSpaceSystemID(session);
    if (!systemID) {
      throw new Error("NPC_WING_NOT_IN_SPACE");
    }
    const runtime = getSpaceRuntime();
    const scene = runtime.getSceneForSession(session);
    const leader = scene && scene.getShipEntityForSession(session);
    if (!scene || !leader) {
      throw new Error("NPC_WING_LEADER_NOT_FOUND");
    }
    return {runtime, scene, systemID, leader};
  }

  _findSceneForSystem(runtime, systemID) {
    const numericSystemID = positive(systemID);
    if (!runtime || !numericSystemID || !runtime.scenes) {
      return null;
    }
    if (typeof runtime.scenes.get === "function") {
      const direct = runtime.scenes.get(numericSystemID);
      if (direct && positive(direct.systemID) === numericSystemID) {
        return direct;
      }
    }
    if (typeof runtime.scenes.values !== "function") {
      return null;
    }
    for (const scene of runtime.scenes.values()) {
      if (
        scene && (
          positive(scene.systemID) === numericSystemID ||
          positive(scene.sceneDescriptor && scene.sceneDescriptor.locationID) ===
            numericSystemID
        )
      ) {
        return scene;
      }
    }
    return null;
  }

  _findSessionForCharacterInSystem(runtime, characterID, systemID) {
    if (!runtime || !runtime.scenes || typeof runtime.scenes.values !== "function") {
      return null;
    }
    const numericCharacterID = positive(characterID);
    const numericSystemID = positive(systemID);
    for (const scene of runtime.scenes.values()) {
      if (!scene || !scene.sessions || typeof scene.sessions.values !== "function") {
        continue;
      }
      for (const session of scene.sessions.values()) {
        if (
          sessionCharacterID(session) === numericCharacterID &&
          currentSpaceSystemID(session) === numericSystemID &&
          session.disconnected !== true
        ) {
          return session;
        }
      }
    }
    return null;
  }

  _gateBetween(fromSystemID, toSystemID) {
    const from = positive(fromSystemID);
    const to = positive(toSystemID);
    if (!from || !to) {
      return null;
    }
    return worldData
      .getStargatesForSystem(from)
      .find((gate) => positive(gate && gate.destinationSolarSystemID) === to) ||
      null;
  }

  _findRoute(fromSystemID, toSystemID) {
    const from = positive(fromSystemID);
    const to = positive(toSystemID);
    if (!from || !to) {
      return null;
    }
    if (from === to) {
      return [from];
    }
    const cacheKey = `${from}:${to}`;
    if (this._routeCache.has(cacheKey)) {
      return clone(this._routeCache.get(cacheKey));
    }

    const queue = [[from, [from]]];
    const visited = new Set([from]);
    let route = null;
    while (queue.length > 0 && visited.size <= 5000) {
      const [current, path] = queue.shift();
      for (const gate of worldData.getStargatesForSystem(current)) {
        const next = positive(gate && gate.destinationSolarSystemID);
        if (!next || visited.has(next)) {
          continue;
        }
        const nextPath = [...path, next];
        if (next === to) {
          route = nextPath;
          break;
        }
        visited.add(next);
        queue.push([next, nextPath]);
      }
      if (route) {
        break;
      }
    }
    this._routeCache.set(cacheKey, route || []);
    return route;
  }

  _removeShipFromSystemScene(runtime, systemID, shipID) {
    const scene = this._findSceneForSystem(runtime, systemID);
    if (!scene || !scene.getEntityByID(shipID)) {
      return true;
    }
    const result = scene.removeDynamicEntity(shipID, {
      broadcast: true,
      persistSpaceState: false,
    });
    return Boolean(result && result.success === true);
  }

  _moveWingAcrossGate(runtime, characterID, character, fromSystemID, toSystemID, leader) {
    const gate = this._gateBetween(fromSystemID, toSystemID);
    if (!gate) {
      log.warn(
        `[NPCMiningWing] char=${characterID} gate-follow unavailable ` +
          `from=${fromSystemID} to=${toSystemID}`,
      );
      return false;
    }
    const destinationScene = this._findSceneForSystem(runtime, toSystemID);
    let moved = 0;
    for (const [index, shipID] of this._deployedShipIDs(character).entries()) {
      if (
        character.collectionTrip &&
        character.collectionTrip.active === true &&
        positive(character.collectionTrip.shipID) === shipID
      ) {
        continue;
      }
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || shipSystemID(ship) !== positive(fromSystemID)) {
        continue;
      }
      if (!this._prepareWingShipForDock(
        null,
        characterID,
        ship,
        this._findSceneForSystem(runtime, fromSystemID),
      )) {
        continue;
      }
      if (!this._removeShipFromSystemScene(runtime, fromSystemID, shipID)) {
        continue;
      }
      const moveResult = itemStore.moveShipToSpace(
        shipID,
        toSystemID,
        buildCompanionSpaceState(toSystemID, leader, index),
      );
      if (!moveResult || moveResult.success !== true) {
        log.warn(
          `[NPCMiningWing] char=${characterID} gate-follow move failed ` +
            `ship=${shipID} error=${String(moveResult && moveResult.errorMsg || "UNKNOWN")}`,
        );
        continue;
      }
      moved += 1;
      if (destinationScene) {
        const entity = this._ensureDeployedEntity(
          runtime,
          destinationScene,
          toSystemID,
          shipID,
        );
        if (character.command === "follow" && entity) {
          runtime.followDynamicEntity(
            destinationScene.sceneDescriptor || toSystemID,
            shipID,
            positive(leader && leader.itemID),
            FOLLOW_RANGE_METERS,
            {broadcast: true},
          );
        }
      }
      log.info(
        `[NPCMiningWing] char=${characterID} gate-follow ship=${shipID} ` +
          `from=${fromSystemID} to=${toSystemID} gate=${positive(gate.itemID)}`,
      );
    }
    if (moved > 0) {
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
    }
    return moved > 0;
  }

  _observeSessionMovement(runtime, session, characterID, character, systemID, leader) {
    const previous = this._sessionSystems.get(characterID);
    this._sessionSystems.set(characterID, {
      session,
      systemID,
      seenAt: Date.now(),
    });
    if (
      !previous ||
      previous.session !== session ||
      previous.systemID === systemID ||
      character.recalling === true ||
      character.command !== "follow"
    ) {
      return;
    }
    this._moveWingAcrossGate(
      runtime,
      characterID,
      character,
      previous.systemID,
      systemID,
      leader,
    );
  }

  _leaderDockingStationID(leader) {
    const pendingStationID = positive(leader && leader.pendingDock && leader.pendingDock.stationID);
    if (pendingStationID) {
      return pendingStationID;
    }
    const approachStationID = positive(leader && leader.dockingTargetID);
    return (
      approachStationID &&
      (String(leader && leader.mode || "").toUpperCase() === "FOLLOW" ||
        String(leader && leader.mode || "").toUpperCase() === "GOTO") &&
      positive(leader && leader.targetEntityID) === approachStationID
    )
      ? approachStationID
      : 0;
  }

  _clearDockingState(character) {
    character.dockingStationIDs = {};
    character.dockingWithLeader = false;
  }

  _beginLeaderDocking(runtime, scene, characterID, character, systemID, stationID) {
    const numericStationID = positive(stationID);
    if (
      !numericStationID ||
      character.dockingWithLeader === true ||
      character.command !== "follow"
    ) {
      return false;
    }
    const station = this._validateReturnStation(numericStationID, systemID);
    const dockingStationIDs = {};
    for (const shipID of this._deployedShipIDs(character)) {
      if (
        character.collectionTrip &&
        character.collectionTrip.active === true &&
        positive(character.collectionTrip.shipID) === shipID
      ) {
        continue;
      }
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (
        !ship ||
        Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR ||
        shipSystemID(ship) !== positive(systemID)
      ) {
        continue;
      }
      dockingStationIDs[String(shipID)] = numericStationID;
    }
    if (Object.keys(dockingStationIDs).length <= 0) {
      return false;
    }

    character.dockingStationIDs = dockingStationIDs;
    character.dockingWithLeader = true;
    character.recalling = false;
    character.recallStationIDs = {};
    character.recallTransit = {};
    character.followTransit = {};
    character.launchTransit = {};
    character.miningShipStates = {};
    character.command = "dock";
    character.revision = positive(character.revision) + 1;
    writeState(this._getState());
    this._ensureRuntimeTicker();

    for (const shipID of Object.keys(dockingStationIDs).map(positive)) {
      if (!scene) {
        continue;
      }
      try {
        this._cancelSessionlessWingMovement(
          runtime,
          scene,
          systemID,
          characterID,
          shipID,
          "leader-docking",
        );
        this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        this._issueRecallMovement(runtime, scene, systemID, shipID, numericStationID);
      } catch (error) {
        log.warn(
          `[NPCMiningWing] char=${characterID} leader-dock approach pending ` +
            `ship=${shipID} station=${numericStationID} error=${error.message}`,
        );
      }
    }
    log.info(
      `[NPCMiningWing] char=${characterID} follow-dock station=${numericStationID} ` +
        `name=${station.stationName || station.itemName || station.name || numericStationID}`,
    );
    return true;
  }

  _tickDockingWithoutLeader(runtime, characterID, character) {
    if (!character || character.dockingWithLeader !== true) {
      return false;
    }
    const dockingTargetSystems = new Set();
    for (const shipID of this._deployedShipIDs(character)) {
      const stationID = positive(character.dockingStationIDs[String(shipID)]);
      const station = dockableLocation(stationID);
      const targetSystemID = dockableSystemID(station);
      if (targetSystemID) {
        dockingTargetSystems.add(targetSystemID);
      }
    }
    let sessionInRecordedTarget = null;
    for (const targetSystemID of dockingTargetSystems) {
      sessionInRecordedTarget = this._findSessionForCharacterInSystem(
        runtime,
        characterID,
        targetSystemID,
      );
      if (sessionInRecordedTarget) {
        break;
      }
    }
    const leaderSession = sessionInRecordedTarget ||
      getSessionRegistry().findSessionByCharacterID(characterID);
    if (leaderSession && currentSpaceSystemID(leaderSession)) {
      return false;
    }

    const systemsWithScenes = new Set();
    for (const shipID of this._deployedShipIDs(character)) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      const stationID = positive(character.dockingStationIDs[String(shipID)]);
      const station = dockableLocation(stationID);
      const shipSystem = shipSystemID(ship);
      if (
        ship &&
        station &&
        shipSystem &&
        shipSystem === dockableSystemID(station)
      ) {
        systemsWithScenes.add(shipSystem);
      }
    }

    let changed = false;
    for (const systemID of systemsWithScenes) {
      const scene = this._findSceneForSystem(runtime, systemID);
      if (scene) {
        this._tickRecall(runtime, scene, null, characterID, character, systemID);
        continue;
      }
      for (const shipID of this._deployedShipIDs(character)) {
        const ship = itemStore.findCharacterShipItem(characterID, shipID);
        const stationID = positive(character.dockingStationIDs[String(shipID)]);
        const station = dockableLocation(stationID);
        if (
          !ship ||
          !station ||
          shipSystemID(ship) !== systemID ||
          dockableSystemID(station) !== systemID
        ) {
          continue;
        }
        if (!this._prepareWingShipForDock(null, characterID, ship, null)) {
          continue;
        }
        if (!this._removeShipFromSystemScene(runtime, systemID, shipID)) {
          continue;
        }
        const dockResult = itemStore.dockShipToLocation(shipID, stationID);
        if (dockResult && dockResult.success === true) {
          this._depositDockedMiningCargo(null, characterID, shipID, stationID, "follow-dock");
          this._syncDockedShipToSession(
            null,
            characterID,
            shipID,
            dockResult,
            "follow-dock",
          );
          this._finishRecalledShip(character, shipID);
          changed = true;
          log.info(
            `[NPCMiningWing] char=${characterID} follow-dock ship=${shipID} ` +
              `station=${stationID} remote-arrival=true`,
          );
        }
      }
    }
    if (character.deployedShipIDs.length === 0) {
      character.recalling = false;
      this._clearDockingState(character);
      character.command = "hold";
      changed = true;
    }
    if (changed) {
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
    }
    return changed;
  }

  _ensureDeployedEntity(runtime, scene, systemID, shipID) {
    const existing = scene.getEntityByID(shipID);
    if (existing) {
      if (existing.kind !== "ship") {
        throw new Error("NPC_WING_ENTITY_ID_COLLISION");
      }
      return existing;
    }

    const spawnResult = runtime.spawnDynamicInventoryEntity(
      scene.sceneDescriptor || systemID,
      shipID,
      {
        sceneDescriptor: scene.sceneDescriptor || undefined,
        broadcast: true,
        broadcastOptions: {freshAcquire: true},
      },
    );
    if (!spawnResult || spawnResult.success !== true || !spawnResult.data) {
      throw new Error(
        "NPC_WING_SPAWN_FAILED:%s".replace(
          "%s",
          String(spawnResult && spawnResult.errorMsg || "UNKNOWN"),
        ),
      );
    }
    return spawnResult.data.entity || scene.getEntityByID(shipID);
  }

  _returnLocationID(character, shipID, session) {
    const savedLocationID = positive(
      character && character.returnLocationIDs &&
        character.returnLocationIDs[String(shipID)],
    );
    return savedLocationID || dockedLocationID(session);
  }

  _stationEntity(scene, stationID) {
    return (scene && scene.getEntityByID(stationID)) || dockableLocation(stationID);
  }

  _validateReturnStation(stationID, systemID = 0, allowOtherSystem = false) {
    const station = dockableLocation(stationID);
    if (!station) {
      throw new Error("NPC_WING_RETURN_STATION_NOT_FOUND");
    }
    if (
      !allowOtherSystem &&
      positive(systemID) > 0 &&
      dockableSystemID(station) !== positive(systemID)
    ) {
      throw new Error("NPC_WING_RETURN_STATION_NOT_IN_CURRENT_SYSTEM");
    }
    return station;
  }

  _stationWarpStopDistance(runtime, entity, station) {
    if (typeof runtime.getWarpStopDistanceForTargetForTesting === "function") {
      return Math.max(
        0,
        finite(
          runtime.getWarpStopDistanceForTargetForTesting(entity, station),
          0,
        ),
      );
    }
    return 0;
  }

  _issueRecallMovement(runtime, scene, systemID, shipID, stationID) {
    const entity = scene.getEntityByID(shipID);
    const station = this._stationEntity(scene, stationID);
    if (!entity || !station) {
      throw new Error("NPC_WING_RECALL_ENTITY_NOT_FOUND");
    }
    if (canShipDockAtStation(entity, station)) {
      return true;
    }
    if (entity.pendingWarp || entity.warpState || entity.mode === "WARP") {
      const warpTargetEntityID = positive(
        entity.targetEntityID ||
          entity.pendingWarp && entity.pendingWarp.targetEntityID ||
          entity.warpState && entity.warpState.targetEntityID,
      );
      const warpTargetPoint = entity.pendingWarp && (
        entity.pendingWarp.rawDestination || entity.pendingWarp.targetPoint
      ) || entity.warpState && entity.warpState.targetPoint;
      if (
        warpTargetEntityID === positive(stationID) ||
        warpTargetPoint && pointsNear(warpTargetPoint, station.position, 10000)
      ) {
        return true;
      }
      if (!this._cancelSessionlessWingMovement(
        runtime,
        scene,
        systemID,
        0,
        shipID,
        "recall",
      )) {
        throw new Error("NPC_WING_RECALL_FAILED:WARP_IN_PROGRESS");
      }
    }
    if (
      (entity.mode === "GOTO" || entity.mode === "FOLLOW") &&
      pointsNear(entity.targetPoint, station.position, 10000) &&
      positive(entity.targetEntityID) === positive(stationID)
    ) {
      return true;
    }

    const warpResult = runtime.startSessionlessWarpIngress(
      scene.sceneDescriptor || systemID,
      shipID,
      station.position,
      {
        targetEntityID: stationID,
        stopDistance: this._stationWarpStopDistance(runtime, entity, station),
        broadcastWarpStartToVisibleSessions: true,
        acquireForRelevantSessions: true,
      },
    );
    if (warpResult && warpResult.success === true) {
      return true;
    }
    if (warpResult && warpResult.errorMsg === "WARP_DISTANCE_TOO_CLOSE") {
      const followResult = runtime.followDynamicEntity(
        scene.sceneDescriptor || systemID,
        shipID,
        stationID,
        0,
        {dockingTargetID: stationID, broadcast: true},
      );
      if (followResult === true) {
        return true;
      }
    }
    throw new Error(
      "NPC_WING_RECALL_FAILED:%s".replace(
        "%s",
        String(warpResult && warpResult.errorMsg || "UNKNOWN"),
      ),
    );
  }

  _issueLaunchMovement(runtime, scene, leader, characterID, shipID, systemID) {
    const entity = scene && scene.getEntityByID(shipID);
    const leaderID = positive(leader && leader.itemID);
    if (!entity || !leaderID || !leader || !leader.position) {
      throw new Error("NPC_WING_LAUNCH_ENTITY_NOT_FOUND");
    }

    const distanceToLeader = distanceBetween(entity.position, leader.position);
    if (distanceToLeader <= FOLLOW_RANGE_METERS) {
      return true;
    }

    const leaderWarp = leader.pendingWarp || leader.warpState;
    const leaderWarpDestination = leaderWarp && (
      leaderWarp.rawDestination || leaderWarp.targetPoint
    );
    const shouldWarp = Boolean(
      leader.mode === "WARP" && leaderWarpDestination,
    ) || distanceToLeader > FOLLOW_RANGE_METERS * 4;
    const warpDestination = leaderWarpDestination || leader.position;
    const warpKey = `launch:${positive(characterID)}:${positive(shipID)}`;
    const warpSignature = `${positive(systemID)}:${pointSignature(warpDestination)}`;
    if (shouldWarp) {
      if (
        this._warpTargets.get(warpKey) === warpSignature ||
        entity.pendingWarp ||
        entity.warpState ||
        entity.mode === "WARP"
      ) {
        return true;
      }
      const warpResult = runtime.startSessionlessWarpIngress(
        scene.sceneDescriptor || systemID,
        shipID,
        warpDestination,
        {
          targetEntityID: positive(leaderWarp && leaderWarp.targetEntityID) || leaderID,
          stopDistance: Math.max(0, finite(leaderWarp && leaderWarp.stopDistance, 0)),
          broadcastWarpStartToVisibleSessions: true,
          acquireForRelevantSessions: true,
        },
      );
      if (warpResult && warpResult.success === true) {
        this._warpTargets.set(warpKey, warpSignature);
        return true;
      }
      if (leader.mode === "WARP") {
        throw new Error(
          "NPC_WING_LAUNCH_FAILED:%s".replace(
            "%s",
            String(warpResult && warpResult.errorMsg || "WARP_FAILED"),
          ),
        );
      }
    }

    const followResult = runtime.followDynamicEntity(
      scene.sceneDescriptor || systemID,
      shipID,
      leaderID,
      FOLLOW_RANGE_METERS,
      {broadcast: true},
    );
    if (followResult === true) {
      return true;
    }
    throw new Error("NPC_WING_LAUNCH_FAILED:FOLLOW_FAILED");
  }

  _cancelSessionlessWingMovement(
    runtime,
    scene,
    systemID,
    characterID,
    shipID,
    reason,
  ) {
    const entity = scene && scene.getEntityByID(shipID);
    this._warpTargets.delete(`launch:${positive(characterID)}:${positive(shipID)}`);
    if (
      !entity ||
      (!entity.pendingWarp && !entity.warpState && entity.mode !== "WARP")
    ) {
      return true;
    }
    const result = runtime.stopDynamicEntity(
      scene.sceneDescriptor || systemID,
      shipID,
      {
        broadcast: true,
        allowSessionlessWarpAbort: true,
        reason: reason || "wing_command",
      },
    );
    return result === true;
  }

  _tickLaunchTransit(runtime, scene, characterID, character, systemID, leader) {
    const launchTransit = character && character.launchTransit;
    if (
      !launchTransit ||
      typeof launchTransit !== "object" ||
      Object.keys(launchTransit).length <= 0
    ) {
      return false;
    }

    let stateChanged = false;
    for (const [shipKey, transit] of Object.entries(launchTransit)) {
      const shipID = positive(shipKey);
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
        delete launchTransit[shipKey];
        this._warpTargets.delete(`launch:${positive(characterID)}:${shipID}`);
        stateChanged = true;
        continue;
      }
      const launchSystemID = positive(transit && transit.systemID) || systemID;
      if (!isShipInSystem(ship, systemID) || launchSystemID !== positive(systemID)) {
        continue;
      }

      let entity = scene.getEntityByID(shipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} launch resume spawn failed ` +
              `ship=${shipID} error=${error.message}`,
          );
          continue;
        }
      }
      if (
        !entity.pendingWarp &&
        !entity.warpState &&
        entity.mode !== "WARP" &&
        distanceBetween(entity.position, leader.position) <= FOLLOW_RANGE_METERS
      ) {
        runtime.stopDynamicEntity(
          scene.sceneDescriptor || systemID,
          shipID,
          {broadcast: true},
        );
        delete launchTransit[shipKey];
        this._warpTargets.delete(`launch:${positive(characterID)}:${shipID}`);
        stateChanged = true;
        log.info(
          `[NPCMiningWing] char=${characterID} launch complete ` +
            `ship=${shipID} system=${systemID}`,
        );
        continue;
      }
      try {
        this._issueLaunchMovement(
          runtime,
          scene,
          leader,
          characterID,
          shipID,
          systemID,
        );
      } catch (error) {
        log.warn(
          `[NPCMiningWing] char=${characterID} launch movement pending ` +
            `ship=${shipID} error=${error.message}`,
        );
      }
    }
    if (stateChanged) {
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
    }
    return stateChanged;
  }

  _materializeWingShipsForScene(runtime, scene, characterID, character, systemID) {
    if (!runtime || !scene || !character) {
      return 0;
    }
    let materialized = 0;
    for (const shipID of this._deployedShipIDs(character)) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (
        !ship ||
        !isShipInSystem(ship, systemID) ||
        scene.getEntityByID(shipID)
      ) {
        continue;
      }
      try {
        this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        materialized += 1;
        log.info(
          `[NPCMiningWing] char=${characterID} materialized ship=${shipID} ` +
            `system=${systemID} reason=scene-reentry`,
        );
      } catch (error) {
        log.warn(
          `[NPCMiningWing] char=${characterID} scene reentry spawn failed ` +
            `ship=${shipID} system=${systemID} error=${error.message}`,
        );
      }
    }
    return materialized;
  }

  _finishRecalledShip(character, shipID) {
    const deployedShipIDs = this._deployedShipIDs(character)
      .filter((candidate) => candidate !== shipID);
    character.deployedShipIDs = deployedShipIDs;
    character.deployed = deployedShipIDs.length > 0;
    delete character.recallStationIDs[String(shipID)];
    delete character.dockingStationIDs[String(shipID)];
    delete character.recallTransit[String(shipID)];
    delete character.followTransit[String(shipID)];
    delete character.launchTransit[String(shipID)];
    delete character.miningShipStates[String(shipID)];
  }

  _buildRecallTransit(ship, stationID) {
    const currentSystemID = shipSystemID(ship);
    const station = this._validateReturnStation(stationID, 0, true);
    const targetSystemID = dockableSystemID(station);
    if (!currentSystemID || !targetSystemID) {
      throw new Error("NPC_WING_RECALL_SYSTEM_UNKNOWN");
    }
    const route = this._findRoute(currentSystemID, targetSystemID);
    if (!route || route.length < 2) {
      throw new Error("NPC_WING_RECALL_ROUTE_NOT_FOUND");
    }
    return {
      currentSystemID,
      targetSystemID,
      stationID: positive(stationID),
      nextSystemID: positive(route[1]),
      readyAtMs: Date.now() + GATE_TRANSIT_MS,
    };
  }

  _tickRemoteRecall(runtime, characterID, character) {
    if (!character || character.recalling !== true) {
      return false;
    }
    let stateChanged = false;
    const now = Date.now();
    for (const shipID of this._deployedShipIDs(character)) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      const stationID = positive(character.recallStationIDs[String(shipID)]);
      if (!ship || Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
        this._finishRecalledShip(character, shipID);
        stateChanged = true;
        continue;
      }
      if (!stationID) {
        continue;
      }

      const station = this._validateReturnStation(stationID, 0, true);
      const currentSystemID = shipSystemID(ship);
      const targetSystemID = dockableSystemID(station);
      if (!currentSystemID || !targetSystemID) {
        continue;
      }

      const sourceScene = this._findSceneForSystem(runtime, currentSystemID);
      if (!this._prepareWingShipForDock(null, characterID, ship, sourceScene)) {
        continue;
      }

      if (currentSystemID === targetSystemID) {
        const transit = character.recallTransit[String(shipID)];
        const activeSession = this._findSessionForCharacterInSystem(
          runtime,
          characterID,
          targetSystemID,
        );
        if (activeSession && currentSpaceSystemID(activeSession)) {
          if (transit) {
            delete character.recallTransit[String(shipID)];
            stateChanged = true;
          }
          continue;
        }
        if (transit && finite(transit.readyAtMs, 0) > now) {
          continue;
        }
        if (!this._removeShipFromSystemScene(runtime, currentSystemID, shipID)) {
          continue;
        }
        const dockResult = itemStore.dockShipToLocation(shipID, stationID);
        if (dockResult && dockResult.success === true) {
          this._depositDockedMiningCargo(null, characterID, shipID, stationID, "remote-arrival");
          this._syncDockedShipToSession(
            null,
            characterID,
            shipID,
            dockResult,
            "remote-arrival",
          );
          this._finishRecalledShip(character, shipID);
          stateChanged = true;
          log.info(
            `[NPCMiningWing] char=${characterID} recalled ship=${shipID} ` +
              `station=${stationID} remote-arrival=true`,
          );
        }
        continue;
      }

      let transit = character.recallTransit[String(shipID)];
      if (!transit || typeof transit !== "object") {
        transit = this._buildRecallTransit(ship, stationID);
        character.recallTransit[String(shipID)] = transit;
        stateChanged = true;
      }
      if (finite(transit.readyAtMs, 0) > now) {
        continue;
      }

      const route = this._findRoute(currentSystemID, targetSystemID);
      const nextSystemID = route && positive(route[1]);
      const gate = this._gateBetween(currentSystemID, nextSystemID);
      if (!nextSystemID || !gate) {
        log.warn(
          `[NPCMiningWing] char=${characterID} recall route stalled ` +
            `ship=${shipID} from=${currentSystemID} target=${targetSystemID}`,
        );
        transit.readyAtMs = now + GATE_TRANSIT_MS;
        stateChanged = true;
        continue;
      }

      if (!this._removeShipFromSystemScene(runtime, currentSystemID, shipID)) {
        transit.readyAtMs = now + GATE_TRANSIT_MS;
        stateChanged = true;
        continue;
      }
      const moveResult = itemStore.moveShipToSpace(
        shipID,
        nextSystemID,
        buildGateSpaceState(nextSystemID, worldData.getStargateByID(gate.destinationID) || gate),
      );
      if (!moveResult || moveResult.success !== true) {
        log.warn(
          `[NPCMiningWing] char=${characterID} recall gate move failed ` +
            `ship=${shipID} from=${currentSystemID} to=${nextSystemID}`,
        );
        transit.readyAtMs = now + GATE_TRANSIT_MS;
        stateChanged = true;
        continue;
      }

      transit.currentSystemID = nextSystemID;
      transit.nextSystemID = 0;
      transit.readyAtMs = now + GATE_TRANSIT_MS;
      delete character.followTransit[String(shipID)];
      stateChanged = true;
      log.info(
        `[NPCMiningWing] char=${characterID} recall-gate ship=${shipID} ` +
          `from=${currentSystemID} to=${nextSystemID} gate=${positive(gate.itemID)}`,
      );

      const destinationScene = this._findSceneForSystem(runtime, nextSystemID);
      if (destinationScene) {
        const destinationSession = this._findSessionForCharacterInSystem(
          runtime,
          characterID,
          nextSystemID,
        );
        if (destinationSession && currentSpaceSystemID(destinationSession)) {
          try {
            this._ensureDeployedEntity(runtime, destinationScene, nextSystemID, shipID);
          } catch (error) {
            log.warn(
              `[NPCMiningWing] char=${characterID} recall arrival spawn failed ` +
                `ship=${shipID} error=${error.message}`,
            );
          }
        }
      }
    }
    if (character.deployedShipIDs.length === 0) {
      character.recalling = false;
      character.command = "hold";
      stateChanged = true;
    }
    if (stateChanged) {
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
    }
    return stateChanged;
  }

  _tickRemoteFollow(
    runtime,
    characterID,
    character,
    targetSystemID,
    leaderSession = null,
    leader = null,
  ) {
    if (
      !runtime ||
      !character ||
      character.command !== "follow" ||
      character.recalling === true
    ) {
      return false;
    }
    const destinationSystemID = positive(targetSystemID);
    if (!destinationSystemID) {
      return false;
    }

    const now = Date.now();
    const state = this._getState();
    let stateChanged = false;
    const followLeaderInDestination = (shipID, systemID) => {
      if (
        !leaderSession ||
        !currentSpaceSystemID(leaderSession) ||
        currentSpaceSystemID(leaderSession) !== positive(systemID)
      ) {
        return;
      }
      const destinationScene = this._findSceneForSystem(runtime, systemID);
      if (!destinationScene) {
        return;
      }
      let entity = destinationScene.getEntityByID(shipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(runtime, destinationScene, systemID, shipID);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} follow arrival spawn failed ` +
              `ship=${shipID} error=${error.message}`,
          );
          return;
        }
      }
      const leaderEntity = destinationScene.getShipEntityForSession(leaderSession) ||
        (leader && positive(leader.itemID) === positive(currentShipID(leaderSession))
          ? leader
          : null);
      if (!leaderEntity || !entity) {
        return;
      }
      runtime.followDynamicEntity(
        destinationScene.sceneDescriptor || systemID,
        shipID,
        positive(leaderEntity.itemID),
        FOLLOW_RANGE_METERS,
        {broadcast: true},
      );
    };

    for (const [index, shipID] of this._deployedShipIDs(character).entries()) {
      if (
        character.collectionTrip &&
        character.collectionTrip.active === true &&
        positive(character.collectionTrip.shipID) === shipID
      ) {
        continue;
      }
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      const key = String(shipID);
      if (!ship || Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
        this._finishRecalledShip(character, shipID);
        stateChanged = true;
        continue;
      }

      const currentSystem = shipSystemID(ship);
      if (!currentSystem) {
        continue;
      }
      let transit = character.followTransit[key];
      if (currentSystem === destinationSystemID) {
        if (transit) {
          delete character.followTransit[key];
          stateChanged = true;
        }
        followLeaderInDestination(shipID, currentSystem);
        continue;
      }
      if (!transit || typeof transit !== "object") {
        transit = {
          currentSystemID: currentSystem,
          targetSystemID: destinationSystemID,
          nextSystemID: 0,
          readyAtMs: now,
        };
        character.followTransit[key] = transit;
        stateChanged = true;
      } else {
        if (positive(transit.currentSystemID) !== currentSystem) {
          transit.currentSystemID = currentSystem;
          transit.nextSystemID = 0;
          transit.readyAtMs = now;
          stateChanged = true;
        }
        if (positive(transit.targetSystemID) !== destinationSystemID) {
          transit.targetSystemID = destinationSystemID;
          transit.nextSystemID = 0;
          transit.readyAtMs = now;
          stateChanged = true;
        }
      }
      if (finite(transit.readyAtMs, 0) > now) {
        continue;
      }

      if (!this._prepareWingShipForDock(
        null,
        characterID,
        ship,
        this._findSceneForSystem(runtime, currentSystem),
      )) {
        continue;
      }

      const route = this._findRoute(currentSystem, destinationSystemID);
      const nextSystemID = route && positive(route[1]);
      const gate = this._gateBetween(currentSystem, nextSystemID);
      if (!nextSystemID || !gate) {
        log.warn(
          `[NPCMiningWing] char=${characterID} follow route stalled ` +
            `ship=${shipID} from=${currentSystem} target=${destinationSystemID}`,
        );
        transit.readyAtMs = now + GATE_TRANSIT_MS;
        stateChanged = true;
        continue;
      }

      if (!this._removeShipFromSystemScene(runtime, currentSystem, shipID)) {
        transit.readyAtMs = now + GATE_TRANSIT_MS;
        stateChanged = true;
        continue;
      }
      const moveResult = itemStore.moveShipToSpace(
        shipID,
        nextSystemID,
        buildGateSpaceState(
          nextSystemID,
          worldData.getStargateByID(gate.destinationID) || gate,
          index,
        ),
      );
      if (!moveResult || moveResult.success !== true) {
        log.warn(
          `[NPCMiningWing] char=${characterID} follow gate move failed ` +
            `ship=${shipID} from=${currentSystem} to=${nextSystemID} ` +
            `error=${String(moveResult && moveResult.errorMsg || "UNKNOWN")}`,
        );
        transit.readyAtMs = now + GATE_TRANSIT_MS;
        stateChanged = true;
        continue;
      }

      transit.currentSystemID = nextSystemID;
      transit.nextSystemID = 0;
      transit.readyAtMs = now + GATE_TRANSIT_MS;
      stateChanged = true;
      log.info(
        `[NPCMiningWing] char=${characterID} follow-gate ship=${shipID} ` +
          `from=${currentSystem} to=${nextSystemID} gate=${positive(gate.itemID)}`,
      );

      if (nextSystemID === destinationSystemID) {
        followLeaderInDestination(shipID, nextSystemID);
      }
    }

    if (stateChanged) {
      character.revision = positive(character.revision) + 1;
      writeState(state);
    }
    return stateChanged;
  }

  _dockRecalledShip(session, scene, characterID, character, shipID, stationID) {
    const entity = scene.getEntityByID(shipID);
    const station = this._stationEntity(scene, stationID);
    if (!entity || !station || !canShipDockAtStation(entity, station)) {
      return false;
    }
    if (!this._prepareWingShipForDock(session, characterID, itemStore.findCharacterShipItem(characterID, shipID), scene)) {
      return false;
    }
    const dockResult = itemStore.dockShipToLocation(shipID, stationID);
    if (!dockResult || dockResult.success !== true) {
      log.warn(
        `[NPCMiningWing] char=${characterID} recall dock failed ` +
          `ship=${shipID} station=${stationID} ` +
          `error=${String(dockResult && dockResult.errorMsg || "UNKNOWN")}`,
      );
      return false;
    }
    this._depositDockedMiningCargo(session, characterID, shipID, stationID, "local-dock");
    this._syncDockedShipToSession(
      session,
      characterID,
      shipID,
      dockResult,
      "local-dock",
    );
    const removeResult = scene.removeDynamicEntity(shipID, {
      broadcast: true,
      persistSpaceState: false,
    });
    if (!removeResult || removeResult.success !== true) {
      log.warn(
        `[NPCMiningWing] char=${characterID} recall scene cleanup pending ` +
          `ship=${shipID} station=${stationID}`,
      );
    }
    this._finishRecalledShip(character, shipID);
    log.info(
      `[NPCMiningWing] char=${characterID} recalled ship=${shipID} ` +
        `station=${stationID}`,
    );
    return true;
  }

  _clearWarpTargetsForCharacter(characterID) {
    const prefix = `${characterID}:`;
    for (const key of this._warpTargets.keys()) {
      if (key.startsWith(prefix)) {
        this._warpTargets.delete(key);
      }
    }
  }

  _resumeDynamicFollower(runtime, scene, characterID, character, systemID, leader) {
    const leaderID = positive(leader && leader.itemID);
    if (!leaderID) {
      return;
    }
    for (const shipID of this._deployedShipIDs(character)) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || !isShipInSystem(ship, systemID)) {
        continue;
      }
      let entity = scene.getEntityByID(shipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} follow resume spawn failed ` +
              `ship=${shipID} error=${error.message}`,
          );
          continue;
        }
      }
      if (entity.pendingWarp || entity.warpState || entity.mode === "WARP") {
        continue;
      }
      if (
        entity.mode === "FOLLOW" &&
        positive(entity.targetEntityID) === leaderID
      ) {
        continue;
      }
      const result = runtime.followDynamicEntity(
        scene.sceneDescriptor || systemID,
        shipID,
        leaderID,
        FOLLOW_RANGE_METERS,
        {broadcast: true},
      );
      if (result !== true) {
        log.warn(
          `[NPCMiningWing] char=${characterID} follow resume failed ` +
            `ship=${shipID}`,
        );
      }
    }
  }

  _tickWarpFollower(runtime, scene, session, characterID, character, systemID, leader) {
    const warpState = leader && (leader.pendingWarp || leader.warpState);
    if (
      !leader ||
      leader.mode !== "WARP" ||
      !warpState
    ) {
      this._clearWarpTargetsForCharacter(characterID);
      if (leader) {
        this._resumeDynamicFollower(
          runtime,
          scene,
          characterID,
          character,
          systemID,
          leader,
        );
      }
      return;
    }
    const destination = warpState.rawDestination || warpState.targetPoint;
    if (!destination) {
      return;
    }
    const targetSignature = `${systemID}:${pointSignature(destination)}`;
    for (const shipID of this._deployedShipIDs(character)) {
      if (
        character.collectionTrip &&
        character.collectionTrip.active === true &&
        positive(character.collectionTrip.shipID) === shipID
      ) {
        continue;
      }
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || !isShipInSystem(ship, systemID)) {
        continue;
      }
      let entity = scene.getEntityByID(shipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} warp follow spawn failed ` +
              `ship=${shipID} error=${error.message}`,
          );
          continue;
        }
      }
      const warpKey = `${characterID}:${shipID}`;
      if (this._warpTargets.get(warpKey) === targetSignature) {
        continue;
      }
      if (entity.pendingWarp || entity.warpState || entity.mode === "WARP") {
        this._warpTargets.set(warpKey, targetSignature);
        continue;
      }
      if (
        entity.mode === "GOTO" &&
        pointsNear(entity.targetPoint, destination, 10000)
      ) {
        this._warpTargets.set(warpKey, targetSignature);
        continue;
      }
      const result = runtime.startSessionlessWarpIngress(
        scene.sceneDescriptor || systemID,
        shipID,
        destination,
        {
          targetEntityID: positive(warpState.targetEntityID),
          stopDistance: Math.max(0, finite(warpState.stopDistance, 0)),
          broadcastWarpStartToVisibleSessions: true,
          acquireForRelevantSessions: true,
        },
      );
      if (result && result.success === true) {
        this._warpTargets.set(warpKey, targetSignature);
        log.info(
          `[NPCMiningWing] char=${characterID} warp-follow ship=${shipID} ` +
            `system=${systemID}`,
        );
      } else {
        log.warn(
          `[NPCMiningWing] char=${characterID} warp-follow failed ` +
            `ship=${shipID} error=${String(result && result.errorMsg || "UNKNOWN")}`,
        );
      }
    }
  }

  _tickRecall(runtime, scene, session, characterID, character, systemID) {
    const state = this._getState();
    let stateChanged = false;
    const targetStationIDs = character.dockingWithLeader === true
      ? character.dockingStationIDs
      : character.recallStationIDs;
    for (const shipID of this._deployedShipIDs(character)) {
      const stationID = positive(targetStationIDs[String(shipID)]);
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
        this._finishRecalledShip(character, shipID);
        stateChanged = true;
        continue;
      }
      if (!stationID || !isShipInSystem(ship, systemID)) {
        continue;
      }
      const station = this._validateReturnStation(stationID, systemID);
      delete character.recallTransit[String(shipID)];
      let entity = scene.getEntityByID(shipID);
      if (!entity) {
        entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
      }
      const stationEntity = this._stationEntity(scene, stationID) || station;
      if (!this._prepareWingShipForDock(session, characterID, ship, scene)) {
        continue;
      }
      if (canShipDockAtStation(entity, stationEntity)) {
        if (this._dockRecalledShip(session, scene, characterID, character, shipID, stationID)) {
          stateChanged = true;
        }
        continue;
      }
      if (
        entity.pendingWarp ||
        entity.warpState ||
        entity.mode === "WARP" ||
        (
          (entity.mode === "GOTO" || entity.mode === "FOLLOW") &&
          positive(entity.targetEntityID) === stationID &&
          pointsNear(entity.targetPoint, station.position, 10000)
        )
      ) {
        continue;
      }
      this._issueRecallMovement(runtime, scene, systemID, shipID, stationID);
    }
    if (character.deployedShipIDs.length === 0) {
      character.recalling = false;
      this._clearDockingState(character);
      character.command = "hold";
      stateChanged = true;
    }
    if (stateChanged) {
      character.revision = positive(character.revision) + 1;
      writeState(state);
    }
  }

  _applyWingSkillProfile(characterID, ship, entity) {
    if (!ship || !entity || !positive(characterID)) {
      return null;
    }

    const fitting = getLiveFittingState();
    const fittedItems = fitting.getFittedModuleItems(
      characterID,
      positive(ship.itemID),
    );
    const skillMap = getSkillState().getCachedCharacterSkillMap(characterID);
    const resourceState = fitting.buildShipResourceState(characterID, ship, {
      fittedItems,
      skillMap,
    });

    // A deployed wing ship is intentionally unpiloted in the Destiny
    // presentation, so the normal runtime entity has no pilot skill map. Keep
    // that presentation while giving its dogma/mining calculations the same
    // complete skill set as the owner who commanded the wing.
    entity.skillMap = skillMap;
    entity.fittedItems = fittedItems.map((item) => ({...item}));
    entity.npcMiningWingSkillOwnerID = positive(characterID);
    entity.npcMiningWingCharacterID = positive(characterID);
    entity.npcMiningWingController = true;
    entity.npcMiningWingHiveMember = true;
    entity.npcMiningWingLeader = false;
    entity.runtimeOwnerCharacterID = positive(characterID);
    // The native drone tick resolves a sessionless ship controller through
    // pilotCharacterID. Wing ships are intentionally unpiloted in the client
    // presentation, so their custom owner fields alone are not enough: the
    // first mining tick would reject the asteroid and return the drone to the
    // ship's idle orbit. This is runtime ownership metadata only; it does not
    // put the player's pilot into the wing hull or change the ship inventory.
    entity.pilotCharacterID = positive(characterID);
    this._registerHiveShipIdentity(entity, ship, characterID);
    entity.passiveDerivedState = resourceState || entity.passiveDerivedState;

    const runtimeFields = [
      "maxVelocity",
      "mass",
      "agility",
      "maxTargetRange",
      "maxLockedTargets",
      "signatureRadius",
      "cloakingTargetingDelay",
      "scanResolution",
      "capacitorCapacity",
      "capacitorRechargeRate",
      "shieldCapacity",
      "shieldRechargeRate",
      "armorHP",
      "structureHP",
      "cargoCapacity",
    ];
    for (const field of runtimeFields) {
      const value = finite(resourceState && resourceState[field], NaN);
      if (Number.isFinite(value)) {
        entity[field] = value;
      }
    }
    if (finite(resourceState && resourceState.agility, 0) > 0) {
      entity.inertia = finite(resourceState.agility, entity.inertia);
    }

    log.info(
      `[NPCMiningWing] char=${characterID} skill profile applied ` +
        `ship=${ship.itemID} targetRange=${entity.maxTargetRange} ` +
        `maxLocks=${entity.maxLockedTargets} skills=${skillMap.size}`,
    );
    return {fittedItems, skillMap, resourceState};
  }

  _buildWingModuleSession(session, characterID, entity) {
    const pseudoSession = session && typeof session === "object"
      ? Object.create(session)
      : {};
    const baseSpace = session && session._space && typeof session._space === "object"
      ? session._space
      : {};
    const systemID = positive(entity && entity.systemID);
    const shipID = positive(entity && entity.itemID);
    pseudoSession.characterID = positive(characterID);
    pseudoSession.charid = positive(characterID);
    pseudoSession.shipID = shipID;
    pseudoSession._space = {
      ...baseSpace,
      systemID,
      shipID,
      sceneKey: entity && entity.sceneKey || baseSpace.sceneKey,
      sceneKind: entity && entity.sceneKind || baseSpace.sceneKind,
      instanceID: entity && entity.instanceID || baseSpace.instanceID,
      sceneDescriptor: entity && entity.sceneDescriptor || baseSpace.sceneDescriptor,
    };
    return pseudoSession;
  }

  _wingDroneEntities(scene, shipID) {
    if (!scene || !(scene.dynamicEntities instanceof Map)) {
      return [];
    }
    const numericShipID = positive(shipID);
    return [...scene.dynamicEntities.values()]
      .filter((entity) => (
        entity &&
        entity.kind === "drone" &&
        positive(entity.controllerID) === numericShipID
      ));
  }

  _wingDroneItemsForShip(characterID, shipID, systemID) {
    const numericCharacterID = positive(characterID);
    const numericShipID = positive(shipID);
    const numericSystemID = positive(systemID);
    if (!numericCharacterID || !numericShipID || !numericSystemID) {
      return [];
    }
    return itemStore
      .listSystemSpaceItems(numericSystemID)
      .filter((item) => (
        Number(item && item.ownerID) === numericCharacterID &&
        Number(item && item.categoryID) === DRONE_CATEGORY_ID &&
        wingDroneMarkerShipID(item) === numericShipID
      ));
  }

  _recoverWingDroneItem(characterID, ship, item) {
    const numericCharacterID = positive(characterID);
    const shipID = positive(ship && ship.itemID);
    const droneID = positive(item && item.itemID);
    const systemID = positive(
      item && item.spaceState && item.spaceState.systemID ||
      item && item.locationID,
    );
    if (
      !numericCharacterID ||
      !shipID ||
      !droneID ||
      !systemID ||
      Number(item && item.ownerID) !== numericCharacterID ||
      Number(item && item.categoryID) !== DRONE_CATEGORY_ID ||
      Number(item && item.flagID) !== 0
    ) {
      return {success: false, errorMsg: "NPC_WING_DRONE_RECOVERY_SOURCE_INVALID"};
    }

    const result = getItemCustody().transfer({
      items: {itemID: droneID},
      from: getItemCustody().custodyRef.inSpace(
        numericCharacterID,
        systemID,
        item.spaceState || null,
      ),
      to: getItemCustody().custodyRef.shipBay(
        numericCharacterID,
        shipID,
        itemStore.ITEM_FLAGS.DRONE_BAY,
      ),
      reason: getItemCustody().CUSTODY_REASON.DRONE_RECOVER,
      actor: numericCharacterID,
      idempotencyKey: `npc-mining-wing-drone-recover:${droneID}:${shipID}`,
      options: {
        destinationItemPatch: {
          customInfo: item.customInfo,
          singleton: 1,
          quantity: 1,
          stacksize: 1,
          launcherID: null,
          spaceState: null,
        },
      },
    });
    if (result && result.success === true) {
      log.info(
        `[NPCMiningWing] char=${numericCharacterID} recovered drone=${droneID} ` +
          `to ship=${shipID} after wing reload`,
      );
    }
    return result;
  }

  _recoverDockedWingDrones() {
    const state = this._getState();
    for (const [characterID, character] of Object.entries(state.characters || {})) {
      const numericCharacterID = positive(characterID);
      if (!numericCharacterID || !character) {
        continue;
      }
      const markedShipIDs = new Set([
        ...(Array.isArray(character.markedShipIDs) ? character.markedShipIDs : []),
        ...this._deployedShipIDs(character),
      ].map(positive).filter(Boolean));
      if (markedShipIDs.size <= 0) {
        continue;
      }
      let candidates;
      try {
        const allItems = itemStore.getAllItems();
        const itemRows = Array.isArray(allItems)
          ? allItems
          : Object.values(allItems || {});
        candidates = itemRows.filter((item) => (
          Number(item && item.ownerID) === numericCharacterID &&
          Number(item && item.categoryID) === DRONE_CATEGORY_ID &&
          Number(item && item.flagID) === 0 &&
          wingDroneMarkerShipID(item) > 0 &&
          markedShipIDs.has(wingDroneMarkerShipID(item))
        ));
      } catch (error) {
        log.warn(
          `[NPCMiningWing] char=${numericCharacterID} wing drone recovery scan failed: ` +
            `${error.message}`,
        );
        continue;
      }
      for (const item of candidates) {
        const shipID = wingDroneMarkerShipID(item);
        const ship = itemStore.findCharacterShipItem(numericCharacterID, shipID);
        if (!ship || Number(ship.flagID) !== itemStore.ITEM_FLAGS.HANGAR) {
          continue;
        }
        try {
          this._recoverWingDroneItem(numericCharacterID, ship, item);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${numericCharacterID} drone recovery failed ` +
              `drone=${positive(item && item.itemID)} ship=${shipID}: ${error.message}`,
          );
        }
      }
    }
  }

  _markWingDroneEntities(scene, shipID) {
    const numericShipID = positive(shipID);
    if (!scene || !numericShipID) {
      return;
    }
    for (const drone of this._wingDroneEntities(scene, numericShipID)) {
      const item = itemStore.findItemById(positive(drone && drone.itemID));
      if (!item || Number(item.categoryID) !== DRONE_CATEGORY_ID) {
        continue;
      }
      const customInfo = markWingDroneCustomInfo(item, numericShipID);
      if (customInfo === String(item.customInfo || "")) {
        continue;
      }
      itemStore.updateInventoryItem(item.itemID, (currentItem) => ({
        ...currentItem,
        customInfo,
        launcherID: numericShipID,
      }));
    }
  }

  _reattachWingDroneEntities(scene, characterID) {
    if (!scene || !(scene.dynamicEntities instanceof Map)) {
      return;
    }
    const numericCharacterID = positive(characterID);
    if (!numericCharacterID) {
      return;
    }
    for (const entity of scene.dynamicEntities.values()) {
      if (!entity || entity.kind !== "drone") {
        continue;
      }
      const item = itemStore.findItemById(positive(entity.itemID));
      const shipID = wingDroneMarkerShipID(item);
      if (!shipID || Number(item.ownerID) !== numericCharacterID) {
        continue;
      }
      const ship = itemStore.findCharacterShipItem(numericCharacterID, shipID);
      const shipEntity = scene.getEntityByID(shipID);
      if (
        !ship ||
        Number(ship.flagID) !== 0 ||
        shipSystemID(ship) !== positive(scene.systemID) ||
        !shipEntity
      ) {
        continue;
      }
      entity.launcherID = shipID;
      entity.controllerID = shipID;
      entity.controllerOwnerID = numericCharacterID;
      entity.droneStateVisible = true;
      itemStore.updateInventoryItem(item.itemID, (currentItem) => ({
        ...currentItem,
        launcherID: shipID,
        customInfo: markWingDroneCustomInfo(currentItem, shipID),
      }));
    }
  }

  _prepareWingShipForDock(session, characterID, ship, scene = null) {
    const shipID = positive(ship && ship.itemID);
    const systemID = shipSystemID(ship);
    if (!shipID || !systemID) {
      return true;
    }
    const activeScene = scene || this._findSceneForSystem(getSpaceRuntime(), systemID);
    const entity = activeScene && activeScene.getEntityByID(shipID);
    if (activeScene && entity) {
      this._reattachWingDroneEntities(activeScene, characterID);
      const drones = this._wingDroneEntities(activeScene, shipID);
      if (drones.length > 0) {
        this._returnWingDronesToBay(
          session,
          characterID,
          entity,
          ship,
          null,
          activeScene,
        );
        return false;
      }
    }

    const orphaned = this._wingDroneItemsForShip(characterID, shipID, systemID);
    if (orphaned.length > 0) {
      for (const item of orphaned) {
        try {
          this._recoverWingDroneItem(characterID, ship, item);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} drone recovery pending ` +
              `drone=${positive(item && item.itemID)} ship=${shipID}: ${error.message}`,
          );
        }
      }
      return this._wingDroneItemsForShip(characterID, shipID, systemID).length === 0;
    }
    return true;
  }

  _wingDroneTaskTargetID(drone) {
    return positive(
      drone && drone.droneCombat && drone.droneCombat.targetID ||
      drone && drone.droneMining && drone.droneMining.targetID ||
      drone && drone.targetID,
    );
  }

  _wingShipOwnerID(characterID, shipRecord) {
    const ownerCharacterID = positive(shipRecord && shipRecord.ownerID);
    const expectedOwnerID = positive(characterID);
    return ownerCharacterID &&
      (!expectedOwnerID || expectedOwnerID === ownerCharacterID)
      ? ownerCharacterID
      : 0;
  }

  _wingDroneCapabilities(drone, controller, characterID, shipRecord) {
    // Use persisted ownership as the source; only cross-check a positive live ID.
    const ownerCharacterID = this._wingShipOwnerID(characterID, shipRecord);
    const shipID = positive(shipRecord && shipRecord.itemID);
    const droneID = positive(drone && drone.itemID);
    let reason = "";
    if (!ownerCharacterID) {
      reason = "owner_unavailable_or_mismatched";
    } else if (!controller) {
      reason = "controller_unavailable";
    } else if (!shipID) {
      reason = "ship_record_id_unavailable";
    } else if (positive(controller.itemID) !== shipID) {
      reason = "controller_ship_mismatch";
    } else if (positive(shipRecord.ownerID) !== ownerCharacterID) {
      reason = "record_owner_mismatch";
    }
    if (reason) {
      this._traceWingDrone("capability.rejected", {
        characterID: positive(characterID),
        ownerCharacterID,
        shipID,
        entityShipID: positive(controller && controller.itemID),
        droneID,
        recordOwnerID: positive(shipRecord && shipRecord.ownerID),
        reason,
      }, 10_000, `capability-rejected:${positive(characterID)}:${shipID}:${droneID}`);
      return {combatSnapshot: null, miningSnapshot: null};
    }
    try {
      const runtime = getDroneRuntime();
      if (typeof runtime.resolveWingDroneCapabilities !== "function") {
        this._traceWingDrone("capability.unavailable", {
          characterID: ownerCharacterID,
          shipID,
          droneID,
          reason: "capability_resolver_missing",
        }, 10_000, `capability-unavailable:${ownerCharacterID}:${shipID}:${droneID}`);
        return {combatSnapshot: null, miningSnapshot: null};
      }
      const capabilities = runtime.resolveWingDroneCapabilities(
        drone,
        controller,
        shipRecord,
        ownerCharacterID,
      ) || {
        combatSnapshot: null,
        miningSnapshot: null,
      };
      this._traceWingDrone("capability.result", {
        characterID: ownerCharacterID,
        shipID,
        droneID,
        typeID: positive(drone && drone.typeID),
        name: String(drone && (drone.itemName || drone.typeName) || "").slice(0, 100),
        combatProfile: Boolean(capabilities.combatSnapshot),
        miningProfile: Boolean(capabilities.miningSnapshot),
      }, 5_000, `capability-result:${ownerCharacterID}:${shipID}:${droneID}`);
      return capabilities;
    } catch (error) {
      this._traceWingDrone("capability.throw", {
        characterID: ownerCharacterID,
        shipID,
        droneID,
        error: String(error && error.message || error),
      }, 10_000, `capability-throw:${ownerCharacterID}:${shipID}:${droneID}`);
      return {combatSnapshot: null, miningSnapshot: null};
    }
  }

  _wingDroneMiningFamily(drone) {
    const metadata = itemStore.getItemMetadata(
      positive(drone && drone.typeID),
      drone && (drone.itemName || drone.typeName),
    );
    const name = String(
      metadata && (metadata.name || metadata.typeName) ||
      drone && (drone.itemName || drone.typeName) ||
      "",
    ).toLowerCase();
    if (name.includes("ice harvesting")) {
      return "ice";
    }
    if (
      name.includes("mining drone") ||
      name.includes("augmented") && name.includes("mining") ||
      name.includes("excavator")
    ) {
      return "ore";
    }
    return "";
  }

  _wingDroneBayItems(characterID, shipID) {
    return itemStore
      .listContainerItems(
        characterID,
        shipID,
        itemStore.ITEM_FLAGS.DRONE_BAY,
      )
      .filter((item) => Number(item && item.categoryID) === DRONE_CATEGORY_ID);
  }

  _wingDroneLaunchRequests(items) {
    return (Array.isArray(items) ? items : [])
      // The native drone runtime consumes the same wire shape as the client:
      // [itemID, quantity]. Passing an object here is accepted by the service
      // boundary but normalizes to an empty request, which looks like a
      // successful launch with zero drones.
      .map((item) => [
        positive(item && item.itemID),
        Math.max(1, itemQuantity(item)),
      ])
      .filter((request) => request[0] > 0);
  }

  _wingDroneNotice(session, characterID, shipID, message, field = "") {
    const runtime = this._stateRuntimeContext(session);
    const entity = runtime && runtime.scene && runtime.scene.getEntityByID(shipID);
    const noticeKey = field ? `npcMiningWingNotice${field}` : "npcMiningWingNotice";
    const stamp = `${String(message || "")}:${Math.floor(Date.now() / 5000)}`;
    if (entity && entity[noticeKey] === stamp) {
      return false;
    }
    if (entity) {
      entity[noticeKey] = stamp;
    }
    this._sendWingChat(session, characterID, shipID, message);
    return true;
  }

  _droneResponseError(response) {
    if (!response || typeof response !== "object") {
      return "";
    }
    if (response.success === false) {
      return String(response.errorMsg || "Drone command failed");
    }
    const visit = (value) => {
      if (!value) {
        return "";
      }
      if (Array.isArray(value)) {
        if (String(value[0] || "") === "CustomNotify") {
          const notifyDict = value[1];
          const notifyEntry = notifyDict && Array.isArray(notifyDict.entries)
            ? notifyDict.entries.find((entry) => (
              Array.isArray(entry) && String(entry[0] || "") === "notify"
            ))
            : null;
          if (notifyEntry && notifyEntry[1]) {
            return String(notifyEntry[1]);
          }
        }
        for (const entry of value) {
          const nested = visit(entry);
          if (nested) {
            return nested;
          }
        }
        return "";
      }
      if (value.type === "dict" && Array.isArray(value.entries)) {
        for (const entry of value.entries) {
          const nested = visit(Array.isArray(entry) ? entry[1] : null);
          if (nested) {
            return nested;
          }
        }
      } else if (value.type === "list" && Array.isArray(value.items)) {
        for (const entry of value.items) {
          const nested = visit(entry);
          if (nested) {
            return nested;
          }
        }
      }
      return "";
    };
    return visit(response.response || response);
  }

  _droneResponseSummary(response) {
    if (response === null || response === undefined) {
      return {present: false};
    }
    try {
      let error = "";
      try {
        error = this._droneResponseError(response);
      } catch (inspectionError) {
        error = `response_inspection_failed:${String(inspectionError && inspectionError.message || inspectionError)}`;
      }
      return {
        present: true,
        success: typeof response.success === "boolean" ? response.success : null,
        error: String(error || "").slice(0, 300) || null,
        keys: typeof response === "object" ? Object.keys(response).slice(0, 12) : [],
      };
    } catch (error) {
      return {
        present: true,
        summaryError: String(error && error.message || error).slice(0, 300),
      };
    }
  }

  _traceWingDrone(event, fields = {}, throttleMs = 0, throttleKey = "") {
    try {
      if (!miningTrace.enabled) return false;
      if (throttleMs > 0) {
        const now = Date.now();
        const key = String(throttleKey || (
          `${event}:${positive(fields.characterID)}:` +
          `${positive(fields.shipID)}:${positive(fields.targetID)}`
        ));
        const previousAt = finite(this._droneTraceAt.get(key), 0);
        if (now - previousAt < throttleMs) {
          return false;
        }
        this._droneTraceAt.set(key, now);
        if (this._droneTraceAt.size > 2048) {
          for (const [existingKey, timestamp] of this._droneTraceAt.entries()) {
            if (now - finite(timestamp, 0) > 60_000) {
              this._droneTraceAt.delete(existingKey);
            }
          }
        }
      }
      miningTrace.log(`drone.${event}`, fields);
      return true;
    } catch (_) {
      return false;
    }
  }

  _wingDroneTraceSummary(drone) {
    const mining = drone && drone.droneMining && typeof drone.droneMining === "object"
      ? drone.droneMining
      : null;
    const combat = drone && drone.droneCombat && typeof drone.droneCombat === "object"
      ? drone.droneCombat
      : null;
    return {
      droneID: positive(drone && drone.itemID),
      typeID: positive(drone && drone.typeID),
      ownerID: positive(drone && drone.ownerID),
      controllerID: positive(drone && drone.controllerID),
      controllerOwnerID: positive(drone && drone.controllerOwnerID),
      command: String(drone && drone.droneCommand || ""),
      activityState: positive(drone && drone.activityState),
      targetID: this._wingDroneTaskTargetID(drone),
      mining: mining ? {
        targetID: positive(mining.targetID),
        cycleStartedAtMs: finite(mining.cycleStartedAtMs, 0),
        nextCycleAtMs: finite(mining.nextCycleAtMs, 0),
        hasSnapshot: Boolean(mining.snapshot),
      } : null,
      combat: combat ? {
        targetID: positive(combat.targetID),
        nextCycleAtMs: finite(combat.nextCycleAtMs, 0),
        hasSnapshot: Boolean(combat.snapshot),
      } : null,
    };
  }

  _returnWingDronesToBay(
    session,
    characterID,
    entity,
    shipRecord,
    predicate = null,
    sceneOverride = null,
    purpose = "automation",
  ) {
    const runtime = getDroneRuntime();
    characterID = this._wingShipOwnerID(characterID, shipRecord);
    if (
      !runtime ||
      typeof runtime.commandReturnBayForWingShip !== "function" ||
      !entity ||
      !shipRecord ||
      !characterID
    ) {
      const response = {success: false, errorMsg: "NPC_WING_DRONE_OWNER_OR_CONTROLLER_UNAVAILABLE"};
      this._traceWingDrone("return.rejected", {
        purpose,
        characterID,
        shipID: positive(shipRecord && shipRecord.itemID),
        entityShipID: positive(entity && entity.itemID),
        reason: !runtime ? "drone_runtime_unavailable" : !characterID
          ? "owner_unavailable"
          : "controller_or_return_method_unavailable",
        result: this._droneResponseSummary(response),
      }, 5_000, `return-rejected:${positive(characterID)}:${positive(shipRecord && shipRecord.itemID)}`);
      return response;
    }
    const scene = sceneOverride || this._stateRuntimeContext(session).scene;
    const drones = this._wingDroneEntities(scene, entity.itemID).filter((drone) => (
      drone.droneCommand !== DRONE_COMMAND_RETURN_BAY &&
      (!predicate || predicate(drone))
    ));
    const droneIDs = drones.map((drone) => positive(drone.itemID)).filter(Boolean);
    if (droneIDs.length <= 0) {
      this._traceWingDrone("return.skipped", {
        purpose,
        characterID,
        shipID: positive(shipRecord.itemID),
        reason: "no_matching_drones",
      }, 5_000, `return-skipped:${positive(characterID)}:${positive(shipRecord.itemID)}:${purpose}`);
      return {success: true, data: {droneIDs: []}};
    }
    const traceFields = {
      purpose,
      characterID,
      shipID: positive(shipRecord.itemID),
      droneIDs: droneIDs.slice(0, 24),
      droneCount: droneIDs.length,
      drones: drones.slice(0, 24).map((drone) => this._wingDroneTraceSummary(drone)),
    };
    this._traceWingDrone("return.before", traceFields);
    try {
      const response = runtime.commandReturnBayForWingShip(
        session,
        entity,
        shipRecord,
        droneIDs,
        characterID,
      );
      this._traceWingDrone("return.after", {
        ...traceFields,
        result: this._droneResponseSummary(response),
      });
      return response;
    } catch (error) {
      this._traceWingDrone("return.throw", {
        ...traceFields,
        error: String(error && error.message || error),
      });
      throw error;
    }
  }

  _launchWingDrones(
    session,
    characterID,
    entity,
    shipRecord,
    predicate,
    purpose = "automation",
    traceContext = {},
  ) {
    const runtime = getDroneRuntime();
    characterID = this._wingShipOwnerID(characterID, shipRecord);
    if (
      !runtime ||
      typeof runtime.launchDronesForWingShip !== "function" ||
      !entity ||
      !shipRecord ||
      !characterID
    ) {
      const response = {
        success: false,
        errorMsg: "NPC_WING_DRONE_OWNER_OR_CONTROLLER_UNAVAILABLE",
      };
      this._traceWingDrone("launch.rejected", {
        purpose,
        characterID,
        shipID: positive(shipRecord && shipRecord.itemID),
        ...traceContext,
        entityShipID: positive(entity && entity.itemID),
        recordOwnerID: positive(shipRecord && shipRecord.ownerID),
        reason: !runtime ? "drone_runtime_unavailable" : !characterID
          ? "owner_unavailable_or_mismatched"
          : "controller_or_launch_method_unavailable",
        result: this._droneResponseSummary(response),
      }, 5_000, `launch-rejected:${purpose}:${positive(characterID)}:${positive(shipRecord && shipRecord.itemID)}`);
      return response;
    }
    let bayItems;
    let candidates;
    let requests;
    try {
      bayItems = this._wingDroneBayItems(characterID, shipRecord.itemID);
      candidates = bayItems.filter(predicate);
      requests = this._wingDroneLaunchRequests(candidates);
    } catch (error) {
      this._traceWingDrone("launch.scan.throw", {
        purpose,
        characterID,
        shipID: positive(shipRecord.itemID),
        ...traceContext,
        error: String(error && error.message || error),
      });
      throw error;
    }
    const traceFields = {
      purpose,
      characterID,
      shipID: positive(shipRecord.itemID),
      ...traceContext,
      entityShipID: positive(entity && entity.itemID),
      recordOwnerID: positive(shipRecord.ownerID),
      bayDroneCount: bayItems.length,
      bayItems: bayItems.slice(0, 24).map((item) => ({
        itemID: positive(item && item.itemID),
        typeID: positive(item && item.typeID),
        name: String(item && (item.itemName || item.typeName) || "").slice(0, 100),
        quantity: itemQuantity(item),
        family: this._wingDroneMiningFamily(item) || null,
      })),
      compatibleCount: candidates.length,
      requests: requests.slice(0, 24),
      candidateItems: candidates.slice(0, 24).map((item) => ({
        itemID: positive(item && item.itemID),
        typeID: positive(item && item.typeID),
        quantity: itemQuantity(item),
        family: this._wingDroneMiningFamily(item) || null,
      })),
    };
    if (requests.length <= 0) {
      this._traceWingDrone("launch.skipped", {
        ...traceFields,
        reason: bayItems.length > 0 ? "no_compatible_drones" : "drone_bay_empty",
      }, 5_000, `launch-skipped:${purpose}:${positive(characterID)}:${positive(shipRecord.itemID)}`);
      return null;
    }
    this._traceWingDrone("launch.before", traceFields);
    try {
      const response = runtime.launchDronesForWingShip(
        session,
        entity,
        shipRecord,
        requests,
        characterID,
      );
      this._markWingDroneEntities(
        this._stateRuntimeContext(session).scene || null,
        shipRecord.itemID,
      );
      const activeDrones = this._wingDroneEntities(
        this._stateRuntimeContext(session).scene || null,
        shipRecord.itemID,
      );
      this._traceWingDrone("launch.after", {
        ...traceFields,
        result: this._droneResponseSummary(response),
        activeDroneCount: activeDrones.length,
        activeDrones: activeDrones.slice(0, 24).map((drone) => this._wingDroneTraceSummary(drone)),
      });
      return response;
    } catch (error) {
      this._traceWingDrone("launch.throw", {
        ...traceFields,
        error: String(error && error.message || error),
      });
      throw error;
    }
  }

  _activeWingDroneIDs(scene, entity, controller) {
    return this._wingDroneEntities(scene, entity && entity.itemID)
      .filter((drone) => Boolean(controller(drone)))
      .map((drone) => positive(drone.itemID))
      .filter(Boolean);
  }

  _maintainMiningDrones(
    session,
    characterID,
    shipRecord,
    entity,
    scene,
    targetEntity,
    mineableState,
  ) {
    const runtime = getDroneRuntime();
    characterID = this._wingShipOwnerID(characterID, shipRecord);
    let skipReason = "";
    if (!runtime) {
      skipReason = "drone_runtime_unavailable";
    } else if (typeof runtime.commandMineForWingShip !== "function") {
      skipReason = "mining_command_unavailable";
    } else if (!characterID) {
      skipReason = "owner_unavailable_or_mismatched";
    } else if (!entity) {
      skipReason = "controller_unavailable";
    } else if (!targetEntity) {
      skipReason = "target_unavailable";
    } else if (!mineableState) {
      skipReason = "mineable_state_unavailable";
    } else if (entity.npcMiningWingDroneDefenseActive === true) {
      skipReason = "combat_defense_active";
    }
    if (skipReason) {
      this._traceWingDrone("mining.skipped", {
        characterID,
        shipID: positive(shipRecord && shipRecord.itemID),
        entityShipID: positive(entity && entity.itemID),
        targetID: positive(targetEntity && targetEntity.itemID),
        reason: skipReason,
      }, 5_000, `mining-skipped:${positive(characterID)}:${positive(shipRecord && shipRecord.itemID)}`);
      return {active: 0, assigned: 0, launched: false};
    }

    const targetFamily = String(mineableState.yieldKind || "ore").toLowerCase();
    const isCompatible = (drone) => {
      const family = this._wingDroneMiningFamily(drone);
      const capabilities = this._wingDroneCapabilities(
        drone,
        entity,
        characterID,
        shipRecord,
      );
      return Boolean(
        capabilities.miningSnapshot &&
        family === targetFamily,
      );
    };

    const launchResponse = this._launchWingDrones(
      session,
      characterID,
      entity,
      shipRecord,
      isCompatible,
      "mining",
      {
        targetID: positive(targetEntity.itemID),
        targetFamily,
      },
    );
    const launchError = this._droneResponseError(launchResponse);
    if (launchError && this._wingDroneNotice(
      session,
      characterID,
      entity.itemID,
      `I could not launch mining drones: ${friendlyErrorMessage(launchError)}`,
      "MiningDrones",
    )) {
      log.warn(
        `[NPCMiningWing] char=${characterID} mining-drone launch failed ` +
          `ship=${shipRecord.itemID} error=${launchError}`,
      );
    }
    const drones = this._wingDroneEntities(scene, entity.itemID);
    const compatibleDrones = drones.filter(isCompatible);
    const assignmentIDs = compatibleDrones
      .filter((drone) => (
        drone.droneCommand !== DRONE_COMMAND_MINE ||
        this._wingDroneTaskTargetID(drone) !== positive(targetEntity.itemID)
      ))
      .map((drone) => positive(drone.itemID))
      .filter(Boolean);
    let assignmentResponse = null;
    if (assignmentIDs.length > 0) {
      const assignmentFields = {
        characterID,
        shipID: positive(shipRecord.itemID),
        targetID: positive(targetEntity.itemID),
        droneIDs: assignmentIDs.slice(0, 24),
        droneCount: assignmentIDs.length,
        drones: compatibleDrones
          .filter((drone) => assignmentIDs.includes(positive(drone.itemID)))
          .slice(0, 24)
          .map((drone) => this._wingDroneTraceSummary(drone)),
      };
      this._traceWingDrone("mining.assignment.before", assignmentFields);
      try {
        assignmentResponse = runtime.commandMineForWingShip(
          session,
          entity,
          shipRecord,
          assignmentIDs,
          positive(targetEntity.itemID),
          characterID,
        );
        this._traceWingDrone("mining.assignment.after", {
          ...assignmentFields,
          result: this._droneResponseSummary(assignmentResponse),
        });
      } catch (error) {
        this._traceWingDrone("mining.assignment.throw", {
          ...assignmentFields,
          error: String(error && error.message || error),
        });
        throw error;
      }
    }
    const assignmentError = this._droneResponseError(assignmentResponse);
    if (launchResponse && !launchError && compatibleDrones.length > 0) {
      log.info(
        `[NPCMiningWing] char=${characterID} mining drones launched ` +
          `ship=${shipRecord.itemID} target=${targetEntity.itemID} ` +
          `active=${compatibleDrones.length}`,
      );
      this._wingDroneNotice(
        session,
        characterID,
        entity.itemID,
        `I deployed ${compatibleDrones.length} mining drone(s) for this target.`,
        "MiningDrones",
      );
    } else if (launchResponse && !launchError && compatibleDrones.length <= 0) {
      log.warn(
        `[NPCMiningWing] char=${characterID} mining-drone launch produced ` +
          `no active drones ship=${shipRecord.itemID} target=${targetEntity.itemID}`,
      );
    }
    if (assignmentError && this._wingDroneNotice(
      session,
      characterID,
      entity.itemID,
      `I could not assign mining drones: ${friendlyErrorMessage(assignmentError)}`,
      "MiningDrones",
    )) {
      log.warn(
        `[NPCMiningWing] char=${characterID} mining-drone assignment failed ` +
          `ship=${shipRecord.itemID} target=${targetEntity.itemID} ` +
          `error=${assignmentError}`,
      );
    }
    let miningOutput = {quantity: null, itemSummary: "unavailable"};
    try {
      const output = this._miningOutputSnapshot(characterID, shipRecord.itemID);
      miningOutput = {
        quantity: output.quantity,
        itemSummary: output.itemSummary,
      };
    } catch (error) {
      miningOutput = {quantity: null, error: String(error && error.message || error)};
    }
    this._traceWingDrone("mining.state", {
      characterID,
      shipID: positive(shipRecord.itemID),
      targetID: positive(targetEntity.itemID),
      targetFamily,
      remainingQuantity: finite(mineableState.remainingQuantity, 0),
      launched: Boolean(launchResponse),
      launchResult: this._droneResponseSummary(launchResponse),
      assignmentResult: this._droneResponseSummary(assignmentResponse),
      activeDroneCount: compatibleDrones.length,
      activeDrones: compatibleDrones.slice(0, 24).map((drone) => this._wingDroneTraceSummary(drone)),
      shipMiningOutput: miningOutput,
    }, 5_000, `mining-state:${positive(characterID)}:${positive(shipRecord.itemID)}`);
    return {
      active: compatibleDrones.length,
      assigned: assignmentIDs.length,
      launched: Boolean(launchResponse),
      launchResponse,
      assignmentResponse,
    };
  }

  _recallMiningDrones(session, characterID, entity, shipRecord, scene) {
    return this._returnWingDronesToBay(
      session,
      characterID,
      entity,
      shipRecord,
      (drone) => Boolean(
        this._wingDroneCapabilities(
          drone,
          entity,
          characterID,
          shipRecord,
        ).miningSnapshot,
      ),
      scene,
      "combat-interrupt",
    );
  }

  _tickWingDroneDefense(
    runtime,
    scene,
    session,
    characterID,
    character,
    shipRecord,
    entity,
    miningState,
    sharedThreats = [],
  ) {
    const droneAPI = getDroneRuntime();
    if (!droneAPI || typeof droneAPI.getNpcMiningWingAggression !== "function") {
      this._traceWingDrone("defense.skipped", {
        characterID: positive(characterID),
        shipID: positive(shipRecord && shipRecord.itemID),
        entityShipID: positive(entity && entity.itemID),
        reason: "aggression_api_unavailable",
      }, 5_000, `defense-api:${positive(characterID)}:${positive(shipRecord && shipRecord.itemID)}`);
      return false;
    }
    const now = Date.now();
    const overrides = character && character.hiveDefenseOverrides || {};
    const traceLocalLookup = this._traceWingDrone("defense.local_lookup.before", {
      characterID: positive(characterID),
      shipID: positive(shipRecord && shipRecord.itemID),
      entityShipID: positive(entity && entity.itemID),
    }, 5_000, `defense-local:${positive(characterID)}:${positive(shipRecord && shipRecord.itemID)}`);
    let rawLocalThreats;
    let localThreats;
    try {
      rawLocalThreats = droneAPI.getNpcMiningWingAggression(entity.itemID, now);
      localThreats = rawLocalThreats.filter((entry) => (
        finite(entry && entry.lastAggressedAtMs, 0) >
          finite(overrides[String(positive(entry && entry.targetID))], 0)
      ));
    } catch (error) {
      if (traceLocalLookup) {
        this._traceWingDrone("defense.local_lookup.throw", {
          characterID: positive(characterID),
          shipID: positive(shipRecord && shipRecord.itemID),
          rawThreatCount: Array.isArray(rawLocalThreats) ? rawLocalThreats.length : null,
          error: String(error && error.message || error),
        });
      }
      throw error;
    }
    if (traceLocalLookup) {
      this._traceWingDrone("defense.local_lookup.after", {
        characterID: positive(characterID),
        shipID: positive(shipRecord && shipRecord.itemID),
        rawThreatCount: Array.isArray(rawLocalThreats) ? rawLocalThreats.length : null,
        unresolvedThreatCount: localThreats.length,
        threats: localThreats.slice(0, 16).map((entry) => ({
          targetID: positive(entry && entry.targetID),
          lastAggressedAtMs: finite(entry && entry.lastAggressedAtMs, 0),
        })),
      });
    }
    const threatByTarget = new Map();
    for (const entry of [...localThreats, ...sharedThreats]) {
      const targetID = positive(entry && entry.targetID);
      if (!targetID) {
        continue;
      }
      const previous = threatByTarget.get(String(targetID));
      if (
        !previous ||
        finite(entry && entry.lastAggressedAtMs, 0) >
          finite(previous.lastAggressedAtMs, 0)
      ) {
        threatByTarget.set(String(targetID), entry);
      }
    }
    const threats = [...threatByTarget.values()]
      .map((entry) => ({
        ...entry,
        entity: scene.getEntityByID(positive(entry && entry.targetID)),
      }))
      .filter((entry) => entry.entity && positive(entry.entity.itemID) > 0)
      .sort((left, right) => (
        finite(right.lastAggressedAtMs, 0) - finite(left.lastAggressedAtMs, 0) ||
        positive(left.targetID) - positive(right.targetID)
      ));

    this._traceWingDrone("defense.evaluate", {
      characterID: positive(characterID),
      shipID: positive(shipRecord && shipRecord.itemID),
      entityShipID: positive(entity && entity.itemID),
      ownerID: positive(shipRecord && shipRecord.ownerID),
      defenseActive: entity.npcMiningWingDroneDefenseActive === true,
      localThreats: localThreats.slice(0, 16).map((entry) => ({
        targetID: positive(entry && entry.targetID),
        lastAggressedAtMs: finite(entry && entry.lastAggressedAtMs, 0),
      })),
      sharedThreats: sharedThreats.slice(0, 16).map((entry) => ({
        targetID: positive(entry && entry.targetID),
        defendedShipID: positive(entry && entry.defendedShipID),
        lastAggressedAtMs: finite(entry && entry.lastAggressedAtMs, 0),
      })),
      resolvedThreats: threats.slice(0, 16).map((entry) => ({
        targetID: positive(entry && entry.targetID),
        lastAggressedAtMs: finite(entry && entry.lastAggressedAtMs, 0),
        targetKind: String(entry.entity && entry.entity.kind || ""),
      })),
      activeDrones: this._wingDroneEntities(scene, entity.itemID)
        .slice(0, 24)
        .map((drone) => this._wingDroneTraceSummary(drone)),
    }, 5_000, `defense-evaluate:${positive(characterID)}:${positive(shipRecord && shipRecord.itemID)}`);

    if (threats.length > 0) {
      const wasActive = entity.npcMiningWingDroneDefenseActive === true;
      entity.npcMiningWingDroneDefenseActive = true;
      entity.npcMiningWingDroneDefenseTargetID = positive(threats[0].targetID);
      const threatSignature = threats
        .map((entry) => `${positive(entry.targetID)}:${finite(entry.lastAggressedAtMs, 0)}`)
        .sort()
        .join(",");
      const signatureChanged = String(
        entity.npcMiningWingDroneDefenseThreatSignature || "",
      ) !== threatSignature;
      if (miningState) {
        if (miningState.combatPaused !== true) {
          miningState.combatPaused = true;
          miningState.combatResumeStatus = String(miningState.status || "mining");
        }
        miningState.status = "combat-defense";
        miningState.lastError = "";
        miningState.nextCycleAtMs = Date.now() + DRONE_RETRY_MS;
      }

      const autonomousWingShip = entity.npcMiningWingController === true;
      if (autonomousWingShip) {
        this._deactivateWingMiningModules(
          scene,
          this._buildWingModuleSession(session, characterID, entity),
          entity,
          "combat",
        );
      }

      const activeBefore = this._wingDroneEntities(scene, entity.itemID);
      const miningInSpace = autonomousWingShip && activeBefore.some((drone) => (
        drone.droneCommand === DRONE_COMMAND_MINE ||
        Boolean(this._wingDroneCapabilities(
          drone,
          entity,
          characterID,
          shipRecord,
        ).miningSnapshot)
      ));
      if (autonomousWingShip) {
        this._recallMiningDrones(session, characterID, entity, shipRecord, scene);
      }
      if (miningInSpace) {
        this._traceWingDrone("defense.interrupting_mining", {
          characterID: positive(characterID),
          shipID: positive(shipRecord.itemID),
          targetID: positive(threats[0].targetID),
          miningDroneIDs: activeBefore
            .filter((drone) => drone.droneCommand === DRONE_COMMAND_MINE)
            .map((drone) => positive(drone.itemID))
            .filter(Boolean),
          reason: "return_mining_drones_before_defense_launch",
        }, 2_000, `defense-interrupt:${positive(characterID)}:${positive(shipRecord.itemID)}`);
        if (!wasActive) {
          this._wingDroneNotice(
            session,
            characterID,
            shipRecord.itemID,
            "Hive defense active. Returning mining drones and preparing combat drones.",
            "Defense",
          );
        }
        return true;
      }

      const activeCombatBefore = activeBefore.filter((drone) => Boolean(
        this._wingDroneCapabilities(
          drone,
          entity,
          characterID,
          shipRecord,
        ).combatSnapshot,
      ));
      const lastAttemptAtMs = finite(
        entity.npcMiningWingDroneDefenseLastAttemptAtMs,
        0,
      );
      const shouldArm = !wasActive || signatureChanged || (
        activeCombatBefore.length <= 0 &&
        now >= lastAttemptAtMs + DRONE_RETRY_MS
      );
      if (!shouldArm) {
        return true;
      }
      entity.npcMiningWingDroneDefenseThreatSignature = threatSignature;
      entity.npcMiningWingDroneDefenseLastAttemptAtMs = now;
      const targetID = positive(threats[0].targetID);

      const launchResponse = this._launchWingDrones(
        session,
        characterID,
        entity,
        shipRecord,
        (drone) => Boolean(
          this._wingDroneCapabilities(
            drone,
            entity,
            characterID,
            shipRecord,
          ).combatSnapshot,
        ),
        "defense",
        {targetID},
      );
      const activeCombat = this._wingDroneEntities(scene, entity.itemID)
        .filter((drone) => Boolean(
          this._wingDroneCapabilities(
            drone,
            entity,
            characterID,
            shipRecord,
          ).combatSnapshot,
        ));
      const assignmentIDs = activeCombat
        .filter((drone) => (
          drone.droneCommand !== DRONE_COMMAND_ENGAGE ||
          this._wingDroneTaskTargetID(drone) !== targetID
        ))
        .map((drone) => positive(drone.itemID))
        .filter(Boolean);
      let assignmentResponse = null;
      if (assignmentIDs.length > 0) {
        const assignmentFields = {
          characterID: positive(characterID),
          shipID: positive(shipRecord.itemID),
          targetID,
          droneIDs: assignmentIDs.slice(0, 24),
          droneCount: assignmentIDs.length,
          drones: activeCombat
            .filter((drone) => assignmentIDs.includes(positive(drone.itemID)))
            .slice(0, 24)
            .map((drone) => this._wingDroneTraceSummary(drone)),
        };
        this._traceWingDrone("defense.assignment.before", assignmentFields);
        try {
          assignmentResponse = droneAPI.commandEngageForWingShip(
            session,
            entity,
            shipRecord,
            assignmentIDs,
            targetID,
            characterID,
          );
          this._traceWingDrone("defense.assignment.after", {
            ...assignmentFields,
            result: this._droneResponseSummary(assignmentResponse),
          });
        } catch (error) {
          this._traceWingDrone("defense.assignment.throw", {
            ...assignmentFields,
            error: String(error && error.message || error),
          });
          throw error;
        }
      } else {
        this._traceWingDrone("defense.assignment.skipped", {
          characterID: positive(characterID),
          shipID: positive(shipRecord.itemID),
          targetID,
          reason: activeCombat.length > 0
            ? "combat_drones_already_assigned"
            : "no_compatible_active_combat_drones",
          activeCombatDroneCount: activeCombat.length,
        }, 2_000, `defense-assignment-skipped:${positive(characterID)}:${positive(shipRecord.itemID)}`);
      }
      if (!wasActive) {
        this._wingDroneNotice(
          session,
          characterID,
          shipRecord.itemID,
          activeCombat.length > 0
            ? `Hive defense: ${activeCombat.length} combat drone(s) deployed to protect the wing.`
            : "Hive defense active, but no usable combat drones are available.",
          "Defense",
        );
        log.info(
          `[NPCMiningWing] char=${characterID} drone-defense ` +
            `ship=${shipRecord.itemID} target=${targetID} ` +
            `combatDrones=${activeCombat.length} launched=${Boolean(launchResponse)} ` +
            `assigned=${assignmentIDs.length}`,
        );
      }
      const launchError = this._droneResponseError(launchResponse);
      const assignmentError = this._droneResponseError(assignmentResponse);
      if (launchError && this._wingDroneNotice(
        session,
        characterID,
        shipRecord.itemID,
        `I could not launch combat drones: ${friendlyErrorMessage(launchError)}`,
        "Defense",
      )) {
        log.warn(
          `[NPCMiningWing] char=${characterID} combat-drone launch failed ` +
            `ship=${shipRecord.itemID} target=${targetID} error=${launchError}`,
        );
      }
      if (assignmentError && this._wingDroneNotice(
        session,
        characterID,
        shipRecord.itemID,
        `I could not engage the attacker: ${friendlyErrorMessage(assignmentError)}`,
        "Defense",
      )) {
        log.warn(
          `[NPCMiningWing] char=${characterID} drone-defense command failed ` +
            `ship=${shipRecord.itemID} target=${targetID} ` +
            `error=${assignmentError}`,
        );
      }
      return true;
    }

    if (entity.npcMiningWingDroneDefenseActive !== true) {
      return false;
    }

    const activeCombat = this._wingDroneEntities(scene, entity.itemID)
      .filter((drone) => Boolean(
        this._wingDroneCapabilities(
          drone,
          entity,
          characterID,
          shipRecord,
        ).combatSnapshot,
      ));
    const returnResponse = this._returnWingDronesToBay(
      session,
      characterID,
      entity,
      shipRecord,
      (drone) => Boolean(
        this._wingDroneCapabilities(
          drone,
          entity,
          characterID,
          shipRecord,
        ).combatSnapshot,
      ),
      scene,
      "defense-clear",
    );
    if (activeCombat.length > 0) {
      this._traceWingDrone("defense.returning", {
        characterID: positive(characterID),
        shipID: positive(shipRecord.itemID),
        activeCombatDroneCount: activeCombat.length,
        returnResult: this._droneResponseSummary(returnResponse),
      }, 2_000, `defense-return:${positive(characterID)}:${positive(shipRecord.itemID)}`);
      if (miningState) {
        miningState.status = "combat-returning";
        miningState.nextCycleAtMs = Date.now() + DRONE_RETRY_MS;
      }
      return true;
    }

    const clearedTargetID = positive(entity.npcMiningWingDroneDefenseTargetID);
    entity.npcMiningWingDroneDefenseActive = false;
    entity.npcMiningWingDroneDefenseTargetID = 0;
    entity.npcMiningWingDroneDefenseThreatSignature = "";
    entity.npcMiningWingDroneDefenseLastAttemptAtMs = 0;
    if (typeof droneAPI.clearNpcMiningWingAggression === "function") {
      droneAPI.clearNpcMiningWingAggression(entity.itemID);
    }
    this._traceWingDrone("defense.cleared", {
      characterID: positive(characterID),
      shipID: positive(shipRecord.itemID),
      targetID: clearedTargetID,
      returnResult: this._droneResponseSummary(returnResponse),
      combatDronesRemaining: activeCombat.length,
    });
    if (miningState && miningState.combatPaused === true) {
      miningState.combatPaused = false;
      miningState.status = "resuming-mining";
      miningState.lastError = "";
      miningState.nextCycleAtMs = Date.now() + DRONE_RETRY_MS;
      this._wingDroneNotice(
        session,
        characterID,
        shipRecord.itemID,
        "Threat cleared. Combat drones are returning and I will resume mining.",
        "Defense",
      );
    } else {
      this._wingDroneNotice(
        session,
        characterID,
        shipRecord.itemID,
        "Threat cleared. Combat drones are returning to the ship.",
        "Defense",
      );
    }
    return false;
  }

  _tickWingDroneAutomation(
    runtime,
    scene,
    session,
    characterID,
    character,
    systemID,
    leader,
  ) {
    const activeShipRecord = itemStore.findCharacterShipItem(
      characterID,
      positive(leader && leader.itemID),
    );
    this._markHiveMindLeader(leader, characterID, activeShipRecord);
    const sharedThreats = this._hiveDefenseThreats(
      scene,
      characterID,
      character,
      Date.now(),
    );
    // The player is a full member of the defensive group. The player's ship
    // command, movement, and mining modules are left untouched; only its drone
    // controller participates in the automatic defensive response.
    if (activeShipRecord && leader) {
      this._tickWingDroneDefense(
        runtime,
        scene,
        session,
        characterID,
        character,
        activeShipRecord,
        leader,
        null,
        sharedThreats,
      );
    }
    for (const shipID of this._deployedShipIDs(character)) {
      const shipRecord = itemStore.findCharacterShipItem(characterID, shipID);
      if (!shipRecord || !isShipInSystem(shipRecord, systemID)) {
        continue;
      }
      let entity = scene.getEntityByID(shipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        } catch (_) {
          continue;
        }
      }
      this._registerHiveShipIdentity(entity, shipRecord, characterID);
      const miningState = character.miningShipStates[String(shipID)] || null;
      const defenseActive = this._tickWingDroneDefense(
        runtime,
        scene,
        session,
        characterID,
        character,
        shipRecord,
        entity,
        miningState,
        sharedThreats,
      );
      if (!defenseActive && character.command !== "mine") {
        this._recallMiningDrones(
          session,
          characterID,
          entity,
          shipRecord,
          scene,
        );
      }
    }
  }

  _deactivateWingMiningModules(scene, moduleSession, entity, reason = "npc") {
    if (!scene || !moduleSession || !entity || !(entity.activeModuleEffects instanceof Map)) {
      return {stopped: 0, pending: 0};
    }
    let stopped = 0;
    let pending = 0;
    for (const effectState of [...entity.activeModuleEffects.values()]) {
      if (!effectState || effectState.miningEffect !== true) {
        continue;
      }
      const moduleID = positive(effectState.moduleID);
      if (!moduleID) {
        continue;
      }
      const result = scene.deactivateGenericModule(moduleSession, moduleID, {
        reason,
        deferUntilCycle: false,
      });
      if (
        entity.activeModuleEffects instanceof Map &&
        entity.activeModuleEffects.has(moduleID)
      ) {
        pending += 1;
      } else if (result && result.success === true) {
        stopped += 1;
      }
    }
    return {stopped, pending};
  }

  _activateWingMiningModules(scene, moduleSession, entity, targetEntity, miningSnapshots) {
    const result = {
      active: 0,
      activated: 0,
      pending: 0,
      errors: [],
    };
    if (!scene || !moduleSession || !entity || !targetEntity) {
      return result;
    }
    for (const entry of Array.isArray(miningSnapshots) ? miningSnapshots : []) {
      const moduleID = positive(entry && entry.moduleItem && entry.moduleItem.itemID);
      if (!moduleID || !entry.moduleItem || !entry.effectRecord) {
        continue;
      }
      let activeEffect = entity.activeModuleEffects instanceof Map
        ? entity.activeModuleEffects.get(moduleID)
        : null;
      if (activeEffect) {
        if (positive(activeEffect.targetID) === positive(targetEntity.itemID)) {
          result.active += 1;
          continue;
        }
        scene.deactivateGenericModule(moduleSession, moduleID, {
          reason: "target",
          deferUntilCycle: false,
        });
        activeEffect = entity.activeModuleEffects instanceof Map
          ? entity.activeModuleEffects.get(moduleID)
          : null;
        if (activeEffect) {
          result.pending += 1;
          continue;
        }
      }

      const activation = scene.activateGenericModule(
        moduleSession,
        entry.moduleItem,
        entry.effectRecord.name,
        {targetID: targetEntity.itemID},
      );
      if (!activation || activation.success !== true) {
        result.errors.push({
          moduleID,
          errorMsg: String(activation && activation.errorMsg || "ACTIVATION_FAILED"),
        });
        continue;
      }
      result.activated += 1;
      activeEffect = entity.activeModuleEffects instanceof Map
        ? entity.activeModuleEffects.get(moduleID)
        : null;
      if (activeEffect) {
        result.active += 1;
      }
    }
    return result;
  }

  _resolveMiningModules(characterID, shipID) {
    const fitting = getLiveFittingState();
    const dogma = getMiningDogma();
    const fittedItems = fitting.getFittedModuleItems(characterID, shipID);
    return fittedItems
      .filter((moduleItem) => fitting.isModuleOnline(moduleItem))
      .map((moduleItem) => ({
        moduleItem,
        effectRecord: fitting
          .getTypeEffectRecords(positive(moduleItem.typeID))
          .find((record) => dogma.isMiningEffectRecord(record, moduleItem)),
        fittedItems,
      }))
      .filter((entry) => entry.effectRecord);
  }

  _resolveMiningModule(characterID, shipID) {
    return this._resolveMiningModules(characterID, shipID)[0] || null;
  }

  _buildMiningSnapshot(characterID, ship, resolvedModule) {
    if (!ship || !resolvedModule) {
      return null;
    }
    const fitting = getLiveFittingState();
    const snapshot = getMiningDogma().buildMiningModuleSnapshot({
      characterID,
      shipItem: ship,
      moduleItem: resolvedModule.moduleItem,
      effectRecord: resolvedModule.effectRecord,
      chargeItem: fitting.getLoadedChargeByFlag(
        characterID,
        positive(ship.itemID),
        positive(resolvedModule.moduleItem.flagID),
      ),
      fittedItems: resolvedModule.fittedItems,
      skillMap: getSkillState().getCachedCharacterSkillMap(characterID),
    });
    return snapshot
      ? {
          ...resolvedModule,
          snapshot,
        }
      : null;
  }

  _miningSnapshotMatchesTarget(snapshot, mineableState) {
    if (!snapshot || !mineableState) {
      return false;
    }
    const family = String(snapshot.family || "ore").toLowerCase();
    const yieldKind = String(mineableState.yieldKind || "ore").toLowerCase();
    if (
      (family === "gas" && yieldKind !== "gas") ||
      (family === "ice" && yieldKind !== "ice") ||
      (family === "ore" && yieldKind !== "ore")
    ) {
      return false;
    }
    return true;
  }

  _selectMiningTarget(scene, sourceEntity, miningSnapshots = []) {
    const runtimeState = getMiningRuntimeState();
    runtimeState.ensureSceneMiningState(scene);
    const staticEntities = Array.isArray(scene && scene.staticEntities)
      ? scene.staticEntities
      : [];
    const candidates = [];
    for (const entity of staticEntities) {
      const mineableState = runtimeState.getMineableState(
        scene,
        positive(entity && entity.itemID),
      );
      if (
        !entity ||
        !mineableState ||
        mineableState.remainingQuantity <= 0 ||
        !canEntitiesInteractLocally(sourceEntity, entity)
      ) {
        continue;
      }
      if (
        Array.isArray(miningSnapshots) &&
        miningSnapshots.length > 0 &&
        !miningSnapshots.some((entry) =>
          this._miningSnapshotMatchesTarget(entry && entry.snapshot, mineableState),
        )
      ) {
        continue;
      }
      candidates.push({
        entity,
        distance: surfaceDistanceBetween(sourceEntity, entity),
      });
    }
    candidates.sort(
      (left, right) =>
        left.distance - right.distance ||
        positive(left.entity.itemID) - positive(right.entity.itemID),
    );
    return candidates.length > 0 ? candidates[0].entity : null;
  }

  _availableMiningStorage(characterID, ship, fittedItems, skillMap, yieldTypeID) {
    const fitting = getLiveFittingState();
    const inventory = getMiningInventory();
    const resourceState = fitting.buildShipResourceState(characterID, ship, {
      fittedItems,
      skillMap,
    });
    const preferredFlag = inventory.getPreferredMiningHoldFlagForType(
      resourceState,
      yieldTypeID,
    );
    const flagID = preferredFlag || itemStore.ITEM_FLAGS.CARGO_HOLD;
    const capacity = flagID === itemStore.ITEM_FLAGS.CARGO_HOLD
      ? finite(resourceState && resourceState.cargoCapacity, 0)
      : finite(inventory.getShipHoldCapacityByFlag(resourceState, flagID), 0);
    const used = cargoItemsForShip(characterID, positive(ship.itemID))
      .filter((item) => Number(item.flagID) === Number(flagID))
      .reduce((sum, item) => (
        sum + itemQuantity(item) * Math.max(
          0,
          finite(itemStore.getInventoryItemUnitVolume(item), 0),
        )
      ), 0);
    return {
      flagID,
      capacity,
      used,
      availableVolume: Math.max(0, capacity - used),
    };
  }

  _miningOutputSnapshot(characterID, shipID) {
    const items = cargoItemsForShip(characterID, shipID)
      .filter(isMiningOutputItem);
    let quantity = 0;
    let volume = 0;
    for (const item of items) {
      const itemQuantityValue = itemQuantity(item);
      quantity += itemQuantityValue;
      volume += itemQuantityValue * Math.max(
        0,
        finite(itemStore.getInventoryItemUnitVolume(item), 0),
      );
    }
    return {
      items,
      quantity,
      volume,
      itemSummary: items
        .map((item) => (
          `${positive(item.typeID)}:${itemQuantity(item)}@${positive(item.flagID)}`
        ))
        .join(",") || "none",
    };
  }

  _installNativeMiningCycleDiagnostics() {
    if (nativeMiningCycleDiagnosticsAttempted) {
      return;
    }
    nativeMiningCycleDiagnosticsAttempted = true;
    try {
      const miningRuntime = require(serverPath("services", "mining", "miningRuntime"));
      const originalExecuteMiningCycle = miningRuntime.executeMiningCycle;
      if (typeof originalExecuteMiningCycle !== "function") {
        log.warn(
          "[NPCMiningWing] native mining cycle diagnostics unavailable: " +
            "executeMiningCycle export missing",
        );
        return;
      }
      if (originalExecuteMiningCycle.npcMiningWingDiagnostics === true) {
        return;
      }

      const executeMiningCycleWithDiagnostics = function(...args) {
        const [scene, entity, effectState] = args;
        if (!entity || entity.npcMiningWingController !== true) {
          return originalExecuteMiningCycle.apply(this, args);
        }

        const startedAtMs = Date.now();
        let result;
        try {
          result = originalExecuteMiningCycle.apply(this, args);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] native mining cycle threw ` +
              `char=${positive(entity.runtimeOwnerCharacterID)} ` +
              `ship=${positive(entity.itemID)} ` +
              `module=${positive(effectState && effectState.moduleID)} ` +
              `target=${positive(effectState && effectState.targetID)} ` +
              `error=${String(error && error.stack || error)}`,
          );
          throw error;
        }

        const characterID = positive(
          entity.session && entity.session.characterID ||
          entity.characterID ||
          entity.pilotCharacterID ||
          entity.runtimeOwnerCharacterID,
        );
        let cargoRows = [];
        try {
          cargoRows = itemStore
            .listContainerItems(characterID, positive(entity.itemID), null)
            .filter(isCargoItem);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] native mining inventory inspection failed ` +
              `char=${characterID} ship=${positive(entity.itemID)} ` +
              `error=${String(error && error.message || error)}`,
          );
        }
        const cargoSummary = cargoRows
          .slice(0, 20)
          .map((item) => (
            `${positive(item.typeID)}x${itemQuantity(item)}@${positive(item.flagID)}`
          ))
          .join(",") || "none";
        const data = result && result.data || {};
        const success = Boolean(result && result.success === true);
        const level = success ? "info" : "warn";
        log[level](
          `[NPCMiningWing] native mining cycle result ` +
            `char=${characterID} ship=${positive(entity.itemID)} ` +
            `module=${positive(effectState && effectState.moduleID)} ` +
            `target=${positive(effectState && effectState.targetID)} ` +
            `success=${success} stopReason=${String(result && result.stopReason || "none")} ` +
            `yieldType=${positive(data.yieldTypeID)} ` +
            `transferred=${finite(data.transferredQuantity, 0)} ` +
            `wasted=${finite(data.wastedQuantity, 0)} ` +
            `inventoryRows=${cargoRows.length}[${cargoSummary}] ` +
            `elapsedMs=${Date.now() - startedAtMs}`,
        );
        return result;
      };
      executeMiningCycleWithDiagnostics.npcMiningWingDiagnostics = true;
      miningRuntime.executeMiningCycle = executeMiningCycleWithDiagnostics;
      log.info("[NPCMiningWing] native mining cycle diagnostics attached");
    } catch (error) {
      log.warn(
        `[NPCMiningWing] native mining cycle diagnostics failed to attach: ` +
          `${String(error && error.stack || error)}`,
      );
    }
  }

  _observeMiningInventory(
    characterID,
    shipID,
    targetID,
    miningState,
    storage,
    snapshots,
    runtime = {},
  ) {
    const now = Date.now();
    const key = `${positive(characterID)}:${positive(shipID)}`;
    const output = this._miningOutputSnapshot(characterID, shipID);
    const quantity = output.quantity;
    const itemSummary = output.itemSummary;
    const allContainerItems = itemStore.listContainerItems(null, shipID, null);
    const containerSummary = allContainerItems
      .slice(0, 20)
      .map((item) => (
        `${positive(item.ownerID)}:${positive(item.flagID)}:` +
        `${positive(item.typeID)}x${itemQuantity(item)}`
      ))
      .join(",") || "none";
    const state = this._miningDiagnostics.get(key);
    if (!state) {
      this._miningDiagnostics.set(key, {
        quantity,
        lastProgressAtMs: now,
        lastWarnAtMs: 0,
        nextCheckAtMs: now + 5000,
      });
      log.info(
        `[NPCMiningWing] mining inventory monitor started ` +
          `char=${positive(characterID)} ship=${positive(shipID)} ` +
          `target=${positive(targetID)} quantity=${quantity} items=${itemSummary}`,
      );
      return;
    }
    if (now < state.nextCheckAtMs) {
      return;
    }
    state.nextCheckAtMs = now + 5000;
    if (quantity !== state.quantity) {
      const delta = quantity - state.quantity;
      log.info(
        `[NPCMiningWing] mining inventory changed ` +
          `char=${positive(characterID)} ship=${positive(shipID)} ` +
          `target=${positive(targetID)} delta=${delta} quantity=${quantity} ` +
          `items=${itemSummary}`,
      );
      state.quantity = quantity;
      state.lastProgressAtMs = now;
      state.lastWarnAtMs = 0;
      return;
    }

    const cycleMs = Math.max(
      1000,
      ...snapshots.map((entry) => finite(entry && entry.snapshot && entry.snapshot.durationMs, 0)),
    );
    const noProgressMs = now - state.lastProgressAtMs;
    const warningIntervalMs = Math.max(30000, cycleMs * 2);
    if (
      noProgressMs >= warningIntervalMs &&
      now - state.lastWarnAtMs >= warningIntervalMs
    ) {
      const entity = runtime.entity || null;
      const targetEntity = runtime.targetEntity || null;
      const mineableState = runtime.mineableState || null;
      const activation = runtime.activation || {};
      const activeEffects = entity && entity.activeModuleEffects instanceof Map
        ? [...entity.activeModuleEffects.values()].filter((effect) => (
          effect && effect.miningEffect === true
        ))
        : [];
      const effectSummary = activeEffects
        .map((effect) => (
          `${positive(effect.moduleID)}->${positive(effect.targetID)}` +
          `(${Math.round(finite(effect.startedAtMs, 0))}/` +
          `${Math.round(finite(effect.nextCycleAtMs, 0))})`
        ))
        .join(",") || "none";
      const moduleSummary = snapshots
        .map((entry) => {
          const module = entry && entry.moduleItem || {};
          const snapshot = entry && entry.snapshot || {};
          return `${positive(module.itemID)}/${positive(module.typeID)}:` +
            `${String(snapshot.family || "unknown")},` +
            `${finite(snapshot.durationMs, 0)}ms,` +
            `${finite(snapshot.miningAmountM3, 0)}m3,` +
            `${finite(snapshot.maxRangeMeters, 0)}m`;
        })
        .join(";") || "none";
      const targetDistance = entity && targetEntity
        ? surfaceDistanceBetween(entity, targetEntity)
        : 0;
      const targetLocked = Boolean(
        entity &&
        runtime.scene &&
        typeof runtime.scene.getTargetsForEntity === "function" &&
        runtime.scene.getTargetsForEntity(entity).includes(positive(targetID)),
      );
      log.warn(
        `[NPCMiningWing] mining active but inventory unchanged ` +
          `char=${positive(characterID)} ship=${positive(shipID)} ` +
          `target=${positive(targetID)} yieldType=${positive(miningState && miningState.yieldTypeID)} ` +
          `quantity=${quantity} items=${itemSummary} ` +
          `containerRows=${allContainerItems.length}[${containerSummary}] ` +
          `holdFlag=${positive(storage && storage.flagID)} ` +
          `holdUsed=${finite(storage && storage.used, 0)} ` +
          `holdCapacity=${finite(storage && storage.capacity, 0)} ` +
          `holdAvailable=${finite(storage && storage.availableVolume, 0)} ` +
          `unitVolume=${finite(mineableState && mineableState.unitVolume, 0)} ` +
          `remaining=${finite(mineableState && mineableState.remainingQuantity, 0)} ` +
          `distance=${Math.round(targetDistance)} locked=${targetLocked} ` +
          `activeModules=${activation.active || 0} ` +
          `activatedModules=${activation.activated || 0} ` +
          `pendingModules=${activation.pending || 0} ` +
          `moduleErrors=${JSON.stringify(activation.errors || [])} ` +
          `effects=[${effectSummary}] modules=[${moduleSummary}] ` +
          `entityKind=${String(entity && entity.kind || "unknown")} ` +
          `nativeNpc=${Boolean(entity && entity.nativeNpc)} ` +
          `runtimeOwner=${positive(entity && entity.runtimeOwnerCharacterID)} ` +
          `entityOwner=${positive(entity && entity.ownerID)} ` +
          `entityCharacter=${positive(entity && entity.characterID)} ` +
          `pilotCharacter=${positive(entity && entity.pilotCharacterID)} ` +
          `hasSession=${Boolean(entity && entity.session)} ` +
          `cycleMs=${cycleMs} noProgressMs=${noProgressMs}`,
      );
      state.lastWarnAtMs = now;
    }
  }

  _syncMiningChanges(session, changes) {
    if (!session || !Array.isArray(changes)) {
      return;
    }
    const stateService = getCharacterStateService();
    for (const change of changes) {
      if (!change || !change.item) {
        continue;
      }
      try {
        stateService.syncInventoryItemForSession(
          session,
          change.item,
          change.previousData || change.previousState || {},
          {emitCfgLocation: true},
        );
      } catch (error) {
        log.debug(
          `[NPCMiningWing] inventory notification failed: ${error.message}`,
        );
      }
    }
  }

  _syncDockedShipToSession(session, characterID, shipID, dockResult, reason) {
    if (!dockResult || dockResult.success !== true) {
      return false;
    }
    const targetSession = session || getSessionRegistry().findSessionByCharacterID(
      positive(characterID),
    );
    if (!targetSession) {
      log.debug(
        `[NPCMiningWing] dock inventory sync deferred: no session ` +
          `char=${characterID} ship=${shipID} reason=${reason}`,
      );
      return false;
    }
    const dockedShip = itemStore.findCharacterShipItem(characterID, shipID) ||
      dockResult.data;
    if (!dockedShip) {
      log.warn(
        `[NPCMiningWing] dock inventory sync skipped: ship not found ` +
          `char=${characterID} ship=${shipID} reason=${reason}`,
      );
      return false;
    }
    try {
      getCharacterStateService().syncInventoryItemForSession(
        targetSession,
        dockedShip,
        dockResult.previousData || {},
        {emitCfgLocation: true},
      );
      log.debug(
        `[NPCMiningWing] dock inventory sync sent ` +
          `char=${characterID} ship=${shipID} station=${dockedShip.locationID} ` +
          `reason=${reason}`,
      );
      return true;
    } catch (error) {
      log.warn(
        `[NPCMiningWing] dock inventory sync failed ` +
          `char=${characterID} ship=${shipID} reason=${reason} ` +
          `error=${error.message}`,
      );
      return false;
    }
  }

  _depositDockedMiningCargo(session, characterID, shipID, stationID, reason) {
    const numericStationID = positive(stationID);
    if (!numericStationID) {
      return {moved: [], failed: []};
    }
    let targetSession = session;
    if (!targetSession) {
      try {
        targetSession = getSessionRegistry().findSessionByCharacterID(
          positive(characterID),
        );
      } catch (_) {
        targetSession = null;
      }
    }
    const sourceItems = cargoItemsForShip(characterID, shipID)
      .filter(isMiningOutputItem);
    const moved = [];
    const failed = [];
    for (const item of sourceItems) {
      let moveResult;
      try {
        moveResult = itemStore.moveItemToLocation(
          item.itemID,
          numericStationID,
          itemStore.ITEM_FLAGS.HANGAR,
          null,
        );
      } catch (error) {
        moveResult = {success: false, errorMsg: error.message};
      }
      if (!moveResult || moveResult.success !== true || !moveResult.data) {
        failed.push({
          itemID: positive(item.itemID),
          error: String(moveResult && moveResult.errorMsg || "MOVE_FAILED"),
        });
        continue;
      }
      moved.push({
        itemID: positive(item.itemID),
        typeID: positive(item.typeID),
        quantity: positive(moveResult.data.quantity),
        stationID: numericStationID,
      });
      this._syncMiningChanges(targetSession, moveResult.data.changes);
    }
    if (moved.length > 0) {
      log.info(
        `[NPCMiningWing] char=${characterID} dock cargo deposit ` +
          `ship=${shipID} station=${numericStationID} stacks=${moved.length} ` +
          `reason=${reason}`,
      );
      if (targetSession) {
        this._sendWingChat(
          targetSession,
          characterID,
          shipID,
          `Docked and deposited ${moved.length} mining cargo stack(s) into the station hangar.`,
        );
      }
    }
    if (failed.length > 0) {
      log.warn(
        `[NPCMiningWing] char=${characterID} dock cargo deposit incomplete ` +
          `ship=${shipID} station=${numericStationID} failed=${failed.length} ` +
          `reason=${reason}`,
      );
      if (targetSession) {
        this._sendWingChat(
          targetSession,
          characterID,
          shipID,
          "Docked, but some mining cargo could not be deposited.",
        );
      }
    }
    return {moved, failed};
  }

  _miningEngagementRange(scene, entity, snapshot) {
    const buffer = Math.max(0, MINING_RANGE_BUFFER_METERS);
    const miningRange = Math.max(
      0,
      finite(snapshot && snapshot.snapshot && snapshot.snapshot.maxRangeMeters, 0) -
        buffer,
    );
    const targetingStats = scene && typeof scene.getEntityTargetingStats === "function"
      ? scene.getEntityTargetingStats(entity)
      : null;
    const lockRange = Math.max(
      0,
      finite(targetingStats && targetingStats.maxTargetRange, 0) - buffer,
    );
    if (lockRange <= 0) {
      return miningRange;
    }
    if (miningRange <= 0) {
      return lockRange;
    }
    return Math.min(miningRange, lockRange);
  }

  _syncMiningApproachOrder(runtime, scene, systemID, entity, targetEntity) {
    if (!scene || !entity || !targetEntity) {
      return false;
    }

    const orbitDistance = Math.max(500, MINING_ORBIT_DISTANCE_METERS);
    const surfaceDistance = surfaceDistanceBetween(entity, targetEntity);
    const sameTarget = positive(entity.targetEntityID) === positive(targetEntity.itemID);
    const currentlyFollowingOrbitBand =
      entity.mode === "FOLLOW" &&
      sameTarget &&
      Math.abs(finite(entity.followRange, 0) - orbitDistance) <= 1;
    const orbitReacquireDistance = orbitDistance + Math.max(5000, orbitDistance * 0.5);
    const orbitSettleDistance = orbitDistance + Math.max(1000, orbitDistance * 0.2);
    const shouldFollow =
      surfaceDistance > orbitReacquireDistance ||
      (currentlyFollowingOrbitBand && surfaceDistance > orbitSettleDistance);

    if (shouldFollow && typeof scene.followShipEntity === "function") {
      return scene.followShipEntity(
        entity,
        targetEntity.itemID,
        orbitDistance,
        {
          queueHistorySafeContract: true,
          suppressFreshAcquireReplay: true,
        },
      );
    }
    if (!shouldFollow && typeof scene.orbitShipEntity === "function") {
      return scene.orbitShipEntity(
        entity,
        targetEntity.itemID,
        orbitDistance,
        {
          queueHistorySafeContract: true,
          suppressFreshAcquireReplay: true,
        },
      );
    }
    if (shouldFollow && runtime && typeof runtime.followDynamicEntity === "function") {
      return runtime.followDynamicEntity(
        scene.sceneDescriptor || systemID,
        entity.itemID,
        targetEntity.itemID,
        orbitDistance,
        {broadcast: true},
      );
    }
    return false;
  }

  _availableCollectionShipID(character, characterID, systemID, scene) {
    const collectionShipID = positive(character && character.collectionShipID);
    if (!collectionShipID || character && character.collectionTrip &&
      character.collectionTrip.active) {
      return 0;
    }
    if (!this._deployedShipIDs(character).includes(collectionShipID)) {
      return 0;
    }
    const ship = itemStore.findCharacterShipItem(characterID, collectionShipID);
    if (!ship || !isShipInSystem(ship, systemID)) {
      return 0;
    }
    if (!scene || !scene.getEntityByID(collectionShipID)) {
      return 0;
    }
    return collectionShipID;
  }

  _tickCollectionShipFollow(runtime, scene, characterID, character, systemID, leader) {
    if (
      !character ||
      character.command !== "mine" ||
      !leader ||
      character.collectionTrip && character.collectionTrip.active
    ) {
      return false;
    }
    const configuredCollectionShipID = positive(character.collectionShipID);
    const collectionShipID = this._availableCollectionShipID(
      character,
      characterID,
      systemID,
      scene,
    );
    if (configuredCollectionShipID && !collectionShipID) {
      if (markCollectionUnavailableStates(character, Date.now(), MINING_RETRY_MS)) {
        character.revision = positive(character.revision) + 1;
        writeState(this._getState());
      }
      return false;
    }
    if (!collectionShipID) {
      return false;
    }
    if (!scene.getEntityByID(collectionShipID)) {
      try {
        this._ensureDeployedEntity(runtime, scene, systemID, collectionShipID);
      } catch (error) {
        log.warn(
          `[NPCMiningWing] collection ship spawn pending ` +
            `char=${characterID} ship=${collectionShipID} error=${error.message}`,
        );
        return false;
      }
    }
    const result = runtime && typeof runtime.followDynamicEntity === "function"
      ? runtime.followDynamicEntity(
        scene.sceneDescriptor || systemID,
        collectionShipID,
        positive(leader.itemID),
        FOLLOW_RANGE_METERS,
        {broadcast: true},
      )
      : false;
    return result === true;
  }

  _tickMiningCargoReturn(
    runtime, scene, session, characterID, character, systemID, shipID, entity, leader, miningState,
  ) {
    return miningTrace.run("cargoHandoff", entity, () => ({
      characterID, sourceShipID: shipID, collectionShipID: character.collectionShipID,
      leaderShipID: positive(leader && leader.itemID),
      source: this._miningOutputSnapshot(characterID, shipID).itemSummary,
    }), () => this._tickMiningCargoReturnImpl(
      runtime, scene, session, characterID, character, systemID, shipID, entity, leader, miningState,
    ), (result) => ({result, status: miningState.status, error: miningState.lastError,
      source: this._miningOutputSnapshot(characterID, shipID).itemSummary,
    }));
  }

  _tickMiningCargoReturnImpl(
    runtime,
    scene,
    session,
    characterID,
    character,
    systemID,
    shipID,
    entity,
    leader,
    miningState,
  ) {
    const now = Date.now();
    const outputBefore = this._miningOutputSnapshot(characterID, shipID);
    if (outputBefore.quantity <= 0) {
      miningState.cargoReturn = false;
      miningState.status = "resuming-mining";
      miningState.lastError = "";
      miningState.nextCycleAtMs = now + MINING_RETRY_MS;
      log.warn(
        `[NPCMiningWing] cargo handoff skipped: no mining output ` +
          `char=${characterID} ship=${shipID} ` +
          `sourceQuantity=${outputBefore.quantity} ` +
          `sourceVolume=${outputBefore.volume} items=${outputBefore.itemSummary}`,
      );
      return false;
    }
    const moduleSession = this._buildWingModuleSession(session, characterID, entity);
    this._deactivateWingMiningModules(scene, moduleSession, entity, "cargo");
    this._recallMiningDrones(
      session,
      characterID,
      entity,
      itemStore.findCharacterShipItem(characterID, shipID) || {
        itemID: shipID,
        ownerID: characterID,
      },
      scene,
    );
    miningState.cargoReturn = true;

    if (!leader) {
      miningState.status = "cargo-waiting";
      miningState.lastError = "NPC_WING_LEADER_NOT_FOUND";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }
    if (
      positive(character.collectionShipID) &&
      character.collectionTrip &&
      character.collectionTrip.active === true
    ) {
      miningState.status = "cargo-waiting";
      miningState.lastError = "NPC_WING_COLLECTION_TRIP_ACTIVE";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }
    const collectionShipID = this._availableCollectionShipID(
      character,
      characterID,
      systemID,
      scene,
    );
    if (positive(character.collectionShipID) && !collectionShipID) {
      miningState.status = "cargo-waiting";
      miningState.lastError = "NPC_WING_COLLECTION_UNAVAILABLE";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }
    const destinationShipID = collectionShipID || positive(leader.itemID);
    const destinationEntity = collectionShipID
      ? scene.getEntityByID(collectionShipID)
      : leader;
    if (!destinationEntity) {
      miningState.status = "cargo-waiting";
      miningState.lastError = "NPC_WING_COLLECTION_UNAVAILABLE";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }
    if (String(leader.mode || "").toUpperCase() === "WARP" && !collectionShipID) {
      miningState.status = "cargo-waiting";
      miningState.lastError = "NPC_WING_CARGO_DURING_WARP";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }

    if (distanceBetween(destinationEntity.position, entity.position) > CARGO_TRANSFER_RANGE_METERS) {
      const followResult = runtime && typeof runtime.followDynamicEntity === "function"
        ? runtime.followDynamicEntity(
            scene.sceneDescriptor || systemID,
            entity.itemID,
            destinationShipID,
            CARGO_FOLLOW_RANGE_METERS,
            {broadcast: true},
          )
        : false;
      miningState.status = followResult === true
        ? "returning-for-cargo"
        : "cargo-waiting";
      miningState.lastError = followResult === true ? "" : "FOLLOW_FAILED";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }

    // Keep the ship attached to the player while unloading or waiting for
    // space. The mining tick will replace this order with the asteroid orbit
    // after the transfer completes.
    if (runtime && typeof runtime.followDynamicEntity === "function") {
      runtime.followDynamicEntity(
        scene.sceneDescriptor || systemID,
        entity.itemID,
        destinationShipID,
        CARGO_FOLLOW_RANGE_METERS,
        {broadcast: true},
      );
    }
    miningState.status = "transferring-cargo";
    miningState.lastError = "";
    miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
    const activeShipID = destinationShipID || currentShipID(session);
    let transfer;
    try {
      transfer = this._transferCargoForShip(
        session,
        characterID,
        shipID,
        activeShipID,
        {miningOnly: true, destinationShipID},
      );
    } catch (error) {
      miningState.status = "cargo-waiting";
      miningState.lastError = String(error && error.message || error || "TRANSFER_FAILED");
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }

    const outputAfter = this._miningOutputSnapshot(characterID, shipID);
    const movedQuantity = transfer.moved.reduce(
      (sum, entry) => sum + positive(entry && entry.quantity),
      0,
    );
    if (transfer.moved.length > 0) {
      this._recordMetric(characterID, "cargoMoves", transfer.moved.length);
      const holds = [...new Set(transfer.moved.map((entry) => entry.destinationHold))];
      this._sendWingChat(
        session,
        characterID,
        shipID,
        `Cargo transfer complete. Moved ${transfer.moved.length} mining stack(s) to ${
          collectionShipID ? "the collection ship" : holds.join(" and ")
        }.`,
      );
      log.info(
        `[NPCMiningWing] cargo handoff moved mining output ` +
          `char=${characterID} ship=${shipID} destination=${activeShipID} ` +
          `beforeQuantity=${outputBefore.quantity} afterQuantity=${outputAfter.quantity} ` +
          `movedQuantity=${movedQuantity} beforeVolume=${outputBefore.volume} ` +
          `afterVolume=${outputAfter.volume}`,
      );
    } else {
      log.warn(
        `[NPCMiningWing] cargo handoff moved nothing ` +
          `char=${characterID} ship=${shipID} destination=${activeShipID} ` +
          `sourceQuantity=${outputBefore.quantity} sourceVolume=${outputBefore.volume} ` +
          `items=${outputBefore.itemSummary} failures=${JSON.stringify(transfer.failed)}`,
      );
    }
    if (outputAfter.items.length === 0) {
      miningState.cargoReturn = false;
      miningState.status = "resuming-mining";
      miningState.lastError = "";
      miningState.nextCycleAtMs = now + MINING_RETRY_MS;
      log.info(
        `[NPCMiningWing] char=${characterID} cargo-return complete ` +
          `ship=${shipID} activeShip=${activeShipID} ` +
          `sourceQuantityBefore=${outputBefore.quantity} ` +
          `sourceQuantityAfter=${outputAfter.quantity} ` +
          `movedQuantity=${movedQuantity}`,
      );
      return true;
    }

    const failure = transfer.failed[0];
    if (
      collectionShipID &&
      failure &&
      String(failure.error || "") === "NPC_WING_DESTINATION_HOLD_FULL"
    ) {
      try {
        this._startCollectionTrip(session, characterID, character, {automatic: true});
      } catch (error) {
        log.warn(
          `[NPCMiningWing] automatic collection trip could not start ` +
            `char=${characterID} ship=${collectionShipID} error=${error.message}`,
        );
      }
      if (character.collectionTrip && character.collectionTrip.active === true) {
        miningState.status = "cargo-waiting";
        miningState.lastError = "NPC_WING_COLLECTION_TRIP_ACTIVE";
        miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
        return false;
      }
    }
    miningState.status = "cargo-waiting";
    miningState.lastError = String(
      failure && failure.error || "NPC_WING_DESTINATION_HOLD_FULL",
    );
    miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
    return false;
  }

  _tickMiningShip(
    runtime, scene, session, characterID, character, systemID, shipID, entity, leader,
  ) {
    return miningTrace.shipTick(scene, entity, () => ({
      characterID, systemID, leaderShipID: positive(leader && leader.itemID),
      command: character.command, state: character.miningShipStates[String(shipID)] || null,
    }), () => this._tickMiningShipImpl(
      runtime, scene, session, characterID, character, systemID, shipID, entity, leader,
    ));
  }

  _tickMiningShipImpl(
    runtime,
    scene,
    session,
    characterID,
    character,
    systemID,
    shipID,
    entity,
    leader,
  ) {
    this._installNativeMiningCycleDiagnostics();
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    if (!ship || !isShipInSystem(ship, systemID)) {
      return false;
    }
    if (
      positive(entity.npcMiningWingSkillOwnerID) !== positive(characterID) ||
      !(entity.skillMap instanceof Map)
    ) {
      try {
        this._applyWingSkillProfile(characterID, ship, entity);
      } catch (error) {
        log.warn(
          `[NPCMiningWing] char=${characterID} skill profile failed ` +
            `ship=${shipID} error=${error.message}`,
        );
      }
    }
    const key = String(shipID);
    const miningState = character.miningShipStates[key] || {
      status: "searching",
      targetID: 0,
      nextCycleAtMs: 0,
    };
    character.miningShipStates[key] = miningState;
    if (miningState.combatPaused === true) {
      this._deactivateWingMiningModules(
        scene,
        this._buildWingModuleSession(session, characterID, entity),
        entity,
        "combat",
      );
      this._recallMiningDrones(session, characterID, entity, ship, scene);
      miningState.status = miningState.status === "combat-returning"
        ? "combat-returning"
        : "combat-defense";
      miningState.nextCycleAtMs = Date.now() + DRONE_RETRY_MS;
      return false;
    }
    if (
      miningState.cargoReturn === true ||
      [
        "cargo-full",
        "returning-for-cargo",
        "transferring-cargo",
        "cargo-waiting",
      ].includes(String(miningState.status || ""))
    ) {
      if (!miningHandoffIsReady(miningState)) {
        return false;
      }
      return this._tickMiningCargoReturn(
        runtime,
        scene,
        session,
        characterID,
        character,
        systemID,
        shipID,
        entity,
        leader,
        miningState,
      );
    }
    if (finite(miningState.nextCycleAtMs, 0) > Date.now()) {
      return false;
    }
    const resolvedModules = this._resolveMiningModules(characterID, shipID);
    const miningSnapshots = resolvedModules
      .map((resolvedModule) =>
        this._buildMiningSnapshot(characterID, ship, resolvedModule),
      )
      .filter((entry) =>
        entry && finite(entry.snapshot && entry.snapshot.maxRangeMeters, 0) > 0,
      );
    if (miningSnapshots.length <= 0) {
      this._deactivateWingMiningModules(
        scene,
        this._buildWingModuleSession(session, characterID, entity),
        entity,
        "npc",
      );
      this._recallMiningDrones(session, characterID, entity, ship, scene);
      miningState.status = "no-mining-module";
      miningState.targetID = 0;
      return false;
    }

    let activeTarget = positive(miningState.targetID)
      ? scene.getEntityByID(positive(miningState.targetID))
      : null;
    let mineableState = activeTarget
      ? getMiningRuntimeState().getMineableState(scene, activeTarget.itemID)
      : null;
    let resolvedMiningModule = miningSnapshots.find((entry) =>
      this._miningSnapshotMatchesTarget(entry.snapshot, mineableState),
    ) || null;
    const moduleSession = this._buildWingModuleSession(session, characterID, entity);
    if (
      !activeTarget ||
      !mineableState ||
      mineableState.remainingQuantity <= 0 ||
      !resolvedMiningModule
    ) {
      const stopped = this._deactivateWingMiningModules(
        scene,
        moduleSession,
        entity,
        "target",
      );
      this._recallMiningDrones(session, characterID, entity, ship, scene);
      if (stopped.pending > 0) {
        miningState.status = "switching-target";
        miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
        return false;
      }
      const nextTarget = this._selectMiningTarget(scene, entity, miningSnapshots);
      if (!nextTarget) {
        miningState.status = "no-target";
        miningState.targetID = 0;
        miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
        return false;
      }
      miningState.targetID = positive(nextTarget.itemID);
      miningState.status = "approaching";
      miningState.nextCycleAtMs = 0;
      activeTarget = nextTarget;
      mineableState = getMiningRuntimeState().getMineableState(
        scene,
        activeTarget.itemID,
      );
      resolvedMiningModule = miningSnapshots.find((entry) =>
        this._miningSnapshotMatchesTarget(entry.snapshot, mineableState),
      ) || null;
    }

    if (!activeTarget || !mineableState || !resolvedMiningModule) {
      miningState.status = "target-incompatible";
      return false;
    }

    const engagementRange = this._miningEngagementRange(
      scene,
      entity,
      resolvedMiningModule,
    );
    const actualDistance = surfaceDistanceBetween(entity, activeTarget);
    if (engagementRange <= 0 || actualDistance > engagementRange) {
      const moveResult = this._syncMiningApproachOrder(
        runtime,
        scene,
        systemID,
        entity,
        activeTarget,
      );
      miningState.status = moveResult === true ? "approaching" : "out-of-range";
      return false;
    }

    // Keep the ship moving around the asteroid instead of stopping at the
    // first follow point. The orbit distance is deliberately independent of
    // the module range; range/lock checks above decide whether it is safe to
    // begin a cycle.
    this._syncMiningApproachOrder(
      runtime,
      scene,
      systemID,
      entity,
      activeTarget,
    );

    const targets = typeof scene.getTargetsForEntity === "function"
      ? scene.getTargetsForEntity(entity)
      : [];
    if (!targets.includes(positive(activeTarget.itemID))) {
      const lockResult = typeof scene.requestModuleTargetLock === "function"
        ? scene.requestModuleTargetLock(entity, activeTarget, {suppressTargetNotice: true})
        : {success: false, errorMsg: "TARGET_LOCK_UNAVAILABLE"};
      if (!lockResult || lockResult.success !== true) {
        this._recallMiningDrones(session, characterID, entity, ship, scene);
        miningState.status = "lock-failed";
        miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
        return false;
      }
      if (lockResult.data && lockResult.data.pending === true) {
        this._recallMiningDrones(session, characterID, entity, ship, scene);
        miningState.status = "locking";
        miningState.nextCycleAtMs = Date.now() + Math.max(
          MINING_RETRY_MS,
          finite(lockResult.data.lockDurationMs, MINING_RETRY_MS),
        );
        return false;
      }
    }

    const compatibleMiningSnapshots = miningSnapshots.filter((entry) =>
      this._miningSnapshotMatchesTarget(entry.snapshot, mineableState),
    );
    const storage = this._availableMiningStorage(
      characterID,
      ship,
      resolvedMiningModule.fittedItems,
      getSkillState().getCachedCharacterSkillMap(characterID),
      mineableState.yieldTypeID,
    );
    const unitVolume = Math.max(0, finite(mineableState.unitVolume, 0));
    if (unitVolume <= 0 || storage.availableVolume < unitVolume) {
      const outputBeforeCapacityGate = this._miningOutputSnapshot(
        characterID,
        shipID,
      );
      log.warn(
        `[NPCMiningWing] mining blocked by hold capacity ` +
          `char=${characterID} ship=${shipID} target=${positive(activeTarget.itemID)} ` +
          `yieldType=${positive(mineableState.yieldTypeID)} ` +
          `holdFlag=${storage.flagID} used=${storage.used} ` +
          `capacity=${storage.capacity} available=${storage.availableVolume} ` +
          `unitVolume=${unitVolume} ` +
          `miningOutputQuantity=${outputBeforeCapacityGate.quantity} ` +
          `miningOutputVolume=${outputBeforeCapacityGate.volume} ` +
          `miningOutputItems=${outputBeforeCapacityGate.itemSummary}`,
      );
      if (
        unitVolume > 0 &&
        storage.availableVolume < unitVolume &&
        outputBeforeCapacityGate.quantity <= 0
      ) {
        this._deactivateWingMiningModules(
          scene,
          moduleSession,
          entity,
          "cargo",
        );
        this._recallMiningDrones(session, characterID, entity, ship, scene);
        miningState.cargoReturn = false;
        miningState.status = "capacity-blocked";
        miningState.lastError = "NPC_WING_MINING_HOLD_FULL";
        miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
        log.warn(
          `[NPCMiningWing] capacity gate has no mining output; ` +
            `cargo handoff not attempted ` +
            `char=${characterID} ship=${shipID} ` +
            `available=${storage.availableVolume} unitVolume=${unitVolume}`,
        );
        return false;
      }
      this._deactivateWingMiningModules(
        scene,
        moduleSession,
        entity,
        "cargo",
      );
      this._recallMiningDrones(session, characterID, entity, ship, scene);
      miningState.cargoReturn = true;
      miningState.status = "returning-for-cargo";
      miningState.lastError = "";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return this._tickMiningCargoReturn(
        runtime,
        scene,
        session,
        characterID,
        character,
        systemID,
        shipID,
        entity,
        leader,
        miningState,
      );
    }

    const activation = this._activateWingMiningModules(
      scene,
      moduleSession,
      entity,
      activeTarget,
      compatibleMiningSnapshots,
    );
    if (activation.active > 0) {
      const targetID = positive(activeTarget.itemID);
      if (positive(miningState.lastActivationTargetID) !== targetID) {
        log.info(
          `[NPCMiningWing] char=${characterID} native mining activated ` +
            `ship=${shipID} target=${targetID} modules=${activation.active}`,
        );
      }
      miningState.status = "mining";
      miningState.lastActivationTargetID = targetID;
      miningState.lastError = "";
      miningState.nextCycleAtMs = 0;
      this._recordMetric(characterID, "miningActivations");
      this._observeMiningInventory(
        characterID,
        shipID,
        targetID,
        {...miningState, yieldTypeID: mineableState.yieldTypeID},
        storage,
        compatibleMiningSnapshots,
        {
          entity,
          targetEntity: activeTarget,
          mineableState,
          activation,
          scene,
        },
      );
      const droneResult = this._maintainMiningDrones(
        session,
        characterID,
        ship,
        entity,
        scene,
        activeTarget,
        mineableState,
      );
      miningState.miningDroneCount = positive(droneResult && droneResult.active);
      return true;
    }
    if (activation.pending > 0) {
      miningState.status = "switching-target";
      miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
      return false;
    }

    const activationError = activation.errors[0] && activation.errors[0].errorMsg
      ? activation.errors[0].errorMsg
      : "ACTIVATION_FAILED";
    miningState.status = "activation-failed";
    miningState.lastError = activationError;
    miningState.nextCycleAtMs = Date.now() + MINING_RETRY_MS;
    this._recallMiningDrones(session, characterID, entity, ship, scene);
    log.warn(
      `[NPCMiningWing] char=${characterID} native mining activation failed ` +
        `ship=${shipID} target=${positive(activeTarget.itemID)} error=${activationError}`,
    );
    return false;
  }

  _tickMiningWing(runtime, scene, session, characterID, character, systemID, leader) {
    this._tickCollectionShipFollow(
      runtime,
      scene,
      characterID,
      character,
      systemID,
      leader,
    );
    const before = serializePersistentMiningStates(character.miningShipStates);
    for (const shipID of this._deployedShipIDs(character)) {
      if (positive(character.collectionShipID) === shipID) {
        delete character.miningShipStates[String(shipID)];
        continue;
      }
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || !isShipInSystem(ship, systemID)) {
        continue;
      }
      let entity = scene.getEntityByID(shipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} mining spawn failed ` +
              `ship=${shipID} error=${error.message}`,
          );
          this._sendWingChat(
            session,
            characterID,
            shipID,
            `I could not enter the system scene to begin mining: ${friendlyErrorMessage(error)}`,
          );
          continue;
        }
      }
      const previousMiningState = character.miningShipStates[String(shipID)]
        ? clone(character.miningShipStates[String(shipID)])
        : null;
      this._tickMiningShip(
        runtime,
        scene,
        session,
        characterID,
        character,
        systemID,
        shipID,
        entity,
        leader,
      );
      this._sendMiningStatusChat(
        session,
        characterID,
        shipID,
        previousMiningState,
        character.miningShipStates[String(shipID)],
      );
    }
    if (before !== serializePersistentMiningStates(character.miningShipStates)) {
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
    }
  }

  _refreshDeployedSkillProfiles(scene, characterID, character) {
    if (!scene || !positive(characterID) || !character) {
      return;
    }
    for (const shipID of this._deployedShipIDs(character)) {
      const entity = scene.getEntityByID(shipID);
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (
        !entity ||
        !ship ||
        (
          positive(entity.npcMiningWingSkillOwnerID) === positive(characterID) &&
          entity.skillMap instanceof Map
        )
      ) {
        continue;
      }
      try {
        this._applyWingSkillProfile(characterID, ship, entity);
      } catch (error) {
        log.warn(
          `[NPCMiningWing] char=${characterID} skill profile refresh failed ` +
            `ship=${shipID} error=${error.message}`,
        );
      }
    }
  }

  _tickSessionRuntime(runtime, scene, session) {
    if (!session || session.disconnected === true) {
      return;
    }
    const characterID = sessionCharacterID(session);
    const systemID = currentSpaceSystemID(session);
    if (!characterID || !systemID) {
      return;
    }
    const state = this._getState();
    const character = state.characters[String(characterID)];
    if (!character || !Array.isArray(character.deployedShipIDs) || !character.deployedShipIDs.length) {
      return;
    }
    const leader = scene.getShipEntityForSession(session);
    if (!leader) {
      return;
    }
    this._materializeWingShipsForScene(
      runtime,
      scene,
      characterID,
      character,
      systemID,
    );
    this._tickLaunchTransit(
      runtime,
      scene,
      characterID,
      character,
      systemID,
      leader,
    );
    const metrics = this._metricsFor(characterID);
    metrics.runtimeTicks += 1;
    metrics.lastTickAtMs = Date.now();
    this._reattachWingDroneEntities(scene, characterID);
    this._refreshDeployedSkillProfiles(scene, characterID, character);
    const automationStateBefore = serializePersistentMiningStates(
      character.miningShipStates,
    );
    this._tickWingDroneAutomation(
      runtime,
      scene,
      session,
      characterID,
      character,
      systemID,
      leader,
    );
    if (
      automationStateBefore !==
      serializePersistentMiningStates(character.miningShipStates)
    ) {
      character.revision = positive(character.revision) + 1;
      writeState(state);
    }
    this._observeSessionMovement(
      runtime,
      session,
      characterID,
      character,
      systemID,
      leader,
    );
    const leaderDockingStationID = this._leaderDockingStationID(leader);
    if (leaderDockingStationID && character.command === "follow") {
      this._beginLeaderDocking(
        runtime,
        scene,
        characterID,
        character,
        systemID,
        leaderDockingStationID,
      );
    }
    if (character.dockingWithLeader === true) {
      this._tickRecall(runtime, scene, session, characterID, character, systemID);
      return;
    }
    if (character.recalling === true) {
      this._tickRecall(runtime, scene, session, characterID, character, systemID);
      return;
    }
    if (character.command === "follow") {
      this._tickRemoteFollow(
        runtime,
        characterID,
        character,
        systemID,
        session,
        leader,
      );
    }
    if (character.command === "follow") {
      this._tickWarpFollower(runtime, scene, session, characterID, character, systemID, leader);
    } else if (character.command === "mine") {
      this._tickMiningWing(runtime, scene, session, characterID, character, systemID, leader);
    } else {
      this._clearWarpTargetsForCharacter(characterID);
    }
  }

  _tickRuntime() {
    miningTrace.heartbeat(() => {
      const runtime = getSpaceRuntime();
      return {
        service: "runtime-tick-enter", scenes: runtime.scenes && runtime.scenes.size,
        sessions: runtime.scenes ? [...runtime.scenes.values()].reduce((sum, scene) => sum + (scene.sessions && scene.sessions.size || 0), 0) : 0,
        wings: Object.entries(this._getState().characters || {}).filter(([, c]) => c.deployedShipIDs && c.deployedShipIDs.length).map(([characterID, c]) => ({
          characterID, command: c.command, deployedShipIDs: c.deployedShipIDs,
          collectionShipID: c.collectionShipID,
        })),
      };
    });
    try {
      const runtime = getSpaceRuntime();
      if (!runtime.scenes || typeof runtime.scenes.values !== "function") {
        return;
      }
      const state = this._getState();
      for (const [characterID] of Object.entries(state.characters || {})) {
        const character = characterState(state, positive(characterID));
        if (character && character.collectionTrip && character.collectionTrip.active === true) {
          try {
            this._tickCollectionTrip(runtime, positive(characterID), character);
          } catch (error) {
            log.warn(
              `[NPCMiningWing] collection trip tick failed ` +
                `char=${characterID} error=${error.message}`,
            );
          }
        }
        if (character && character.recalling === true) {
          try {
            this._tickRemoteRecall(runtime, positive(characterID), character);
          } catch (error) {
            log.warn(
              `[NPCMiningWing] remote recall tick failed ` +
                `char=${characterID} error=${error.message}`,
            );
          }
        }
        if (
          character &&
          character.command === "follow" &&
          character.dockingWithLeader !== true &&
          character.recalling !== true
        ) {
          try {
            const leaderSession = getSessionRegistry().findSessionByCharacterID(
              positive(characterID),
            );
            const leaderSystemID = currentSystemID(leaderSession);
            if (leaderSession && leaderSystemID) {
              const leaderScene = currentSpaceSystemID(leaderSession)
                ? this._findSceneForSystem(runtime, leaderSystemID)
                : null;
              const leaderEntity = leaderScene
                ? leaderScene.getShipEntityForSession(leaderSession)
                : null;
              this._tickRemoteFollow(
                runtime,
                positive(characterID),
                character,
                leaderSystemID,
                leaderSession,
                leaderEntity,
              );
            }
            const stationID = dockedLocationID(leaderSession);
            const station = dockableLocation(stationID);
            const systemID = dockableSystemID(station);
            const scene = systemID
              ? this._findSceneForSystem(runtime, systemID)
              : null;
            if (
              leaderSession &&
              !currentSpaceSystemID(leaderSession) &&
              station &&
              systemID
            ) {
              this._beginLeaderDocking(
                runtime,
                scene,
                positive(characterID),
                character,
                systemID,
                stationID,
              );
            }
          } catch (error) {
            log.warn(
              `[NPCMiningWing] docked leader handoff failed ` +
                `char=${characterID} error=${error.message}`,
            );
          }
        }
        if (character && character.dockingWithLeader === true) {
          try {
            this._tickDockingWithoutLeader(runtime, positive(characterID), character);
          } catch (error) {
            log.warn(
              `[NPCMiningWing] leader docking tick failed ` +
                `char=${characterID} error=${error.message}`,
            );
          }
        }
      }
      for (const scene of runtime.scenes.values()) {
        if (!scene || !scene.sessions || typeof scene.sessions.values !== "function") {
          continue;
        }
        for (const session of scene.sessions.values()) {
          const runtimeCharacterID = positive(sessionCharacterID(session));
          const previousFailure = runtimeCharacterID
            ? this._runtimeFailures.get(String(runtimeCharacterID))
            : null;
          if (runtimeFailureIsCoolingDown(previousFailure)) {
            continue;
          }
          try {
            this._tickSessionRuntime(runtime, scene, session);
            if (runtimeCharacterID) {
              this._runtimeFailures.delete(String(runtimeCharacterID));
            }
          } catch (error) {
            if (!runtimeCharacterID) {
              log.warn(`[NPCMiningWing] runtime tick failed: ${error.message}`);
              continue;
            }
            const failure = nextRuntimeFailure(previousFailure, error);
            this._runtimeFailures.set(String(runtimeCharacterID), failure);
            const metrics = this._recordMetric(runtimeCharacterID, "runtimeFailures");
            metrics.lastFailureAtMs = Date.now();
            if (failure.shouldLog) {
              log.warn(
                `[NPCMiningWing] runtime tick failed ` +
                  `char=${runtimeCharacterID} failures=${failure.count} ` +
                  `retryInMs=${failure.backoffMs}: ${failure.message}`,
              );
            }
          }
        }
      }
      this._maybeStopRuntimeTicker();
    } catch (error) {
      log.warn(`[NPCMiningWing] runtime ticker failed: ${error.message}`);
    } finally {
      miningTrace.runtimeCompleted();
    }
  }

  _startRecall(session, characterID, character, deployedShipIDs, options = {}) {
    const currentSystem = positive(
      options.currentSystemID || currentSystemID(session),
    );
    const dockedStationID = positive(options.dockedStationID || dockedLocationID(session));
    const inSpace = Boolean(currentSpaceSystemID(session));
    const recallStationIDs = {};
    const recallTransit = {};
    const usableShipIDs = [];
    const state = this._getState();
    const launchTransit = {...(character.launchTransit || {})};
    const runtime = getSpaceRuntime();
    this._clearDockingState(character);

    for (const shipID of deployedShipIDs) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
        this._finishRecalledShip(character, shipID);
        continue;
      }
      const shipSystem = shipSystemID(ship);
      let stationID = positive(
        character.returnLocationIDs[String(shipID)],
      );
      if (!stationID && dockedStationID && shipSystem === currentSystem) {
        stationID = dockedStationID;
      }
      if (!stationID) {
        throw new Error("NPC_WING_RETURN_STATION_UNKNOWN");
      }
      const station = this._validateReturnStation(stationID, 0, true);
      const targetSystem = dockableSystemID(station);
      if (!shipSystem || !targetSystem) {
        throw new Error("NPC_WING_RECALL_SYSTEM_UNKNOWN");
      }
      recallStationIDs[String(shipID)] = stationID;
      usableShipIDs.push(shipID);
      if (shipSystem !== targetSystem) {
        recallTransit[String(shipID)] = this._buildRecallTransit(ship, stationID);
      }
    }

    if (usableShipIDs.length <= 0) {
      character.recalling = false;
      character.command = "hold";
      character.recallStationIDs = {};
      character.recallTransit = {};
      character.followTransit = {};
      character.miningShipStates = {};
      character.revision = positive(character.revision) + 1;
      writeState(state);
      this._maybeStopRuntimeTicker();
      throw new Error("NPC_WING_NO_DEPLOYED_SHIPS");
    }

    character.recallStationIDs = recallStationIDs;
    character.recallTransit = recallTransit;
    character.followTransit = {};
    character.launchTransit = {};
    character.miningShipStates = {};
    character.recalling = true;
    character.command = "return";
    character.revision = positive(character.revision) + 1;
    writeState(state);
    this._ensureRuntimeTicker();

    const scene = inSpace ? runtime.getSceneForSession(session) : null;
    for (const shipID of usableShipIDs) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      const shipSystem = shipSystemID(ship);
      const sourceScene = shipSystem
        ? this._findSceneForSystem(runtime, shipSystem)
        : null;
      const entity = sourceScene && sourceScene.getEntityByID(shipID);
      if (launchTransit[String(shipID)] && sourceScene) {
        this._cancelSessionlessWingMovement(
          runtime,
          sourceScene,
          shipSystem,
          characterID,
          shipID,
          "recall",
        );
      }
      if (sourceScene && entity) {
        this._returnWingDronesToBay(
          session,
          characterID,
          entity,
          ship,
          null,
          sourceScene,
        );
        this._deactivateWingMiningModules(
          sourceScene,
          this._buildWingModuleSession(session, characterID, entity),
          entity,
          "npc",
        );
      }
    }
    let immediateChange = false;
    for (const shipID of usableShipIDs) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship) {
        continue;
      }
      const station = this._validateReturnStation(
        recallStationIDs[String(shipID)],
        0,
        true,
      );
      const targetSystem = dockableSystemID(station);
      const shipSystem = shipSystemID(ship);
      if (shipSystem !== currentSystem || !targetSystem || shipSystem !== targetSystem) {
        continue;
      }
      if (inSpace && shipSystem === currentSystem && scene) {
        try {
          this._ensureDeployedEntity(runtime, scene, currentSystem, shipID);
          this._issueRecallMovement(
            runtime,
            scene,
            currentSystem,
            shipID,
            recallStationIDs[String(shipID)],
          );
        } catch (error) {
          log.warn(
            `[NPCMiningWing] char=${characterID} recall movement pending ` +
              `ship=${shipID} error=${error.message}`,
          );
        }
        continue;
      }
      if (!this._prepareWingShipForDock(
        session,
        characterID,
        ship,
        this._findSceneForSystem(runtime, shipSystem),
      )) {
        continue;
      }
      if (!this._removeShipFromSystemScene(runtime, shipSystem, shipID)) {
        continue;
      }
      const dockResult = itemStore.dockShipToLocation(
        shipID,
        recallStationIDs[String(shipID)],
      );
      if (dockResult && dockResult.success === true) {
        this._depositDockedMiningCargo(
          session,
          characterID,
          shipID,
          recallStationIDs[String(shipID)],
          "while-docked",
        );
        this._syncDockedShipToSession(
          session,
          characterID,
          shipID,
          dockResult,
          "while-docked",
        );
        this._finishRecalledShip(character, shipID);
        immediateChange = true;
        log.info(
          `[NPCMiningWing] char=${characterID} recalled ship=${shipID} ` +
            `station=${recallStationIDs[String(shipID)]} while-docked=true`,
        );
      }
    }

    if (character.deployedShipIDs.length === 0) {
      character.recalling = false;
      character.command = "hold";
      character.recallStationIDs = {};
      character.recallTransit = {};
      character.followTransit = {};
      immediateChange = true;
    }
    if (immediateChange) {
      character.revision = positive(character.revision) + 1;
      writeState(state);
      this._maybeStopRuntimeTicker();
    }
    log.info(
      `[NPCMiningWing] char=${characterID} recall-start ` +
        `ships=${character.deployedShipIDs.join(",")} currentSystem=${currentSystem}`,
    );
    return true;
  }

  _activeShipResourceState(characterID, activeShipID) {
    const ship = itemStore.findCharacterShipItem(characterID, activeShipID);
    if (!ship) {
      return null;
    }
    const fitting = getLiveFittingState();
    const fittedItems = fitting.getFittedModuleItems(characterID, activeShipID);
    const skillMap = getSkillState().getCachedCharacterSkillMap(characterID);
    return {
      ship,
      resourceState: fitting.buildShipResourceState(characterID, ship, {
        fittedItems,
        skillMap,
      }),
    };
  }

  _cargoVolumeForHold(characterID, shipID, flagID) {
    return cargoItemsForShip(characterID, shipID)
      .filter((item) => Number(item.flagID) === Number(flagID))
      .reduce((sum, item) => sum + itemQuantity(item) * Math.max(
        0,
        finite(itemStore.getInventoryItemUnitVolume(item), 0),
      ), 0);
  }

  _cargoMovePlan(characterID, activeShipID, item) {
    const context = this._activeShipResourceState(characterID, activeShipID);
    if (!context || !context.resourceState) {
      return {
        destinationFlagID: itemStore.ITEM_FLAGS.CARGO_HOLD,
        destinationHold: holdName(itemStore.ITEM_FLAGS.CARGO_HOLD),
        quantity: null,
      };
    }

    const resourceState = context.resourceState;
    const inventory = getMiningInventory();
    const preferredMiningFlag = inventory.getPreferredMiningHoldFlagForType(
      resourceState,
      positive(item && item.typeID),
    );
    const destinationFlagID = preferredMiningFlag || itemStore.ITEM_FLAGS.CARGO_HOLD;
    const capacity = destinationFlagID === itemStore.ITEM_FLAGS.CARGO_HOLD
      ? Math.max(0, finite(resourceState.cargoCapacity, 0))
      : Math.max(
        0,
        finite(
          inventory.getShipHoldCapacityByFlag(resourceState, destinationFlagID),
          0,
        ),
      );
    const used = this._cargoVolumeForHold(
      characterID,
      activeShipID,
      destinationFlagID,
    );
    const availableVolume = Math.max(0, capacity - used);
    const sourceQuantity = itemQuantity(item);
    const unitVolume = Math.max(
      0,
      finite(itemStore.getInventoryItemUnitVolume(item), 0),
    );
    if (sourceQuantity <= 0) {
      throw new Error("NPC_WING_CARGO_EMPTY");
    }
    if (unitVolume <= 0) {
      return {
        destinationFlagID,
        destinationHold: holdName(destinationFlagID),
        quantity: null,
      };
    }

    const maximumQuantity = Math.min(
      sourceQuantity,
      Math.floor((availableVolume + 0.000001) / unitVolume),
    );
    if (maximumQuantity <= 0) {
      throw new Error("NPC_WING_DESTINATION_HOLD_FULL");
    }
    return {
      destinationFlagID,
      destinationHold: holdName(destinationFlagID),
      quantity: maximumQuantity < sourceQuantity ? maximumQuantity : null,
    };
  }

  _transferCargoForShip(
    session,
    characterID,
    shipID,
    activeShipID,
    options = {},
  ) {
    const destinationShipID = positive(options.destinationShipID || activeShipID);
    const context = this._cargoContext(
      session,
      characterID,
      shipID,
      destinationShipID,
    );
    const sourceItems = cargoItemsForShip(characterID, shipID);
    const miningOnly = options.miningOnly === true;
    const transferItems = miningOnly
      ? sourceItems.filter(isMiningOutputItem)
      : sourceItems;
    const moved = [];
    const failed = [];
    if (!miningOnly && sourceItems.length === 0) {
      failed.push({shipID, error: "NPC_WING_CARGO_EMPTY"});
    }
    for (const item of transferItems) {
      let movePlan;
      try {
        movePlan = this._cargoMovePlan(characterID, destinationShipID, item);
      } catch (error) {
        failed.push({
          shipID,
          itemID: positive(item && item.itemID),
          error: error.message,
        });
        continue;
      }
      const moveResult = itemStore.moveItemToLocation(
        item.itemID,
        destinationShipID,
        movePlan.destinationFlagID,
        movePlan.quantity,
      );
      if (!moveResult || moveResult.success !== true || !moveResult.data) {
        failed.push({
          shipID,
          itemID: positive(item.itemID),
          error: String(moveResult && moveResult.errorMsg || "MOVE_FAILED"),
        });
        continue;
      }
      moved.push({
        shipID,
        itemID: positive(item.itemID),
        quantity: positive(moveResult.data.quantity),
        destinationFlagID: movePlan.destinationFlagID,
        destinationHold: movePlan.destinationHold,
      });
      this._syncMiningChanges(session, moveResult.data.changes);
    }
    return {context, sourceItems, transferItems, moved, failed};
  }

  _cargoContext(session, characterID, shipID, destinationShipID = 0) {
    const {runtime, scene, systemID, leader} = this._spaceContext(session);
    if (String(leader.mode || "") === "WARP") {
      throw new Error("NPC_WING_CARGO_DURING_WARP");
    }
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    if (!ship || !isShipInSystem(ship, systemID)) {
      throw new Error("NPC_WING_SHIP_NOT_IN_CURRENT_SYSTEM");
    }
    const entity = scene.getEntityByID(shipID) ||
      this._ensureDeployedEntity(runtime, scene, systemID, shipID);
    if (!entity || !canEntitiesInteractLocally(leader, entity)) {
      throw new Error("NPC_WING_CARGO_ENTITY_NOT_FOUND");
    }
    const numericDestinationShipID = positive(destinationShipID || leader.itemID);
    let destinationEntity = leader;
    let destinationShip = null;
    if (numericDestinationShipID === positive(leader.itemID) &&
      distanceBetween(leader.position, entity.position) > CARGO_TRANSFER_RANGE_METERS) {
      throw new Error("NPC_WING_CARGO_OUT_OF_RANGE");
    }
    if (numericDestinationShipID !== positive(leader.itemID)) {
      destinationShip = itemStore.findCharacterShipItem(
        characterID,
        numericDestinationShipID,
      );
      if (!destinationShip || !isShipInSystem(destinationShip, systemID)) {
        throw new Error("NPC_WING_COLLECTION_UNAVAILABLE");
      }
      destinationEntity = scene.getEntityByID(numericDestinationShipID) ||
        this._ensureDeployedEntity(runtime, scene, systemID, numericDestinationShipID);
      if (!destinationEntity || !canEntitiesInteractLocally(entity, destinationEntity)) {
        throw new Error("NPC_WING_COLLECTION_UNAVAILABLE");
      }
      if (distanceBetween(destinationEntity.position, entity.position) > CARGO_TRANSFER_RANGE_METERS) {
        throw new Error("NPC_WING_CARGO_OUT_OF_RANGE");
      }
    }
    return {
      runtime,
      scene,
      systemID,
      leader,
      ship,
      entity,
      destinationShipID: numericDestinationShipID,
      destinationShip,
      destinationEntity,
    };
  }

  _serializeCargoItem(item) {
    const metadata = itemStore.getItemMetadata(item && item.typeID, item && item.itemName);
    return {
      itemID: positive(item && item.itemID),
      typeID: positive(item && item.typeID),
      typeName: String(
        item && (item.itemName || item.typeName) ||
          metadata && (metadata.name || metadata.typeName) ||
          "Item",
      ),
      quantity: itemQuantity(item),
      volume: Math.max(0, finite(itemStore.getInventoryItemUnitVolume(item), 0)),
      flagID: positive(item && item.flagID),
    };
  }

  Handle_GetWingState(args, session) {
    const characterID = this._requireCharacter(session);
    return this._stateResponse(characterID, session);
  }

  Handle_EnsureWingChat(args, session) {
    const characterID = this._requireCharacter(session);
    const record = this._ensureWingChatChannel(session, characterID);
    if (!record) {
      throw new Error("NPC_WING_CHAT_CHANNEL_UNAVAILABLE");
    }
    const state = this._getState();
    const character = characterState(state, characterID);
    return {
      roomName: String(record.roomName || ""),
      channelID: positive(character.wingChatChannelID || record.entityID),
      displayName: WING_CHAT_DISPLAY_NAME,
      joinLink: `joinChannel:${record.roomName}`,
    };
  }

  Handle_ListOwnedEligibleShips(args, session) {
    return this.Handle_GetWingState(args, session);
  }

  _startCollectionTrip(session, characterID, character, options = {}) {
    const {runtime, scene, systemID, leader} = this._spaceContext(session);
    const collectionShipID = positive(character.collectionShipID);
    if (!collectionShipID) {
      throw new Error("NPC_WING_COLLECTION_SHIP_REQUIRED");
    }
    if (character.collectionTrip && character.collectionTrip.active) {
      throw new Error("NPC_WING_COLLECTION_TRIP_ACTIVE");
    }
    if (!this._deployedShipIDs(character).includes(collectionShipID)) {
      throw new Error("NPC_WING_COLLECTION_SHIP_NOT_DEPLOYED");
    }
    const ship = itemStore.findCharacterShipItem(characterID, collectionShipID);
    if (!ship || Number(ship.flagID) !== 0) {
      throw new Error("NPC_WING_COLLECTION_SHIP_NOT_IN_SPACE");
    }
    const stationID = positive(
      character.returnLocationIDs[String(collectionShipID)] ||
        dockedLocationID(session),
    );
    const station = this._validateReturnStation(stationID, 0, true);
    const currentSystemID = shipSystemID(ship);
    const targetSystemID = dockableSystemID(station);
    if (!currentSystemID || !targetSystemID) {
      throw new Error("NPC_WING_COLLECTION_STATION_NOT_FOUND");
    }

    character.collectionTrip = {
      active: true,
      phase: "outbound",
      shipID: collectionShipID,
      stationID,
      currentSystemID,
      targetSystemID,
      readyAtMs: Date.now(),
      failureCount: 0,
      lastError: "",
    };
    delete character.launchTransit[String(collectionShipID)];
    const sourceScene = this._findSceneForSystem(runtime, currentSystemID) || scene;
    const entity = sourceScene && sourceScene.getEntityByID(collectionShipID);
    if (entity) {
      this._returnWingDronesToBay(
        session,
        characterID,
        entity,
        ship,
        null,
        sourceScene,
      );
      this._deactivateWingMiningModules(
        sourceScene,
        this._buildWingModuleSession(session, characterID, entity),
        entity,
        "collection-trip",
      );
      if (currentSystemID === targetSystemID && sourceScene === scene) {
        try {
          this._cancelSessionlessWingMovement(
            runtime,
            sourceScene,
            currentSystemID,
            characterID,
            collectionShipID,
            "collection-trip",
          );
          this._issueRecallMovement(
            runtime,
            sourceScene,
            currentSystemID,
            collectionShipID,
            stationID,
          );
        } catch (error) {
          log.warn(
            `[NPCMiningWing] collection station approach pending ` +
              `char=${characterID} ship=${collectionShipID} error=${error.message}`,
          );
        }
      }
    }
    character.revision = positive(character.revision) + 1;
    writeState(this._getState());
    this._ensureRuntimeTicker();
    this._sendWingChat(
      session,
      characterID,
      collectionShipID,
      options.automatic === true
        ? `Collection ship cargo is full. It is unloading at ${dockableLocationName(stationID) || "its saved station"} and will return automatically.`
        : `Collection ship sent to ${dockableLocationName(stationID) || "its saved station"} to unload ore.`,
    );
    return this._tickCollectionTrip(runtime, characterID, character) || true;
  }

  _tickCollectionTrip(runtime, characterID, character) {
    const trip = character && character.collectionTrip;
    if (!trip || trip.active !== true) {
      return false;
    }
    const now = Date.now();
    if (finite(trip.readyAtMs, 0) > now) {
      return false;
    }
    const defer = (errorCode) => {
      deferCollectionTrip(trip, Date.now(), GATE_TRANSIT_MS, errorCode);
      this._recordMetric(characterID, "collectionRetries");
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
      return false;
    };
    const collectionShipID = positive(trip.shipID || character.collectionShipID);
    const stationID = positive(trip.stationID);
    const ship = itemStore.findCharacterShipItem(characterID, collectionShipID);
    if (!collectionShipID || !stationID || !ship) {
      trip.active = false;
      trip.phase = "idle";
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
      return false;
    }

    let station;
    try {
      station = this._validateReturnStation(stationID, 0, true);
    } catch (error) {
      trip.active = false;
      trip.phase = "idle";
      log.warn(
        `[NPCMiningWing] collection trip cancelled ` +
          `char=${characterID} ship=${collectionShipID} error=${error.message}`,
      );
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
      return false;
    }
    const targetStationSystemID = dockableSystemID(station);
    const currentSystemID = shipSystemID(ship) || positive(trip.currentSystemID);
    const phase = String(trip.phase || "outbound");

    if (phase === "outbound") {
      trip.currentSystemID = currentSystemID;
      trip.targetSystemID = targetStationSystemID;
      if (currentSystemID !== targetStationSystemID) {
        if (finite(trip.readyAtMs, 0) > now) {
          return false;
        }
        const route = this._findRoute(currentSystemID, targetStationSystemID);
        const nextSystemID = route && positive(route[1]);
        const gate = this._gateBetween(currentSystemID, nextSystemID);
        if (!nextSystemID || !gate) {
          return defer("NPC_WING_COLLECTION_ROUTE_UNAVAILABLE");
        }
        if (!this._prepareWingShipForDock(
          null,
          characterID,
          ship,
          this._findSceneForSystem(runtime, currentSystemID),
        )) {
          return defer("NPC_WING_COLLECTION_DOCK_PENDING");
        }
        if (!this._removeShipFromSystemScene(runtime, currentSystemID, collectionShipID)) {
          return defer("NPC_WING_COLLECTION_SCENE_UNAVAILABLE");
        }
        const moveResult = itemStore.moveShipToSpace(
          collectionShipID,
          nextSystemID,
          buildGateSpaceState(
            nextSystemID,
            worldData.getStargateByID(gate.destinationID) || gate,
          ),
        );
        if (!moveResult || moveResult.success !== true) {
          return defer("NPC_WING_COLLECTION_ROUTE_UNAVAILABLE");
        }
        trip.currentSystemID = nextSystemID;
        trip.readyAtMs = now + GATE_TRANSIT_MS;
        clearCollectionTripRetry(trip);
        character.revision = positive(character.revision) + 1;
        writeState(this._getState());
        const destinationScene = this._findSceneForSystem(runtime, nextSystemID);
        if (destinationScene && this._findSessionForCharacterInSystem(
          runtime,
          characterID,
          nextSystemID,
        )) {
          try {
            this._ensureDeployedEntity(runtime, destinationScene, nextSystemID, collectionShipID);
          } catch (error) {
            log.warn(
              `[NPCMiningWing] collection arrival spawn failed ` +
                `char=${characterID} ship=${collectionShipID} error=${error.message}`,
            );
          }
        }
        return true;
      }

      const scene = this._findSceneForSystem(runtime, targetStationSystemID);
      const activeSession = this._findSessionForCharacterInSystem(
        runtime,
        characterID,
        targetStationSystemID,
      );
      if (Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
        this._depositDockedMiningCargo(
          activeSession,
          characterID,
          collectionShipID,
          stationID,
          "collection-trip",
        );
        trip.phase = "returning";
        trip.currentSystemID = targetStationSystemID;
        trip.targetSystemID = currentSpaceSystemID(activeSession)
          ? currentSpaceSystemID(activeSession)
          : 0;
        trip.readyAtMs = now + GATE_TRANSIT_MS;
        character.revision = positive(character.revision) + 1;
        writeState(this._getState());
        return true;
      }
      if (!scene) {
        return defer("NPC_WING_COLLECTION_SCENE_UNAVAILABLE");
      }
      let entity = scene.getEntityByID(collectionShipID);
      if (!entity) {
        try {
          entity = this._ensureDeployedEntity(
            runtime,
            scene,
            targetStationSystemID,
            collectionShipID,
          );
        } catch (_) {
          return defer("NPC_WING_COLLECTION_SCENE_UNAVAILABLE");
        }
      }
      if (!canShipDockAtStation(entity, station)) {
        try {
          this._issueRecallMovement(
            runtime,
            scene,
            targetStationSystemID,
            collectionShipID,
            stationID,
          );
        } catch (_) {
          return defer("NPC_WING_COLLECTION_DOCK_PENDING");
        }
        return defer("NPC_WING_COLLECTION_DOCK_PENDING");
      }
      if (!this._prepareWingShipForDock(null, characterID, ship, scene)) {
        return defer("NPC_WING_COLLECTION_DOCK_PENDING");
      }
      if (!this._removeShipFromSystemScene(runtime, targetStationSystemID, collectionShipID)) {
        return defer("NPC_WING_COLLECTION_DOCK_PENDING");
      }
      const dockResult = itemStore.dockShipToLocation(collectionShipID, stationID);
      if (!dockResult || dockResult.success !== true) {
        return defer("NPC_WING_COLLECTION_DOCK_PENDING");
      }
      this._depositDockedMiningCargo(
        activeSession,
        characterID,
        collectionShipID,
        stationID,
        "collection-trip",
      );
      this._syncDockedShipToSession(
        activeSession,
        characterID,
        collectionShipID,
        dockResult,
        "collection-trip",
      );
      trip.phase = "returning";
      trip.currentSystemID = targetStationSystemID;
      trip.targetSystemID = currentSpaceSystemID(activeSession)
        ? currentSpaceSystemID(activeSession)
        : 0;
      trip.readyAtMs = now + GATE_TRANSIT_MS;
      clearCollectionTripRetry(trip);
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
      this._sendWingChat(
        activeSession,
        characterID,
        collectionShipID,
        "Collection ship docked and unloaded its mining cargo. It is returning to the wing.",
      );
      return true;
    }

    if (phase !== "returning") {
      trip.phase = "returning";
    }
    const leaderSession = getSessionRegistry().findSessionByCharacterID(characterID);
    const leaderSystemID = currentSpaceSystemID(leaderSession);
    if (leaderSystemID) {
      trip.targetSystemID = leaderSystemID;
    }
    const returnTargetSystemID = positive(trip.targetSystemID);
    if (!returnTargetSystemID || finite(trip.readyAtMs, 0) > now) {
      return defer("NPC_WING_COLLECTION_RETURN_PENDING");
    }
    const returnCurrentSystemID = positive(trip.currentSystemID || shipSystemID(ship));
    if (returnCurrentSystemID !== returnTargetSystemID) {
      if (Number(ship.flagID) !== 0) {
        const undockResult = itemStore.moveShipToSpace(
          collectionShipID,
          returnCurrentSystemID,
          buildCompanionSpaceState(
            returnCurrentSystemID,
            {
              position: station.position,
              direction: {x: 1, y: 0, z: 0},
            },
            0,
          ),
        );
        if (!undockResult || undockResult.success !== true) {
          return defer("NPC_WING_COLLECTION_RETURN_PENDING");
        }
        trip.readyAtMs = now + GATE_TRANSIT_MS;
        clearCollectionTripRetry(trip);
        character.revision = positive(character.revision) + 1;
        writeState(this._getState());
        return true;
      }
      const route = this._findRoute(returnCurrentSystemID, returnTargetSystemID);
      const nextSystemID = route && positive(route[1]);
      const gate = this._gateBetween(returnCurrentSystemID, nextSystemID);
      if (!nextSystemID || !gate) {
        return defer("NPC_WING_COLLECTION_ROUTE_UNAVAILABLE");
      }
      const destinationScene = this._findSceneForSystem(runtime, nextSystemID);
      const destinationSession = this._findSessionForCharacterInSystem(
        runtime,
        characterID,
        nextSystemID,
      );
      const destinationLeader = destinationScene && destinationSession
        ? destinationScene.getShipEntityForSession(destinationSession) ||
          destinationScene.getEntityByID(currentShipID(destinationSession))
        : null;
      const arrivalState = destinationLeader
        ? buildCompanionSpaceState(nextSystemID, destinationLeader, 0)
        : buildGateSpaceState(
          nextSystemID,
          worldData.getStargateByID(gate.destinationID) || gate,
        );
      if (!this._removeShipFromSystemScene(runtime, returnCurrentSystemID, collectionShipID)) {
        return defer("NPC_WING_COLLECTION_ROUTE_UNAVAILABLE");
      }
      const moveResult = itemStore.moveShipToSpace(
        collectionShipID,
        nextSystemID,
        arrivalState,
      );
      if (!moveResult || moveResult.success !== true) {
        return defer("NPC_WING_COLLECTION_ROUTE_UNAVAILABLE");
      }
      trip.currentSystemID = nextSystemID;
      trip.readyAtMs = now + GATE_TRANSIT_MS;
      clearCollectionTripRetry(trip);
      character.revision = positive(character.revision) + 1;
      writeState(this._getState());
      return true;
    }

    if (Number(ship.flagID) !== 0) {
      if (!leaderSession || !currentSpaceSystemID(leaderSession)) {
        return defer("NPC_WING_COLLECTION_RETURN_PENDING");
      }
      const scene = this._findSceneForSystem(runtime, returnTargetSystemID);
      const leaderShipID = currentShipID(leaderSession);
      const leader = scene && (
        scene.getShipEntityForSession(leaderSession) ||
        scene.getEntityByID(leaderShipID)
      );
      if (!scene || !leader) {
        return false;
      }
      const moveResult = itemStore.moveShipToSpace(
        collectionShipID,
        returnTargetSystemID,
        buildCompanionSpaceState(returnTargetSystemID, leader, 0),
      );
      if (!moveResult || moveResult.success !== true) {
        return defer("NPC_WING_COLLECTION_RETURN_PENDING");
      }
    }
    const destinationScene = this._findSceneForSystem(runtime, returnTargetSystemID);
    if (!destinationScene) {
      return defer("NPC_WING_COLLECTION_SCENE_UNAVAILABLE");
    }
    let destinationEntity;
    try {
      destinationEntity = this._ensureDeployedEntity(
        runtime,
        destinationScene,
        returnTargetSystemID,
        collectionShipID,
      );
    } catch (_) {
      return defer("NPC_WING_COLLECTION_SCENE_UNAVAILABLE");
    }
    if (leaderSession && destinationEntity) {
      const leader = destinationScene.getShipEntityForSession(leaderSession) ||
        destinationScene.getEntityByID(currentShipID(leaderSession));
      if (leader) {
        runtime.followDynamicEntity(
          destinationScene.sceneDescriptor || returnTargetSystemID,
          collectionShipID,
          positive(leader.itemID),
          FOLLOW_RANGE_METERS,
          {broadcast: true},
        );
      }
    }
    trip.active = false;
    trip.phase = "idle";
    trip.currentSystemID = returnTargetSystemID;
    trip.targetSystemID = returnTargetSystemID;
    trip.readyAtMs = 0;
    clearCollectionTripRetry(trip);
    character.revision = positive(character.revision) + 1;
    writeState(this._getState());
    this._sendWingChat(
      leaderSession,
      characterID,
      collectionShipID,
      "Collection ship has returned to the mining system.",
    );
    return true;
  }

  Handle_SetShipMarked(args, session) {
    const characterID = this._requireCharacter(session);
    const request = requestObject(args);
    const shipID = positive(request.shipID);
    const marked = request.marked === true;
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    if (!ship || Number(ship.flagID) !== itemStore.ITEM_FLAGS.HANGAR) {
      throw new Error("NPC_WING_SHIP_NOT_IN_CHARACTER_HANGAR");
    }
    if (shipID === currentShipID(session)) {
      throw new Error("NPC_WING_ACTIVE_SHIP_CANNOT_JOIN_WING");
    }

    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    this._ensurePilotNames(character, shipID);
    const existingMembership = new Set(wingMembershipIDs(character));
    if (
      marked &&
      !existingMembership.has(shipID) &&
      existingMembership.size >= MAX_WING_SHIPS
    ) {
      throw new Error("NPC_WING_MAX_SHIPS_EXCEEDED");
    }
    const markedShipIDs = new Set(character.markedShipIDs.map(positive).filter(Boolean));
    if (marked) markedShipIDs.add(shipID);
    else {
      markedShipIDs.delete(shipID);
      if (positive(character.collectionShipID) === shipID) {
        character.collectionShipID = 0;
      }
    }
    character.markedShipIDs = [...markedShipIDs].sort((left, right) => left - right);
    character.revision = positive(character.revision) + 1;
    writeState(state);
    log.info(`[NPCMiningWing] char=${characterID} ship=${shipID} marked=${marked}`);
    this._sendWingChat(
      session,
      characterID,
      shipID,
      marked ? "Ship marked for wing duty." : "Ship removed from wing duty.",
    );
    return this._stateResponse(characterID, session);
  }

  Handle_SetCollectionShip(args, session) {
    const characterID = this._requireCharacter(session);
    const request = requestObject(args);
    const shipID = positive(request.shipID);
    const enabled = request.enabled !== false;
    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    if (character.collectionTrip && character.collectionTrip.active) {
      throw new Error("NPC_WING_COLLECTION_TRIP_ACTIVE");
    }
    if (!enabled) {
      character.collectionShipID = 0;
      character.revision = positive(character.revision) + 1;
      writeState(state);
      this._sendWingChat(session, characterID, shipID, "Collection ship role cleared.");
      return this._stateResponse(characterID, session);
    }
    if (!shipID) {
      throw new Error("NPC_WING_COLLECTION_SHIP_REQUIRED");
    }
    const ship = itemStore.findCharacterShipItem(characterID, shipID);
    if (!ship) {
      throw new Error("NPC_WING_SHIP_NOT_FOUND");
    }
    if (shipID === currentShipID(session)) {
      throw new Error("NPC_WING_ACTIVE_SHIP_CANNOT_JOIN_WING");
    }
    if (!wingMembershipIDs(character).includes(shipID)) {
      throw new Error("NPC_WING_COLLECTION_SHIP_NOT_MARKED");
    }
    character.collectionShipID = shipID;
    this._ensurePilotNames(character, shipID);
    if (Number(ship.flagID) === 0) {
      try {
        const runtime = getSpaceRuntime();
        const systemID = shipSystemID(ship);
        const scene = this._findSceneForSystem(runtime, systemID);
        const entity = scene && scene.getEntityByID(shipID);
        if (entity) {
          this._returnWingDronesToBay(session, characterID, entity, ship, null, scene);
          this._deactivateWingMiningModules(
            scene,
            this._buildWingModuleSession(session, characterID, entity),
            entity,
            "collection-role",
          );
        }
      } catch (error) {
        log.warn(
          `[NPCMiningWing] collection role module cleanup pending ` +
            `char=${characterID} ship=${shipID} error=${error.message}`,
        );
      }
    }
    delete character.miningShipStates[String(shipID)];
    character.revision = positive(character.revision) + 1;
    writeState(state);
    this._sendWingChat(
      session,
      characterID,
      shipID,
      "This ship is now the collection ship. Miners will unload into it while it is deployed.",
    );
    return this._stateResponse(characterID, session);
  }

  Handle_SendCollectionShip(args, session) {
    const characterID = this._requireCharacter(session);
    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    this._startCollectionTrip(session, characterID, character);
    return this._stateResponse(characterID, session);
  }

  Handle_SetWingCommand(args, session) {
    const characterID = this._requireCharacter(session);
    const request = requestObject(args);
    const command = String(request.command || "").trim().toLowerCase();
    if (!COMMANDS.has(command)) {
      throw new Error("NPC_WING_COMMAND_NOT_READY");
    }
    const {runtime, scene, systemID, leader} = this._spaceContext(session);
    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    this._suppressHiveDefenseForCharacter(characterID, character);
    const deployedShipIDs = this._deployedShipIDs(character);
    if (deployedShipIDs.length > MAX_WING_SHIPS) {
      throw new Error("NPC_WING_MAX_SHIPS_EXCEEDED");
    }
    if (!deployedShipIDs.length) {
      throw new Error("NPC_WING_NO_DEPLOYED_SHIPS");
    }
    if (
      command === "mine" &&
      deployedShipIDs.length > MAX_MINING_SHIPS &&
      !positive(character.collectionShipID)
    ) {
      throw new Error("NPC_WING_COLLECTION_REQUIRED_FOR_FULL_WING");
    }
    this._ensurePilotNames(character, deployedShipIDs);

    if (command === "mine") {
      for (const shipID of deployedShipIDs) {
        const ship = itemStore.findCharacterShipItem(characterID, shipID);
        if (!ship || !isShipInSystem(ship, systemID)) {
          throw new Error("NPC_WING_SHIP_NOT_IN_CURRENT_SYSTEM");
        }
      }
    }

    const configuredCollectionShipID = positive(character.collectionShipID);
    if (command === "mine" && configuredCollectionShipID) {
      if (!deployedShipIDs.includes(configuredCollectionShipID)) {
        throw new Error("NPC_WING_COLLECTION_SHIP_NOT_DEPLOYED");
      }
      const collectionShip = itemStore.findCharacterShipItem(
        characterID,
        configuredCollectionShipID,
      );
      if (!collectionShip) {
        throw new Error("NPC_WING_SHIP_NOT_FOUND");
      }
      if (!isShipInSystem(collectionShip, systemID)) {
        throw new Error("NPC_WING_COLLECTION_NOT_IN_SPACE");
      }
    }

    let localShipCount = 0;
    const followTransit = {};
    for (const shipID of deployedShipIDs) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || !isShipInSystem(ship, systemID)) {
        if (ship && command !== "mine") {
          const remoteSystemID = shipSystemID(ship);
          const remoteScene = remoteSystemID
            ? this._findSceneForSystem(runtime, remoteSystemID)
            : null;
          const remoteEntity = remoteScene && remoteScene.getEntityByID(shipID);
          if (remoteScene && remoteEntity) {
            this._returnWingDronesToBay(
              session,
              characterID,
              remoteEntity,
              ship,
              null,
              remoteScene,
            );
            this._deactivateWingMiningModules(
              remoteScene,
              this._buildWingModuleSession(session, characterID, remoteEntity),
              remoteEntity,
              "npc",
            );
          }
          if (command === "follow" && remoteSystemID) {
            followTransit[String(shipID)] = {
              currentSystemID: remoteSystemID,
              targetSystemID: systemID,
              nextSystemID: 0,
              readyAtMs: Date.now(),
            };
          }
        }
        continue;
      }
      if (character.launchTransit[String(shipID)]) {
        this._cancelSessionlessWingMovement(
          runtime,
          scene,
          systemID,
          characterID,
          shipID,
          "wing-command",
        );
      }
      const entity = this._ensureDeployedEntity(runtime, scene, systemID, shipID);
      this._returnWingDronesToBay(
        session,
        characterID,
        entity,
        ship,
        null,
        scene,
      );
      if (command !== "mine") {
        this._deactivateWingMiningModules(
          scene,
          this._buildWingModuleSession(session, characterID, entity),
          entity,
          "npc",
        );
      }
      localShipCount += 1;
    }
    if (command === "mine" && localShipCount !== deployedShipIDs.length) {
      throw new Error("NPC_WING_SHIP_NOT_IN_CURRENT_SYSTEM");
    }
    if (command === "mine" && localShipCount <= 0) {
      throw new Error("NPC_WING_SHIP_NOT_IN_CURRENT_SYSTEM");
    }

    for (const shipID of deployedShipIDs) {
      const ship = itemStore.findCharacterShipItem(characterID, shipID);
      if (!ship || !isShipInSystem(ship, systemID)) {
        continue;
      }
      const isCollectionShip = positive(character.collectionShipID) === shipID;
      const result = command === "follow" || command === "mine" && isCollectionShip
        ? runtime.followDynamicEntity(
            scene.sceneDescriptor || systemID,
            shipID,
            positive(leader.itemID),
            FOLLOW_RANGE_METERS,
            {broadcast: true},
          )
        : runtime.stopDynamicEntity(
            scene.sceneDescriptor || systemID,
            shipID,
            {broadcast: true},
          );
      if (result !== true) {
        throw new Error("NPC_WING_COMMAND_FAILED");
      }
      if (command === "mine") {
        if (isCollectionShip) {
          delete character.miningShipStates[String(shipID)];
        } else {
          character.miningShipStates[String(shipID)] = {
            status: "searching",
            targetID: 0,
            nextCycleAtMs: 0,
          };
        }
      }
    }

    character.recalling = false;
    this._clearDockingState(character);
    character.recallStationIDs = {};
    character.recallTransit = {};
    character.followTransit = command === "follow" ? followTransit : {};
    character.launchTransit = {};
    if (command !== "mine") {
      character.miningShipStates = {};
    }
    character.command = command;
    character.revision = positive(character.revision) + 1;
    writeState(state);
    this._ensureRuntimeTicker();
    log.info(
      `[NPCMiningWing] char=${characterID} command=${command} ` +
        `ships=${deployedShipIDs.join(",")} system=${systemID} runtime=active`,
    );
    this._sendCommandAcknowledgement(
      session,
      characterID,
      deployedShipIDs,
      command,
    );
    return this._stateResponse(characterID, session);
  }

  Handle_DeployWing(args, session) {
    const characterID = this._requireCharacter(session);
    const {runtime, scene, systemID, leader} = this._spaceContext(session);
    if (String(leader.mode || "") === "WARP") {
      throw new Error("NPC_WING_CANNOT_DEPLOY_DURING_WARP");
    }
    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    if (character.collectionTrip && character.collectionTrip.active === true) {
      throw new Error("NPC_WING_COLLECTION_TRIP_ACTIVE");
    }
    this._suppressHiveDefenseForCharacter(characterID, character);
    const markedShipIDs = [...new Set(
      character.markedShipIDs.map(positive).filter(Boolean),
    )].sort((left, right) => left - right);
    if (
      markedShipIDs.length > MAX_WING_SHIPS ||
      wingMembershipIDs(character).length > MAX_WING_SHIPS
    ) {
      throw new Error("NPC_WING_MAX_SHIPS_EXCEEDED");
    }
    if (!markedShipIDs.length) {
      throw new Error("NPC_WING_NO_MARKED_SHIPS");
    }

    const deployedShipIDs = new Set(this._deployedShipIDs(character));
    const moved = [];
    const spawned = [];
    const returnLocationUpdates = [];
    const launchingShipIDs = [];
    try {
      markedShipIDs.forEach((shipID, index) => {
        const ship = itemStore.findCharacterShipItem(characterID, shipID);
        if (!ship) {
          throw new Error("NPC_WING_SHIP_NOT_FOUND");
        }
        if (shipID === currentShipID(session)) {
          throw new Error("NPC_WING_ACTIVE_SHIP_CANNOT_JOIN_WING");
        }
        if (
          Number(ship.flagID) === 0 &&
          positive(ship.locationID) !== systemID
        ) {
          throw new Error("NPC_WING_SHIP_IN_OTHER_SYSTEM");
        }
        if (Number(ship.flagID) !== 0 && Number(ship.flagID) !== itemStore.ITEM_FLAGS.HANGAR) {
          throw new Error("NPC_WING_SHIP_NOT_IN_CHARACTER_HANGAR");
        }
        const launchStation = Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR
          ? this._validateReturnStation(positive(ship.locationID), systemID)
          : null;

        let currentShip = ship;
        if (!isShipInSystem(ship, systemID)) {
          const moveResult = itemStore.moveShipToSpace(
            shipID,
            systemID,
            buildStationLaunchSpaceState(runtime, launchStation, ship, index),
          );
          if (!moveResult || moveResult.success !== true || !moveResult.data) {
            throw new Error(
              "NPC_WING_DEPLOY_FAILED:%s".replace(
                "%s",
                String(moveResult && moveResult.errorMsg || "MOVE_FAILED"),
              ),
            );
          }
          moved.push({
            shipID,
            previousData: {
              locationID: ship.locationID,
              flagID: ship.flagID,
              spaceState: ship.spaceState || null,
            },
          });
          currentShip = moveResult.data;
          launchingShipIDs.push(shipID);
        }

        const wasAlreadyPresent = Boolean(scene.getEntityByID(shipID));
        const entity = this._ensureDeployedEntity(
          runtime,
          scene,
          systemID,
          shipID,
        );
        if (!entity || entity.kind !== "ship") {
          throw new Error("NPC_WING_SPAWN_FAILED");
        }
        if (!wasAlreadyPresent) {
          spawned.push(shipID);
        }
        deployedShipIDs.add(positive(currentShip.itemID));
        if (Number(ship.flagID) === itemStore.ITEM_FLAGS.HANGAR) {
          const returnKey = String(shipID);
          returnLocationUpdates.push({
            key: returnKey,
            previousValue: character.returnLocationIDs[returnKey],
          });
          character.returnLocationIDs[returnKey] = positive(ship.locationID);
        }
        log.info(
          `[NPCMiningWing] char=${characterID} deploy ship=${shipID} ` +
            `system=${systemID}`,
        );
        if (!currentShip.spaceState) {
          throw new Error("NPC_WING_DEPLOY_FAILED:SPACE_STATE_MISSING");
        }
      });
    } catch (error) {
      for (const shipID of spawned.reverse()) {
        scene.removeDynamicEntity(shipID, {broadcast: true});
      }
      for (const movedShip of moved.reverse()) {
        itemStore.updateShipItem(movedShip.shipID, (currentItem) => ({
          ...currentItem,
          ...movedShip.previousData,
        }));
      }
      for (const update of returnLocationUpdates.reverse()) {
        if (update.previousValue === undefined) {
          delete character.returnLocationIDs[update.key];
        } else {
          character.returnLocationIDs[update.key] = update.previousValue;
        }
      }
      throw error;
    }

    character.deployedShipIDs = [...deployedShipIDs].sort((left, right) => left - right);
    character.deployed = character.deployedShipIDs.length > 0;
    const launchTransit = {
      ...(character.launchTransit || {}),
    };
    for (const shipID of launchingShipIDs) {
      launchTransit[String(shipID)] = {
        systemID,
      };
    }
    character.launchTransit = launchTransit;
    character.recalling = false;
    this._clearDockingState(character);
    character.recallStationIDs = {};
    character.recallTransit = {};
    character.followTransit = {};
    character.miningShipStates = {};
    this._ensurePilotNames(character, [...deployedShipIDs]);
    character.command = "hold";
    character.revision = positive(character.revision) + 1;
    writeState(state);
    this._ensureRuntimeTicker();
    this._tickLaunchTransit(
      runtime,
      scene,
      characterID,
      character,
      systemID,
      leader,
    );
    log.info(
      `[NPCMiningWing] char=${characterID} deployed=${character.deployedShipIDs.join(",")} ` +
        `system=${systemID}`,
    );
    for (const shipID of character.deployedShipIDs) {
      this._sendWingChat(
        session,
        characterID,
        shipID,
        `Deployed in ${solarSystemName(systemID) || "this system"} and standing by.`,
      );
    }
    return this._stateResponse(characterID, session);
  }

  Handle_RecallWing(args, session) {
    const characterID = this._requireCharacter(session);
    const state = this._getState();
    const character = characterState(state, characterID);
    this._reconcileCharacterShipIDs(characterID, character);
    this._suppressHiveDefenseForCharacter(characterID, character);
    if (character.collectionTrip && character.collectionTrip.active === true) {
      throw new Error("NPC_WING_COLLECTION_TRIP_ACTIVE");
    }
    const deployedShipIDs = this._deployedShipIDs(character);
    if (!deployedShipIDs.length) {
      throw new Error("NPC_WING_NO_DEPLOYED_SHIPS");
    }

    const dockedStationID = dockedLocationID(session);
    if (!currentSpaceSystemID(session) && dockedStationID) {
      this._startRecall(
        session,
        characterID,
        character,
        deployedShipIDs,
        {currentSystemID: currentSystemID(session), dockedStationID},
      );
      this._ensurePilotNames(character, deployedShipIDs);
      for (const shipID of deployedShipIDs) {
        const stationName = dockableLocationName(
          this._shipTargetStationID(character, shipID),
        );
        this._sendWingChat(
          session,
          characterID,
          shipID,
          `Recall order accepted. Returning to ${stationName || "the saved station"}.`,
        );
      }
      return this._stateResponse(characterID, session);
    }

    const {leader} = this._spaceContext(session);
    if (String(leader.mode || "") === "WARP") {
      throw new Error("NPC_WING_CANNOT_RECALL_DURING_WARP");
    }
    this._startRecall(
      session,
      characterID,
      character,
      deployedShipIDs,
      {currentSystemID: currentSystemID(session)},
    );
    this._ensurePilotNames(character, deployedShipIDs);
    for (const shipID of deployedShipIDs) {
      const stationName = dockableLocationName(
        this._shipTargetStationID(character, shipID),
      );
      this._sendWingChat(
        session,
        characterID,
        shipID,
        `Recall order accepted. Returning to ${stationName || "the saved station"}.`,
      );
    }
    return this._stateResponse(characterID, session);
  }

  Handle_TransferCargo(args, session) {
    const characterID = this._requireCharacter(session);
    const request = requestObject(args);
    const state = this._getState();
    const character = characterState(state, characterID);
    const deployedShipIDs = this._deployedShipIDs(character);
    if (!deployedShipIDs.length) {
      throw new Error("NPC_WING_NO_DEPLOYED_SHIPS");
    }
    const requestedShipID = positive(request.shipID);
    const shipIDs = requestedShipID ? [requestedShipID] : deployedShipIDs;
    const activeShipID = currentShipID(session);
    if (!activeShipID) {
      throw new Error("NPC_WING_ACTIVE_SHIP_NOT_FOUND");
    }
    const moved = [];
    const failed = [];
    for (const shipID of shipIDs) {
      if (!deployedShipIDs.includes(shipID)) {
        failed.push({shipID, error: "NPC_WING_SHIP_NOT_DEPLOYED"});
        this._sendWingChat(
          session,
          characterID,
          shipID,
          `Cargo transfer failed: ${friendlyErrorMessage("NPC_WING_SHIP_NOT_DEPLOYED")}`,
        );
        continue;
      }
      let transfer;
      try {
        transfer = this._transferCargoForShip(
          session,
          characterID,
          shipID,
          activeShipID,
        );
      } catch (error) {
        failed.push({shipID, error: error.message});
        this._sendWingChat(
          session,
          characterID,
          shipID,
          `Cargo transfer failed: ${friendlyErrorMessage(error)}`,
        );
        continue;
      }
      moved.push(...transfer.moved);
      failed.push(...transfer.failed);
      log.info(
        `[NPCMiningWing] char=${characterID} cargo-collect ship=${shipID} ` +
          `activeShip=${activeShipID} moved=${moved.length}`,
      );
      const shipFailures = failed.filter((entry) => entry.shipID === shipID);
      const shipMoves = moved.filter((entry) => entry.shipID === shipID);
      if (shipMoves.length > 0) {
        const holds = [...new Set(shipMoves.map((entry) => entry.destinationHold))];
        this._sendWingChat(
          session,
          characterID,
          shipID,
          `Cargo transfer complete. Moved ${shipMoves.length} item stack(s) to ${holds.join(" and ")}.`,
        );
      }
      if (shipFailures.length > 0) {
        const reasons = [...new Set(
          shipFailures.map((entry) => friendlyErrorMessage(entry.error)),
        )];
        this._sendWingChat(
          session,
          characterID,
          shipID,
          `Cargo transfer incomplete: ${reasons.join(" ")}`,
        );
      }
    }
    return this._stateResponse(characterID, session, {
      cargoTransfer: {
        activeShipID,
        moved,
        failed,
      },
    });
  }

  Handle_GetShipCargo(args, session) {
    const characterID = this._requireCharacter(session);
    const request = requestObject(args);
    const shipID = positive(request.shipID);
    if (!shipID) {
      throw new Error("NPC_WING_SHIP_REQUIRED");
    }
    const state = this._getState();
    const character = characterState(state, characterID);
    if (!this._deployedShipIDs(character).includes(shipID)) {
      throw new Error("NPC_WING_SHIP_NOT_DEPLOYED");
    }
    this._cargoContext(session, characterID, shipID);
    const cargo = cargoItemsForShip(characterID, shipID)
      .map((item) => this._serializeCargoItem(item));
    return this._stateResponse(characterID, session, {
      cargoShipID: shipID,
      cargo,
    });
  }
}

module.exports = NpcMiningWingService;
