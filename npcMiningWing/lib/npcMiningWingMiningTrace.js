"use strict";

const Module = require("node:module");
const path = require("node:path");
const {serverPath} = require("./npcMiningWingHost");
const MOD_VERSION = require("../evejs-launcher.mod.json").version;
const SINGLETON = Symbol.for("evejs.npcMiningWing.miningTrace.v1");
const WRAPPED = Symbol("miningTraceWrapped");
const TRACE_ENV = "NPC_MINING_WING_MINING_TRACE";

function traceEnabled() {
  return ["1", "true", "on", "enabled"].includes(
    String(process.env[TRACE_ENV] || "").trim().toLowerCase(),
  );
}

function createDisabledTrace() {
  return {
    enabled: false,
    log() {},
    patch() {},
    run(_stage, _entity, _details, callback) { return callback(); },
    observe() {},
    heartbeat() {},
    shipTick(_scene, _entity, _details, callback) { return callback(); },
    known() { return false; },
    wrap(exports) { return exports; },
    runtimeCompleted() {},
  };
}

// Only allowlisted scalar fields are logged. Never serialize sessions, sockets,
// full inventory records or effect objects (which can contain circular data).
function scalar(value) {
  return value === undefined ? "<undefined>" : value === null ? "<null>" :
    ["string", "number", "boolean"].includes(typeof value) ? value : String(value);
}

function identity(entity) {
  const e = entity || {};
  const resolved = e.kind === "ship"
    ? Number(e.session && e.session.characterID
      ? e.session.characterID : e.characterID ?? e.pilotCharacterID)
    : 0;
  return {
    shipID: scalar(e.itemID), ownerID: scalar(e.ownerID), kind: scalar(e.kind),
    characterID: scalar(e.characterID), characterIDType: typeof e.characterID,
    pilotCharacterID: scalar(e.pilotCharacterID),
    runtimeOwnerCharacterID: scalar(e.runtimeOwnerCharacterID),
    sessionCharacterID: scalar(e.session && e.session.characterID),
    hasSession: Boolean(e.session), nativeNpc: scalar(e.nativeNpc),
    wingController: scalar(e.npcMiningWingController),
    // A prediction of the host resolver, not a claim that its private function ran.
    predictedNativeCharacterID: Number.isFinite(resolved) ? Math.trunc(resolved) : 0,
    systemID: scalar(e.systemID), sceneKey: scalar(e.sceneKey),
  };
}

function item(row) {
  if (!row) return null;
  return Object.fromEntries(["itemID", "ownerID", "locationID", "flagID", "typeID", "quantity", "stacksize"]
    .map((key) => [key, scalar(row[key])]));
}

function resultSummary(result) {
  if (typeof result !== "object" || result === null) return {result: scalar(result)};
  if (Array.isArray(result)) return {count: result.length, rows: result.slice(0, 32).map(item)};
  const data = result.data || {};
  return {
    success: scalar(result.success), stopReason: scalar(result.stopReason), error: scalar(result.errorMsg),
    item: result.itemID ? item(result) : null,
    transferred: scalar(data.transferredQuantity), quantity: scalar(data.quantity),
    depleted: scalar(data.depleted), pending: scalar(data.pending),
    module: data.moduleItem ? item(data.moduleItem) : null,
    durationMs: scalar(data.snapshot && data.snapshot.durationMs),
    miningAmountM3: scalar(data.snapshot && data.snapshot.miningAmountM3),
    changedItems: Array.isArray(data.changes) ? data.changes.slice(0, 32).map((c) => item(c.item)) : [],
  };
}

