"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(modRoot, "evejs-launcher.mod.json");
const loaderPath = path.join(modRoot, "loader.js");
const clientPath = path.join(modRoot, "client", "menu.py");
const read = (file) => fs.readFileSync(file, "utf8");

const manifest = JSON.parse(read(manifestPath));
assert.strictEqual(manifest.schemaVersion, 3);
assert.strictEqual(manifest.id, "systemclock");
assert.strictEqual(manifest.displayName, "System Clock");
assert.strictEqual(manifest.version, "0.3.0");
assert.deepStrictEqual(manifest.supportedBackends, ["native"]);
assert.strictEqual(manifest.activation.strategy, "loader_rename");
assert.strictEqual(manifest.restart, "game_server");
assert.deepStrictEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.deepStrictEqual(manifest.clientMenu, {
  apiVersion: 1,
  entrypoint: "client/menu.py",
});

const loader = read(loaderPath);
assert.match(loader, /System Clock has no server-side gameplay integration/u);
assert.doesNotMatch(loader, /Module\._load|_compile|sourceTransforms|require\(["']\.\/lib/u);

const client = read(clientPath);
assert.match(client, /import evejs_mod_menu as mods/u);
assert.match(client, /mods\.register\(/u);
assert.match(client, /'systemclock'/u);
assert.match(client, /class SystemClockWindow\(Window\)/u);
assert.match(client, /default_windowID = _WINDOW_ID/u);
assert.match(client, /default_scope = uiconst\.SCOPE_INGAME/u);
assert.match(client, /def open_window\(\):/u);
assert.match(client, /SystemClockWindow\.Open\(\)/u);
assert.match(client, /Window\.Close\(self/u);
assert.match(client, /time\.strftime\('%I:%M:%S %p'/u);
assert.match(client, /SleepWallclock\(1000\)/u);
assert.match(client, /_window\.Close\(\)/u);
assert.doesNotMatch(client, /\basync\b|f['"]|:=/u);

console.log("System Clock manifest, loader, and client entrypoint checks passed.");
