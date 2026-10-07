"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const log = require(serverPath("utils", "logger"));
const {loadConfig} = require(path.join(__dirname, "config"));

const MOD_ID = "ambientNpcMining";

let runtimeDependencies = null;

function getRuntimeDependencies() {
  if (runtimeDependencies) {
    return runtimeDependencies;
  }
  runtimeDependencies = Object.freeze({
    miningCommandService: require(serverPath(
      "services",
      "mining",
      "miningCommandService",
    )),
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

function hasAsteroidField(scene) {
  return Boolean(
    scene &&
    Array.isArray(scene.staticEntities) &&
    scene.staticEntities.some((entity) => (
      entity &&
      String(entity.kind || "").trim().toLowerCase() === "asteroid" &&
      entity.position
    )),
  );
}

function shouldSpawnForRoll(roll, chance) {
  return finite(roll, 1) < Math.max(0, Math.min(1, finite(chance, 0)));
}

function getSessionCharacterID(session) {
  return positive(session && (session.characterID || session.charid), 0);
}

function getRepresentativeSession(scene) {
  if (!scene || !(scene.sessions instanceof Map)) {
    return null;
  }
  for (const session of scene.sessions.values()) {
    if (
      session &&
      getSessionCharacterID(session) > 0 &&
      session._space &&
      normalizeSystemID(session._space.systemID) === normalizeSystemID(scene.systemID)
    ) {
      return session;
    }
  }
  return null;
}

function buildAmbientSession(session) {
  if (!session || !session._space) {
    return null;
  }
  return {
    ...session,
    _space: {
      ...session._space,
      // The shared mining handler uses a zero ship ID to choose the first
      // unscoped asteroid instead of centering the ambient fleet on a player.
      shipID: 0,
    },
  };
}

function fleetIDOf(record) {
  return positive(record && record.fleetID, 0);
}

class AmbientNpcMiningService extends BaseService {
  constructor() {
    super("ambientNpcMining");
    this._config = loadConfig();
    this._ticker = null;
    this._initialTimer = null;
    this._tickInProgress = false;
    this._lastTickAtMs = 0;
    this._ambientFleetIDs = new Set();
    this._trackedFleetSystemIDs = new Map();
    this._lastEndedAtBySystem = new Map();

    if (this._config.enabled) {
      this._startTicker();
    }
  }

  _startTicker() {
    if (this._ticker || this._initialTimer) {
      return;
    }
    const start = () => {
      this._initialTimer = null;
      if (!this._config.enabled) {
        return;
      }
      this.tick();
      this._ticker = setInterval(() => {
        this.tick();
      }, this._config.tickIntervalMs);
      if (this._ticker && typeof this._ticker.unref === "function") {
        this._ticker.unref();
      }
    };
    this._initialTimer = setTimeout(start, this._config.initialDelayMs);
    if (this._initialTimer && typeof this._initialTimer.unref === "function") {
      this._initialTimer.unref();
    }
  }

  stop() {
    if (this._initialTimer) {
      clearTimeout(this._initialTimer);
      this._initialTimer = null;
    }
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
    this._ambientFleetIDs.clear();
    this._trackedFleetSystemIDs.clear();
    this._lastEndedAtBySystem.clear();
    return true;
  }

  getStatus() {
    return {
      enabled: this._config.enabled,
      trackedFleetCount: this._ambientFleetIDs.size,
      cooldownSystems: this._lastEndedAtBySystem.size,
      maxFleetsPerSystem: this._config.maxFleetsPerSystem,
      maxFleetsGlobal: this._config.maxFleetsGlobal,
      spawnChance: this._config.spawnChance,
      tickIntervalMs: this._config.tickIntervalMs,
    };
  }

  _activeScenes(spaceRuntime) {
    const activeScenes = new Map();
    if (
      !spaceRuntime ||
      !spaceRuntime.scenes ||
      typeof spaceRuntime.scenes.values !== "function"
    ) {
      return activeScenes;
    }
    for (const scene of spaceRuntime.scenes.values()) {
      if (isActiveScene(scene)) {
        activeScenes.set(normalizeSystemID(scene.systemID), scene);
      }
    }
    return activeScenes;
  }

  _isAllowedSystem(systemID) {
    return (
      this._config.allowedSystemIDs.length === 0 ||
      this._config.allowedSystemIDs.includes(normalizeSystemID(systemID))
    );
  }

  _getFleetRecords(systemID, dependencies) {
    const service = dependencies.miningCommandService;
    if (!service || typeof service.getMiningFleetsForSystem !== "function") {
      return [];
    }
    const records = service.getMiningFleetsForSystem(systemID);
    return (Array.isArray(records) ? records : [])
      .map((record) => (
        typeof service.pruneMiningFleet === "function"
          ? service.pruneMiningFleet(record)
          : record
      ))
      .filter(Boolean);
  }

  _countActiveFleets(activeScenes, dependencies) {
    let count = 0;
    const seenFleetIDs = new Set();
    for (const scene of activeScenes.values()) {
      for (const record of this._getFleetRecords(scene.systemID, dependencies)) {
        const fleetID = fleetIDOf(record);
        if (fleetID > 0 && !seenFleetIDs.has(fleetID)) {
          seenFleetIDs.add(fleetID);
          count += 1;
        }
      }
    }
    return count;
  }

  _reconcileTrackedFleets(nowMs, dependencies) {
    for (const fleetID of [...this._ambientFleetIDs]) {
      let found = false;
      for (const scene of dependencies.spaceRuntime.scenes.values()) {
        if (
          this._getFleetRecords(scene.systemID, dependencies)
            .some((record) => fleetIDOf(record) === fleetID)
        ) {
          found = true;
          break;
        }
      }
      if (found) {
        continue;
      }
      this._ambientFleetIDs.delete(fleetID);
      const systemID = this._trackedFleetSystemIDs.get(fleetID);
      if (systemID > 0) {
        this._lastEndedAtBySystem.set(systemID, nowMs);
      }
      this._trackedFleetSystemIDs.delete(fleetID);
    }
  }

  _spawnFleet(scene, nowMs, dependencies) {
    const representativeSession = getRepresentativeSession(scene);
    const ambientSession = buildAmbientSession(representativeSession);
    if (!ambientSession) {
      return false;
    }

    const before = new Set(
      this._getFleetRecords(scene.systemID, dependencies).map(fleetIDOf),
    );
    const query = this._config.minerCommandQuery;
    const command = query ? `1 ${query}` : "1";
    const result = dependencies.miningCommandService.handleMiningFleetCommand(
      ambientSession,
      command,
    );
    if (!result || result.success !== true) {
      log.warn(
        `[${MOD_ID}] spawn failed system=${scene.systemID} ` +
        `reason=${result && result.message || "UNKNOWN"}`,
      );
      return false;
    }

    const createdRecord = this._getFleetRecords(scene.systemID, dependencies)
      .find((record) => !before.has(fleetIDOf(record)));
    if (!createdRecord || fleetIDOf(createdRecord) <= 0) {
      log.warn(`[${MOD_ID}] spawn succeeded without a tracked fleet system=${scene.systemID}`);
      return false;
    }

    const fleetID = fleetIDOf(createdRecord);
    this._ambientFleetIDs.add(fleetID);
    this._trackedFleetSystemIDs.set(fleetID, normalizeSystemID(scene.systemID));
    log.info(
      `[${MOD_ID}] spawned fleet=${fleetID} system=${scene.systemID} ` +
      `miners=${Array.isArray(createdRecord.minerEntityIDs) ? createdRecord.minerEntityIDs.length : 0} ` +
      `haulers=${Array.isArray(createdRecord.haulerEntityIDs) ? createdRecord.haulerEntityIDs.length : 0}`,
    );
    return true;
  }

  _considerScene(scene, nowMs, activeFleetCount, dependencies) {
    const systemID = normalizeSystemID(scene.systemID);
    if (!systemID || !this._isAllowedSystem(systemID)) {
      return activeFleetCount;
    }

    const records = this._getFleetRecords(systemID, dependencies);
    if (records.length >= this._config.maxFleetsPerSystem) {
      return activeFleetCount;
    }
    if (!hasAsteroidField(scene)) {
      return activeFleetCount;
    }
    const cooldownStartedAt = finite(this._lastEndedAtBySystem.get(systemID), 0);
    if (
      cooldownStartedAt > 0 &&
      nowMs - cooldownStartedAt < this._config.respawnCooldownMs
    ) {
      return activeFleetCount;
    }
    if (activeFleetCount >= this._config.maxFleetsGlobal) {
      return activeFleetCount;
    }
    if (!shouldSpawnForRoll(Math.random(), this._config.spawnChance)) {
      return activeFleetCount;
    }

    return this._spawnFleet(scene, nowMs, dependencies)
      ? activeFleetCount + 1
      : activeFleetCount;
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
      this._reconcileTrackedFleets(this._lastTickAtMs, dependencies);
      let activeFleetCount = this._countActiveFleets(activeScenes, dependencies);
      for (const scene of activeScenes.values()) {
        activeFleetCount = this._considerScene(
          scene,
          this._lastTickAtMs,
          activeFleetCount,
          dependencies,
        );
      }
    } catch (error) {
      log.warn(`[${MOD_ID}] tick failed: ${error.message}`);
    } finally {
      this._tickInProgress = false;
    }
    return this.getStatus();
  }
}

module.exports = AmbientNpcMiningService;
module.exports._testing = {
  buildAmbientSession,
  getRepresentativeSession,
  hasAsteroidField,
  isActiveScene,
  shouldSpawnForRoll,
};
