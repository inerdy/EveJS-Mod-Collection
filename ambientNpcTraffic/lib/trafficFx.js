"use strict";

const log = require(require("./runtime").serverPath("utils", "logger"));
const {DECLOAK_DURATION_MS, JUMP_IN_DURATION_MS, MOD_ID} = require("./constants");
const {positive} = require("./util");

function jumpGraphicInfo(gate) {
  return {
    type: "tuple",
    items: [
      positive(gate && (gate.destinationSolarSystemID || gate.destinationSystemID), 0) || null,
      null,
    ],
  };
}

function broadcastFx(scene, entity, guid, fxOptions, visibilityEntity) {
  if (!scene || typeof scene.broadcastSpecialFx !== "function" || !entity) {
    return false;
  }
  try {
    scene.broadcastSpecialFx(entity.itemID, guid, {
      start: true,
      active: false,
      ...fxOptions,
    }, visibilityEntity);
    return true;
  } catch (error) {
    log.warn(`[${MOD_ID}] ${guid} failed entity=${entity.itemID}: ${error.message}`);
    return false;
  }
}

function playJumpOut(scene, ship, gate, dependencies) {
  const resetMotion = dependencies &&
    dependencies.destinyMovement &&
    dependencies.destinyMovement.resetEntityMotion;
  if (ship && typeof resetMotion === "function") {
    resetMotion(ship);
  }
  const gateID = positive(gate && gate.itemID, 0) || null;
  const graphicInfo = jumpGraphicInfo(gate);
  const shipOptions = {
    targetID: gateID,
    graphicInfo,
    includeStopInSameUpdate: true,
    useCurrentStamp: true,
    minimumLeadFromCurrentHistory: 1,
  };
  // JumpOut belongs on the ship. The gate is only the target, the same way a
  // pilot jump is authored. Play it on the current stamp so it is not still
  // queued when the NPC is removed.
  return broadcastFx(scene, ship, "effects.JumpOut", shipOptions, ship);
}

function playJumpIn(scene, ship) {
  return broadcastFx(scene, ship, "effects.JumpIn", {
    duration: JUMP_IN_DURATION_MS,
    useCurrentStamp: true,
    minimumLeadFromCurrentHistory: 1,
  }, ship);
}

function playDecloak(scene, ship) {
  return broadcastFx(scene, ship, "effects.Uncloak", {
    duration: DECLOAK_DURATION_MS,
    useCurrentStamp: true,
    minimumLeadFromCurrentHistory: 1,
  }, ship);
}

function playSpawnPresentation(scene, ship, options = {}) {
  const playedDecloak = playDecloak(scene, ship);
  if (options.jumpArrival === true) {
    playJumpIn(scene, ship);
  }
  return playedDecloak;
}

module.exports = {
  broadcastFx,
  jumpGraphicInfo,
  playDecloak,
  playJumpIn,
  playJumpOut,
  playSpawnPresentation,
};
