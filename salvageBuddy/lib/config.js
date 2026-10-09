"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "salvageBuddy.json");
const LOCAL_CONFIG_PATH = path.join(__dirname, "..", "config", "salvageBuddy.local.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  droneOnly: true,
  serviceFeeISK: 120000,
  cooldownSeconds: 300,
  noctisTypeID: 2998,
  afterburnerTypeID: 12058,
  tractorBeamTypeID: 24622,
  tractorBeamCount: 4,
  salvagerTypeID: 30836,
  salvagerCount: 4,
  salvageDroneTypeID: 55760,
  salvageDroneCount: 5,
  spawnDistanceAU: 1,
  approachRangeMeters: 5000,
  approachTimeoutMs: 180000,
  serviceLifetimeMs: 900000,
  departureDelayMs: 5000,
  pollIntervalMs: 250,
  maxServiceDurationMs: 600000,
  maxSalvageCyclesPerTarget: 12,
});

function number(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(number(value, fallback))));
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    enabled: source.enabled !== false,
    droneOnly: source.droneOnly !== false,
    serviceFeeISK: Math.max(0, Math.round(number(source.serviceFeeISK, DEFAULT_CONFIG.serviceFeeISK) * 100) / 100),
    cooldownSeconds: integer(source.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds, 0, 864000),
    noctisTypeID: integer(source.noctisTypeID, DEFAULT_CONFIG.noctisTypeID, 1, 1000000000),
    afterburnerTypeID: integer(source.afterburnerTypeID, DEFAULT_CONFIG.afterburnerTypeID, 1, 1000000000),
    tractorBeamTypeID: integer(source.tractorBeamTypeID, DEFAULT_CONFIG.tractorBeamTypeID, 1, 1000000000),
    tractorBeamCount: integer(source.tractorBeamCount, DEFAULT_CONFIG.tractorBeamCount, 0, 8),
    salvagerTypeID: integer(source.salvagerTypeID, DEFAULT_CONFIG.salvagerTypeID, 1, 1000000000),
    salvagerCount: integer(source.salvagerCount, DEFAULT_CONFIG.salvagerCount, 0, 8),
    salvageDroneTypeID: integer(source.salvageDroneTypeID, DEFAULT_CONFIG.salvageDroneTypeID, 1, 1000000000),
    salvageDroneCount: integer(source.salvageDroneCount, DEFAULT_CONFIG.salvageDroneCount, 0, 50),
    spawnDistanceAU: Math.max(0.01, number(source.spawnDistanceAU, DEFAULT_CONFIG.spawnDistanceAU)),
    approachRangeMeters: integer(source.approachRangeMeters, DEFAULT_CONFIG.approachRangeMeters, 100, 1000000),
    approachTimeoutMs: integer(source.approachTimeoutMs, DEFAULT_CONFIG.approachTimeoutMs, 1000, 300000),
    serviceLifetimeMs: integer(source.serviceLifetimeMs, DEFAULT_CONFIG.serviceLifetimeMs, 30000, 3600000),
    departureDelayMs: integer(source.departureDelayMs, DEFAULT_CONFIG.departureDelayMs, 0, 300000),
    pollIntervalMs: integer(source.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 50, 10000),
    maxServiceDurationMs: integer(source.maxServiceDurationMs, DEFAULT_CONFIG.maxServiceDurationMs, 10000, 3600000),
    maxSalvageCyclesPerTarget: integer(source.maxSalvageCyclesPerTarget, DEFAULT_CONFIG.maxSalvageCyclesPerTarget, 1, 100),
  });
}

function loadConfig(configPath = CONFIG_PATH) {
  const base = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  return normalizeConfig({...base, ...local});
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  LOCAL_CONFIG_PATH,
  loadConfig,
  normalizeConfig,
};
