"use strict";

const path = require("node:path");

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  apparelCategoryID: 30,
  apparelGroupIDs: [1083, 1084, 1088, 1089, 1090, 1091, 1092],
});

function positive(value, fallback = 0) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : fallback;
}

function normalizeConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const groups = Array.isArray(source.apparelGroupIDs)
    ? source.apparelGroupIDs.map((value) => positive(value)).filter(Boolean)
    : DEFAULT_CONFIG.apparelGroupIDs;
  return {
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : Boolean(source.enabled),
    apparelCategoryID: positive(source.apparelCategoryID, DEFAULT_CONFIG.apparelCategoryID),
    apparelGroupIDs: [...new Set(groups)],
  };
}

function loadConfig() {
  try {
    return normalizeConfig(require(path.join(__dirname, "..", "config", "apparel.json")));
  } catch (_error) {
    return normalizeConfig();
  }
}

module.exports = {DEFAULT_CONFIG, loadConfig, normalizeConfig};
