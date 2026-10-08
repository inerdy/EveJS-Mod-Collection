"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"));
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const {normalizeState} = require(path.join(modRoot, "lib", "state"));
const ServiceModule = require(path.join(modRoot, "lib", "shipWarpFuelService"));
const testing = ServiceModule._testing;

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "shipwarpfuel");
assert.equal(manifest.version, "0.2.0");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.deepEqual(manifest.clientMenu, {apiVersion: 1, entrypoint: "client/menu.py"});

const config = normalizeConfig({});
assert.equal(config.enabled, true);
assert.equal(config.fuelTypeID, 17887);
assert.deepEqual(config.fuelTypes.map((entry) => entry.typeID), [17889, 16274, 17888, 17887]);
assert.equal(config.fuelTypes.find((entry) => entry.typeID === 17889).burnMultiplier, 0.75);
assert.equal(config.fuelTypes.find((entry) => entry.typeID === 16274).burnMultiplier, 0.9);
assert.equal(config.fuelTypes.find((entry) => entry.typeID === 17888).burnMultiplier, 1.05);
assert.equal(config.fuelTypes.find((entry) => entry.typeID === 17887).burnMultiplier, 1.25);
assert.equal(config.fuelCapacityUnits, 1000);
assert.equal(config.fuelUnitsPerAU, 1);
assert.equal(config.fuelUnitsPerAUByClass.frigate, 0.5);
assert.equal(config.fuelUnitsPerAUByClass.corvette, 0.5);
assert.equal(config.fuelUnitsPerAUByClass.destroyer, 0.75);
assert.equal(config.fuelUnitsPerAUByClass.cruiser, 1.25);
assert.equal(config.fuelUnitsPerAUByClass.battlecruiser, 1.5);
assert.equal(config.fuelUnitsPerAUByClass.battleship, 2);
assert.equal(config.fuelUnitsPerAUByClass.industrialTransport, 2.5);
assert.equal(config.fuelUnitsPerAUByClass.capitalFreighter, 4);
assert.equal(config.minimumWarpFuel, 1);
assert.equal(config.emergencyFuelUnits, 25);
assert.equal(config.emergencyFeeISK, 1000000);
assert.equal(config.emergencyCooldownSeconds, 900);
assert.equal(config.serviceShipTypeID, 648);
assert.equal(config.serviceShipSpawnDistanceAU, 1);
assert.equal(config.serviceShipApproachRangeMeters, 5000);
assert.equal(config.serviceShipApproachTimeoutMs, 30000);
assert.equal(config.serviceShipDepartureDelayMs, 5000);
assert.equal(config.serviceShipLifetimeMs, 120000);
assert.equal(config.waypointEstimateEnabled, true);
assert.equal(config.estimatedWarpAUPerGateJump, 50);

assert.equal(testing.AU_METERS, 149597870700);
assert.equal(testing.distanceMeters({x: 0, y: 0, z: 0}, {x: 3, y: 4, z: 0}), 5);
assert.equal(testing.distanceMeters(null, {x: 1, y: 2, z: 3}), 0);
assert.equal(testing.quantityOf({singleton: 1}), 1);
assert.equal(testing.quantityOf({singleton: 0, quantity: 25}), 25);
assert.equal(testing.isInSpaceSession({characterID: 42, _space: {shipID: 900, systemID: 30000002}}), true);
assert.equal(testing.isInSpaceSession({characterID: 42, stationid: 60003760}), false);
assert.equal(testing.classifyShip({groupName: "Frigate"}), "frigate");
assert.equal(testing.classifyShip({groupName: "Corvette"}), "corvette");
assert.equal(testing.classifyShip({groupName: "Shuttle"}), "shuttle");
assert.equal(testing.classifyShip({groupName: "Destroyer"}), "destroyer");
assert.equal(testing.classifyShip({groupName: "Cruiser"}), "cruiser");
assert.equal(testing.classifyShip({groupName: "Battlecruiser"}), "battlecruiser");
assert.equal(testing.classifyShip({groupName: "Battleship"}), "battleship");
assert.equal(testing.classifyShip({groupName: "Industrial"}), "industrialTransport");
assert.equal(testing.classifyShip({groupName: "Freighter"}), "capitalFreighter");
assert.equal(testing.classifyShip({groupName: "Something Unknown"}), "fallback");
assert.equal(normalizeConfig({fuelUnitsPerAU: 2}).fuelUnitsPerAUByClass.fallback, 2);

const state = normalizeState({
  nextEmergencyID: 3,
  nextWarpID: 7,
  nextInventoryMoveID: 11,
  characters: {"42": {debtISK: 12.5, cooldownUntilMs: 1000}},
  ships: {"99": {characterID: 42, totalWarpAU: 5.5, warpCount: 2}},
});
assert.equal(state.nextEmergencyID, 3);
assert.equal(state.nextWarpID, 7);
assert.equal(state.nextInventoryMoveID, 11);
assert.equal(state.characters["42"].debtISK, 12.5);
assert.equal(state.ships["99"].totalWarpAU, 5.5);

