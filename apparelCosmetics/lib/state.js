"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_VERSION = 1;

function positive(value, fallback = 0) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return positive(value.value, fallback);
  }
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : fallback;
}

function normalizeCharacter(raw = {}) {
  const unlockedByTypeID = {};
  for (const [typeID, value] of Object.entries(raw.unlockedByTypeID || {})) {
    const numericTypeID = positive(typeID);
    if (numericTypeID <= 0) continue;
    unlockedByTypeID[String(numericTypeID)] = {
      activatedAt: Math.max(0, Math.trunc(Number(value && value.activatedAt) || 0)),
      sourceItemID: positive(value && value.sourceItemID),
    };
  }
  return {
    legacyMigratedAt: Math.max(0, Math.trunc(Number(raw.legacyMigratedAt) || 0)),
    unlockedByTypeID,
  };
}

function normalizeState(raw = {}) {
  const characters = {};
  for (const [characterID, value] of Object.entries(raw.characters || {})) {
    const numericCharacterID = positive(characterID);
    if (numericCharacterID > 0) {
      characters[String(numericCharacterID)] = normalizeCharacter(value);
    }
  }
  return {schemaVersion: STATE_VERSION, characters};
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
        return normalizeState({});
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

module.exports = {STATE_VERSION, createStateStore, normalizeCharacter, normalizeState};
