"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const state = require(path.join(__dirname, "..", "lib", "state"));
const loader = require(path.join(__dirname, "..", "loader"));

const modRoot = path.resolve(__dirname, "..");
const loaderSource = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
const serviceSource = fs.readFileSync(
  path.join(modRoot, "lib", "autoShopRepairService.js"),
  "utf8",
);
const clientSource = fs.readFileSync(
  path.join(modRoot, "client", "menu.py"),
  "utf8",
);

assert.equal(loader.id, "autoshoprepair");
assert.equal(loader.active, true);
assert.equal(state.normalizeCharacterState({}).enabled, true);
assert.equal(state.normalizeCharacterState({enabled: false}).enabled, false);
assert.deepEqual(state.normalizeState({characters: {"42": {enabled: false}}}), {
  schemaVersion: 1,
  characters: {"42": {enabled: false}},
});
assert.match(loaderSource, /onDocked\(args\[0\], args\[1\]\)/u);
assert.match(serviceSource, /getActiveShipItem\(characterID\)/u);
assert.match(
  serviceSource,
  /_repairAfterDocking\(\s*session,\s*characterID,\s*normalizedStationID,?\s*\)/u,
);
assert.match(clientSource, /ScrollContainer/u);
assert.match(clientSource, /Container/u);
assert.match(serviceSource, /sendSystemMessage/u);
assert.doesNotMatch(serviceSource, /OnRemoteMessage/u);
console.log("autoShopRepair validation passed");
