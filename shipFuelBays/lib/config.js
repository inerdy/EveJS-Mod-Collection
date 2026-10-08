"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "fuel-bays.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  capacityMode: "baseCargo",
  minimumCapacityM3: 0.01,
});

function number(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const capacityMode = source.capacityMode === "baseCargo"
    ? source.capacityMode
    : DEFAULT_CONFIG.capacityMode;

  return Object.freeze({
    enabled: source.enabled !== false,
    capacityMode,
    minimumCapacityM3: Math.max(
      0,
      number(source.minimumCapacityM3, DEFAULT_CONFIG.minimumCapacityM3),
    ),
  });
}

function loadConfig(configPath = CONFIG_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeConfig(parsed);
  } catch (_error) {
    return DEFAULT_CONFIG;
  }
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeConfig,
};
