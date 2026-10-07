"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "fuel.json");
const LOCAL_CONFIG_PATH = path.join(__dirname, "..", "config", "fuel.local.json");

const FUEL_CLASS_KEYS = Object.freeze([
  "capsule",
  "frigate",
  "corvette",
  "shuttle",
  "destroyer",
  "cruiser",
  "battlecruiser",
  "battleship",
  "industrialTransport",
  "capitalFreighter",
  "fallback",
]);

const DEFAULT_FUEL_RATES = Object.freeze({
  capsule: 0.5,
  frigate: 0.5,
  corvette: 0.5,
  shuttle: 0.5,
  destroyer: 0.75,
  cruiser: 1.25,
  battlecruiser: 1.5,
  battleship: 2,
  industrialTransport: 2.5,
  capitalFreighter: 4,
  fallback: 0.5,
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  fuelTypeID: 17887,
  fuelCapacityUnits: 1000,
  fuelUnitsPerAU: 1,
  fuelUnitsPerAUByClass: DEFAULT_FUEL_RATES,
  minimumWarpFuel: 1,
  initialFillActiveShips: true,
  emergencyFuelUnits: 25,
  emergencyFeeISK: 1000000,
  emergencyCooldownSeconds: 900,
  serviceShipTypeID: 648,
  serviceShipSpawnDistanceAU: 1,
  serviceShipApproachRangeMeters: 5000,
  serviceShipApproachTimeoutMs: 30000,
  serviceShipDepartureDelayMs: 5000,
  serviceShipLifetimeMs: 120000,
  serviceShipDelayMs: 1000,
  debtPollMs: 30000,
  trackWarpOdometer: true,
  recentWarpLimit: 10,
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
  const sourceRates = source.fuelUnitsPerAUByClass &&
    typeof source.fuelUnitsPerAUByClass === "object"
    ? source.fuelUnitsPerAUByClass
    : {};
  const fallbackRate = Math.max(
    0.000001,
    number(source.fuelUnitsPerAU, DEFAULT_CONFIG.fuelUnitsPerAU),
  );
  const hasClassRates = Boolean(
    source.fuelUnitsPerAUByClass &&
    typeof source.fuelUnitsPerAUByClass === "object",
  );
  const hasLegacyRate = Object.prototype.hasOwnProperty.call(
    source,
    "fuelUnitsPerAU",
  );
  const fuelUnitsPerAUByClass = {};
  for (const key of FUEL_CLASS_KEYS) {
    fuelUnitsPerAUByClass[key] = Math.max(
      0.000001,
      number(
        sourceRates[key],
        hasClassRates || !hasLegacyRate
          ? DEFAULT_FUEL_RATES[key]
          : fallbackRate,
      ),
    );
  }
  return Object.freeze({
    enabled: source.enabled !== false,
    fuelTypeID: integer(source.fuelTypeID, DEFAULT_CONFIG.fuelTypeID, 1, 1000000000),
    fuelCapacityUnits: integer(source.fuelCapacityUnits, DEFAULT_CONFIG.fuelCapacityUnits, 1, 1000000000),
    fuelUnitsPerAU: fallbackRate,
    fuelUnitsPerAUByClass: Object.freeze(fuelUnitsPerAUByClass),
    minimumWarpFuel: integer(source.minimumWarpFuel, DEFAULT_CONFIG.minimumWarpFuel, 1, 1000000000),
    initialFillActiveShips: source.initialFillActiveShips !== false,
    emergencyFuelUnits: integer(source.emergencyFuelUnits, DEFAULT_CONFIG.emergencyFuelUnits, 1, 1000000000),
    emergencyFeeISK: Math.max(0, Math.round(number(source.emergencyFeeISK, DEFAULT_CONFIG.emergencyFeeISK) * 100) / 100),
    emergencyCooldownSeconds: integer(source.emergencyCooldownSeconds, DEFAULT_CONFIG.emergencyCooldownSeconds, 0, 864000),
    serviceShipTypeID: integer(source.serviceShipTypeID, DEFAULT_CONFIG.serviceShipTypeID, 1, 1000000000),
    serviceShipSpawnDistanceAU: Math.max(0.01, number(source.serviceShipSpawnDistanceAU, DEFAULT_CONFIG.serviceShipSpawnDistanceAU)),
    serviceShipApproachRangeMeters: integer(source.serviceShipApproachRangeMeters, DEFAULT_CONFIG.serviceShipApproachRangeMeters, 100, 1000000),
    serviceShipApproachTimeoutMs: integer(source.serviceShipApproachTimeoutMs, DEFAULT_CONFIG.serviceShipApproachTimeoutMs, 1000, 300000),
    serviceShipDepartureDelayMs: integer(source.serviceShipDepartureDelayMs, DEFAULT_CONFIG.serviceShipDepartureDelayMs, 0, 300000),
    serviceShipLifetimeMs: integer(source.serviceShipLifetimeMs, DEFAULT_CONFIG.serviceShipLifetimeMs, 30000, 600000),
    serviceShipDelayMs: integer(source.serviceShipDelayMs, DEFAULT_CONFIG.serviceShipDelayMs, 0, 30000),
    debtPollMs: integer(source.debtPollMs, DEFAULT_CONFIG.debtPollMs, 1000, 86400000),
    trackWarpOdometer: source.trackWarpOdometer !== false,
    recentWarpLimit: integer(source.recentWarpLimit, DEFAULT_CONFIG.recentWarpLimit, 0, 100),
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
  DEFAULT_FUEL_RATES,
  FUEL_CLASS_KEYS,
  LOCAL_CONFIG_PATH,
  loadConfig,
  normalizeConfig,
};
