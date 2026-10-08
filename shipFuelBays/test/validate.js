"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);

for (const file of [
  ".gitignore",
  "LICENSE",
  "README.md",
  "evejs-launcher.mod.json",
  "loader.js",
  "config/fuel-bays.json",
  "lib/config.js",
  "lib/shipFuelBaysService.js",
]) {
  assert.equal(fs.existsSync(path.join(modRoot, file)), true, "missing " + file);
}

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "shipfuelbays");
assert.equal(manifest.displayName, "Ship Fuel Bays");
assert.equal(manifest.version, "0.1.2");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const {DEFAULT_CONFIG, normalizeConfig} = require("../lib/config");
assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
assert.equal(normalizeConfig({
  enabled: false,
  capacityMode: "unexpected",
  minimumCapacityM3: -10,
}).enabled, false);
assert.equal(normalizeConfig({
  capacityMode: "unexpected",
}).capacityMode, "baseCargo");
assert.equal(normalizeConfig({
  minimumCapacityM3: "not-a-number",
}).minimumCapacityM3, DEFAULT_CONFIG.minimumCapacityM3);

const {
  FUEL_BAY_ATTRIBUTE_ID,
  SHIP_CATEGORY_ID,
  ShipFuelBaysService,
} = require("../lib/shipFuelBaysService");

const service = new ShipFuelBaysService(DEFAULT_CONFIG);
const merlin = {typeID: 603, categoryID: SHIP_CATEGORY_ID, name: "Merlin"};
const merlinInfo = service.getFuelBayInfo(merlin);
assert.equal(merlinInfo.nativeCapacity, 0);
assert.equal(merlinInfo.baseCargoCapacity, 150);
assert.equal(merlinInfo.added, true);

const merlinState = {
  attributes: {},
};
service.decorateResourceState(merlinState, merlin);
assert.equal(merlinState.specialFuelBayCapacity, 150);
assert.equal(merlinState.attributes[FUEL_BAY_ATTRIBUTE_ID], 150);

const orca = {typeID: 28606, categoryID: SHIP_CATEGORY_ID, name: "Orca"};
const orcaInfo = service.getFuelBayInfo(orca);
assert.equal(orcaInfo.nativeCapacity, 6400);
assert.equal(orcaInfo.added, false);
const orcaState = {
  attributes: {"1549": 6400},
  specialFuelBayCapacity: 6400,
};
service.decorateResourceState(orcaState, orca);
assert.equal(orcaState.specialFuelBayCapacity, 6400);

const mineralState = {attributes: {}};
service.decorateResourceState(mineralState, {typeID: 34, categoryID: 4});
assert.equal(mineralState.attributes[FUEL_BAY_ATTRIBUTE_ID], undefined);

const disabledService = new ShipFuelBaysService(
  normalizeConfig({enabled: false}),
);
const disabledState = {attributes: {}};
disabledService.decorateResourceState(disabledState, merlin);
assert.equal(disabledState.attributes[FUEL_BAY_ATTRIBUTE_ID], undefined);

const loader = require("../loader");
const fakeLiveModule = {
  buildShipResourceState(_characterID, shipItem) {
    return {attributes: {}, shipItem};
  },
};
loader._testing.wrapLiveFittingState(fakeLiveModule);
const wrappedState = fakeLiveModule.buildShipResourceState(1, merlin);
assert.equal(wrappedState.attributes[FUEL_BAY_ATTRIBUTE_ID], 150);

const fakeFittingModule = {
  getShipFittingSnapshot() {
    return {
      shipItem: merlin,
      resourceState: {attributes: {}},
      shipAttributes: {},
      trackedShipAttributes: {},
    };
  },
};
loader._testing.wrapFittingRuntime(fakeFittingModule);
const wrappedSnapshot = fakeFittingModule.getShipFittingSnapshot(1, 2);
assert.equal(wrappedSnapshot.shipAttributes[FUEL_BAY_ATTRIBUTE_ID], 150);

class FakeDogmaService {
  _buildShipAttributes(_character, shipItem) {
    return {mass: 100};
  }

  _buildShipBaseAttributes(shipItem) {
    return {mass: 100};
  }

  _buildInventoryItemAttributes(shipItem) {
    return {mass: 100};
  }

  _buildShipAttributeDict(_character, shipItem) {
    return {type: "dict", entries: [[4, 100]]};
  }
}
loader._testing.wrapDogmaService(FakeDogmaService);
const fakeDogma = new FakeDogmaService();
const dogmaAttributes = fakeDogma._buildShipAttributes(1, merlin);
assert.equal(dogmaAttributes[FUEL_BAY_ATTRIBUTE_ID], 150);
assert.equal(
  fakeDogma._buildShipBaseAttributes(merlin)[FUEL_BAY_ATTRIBUTE_ID],
  150,
);
assert.equal(
  fakeDogma._buildInventoryItemAttributes(merlin)[FUEL_BAY_ATTRIBUTE_ID],
  150,
);
assert.deepEqual(
  fakeDogma._buildShipAttributeDict(1, merlin).entries.find(
    (entry) => Number(entry[0]) === FUEL_BAY_ATTRIBUTE_ID,
  ),
  [FUEL_BAY_ATTRIBUTE_ID, 150],
);

const nativeAttributeDict = fakeDogma._buildShipAttributeDict(1, orca);
assert.equal(
  nativeAttributeDict.entries.some(
    (entry) => Number(entry[0]) === FUEL_BAY_ATTRIBUTE_ID,
  ),
  false,
);

const snapshot = {
  shipItem: merlin,
  resourceState: {attributes: {}},
  shipAttributes: {},
  trackedShipAttributes: {},
};
service.decorateFittingSnapshot(snapshot);
assert.equal(snapshot.shipAttributes[FUEL_BAY_ATTRIBUTE_ID], 150);
assert.equal(snapshot.trackedShipAttributes[FUEL_BAY_ATTRIBUTE_ID], 150);

console.log("shipFuelBays validation passed");
