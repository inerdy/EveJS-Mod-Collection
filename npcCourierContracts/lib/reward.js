"use strict";

const {securityClass} = require("./routePlanner");

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function calculateCargoVolume(quantity, metadata) {
  return Math.max(0, finite(quantity, 0) * finite(metadata && metadata.volume, 0));
}

function calculateReferenceValue(quantity, catalogEntry) {
  return Math.max(0, finite(quantity, 0) * finite(catalogEntry && catalogEntry.referenceValueISK, 0));
}

function calculateCargoTotals(items) {
  return (Array.isArray(items) ? items : []).reduce((totals, entry) => ({
    volumeM3: totals.volumeM3 + calculateCargoVolume(entry.quantity, entry.metadata),
    referenceValueISK: totals.referenceValueISK + calculateReferenceValue(entry.quantity, entry.item),
  }), {volumeM3: 0, referenceValueISK: 0});
}

function calculateReward({jumps, volumeM3, security, config}) {
  const rewardConfig = config.reward;
  const className = securityClass(security);
  const multiplier = finite(
    rewardConfig.securityMultipliers[className],
    1,
  );
  const base = finite(rewardConfig.baseISK, 0) +
    Math.max(0, Math.trunc(finite(jumps, 0))) * finite(rewardConfig.perJumpISK, 0) +
    Math.max(0, finite(volumeM3, 0)) * finite(rewardConfig.perVolumeM3ISK, 0);
  return Math.round(clamp(
    base * Math.max(0, multiplier),
    finite(rewardConfig.minimumISK, 0),
    Math.max(finite(rewardConfig.minimumISK, 0), finite(rewardConfig.maximumISK, 0)),
  ));
}

function calculateCollateral(referenceValueISK, config) {
  const collateralConfig = config.collateral;
  return Math.round(clamp(
    Math.max(0, finite(referenceValueISK, 0)) * finite(collateralConfig.valueMultiplier, 0),
    finite(collateralConfig.minimumISK, 0),
    Math.max(finite(collateralConfig.minimumISK, 0), finite(collateralConfig.maximumISK, 0)),
  ));
}

function calculateDeliveryDays(jumps, config) {
  const courier = config.courier;
  const normalizedJumps = Math.max(0, Math.trunc(finite(jumps, 0)));
  return Math.max(
    1,
    Math.trunc(finite(courier.baseDeliveryDays, 1)) +
      Math.ceil(normalizedJumps / Math.max(1, Math.trunc(finite(courier.jumpsPerExtraDeliveryDay, 10)))),
  );
}

module.exports = {
  calculateCargoVolume,
  calculateCargoTotals,
  calculateCollateral,
  calculateDeliveryDays,
  calculateReferenceValue,
  calculateReward,
};