const fuelRows = new Map([[700, {
  itemID: 700,
  typeID: 17887,
  ownerID: 42,
  locationID: 900,
  flagID: 133,
  singleton: 0,
  quantity: 10,
  stacksize: 10,
}]]);
const cargoRows = new Map([[701, {
  itemID: 701,
  typeID: 17887,
  ownerID: 42,
  locationID: 900,
  flagID: 5,
  singleton: 0,
  quantity: 12,
  stacksize: 12,
}]]);
const fakeItemStore = {
  ITEM_FLAGS: {FUEL_BAY: 133, CARGO_HOLD: 5},
  getActiveShipItem: () => ({itemID: 900, name: "Test Ship", typeID: 9001, groupName: "Destroyer"}),
  findCharacterShipItem: () => ({itemID: 900, name: "Test Ship", typeID: 9001, groupName: "Destroyer"}),
  findShipItemById: () => ({itemID: 900, name: "Test Ship", typeID: 9001, groupName: "Destroyer"}),
  listContainerItems: (_ownerID, shipID, flagID) => {
    if (shipID !== 900) return [];
    if (flagID === 133) return [...fuelRows.values()];
    if (flagID === 5) return [...cargoRows.values()];
    return [];
  },
  consumeInventoryItemStacksAtomic: (requests) => {
    const row = fuelRows.get(requests[0].itemID);
    const previousData = {...row};
    row.quantity -= requests[0].quantity;
    row.stacksize = row.quantity;
    return {
      success: true,
      changes: [{
        removed: false,
        previousData,
        item: {...row},
      }],
    };
  },
  restoreInventoryItemChangesAtomic: (changes) => {
    const row = fuelRows.get(changes[0].item.itemID);
    Object.assign(row, changes[0].previousData);
    return {success: true};
  },
  moveItemToLocationIdempotent: (itemID, _destinationLocationID, destinationFlagID, quantity) => {
    if (
      !((itemID === 701 && destinationFlagID === 133) ||
        (itemID === 700 && destinationFlagID === 5))
    ) return {success: false, errorMsg: "TEST_MOVE_FAILED"};
    const source = itemID === 701 ? cargoRows.get(701) : fuelRows.get(700);
    const destination = itemID === 701 ? fuelRows.get(700) : cargoRows.get(701);
    const previousData = {...source};
    source.quantity -= quantity;
    source.stacksize = source.quantity;
    destination.quantity += quantity;
    destination.stacksize = destination.quantity;
    return {
      success: true,
      data: {
        changes: [{
          previousData,
          item: {...source, flagID: destinationFlagID},
        }],
      },
    };
  },
  getItemMetadata: () => ({volume: 0.03}),
};
const fakeStateStore = {
  filePath: "test-state.json",
  load: () => normalizeState({}),
  save: (value) => normalizeState(value),
};
const inventoryNotifications = [];
const fakeDependencies = {
  itemStore: fakeItemStore,
  spaceRuntime: {
    getSceneForSession: () => ({
      getShipEntityForSession: () => ({position: {x: 0, y: 0, z: 0}}),
      getEntityByID: () => ({position: {x: testing.AU_METERS * 2, y: 0, z: 0}}),
    }),
  },
  chatHub: {sendSystemMessage: () => {}},
  sessionRegistry: {findSessionByCharacterID: () => null},
  characterState: {
    emitItemsChangedBatchForSession: (_session, changes) => {
      inventoryNotifications.push(changes);
      return true;
    },
  },
};
const fuelService = new ServiceModule({
  config: normalizeConfig({serviceShipDelayMs: 0}),
  stateStore: fakeStateStore,
  dependencies: fakeDependencies,
  autoStart: false,
});
const session = {characterID: 42, _space: {shipID: 900, systemID: 30000002}};
const warpPlan = fuelService.prepareWarp(session, "entity", 123);
assert.equal(warpPlan.blocked, undefined);
assert.equal(warpPlan.shipClass, "destroyer");
assert.equal(warpPlan.fuelTypeID, 17887);
assert.equal(warpPlan.fuelName, "Oxygen Isotopes");
assert.equal(warpPlan.fuelMultiplier, 1.25);
assert.equal(warpPlan.fuelUnitsPerAU, 0.9375);
assert.equal(warpPlan.fuelUnits, 2);
assert.equal(fuelRows.get(700).quantity, 8);

