"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "bounty-hunting.json");

const DEFAULT_TIERS = Object.freeze([
  {id: "low", label: "Low", maxBountyISK: 9999, isk: 25000, skillPoints: 1000, plexMinimum: 0, plexMaximum: 0, xp: 25},
  {id: "standard", label: "Standard", maxBountyISK: 99999, isk: 75000, skillPoints: 2500, plexMinimum: 1, plexMaximum: 1, xp: 50},
  {id: "elite", label: "Elite", maxBountyISK: 999999, isk: 150000, skillPoints: 5000, plexMinimum: 1, plexMaximum: 1, xp: 100},
  {id: "boss", label: "Boss", maxBountyISK: null, isk: 300000, skillPoints: 10000, plexMinimum: 2, plexMaximum: 2, xp: 250},
]);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  recentKillLimit: 10,
  payoutDelayMs: 20 * 60 * 1000,
  notifications: {enabled: true},
  diagnostics: {enabled: false},
  progression: {
    maxLevel: 50,
    xpToNextLevelBase: 1000,
    xpToNextLevelPerLevel: 250,
  },
  tiers: DEFAULT_TIERS,
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

function normalizeTier(raw = {}, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaultValue = fallback && typeof fallback === "object" ? fallback : {};
  const minimum = 0;
  const maximum = source.maxBountyISK === null || source.maxBountyISK === undefined
    ? (defaultValue.maxBountyISK === null ? null : defaultValue.maxBountyISK)
    : Math.max(0, Math.trunc(finite(source.maxBountyISK, defaultValue.maxBountyISK || 0)));
  const plexMinimum = integer(source.plexMinimum, defaultValue.plexMinimum || 0, 0, 1000000);
  return {
    id: String(source.id || defaultValue.id || "tier"),
    label: String(source.label || defaultValue.label || source.id || "Tier"),
    maxBountyISK: maximum === null ? null : Math.max(minimum, maximum),
    isk: money(source.isk, defaultValue.isk || 0),
    skillPoints: integer(source.skillPoints, defaultValue.skillPoints || 0, 0, 1000000000),
    plexMinimum,
    plexMaximum: Math.max(
      plexMinimum,
      integer(source.plexMaximum, defaultValue.plexMaximum || 0, 0, 1000000),
    ),
    xp: integer(source.xp, defaultValue.xp || 0, 0, 1000000),
  };
}

function normalizeTiers(value) {
  const source = Array.isArray(value) ? value : DEFAULT_TIERS;
  const tiers = source.map((entry, index) => normalizeTier(
    entry,
    DEFAULT_TIERS[index] || DEFAULT_TIERS[DEFAULT_TIERS.length - 1],
  ));
  if (tiers.length === 0) {
    return DEFAULT_TIERS.map((tier) => ({...tier}));
  }
  const withoutDuplicates = [];
  const seen = new Set();
  for (const tier of tiers) {
    if (!seen.has(tier.id)) {
      seen.add(tier.id);
      withoutDuplicates.push(tier);
    }
  }
  return withoutDuplicates.length > 0
    ? withoutDuplicates
    : DEFAULT_TIERS.map((tier) => ({...tier}));
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const notifications = source.notifications && typeof source.notifications === "object"
    ? source.notifications
    : {};
  const diagnostics = source.diagnostics && typeof source.diagnostics === "object"
    ? source.diagnostics
    : {};
  const progression = source.progression && typeof source.progression === "object"
    ? source.progression
    : {};
  return Object.freeze({
    enabled: source.enabled !== false,
    recentKillLimit: integer(source.recentKillLimit, DEFAULT_CONFIG.recentKillLimit, 1, 100),
    payoutDelayMs: integer(source.payoutDelayMs, DEFAULT_CONFIG.payoutDelayMs, 1000, 86400000),
    notifications: Object.freeze({enabled: notifications.enabled !== false}),
    diagnostics: Object.freeze({enabled: diagnostics.enabled === true}),
    progression: Object.freeze({
      maxLevel: integer(progression.maxLevel, DEFAULT_CONFIG.progression.maxLevel, 1, 50),
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
    tiers: normalizeTiers(source.tiers),
  });
}

function loadConfig(configPath = CONFIG_PATH) {
  return normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  DEFAULT_TIERS,
  loadConfig,
  normalizeConfig,
  normalizeTier,
};
