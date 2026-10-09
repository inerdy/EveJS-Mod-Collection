"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_VERSION = 1;

function nonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    characters: {},
    nextRequestID: 1,
  };
}

function normalizeCharacter(raw = {}) {
  return {
    cooldownUntilMs: Math.max(0, Math.trunc(nonNegative(raw.cooldownUntilMs))),
    lastRequestID: Math.max(0, Math.trunc(nonNegative(raw.lastRequestID))),
    lastCompletedAtMs: Math.max(0, Math.trunc(nonNegative(raw.lastCompletedAtMs))),
    lastStatus: String(raw.lastStatus || "").slice(0, 40),
  };
}

function normalizeState(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const characters = {};
  for (const [key, value] of Object.entries(source.characters || {})) {
    if (/^\d+$/.test(key) && Number(key) > 0) {
      characters[key] = normalizeCharacter(value);
    }
  }
  return {
    schemaVersion: STATE_VERSION,
    characters,
    nextRequestID: Math.max(1, Math.trunc(nonNegative(source.nextRequestID, 1))),
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
  normalizeCharacter,
  normalizeState,
};