const bayState = fuelService._fuelBayState(42, session);
assert.equal(bayState.fuelUnits, 8);
assert.equal(bayState.fuelCapacityUnits, 1000);
assert.equal(bayState.fuelBayItems[0].typeID, 17887);
const loadResult = JSON.parse(fuelService.Handle_LoadFuel([{quantity: 5}], session));
assert.equal(loadResult.moved, 5);
assert.equal(fuelRows.get(700).quantity, 13);
assert.equal(cargoRows.get(701).quantity, 7);
assert.equal(inventoryNotifications.length, 1);
assert.equal(inventoryNotifications[0][0].item.flagID, 133);
fuelService.finishWarp(warpPlan, {success: true});
assert.equal(fuelService._state.ships["900"].totalWarpAU, 2);
const failedPlan = fuelService.prepareWarp(session, "entity", 123);
assert.equal(fuelRows.get(700).quantity, 11);
fuelService.finishWarp(failedPlan, {success: false, errorMsg: "TEST_REJECT"});
assert.equal(fuelRows.get(700).quantity, 13);
const unloadResult = JSON.parse(fuelService.Handle_UnloadFuel([{quantity: 5}], session));
assert.equal(unloadResult.moved, 5);
assert.equal(fuelRows.get(700).quantity, 8);
assert.equal(cargoRows.get(701).quantity, 12);
assert.equal(inventoryNotifications.length, 2);
assert.equal(inventoryNotifications[1][0].item.flagID, 5);
const estimate = JSON.parse(fuelService.Handle_GetWaypointFuelEstimate([{hasRoute: true, jumps: 4}], session));
assert.equal(estimate.hasRoute, true);
assert.equal(estimate.jumps, 4);
assert.equal(estimate.estimatedWarpAU, 200);
assert.equal(estimate.fuelTypeID, 17887);
assert.equal(estimate.fuelRequired, 188);
const switched = JSON.parse(fuelService.Handle_SetFuelType([{fuelTypeID: 17889}], session));
assert.equal(switched.fuelTypeID, 17889);
assert.equal(switched.fuelName, "Hydrogen Isotopes");
const switchedEstimate = JSON.parse(fuelService.Handle_GetWaypointFuelEstimate([{hasRoute: true, jumps: 1}], session));
assert.equal(switchedEstimate.fuelRequired, 29);
JSON.parse(fuelService.Handle_SetFuelType([{fuelTypeID: 17887}], session));
const dockedSession = {characterID: 42, stationid: 60003760};
const dockedSwitch = JSON.parse(fuelService.Handle_SetFuelType([{fuelTypeID: 17889}], dockedSession));
assert.equal(dockedSwitch.fuelTypeID, 17889);
JSON.parse(fuelService.Handle_SetFuelType([{fuelTypeID: 17887}], session));

const loader = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
assert.match(loader, /serviceManager\.js/u);
assert.match(loader, /warpToEntity/u);
assert.match(loader, /warpToPoint/u);
assert.match(loader, /fittingRuntime\.js/u);
assert.match(loader, /attachSession/u);

const client = fs.readFileSync(path.join(modRoot, "client", "menu.py"), "utf8");
assert.match(client, /Ship Warp Fuel/u);
assert.match(client, /GetFuelBayState/u);
assert.match(client, /LoadFuel/u);
assert.match(client, /RequestEmergencyFuel/u);
assert.match(client, /GetWaypointFuelEstimate/u);
assert.match(client, /SetFuelType/u);
assert.match(client, /Waypoint estimate:/u);
assert.match(client, /Switch Fuel:/u);
assert.match(client, /GetAutopilotRoute/u);
assert.match(client, /inSpace/u);
assert.match(client, /ScrollContainer/u);
assert.match(client, /parent=self\._body/u);
assert.match(client, /mods\.register/u);
assert.equal(client.includes('Cargo Oxygen:'), false);
assert.equal(client.includes('Contents:'), false);
assert.ok(client.indexOf('self._odometer =') < client.indexOf('self._load_button ='));
assert.match(client, /UI_HIDDEN/u);
assert.match(client, /self\._details\.state = uiconst\.UI_NORMAL if fuel <= 0 and in_space else uiconst\.UI_HIDDEN/u);
assert.match(client, /_emergency_request_pending/u);
assert.match(client, /Emergency fuel ship: on the way/u);
assert.match(client, /UI_DISABLED/u);

const service = fs.readFileSync(path.join(modRoot, "lib", "shipWarpFuelService.js"), "utf8");
assert.match(service, /startSessionlessWarpIngress/u);
assert.match(service, /followShipEntity/u);
assert.match(service, /serviceShipSpawnDistanceAU/u);
assert.match(service, /_sendServiceShipAway/u);
assert.match(service, /Emergency fuel ship is on the way/u);
assert.match(service, /Handle_GetWaypointFuelEstimate/u);
assert.match(service, /Handle_SetFuelType/u);
assert.match(service, /EMERGENCY_FUEL_REQUIRES_SPACE/u);
assert.match(service, /isInSpaceSession/u);

const packageFiles = [];
function collect(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name === ".git") continue;
    const entryPath = path.join(directory, entry.name);
    const entryPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(entryPath, entryPrefix);
    else packageFiles.push(entryPrefix.replace(/\\/g, "/"));
  }
}
collect(modRoot);
assert.deepEqual(packageFiles.sort(), [
  "README.md",
  "client/menu.py",
  "config/fuel.json",
  "evejs-launcher.mod.json",
  "lib/config.js",
  "lib/shipWarpFuelService.js",
  "lib/state.js",
  "loader.js",
  "test/validate.js",
]);

console.log("Ship Warp Fuel manifest, configuration, state, loader, UI, and package checks passed.");
