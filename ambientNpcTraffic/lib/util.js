"use strict";

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSystemID(value) {
  return positive(value, 0);
}

function isActiveScene(scene) {
  return Boolean(
    scene &&
    normalizeSystemID(scene.systemID) > 0 &&
    String(scene.sceneKind || "solarSystem").toLowerCase() !== "abyssal" &&
    scene.sessions instanceof Map &&
    scene.sessions.size > 0,
  );
}

function entityIsWarping(entity) {
  if (!entity) {
    return false;
  }
  const mode = String(entity.mode || "").trim().toUpperCase();
  return Boolean(
    mode === "WARP" ||
    entity.warpState ||
    entity.pendingWarp ||
    entity.sessionlessWarpIngress,
  );
}

function currentEntityID(record) {
  return positive(record && record.liveEntityID, 0);
}

function buildTrafficSeed(bootSeed, sequence, systemID) {
  return `${bootSeed}:${sequence}:${systemID}`;
}

function buildTrafficID(bootSeed, sequence) {
  return `ambient-${bootSeed}-${sequence}`;
}

module.exports = {
  buildTrafficID,
  buildTrafficSeed,
  currentEntityID,
  entityIsWarping,
  finite,
  isActiveScene,
  normalizeSystemID,
  positive,
};
