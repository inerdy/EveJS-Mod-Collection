"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const log = require(serverPath("utils", "logger"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {
  buildApproachPoint,
  buildRoutePlan,
  distanceSquared,
  listAnchors,
  choose,
} = require(path.join(__dirname, "routeEngine"));

const MOD_ID = "ambientNpcTraffic";
const FALLBACK_PROFILE_ID = "ore_mining_venture";
const ARRIVAL_TOLERANCE_MULTIPLIER = 1.5;
const LEG_DEADLINE_MULTIPLIER = 4;
const BEHAVIOR_OVERRIDES = Object.freeze({
  autoAggro: false,
  autoActivateWeapons: false,
  targetPreference: "none",
  returnToHomeWhenIdle: false,
});

let runtimeDependencies = null;

function getRuntimeDependencies() {
  if (runtimeDependencies) {
    return runtimeDependencies;
  }
  runtimeDependencies = Object.freeze({
    npcRuntime: require(serverPath("space", "npc", "npcRuntime")),
    npcService: require(serverPath("space", "npc", "npcService")),
    spaceRuntime: require(serverPath("space", "runtime")),
  });
  return runtimeDependencies;
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSystemID(value) {
  return positive(value, 0);
}

function isActiveScene(scene) {
  return Boolean(
    scene &&
    normalizeSystemID(scene.systemID) > 0 &&
    String(scene.sceneKind || "solarSystem").toLowerCase() !== "abyssal" &&
    scene.sessions instanceof Map &&
    scene.sessions.size > 0,
  );
}

function entityIsWarping(entity) {
  if (!entity) {
    return false;
  }
  const mode = String(entity.mode || "").trim().toUpperCase();
  return Boolean(
    mode === "WARP" ||
    entity.warpState ||
    entity.pendingWarp ||
    entity.sessionlessWarpIngress,
  );
}

function currentEntityID(record) {
  return positive(record && record.liveEntityID, 0);
}

function buildTrafficSeed(bootSeed, sequence, systemID) {
  return `${bootSeed}:${sequence}:${systemID}`;
}

function buildTrafficID(bootSeed, sequence) {
  return `ambient-${bootSeed}-${sequence}`;
}

class AmbientNpcTrafficService extends BaseService {
  constructor() {
    super("ambientNpcTraffic");
    this._config = loadConfig();
    this._records = new Map();
    this._seenSystems = new Set();
    this._lastSpawnAtBySystem = new Map();
    this._sequence = 0;
    this._bootSeed = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    this._ticker = null;
    this._tickInProgress = false;
    this._lastTickAtMs = 0;

    if (this._config.enabled) {
      this._startTicker();
    }
  }

  _startTicker() {
    if (this._ticker) {
      return;
    }
    this._ticker = setInterval(() => {
      this.tick();
    }, this._config.tickIntervalMs);
    if (this._ticker && typeof this._ticker.unref === "function") {
      this._ticker.unref();
    }
  }

  stop() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
    for (const record of this._records.values()) {
      this._despawnRecord(record, {broadcast: false});
    }
    this._records.clear();
    this._seenSystems.clear();
    this._lastSpawnAtBySystem.clear();
    return true;
  }

  getStatus() {
    let liveCount = 0;
    let virtualCount = 0;
    for (const record of this._records.values()) {
      if (currentEntityID(record)) {
        liveCount += 1;
      } else {
        virtualCount += 1;
      }
    }
    return {
      enabled: this._config.enabled,
      liveCount,
      virtualCount,
      totalCount: this._records.size,
      activeSystems: this._seenSystems.size,
      maxShipsGlobal: this._config.maxShipsGlobal,
    };
  }

  tick(nowMs = Date.now()) {
    if (!this._config.enabled || this._tickInProgress) {
      return this.getStatus();
    }

    this._tickInProgress = true;
    this._lastTickAtMs = finite(nowMs, Date.now());
    try {
      const dependencies = getRuntimeDependencies();
      const activeScenes = this._activeScenes(dependencies.spaceRuntime);
      this._virtualizeInactiveRecords(activeScenes, this._lastTickAtMs);
      this._removeExpiredRecords(this._lastTickAtMs);

      for (const scene of activeScenes.values()) {
        this._tickActiveScene(scene, this._lastTickAtMs, dependencies);
      }
    } catch (error) {
      log.warn(`[${MOD_ID}] tick failed: ${error.message}`);
    } finally {
      this._tickInProgress = false;
    }
    return this.getStatus();
  }

  _activeScenes(spaceRuntime) {
    const activeScenes = new Map();
    if (!spaceRuntime || !spaceRuntime.scenes || typeof spaceRuntime.scenes.values !== "function") {
      return activeScenes;
    }
    for (const scene of spaceRuntime.scenes.values()) {
      if (isActiveScene(scene)) {
        activeScenes.set(normalizeSystemID(scene.systemID), scene);
      }
    }
    return activeScenes;
  }

  _tickActiveScene(scene, nowMs, dependencies) {
    const systemID = normalizeSystemID(scene.systemID);
    if (!systemID) {
      return;
    }
    this._materializeDueRecords(scene, nowMs, dependencies);
    this._ensureTrafficCount(scene, nowMs, dependencies);
    this._seenSystems.add(systemID);

    for (const record of [...this._records.values()]) {
      if (record.systemID !== systemID || !currentEntityID(record)) {
        continue;
      }
      this._tickRecord(record, scene, nowMs, dependencies);
    }
  }

  _recordsForSystem(systemID) {
    return [...this._records.values()].filter((record) => (
      record.systemID === systemID &&
      record.expiresAtMs > 0
    ));
  }

  _liveRecordsForSystem(systemID, scene) {
    return this._recordsForSystem(systemID).filter((record) => {
      const entityID = currentEntityID(record);
      if (!entityID) {
        return false;
      }
      if (scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(entityID)) {
        return true;
      }
      record.liveEntityID = 0;
      record.phase = "virtual";
      record.nextActionAtMs = this._lastTickAtMs + this._config.virtualTravelMs;
      return false;
    });
  }

  _ensureTrafficCount(scene, nowMs, dependencies) {
    const systemID = normalizeSystemID(scene.systemID);
    const liveRecords = this._liveRecordsForSystem(systemID, scene);
    const targetCount = Math.min(
      this._config.maxShipsPerSystem,
      this._config.shipsPerActiveSystem,
    );
    const initialCount = Math.min(
      targetCount,
      this._config.initialShipsPerActiveSystem,
    );
    const firstVisit = !this._seenSystems.has(systemID);
    const desiredCount = firstVisit
      ? initialCount
      : targetCount;
    let currentCount = liveRecords.length;
    while (
      currentCount < desiredCount &&
      this._totalLiveRecords() < this._config.maxShipsGlobal
    ) {
      if (
        !firstVisit &&
        nowMs - finite(this._lastSpawnAtBySystem.get(systemID), 0) < this._config.spawnIntervalMs
      ) {
        break;
      }
      const record = this._createRecord(scene, nowMs);
      if (!record || !this._spawnRecord(record, scene, nowMs, dependencies)) {
        break;
      }
      this._records.set(record.trafficID, record);
      this._lastSpawnAtBySystem.set(systemID, nowMs);
      currentCount += 1;
    }
  }

  _createRecord(scene, nowMs) {
    const systemID = normalizeSystemID(scene && scene.systemID);
    const staticEntities = Array.isArray(scene && scene.staticEntities)
      ? scene.staticEntities
      : [];
    this._sequence += 1;
    const seed = buildTrafficSeed(this._bootSeed, this._sequence, systemID);
    const route = buildRoutePlan({
      systemID,
      staticEntities,
      seed,
      crossSystemChance: this._config.crossSystemChance,
    });
    if (!route) {
      log.warn(`[${MOD_ID}] no usable traffic anchors in system=${systemID}`);
      return null;
    }

    return {
      trafficID: buildTrafficID(this._bootSeed, this._sequence),
      seed,
      sequence: this._sequence,
      profileID: choose(this._config.profileIDs, `${seed}:profile`) || FALLBACK_PROFILE_ID,
      ...route,
      phase: "queued",
      liveEntityID: 0,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this._config.shipLifetimeMs,
      nextActionAtMs: nowMs,
      targetPoint: null,
      legStartedAtMs: 0,
      legDeadlineAtMs: 0,
      legIndex: 0,
    };
  }

  _buildRouteFromCurrentAnchor(record, scene) {
    const route = buildRoutePlan({
      systemID: scene.systemID,
      staticEntities: scene.staticEntities,
      seed: `${record.seed}:rematerialize:${record.legIndex}`,
      crossSystemChance: this._config.crossSystemChance,
    });
    if (!route) {
      return null;
    }

    const currentAnchor = typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(positive(record.currentAnchorID, 0))
      : null;
    if (!currentAnchor) {
      return route;
    }

    route.currentAnchorID = currentAnchor.itemID;
    route.currentAnchorName = currentAnchor.itemName || currentAnchor.slimName || "Anchor";
    if (route.destinationAnchorID === route.currentAnchorID) {
      const anchors = listAnchors(scene.staticEntities).all.filter((entry) => (
        entry.itemID !== route.currentAnchorID
      ));
      const alternate = choose(anchors, `${record.seed}:alternate-destination`);
      if (alternate) {
        route.routeKind = "local";
        route.destinationAnchorID = alternate.itemID;
        route.destinationAnchorName = alternate.itemName;
        route.destinationSystemID = scene.systemID;
        route.destinationGateID = 0;
      }
    }
    return route;
  }

  _materializeDueRecords(scene, nowMs, dependencies) {
    const systemID = normalizeSystemID(scene.systemID);
    for (const record of this._records.values()) {
      if (
        record.systemID !== systemID ||
        currentEntityID(record) ||
        record.expiresAtMs <= nowMs ||
        record.nextActionAtMs > nowMs ||
        this._totalLiveRecords() >= this._config.maxShipsGlobal
      ) {
        continue;
      }
      this._spawnRecord(record, scene, nowMs, dependencies);
    }
  }

  _spawnRecord(record, scene, nowMs, dependencies) {
    let anchor = typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(positive(record.currentAnchorID, 0))
      : null;
    if (
      !anchor ||
      !anchor.position ||
      positive(record.destinationAnchorID, 0) <= 0 ||
      positive(record.destinationAnchorID, 0) === positive(record.currentAnchorID, 0)
    ) {
      const route = this._buildRouteFromCurrentAnchor(record, scene);
      if (!route) {
        record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
        return false;
      }
      Object.assign(record, route);
      anchor = scene.getEntityByID(positive(record.currentAnchorID, 0));
    }

    const spawnResult = dependencies.npcService.spawnNpcBatchInSystem(scene.systemID, {
      sceneDescriptor: scene.sceneDescriptor || undefined,
      anchorEntity: anchor,
      amount: 1,
      entityType: "npc",
      profileQuery: record.profileID,
      fallbackProfileID: FALLBACK_PROFILE_ID,
      runtimeKind: "nativeAmbient",
      transient: true,
      skipInitialBehaviorTick: true,
      broadcast: true,
      behaviorOverrides: BEHAVIOR_OVERRIDES,
      spawnDistanceMeters: this._config.spawnDistanceMeters,
      spreadMeters: 1500,
      formationSpacingMeters: 1000,
      selectionKind: "ambientNpcTraffic",
      selectionID: record.trafficID,
      selectionName: "Ambient NPC Traffic",
      anchorName: anchor && anchor.itemName,
      preferredTargetID: 0,
      runtimeEntityMetadata: {
        ambientNpcTraffic: true,
        ambientNpcTrafficID: record.trafficID,
        visualOnly: true,
      },
    });
    if (
      !spawnResult ||
      spawnResult.success !== true ||
      !spawnResult.data ||
      !Array.isArray(spawnResult.data.spawned) ||
      !spawnResult.data.spawned[0] ||
      !spawnResult.data.spawned[0].entity
    ) {
      record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
      log.warn(
        `[${MOD_ID}] spawn failed system=${scene.systemID} profile=${record.profileID} ` +
        `reason=${spawnResult && spawnResult.errorMsg || "UNKNOWN"}`,
      );
      return false;
    }

    const entity = spawnResult.data.spawned[0].entity;
    const entityID = positive(entity.itemID, 0);
    if (!entityID) {
      record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
      return false;
    }

    // These markers are runtime-only. The native ambient controller prevents
    // combat behavior; targetable=false also keeps the client from presenting
    // ordinary lock/attack affordances for this cosmetic traffic.
    entity.ambientNpcTraffic = true;
    entity.ambientNpcTrafficID = record.trafficID;
    entity.visualOnly = true;
    entity.targetable = false;
    entity.lockable = false;

    record.liveEntityID = entityID;
    record.systemID = normalizeSystemID(scene.systemID);
    record.phase = "queued";
    record.nextActionAtMs = nowMs + 1000;
    record.expiresAtMs = nowMs + this._config.shipLifetimeMs;

    log.info(
      `[${MOD_ID}] spawned ${record.profileID} entity=${entityID} ` +
      `system=${record.systemID} traffic=${record.trafficID}`,
    );
    return true;
  }

  _tickRecord(record, scene, nowMs, dependencies) {
    const entityID = currentEntityID(record);
    const entity = entityID && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    if (!entity) {
      record.liveEntityID = 0;
      record.phase = "virtual";
      record.nextActionAtMs = nowMs + this._config.virtualTravelMs;
      return;
    }

    entity.ambientNpcTraffic = true;
    entity.ambientNpcTrafficID = record.trafficID;
    entity.visualOnly = true;
    entity.targetable = false;
    entity.lockable = false;

    if (record.expiresAtMs <= nowMs) {
      this._despawnRecord(record, {broadcast: true}, dependencies);
      this._records.delete(record.trafficID);
      return;
    }
    if (record.nextActionAtMs > nowMs) {
      return;
    }

    if (record.phase === "queued" || record.phase === "virtual") {
      this._startLeg(record, scene, nowMs, dependencies);
      return;
    }

    if (record.phase === "traveling") {
      const reached = !entityIsWarping(entity) && (
        distanceSquared(entity.position, record.targetPoint) <= (
          this._config.arrivalDistanceMeters *
          this._config.arrivalDistanceMeters *
          ARRIVAL_TOLERANCE_MULTIPLIER
        ) || nowMs >= record.legDeadlineAtMs
      );
      if (reached) {
        this._enterDwell(record, scene, nowMs, dependencies);
      }
      return;
    }

    if (record.phase === "dwell") {
      if (nowMs < record.nextActionAtMs) {
        return;
      }
      if (record.routeKind === "cross-system") {
        this._beginGateTransit(record, nowMs, dependencies);
        return;
      }

      record.currentAnchorID = record.destinationAnchorID;
      record.currentAnchorName = record.destinationAnchorName;
      record.legIndex += 1;
      const route = buildRoutePlan({
        systemID: record.systemID,
        staticEntities: scene.staticEntities,
        seed: `${record.seed}:leg:${record.legIndex}`,
        crossSystemChance: this._config.crossSystemChance,
      });
      if (!route) {
        record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
        return;
      }
      record.routeKind = route.routeKind;
      record.destinationAnchorID = route.destinationAnchorID;
      record.destinationAnchorName = route.destinationAnchorName;
      record.destinationSystemID = route.destinationSystemID;
      record.destinationGateID = route.destinationGateID;
      record.phase = "queued";
      record.nextActionAtMs = nowMs + 250;
    }
  }

  _startLeg(record, scene, nowMs, dependencies) {
    const target = typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(positive(record.destinationAnchorID, 0))
      : null;
    const entityID = currentEntityID(record);
    if (!target || !target.position || !entityID) {
      record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
      return;
    }

    const targetPoint = buildApproachPoint(
      target,
      `${record.seed}:leg:${record.legIndex}`,
      this._config.arrivalDistanceMeters,
    );
    const warpResult = dependencies.npcRuntime.warpToPoint(entityID, targetPoint, {
      targetEntityID: target.itemID,
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      useNativeWarpProfile: true,
      suppressCompletionStopUpdates: true,
      scheduleWake: false,
      ingressDurationMs: 2500,
      visibilitySuppressMs: 250,
    });
    if (!warpResult || warpResult.success !== true) {
      record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
      log.warn(
        `[${MOD_ID}] route warp failed entity=${entityID} system=${scene.systemID} ` +
        `reason=${warpResult && warpResult.errorMsg || "UNKNOWN"}`,
      );
      return;
    }

    record.phase = "traveling";
    record.targetPoint = targetPoint;
    record.legStartedAtMs = nowMs;
    record.legDeadlineAtMs = nowMs + Math.max(
      120000,
      this._config.virtualTravelMs * LEG_DEADLINE_MULTIPLIER,
    );
    record.nextActionAtMs = nowMs + 5000;
    log.debug(
      `[${MOD_ID}] route leg entity=${entityID} system=${scene.systemID} ` +
      `destination=${record.destinationAnchorName}`,
    );
  }

  _enterDwell(record, scene, nowMs, dependencies) {
    const entityID = currentEntityID(record);
    const target = scene.getEntityByID(positive(record.destinationAnchorID, 0));
    if (entityID && target) {
      const orbitResult = dependencies.npcRuntime.orbit(
        entityID,
        target.itemID,
        this._config.orbitDistanceMeters,
        {wakeController: false},
      );
      if (!orbitResult || orbitResult.success !== true) {
        log.debug(`[${MOD_ID}] dwell orbit unavailable entity=${entityID}`);
      }
    }
    record.phase = "dwell";
    record.nextActionAtMs = nowMs + this._config.dwellTimeMs;
  }

  _beginGateTransit(record, nowMs, dependencies) {
    const entityID = currentEntityID(record);
    if (entityID) {
      this._despawnRecord(record, {broadcast: true}, dependencies);
    }
    const destinationSystemID = normalizeSystemID(record.destinationSystemID);
    const destinationGateID = positive(record.destinationGateID, record.destinationAnchorID);
    if (!destinationSystemID || !destinationGateID) {
      this._records.delete(record.trafficID);
      return;
    }

    record.systemID = destinationSystemID;
    record.currentAnchorID = destinationGateID;
    record.currentAnchorName = "Destination stargate";
    record.destinationAnchorID = 0;
    record.destinationAnchorName = "";
    record.destinationSystemID = destinationSystemID;
    record.destinationGateID = 0;
    record.routeKind = "local";
    record.phase = "virtual";
    record.nextActionAtMs = nowMs + this._config.virtualTravelMs;
    record.expiresAtMs = nowMs + this._config.shipLifetimeMs;
    log.info(
      `[${MOD_ID}] gate transit traffic=${record.trafficID} destinationSystem=${destinationSystemID}`,
    );
  }

  _virtualizeInactiveRecords(activeScenes, nowMs) {
    for (const record of this._records.values()) {
      const entityID = currentEntityID(record);
      if (!entityID) {
        continue;
      }
      const scene = activeScenes.get(normalizeSystemID(record.systemID));
      if (scene) {
        continue;
      }

      this._despawnRecord(record, {broadcast: false});
      if (record.routeKind === "cross-system" && normalizeSystemID(record.destinationSystemID) !== record.systemID) {
        record.systemID = normalizeSystemID(record.destinationSystemID);
        record.currentAnchorID = positive(record.destinationGateID, record.destinationAnchorID);
        record.currentAnchorName = "Destination stargate";
        record.destinationAnchorID = 0;
        record.destinationAnchorName = "";
        record.destinationSystemID = record.systemID;
        record.destinationGateID = 0;
        record.routeKind = "local";
      } else {
        record.currentAnchorID = positive(record.destinationAnchorID, record.currentAnchorID);
        record.currentAnchorName = record.destinationAnchorName || record.currentAnchorName;
        record.destinationAnchorID = 0;
        record.destinationAnchorName = "";
        record.destinationSystemID = record.systemID;
        record.destinationGateID = 0;
        record.routeKind = "local";
      }
      record.phase = "virtual";
      record.nextActionAtMs = nowMs + this._config.virtualTravelMs;
      record.expiresAtMs = nowMs + this._config.shipLifetimeMs;
    }
  }

  _removeExpiredRecords(nowMs) {
    for (const record of [...this._records.values()]) {
      if (record.expiresAtMs > nowMs) {
        continue;
      }
      this._despawnRecord(record, {broadcast: false});
      this._records.delete(record.trafficID);
    }
  }

  _despawnRecord(record, options = {}, dependencies = null) {
    const entityID = currentEntityID(record);
    record.liveEntityID = 0;
    if (!entityID) {
      return true;
    }
    const resolvedDependencies = dependencies || getRuntimeDependencies();
    const result = resolvedDependencies.npcRuntime.despawn(entityID, {
      removeContents: true,
      broadcast: options.broadcast === true,
    });
    if (!result || result.success !== true) {
      log.debug(
        `[${MOD_ID}] despawn skipped entity=${entityID} ` +
        `reason=${result && result.errorMsg || "UNKNOWN"}`,
      );
      return false;
    }
    return true;
  }

  _totalLiveRecords() {
    let count = 0;
    for (const record of this._records.values()) {
      if (currentEntityID(record)) {
        count += 1;
      }
    }
    return count;
  }
}

module.exports = AmbientNpcTrafficService;
module.exports._testing = {
  BEHAVIOR_OVERRIDES,
  buildTrafficID,
  buildTrafficSeed,
  entityIsWarping,
  isActiveScene,
};
