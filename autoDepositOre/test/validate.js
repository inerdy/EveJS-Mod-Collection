"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);

function read(relativePath) {
  return fs.readFileSync(path.join(modRoot, relativePath), "utf8");
}

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "autodepositore");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.equal(manifest.clientMenu.entrypoint, "client/menu.py");

const loader = read("loader.js");
assert.match(loader, /autoDepositOreService/u);
assert.match(loader, /serviceManager\.js/u);
assert.match(loader, /transitions\.js/u);
assert.match(loader, /dockSession/u);

const service = read("lib/autoDepositOreService.js");
assert.match(service, /Handle_GetState/u);
assert.match(service, /Handle_SetEnabled/u);
assert.match(service, /enabled: true/u);
assert.match(service, /SPECIALIZED_ASTEROID_HOLD/u);
assert.match(service, /SPECIALIZED_GAS_HOLD/u);
assert.match(service, /SPECIALIZED_ICE_HOLD/u);
assert.match(service, /itemCustody\.transfer/u);
assert.match(service, /INV_BROKER_MOVE/u);
assert.match(service, /personal hangar/u);
assert.match(service, /handleDockSuccess/u);
assert.doesNotMatch(service, /CARGO_HOLD\s*,/u);

const client = read("client/menu.py");
assert.match(client, /Auto Deposit Ore/u);
assert.match(client, /GetState/u);
assert.match(client, /SetEnabled/u);
assert.match(client, /Button/u);
assert.match(client, /SetLabel/u);
assert.match(client, /mods\.register/u);

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
  "LICENSE",
  "README.md",
  "client/menu.py",
  "evejs-launcher.mod.json",
  "lib/autoDepositOreService.js",
  "loader.js",
  "test/validate.js",
]);

console.log("Auto Deposit Ore manifest and package checks passed.");
