"use strict";

const BaseService = require(require("./runtime").serverPath("services", "baseService"));
const log = require(require("./runtime").serverPath("utils", "logger"));
const {loadConfig} = require("./config");
const {
  GATE_JUMP_LANDING_MAX_METERS,
  GATE_JUMP_LANDING_MIN_METERS,
  WARP_EXIT_SCATTER_MAX_METERS,
  buildApproachPoint,
  buildInlineGateExitPoint,
  buildRoutePlan,
  canStartWarp,
  choose,
  chooseGateLanding,
  distanceSquared,
  isHaulerProfile,
  isWarpEntryReady,
  isWithinGateJumpRange,
  listActiveWarpPointFamilies,
  listAnchors,
  shipHasWarpCoreStabilizer,
  warpDepartureDenial,
} = require("./routeEngine");
const {getRuntimeDependencies, serverPath} = require("./runtime");
const {loadHaulerCargo} = require("./cargoOps");
const {noteMissingEntity} = require("./wreckLoot");
const {installWarpOverviewHook, installWreckLootHook} = require("./hooks");
const {playJumpOut, playSpawnPresentation} = require("./trafficFx");
const {
  ARRIVAL_TOLERANCE_MULTIPLIER,
  BEHAVIOR_OVERRIDES,
  FALLBACK_PROFILE_ID,
  GATE_APPROACH_POLL_MS,
  GATE_APPROACH_TIMEOUT_MS,
  GATE_JUMP_ANIMATION_MS,
  HAULER_ALIGN_POLL_MS,
  HAULER_ALIGN_TIMEOUT_MS,
  LEG_DEADLINE_MULTIPLIER,
  MIN_WARP_DISTANCE_METERS,
  MOD_ID,
} = require("./constants");
const {
  buildTrafficID,
  buildTrafficSeed,
  currentEntityID,
  entityIsWarping,
  finite,
  isActiveScene,
  normalizeSystemID,
  positive,
} = require("./util");

