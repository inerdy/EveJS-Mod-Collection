"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const {createStateStore, normalizeState} = require(path.join(modRoot, "lib", "state"));

const config = normalizeConfig({
  enabled: true,
  apparelCategoryID: 30,
  apparelGroupIDs: [1083, 1083, "1089", 0],
});
assert.deepEqual(config.apparelGroupIDs, [1083, 1089]);
assert.equal(config.apparelCategoryID, 30);

const normalized = normalizeState({
  characters: {
    "42": {
      unlockedByTypeID: {
        "2001": {activatedAt: 123, sourceItemID: 9001},
        invalid: {activatedAt: 999},
      },
    },
    invalid: {unlockedByTypeID: {"2002": {}}},
  },
});
assert.deepEqual(normalized.characters["42"].unlockedByTypeID["2001"], {
  activatedAt: 123,
  sourceItemID: 9001,
});
assert.equal(normalized.characters["42"].legacyMigratedAt, 0);
assert.equal(normalized.characters.invalid, undefined);

const tempFile = path.join(modRoot, `.test-state-${process.pid}.json`);
try {
  const store = createStateStore(tempFile);
  const state = store.load();
  state.characters["42"] = normalized.characters["42"];
  store.save(state);
  assert.deepEqual(store.load().characters["42"], normalized.characters["42"]);
} finally {
  try { fs.unlinkSync(tempFile); } catch (_error) { /* already absent */ }
}

const loader = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
assert.match(loader, /apparelCosmeticsService/);
assert.match(loader, /paperDollServerService\.js/);
assert.match(loader, /charService\.js/);
assert.match(loader, /apparel activate/);

const serviceItem = {
  itemID: 9001,
  typeID: 2001,
  ownerID: 42,
  categoryID: 30,
  groupID: 1083,
  quantity: 1,
  singleton: 1,
  locationID: 60003760,
  flagID: 4,
};
const notifications = [];
let consumedItemID = 0;
let physicalItems = [serviceItem];
const fakeItemStore = {
  getItemMetadata(typeID) {
    return [2001, 2002].includes(Number(typeID))
      ? {typeID: Number(typeID), name: Number(typeID) === 2001 ? "Test Jacket" : "Test Apparel 2002", categoryID: 30, groupID: 1083}
      : {typeID: Number(typeID), name: "Other Item", categoryID: 1, groupID: 1};
  },
  listCharacterItems() { return physicalItems; },
  grantItemToCharacterStationHangar(_characterID, stationID, typeID) {
    physicalItems.push({itemID: 9002, typeID, ownerID: 42, locationID: stationID, flagID: 4});
    return {success: true, data: {items: physicalItems.slice(-1)}};
  },
  findItemById(itemID) { return Number(itemID) === serviceItem.itemID ? {...serviceItem} : null; },
  consumeInventoryItemQuantity(itemID) {
    consumedItemID = Number(itemID);
    return {success: true, data: {changes: [{item: null, previousData: serviceItem}]}};
  },
};
const fakeCharacterState = {
  legacyAppearance: null,
  getCharacterRecord() { return {appearanceInfo: this.legacyAppearance, stationID: 60003760}; },
  emitItemsChangedBatchForSession(_session, changes) { notifications.push(changes); },
};
const fakeChatHub = {
  sendSystemMessage(_session, message) { notifications.push(message); },
};
const fakeSessionIdentity = {resolveSessionCharacterID: () => 42};
const fakeDataRoot = {resolveDataRootPath: (...parts) => path.join(modRoot, ...parts)};
const originalLoad = Module._load;
Module._load = function loadForApparelTest(request, parent, isMain) {
  const normalized = String(request).replaceAll("\\", "/");
  if (normalized.endsWith("/services/baseService") || normalized.endsWith("/services/baseService.js")) {
    return class BaseService { constructor(name) { this._name = name; } get name() { return this._name; } };
  }
  if (normalized.endsWith("/services/inventory/itemStore") || normalized.endsWith("/services/inventory/itemStore.js")) return fakeItemStore;
  if (normalized.endsWith("/services/character/characterState") || normalized.endsWith("/services/character/characterState.js")) return fakeCharacterState;
  if (normalized.endsWith("/services/chat/chatHub") || normalized.endsWith("/services/chat/chatHub.js")) return fakeChatHub;
  if (normalized.endsWith("/services/_shared/sessionIdentity") || normalized.endsWith("/services/_shared/sessionIdentity.js")) return fakeSessionIdentity;
  if (normalized.endsWith("/config/dataRoot") || normalized.endsWith("/config/dataRoot.js")) return fakeDataRoot;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const ApparelCosmeticsService = require(path.join(modRoot, "lib", "apparelCosmeticsService"));
  const savedStates = [];
  const service = new ApparelCosmeticsService({
    config,
    stateStore: {
      load: () => ({schemaVersion: 1, characters: {}}),
      save: (value) => savedStates.push(JSON.parse(JSON.stringify(value))),
    },
  });
  const session = {characterID: 42};

  assert.equal(service.isEligibleType(2001), true);
  assert.deepEqual(service.validateAppearance(42, {clothing: {typeID: 2001}}), [2001]);
  assert.match(service.listCommand(session), /9001: Test Jacket/);
  const activation = service.activateCommand(session, "9001");
  assert.equal(activation.success, true);
  assert.equal(consumedItemID, 9001);
  assert.equal(service.isUnlocked(42, 2001), true);
  assert.deepEqual(service.validateAppearance(42, {clothing: {typeID: 2001}}), []);
  assert.equal(savedStates.length, 2);
  assert.equal(notifications.length >= 2, true);

  fakeCharacterState.legacyAppearance = {clothing: {typeID: 2001}};
  const legacySaves = [];
  const legacyService = new ApparelCosmeticsService({
    config,
    stateStore: {
      load: () => ({schemaVersion: 1, characters: {}}),
      save: (value) => legacySaves.push(JSON.parse(JSON.stringify(value))),
    },
  });
  assert.deepEqual(legacyService.validateAppearance(42, {clothing: {typeID: 2001}}), []);
  assert.equal(legacyService.isUnlocked(42, 2001), true);
  assert.equal(legacySaves.length, 1);
  assert.equal(legacySaves[0].characters["42"].legacyMigratedAt > 0, true);
  fakeCharacterState.legacyAppearance = {clothing: {typeID: 2002}};
  legacyService.migrateLegacyAppearance(42);
  assert.equal(legacyService.isUnlocked(42, 2002), false);
  fakeCharacterState.legacyAppearance = {clothing: {typeID: 2001}};
  physicalItems = [];
  assert.deepEqual(legacyService.repairSavedAppearance(42), [2001]);
  assert.equal(physicalItems.length, 1);
  assert.deepEqual(legacyService.repairSavedAppearance(42), []);
} finally {
  Module._load = originalLoad;
}

