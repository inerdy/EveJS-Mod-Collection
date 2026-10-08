"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const log = require(serverPath("utils", "logger"));
const {loadConfig} = require("./config");

const MOD_ID = "serverHealthMonitor";
const SERVICE_NAME = MOD_ID;
const GM_ROLE_MASK =
  274877906944n | // GMS
  9007199254740992n | // GMH
  18014398509481984n | // GML
  72057594037927936n; // Admin

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, finite(value, fallback));
}

function rounded(value) {
  return Math.round(nonNegative(value, 0) * 10) / 10;
}

function statusRank(status) {
  if (status === "stalled") return 2;
  if (status === "degraded") return 1;
  return 0;
}

function normalizeRoleValue(value) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value.trim());
    if (value && typeof value === "object" && (value.type === "long" || value.type === "int")) {
      return normalizeRoleValue(value.value);
    }
  } catch (_error) {
    return 0n;
  }
  return 0n;
}

function hasGMAccess(session) {
  if (!session || typeof session !== "object") return false;
  const role = normalizeRoleValue(
    session.accountRole ?? session.role ?? session.rolesAtAll,
  );
  return (role & GM_ROLE_MASK) !== 0n;
}

function classifyStatus({
  eventLoopDelayMs = 0,
  tickDurationMs = null,
  tickLatenessMs = null,
  thresholds,
} = {}) {
  const settings = thresholds || {};
  if (
    eventLoopDelayMs >= settings.stalledEventLoopDelayMs ||
    tickDurationMs !== null && tickDurationMs >= settings.stalledTickDurationMs ||
    tickLatenessMs !== null && tickLatenessMs >= settings.stalledTickLatenessMs
  ) {
    return "stalled";
  }
  if (
    eventLoopDelayMs >= settings.degradedEventLoopDelayMs ||
    tickDurationMs !== null && tickDurationMs >= settings.degradedTickDurationMs ||
    tickLatenessMs !== null && tickLatenessMs >= settings.degradedTickLatenessMs
  ) {
    return "degraded";
  }
  return "healthy";
}

function metricAverage(samples, field) {
  const values = samples
    .map((sample) => Number(sample && sample[field]))
    .filter((value) => Number.isFinite(value));
  return values.length > 0
    ? rounded(values.reduce((total, value) => total + value, 0) / values.length)
    : null;
}

