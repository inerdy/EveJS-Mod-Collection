"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "mining.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  tickIntervalMs: 300000,
  initialDelayMs: 30000,
  spawnChance: 0.15,
  respawnCooldownMs: 2700000,
  maxFleetsPerSystem: 1,
  maxFleetsGlobal: 10,
  minerCommandQuery: "",
  allowedSystemIDs: [],
});

function finite(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integer(value, fallback, minimum, maximum) {
  const numeric = Math.trunc(finite(value, fallback));
  return Math.max(minimum, Math.min(maximum, numeric));
}

function fraction(value, fallback) {
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

function positiveSystemIDs(value) {
  const entries = Array.isArray(value) ? value : [];
  return [...new Set(
    entries
      .map((entry) => Math.trunc(Number(entry) || 0))
      .filter((entry) => entry > 0),
  )];
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    enabled: source.enabled !== false,
    tickIntervalMs: integer(
      source.tickIntervalMs,
      DEFAULT_CONFIG.tickIntervalMs,
      30000,
      3600000,
    ),
    initialDelayMs: integer(
      source.initialDelayMs,
      DEFAULT_CONFIG.initialDelayMs,
      0,
      3600000,
    ),
    spawnChance: fraction(source.spawnChance, DEFAULT_CONFIG.spawnChance),
    respawnCooldownMs: integer(
      source.respawnCooldownMs,
      DEFAULT_CONFIG.respawnCooldownMs,
      0,
      86400000,
    ),
    maxFleetsPerSystem: integer(
      source.maxFleetsPerSystem,
      DEFAULT_CONFIG.maxFleetsPerSystem,
      1,
      10,
    ),
    maxFleetsGlobal: integer(
      source.maxFleetsGlobal,
      DEFAULT_CONFIG.maxFleetsGlobal,
      1,
      100,
    ),
    minerCommandQuery: String(
      source.minerCommandQuery || DEFAULT_CONFIG.minerCommandQuery,
    ).trim(),
    allowedSystemIDs: positiveSystemIDs(source.allowedSystemIDs),
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
