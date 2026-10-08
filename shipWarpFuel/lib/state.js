"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_VERSION = 2;

function nonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    characters: {},
    ships: {},
    nextEmergencyID: 1,
    nextWarpID: 1,
    nextInventoryMoveID: 1,
  };
}

function normalizeShip(raw = {}) {
  return {
    characterID: positive(raw.characterID),
    fuelTypeID: positive(raw.fuelTypeID),
    totalWarpAU: nonNegative(raw.totalWarpAU),
    warpCount: Math.max(0, Math.trunc(nonNegative(raw.warpCount))),
    lastWarpAtMs: Math.max(0, Math.trunc(nonNegative(raw.lastWarpAtMs))),
    recentWarps: Array.isArray(raw.recentWarps)
      ? raw.recentWarps.slice(0, 100).map((entry) => ({
          distanceAU: nonNegative(entry && entry.distanceAU),
          fuelUnits: Math.max(0, Math.trunc(nonNegative(entry && entry.fuelUnits))),
          atMs: Math.max(0, Math.trunc(nonNegative(entry && entry.atMs))),
        }))
      : [],
  };
}

function normalizeCharacter(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const initialFills = {};
  for (const [shipID, entry] of Object.entries(source.initialFills || {})) {
    if (!/^\d+$/.test(shipID)) continue;
    initialFills[shipID] = {
      completed: entry && entry.completed === true,
      quantity: Math.max(0, Math.trunc(nonNegative(entry && entry.quantity))),
      atMs: Math.max(0, Math.trunc(nonNegative(entry && entry.atMs))),
    };
  }
  const emergencyRequests = {};
  for (const [requestID, entry] of Object.entries(source.emergencyRequests || {})) {
    if (!/^\d+$/.test(requestID)) continue;
    emergencyRequests[requestID] = {
      status: String(entry && entry.status || "pending"),
      shipID: positive(entry && entry.shipID),
      systemID: positive(entry && entry.systemID),
      fuelUnits: Math.max(0, Math.trunc(nonNegative(entry && entry.fuelUnits))),
      fuelTypeID: positive(entry && entry.fuelTypeID),
      feeISK: Math.round(nonNegative(entry && entry.feeISK) * 100) / 100,
      chargedISK: Math.round(nonNegative(entry && entry.chargedISK) * 100) / 100,
      debtISK: Math.round(nonNegative(entry && entry.debtISK) * 100) / 100,
      createdAtMs: Math.max(0, Math.trunc(nonNegative(entry && entry.createdAtMs))),
      completedAtMs: Math.max(0, Math.trunc(nonNegative(entry && entry.completedAtMs))),
    };
  }
  return {
    cooldownUntilMs: Math.max(0, Math.trunc(nonNegative(source.cooldownUntilMs))),
    debtISK: Math.round(nonNegative(source.debtISK) * 100) / 100,
    debtSequence: Math.max(0, Math.trunc(nonNegative(source.debtSequence))),
    initialFills,
    emergencyRequests,
    pendingDebtCollection: source.pendingDebtCollection && typeof source.pendingDebtCollection === "object"
      ? {
          key: String(source.pendingDebtCollection.key || ""),
          amount: Math.round(nonNegative(source.pendingDebtCollection.amount) * 100) / 100,
        }
      : null,
  };
}

function normalizeState(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const characters = {};
  for (const [key, value] of Object.entries(source.characters || {})) {
    if (/^\d+$/.test(key) && positive(key)) characters[key] = normalizeCharacter(value);
  }
  const ships = {};
  for (const [key, value] of Object.entries(source.ships || {})) {
    if (/^\d+$/.test(key) && positive(key)) ships[key] = normalizeShip(value);
  }
  return {
    schemaVersion: STATE_VERSION,
    characters,
    ships,
    nextEmergencyID: Math.max(1, Math.trunc(nonNegative(source.nextEmergencyID, 1))),
    nextWarpID: Math.max(1, Math.trunc(nonNegative(source.nextWarpID, 1))),
    nextInventoryMoveID: Math.max(1, Math.trunc(nonNegative(source.nextInventoryMoveID, 1))),
  };
}

function createStateStore(filePath) {
  const resolvedPath = path.resolve(filePath);
  return Object.freeze({
    filePath: resolvedPath,
    load() {
      try {
        return normalizeState(JSON.parse(fs.readFileSync(resolvedPath, "utf8")));
      } catch (error) {
        if (error && error.code !== "ENOENT") throw error;
        return defaultState();
      }
    },
    save(value) {
      const normalized = normalizeState(value);
      fs.mkdirSync(path.dirname(resolvedPath), {recursive: true});
      const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, resolvedPath);
      return normalized;
    },
  });
}

module.exports = {
  STATE_VERSION,
  createStateStore,
  defaultState,
  normalizeState,
  normalizeCharacter,
  normalizeShip,
};
