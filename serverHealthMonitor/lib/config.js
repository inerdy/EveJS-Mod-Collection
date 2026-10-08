"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "health-monitor.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  sampleIntervalMs: 1000,
  historyMinutes: 5,
  transitionGraceMs: 3000,
  thresholds: {
    degradedEventLoopDelayMs: 100,
    stalledEventLoopDelayMs: 2000,
    degradedTickDurationMs: 250,
    stalledTickDurationMs: 2000,
    degradedTickLatenessMs: 100,
    stalledTickLatenessMs: 2000,
  },
  logging: {
    enabled: true,
    maxBytes: 5 * 1024 * 1024,
  },
});

function finite(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integer(value, fallback, minimum, maximum) {
  const numeric = Math.trunc(finite(value, fallback));
  return Math.max(minimum, Math.min(maximum, numeric));
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const thresholds = source.thresholds && typeof source.thresholds === "object"
    ? source.thresholds
    : {};
  const logging = source.logging && typeof source.logging === "object"
    ? source.logging
    : {};
  const degradedEventLoopDelayMs = integer(
    thresholds.degradedEventLoopDelayMs,
    DEFAULT_CONFIG.thresholds.degradedEventLoopDelayMs,
    1,
    60000,
  );
  const stalledEventLoopDelayMs = integer(
    thresholds.stalledEventLoopDelayMs,
    DEFAULT_CONFIG.thresholds.stalledEventLoopDelayMs,
    degradedEventLoopDelayMs,
    120000,
  );
  const degradedTickDurationMs = integer(
    thresholds.degradedTickDurationMs,
    DEFAULT_CONFIG.thresholds.degradedTickDurationMs,
    1,
    120000,
  );
  const stalledTickDurationMs = integer(
    thresholds.stalledTickDurationMs,
    DEFAULT_CONFIG.thresholds.stalledTickDurationMs,
    degradedTickDurationMs,
    120000,
  );
  const degradedTickLatenessMs = integer(
    thresholds.degradedTickLatenessMs,
    DEFAULT_CONFIG.thresholds.degradedTickLatenessMs,
    1,
    120000,
  );
  const stalledTickLatenessMs = integer(
    thresholds.stalledTickLatenessMs,
    DEFAULT_CONFIG.thresholds.stalledTickLatenessMs,
    degradedTickLatenessMs,
    120000,
  );
  return Object.freeze({
    enabled: source.enabled !== false,
    sampleIntervalMs: integer(
      source.sampleIntervalMs,
      DEFAULT_CONFIG.sampleIntervalMs,
      250,
      60000,
    ),
    historyMinutes: integer(
      source.historyMinutes,
      DEFAULT_CONFIG.historyMinutes,
      1,
      5,
    ),
    transitionGraceMs: integer(
      source.transitionGraceMs,
      DEFAULT_CONFIG.transitionGraceMs,
      1000,
      30000,
    ),
    thresholds: Object.freeze({
      degradedEventLoopDelayMs,
      stalledEventLoopDelayMs,
      degradedTickDurationMs,
      stalledTickDurationMs,
      degradedTickLatenessMs,
      stalledTickLatenessMs,
    }),
    logging: Object.freeze({
      enabled: logging.enabled !== false,
      maxBytes: integer(
        logging.maxBytes,
        DEFAULT_CONFIG.logging.maxBytes,
        65536,
        100 * 1024 * 1024,
      ),
    }),
  });
}

function loadConfig(configPath = CONFIG_PATH) {
  return normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeConfig,
};