const loaderBase = Module._load;
const fakeLoaderService = {
  validateAppearance(_charID, payload) { return payload && payload.blocked ? [2001] : []; },
  listCommand() { return "listed"; },
  activateCommand() { return {success: true, message: "activated"}; },
};
class FakeServiceManager {
  constructor() { this.services = new Map(); }
  lookup(name) { return this.services.get(name) || null; }
  register(service) { this.services.set(service.name, service); }
}
class FakePaperDoll {
  Handle_GetPaperDollData() { return "data"; }
  Handle_GetMyPaperDollData() { return "my-data"; }
  Handle_UpdateExistingCharacterFull() { return "full"; }
  Handle_UpdateExistingCharacterLimited() { return "limited"; }
}
class FakeCharService {
  Handle_CreateCharacterWithDoll() { return "created"; }
}
const fakeChatCommands = {
  executeChatCommand() { return {handled: false}; },
  AVAILABLE_SLASH_COMMANDS: [],
  COMMANDS_HELP_TEXT: "Commands",
};
Module._load = function loadLoaderFixtures(request, parent, isMain) {
  const normalized = String(request).replaceAll("\\", "/");
  if (normalized.endsWith("/services/serviceManager.js")) return FakeServiceManager;
  if (normalized.endsWith("/services/chat/chatCommands.js")) return fakeChatCommands;
  if (normalized.endsWith("/services/character/paperDollServerService.js")) return FakePaperDoll;
  if (normalized.endsWith("/services/character/charService.js")) return FakeCharService;
  if (normalized.endsWith("/apparelCosmeticsService")) return class ApparelServiceFixture {
    constructor() { this.name = "apparelCosmetics"; }
    repairSavedAppearance() { return []; }
    validateAppearance(...args) { return fakeLoaderService.validateAppearance(...args); }
    listCommand(...args) { return fakeLoaderService.listCommand(...args); }
    activateCommand(...args) { return fakeLoaderService.activateCommand(...args); }
  };
  return loaderBase.call(this, request, parent, isMain);
};
try {
  require(path.join(modRoot, "loader.js"));
  const evejsRoot = path.resolve(modRoot, "..", "..", "EveJS-261028.1");
  const serviceManager = new (require(path.join(evejsRoot, "server", "src", "services", "serviceManager.js")))();
  assert.ok(serviceManager.lookup("apparelCosmetics"));

  const commands = require(path.join(evejsRoot, "server", "src", "services", "chat", "chatCommands.js"));
  const chatMessages = [];
  const chatHubFixture = {sendSystemMessage(_session, message) { chatMessages.push(message); }};
  const commandResult = commands.executeChatCommand(
    {characterID: 42},
    "/apparel activate 9001",
    chatHubFixture,
    {serviceManager},
  );
  assert.equal(commandResult.handled, true);
  assert.equal(commandResult.message, "activated");
  assert.deepEqual(chatMessages, ["activated"]);

  const PaperDoll = require(path.join(evejsRoot, "server", "src", "services", "character", "paperDollServerService.js"));
  const paperDoll = new PaperDoll();
  assert.equal(paperDoll.Handle_GetPaperDollData([42]), "data");
  assert.equal(paperDoll.Handle_GetMyPaperDollData([], {characterID: 42}), "my-data");
  assert.equal(paperDoll.Handle_UpdateExistingCharacterFull([42, {blocked: true}]), null);
  assert.equal(paperDoll.Handle_UpdateExistingCharacterFull([42, {blocked: false}]), "full");
} finally {
  Module._load = loaderBase;
}

console.log("Apparel Cosmetics validation passed.");
