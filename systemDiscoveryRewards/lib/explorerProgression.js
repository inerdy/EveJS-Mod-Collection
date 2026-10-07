"use strict";

const DEFAULT_MAX_LEVEL = 50;
const DEFAULT_XP_TO_NEXT_LEVEL_BASE = 1000;
const DEFAULT_XP_TO_NEXT_LEVEL_PER_LEVEL = 250;

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function nonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function progressionConfig(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  return {
    maxLevel: Math.max(1, Math.min(50, positive(source.maxLevel, DEFAULT_MAX_LEVEL))),
    xpToNextLevelBase: Math.max(
      1,
      Math.floor(nonNegative(source.xpToNextLevelBase, DEFAULT_XP_TO_NEXT_LEVEL_BASE)),
    ),
    xpToNextLevelPerLevel: Math.max(
      0,
      Math.floor(nonNegative(source.xpToNextLevelPerLevel, DEFAULT_XP_TO_NEXT_LEVEL_PER_LEVEL)),
    ),
  };
}

function xpToNextLevel(level, config = {}) {
  const settings = progressionConfig(config);
  const normalizedLevel = Math.max(1, Math.min(settings.maxLevel, positive(level, 1)));
  return settings.xpToNextLevelBase +
    (normalizedLevel - 1) * settings.xpToNextLevelPerLevel;
}

function levelForXP(totalXP, config = {}) {
  const settings = progressionConfig(config);
  let level = 1;
  let remaining = Math.max(0, Math.floor(nonNegative(totalXP, 0)));
  while (level < settings.maxLevel) {
    const required = xpToNextLevel(level, settings);
    if (remaining < required) {
      break;
    }
    remaining -= required;
    level += 1;
  }
  return level;
}

function totalXPForLevel(targetLevel, config = {}) {
  const settings = progressionConfig(config);
  const normalizedTarget = Math.max(1, Math.min(settings.maxLevel, positive(targetLevel, 1)));
  let total = 0;
  for (let level = 1; level < normalizedTarget; level += 1) {
    total += xpToNextLevel(level, settings);
  }
  return total;
}

function awardDiscovery(character, discovery, config = {}, nowMs = Date.now(), recentLimit = 10) {
  if (!character || !discovery || discovery.progressionApplied === true) {
    return {success: true, duplicate: true};
  }
  const settings = progressionConfig(config);
  const levelBefore = Math.max(1, positive(character.level, 1));
  const xp = Math.max(0, Math.floor(nonNegative(discovery.reward && discovery.reward.xp, 0)));
  const totalXP = Math.max(0, Math.floor(nonNegative(character.totalXP, 0))) + xp;
  const levelAfter = levelForXP(totalXP, settings);
  const normalizedDiscovery = {
    systemID: positive(discovery.systemID, 0),
    systemName: String(discovery.systemName || `System ${discovery.systemID}`),
    security: Number.isFinite(Number(discovery.security)) ? Number(discovery.security) : null,
    discoveredAtMs: Math.max(0, Math.floor(nonNegative(discovery.discoveredAtMs, nowMs))),
    reward: {
      isk: Math.round(nonNegative(discovery.reward && discovery.reward.isk, 0) * 100) / 100,
      xp,
      skillPoints: Math.max(0, Math.floor(nonNegative(
        discovery.reward && discovery.reward.skillPoints,
        0,
      ))),
      plex: Math.max(0, Math.floor(nonNegative(discovery.reward && discovery.reward.plex, 0))),
    },
    levelBefore,
    levelAfter,
  };
  character.totalXP = totalXP;
  character.level = levelAfter;
  character.systemsDiscovered = Math.max(0, Math.floor(nonNegative(character.systemsDiscovered, 0))) + 1;
  character.totalISK = Math.round(
    (nonNegative(character.totalISK, 0) + normalizedDiscovery.reward.isk) * 100,
  ) / 100;
  character.totalSkillPoints = Math.max(0, Math.floor(
    nonNegative(character.totalSkillPoints, 0) + normalizedDiscovery.reward.skillPoints,
  ));
  character.totalPlex = Math.max(0, Math.floor(nonNegative(character.totalPlex, 0))) +
    normalizedDiscovery.reward.plex;
  character.recentDiscoveries = [normalizedDiscovery, ...(character.recentDiscoveries || [])]
    .filter((entry, index, entries) => index === entries.findIndex((candidate) => (
      positive(candidate && candidate.systemID, 0) === normalizedDiscovery.systemID
    )))
    .slice(0, Math.max(1, Math.trunc(Number(recentLimit) || 10)));
  discovery.progressionApplied = true;
  discovery.status = "claimed";
  return {
    success: true,
    duplicate: false,
    xp,
    levelBefore,
    levelAfter,
    discovery: normalizedDiscovery,
  };
}

function buildSnapshot(character, config = {}) {
  const settings = progressionConfig(config);
  const source = character && typeof character === "object" ? character : {};
  const totalXP = Math.max(0, Math.floor(nonNegative(source.totalXP, 0)));
  const level = levelForXP(totalXP, settings);
  const levelStartXP = totalXPForLevel(level, settings);
  const levelTargetXP = level >= settings.maxLevel
    ? levelStartXP
    : levelStartXP + xpToNextLevel(level, settings);
  const xpIntoLevel = Math.max(0, totalXP - levelStartXP);
  const xpForNextLevel = Math.max(0, levelTargetXP - totalXP);
  const progressPercent = level >= settings.maxLevel || levelTargetXP <= levelStartXP
    ? 100
    : Math.min(100, Math.max(0, (xpIntoLevel / (levelTargetXP - levelStartXP)) * 100));
  return {
    level,
    maxLevel: settings.maxLevel,
    totalXP,
    xpIntoLevel,
    xpForNextLevel,
    progressPercent: Math.round(progressPercent * 10) / 10,
    systemsDiscovered: Math.max(0, Math.floor(nonNegative(source.systemsDiscovered, 0))),
    totalISK: Math.round(nonNegative(source.totalISK, 0) * 100) / 100,
    totalSkillPoints: Math.max(0, Math.floor(nonNegative(source.totalSkillPoints, 0))),
    totalPlex: Math.max(0, Math.floor(nonNegative(source.totalPlex, 0))),
    lastDiscovery: Array.isArray(source.recentDiscoveries) && source.recentDiscoveries.length > 0
      ? source.recentDiscoveries[0]
      : null,
    recentDiscoveries: Array.isArray(source.recentDiscoveries)
      ? source.recentDiscoveries
      : [],
  };
}

module.exports = {
  DEFAULT_MAX_LEVEL,
  DEFAULT_XP_TO_NEXT_LEVEL_BASE,
  DEFAULT_XP_TO_NEXT_LEVEL_PER_LEVEL,
  awardDiscovery,
  buildSnapshot,
  levelForXP,
  progressionConfig,
  totalXPForLevel,
  xpToNextLevel,
};
