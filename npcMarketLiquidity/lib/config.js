"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "liquidity.json");
const LOCAL_CONFIG_PATH = path.join(__dirname, "..", "config", "liquidity.local.json");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_PRICE_MANIFEST_PATH = path.join(__dirname, "..", "data", "price-manifest.json");
const DEFAULT_HUBS = [60003760, 60008494, 60011866, 60004588, 60005686];
const DEFAULT_ORE_TYPE_IDS = Object.freeze([
  18, 19, 20, 21, 22,
  1223, 1224, 1225, 1226, 1227, 1228, 1229, 1230, 1231, 1232,
  11396,
]);
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
const DEFAULT_FUEL_SEEDS = Object.freeze([
  Object.freeze({
    enabled: true,
    typeID: 17889,
    name: "Hydrogen Isotopes",
    quantity: 100000,
    sellOnly: true,
    repairAfterMarketRestart: true,
    hubStationIDs: DEFAULT_HUBS,
  }),
  Object.freeze({
    enabled: true,
    typeID: 16274,
    name: "Helium Isotopes",
    quantity: 100000,
    sellOnly: true,
    repairAfterMarketRestart: true,
    hubStationIDs: DEFAULT_HUBS,
  }),
  Object.freeze({
    enabled: true,
    typeID: 17888,
    name: "Nitrogen Isotopes",
    quantity: 100000,
    sellOnly: true,
    repairAfterMarketRestart: true,
    hubStationIDs: DEFAULT_HUBS,
  }),
  Object.freeze({
    enabled: true,
    typeID: 17887,
    name: "Oxygen Isotopes",
    quantity: 100000,
    sellOnly: true,
    repairAfterMarketRestart: true,
    hubStationIDs: DEFAULT_HUBS,
  }),
]);
const DEFAULT_HUB_FUEL_SEED = DEFAULT_FUEL_SEEDS[DEFAULT_FUEL_SEEDS.length - 1];
const DEFAULT_ORE_LIQUIDITY = Object.freeze({
  enabled: true,
  tickIntervalMs: 900000,
  ordersPerItem: 5,
  targetOrderVolumeM3: 25000,
  maximumOrderQuantity: 5000000,
  typeIDs: DEFAULT_ORE_TYPE_IDS,
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
  priceManifestEnabled: true,
  priceManifestPath: DEFAULT_PRICE_MANIFEST_PATH,
  allowCalculatedManifestPrices: true,
  fuelSeeds: DEFAULT_FUEL_SEEDS,
  hubFuelSeed: DEFAULT_HUB_FUEL_SEED,
  oreLiquidity: DEFAULT_ORE_LIQUIDITY,
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

function normalizeFuelSeed(value, fallback = DEFAULT_HUB_FUEL_SEED) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== undefined ? source.enabled !== false : fallback.enabled !== false,
    typeID: integer(source.typeID, fallback.typeID, 1, 1000000000),
    name: String(source.name || fallback.name || `Fuel ${source.typeID || fallback.typeID}`).trim() || `Fuel ${fallback.typeID}`,
    quantity: integer(source.quantity, fallback.quantity, 1, 1000000000),
    sellOnly: source.sellOnly !== undefined ? source.sellOnly !== false : fallback.sellOnly !== false,
    repairAfterMarketRestart: source.repairAfterMarketRestart !== undefined
      ? source.repairAfterMarketRestart !== false
      : fallback.repairAfterMarketRestart !== false,
    hubStationIDs: positiveIDs(source.hubStationIDs, fallback.hubStationIDs),
  };
}

function normalizeFuelSeeds(value, legacyValue) {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : DEFAULT_FUEL_SEEDS;
  const legacy = legacyValue && typeof legacyValue === "object"
    ? normalizeFuelSeed(legacyValue, DEFAULT_HUB_FUEL_SEED)
    : null;
  const entries = source.map((entry) => {
    const fallback = DEFAULT_FUEL_SEEDS.find((candidate) =>
      Number(candidate.typeID) === Number(entry && entry.typeID)) || DEFAULT_HUB_FUEL_SEED;
    return normalizeFuelSeed(entry, fallback);
  });
  if (legacy && !Array.isArray(value)) {
    const index = entries.findIndex((entry) => entry.typeID === legacy.typeID);
    if (index >= 0) entries[index] = legacy;
    else entries.push(legacy);
  }
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.typeID)) return false;
    seen.add(entry.typeID);
    return true;
  });
}

function normalizeOreLiquidity(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    tickIntervalMs: integer(source.tickIntervalMs, DEFAULT_ORE_LIQUIDITY.tickIntervalMs, 60000, 86400000),
    ordersPerItem: integer(source.ordersPerItem, DEFAULT_ORE_LIQUIDITY.ordersPerItem, 1, 10),
    targetOrderVolumeM3: Math.max(
      0.01,
      number(source.targetOrderVolumeM3, DEFAULT_ORE_LIQUIDITY.targetOrderVolumeM3),
    ),
    maximumOrderQuantity: integer(
      source.maximumOrderQuantity,
      DEFAULT_ORE_LIQUIDITY.maximumOrderQuantity,
      1,
      1000000000,
    ),
    typeIDs: positiveIDs(source.typeIDs, DEFAULT_ORE_TYPE_IDS),
  };
}

function resolveConfiguredPath(value, fallback) {
  const configured = String(value || "").trim();
  if (!configured) return fallback;
  return path.isAbsolute(configured) ? configured : path.resolve(REPO_ROOT, configured);
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
    priceManifestEnabled: source.priceManifestEnabled !== false,
    priceManifestPath: resolveConfiguredPath(source.priceManifestPath, DEFAULT_PRICE_MANIFEST_PATH),
    allowCalculatedManifestPrices: source.allowCalculatedManifestPrices !== false,
    fuelSeeds: normalizeFuelSeeds(source.fuelSeeds, source.hubFuelSeed || source.fuelSeed),
    hubFuelSeed: normalizeFuelSeed(
      source.hubFuelSeed || source.fuelSeed || DEFAULT_HUB_FUEL_SEED,
      DEFAULT_HUB_FUEL_SEED,
    ),
    oreLiquidity: normalizeOreLiquidity(source.oreLiquidity),
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

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  DEFAULT_FUEL_SEEDS,
  DEFAULT_ORE_LIQUIDITY,
  DEFAULT_ORE_TYPE_IDS,
  DEFAULT_PRICE_MANIFEST_PATH,
  LOCAL_CONFIG_PATH,
  loadConfig,
  normalizeConfig,
  normalizeOreLiquidity,
};
