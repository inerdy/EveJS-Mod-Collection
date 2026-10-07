"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "liquidity.json");
const LOCAL_CONFIG_PATH = path.join(__dirname, "..", "config", "liquidity.local.json");
const DEFAULT_HUBS = [60003760, 60008494, 60011866, 60004588, 60005686];
const DEFAULT_BUY_TIERS = [
  {id: "poor", multiplier: 0.55, weight: 20},
  {id: "fair", multiplier: 0.8, weight: 55},
  {id: "good", multiplier: 0.95, weight: 25},
];
const DEFAULT_SELL_TIERS = [
  {id: "good", multiplier: 1.05, weight: 25},
  {id: "fair", multiplier: 1.25, weight: 55},
  {id: "poor", multiplier: 1.8, weight: 20},
];
const DEFAULT_HUB_FUEL_SEED = Object.freeze({
  enabled: true,
  typeID: 17887,
  quantity: 100000,
  sellOnly: true,
  repairAfterMarketRestart: true,
  hubStationIDs: DEFAULT_HUBS,
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dryRun: false,
  initialDelayMs: 30000,
  tickIntervalMs: 3600000,
  itemsPerHubPerTick: 100,
  ordersPerSide: 3,
  maxActiveOrdersPerHub: 5000,
  targetOrderVolumeM3: 5000,
  maximumOrderQuantity: 1000000,
  minimumVolume: 1,
  durationDays: 3650,
  staleAfterMs: 604800000,
  minimumSpreadRatio: 0.02,
  hubFuelSeed: DEFAULT_HUB_FUEL_SEED,
  discordWebhookUrl: "",
  discordNotifyWhenEmpty: false,
  hubStationIDs: DEFAULT_HUBS,
  buyTiers: DEFAULT_BUY_TIERS,
  sellTiers: DEFAULT_SELL_TIERS,
});

function number(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(number(value, fallback))));
}

function positiveIDs(value, fallback) {
  const values = Array.isArray(value) ? value : fallback;
  const result = [...new Set(values
    .map((entry) => Math.trunc(Number(entry) || 0))
    .filter((entry) => entry > 0))];
  return result.length > 0 ? result : [...fallback];
}

function normalizeTiers(value, fallback) {
  const values = Array.isArray(value) ? value : fallback;
  const tiers = values.map((entry, index) => ({
    id: String(entry && entry.id || `tier-${index + 1}`).trim() || `tier-${index + 1}`,
    multiplier: Math.max(0.01, number(entry && entry.multiplier, fallback[index % fallback.length].multiplier)),
    weight: Math.max(0, number(entry && entry.weight, fallback[index % fallback.length].weight)),
  })).filter((entry) => entry.weight > 0);
  return tiers.length > 0 ? tiers : fallback.map((entry) => ({...entry}));
}

function normalizeHubFuelSeed(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    typeID: integer(source.typeID, DEFAULT_HUB_FUEL_SEED.typeID, 1, 1000000000),
    quantity: integer(source.quantity, DEFAULT_HUB_FUEL_SEED.quantity, 1, 1000000000),
    sellOnly: source.sellOnly !== false,
    repairAfterMarketRestart: source.repairAfterMarketRestart !== false,
    hubStationIDs: positiveIDs(source.hubStationIDs, DEFAULT_HUB_FUEL_SEED.hubStationIDs),
  };
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    enabled: source.enabled !== false,
    dryRun: source.dryRun === true,
    initialDelayMs: integer(source.initialDelayMs, DEFAULT_CONFIG.initialDelayMs, 0, 3600000),
    tickIntervalMs: integer(source.tickIntervalMs, DEFAULT_CONFIG.tickIntervalMs, 60000, 86400000),
    itemsPerHubPerTick: integer(source.itemsPerHubPerTick, DEFAULT_CONFIG.itemsPerHubPerTick, 1, 5000),
    ordersPerSide: integer(source.ordersPerSide, DEFAULT_CONFIG.ordersPerSide, 1, 10),
    maxActiveOrdersPerHub: integer(source.maxActiveOrdersPerHub, DEFAULT_CONFIG.maxActiveOrdersPerHub, 1, 100000),
    targetOrderVolumeM3: Math.max(0.01, number(source.targetOrderVolumeM3, DEFAULT_CONFIG.targetOrderVolumeM3)),
    maximumOrderQuantity: integer(source.maximumOrderQuantity, DEFAULT_CONFIG.maximumOrderQuantity, 1, 1000000000),
    minimumVolume: integer(source.minimumVolume, DEFAULT_CONFIG.minimumVolume, 1, 1000000),
    durationDays: integer(source.durationDays, DEFAULT_CONFIG.durationDays, 1, 3650),
    staleAfterMs: integer(source.staleAfterMs, DEFAULT_CONFIG.staleAfterMs, 3600000, 31536000000),
    minimumSpreadRatio: Math.max(0, Math.min(0.5, number(source.minimumSpreadRatio, DEFAULT_CONFIG.minimumSpreadRatio))),
    hubFuelSeed: normalizeHubFuelSeed(source.hubFuelSeed || source.fuelSeed),
    discordWebhookUrl: String(source.discordWebhookUrl || "").trim(),
    discordNotifyWhenEmpty: source.discordNotifyWhenEmpty === true,
    hubStationIDs: positiveIDs(source.hubStationIDs, DEFAULT_HUBS),
    buyTiers: normalizeTiers(source.buyTiers, DEFAULT_BUY_TIERS),
    sellTiers: normalizeTiers(source.sellTiers, DEFAULT_SELL_TIERS),
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
  const environmentWebhook = String(process.env.NPC_MARKET_LIQUIDITY_DISCORD_WEBHOOK_URL || "").trim();
  return normalizeConfig({
    ...base,
    ...local,
    ...(environmentWebhook ? {discordWebhookUrl: environmentWebhook} : {}),
  });
}

module.exports = {CONFIG_PATH, DEFAULT_CONFIG, LOCAL_CONFIG_PATH, loadConfig, normalizeConfig};
