"use strict";

const DEFAULT_MAX_LEVEL = 50;
const DEFAULT_BASE_XP_PER_CONTRACT = 100;
const DEFAULT_XP_PER_JUMP = 10;
const DEFAULT_PAYOUT_BONUS_PER_LEVEL = 0.03;
const DEFAULT_XP_TO_NEXT_LEVEL_BASE = 1000;
const DEFAULT_XP_TO_NEXT_LEVEL_PER_LEVEL = 250;
const MAX_RECENT_AWARDS = 10;

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
    maxLevel: Math.max(1, positive(source.maxLevel, DEFAULT_MAX_LEVEL)),
    baseXPPerContract: Math.max(
      0,
      nonNegative(source.baseXPPerContract, DEFAULT_BASE_XP_PER_CONTRACT),
    ),
    xpPerJump: Math.max(0, nonNegative(source.xpPerJump, DEFAULT_XP_PER_JUMP)),
    payoutBonusPerLevel: Math.max(
      0,
      nonNegative(source.payoutBonusPerLevel, DEFAULT_PAYOUT_BONUS_PER_LEVEL),
    ),
    xpToNextLevelBase: Math.max(
      1,
      nonNegative(source.xpToNextLevelBase, DEFAULT_XP_TO_NEXT_LEVEL_BASE),
    ),
    xpToNextLevelPerLevel: Math.max(
      0,
      nonNegative(source.xpToNextLevelPerLevel, DEFAULT_XP_TO_NEXT_LEVEL_PER_LEVEL),
    ),
  };
}

function xpToNextLevel(level, config) {
  const settings = progressionConfig(config);
  const normalizedLevel = Math.max(1, Math.min(settings.maxLevel, positive(level, 1)));
  return Math.round(
    settings.xpToNextLevelBase +
      (normalizedLevel - 1) * settings.xpToNextLevelPerLevel,
  );
}

