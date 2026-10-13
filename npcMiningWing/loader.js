"use strict";

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const {EVEJS_ROOT, hostPath} = require("./lib/npcMiningWingHost");

const MOD_ID = "npcminingwing";
const MOD_VERSION = require("./evejs-launcher.mod.json").version;
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const INSTALLED = Symbol.for("evejs.npcMiningWing.loaderInstalled");
const REQUIRED_EVEJS_VERSION = "0.12.9";

function evejsPath(...segments) {
  return hostPath("server", ...segments);
}

function validateHostCompatibility() {
  const packagePath = evejsPath("package.json");
  let packageJSON;
  try {
    packageJSON = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `[${MOD_ID}] EveJS host package is unavailable at ${packagePath}: ${error.message}`,
    );
  }
  if (String(packageJSON.version || "") !== REQUIRED_EVEJS_VERSION) {
    throw new Error(
      `[${MOD_ID}] requires EveJS ${REQUIRED_EVEJS_VERSION}; ` +
        `found ${String(packageJSON.version || "unknown")}`,
    );
  }
  const requiredFiles = [
    ["service manager", evejsPath("src", "services", "serviceManager.js")],
    ["base service", evejsPath("src", "services", "baseService.js")],
    ["game store", evejsPath("src", "gameStore", "index.js")],
    ["space runtime", evejsPath("src", "space", "runtime.js")],
    ["world data", evejsPath("src", "space", "worldData.js")],
    ["interaction scope", evejsPath("src", "space", "destiny", "identity", "interactionScope.js")],
    ["station docking geometry", evejsPath("src", "space", "runtime", "stationDockingGeometry.js")],
    ["character state", evejsPath("src", "services", "character", "characterState.js")],
    ["session identity", evejsPath("src", "services", "_shared", "sessionIdentity.js")],
    ["service helpers", evejsPath("src", "services", "_shared", "serviceHelpers.js")],
    ["inventory item store", evejsPath("src", "services", "inventory", "itemStore.js")],
    ["item custody", evejsPath("src", "services", "inventory", "itemCustody.js")],
    ["live fitting state", evejsPath("src", "services", "fitting", "liveFittingState.js")],
    ["skill state", evejsPath("src", "services", "skills", "skillState.js")],
    ["mining dogma", evejsPath("src", "services", "mining", "miningDogma.js")],
    ["mining inventory", evejsPath("src", "services", "mining", "miningInventory.js")],
    ["drone runtime", evejsPath("src", "services", "drone", "droneRuntime.js")],
    ["drone dogma", evejsPath("src", "services", "drone", "droneDogma.js")],
    ["session registry", evejsPath("src", "services", "chat", "sessionRegistry.js")],
    ["chat hub", evejsPath("src", "services", "chat", "chatHub.js")],
    ["chat runtime", evejsPath("src", "_secondary", "chat", "chatRuntime.js")],
    ["logger", evejsPath("src", "utils", "logger", "index.js")],
    ["mining runtime", evejsPath("src", "services", "mining", "miningRuntime.js")],
    ["mining runtime state", evejsPath("src", "services", "mining", "miningRuntimeState.js")],
  ];
  for (const [label, filePath] of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`[${MOD_ID}] required EveJS ${label} seam is missing: ${filePath}`);
    }
  }
  return packageJSON;
}

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function installServiceRegistrationHook() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const serviceManagerCache = new WeakMap();

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!String(resolved).endsWith(SERVICE_MANAGER_SUFFIX)) {
      return exported;
    }
    if (serviceManagerCache.has(exported)) {
      return serviceManagerCache.get(exported);
    }

    const WingService = require(path.join(__dirname, "lib", "npcMiningWingService"));
    class MiningWingServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup("npcMiningWing")) {
          this.register(new WingService());
          log("server service registered");
        }
      }
    }
    Object.setPrototypeOf(MiningWingServiceManager, exported);
    serviceManagerCache.set(exported, MiningWingServiceManager);
    return MiningWingServiceManager;
  }

  load[INSTALLED] = true;
  Module._load = load;
}

const droneBridge = require(path.join(
  __dirname,
  "lib",
  "npcMiningWingDroneBridge",
));

const hostPackage = validateHostCompatibility();
require("./lib/npcMiningWingMiningTrace").install();
const droneBridgeState = droneBridge.install();
require("./lib/npcMiningWingMiningCompatibility").install(droneBridgeState);
installServiceRegistrationHook();
log(
  `v${MOD_VERSION} active for EveJS ${hostPackage.version} — server service, ` +
    `client menu, and automatic drone management enabled`,
);

module.exports = Object.freeze({
  id: MOD_ID,
  version: MOD_VERSION,
  active: true,
});
