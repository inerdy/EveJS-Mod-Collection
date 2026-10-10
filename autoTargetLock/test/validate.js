"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("evejs-launcher.mod.json"));

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "autotargetlock");
assert.equal(manifest.kind, "loader");
assert.deepEqual(manifest.activation, {strategy: "loader_rename"});
assert.deepEqual(manifest.clientMenu, {apiVersion: 1, entrypoint: "client/menu.py"});
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const loader = read("loader.js");
assert.match(loader, /autoTargetLock/u);
assert.match(loader, /client auto target locking enabled/u);

const menu = read("client/menu.py");
assert.match(menu, /evejs_mod_menu/u);
assert.match(menu, /AutoTargetLockWindow/u);
assert.match(menu, /GetMaxTargetingRange/u);
assert.match(menu, /GetNumAdditionalTargetsAllowed/u);
assert.match(menu, /maxLockedTargets/u);
assert.match(menu, /TryLockTarget/u);
assert.match(menu, /GetBallpark/u);
assert.match(menu, /IsHostile/u);
assert.match(menu, /IsNPC/u);
assert.match(menu, /idCheckers/u);
assert.match(menu, /stateSvc/u);
assert.match(menu, /threatTargetsMe/u);
assert.match(menu, /threatAttackingMe/u);
assert.match(menu, /InWarp/u);
assert.match(menu, /IsPreparingWarp/u);
assert.match(menu, /Targeting paused while warping/u);
assert.match(menu, /target slots full/u);
assert.match(menu, /session\.shipid/u);
assert.match(menu, /SCAN_INTERVAL_MS/u);
assert.doesNotMatch(menu, /code\.ccp/u);
assert.doesNotMatch(menu, /keyboard/u);

console.log("autoTargetLock validation passed");
