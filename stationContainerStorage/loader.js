"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "stationcontainerstorage";
const MOD_VERSION = "0.1.0";
const STATION_CONTAINER_TYPE_ID = 17366;
// Infinity is not safe to send through the normal inventory marshal path. This
// is deliberately a large finite sentinel that is far beyond any practical
// station inventory while leaving the server's normal used-volume accounting
// and capacity checks in place.
const UNLIMITED_CAPACITY = 1_000_000_000_000;
const INV_BROKER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}inventory${path.sep}invBrokerService.js`;
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INV_BROKER_PATH = path.join(
  REPO_ROOT,
  "server",
  "src",
  "services",
  "inventory",
  "invBrokerService.js",
);
const INSTALLED = Symbol.for("evejs.stationContainerStorage.loaderInstalled");
const PATCHED = Symbol.for("evejs.stationContainerStorage.capacityPatched");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function positiveInteger(value) {
  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) && numericValue > 0
    ? numericValue
    : 0;
}

function isStationContainerAtCurrentStation(
  broker,
  session,
  boundContext,
  record,
) {
  if (
    !boundContext ||
    boundContext.kind !== "container" ||
    !record ||
    Number(record.typeID) !== STATION_CONTAINER_TYPE_ID ||
    !broker ||
    typeof broker._getStationId !== "function"
  ) {
    return false;
  }

  const stationID = positiveInteger(broker._getStationId(session));
  if (!stationID) {
    return false;
  }

  const itemStore = require(path.join(
    REPO_ROOT,
    "server",
    "src",
    "services",
    "inventory",
    "itemStore",
  ));
  const hangarFlag = itemStore.ITEM_FLAGS && itemStore.ITEM_FLAGS.HANGAR;

  // Personal station containers are direct children of the station hangar.
  if (
    Number(record.flagID) === Number(hangarFlag) &&
    positiveInteger(record.locationID) === stationID
  ) {
    return true;
  }

  // Corporate containers use the same item rows but are scoped by the first
  // corporation-hangar ancestor. Let the broker resolve that context so this
  // patch does not duplicate or weaken its existing office/access rules.
  if (typeof broker._getCorporationOfficeDivisionAncestorContext !== "function") {
    return false;
  }
  try {
    const context = broker._getCorporationOfficeDivisionAncestorContext(
      session,
      record,
    );
    return Boolean(
      context &&
      context.accessAllowed === true &&
      positiveInteger(context.stationID) === stationID,
    );
  } catch (_error) {
    // Capacity decoration must never turn a normal inventory request into an
    // error. The original broker still owns all access/error behavior.
    return false;
  }
}

function rewriteCapacityResult(result) {
  if (
    !result ||
    !result.args ||
    result.args.type !== "dict" ||
    !Array.isArray(result.args.entries)
  ) {
    return result;
  }

  return {
    ...result,
    args: {
      ...result.args,
      entries: result.args.entries.map((entry) => {
        if (!Array.isArray(entry) || entry[0] !== "capacity") {
          return entry;
        }
        return [entry[0], UNLIMITED_CAPACITY];
      }),
    },
  };
}

function patchInvBrokerService(InvBrokerService) {
  if (
    !InvBrokerService ||
    !InvBrokerService.prototype ||
    InvBrokerService.prototype[PATCHED]
  ) {
    return false;
  }

  const originalCalculateCapacity =
    InvBrokerService.prototype._calculateCapacity;
  if (typeof originalCalculateCapacity !== "function") {
    throw new Error("InvBrokerService._calculateCapacity is unavailable");
  }

  InvBrokerService.prototype._calculateCapacity = function patchedCalculateCapacity(
    session,
    boundContext,
    requestedFlag,
  ) {
    // Run the native path first. It keeps pending-structure handling, access
    // checks, used-volume accounting, and all non-Station-Container behavior.
    const result = originalCalculateCapacity.call(
      this,
      session,
      boundContext,
      requestedFlag,
    );
    const containerRecord =
      boundContext && boundContext.kind === "container"
        ? require(path.join(
            REPO_ROOT,
            "server",
            "src",
            "services",
            "inventory",
            "itemStore",
          )).findItemById(boundContext.inventoryID)
        : null;

    return isStationContainerAtCurrentStation(
      this,
      session,
      boundContext,
      containerRecord,
    )
      ? rewriteCapacityResult(result)
      : result;
  };

  Object.defineProperty(InvBrokerService.prototype, PATCHED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}

function patchCachedInvBrokerService() {
  let resolved;
  try {
    resolved = require.resolve(INV_BROKER_PATH);
  } catch (_error) {
    return false;
  }
  const cachedModule = require.cache[resolved];
  return Boolean(cachedModule && patchInvBrokerService(cachedModule.exports));
}

function installHook() {
  if (Module._load[INSTALLED]) {
    return;
  }

  const originalLoad = Module._load;
  const patchedExports = new WeakSet();

  function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    if (!String(resolved).endsWith(INV_BROKER_SUFFIX)) {
      return exported;
    }
    if (!patchedExports.has(exported)) {
      patchInvBrokerService(exported);
      if (exported && (typeof exported === "object" || typeof exported === "function")) {
        patchedExports.add(exported);
      }
    }
    return exported;
  }

  load[INSTALLED] = true;
  Module._load = load;
  patchCachedInvBrokerService();
}

installHook();
log(`v${MOD_VERSION} active — Station Container capacity override enabled`);

module.exports = Object.freeze({
  id: MOD_ID,
  version: MOD_VERSION,
  active: true,
  _testing: Object.freeze({
    isStationContainerAtCurrentStation,
    rewriteCapacityResult,
    STATION_CONTAINER_TYPE_ID,
    UNLIMITED_CAPACITY,
  }),
});
