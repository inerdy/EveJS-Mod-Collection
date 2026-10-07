"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "contracts.json");
const CORPORATION_HANGAR_FLAGS = Object.freeze([115, 116, 117, 118, 119, 120, 121]);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  clearExistingContractsOnce: false,
  wipeAllActiveContractsOnce: false,
  legacyCleanupVersion: 2,
  initialDelayMs: 30000,
  tickIntervalMs: 300000,
  contractsPerOrigin: 5,
  maxOutstandingContracts: 100,
  generateReturnContracts: true,
  maxPromotedOrigins: 20,
  hubDestinationWeight: 0.7,
  shortHaulChance: 0.35,
  shortHaulMaxJumps: 5,
  promotionThreshold: 25,
  activityHalfLifeMs: 86400000,
  presenceWeightPerPlayer: 1,
  maxPresenceScorePerTick: 5,
  acceptanceScore: 5,
  completionScore: 10,
  failureScore: 0,
  marketActivityScore: 1,
  marketStateRelativePath: "npcMarket/state.json",
  allowedSecurityClasses: ["high"],
  hubStationIDs: [60003760, 60008494, 60011866, 60004588, 60005686],
  treasury: {
    enabled: true,
    targetBalanceISK: 50000000000,
    replenishThresholdRatio: 0.2,
  },
  issuer: {
    corporationID: 1000148,
    characterID: 3015955,
    walletAccountKey: 1000,
    contractHangarFlagID: 115,
    minimumBalanceISK: 0,
  },
  reward: {
    baseISK: 25000,
    perJumpISK: 450000,
    perVolumeM3ISK: 2,
    minimumISK: 25000,
    maximumISK: 50000000,
    securityMultipliers: {high: 1, low: 1.5, null: 2.5},
  },
  collateral: {
    valueMultiplier: 1.25,
    minimumISK: 100000,
    maximumISK: 100000000,
  },
  courier: {
    offerExpirationMinutes: 4320,
    baseDeliveryDays: 1,
    jumpsPerExtraDeliveryDay: 10,
  },
  cargo: {
    referenceVolumeM3: 10000,
    minimumLoadFraction: 0.25,
    maximumLoadFraction: 0.9,
    minimumStackCount: 2,
    maximumStackCount: 5,
  },
  plexReward: {
    minimum: 10,
    maximum: 20,
  },
  haulerProgression: {
    maxLevel: 50,
    baseXPPerContract: 100,
    xpPerJump: 10,
    payoutBonusPerLevel: 0.03,
    xpToNextLevelBase: 1000,
    xpToNextLevelPerLevel: 250,
  },
  cargoCatalog: [
    {typeID: 34, minimumQuantity: 10000, maximumQuantity: 100000, referenceValueISK: 2, maximumVolumeM3: 2000},
    {typeID: 35, minimumQuantity: 10000, maximumQuantity: 100000, referenceValueISK: 8, maximumVolumeM3: 2000},
    {typeID: 36, minimumQuantity: 5000, maximumQuantity: 50000, referenceValueISK: 32, maximumVolumeM3: 2000},
    {typeID: 37, minimumQuantity: 2500, maximumQuantity: 25000, referenceValueISK: 128, maximumVolumeM3: 2000},
    {typeID: 38, minimumQuantity: 1000, maximumQuantity: 10000, referenceValueISK: 512, maximumVolumeM3: 2000},
  ],
  templates: {
    titlePrefix: "[NPC Courier]",
    title: "{item} from {originSystem} to {destinationSystem}",
    description: "Transport {quantity} units of {item} from {originStation} to {destinationStation}. Route: {jumps} stargate jumps. This contract was issued by the NPC logistics network.",
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

function positive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return integer(value, fallback, 1, maximum);
}

function fraction(value, fallback) {
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

function money(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Math.max(0, Math.min(maximum, finite(value, fallback)));
}

function normalizeSecurityClasses(value, fallback) {
  const allowed = new Set(["high", "low", "null"]);
  const values = Array.isArray(value) ? value : fallback;
  const result = [...new Set(values
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => allowed.has(entry)))];
  return result.length > 0 ? result : [...fallback];
}

