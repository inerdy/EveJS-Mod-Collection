"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {normalizeProgressionState} = require(path.join(__dirname, "haulerProgression"));

const STATE_VERSION = 2;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    sequence: 0,
    lastTickAtMs: 0,
    lastMarketTickID: 0,
    promotedStationIDs: [],
    stationScores: {},
    treasury: {
      fundingSequence: 0,
      initialSeedComplete: false,
      pendingFundingKey: "",
      pendingFundingAmountISK: 0,
      lastFundingAtMs: 0,
      lastFundingAmountISK: 0,
      totalFundedISK: 0,
      replenishmentCount: 0,
    },
    maintenance: {
      existingContractsCleared: false,
      legacyCleanupVersion: 0,
    },
    haulerProgression: {
      players: {},
    },
    automation: {
      players: {},
    },
    contracts: {},
  };
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeContract(raw = {}) {
  const items = Array.isArray(raw.items) ? raw.items.map((item) => ({
    typeID: positive(item && item.typeID, 0),
    quantity: positive(item && item.quantity, 0),
    itemID: positive(item && item.itemID, 0),
  })).filter((item) => item.typeID > 0 && item.quantity > 0) : [];
  return {
    jobKey: String(raw.jobKey || ""),
    contractID: positive(raw.contractID, 0),
    state: String(raw.state || "creating"),
    lastStatus: raw.lastStatus === null || raw.lastStatus === undefined
      ? null
      : Number(raw.lastStatus),
    lastEvent: String(raw.lastEvent || ""),
    originStationID: positive(raw.originStationID, 0),
    destinationStationID: positive(raw.destinationStationID, 0),
    typeID: positive(raw.typeID, 0),
    quantity: positive(raw.quantity, 0),
    itemID: positive(raw.itemID, 0),
    items,
    reward: Math.max(0, Number(raw.reward) || 0),
    collateral: Math.max(0, Number(raw.collateral) || 0),
    jumps: Math.max(0, Math.trunc(Number(raw.jumps) || 0)),
    createdAtMs: Math.max(0, Number(raw.createdAtMs) || 0),
    updatedAtMs: Math.max(0, Number(raw.updatedAtMs) || 0),
  };
}

function normalizeAutomationPlayer(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    autoRoute: source.autoRoute === true,
    autoComplete: source.autoComplete === true,
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const contracts = {};
  const sourceContracts = source.contracts && typeof source.contracts === "object"
    ? source.contracts
    : {};
  for (const [key, value] of Object.entries(sourceContracts)) {
    const contract = normalizeContract({...value, jobKey: value && value.jobKey || key});
    if (contract.jobKey) {
      contracts[contract.jobKey] = contract;
    }
  }
  const stationScores = {};
  const sourceScores = source.stationScores && typeof source.stationScores === "object"
    ? source.stationScores
    : {};
  for (const [stationID, value] of Object.entries(sourceScores)) {
    const numericID = positive(stationID, 0);
    const score = Math.max(0, Number(value) || 0);
    if (numericID > 0 && score > 0) {
      stationScores[String(numericID)] = score;
    }
  }
  const sourceTreasury = source.treasury && typeof source.treasury === "object"
    ? source.treasury
    : {};
  const sourceMaintenance = source.maintenance && typeof source.maintenance === "object"
    ? source.maintenance
    : {};
  const sourceAutomation = source.automation && typeof source.automation === "object"
    ? source.automation
    : {};
  const automationPlayers = {};
  const sourceAutomationPlayers = sourceAutomation.players && typeof sourceAutomation.players === "object"
    ? sourceAutomation.players
    : {};
  for (const [characterID, value] of Object.entries(sourceAutomationPlayers)) {
    const numericCharacterID = positive(characterID, 0);
    if (numericCharacterID > 0) {
      automationPlayers[String(numericCharacterID)] = normalizeAutomationPlayer(value);
    }
  }
  const haulerProgression = normalizeProgressionState(source.haulerProgression);
  return {
    schemaVersion: STATE_VERSION,
    sequence: Math.max(0, Math.trunc(Number(source.sequence) || 0)),
    lastTickAtMs: Math.max(0, Number(source.lastTickAtMs) || 0),
    lastMarketTickID: Math.max(0, Math.trunc(Number(source.lastMarketTickID) || 0)),
    promotedStationIDs: [...new Set((Array.isArray(source.promotedStationIDs) ? source.promotedStationIDs : [])
      .map((value) => positive(value, 0))
      .filter(Boolean))],
    stationScores,
    treasury: {
      fundingSequence: Math.max(0, Math.trunc(Number(sourceTreasury.fundingSequence) || 0)),
      initialSeedComplete: sourceTreasury.initialSeedComplete === true,
      pendingFundingKey: String(sourceTreasury.pendingFundingKey || ""),
      pendingFundingAmountISK: Math.max(0, Number(sourceTreasury.pendingFundingAmountISK) || 0),
      lastFundingAtMs: Math.max(0, Number(sourceTreasury.lastFundingAtMs) || 0),
      lastFundingAmountISK: Math.max(0, Number(sourceTreasury.lastFundingAmountISK) || 0),
      totalFundedISK: Math.max(0, Number(sourceTreasury.totalFundedISK) || 0),
      replenishmentCount: Math.max(0, Math.trunc(Number(sourceTreasury.replenishmentCount) || 0)),
    },
    maintenance: {
      existingContractsCleared: sourceMaintenance.existingContractsCleared === true,
      legacyCleanupVersion: Math.max(0, Math.trunc(Number(sourceMaintenance.legacyCleanupVersion) || 0)),
    },
    haulerProgression,
    automation: {
      players: automationPlayers,
    },
    contracts,
  };
}

function createStateStore(filePath) {
  const resolvedPath = path.resolve(filePath);

  function load() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(resolvedPath, "utf8")));
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        throw error;
      }
      return defaultState();
    }
  }

  function save(value) {
    const normalized = normalizeState(value);
    fs.mkdirSync(path.dirname(resolvedPath), {recursive: true});
    fs.writeFileSync(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return clone(normalized);
  }

  return Object.freeze({
    filePath: resolvedPath,
    load,
    save,
  });
}

module.exports = {
  STATE_VERSION,
  createStateStore,
  defaultState,
  normalizeAutomationPlayer,
  normalizeState,
};
