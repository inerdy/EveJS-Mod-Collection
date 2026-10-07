"use strict";

const Module = require("node:module");
const path = require("node:path");

const {
  MOD_VERSION,
  normalizeConfig,
  seedCosmeticStore,
} = require("./lib/cosmeticStoreSeeder");

const MOD_ID = "cosmeticstoreseeder";
const SERVICE_MANAGER_SUFFIX =
  path.sep +
  "server" +
  path.sep +
  "src" +
  path.sep +
  "services" +
  path.sep +
  "serviceManager.js";
const INSTALLED = Symbol.for("evejs.cosmeticStoreSeeder.loaderInstalled");

function log(message) {
  console.log("[" + MOD_ID + "] " + message);
}

function readConfig() {
  try {
    return normalizeConfig(
      require(path.join(__dirname, "config", "cosmetics.json")),
    );
  } catch (error) {
    log("configuration could not be loaded; using defaults: " + error.message);
    return normalizeConfig();
  }
}

function install() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const serviceManagerCache = new WeakMap();
  let seeded = false;

  function seedOnce() {
    if (seeded) return;
    seeded = true;
    if (process.env.EVEJS_COSMETIC_STORE_SEEDER_DISABLE === "1") {
      log("seeding disabled by environment");
      return;
    }
    try {
      const database = require(path.join(
        __dirname,
        "..",
        "..",
        "server",
        "src",
        "gameStore",
      ));
      const result = seedCosmeticStore({
        database,
        config: readConfig(),
        version: MOD_VERSION,
      });
      if (result.skipped) {
        log("disabled in configuration");
        return;
      }
      const summary = result.summary || {};
      log(
        (result.changed ? "catalog reconciled" : "catalog already current") +
          " — " +
          String(summary.active || 0) +
          " active offers (" +
          String(summary.created || 0) +
          " added, " +
          String(summary.updated || 0) +
          " refreshed, " +
          String(summary.skippedExisting || 0) +
          " existing offers preserved)",
      );
    } catch (error) {
      log("catalog seeding skipped safely: " + error.message);
    }
  }

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return exported;
    }
    if (serviceManagerCache.has(exported)) {
      return serviceManagerCache.get(exported);
    }

    class CosmeticStoreSeederServiceManager extends exported {
      constructor(...args) {
        super(...args);
        seedOnce();
      }
    }
    Object.setPrototypeOf(CosmeticStoreSeederServiceManager, exported);
    serviceManagerCache.set(exported, CosmeticStoreSeederServiceManager);
    return CosmeticStoreSeederServiceManager;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

install();
log("v" + MOD_VERSION + " active — in-game cosmetic catalog seeding enabled");

module.exports = Object.freeze({
  id: MOD_ID,
  version: MOD_VERSION,
  active: true,
});
