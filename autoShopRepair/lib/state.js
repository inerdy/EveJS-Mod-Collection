"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_VERSION = 1;

function normalizeCharacterState(value) {
  return {enabled: !(value && value.enabled === false)};
}

function normalizeState(value) {
  const characters = value && typeof value.characters === "object" && value.characters
    ? value.characters
    : {};
  const normalized = {};
  for (const [characterID, characterState] of Object.entries(characters)) {
    normalized[String(characterID)] = normalizeCharacterState(characterState);
  }
  return {schemaVersion: STATE_VERSION, characters: normalized};
}

function createStore(statePath) {
  function read() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(statePath, "utf8")));
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        console.warn(`[autoShopRepair] could not read settings: ${error.message}`);
      }
      return normalizeState(null);
    }
  }

  function write(state) {
    const normalized = normalizeState(state);
    fs.mkdirSync(path.dirname(statePath), {recursive: true});
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, statePath);
    return normalized;
  }

  function getEnabled(characterID) {
    const state = read();
    return normalizeCharacterState(state.characters[String(characterID)]).enabled;
  }

  function setEnabled(characterID, enabled) {
    const state = read();
    state.characters[String(characterID)] = {enabled: enabled !== false};
    write(state);
    return state.characters[String(characterID)].enabled;
  }

  return {read, write, getEnabled, setEnabled};
}

module.exports = {STATE_VERSION, normalizeCharacterState, normalizeState, createStore};
