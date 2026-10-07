"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function nonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    characters: {},
  };
}

function normalizeReward(raw = {}) {
  return {
    isk: Math.round(nonNegative(raw.isk, 0) * 100) / 100,
    xp: Math.max(0, Math.floor(nonNegative(raw.xp, 0))),
    skillPoints: Math.max(0, Math.floor(nonNegative(raw.skillPoints, 0))),
    plex: Math.max(0, Math.floor(nonNegative(raw.plex, 0))),
  };
}

function normalizeDiscovery(raw = {}, systemKey = "") {
  const systemID = positive(raw.systemID, positive(systemKey, 0));
  const status = raw.status === "claimed" ? "claimed" : "pending";
  return {
    systemID,
    systemName: String(raw.systemName || `System ${systemID}`),
    security: Number.isFinite(Number(raw.security)) ? Number(raw.security) : null,
    discoveredAtMs: Math.max(0, Math.floor(nonNegative(raw.discoveredAtMs, 0))),
    reward: normalizeReward(raw.reward),
    iskPaid: raw.iskPaid === true,
    skillPointsPaid: raw.skillPointsPaid === true,
    plexPaid: raw.plexPaid === true,
    progressionApplied: raw.progressionApplied === true,
    status,
  };
}

function normalizeRecent(raw = []) {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => normalizeDiscovery(entry, entry && entry.systemID))
    .filter((entry) => entry.systemID > 0);
}

function normalizeCharacter(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const discoveries = {};
  const sourceDiscoveries = source.discoveries && typeof source.discoveries === "object"
    ? source.discoveries
    : {};
  for (const [key, value] of Object.entries(sourceDiscoveries)) {
    const discovery = normalizeDiscovery(value, key);
    if (discovery.systemID > 0) {
      discoveries[String(discovery.systemID)] = discovery;
    }
  }
  return {
    totalXP: Math.max(0, Math.floor(nonNegative(source.totalXP, 0))),
    level: Math.max(1, positive(source.level, 1)),
    systemsDiscovered: Math.max(0, Math.floor(nonNegative(source.systemsDiscovered, 0))),
    totalISK: Math.round(nonNegative(source.totalISK, 0) * 100) / 100,
    totalSkillPoints: Math.max(0, Math.floor(nonNegative(source.totalSkillPoints, 0))),
    totalPlex: Math.max(0, Math.floor(nonNegative(source.totalPlex, 0))),
    discoveries,
    recentDiscoveries: normalizeRecent(source.recentDiscoveries),
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const characters = {};
  const sourceCharacters = source.characters && typeof source.characters === "object"
    ? source.characters
    : {};
  for (const [key, value] of Object.entries(sourceCharacters)) {
    const characterID = positive(key, 0);
    if (characterID > 0) {
      characters[String(characterID)] = normalizeCharacter(value);
    }
  }
  return {
    schemaVersion: STATE_VERSION,
    characters,
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
    const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, resolvedPath);
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
  normalizeState,
  normalizeCharacter,
  normalizeDiscovery,
};
