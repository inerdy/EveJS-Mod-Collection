"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "discovery.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  knownSpaceOnly: true,
  knownSpaceMaxSystemID: 31000000,
  recentDiscoveryLimit: 10,
  reward: {
    isk: 250000,
    xp: 100,
    skillPoints: 10000,
    plexMinimum: 1,
    plexMaximum: 3,
  },
  progression: {
    maxLevel: 50,
    xpToNextLevelBase: 1000,
    xpToNextLevelPerLevel: 250,
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

function money(value, fallback) {
  return Math.max(0, Math.round(finite(value, fallback) * 100) / 100);
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const reward = source.reward && typeof source.reward === "object" ? source.reward : {};
  const progression = source.progression && typeof source.progression === "object"
    ? source.progression
    : {};
  const plexMinimum = integer(
    reward.plexMinimum,
    DEFAULT_CONFIG.reward.plexMinimum,
    0,
    1000000,
  );

  return Object.freeze({
    enabled: source.enabled !== false,
    knownSpaceOnly: source.knownSpaceOnly !== false,
    knownSpaceMaxSystemID: integer(
      source.knownSpaceMaxSystemID,
      DEFAULT_CONFIG.knownSpaceMaxSystemID,
      30000000,
      100000000,
    ),
    recentDiscoveryLimit: integer(
      source.recentDiscoveryLimit,
      DEFAULT_CONFIG.recentDiscoveryLimit,
      1,
      100,
    ),
    reward: Object.freeze({
      isk: money(reward.isk, DEFAULT_CONFIG.reward.isk),
      xp: integer(reward.xp, DEFAULT_CONFIG.reward.xp, 0, 1000000),
      skillPoints: integer(
        reward.skillPoints,
        DEFAULT_CONFIG.reward.skillPoints,
        0,
        1000000000,
      ),
      plexMinimum,
      plexMaximum: Math.max(
        plexMinimum,
        integer(
          reward.plexMaximum,
          DEFAULT_CONFIG.reward.plexMaximum,
          0,
          1000000,
        ),
      ),
    }),
    progression: Object.freeze({
      maxLevel: integer(
        progression.maxLevel,
        DEFAULT_CONFIG.progression.maxLevel,
        1,
        50,
      ),
      xpToNextLevelBase: integer(
        progression.xpToNextLevelBase,
        DEFAULT_CONFIG.progression.xpToNextLevelBase,
        1,
        1000000000,
      ),
      xpToNextLevelPerLevel: integer(
        progression.xpToNextLevelPerLevel,
        DEFAULT_CONFIG.progression.xpToNextLevelPerLevel,
        0,
        1000000000,
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