function normalizeCatalog(value, fallback) {
  const entries = Array.isArray(value) ? value : fallback;
  const result = entries.map((entry) => {
    const minimumQuantity = positive(entry && entry.minimumQuantity, 1, 1000000000);
    const maximumQuantity = integer(
      entry && entry.maximumQuantity,
      minimumQuantity,
      minimumQuantity,
      1000000000,
    );
    return {
      typeID: positive(entry && entry.typeID, 0, 1000000000),
      minimumQuantity,
      maximumQuantity,
      referenceValueISK: money(entry && entry.referenceValueISK, 0, 1000000000000),
      maximumVolumeM3: money(entry && entry.maximumVolumeM3, 0, 1000000000),
    };
  }).filter((entry) => entry.typeID > 0 && entry.maximumVolumeM3 > 0);
  return result.length > 0 ? result : DEFAULT_CONFIG.cargoCatalog.map((entry) => ({...entry}));
}

function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const issuer = source.issuer && typeof source.issuer === "object" ? source.issuer : {};
  const treasury = source.treasury && typeof source.treasury === "object" ? source.treasury : {};
  const reward = source.reward && typeof source.reward === "object" ? source.reward : {};
  const collateral = source.collateral && typeof source.collateral === "object" ? source.collateral : {};
  const courier = source.courier && typeof source.courier === "object" ? source.courier : {};
  const cargo = source.cargo && typeof source.cargo === "object" ? source.cargo : {};
  const plexReward = source.plexReward && typeof source.plexReward === "object" ? source.plexReward : {};
  const haulerProgression = source.haulerProgression && typeof source.haulerProgression === "object"
    ? source.haulerProgression
    : {};
  const templates = source.templates && typeof source.templates === "object" ? source.templates : {};
  const securityMultipliers = reward.securityMultipliers && typeof reward.securityMultipliers === "object"
    ? reward.securityMultipliers
    : {};

  return Object.freeze({
    enabled: source.enabled !== false,
    clearExistingContractsOnce: source.clearExistingContractsOnce === true,
    wipeAllActiveContractsOnce: source.wipeAllActiveContractsOnce === true,
    legacyCleanupVersion: integer(source.legacyCleanupVersion, DEFAULT_CONFIG.legacyCleanupVersion, 0, 100),
    initialDelayMs: integer(source.initialDelayMs, DEFAULT_CONFIG.initialDelayMs, 0, 3600000),
    tickIntervalMs: integer(source.tickIntervalMs, DEFAULT_CONFIG.tickIntervalMs, 1000, 86400000),
    contractsPerOrigin: integer(source.contractsPerOrigin, DEFAULT_CONFIG.contractsPerOrigin, 1, 100),
    maxOutstandingContracts: integer(source.maxOutstandingContracts, DEFAULT_CONFIG.maxOutstandingContracts, 1, 10000),
    generateReturnContracts: source.generateReturnContracts !== false,
    maxPromotedOrigins: integer(source.maxPromotedOrigins, DEFAULT_CONFIG.maxPromotedOrigins, 0, 1000),
    hubDestinationWeight: fraction(source.hubDestinationWeight, DEFAULT_CONFIG.hubDestinationWeight),
    shortHaulChance: fraction(source.shortHaulChance, DEFAULT_CONFIG.shortHaulChance),
    shortHaulMaxJumps: integer(source.shortHaulMaxJumps, DEFAULT_CONFIG.shortHaulMaxJumps, 1, 100),
    promotionThreshold: money(source.promotionThreshold, DEFAULT_CONFIG.promotionThreshold, 1000000000),
    activityHalfLifeMs: integer(source.activityHalfLifeMs, DEFAULT_CONFIG.activityHalfLifeMs, 60000, 31536000000),
    presenceWeightPerPlayer: money(source.presenceWeightPerPlayer, DEFAULT_CONFIG.presenceWeightPerPlayer, 1000),
    maxPresenceScorePerTick: money(source.maxPresenceScorePerTick, DEFAULT_CONFIG.maxPresenceScorePerTick, 100000),
    acceptanceScore: money(source.acceptanceScore, DEFAULT_CONFIG.acceptanceScore, 100000),
    completionScore: money(source.completionScore, DEFAULT_CONFIG.completionScore, 100000),
    failureScore: money(source.failureScore, DEFAULT_CONFIG.failureScore, 100000),
    marketActivityScore: money(source.marketActivityScore, DEFAULT_CONFIG.marketActivityScore, 100000),
    marketStateRelativePath: String(source.marketStateRelativePath || DEFAULT_CONFIG.marketStateRelativePath),
    allowedSecurityClasses: normalizeSecurityClasses(source.allowedSecurityClasses, DEFAULT_CONFIG.allowedSecurityClasses),
    hubStationIDs: [...new Set((Array.isArray(source.hubStationIDs) ? source.hubStationIDs : DEFAULT_CONFIG.hubStationIDs)
      .map((value) => positive(value, 0, 1000000000))
      .filter(Boolean))],
    treasury: Object.freeze({
      enabled: treasury.enabled !== false,
      targetBalanceISK: positive(
        treasury.targetBalanceISK,
        DEFAULT_CONFIG.treasury.targetBalanceISK,
        1000000000000000,
      ),
      replenishThresholdRatio: Math.max(
        0.01,
        Math.min(1, finite(
          treasury.replenishThresholdRatio,
          DEFAULT_CONFIG.treasury.replenishThresholdRatio,
        )),
      ),
    }),
    issuer: Object.freeze({
      corporationID: positive(issuer.corporationID, DEFAULT_CONFIG.issuer.corporationID, 1000000000),
      characterID: positive(issuer.characterID, DEFAULT_CONFIG.issuer.characterID, 10000000000),
      walletAccountKey: integer(issuer.walletAccountKey, DEFAULT_CONFIG.issuer.walletAccountKey, 1000, 1006),
      contractHangarFlagID: CORPORATION_HANGAR_FLAGS.includes(
        Math.trunc(Number(issuer.contractHangarFlagID)),
      )
        ? Math.trunc(Number(issuer.contractHangarFlagID))
        : DEFAULT_CONFIG.issuer.contractHangarFlagID,
      minimumBalanceISK: money(issuer.minimumBalanceISK, DEFAULT_CONFIG.issuer.minimumBalanceISK, 1000000000000000),
    }),
    reward: Object.freeze({
      baseISK: money(reward.baseISK, DEFAULT_CONFIG.reward.baseISK, 1000000000000000),
      perJumpISK: money(reward.perJumpISK, DEFAULT_CONFIG.reward.perJumpISK, 1000000000000000),
      perVolumeM3ISK: money(reward.perVolumeM3ISK, DEFAULT_CONFIG.reward.perVolumeM3ISK, 1000000000000000),
      minimumISK: money(reward.minimumISK, DEFAULT_CONFIG.reward.minimumISK, 1000000000000000),
      maximumISK: Math.max(
        money(reward.maximumISK, DEFAULT_CONFIG.reward.maximumISK, 1000000000000000),
        money(reward.minimumISK, DEFAULT_CONFIG.reward.minimumISK, 1000000000000000),
      ),
      securityMultipliers: Object.freeze({
        high: Math.max(0, finite(securityMultipliers.high, DEFAULT_CONFIG.reward.securityMultipliers.high)),
        low: Math.max(0, finite(securityMultipliers.low, DEFAULT_CONFIG.reward.securityMultipliers.low)),
        null: Math.max(0, finite(securityMultipliers.null, DEFAULT_CONFIG.reward.securityMultipliers.null)),
      }),
    }),
    collateral: Object.freeze({
      valueMultiplier: Math.max(0, finite(collateral.valueMultiplier, DEFAULT_CONFIG.collateral.valueMultiplier)),
      minimumISK: money(collateral.minimumISK, DEFAULT_CONFIG.collateral.minimumISK, 1000000000000000),
      maximumISK: Math.max(
        money(collateral.maximumISK, DEFAULT_CONFIG.collateral.maximumISK, 1000000000000000),
        money(collateral.minimumISK, DEFAULT_CONFIG.collateral.minimumISK, 1000000000000000),
      ),
    }),
    courier: Object.freeze({
      offerExpirationMinutes: integer(courier.offerExpirationMinutes, DEFAULT_CONFIG.courier.offerExpirationMinutes, 60, 43200),
      baseDeliveryDays: integer(courier.baseDeliveryDays, DEFAULT_CONFIG.courier.baseDeliveryDays, 1, 30),
      jumpsPerExtraDeliveryDay: integer(courier.jumpsPerExtraDeliveryDay, DEFAULT_CONFIG.courier.jumpsPerExtraDeliveryDay, 1, 100),
    }),
    cargo: Object.freeze({
      referenceVolumeM3: money(cargo.referenceVolumeM3, DEFAULT_CONFIG.cargo.referenceVolumeM3, 1000000000),
      minimumLoadFraction: fraction(cargo.minimumLoadFraction, DEFAULT_CONFIG.cargo.minimumLoadFraction),
      maximumLoadFraction: Math.max(
        fraction(cargo.maximumLoadFraction, DEFAULT_CONFIG.cargo.maximumLoadFraction),
        fraction(cargo.minimumLoadFraction, DEFAULT_CONFIG.cargo.minimumLoadFraction),
      ),
      minimumStackCount: integer(cargo.minimumStackCount, DEFAULT_CONFIG.cargo.minimumStackCount, 1, 32),
      maximumStackCount: Math.max(
        integer(cargo.maximumStackCount, DEFAULT_CONFIG.cargo.maximumStackCount, 1, 32),
        integer(cargo.minimumStackCount, DEFAULT_CONFIG.cargo.minimumStackCount, 1, 32),
      ),
    }),
    plexReward: Object.freeze({
      minimum: integer(plexReward.minimum, DEFAULT_CONFIG.plexReward.minimum, 0, 1000000),
      maximum: Math.max(
        integer(plexReward.maximum, DEFAULT_CONFIG.plexReward.maximum, 0, 1000000),
        integer(plexReward.minimum, DEFAULT_CONFIG.plexReward.minimum, 0, 1000000),
      ),
    }),
    haulerProgression: Object.freeze({
      maxLevel: integer(haulerProgression.maxLevel, DEFAULT_CONFIG.haulerProgression.maxLevel, 1, 50),
      baseXPPerContract: money(
        haulerProgression.baseXPPerContract,
        DEFAULT_CONFIG.haulerProgression.baseXPPerContract,
        1000000,
      ),
      xpPerJump: money(
        haulerProgression.xpPerJump,
        DEFAULT_CONFIG.haulerProgression.xpPerJump,
        1000000,
      ),
      payoutBonusPerLevel: Math.max(
        0,
        Math.min(1, finite(
          haulerProgression.payoutBonusPerLevel,
          DEFAULT_CONFIG.haulerProgression.payoutBonusPerLevel,
        )),
      ),
      xpToNextLevelBase: money(
        haulerProgression.xpToNextLevelBase,
        DEFAULT_CONFIG.haulerProgression.xpToNextLevelBase,
        1000000000,
      ),
      xpToNextLevelPerLevel: money(
        haulerProgression.xpToNextLevelPerLevel,
        DEFAULT_CONFIG.haulerProgression.xpToNextLevelPerLevel,
        1000000000,
      ),
    }),
    cargoCatalog: normalizeCatalog(source.cargoCatalog, DEFAULT_CONFIG.cargoCatalog),
    templates: Object.freeze({
      titlePrefix: String(templates.titlePrefix || DEFAULT_CONFIG.templates.titlePrefix).slice(0, 80),
      title: String(templates.title || DEFAULT_CONFIG.templates.title).slice(0, 180),
      description: String(templates.description || DEFAULT_CONFIG.templates.description).slice(0, 3900),
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