function levelForXP(totalXP, config) {
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

function totalXPForLevel(targetLevel, config) {
  const settings = progressionConfig(config);
  const normalizedTarget = Math.max(1, Math.min(settings.maxLevel, positive(targetLevel, 1)));
  let total = 0;
  for (let level = 1; level < normalizedTarget; level += 1) {
    total += xpToNextLevel(level, settings);
  }
  return total;
}

function normalizeAward(raw = {}) {
  return {
    contractID: positive(raw.contractID, 0),
    xp: Math.max(0, Math.floor(nonNegative(raw.xp, 0))),
    bonusISK: Math.round(nonNegative(raw.bonusISK, 0) * 100) / 100,
    levelBefore: Math.max(1, positive(raw.levelBefore, 1)),
    levelAfter: Math.max(1, positive(raw.levelAfter, 1)),
    completedAtMs: Math.max(0, Math.floor(nonNegative(raw.completedAtMs, 0))),
  };
}

function normalizePlayer(raw = {}, config = {}) {
  const settings = progressionConfig(config);
  const source = raw && typeof raw === "object" ? raw : {};
  const totalXP = Math.max(0, Math.floor(nonNegative(source.totalXP, 0)));
  const awards = {};
  const sourceAwards = source.awardedContracts && typeof source.awardedContracts === "object"
    ? source.awardedContracts
    : {};
  for (const [contractID, award] of Object.entries(sourceAwards)) {
    const normalized = normalizeAward({...award, contractID: award && award.contractID || contractID});
    if (normalized.contractID > 0) {
      awards[String(normalized.contractID)] = normalized;
    }
  }
  const recentAwards = Array.isArray(source.recentAwards)
    ? source.recentAwards.map(normalizeAward).filter((award) => award.contractID > 0).slice(0, MAX_RECENT_AWARDS)
    : [];
  return {
    totalXP,
    level: levelForXP(totalXP, settings),
    contractsCompleted: Math.max(0, Math.floor(nonNegative(source.contractsCompleted, 0))),
    totalJumps: Math.max(0, Math.floor(nonNegative(source.totalJumps, 0))),
    totalVolumeM3: Math.round(nonNegative(source.totalVolumeM3, 0) * 100) / 100,
    lastAward: recentAwards[0] || null,
    recentAwards,
    awardedContracts: awards,
  };
}

function normalizeProgressionState(raw = {}, config = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const players = {};
  const sourcePlayers = source.players && typeof source.players === "object"
    ? source.players
    : {};
  for (const [characterID, player] of Object.entries(sourcePlayers)) {
    const numericCharacterID = positive(characterID, 0);
    if (numericCharacterID > 0) {
      players[String(numericCharacterID)] = normalizePlayer(player, config);
    }
  }
  return {players};
}

function ensurePlayer(progressState, characterID, config = {}) {
  const numericCharacterID = positive(characterID, 0);
  if (!numericCharacterID) {
    return null;
  }
  const normalizedState = normalizeProgressionState(progressState, config);
  progressState.players = normalizedState.players;
  const key = String(numericCharacterID);
  if (!progressState.players[key]) {
    progressState.players[key] = normalizePlayer({}, config);
  }
  return progressState.players[key];
}

function calculateXP(record, config = {}) {
  const settings = progressionConfig(config);
  const jumps = Math.max(0, positive(record && record.jumps, 0));
  return Math.max(0, Math.floor(settings.baseXPPerContract + jumps * settings.xpPerJump));
}

function payoutBonusForLevel(reward, level, config = {}, maximumReward = null) {
  const settings = progressionConfig(config);
  const baseReward = Math.max(0, Number(reward) || 0);
  const levelBonus = Math.max(0, positive(level, 1) - 1) * settings.payoutBonusPerLevel;
  const scaledReward = baseReward * (1 + levelBonus);
  const cappedReward = maximumReward !== null && Number.isFinite(Number(maximumReward))
    ? Math.min(scaledReward, Math.max(0, Number(maximumReward)))
    : scaledReward;
  return Math.round(Math.max(0, cappedReward - baseReward) * 100) / 100;
}

function awardCompletion(progressState, characterID, record, config = {}, maximumReward = null, completedAtMs = Date.now()) {
  const settings = progressionConfig(config);
  const player = ensurePlayer(progressState, characterID, settings);
  if (!player) {
    return {success: false, errorMsg: "HAULER_CHARACTER_REQUIRED"};
  }
  const contractID = positive(record && record.contractID, 0);
  if (!contractID) {
    return {success: false, errorMsg: "HAULER_CONTRACT_REQUIRED"};
  }
  const existing = player.awardedContracts[String(contractID)];
  if (existing) {
    return {success: true, duplicate: true, award: existing, player};
  }

  const levelBefore = player.level;
  const xp = calculateXP(record, settings);
  const totalXP = player.totalXP + xp;
  const levelAfter = levelForXP(totalXP, settings);
  const award = normalizeAward({
    contractID,
    xp,
    bonusISK: payoutBonusForLevel(
      record && record.reward,
      levelBefore,
      settings,
      maximumReward,
    ),
    levelBefore,
    levelAfter,
    completedAtMs,
  });
  player.totalXP = totalXP;
  player.level = levelAfter;
  player.contractsCompleted += 1;
  player.totalJumps += Math.max(0, positive(record && record.jumps, 0));
  player.totalVolumeM3 = Math.round(
    (player.totalVolumeM3 + Math.max(0, Number(record && record.volume) || 0)) * 100,
  ) / 100;
  player.awardedContracts[String(contractID)] = award;
  player.recentAwards = [award, ...player.recentAwards]
    .filter((entry, index, entries) => index === entries.findIndex((candidate) => candidate.contractID === entry.contractID))
    .slice(0, MAX_RECENT_AWARDS);
  player.lastAward = award;
  return {success: true, duplicate: false, award, player};
}

function buildSnapshot(progressState, characterID, config = {}) {
  const settings = progressionConfig(config);
  const player = normalizePlayer(
    progressState && progressState.players && progressState.players[String(positive(characterID, 0))],
    settings,
  );
  const levelStartXP = totalXPForLevel(player.level, settings);
  const levelTargetXP = player.level >= settings.maxLevel
    ? levelStartXP
    : levelStartXP + xpToNextLevel(player.level, settings);
  const xpIntoLevel = Math.max(0, player.totalXP - levelStartXP);
  const xpForNextLevel = Math.max(0, levelTargetXP - player.totalXP);
  const progressPercent = player.level >= settings.maxLevel || levelTargetXP <= levelStartXP
    ? 100
    : Math.min(100, Math.max(0, (xpIntoLevel / (levelTargetXP - levelStartXP)) * 100));
  return {
    ...player,
    maxLevel: settings.maxLevel,
    levelStartXP,
    xpIntoLevel,
    xpForNextLevel,
    progressPercent: Math.round(progressPercent * 10) / 10,
    payoutBonusPercent: Math.round(
      Math.max(0, player.level - 1) * settings.payoutBonusPerLevel * 10000,
    ) / 100,
  };
}

module.exports = {
  DEFAULT_BASE_XP_PER_CONTRACT,
  DEFAULT_MAX_LEVEL,
  DEFAULT_PAYOUT_BONUS_PER_LEVEL,
  DEFAULT_XP_PER_JUMP,
  awardCompletion,
  buildSnapshot,
  calculateXP,
  ensurePlayer,
  levelForXP,
  normalizePlayer,
  normalizeProgressionState,
  payoutBonusForLevel,
  progressionConfig,
  totalXPForLevel,
  xpToNextLevel,
};