function createTrace({emit = (line) => console.log(line), now = Date.now} = {}) {
  let sequence = 0;
  let scope = null;
  let suppressed = 0;
  let windowAt = now();
  let windowLines = 0;
  const ships = new Map();
  const scenes = new WeakSet();
  const patched = new WeakMap();
  const samples = new Map();
  const hooks = {};
  const counters = {};
  const errors = {};
  let store = null;
  let lastRuntimeTickAt = null;
  let lastRuntimeCompletedAt = null;
  let runtimeDetails = {};

  function log(event, fields = {}) {
    // Diagnostics must never change a gameplay return value or throw in its place.
    try {
      const time = now();
      if (time - windowAt >= 1000) { windowAt = time; windowLines = 0; }
      if (windowLines++ >= 300 && event !== "heartbeat") { suppressed += 1; return; }
      emit(`[NPCMiningWing:MiningTrace] ${JSON.stringify({
        event, at: time, pid: process.pid, trace: scope && scope.id || null,
        shipID: scope && scope.shipID || null, ...fields,
      })}`);
    } catch (_) { /* logging failure must not interrupt mining */ }
  }

  function inspect(callback) {
    try { return callback(); } catch (error) { return {inspectionError: String(error.message)}; }
  }

  function inventory(shipID) {
    if (!store || typeof store.listContainerItems !== "function") return {unavailable: true};
    return inspect(() => {
      // Deliberately omit the owner filter to expose grants to the wrong owner.
      const rows = store.listContainerItems(null, shipID, null);
      return {count: rows.length, rows: rows.slice(0, 32).map(item)};
    });
  }

  function known(entity) {
    return Boolean(entity && (entity.npcMiningWingController === true || ships.has(String(entity.itemID))));
  }

  function run(stage, entity, details, callback, summarize = resultSummary) {
    const parent = scope;
    const shipID = entity && entity.itemID || parent && parent.shipID;
    const id = `${process.pid}:${++sequence}`;
    scope = {id, shipID};
    counters[stage] = (counters[stage] || 0) + 1;
    log(`${stage}.before`, {parent: parent && parent.id || null, ...inspect(details)});
    try {
      const result = callback();
      log(`${stage}.after`, inspect(() => summarize(result)));
      return result;
    } catch (error) {
      errors[stage] = (errors[stage] || 0) + 1;
      log(`${stage}.throw`, {error: String(error && error.message || error)});
      throw error;
    } finally {
      scope = parent;
    }
  }

  function wrap(exports, name, stage, selectEntity, describe, summarize) {
    if (exports && patched.get(exports) && patched.get(exports).has(name)) return;
    const original = exports && exports[name];
    if (typeof original !== "function") { hooks[stage] = "missing"; log("hook.missing", {stage}); return; }
    if (original[WRAPPED]) return;
    function traced(...args) {
      let entity = null;
      try { entity = selectEntity ? selectEntity(args) : null; }
      catch (error) {
        log("hook.inspectionFailed", {stage, error: String(error.message)});
        return original.apply(this, args);
      }
      if (!(selectEntity ? known(entity) : scope)) return original.apply(this, args);
      return run(stage, entity, () => describe(args), () => original.apply(this, args), summarize);
    }
    traced[WRAPPED] = true;
    try {
      exports[name] = traced;
      hooks[stage] = exports[name] === traced ? "attached" : "failed";
      if (exports[name] === traced) {
        if (!patched.has(exports)) patched.set(exports, new Set());
        patched.get(exports).add(name);
      }
      log("hook.attached", {stage, status: hooks[stage]});
    } catch (error) {
      hooks[stage] = "failed";
      log("hook.failed", {stage, error: String(error.message)});
    }
  }

  function patch(relative, exports) {
    if (relative === "services/mining/miningRuntime.js") {
      wrap(exports, "prepareMiningCycleBoundary", "prepare", (a) => a[0], (a) => ({
        identity: identity(a[0]), moduleID: a[1] && a[1].moduleID,
        targetID: a[1] && a[1].targetID, boundary: a[2],
      }));
      wrap(exports, "executeMiningCycle", "cycle", (a) => a[1], (a) => ({
        identity: identity(a[1]), sceneKey: scalar(a[0] && a[0].sceneKey),
        moduleID: a[2] && a[2].moduleID, targetID: a[2] && a[2].targetID,
        boundary: a[3], inventory: inventory(a[1].itemID),
      }), (result) => ({...resultSummary(result), inventory: inventory(scope.shipID)}));
    } else if (relative === "space/runtime/moduleEffectShutdown.js") {
      wrap(exports, "finalizeGenericModuleDeactivationWithoutSession", "sessionlessStop", (a) => a[1], (a) => ({
        identity: identity(a[1]), moduleID: a[2] && a[2].moduleID,
        targetID: a[2] && a[2].targetID, reason: scalar(a[3] && a[3].reason),
        stopAt: scalar(a[3] && a[3].nowMs),
      }));
    } else if (relative === "services/inventory/itemStore.js") {
      store = exports;
      wrap(exports, "grantItemsToCharacterLocation", "grant", null, (a) => ({
        characterID: scalar(a[0]), destinationShipID: scalar(a[1]), flagID: scalar(a[2]),
        entries: (a[3] || []).slice(0, 16).map((e) => ({typeID: scalar(e.itemType), quantity: scalar(e.quantity)})),
      }));
      wrap(exports, "moveItemToLocation", "cargoMove", null, (a) => ({
        itemID: scalar(a[0]), destinationID: scalar(a[1]), flagID: scalar(a[2]), quantity: scalar(a[3]),
      }));
    } else if (relative === "services/character/characterState.js") {
      wrap(exports, "getActiveShipRecord", "activeShipLookup", null, (a) => ({characterID: scalar(a[0])}));
    } else if (relative === "services/fitting/liveFittingState.js") {
      wrap(exports, "getFittedModuleItems", "fittingLookup", null, (a) => ({characterID: scalar(a[0]), requestedShipID: scalar(a[1])}));
      wrap(exports, "buildShipResourceState", "storageSnapshot", null, (a) => ({characterID: scalar(a[0]), selectedShip: item(a[1])}),
        (r) => ({capacities: Object.fromEntries(Object.entries(r || {}).filter(([key, value]) => /capacity/i.test(key) && typeof value === "number"))}));
    } else if (relative === "services/mining/miningDogma.js") {
      wrap(exports, "buildMiningModuleSnapshot", "miningSnapshot", null, (a) => ({
        characterID: scalar(a[0].characterID), selectedShip: item(a[0].shipItem), module: item(a[0].moduleItem),
      }), (r) => ({present: Boolean(r), durationMs: scalar(r && r.durationMs), amountM3: scalar(r && r.miningAmountM3), maxRange: scalar(r && r.maxRangeMeters)}));
    }
  }

  function sample(key, interval) {
    const time = now();
    if (samples.has(key) && time - samples.get(key) < interval) return false;
    samples.set(key, time);
    return true;
  }

  function observe(scene, entity, context = {}) {
    try {
      if (!entity) { log("ship.missing", context); return; }
      const key = String(entity.itemID);
      const effects = entity.activeModuleEffects instanceof Map
        ? [...entity.activeModuleEffects.values()].filter((e) => e && e.miningEffect).map((e) => ({
          moduleID: e.moduleID, targetID: e.targetID, startedAtMs: e.startedAtMs,
          nextCycleAtMs: e.nextCycleAtMs, deactivateAtMs: e.deactivateAtMs,
          stopReason: e.stopReason, durationMs: e.durationMs,
          overdueMs: e.nextCycleAtMs > 0 ? Math.max(0, now() - e.nextCycleAtMs) : null,
        })) : [];
      const signature = JSON.stringify(effects.map(({overdueMs, ...effect}) => effect));
      const previous = ships.get(key);
      ships.set(key, {signature, lastSeen: now()});
      if (scene && !scenes.has(scene)) {
        scenes.add(scene);
        for (const name of ["activateGenericModule", "deactivateGenericModule", "finalizeGenericModuleDeactivation"]) {
          wrap(scene, name, name, (args) => scene.getShipEntityForSession(args[0]), (args) => ({
            sessionCharacterID: scalar(args[0] && args[0].characterID),
            sessionShipID: scalar(args[0] && args[0].shipID),
            moduleID: scalar(args[1] && args[1].itemID || args[1]),
            reason: scalar(args[2] && args[2].reason),
            targetID: scalar(args[3] && args[3].targetID),
          }));
        }
      }
      if (!previous || previous.signature !== signature || sample(`ship:${key}`, 5000)) {
        log("ship.observe", {shipID: entity.itemID, ...context, identity: identity(entity),
          sceneKey: scalar(scene && scene.sceneKey), effects,
          effectTransition: !previous || previous.signature !== signature,
          inventory: inventory(entity.itemID),
        });
      }
    } catch (error) { log("observe.failed", {error: String(error.message)}); }
  }

  function heartbeat(details) {
    if (details) {
      lastRuntimeTickAt = now();
      if (sample("runtimeDetails", 10000)) runtimeDetails = inspect(details);
    }
    if (!sample("heartbeat", 10000)) return;
    log("heartbeat", {...runtimeDetails, lastRuntimeTickAt, lastRuntimeCompletedAt,
      hooks: {...hooks}, calls: {prepare: 0, cycle: 0, grant: 0, ...counters}, errors: {...errors}, suppressed});
    for (const [key, entry] of ships) {
      if (now() - entry.lastSeen > 120000) { ships.delete(key); samples.delete(`ship:${key}`); samples.delete(`tick:${key}`); }
    }
  }

  function shipTick(scene, entity, details, callback) {
    observe(scene, entity, {...inspect(details), phase: "before"});
    const traced = sample(`tick:${entity && entity.itemID}`, 5000);
    try {
      return traced ? run("wingTick", entity, details, callback, (result) => ({result, ...inspect(details)})) : callback();
    } finally {
      observe(scene, entity, {...inspect(details), phase: "after"});
    }
  }

  return {enabled: true, log, patch, run, observe, heartbeat, shipTick, known, wrap,
    runtimeCompleted: () => { lastRuntimeCompletedAt = now(); },
  };
}

