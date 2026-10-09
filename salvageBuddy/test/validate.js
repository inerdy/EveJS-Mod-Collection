"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "evejs-launcher.mod.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root, "config", "salvageBuddy.json"), "utf8"));
const normalized = require(path.join(root, "lib", "config")).normalizeConfig(config);

assert.equal(manifest.id, "salvagebuddy");
assert.equal(manifest.version, "0.2.6");
assert.equal(manifest.clientMenu.entrypoint, "client/menu.py");
assert.equal(normalized.serviceFeeISK, 120000);
assert.equal(normalized.cooldownSeconds, 300);
assert.equal(normalized.approachTimeoutMs, 180000);
assert.equal(normalized.noctisTypeID, 2998);
assert.equal(normalized.afterburnerTypeID, 12058);
assert.equal(normalized.tractorBeamTypeID, 24622);
assert.equal(normalized.salvagerTypeID, 30836);
assert.equal(normalized.salvageDroneTypeID, 55760);
assert.equal(normalized.tractorBeamCount + normalized.salvagerCount, 8);
assert.equal(normalized.salvageDroneCount, 5);

const service = fs.readFileSync(path.join(root, "lib", "salvageBuddyService.js"), "utf8");
const menu = fs.readFileSync(path.join(root, "client", "menu.py"), "utf8");
assert.match(service, /startSessionlessWarpIngress/u);
assert.match(service, /followShipEntity/u);
assert.match(service, /approachRangeMeters \* 2/u);
assert.match(service, /stopDistance: Math\.max\(rangeMeters/u);
assert.match(service, /approachRangeMeters \+ 500/u);
assert.match(service, /allowSessionlessWarpAbort/u);
assert.match(service, /destroyDynamicInventoryEntity/u);
assert.match(service, /findSceneContainingDynamicEntity/u);
assert.match(service, /request\.serviceShip = null/u);
assert.match(service, /executeSalvagerCycle/u);
assert.match(service, /resolveTractorBeamActivation/u);
assert.match(service, /activatePropulsionModule/u);
assert.match(service, /_deployServiceDrones/u);
assert.match(service, /DRONE_COMMAND_SALVAGE/u);
assert.match(service, /_positionForTractor/u);
assert.match(service, /DRONE_LAUNCH/u);
assert.match(service, /adjustCharacterBalanceAsync/u);
assert.match(service, /RequestSalvage/u);
assert.match(service, /Handle_SendAway/u);
assert.match(menu, /state=uiconst\.UI_DISABLED/u);
assert.match(menu, /_send_away_pending/u);

console.log("salvageBuddy validation passed");
