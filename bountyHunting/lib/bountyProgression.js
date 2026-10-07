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

function normalizeReward(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const plexMinimum = Math.max(0, Math.floor(nonNegative(source.plexMinimum, 0)));
  return {
    isk: Math.round(nonNegative(source.isk, 0) * 100) / 100,
    skillPoints: Math.floor(nonNegative(source.skillPoints, 0)),
    plexMinimum,
    plexMaximum: Math.max(plexMinimum, Math.floor(nonNegative(source.plexMaximum, 0))),
    plex: Math.floor(nonNegative(source.plex, plexMinimum)),
    xp: Math.floor(nonNegative(source.xp, 0)),
  };
}

function normalizeKill(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    eventKey: String(source.eventKey || ""),
    killID: positive(source.killID, 0),
    tier: String(source.tier || "low"),
    tierLabel: String(source.tierLabel || source.tier || "Low"),
    npcName: String(source.npcName || "Unknown NPC"),
    npcTypeID: positive(source.npcTypeID, 0),
    systemID: positive(source.systemID, 0),
    bountyISK: Math.round(nonNegative(source.bountyISK, 0) * 100) / 100,
    reward: normalizeReward(source.reward),
    killedAtMs: Math.max(0, Math.floor(nonNegative(source.killedAtMs, 0))),
    iskPaid: source.iskPaid === true,
    plexPaid: source.plexPaid === true,
    skillPointsPaid: source.skillPointsPaid === true,
    progressionApplied: source.progressionApplied === true,
    notificationSent: source.notificationSent === true,
    status: String(source.status || "pending"),
  };
}

function normalizeCharacter(raw = {}, recentLimit = 10) {
  const source = raw && typeof raw === "object" ? raw : {};
  const recentKills = Array.isArray(source.recentKills)
    ? source.recentKills.map(normalizeKill).filter((entry) => entry.eventKey).slice(0, recentLimit)
    : [];
  const sourceKills = source.kills && typeof source.kills === "object" ? source.kills : {};
  const kills = {};
  for (const [key, value] of Object.entries(sourceKills)) {
    const kill = normalizeKill({...value, eventKey: value && value.eventKey || key});
    if (kill.eventKey) {
      kills[kill.eventKey] = kill;
    }
  }
  const sourceTierCounts = source.killsByTier && typeof source.killsByTier === "object"
    ? source.killsByTier
    : {};
  const killsByTier = {};
  for (const [tier, value] of Object.entries(sourceTierCounts)) {
    killsByTier[String(tier)] = Math.max(0, Math.floor(nonNegative(value, 0)));
  }
  return {
    totalXP: Math.floor(nonNegative(source.totalXP, 0)),
    level: levelForXP(source.totalXP, {}),
    totalKills: Math.floor(nonNegative(source.totalKills, 0)),
    killsByTier,
    totalISK: Math.round(nonNegative(source.totalISK, 0) * 100) / 100,
    totalSkillPoints: Math.floor(nonNegative(source.totalSkillPoints, 0)),
    totalPlex: Math.floor(nonNegative(source.totalPlex, 0)),
    lastKill: recentKills[0] || null,
    recentKills,
    kills,
  };
}

function awardKill(character, kill, config = {}, nowMs = Date.now(), recentLimit = 10) {
  if (!character || !kill || kill.progressionApplied === true) {
    return {success: true, duplicate: true};
  }
  const eventKey = String(kill.eventKey || "");
  if (eventKey && character.kills && character.kills[eventKey] &&
    character.kills[eventKey].progressionApplied === true) {
    return {success: true, duplicate: true, kill: character.kills[eventKey]};
  }
  const settings = progressionConfig(config);
  const normalized = normalizeKill(kill);
  const levelBefore = levelForXP(character.totalXP, settings);
  const totalXP = Math.max(0, Math.floor(nonNegative(character.totalXP, 0))) + normalized.reward.xp;
  const levelAfter = levelForXP(totalXP, settings);
  character.totalXP = totalXP;
  character.level = levelAfter;
  character.totalKills = Math.floor(nonNegative(character.totalKills, 0)) + 1;
  character.killsByTier[normalized.tier] = Math.floor(
    nonNegative(character.killsByTier[normalized.tier], 0),
  ) + 1;
  character.totalISK = Math.round(
    (nonNegative(character.totalISK, 0) + normalized.reward.isk) * 100,
  ) / 100;
  character.totalSkillPoints = Math.floor(
    nonNegative(character.totalSkillPoints, 0) + normalized.reward.skillPoints,
  );
  character.totalPlex = Math.floor(
    nonNegative(character.totalPlex, 0) + normalized.reward.plex,
  );
  normalized.levelBefore = levelBefore;
  normalized.levelAfter = levelAfter;
  normalized.progressionApplied = true;
  normalized.status = "claimed";
  character.kills[normalized.eventKey] = normalized;
  character.recentKills = [normalized, ...(character.recentKills || [])]
    .filter((entry, index, entries) => (
      index === entries.findIndex((candidate) => candidate.eventKey === normalized.eventKey)
    ))
    .slice(0, Math.max(1, Math.trunc(Number(recentLimit) || 10)));
  character.lastKill = normalized;
  return {
    success: true,
    duplicate: false,
    kill: normalized,
    levelBefore,
    levelAfter,
  };
}

function buildSnapshot(character, config = {}, tiers = [], recentLimit = 10) {
  const settings = progressionConfig(config);
  const source = normalizeCharacter(character, recentLimit);
  source.level = levelForXP(source.totalXP, settings);
  const levelStartXP = totalXPForLevel(source.level, settings);
  const levelTargetXP = source.level >= settings.maxLevel
    ? levelStartXP
    : levelStartXP + xpToNextLevel(source.level, settings);
  const xpIntoLevel = Math.max(0, source.totalXP - levelStartXP);
  const xpForNextLevel = Math.max(0, levelTargetXP - source.totalXP);
  const progressPercent = source.level >= settings.maxLevel || levelTargetXP <= levelStartXP
    ? 100
    : Math.min(100, Math.max(0, (xpIntoLevel / (levelTargetXP - levelStartXP)) * 100));
  return {
    level: source.level,
    maxLevel: settings.maxLevel,
    totalXP: source.totalXP,
    xpIntoLevel,
    xpForNextLevel,
    progressPercent: Math.round(progressPercent * 10) / 10,
    totalKills: source.totalKills,
    killsByTier: source.killsByTier,
    totalISK: source.totalISK,
    totalSkillPoints: source.totalSkillPoints,
    totalPlex: source.totalPlex,
    lastKill: source.lastKill,
    recentKills: source.recentKills,
    rewardTiers: Array.isArray(tiers) ? tiers : [],
  };
}

module.exports = {
  DEFAULT_MAX_LEVEL,
  DEFAULT_XP_TO_NEXT_LEVEL_BASE,
  DEFAULT_XP_TO_NEXT_LEVEL_PER_LEVEL,
  awardKill,
  buildSnapshot,
  levelForXP,
  normalizeCharacter,
  normalizeKill,
  progressionConfig,
  totalXPForLevel,
  xpToNextLevel,
};
