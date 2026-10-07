"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {normalizeCharacter} = require("./bountyProgression");

const STATE_VERSION = 2;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    characters: {},
  };
}

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeState(raw, recentLimit = 10) {
  const source = raw && typeof raw === "object" ? raw : {};
  const characters = {};
  const sourceCharacters = source.characters && typeof source.characters === "object"
    ? source.characters
    : {};
  for (const [characterID, value] of Object.entries(sourceCharacters)) {
    const numericCharacterID = positive(characterID, 0);
    if (numericCharacterID > 0) {
      characters[String(numericCharacterID)] = normalizeCharacter(value, recentLimit);
    }
  }
  return {
    schemaVersion: STATE_VERSION,
    characters,
  };
}

function createStateStore(filePath, recentLimit = 10) {
  const resolvedPath = path.resolve(filePath);
  return Object.freeze({
    filePath: resolvedPath,
    load() {
      try {
        return normalizeState(
          JSON.parse(fs.readFileSync(resolvedPath, "utf8")),
          recentLimit,
        );
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          throw error;
        }
        return defaultState();
      }
    },
    save(value) {
      const normalized = normalizeState(value, recentLimit);
      fs.mkdirSync(path.dirname(resolvedPath), {recursive: true});
      fs.writeFileSync(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      return clone(normalized);
    },
  });
}

module.exports = {
  STATE_VERSION,
  createStateStore,
  defaultState,
  normalizeState,
};
