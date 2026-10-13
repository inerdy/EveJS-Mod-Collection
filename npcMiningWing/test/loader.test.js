"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("loader validates and activates against the workspace EveJS checkout", (t) => {
  const inferredRoot = path.resolve(__dirname, "..", "..", "..");
  const bundledRoot = path.join(inferredRoot, "EveJS-v0.12.9");
  const evejsRoot = fs.existsSync(path.join(bundledRoot, "server"))
    ? bundledRoot
    : inferredRoot;
  process.env.EVEJS_ROOT = evejsRoot;

  const loader = require("../loader");
  assert.equal(loader.id, "npcminingwing");
  assert.equal(loader.active, true);
  assert.equal(loader.version, "0.12.10");

  let ServiceManager;
  try {
    ServiceManager = require(path.join(
      evejsRoot,
      "server",
      "src",
      "services",
      "serviceManager.js",
    ));
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      t.skip(`EveJS dependencies are not installed: ${error.message}`);
      return;
    }
    throw error;
  }
  assert.equal(typeof ServiceManager, "function");
  assert.equal(ServiceManager.name, "MiningWingServiceManager");
});

test("loader rejects a root without the EveJS host seams", () => {
  const modRoot = path.resolve(__dirname, "..");
  const loaderPath = path.join(modRoot, "loader.js");
  const result = childProcess.spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(loaderPath)})`],
    {
      env: {...process.env, EVEJS_ROOT: modRoot},
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /EveJS host package is unavailable/u,
  );
});