class AmbientNpcTrafficService extends BaseService {
  constructor() {
    super("ambientNpcTraffic");
    this._config = loadConfig();
    this._records = new Map();
    this._seenSystems = new Set();
    this._lastSpawnAtBySystem = new Map();
    this._sequence = 0;
    this._cargoCatalog = null;
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
      installWreckLootHook(this);
      installWarpOverviewHook(this);
      const activeScenes = this._activeScenes(dependencies.spaceRuntime);
      for (const scene of activeScenes.values()) {
        this._tickActiveScene(scene, this._lastTickAtMs, dependencies);
      }
      this._virtualizeInactiveRecords(activeScenes, this._lastTickAtMs);
      this._removeExpiredRecords(this._lastTickAtMs);
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

  _liveRecordsForSystem(systemID, scene, dependencies) {
    return this._recordsForSystem(systemID).filter((record) => {
      const entityID = currentEntityID(record);
      if (!entityID) {
        return false;
      }
      if (scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(entityID)) {
        return true;
      }
      const outcome = noteMissingEntity(
        record,
        scene,
        entityID,
        this._lastTickAtMs,
        dependencies,
      );
      if (outcome === "wait") {
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
    const liveRecords = this._liveRecordsForSystem(systemID, scene, dependencies);
    const targetCount = Math.min(
      this._config.maxShipsPerSystem,
      this._config.shipsPerActiveSystem,
    );
    const initialCount = Math.min(
      targetCount,
      this._config.initialShipsPerActiveSystem,
    );
    const firstVisit = !this._seenSystems.has(systemID);
    const desiredCount = firstVisit ? initialCount : targetCount;
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
      gateAction: null,
      postJumpHoldMs: 0,
      approachDeadlineAtMs: 0,
      legStartedAtMs: 0,
      legDeadlineAtMs: 0,
      legIndex: 0,
      hasWarpCoreStabilizer: shipHasWarpCoreStabilizer(seed),
      cargoLoaded: false,
      cargoAttempts: 0,
      warpHoldReason: null,
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
        visualOnly: false,
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

    entity.ambientNpcTraffic = true;
    entity.ambientNpcTrafficID = record.trafficID;
    entity.visualOnly = false;
    entity.targetable = true;
    entity.lockable = true;
    record.pendingWreckCargo = null;
    record.wreckLootDeposited = false;
    if (isHaulerProfile(record.profileID)) {
      loadHaulerCargo(this, entity, record, dependencies);
    }

    const postJumpHoldMs = Math.max(0, Math.trunc(finite(record.postJumpHoldMs, 0)));
    record.liveEntityID = entityID;
    record.systemID = normalizeSystemID(scene.systemID);
    record.phase = "queued";
    record.removedByTraffic = false;
    record.wreckWaitUntilMs = 0;
    record.wreckLootDeposited = false;
    record.postJumpHoldMs = 0;
    record.nextActionAtMs = nowMs + (postJumpHoldMs > 0 ? postJumpHoldMs : 1000);
    playSpawnPresentation(scene, entity, {jumpArrival: postJumpHoldMs > 0});
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
      const outcome = noteMissingEntity(record, scene, entityID, nowMs, dependencies);
      if (outcome === "wait") {
        record.nextActionAtMs = nowMs + 1000;
        return;
      }
      record.liveEntityID = 0;
      record.phase = "virtual";
      record.nextActionAtMs = nowMs + this._config.virtualTravelMs;
      return;
    }

    entity.ambientNpcTraffic = true;
    entity.ambientNpcTrafficID = record.trafficID;
    entity.visualOnly = false;
    entity.targetable = true;
    entity.lockable = true;
    if (
      isHaulerProfile(record.profileID) &&
      record.cargoLoaded !== true &&
      finite(record.cargoAttempts, 0) < 3
    ) {
      loadHaulerCargo(this, entity, record, dependencies);
    }

    if (record.expiresAtMs <= nowMs) {
      this._despawnRecord(record, {broadcast: true}, dependencies);
      this._records.delete(record.trafficID);
      return;
    }
    if (record.nextActionAtMs > nowMs) {
      return;
    }

    if (record.phase === "aligning") {
      this._tickHaulerAlign(record, scene, entity, nowMs, dependencies);
      return;
    }
    if (record.phase === "queued" || record.phase === "virtual" || record.phase === "warp-ready") {
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
        this._handleArrival(record, scene, entity, nowMs, dependencies);
      }
      return;
    }
    if (record.phase === "approaching") {
      this._tickGateApproach(record, scene, entity, nowMs, dependencies);
      return;
    }
    if (record.phase === "jumping") {
      this._finishGateTransit(record, nowMs, dependencies);
      return;
    }
    if (record.phase === "dwell") {
      if (nowMs < record.nextActionAtMs) {
        return;
      }
      if (record.routeKind === "cross-system") {
        this._commitGateTransit(record, scene, nowMs, dependencies);
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

    const entity = scene.getEntityByID(entityID);
    let targetPoint = record.targetPoint;
    let stopDistance = finite(record.pendingStopDistance, 0);
    if (record.phase !== "warp-ready" || !targetPoint) {
      const warpTarget = this._resolveWarpTarget(record, entity, target, dependencies);
      targetPoint = warpTarget.targetPoint;
      stopDistance = warpTarget.stopDistance;
      record.targetPoint = targetPoint;
      record.pendingStopDistance = stopDistance;
    }
    if (
      record.gateAction &&
      entity &&
      !canStartWarp(entity.position, targetPoint, MIN_WARP_DISTANCE_METERS)
    ) {
      record.phase = "queued";
      this._handleArrival(record, scene, entity, nowMs, dependencies);
      return;
    }

    if (isHaulerProfile(record.profileID) && entity && record.phase !== "warp-ready") {
      this._beginHaulerAlign(record, scene, entity, targetPoint, nowMs, dependencies);
      return;
    }

    const denial = entity ? this._warpDepartureDenial(record, scene, entity) : null;
    if (denial) {
      this._holdWarpDeparture(record, scene, entity, targetPoint, nowMs, dependencies, denial);
      return;
    }

    const warpResult = this._requestWarp(
      record,
      scene,
      entity,
      entityID,
      target,
      targetPoint,
      stopDistance,
      dependencies,
    );
    if (warpResult && warpResult.nativeGotoFallback === true && record.gateAction) {
      record.targetPoint = targetPoint;
      this._beginGateApproach(record, scene, entity, nowMs, dependencies);
      return;
    }
    if (!warpResult || warpResult.success !== true) {
      if (
        record.gateAction &&
        entity &&
        warpResult &&
        warpResult.errorMsg === "WARP_DISTANCE_TOO_CLOSE"
      ) {
        this._handleArrival(record, scene, entity, nowMs, dependencies);
        return;
      }
      if (entity && warpResult && warpResult.errorMsg === "WARP_DISRUPTED_BY_BUBBLE") {
        this._holdWarpDeparture(record, scene, entity, targetPoint, nowMs, dependencies, "bubble");
        return;
      }
      record.nextActionAtMs = nowMs + this._config.spawnIntervalMs;
      log.warn(
        `[${MOD_ID}] route warp failed entity=${entityID} system=${scene.systemID} ` +
        `reason=${warpResult && warpResult.errorMsg || "UNKNOWN"}`,
      );
      return;
    }

    record.phase = "traveling";
    record.warpHoldReason = null;
    record.targetPoint = targetPoint;
    record.legStartedAtMs = nowMs;
    record.legDeadlineAtMs = nowMs + Math.max(
      120000,
      this._config.virtualTravelMs * LEG_DEADLINE_MULTIPLIER,
    );
    record.nextActionAtMs = nowMs + 5000;
    log.debug(
      `[${MOD_ID}] route leg entity=${entityID} system=${scene.systemID} ` +
      `destination=${record.destinationAnchorName} gate=${record.gateAction || "none"}`,
    );
  }

  _resolveWarpTarget(record, entity, target, dependencies) {
    const gateTransit = String(target.kind || "").toLowerCase() === "stargate";
    if (!gateTransit) {
      record.gateAction = null;
      return {
        targetPoint: buildApproachPoint(
          target,
          `${record.seed}:leg:${record.legIndex}`,
          this._config.arrivalDistanceMeters,
        ),
        stopDistance: 0,
      };
    }

    record.gateAction = chooseGateLanding(`${record.seed}:gate:${record.legIndex}`);
    const gateRadius = this._gateRadius(target, dependencies);
    const approach = record.gateAction !== "jump";
    const chosenSurfaceMeters = approach
      ? this._config.gateApproachDistanceMeters
      : (GATE_JUMP_LANDING_MIN_METERS + GATE_JUMP_LANDING_MAX_METERS) / 2;
    const minSurfaceMeters = approach
      ? Math.max(0, chosenSurfaceMeters - WARP_EXIT_SCATTER_MAX_METERS)
      : GATE_JUMP_LANDING_MIN_METERS;
    const maxSurfaceMeters = approach
      ? chosenSurfaceMeters
      : GATE_JUMP_LANDING_MAX_METERS;
    return {
      targetPoint: buildInlineGateExitPoint(
        entity && entity.position,
        target.position,
        gateRadius,
        {
          chosenSurfaceMeters,
          minSurfaceMeters,
          maxSurfaceMeters,
          seed: `${record.seed}:gate-exit:${record.legIndex}:${record.gateAction}`,
        },
      ),
      stopDistance: 0,
    };
  }

  _beginHaulerAlign(record, scene, entity, targetPoint, nowMs, dependencies) {
    this._commandSubwarp(scene, entity, targetPoint, dependencies);
    record.phase = "aligning";
    record.targetPoint = targetPoint;
    record.alignDeadlineAtMs = nowMs + HAULER_ALIGN_TIMEOUT_MS;
    record.nextActionAtMs = nowMs + HAULER_ALIGN_POLL_MS;
  }

  _tickHaulerAlign(record, scene, entity, nowMs, dependencies) {
    const denial = this._warpDepartureDenial(record, scene, entity);
    if (denial) {
      this._holdWarpDeparture(
        record,
        scene,
        entity,
        record.targetPoint,
        nowMs,
        dependencies,
        denial,
      );
      return;
    }
    record.warpHoldReason = null;
    const ready = isWarpEntryReady(entity, record.targetPoint);
    if (ready || nowMs >= finite(record.alignDeadlineAtMs, 0)) {
      record.phase = "warp-ready";
      record.nextActionAtMs = nowMs;
      this._startLeg(record, scene, nowMs, dependencies);
      return;
    }
    if (String(entity.mode || "").trim().toUpperCase() !== "GOTO") {
      this._commandSubwarp(scene, entity, record.targetPoint, dependencies);
    }
    record.nextActionAtMs = nowMs + HAULER_ALIGN_POLL_MS;
  }

  _commandSubwarp(scene, entity, targetPoint, dependencies) {
    const dispatch = dependencies.destinyMovement &&
      dependencies.destinyMovement.dispatchGotoPointEntity;
    if (typeof dispatch === "function" && dispatch(scene, entity, targetPoint) === true) {
      return true;
    }
    entity.mode = "GOTO";
    entity.speedFraction = 1;
    entity.targetPoint = {
      x: finite(targetPoint && targetPoint.x, 0),
      y: finite(targetPoint && targetPoint.y, 0),
      z: finite(targetPoint && targetPoint.z, 0),
    };
    return true;
  }

  _holdWarpDeparture(record, scene, entity, targetPoint, nowMs, dependencies, reason) {
    if (record.warpHoldReason !== reason) {
      record.warpHoldReason = reason;
      log.debug(
        `[${MOD_ID}] warp held entity=${entity && entity.itemID} ` +
        `system=${scene && scene.systemID} reason=${reason}`,
      );
    }
    if (record.phase !== "aligning") {
      this._commandSubwarp(scene, entity, targetPoint, dependencies);
      record.phase = "aligning";
      record.targetPoint = targetPoint;
      record.alignDeadlineAtMs = nowMs + HAULER_ALIGN_TIMEOUT_MS;
    } else if (String(entity && entity.mode || "").trim().toUpperCase() !== "GOTO") {
      this._commandSubwarp(scene, entity, targetPoint, dependencies);
    }
    record.nextActionAtMs = nowMs + HAULER_ALIGN_POLL_MS;
  }

  _warpDepartureDenial(record, scene, entity) {
    const state = entity && entity.hostileModuleState;
    return warpDepartureDenial({
      families: listActiveWarpPointFamilies(state && state.incomingEffects),
      microwarpdriveBlocked: Boolean(state && state.microwarpdriveBlocked === true),
      inBubble: this._isInsideWarpBubble(scene, entity),
      hasWarpCoreStabilizer: record && record.hasWarpCoreStabilizer === true,
    });
  }

  _isInsideWarpBubble(scene, entity) {
    const systemID = normalizeSystemID(scene && scene.systemID);
    if (!systemID || !entity) {
      return false;
    }
    try {
      const runtime = require(serverPath("services", "ship", "mobileWarpDisruptorRuntime"));
      if (typeof runtime.findActiveWarpDisruptorForEntity !== "function") {
        return false;
      }
      return Boolean(runtime.findActiveWarpDisruptorForEntity(systemID, entity));
    } catch (error) {
      log.debug(`[${MOD_ID}] warp bubble check failed: ${error.message}`);
      return false;
    }
  }

  _requestWarp(_record, _scene, _entity, entityID, target, targetPoint, stopDistance, dependencies) {
    return dependencies.npcRuntime.warpToPoint(entityID, targetPoint, {
      targetEntityID: target.itemID,
      stopDistance: Math.max(0, finite(stopDistance, 0)),
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      useNativeWarpProfile: true,
      suppressCompletionStopUpdates: true,
      scheduleWake: false,
      ingressDurationMs: 2500,
      visibilitySuppressMs: 250,
    });
  }

  _gateRadius(gate, dependencies) {
    const resolver = dependencies &&
      dependencies.stargateRadius &&
      dependencies.stargateRadius.resolveStargatePhysicalRadius;
    if (typeof resolver === "function") {
      return Math.max(0, finite(resolver(gate), 0));
    }
    return Math.max(0, finite(gate && gate.radius, 0));
  }

  _isAtGate(entity, scene, record, dependencies) {
    const gate = typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(positive(record.destinationAnchorID, 0))
      : null;
    if (!entity || !entity.position || !gate || !gate.position) {
      return false;
    }
    return isWithinGateJumpRange(
      entity.position,
      gate.position,
      this._gateRadius(gate, dependencies),
      this._config.gateJumpRangeMeters,
    );
  }

  _ensureGateDestination(record, scene) {
    const systemID = normalizeSystemID(record.systemID);
    const destinationSystemID = normalizeSystemID(record.destinationSystemID);
    const destinationGateID = positive(record.destinationGateID, 0);
    if (destinationGateID > 0 && destinationSystemID > 0 && destinationSystemID !== systemID) {
      return true;
    }

    const gate = typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(positive(record.destinationAnchorID, 0))
      : null;
    const gateSystemID = normalizeSystemID(
      gate && (gate.destinationSolarSystemID || gate.destinationSystemID),
    );
    const gateID = positive(gate && gate.destinationID, 0);
    if (!gateSystemID || !gateID || gateSystemID === systemID) {
      return false;
    }

    record.routeKind = "cross-system";
    record.destinationSystemID = gateSystemID;
    record.destinationGateID = gateID;
    return true;
  }

  _commitGateTransit(record, scene, nowMs, dependencies) {
    if (!this._ensureGateDestination(record, scene)) {
      record.gateAction = null;
      this._enterDwell(record, scene, nowMs, dependencies);
      return;
    }
    this._startGateJump(record, scene, nowMs, dependencies);
  }

  _handleArrival(record, scene, entity, nowMs, dependencies) {
    if (record.gateAction === "jump" && this._isAtGate(entity, scene, record, dependencies)) {
      this._commitGateTransit(record, scene, nowMs, dependencies);
      return;
    }
    if (record.gateAction) {
      this._beginGateApproach(record, scene, entity, nowMs, dependencies);
      return;
    }
    this._enterDwell(record, scene, nowMs, dependencies);
  }

  _beginGateApproach(record, scene, entity, nowMs, dependencies) {
    if (entity && this._isAtGate(entity, scene, record, dependencies)) {
      this._commitGateTransit(record, scene, nowMs, dependencies);
      return;
    }

    const entityID = currentEntityID(record);
    const gateID = positive(record.destinationAnchorID, 0);
    if (entityID && gateID) {
      const followResult = dependencies.npcRuntime.follow(
        entityID,
        gateID,
        0,
        {wakeController: false},
      );
      if (!followResult || followResult.success !== true) {
        log.debug(`[${MOD_ID}] gate approach unavailable entity=${entityID}`);
      }
    }
    record.phase = "approaching";
    record.approachDeadlineAtMs = nowMs + GATE_APPROACH_TIMEOUT_MS;
    record.nextActionAtMs = nowMs + GATE_APPROACH_POLL_MS;
  }

  _tickGateApproach(record, scene, entity, nowMs, dependencies) {
    if (!entity) {
      record.liveEntityID = 0;
      record.phase = "virtual";
      record.nextActionAtMs = nowMs + this._config.virtualTravelMs;
      return;
    }
    if (
      this._isAtGate(entity, scene, record, dependencies) ||
      nowMs >= finite(record.approachDeadlineAtMs, 0)
    ) {
      this._commitGateTransit(record, scene, nowMs, dependencies);
      return;
    }
    if (String(entity.mode || "").trim().toUpperCase() !== "FOLLOW") {
      const gateID = positive(record.destinationAnchorID, 0);
      const entityID = currentEntityID(record);
      if (entityID && gateID) {
        dependencies.npcRuntime.follow(entityID, gateID, 0, {wakeController: false});
      }
    }
    record.nextActionAtMs = nowMs + GATE_APPROACH_POLL_MS;
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

  _startGateJump(record, scene, nowMs, dependencies) {
    const entityID = currentEntityID(record);
    const entity = entityID && scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    const gate = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(positive(record.destinationAnchorID, 0))
      : null;
    if (entity && gate && playJumpOut(scene, entity, gate, dependencies)) {
      record.phase = "jumping";
      record.nextActionAtMs = nowMs + GATE_JUMP_ANIMATION_MS;
      return;
    }
    this._finishGateTransit(record, nowMs, dependencies);
  }

  _finishGateTransit(record, nowMs, dependencies) {
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
    record.gateAction = null;
    record.postJumpHoldMs = this._config.gateExitDelayMs;
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
      if (record.routeKind === "cross-system" && record.gateAction === "jump") {
        const destinationSystemID = normalizeSystemID(record.destinationSystemID);
        const destinationGateID = positive(record.destinationGateID, 0);
        if (destinationSystemID && destinationGateID) {
          record.systemID = destinationSystemID;
          record.currentAnchorID = destinationGateID;
          record.currentAnchorName = "Destination stargate";
          record.destinationAnchorID = 0;
          record.destinationAnchorName = "";
          record.destinationSystemID = destinationSystemID;
          record.destinationGateID = 0;
          record.routeKind = "local";
          record.gateAction = null;
          record.postJumpHoldMs = this._config.gateExitDelayMs;
        }
      } else {
        record.currentAnchorID = positive(record.destinationAnchorID, record.currentAnchorID);
        record.currentAnchorName = record.destinationAnchorName || record.currentAnchorName;
        record.destinationAnchorID = 0;
        record.destinationAnchorName = "";
        record.destinationSystemID = record.systemID;
        record.destinationGateID = 0;
        record.routeKind = "local";
        record.gateAction = null;
        record.postJumpHoldMs = 0;
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
    record.removedByTraffic = true;
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