function metricMaximum(samples, field) {
  const values = samples
    .map((sample) => Number(sample && sample[field]))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? rounded(Math.max(...values)) : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class HealthMonitorService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._database = options.database || database;
    this._dataDir = options.dataDir || this._resolveDataDir();
    this._logPath = path.join(this._dataDir, "serverHealthMonitor", "health-events.jsonl");
    this._runtime = options.runtime || null;
    this._history = [];
    this._timer = null;
    this._lastSampleAtMs = 0;
    this._nextSampleAtMs = 0;
    this._lastCpuUsage = null;
    this._lastStatus = null;
    this._statusSinceMs = 0;
    this._incidentStartedAtMs = 0;
    this._lastHealthyAtMs = 0;
    this._lastRuntimeLookupAtMs = 0;
    this._runtimeLookupErrorLogged = false;
    if (this._config.enabled && options.autoStart !== false) {
      this._start();
    }
  }

  _resolveDataDir() {
    return this._database && this._database._dataDir
      ? this._database._dataDir
      : path.join(REPO_ROOT, "_local");
  }

  _start() {
    if (this._timer) return;
    this._sample();
    this._nextSampleAtMs = Date.now() + this._config.sampleIntervalMs;
    this._timer = setInterval(() => this._sample(), this._config.sampleIntervalMs);
    if (this._timer && typeof this._timer.unref === "function") {
      this._timer.unref();
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return true;
  }

  getStatus() {
    const snapshot = this.getHealthStatus();
    return {
      enabled: this._config.enabled,
      status: snapshot.status,
      currentLagMs: snapshot.current.currentLagMs,
      peakLagMs: snapshot.performance.peakLagMs,
      historySamples: snapshot.history.length,
    };
  }

  Handle_GetStatus(_args, session) {
    if (!hasGMAccess(session)) {
      throw new Error("SERVER_HEALTH_MONITOR_GM_ONLY");
    }
    return JSON.stringify(this.getStatus());
  }

  Handle_GetHealthStatus(_args, session) {
    if (!hasGMAccess(session)) {
      throw new Error("SERVER_HEALTH_MONITOR_GM_ONLY");
    }
    return JSON.stringify(this.getHealthStatus());
  }

  _readRuntime() {
    if (this._runtime) return this._runtime;
    const nowMs = Date.now();
    if (nowMs - this._lastRuntimeLookupAtMs < 1000) return null;
    this._lastRuntimeLookupAtMs = nowMs;
    try {
      const runtimePath = require.resolve(serverPath("space", "runtime"));
      const cached = require.cache[runtimePath];
      if (cached && cached.exports) {
        this._runtime = cached.exports;
      }
    } catch (error) {
      if (!this._runtimeLookupErrorLogged) {
        this._runtimeLookupErrorLogged = true;
        log.debug(`[${MOD_ID}] runtime metrics unavailable: ${error.message}`);
      }
    }
    return this._runtime;
  }

  _runtimeSample() {
    const runtime = this._readRuntime();
    const getLastRuntimeTickSummary = runtime && typeof runtime.getLastRuntimeTickSummary === "function"
      ? runtime.getLastRuntimeTickSummary.bind(runtime)
      : runtime && runtime._testing && typeof runtime._testing.getLastRuntimeTickSummary === "function"
        ? runtime._testing.getLastRuntimeTickSummary.bind(runtime._testing)
        : null;
    if (!runtime || !getLastRuntimeTickSummary) {
      return {available: false, sessions: null, sceneCount: null, tickedSceneCount: null};
    }
    let summary = null;
    try {
      summary = getLastRuntimeTickSummary();
    } catch (error) {
      log.debug(`[${MOD_ID}] runtime tick summary read failed: ${error.message}`);
    }
    let sessions = null;
    if (runtime.scenes instanceof Map) {
      sessions = 0;
      for (const scene of runtime.scenes.values()) {
        if (scene && scene.sessions instanceof Map) sessions += scene.sessions.size;
      }
    }
    if (!summary) {
      return {available: false, sessions, sceneCount: runtime.scenes instanceof Map ? runtime.scenes.size : null, tickedSceneCount: null};
    }
    return {
      available: true,
      tickDurationMs: rounded(summary.tickDurationMs),
      tickLatenessMs: rounded(summary.latenessMs),
      actualIntervalMs: rounded(summary.actualIntervalMs),
      targetTickIntervalMs: rounded(summary.targetTickIntervalMs),
      sceneCount: nonNegative(summary.sceneCount, 0),
      tickedSceneCount: nonNegative(summary.tickedSceneCount, 0),
      sessions,
    };
  }

  _processSample(elapsedMs) {
    const memory = typeof process.memoryUsage === "function" ? process.memoryUsage() : {};
    let cpuPercent = 0;
    if (this._lastCpuUsage) {
      const delta = process.cpuUsage(this._lastCpuUsage);
      cpuPercent = ((delta.user + delta.system) / Math.max(1, elapsedMs * 1000)) * 100;
    }
    this._lastCpuUsage = process.cpuUsage();
    return {
      cpuPercent: rounded(cpuPercent),
      memoryRssMb: rounded(nonNegative(memory.rss, 0) / (1024 * 1024)),
      memoryHeapUsedMb: rounded(nonNegative(memory.heapUsed, 0) / (1024 * 1024)),
    };
  }

  _logTransition(sample, previousStatus) {
    const status = sample.status;
    if (previousStatus === status) return;
    const isRecovery = status === "healthy" && previousStatus && previousStatus !== "healthy";
    if (!isRecovery && status === "healthy") return;
    const record = {
      time: sample.timestamp,
      event: isRecovery ? "recovered" : status,
      previousStatus: previousStatus || null,
      status,
      durationMs: isRecovery && this._incidentStartedAtMs
        ? Math.max(0, sample.timestampMs - this._incidentStartedAtMs)
        : null,
      currentLagMs: sample.currentLagMs,
      eventLoopDelayMs: sample.eventLoopDelayMs,
      tickDurationMs: sample.tickDurationMs,
      tickLatenessMs: sample.tickLatenessMs,
      cpuPercent: sample.cpuPercent,
      memoryRssMb: sample.memoryRssMb,
      sceneCount: sample.sceneCount,
      sessions: sample.sessions,
    };
    if (this._config.logging.enabled) {
      try {
        fs.mkdirSync(path.dirname(this._logPath), {recursive: true});
        if (fs.existsSync(this._logPath)) {
          const size = fs.statSync(this._logPath).size;
          if (size >= this._config.logging.maxBytes) {
            const rotatedPath = `${this._logPath}.1`;
            try {
              if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
              fs.renameSync(this._logPath, rotatedPath);
            } catch (rotateError) {
              log.debug(`[${MOD_ID}] incident log rotation failed: ${rotateError.message}`);
            }
          }
        }
        fs.appendFileSync(this._logPath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (error) {
        log.warn(`[${MOD_ID}] incident log write failed: ${error.message}`);
      }
    }
  }

  _sample() {
    if (!this._config.enabled) return null;
    const nowMs = Date.now();
    const elapsedMs = this._lastSampleAtMs > 0
      ? Math.max(1, nowMs - this._lastSampleAtMs)
      : this._config.sampleIntervalMs;
    const expectedAtMs = this._nextSampleAtMs || nowMs;
    const eventLoopDelayMs = this._nextSampleAtMs
      ? Math.max(0, nowMs - expectedAtMs)
      : 0;
    this._nextSampleAtMs = nowMs + this._config.sampleIntervalMs;
    const runtime = this._runtimeSample();
    const processSample = this._processSample(elapsedMs);
    const tickDurationMs = runtime.available ? runtime.tickDurationMs : null;
    const tickLatenessMs = runtime.available ? runtime.tickLatenessMs : null;
    const currentLagMs = rounded(Math.max(
      eventLoopDelayMs,
      finite(tickLatenessMs, 0),
    ));
    const status = classifyStatus({
      eventLoopDelayMs,
      tickDurationMs,
      tickLatenessMs,
      thresholds: this._config.thresholds,
    });
    const sample = {
      timestamp: new Date(nowMs).toISOString(),
      timestampMs: nowMs,
      status,
      currentLagMs,
      eventLoopDelayMs: rounded(eventLoopDelayMs),
      tickDurationMs,
      tickLatenessMs,
      actualIntervalMs: runtime.actualIntervalMs === undefined ? null : runtime.actualIntervalMs,
      targetTickIntervalMs: runtime.targetTickIntervalMs === undefined ? null : runtime.targetTickIntervalMs,
      sceneCount: runtime.sceneCount,
      tickedSceneCount: runtime.tickedSceneCount,
      sessions: runtime.sessions,
      ...processSample,
    };
    this._history.push(sample);
    const maximumSamples = Math.max(
      60,
      Math.min(600, Math.ceil((this._config.historyMinutes * 60000) / this._config.sampleIntervalMs) + 1),
    );
    while (this._history.length > maximumSamples) this._history.shift();
    const previousStatus = this._lastStatus;
    if (status !== previousStatus) {
      this._statusSinceMs = nowMs;
    }
    if (status === "healthy") {
      this._lastHealthyAtMs = nowMs;
    } else if (!this._incidentStartedAtMs) {
      this._incidentStartedAtMs = nowMs;
    }
    this._logTransition(sample, previousStatus);
    if (status === "healthy" && previousStatus && previousStatus !== "healthy") {
      this._incidentStartedAtMs = 0;
    }
    this._lastStatus = status;
    this._lastSampleAtMs = nowMs;
    return sample;
  }

  getHealthStatus() {
    const history = this._history.slice();
    const latest = history[history.length - 1] || {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      status: this._config.enabled ? "healthy" : "healthy",
      currentLagMs: 0,
      eventLoopDelayMs: 0,
      tickDurationMs: null,
      tickLatenessMs: null,
      cpuPercent: 0,
      memoryRssMb: 0,
      memoryHeapUsedMb: 0,
      sceneCount: null,
      tickedSceneCount: null,
      sessions: null,
    };
    const finiteSamples = history.length > 0 ? history : [latest];
    const nowMs = Date.now();
    return clone({
      schemaVersion: 1,
      enabled: this._config.enabled,
      status: latest.status,
      statusSinceMs: this._statusSinceMs || latest.timestampMs,
      current: {
        currentLagMs: latest.currentLagMs,
        eventLoopDelayMs: latest.eventLoopDelayMs,
        tickDurationMs: latest.tickDurationMs,
        tickLatenessMs: latest.tickLatenessMs,
        cpuPercent: latest.cpuPercent,
        memoryRssMb: latest.memoryRssMb,
        memoryHeapUsedMb: latest.memoryHeapUsedMb,
        sceneCount: latest.sceneCount,
        tickedSceneCount: latest.tickedSceneCount,
        sessions: latest.sessions,
      },
      performance: {
        peakLagMs: metricMaximum(finiteSamples, "currentLagMs"),
        averageEventLoopDelayMs: metricAverage(finiteSamples, "eventLoopDelayMs"),
        worstEventLoopDelayMs: metricMaximum(finiteSamples, "eventLoopDelayMs"),
        averageTickDurationMs: metricAverage(finiteSamples, "tickDurationMs"),
        worstTickDurationMs: metricMaximum(finiteSamples, "tickDurationMs"),
        averageTickLatenessMs: metricAverage(finiteSamples, "tickLatenessMs"),
        worstTickLatenessMs: metricMaximum(finiteSamples, "tickLatenessMs"),
        sampleCount: history.length,
        historyMinutes: this._config.historyMinutes,
      },
      heartbeat: {
        lastHealthyAtMs: this._lastHealthyAtMs || null,
        timeSinceHealthyMs: this._lastHealthyAtMs
          ? Math.max(0, nowMs - this._lastHealthyAtMs)
          : null,
        lastSampleAtMs: this._lastSampleAtMs || null,
      },
      thresholds: this._config.thresholds,
      logPath: this._logPath,
      history: history.slice(-180),
    });
  }
}

module.exports = HealthMonitorService;
module.exports._testing = {
  classifyStatus,
  hasGMAccess,
  metricAverage,
  metricMaximum,
  statusRank,
};