function install() {
  if (globalThis[SINGLETON]) return globalThis[SINGLETON];
  if (!traceEnabled()) {
    const trace = createDisabledTrace();
    globalThis[SINGLETON] = trace;
    return trace;
  }
  const trace = createTrace();
  globalThis[SINGLETON] = trace;
  const targets = new Map([
    "services/mining/miningRuntime.js", "services/inventory/itemStore.js",
    "services/character/characterState.js", "services/fitting/liveFittingState.js",
    "services/mining/miningDogma.js",
    "space/runtime/moduleEffectShutdown.js",
  ].map((relative) => [serverPath(...relative.split("/")), relative]));
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.apply(this, arguments);
    if (targets.has(resolved)) trace.patch(targets.get(resolved), exported);
    return exported;
  };
  const cached = [];
  for (const [filename, relative] of targets) {
    if (require.cache[filename]) { cached.push(relative); trace.patch(relative, require.cache[filename].exports); }
  }
  trace.log("installed", {version: MOD_VERSION, hostRoot: path.dirname(serverPath()), cachedAtInstall: cached,
    coverage: cached.length ? "late-install: previously captured imports may bypass hooks; restart game server" : "early-install",
  });
  // Independent of service ticks: shows a loaded mod with no active service or
  // no mining callbacks. Does not keep a utility/launcher process alive.
  const watchdog = setInterval(() => trace.heartbeat(), 10000);
  watchdog.unref();
  return trace;
}

module.exports = {install, createTrace};
