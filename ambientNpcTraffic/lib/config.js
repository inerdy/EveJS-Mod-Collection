"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "traffic.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  tickIntervalMs: 5000,
  shipsPerActiveSystem: 4,
  initialShipsPerActiveSystem: 3,
  maxShipsPerSystem: 8,
  maxShipsGlobal: 100,
  spawnIntervalMs: 30000,
  shipLifetimeMs: 900000,
  virtualTravelMs: 45000,
  dwellTimeMs: 12000,
  spawnDistanceMeters: 10000,
  arrivalDistanceMeters: 200000,
  orbitDistanceMeters: 5000,
  crossSystemChance: 0.35,
  profileIDs: [
    "parity_mission_generic_40574_toms_shuttle",
    "ore_mining_bestower_hauler",
    "ore_mining_badger_hauler",
    "ore_mining_mammoth_hauler",
  ],
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

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const profiles = Array.isArray(source.profileIDs)
    ? [...new Set(source.profileIDs.map((entry) => String(entry || "").trim()).filter(Boolean))]
    : [];

  return Object.freeze({
    enabled: source.enabled !== false,
    tickIntervalMs: integer(source.tickIntervalMs, DEFAULT_CONFIG.tickIntervalMs, 1000, 60000),
    shipsPerActiveSystem: integer(source.shipsPerActiveSystem, DEFAULT_CONFIG.shipsPerActiveSystem, 1, 50),
    initialShipsPerActiveSystem: integer(
      source.initialShipsPerActiveSystem,
      DEFAULT_CONFIG.initialShipsPerActiveSystem,
      1,
      50,
    ),
    maxShipsPerSystem: integer(source.maxShipsPerSystem, DEFAULT_CONFIG.maxShipsPerSystem, 1, 100),
    maxShipsGlobal: integer(source.maxShipsGlobal, DEFAULT_CONFIG.maxShipsGlobal, 1, 1000),
    spawnIntervalMs: integer(source.spawnIntervalMs, DEFAULT_CONFIG.spawnIntervalMs, 1000, 3600000),
    shipLifetimeMs: integer(source.shipLifetimeMs, DEFAULT_CONFIG.shipLifetimeMs, 30000, 86400000),
    virtualTravelMs: integer(source.virtualTravelMs, DEFAULT_CONFIG.virtualTravelMs, 1000, 86400000),
    dwellTimeMs: integer(source.dwellTimeMs, DEFAULT_CONFIG.dwellTimeMs, 1000, 3600000),
    spawnDistanceMeters: Math.max(1000, finite(source.spawnDistanceMeters, DEFAULT_CONFIG.spawnDistanceMeters)),
    // EveJS requires a native warp leg to be at least 150 km. Keep a margin
    // above that floor because the ship begins near the origin anchor while
    // the approach point is measured from the destination anchor.
    arrivalDistanceMeters: Math.max(200000, finite(source.arrivalDistanceMeters, DEFAULT_CONFIG.arrivalDistanceMeters)),
    orbitDistanceMeters: Math.max(1000, finite(source.orbitDistanceMeters, DEFAULT_CONFIG.orbitDistanceMeters)),
    crossSystemChance: fraction(source.crossSystemChance, DEFAULT_CONFIG.crossSystemChance),
    profileIDs: profiles.length > 0 ? profiles : DEFAULT_CONFIG.profileIDs,
  });
}

function loadConfig(configPath = CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return normalizeConfig(raw);
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeConfig,
};
