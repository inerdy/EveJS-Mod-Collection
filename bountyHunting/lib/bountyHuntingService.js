"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const log = require(serverPath("utils", "logger"));
const {buildDict, buildList} = require(serverPath("services", "_shared", "serviceHelpers"));
const {PLEX_LOG_CATEGORY} = require(serverPath("services", "account", "plexVaultLogState"));
const {loadConfig} = require("./config");
const {createStateStore} = require("./state");
const {
  awardKill,
  buildSnapshot,
  normalizeCharacter,
} = require("./bountyProgression");

const MOD_ID = "bountyHunting";
const SERVICE_NAME = MOD_ID;

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function marshalValue(value) {
  if (Array.isArray(value)) {
    return buildList(value.map((entry) => marshalValue(entry)));
  }
  if (value && typeof value === "object") {
    return buildDict(Object.entries(value).map(([key, entry]) => [key, marshalValue(entry)]));
  }
  return value;
}

function characterIDFromSession(session) {
  return positive(session && (
    session.characterID || session.charID || session.charid
  ), 0);
}

function characterIDFromAttacker(attacker = {}) {
  return positive(
    attacker.characterID ||
      attacker.charID ||
      attacker.charid ||
      attacker.pilotCharacterID ||
      attacker.ownerCharacterID ||
      attacker.controllerOwnerID ||
      attacker.sourceOwnerID ||
      attacker.session && (
        attacker.session.characterID ||
        attacker.session.charID ||
        attacker.session.charid
      ),
    0,
  );
}

function isNativeNpc(entity = {}) {
  const npcEntityType = String(entity.npcEntityType || "").trim().toLowerCase();
  return Boolean(
    entity.nativeNpc === true ||
    entity.nativeNpcOccupied === true ||
    npcEntityType === "npc" ||
    npcEntityType === "concord",
  );
}

function systemIDFromEntity(entity = {}) {
  return positive(entity.systemID || entity.solarSystemID, 0);
}

function extractKillID(result) {
  return positive(
    result && (
      result.killID ||
      result.data && result.data.killID ||
      result.record && result.record.killID ||
      result.data && result.data.record && result.data.record.killID
    ),
    0,
  );
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function choosePlex(eventKey, tier) {
  const minimum = Math.max(0, Math.floor(finite(tier.plexMinimum, 0)));
  const maximum = Math.max(minimum, Math.floor(finite(tier.plexMaximum, minimum)));
  const range = maximum - minimum + 1;
  return minimum + (range > 0 ? hashString(`${eventKey}:plex`) % range : 0);
}

function tierForBounty(tiers, bountyISK) {
  const amount = Math.max(0, finite(bountyISK, 0));
  const source = Array.isArray(tiers) && tiers.length > 0 ? tiers : [];
  for (const tier of source) {
    if (tier.maxBountyISK === null || amount <= finite(tier.maxBountyISK, 0)) {
      return tier;
    }
  }
  return source[source.length - 1] || {
    id: "low",
    label: "Low",
    maxBountyISK: null,
    isk: 0,
    skillPoints: 0,
    plexMinimum: 0,
    plexMaximum: 0,
    xp: 0,
  };
}

function ensureCharacter(state, characterID, recentLimit) {
  const key = String(characterID);
  if (!state.characters[key]) {
    state.characters[key] = normalizeCharacter({}, recentLimit);
  }
  return state.characters[key];
}

function pendingKillCount(state) {
  let pending = 0;
  for (const character of Object.values(state.characters || {})) {
    for (const kill of Object.values(character && character.kills || {})) {
      if (kill && kill.status !== "claimed") {
        pending += 1;
      }
    }
  }
  return pending;
}

class BountyHuntingService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._database = options.database || null;
    this._dataDir = options.dataDir || this._resolveDataDir();
    this._stateStore = options.stateStore || createStateStore(
      path.join(this._dataDir, "bountyHunting", "state.json"),
      this._config.recentKillLimit,
    );
    this._state = this._stateStore.load();
    this._dependencies = options.dependencies || null;
    this._queues = new Map();
    this._retryTimer = null;

    if (this._config.enabled && options.autoStart !== false) {
      this._start();
    }
  }

  _resolveDataDir() {
    const store = this._database || database;
    return store._dataDir || path.join(REPO_ROOT, "_local");
  }

  _start() {
    if (this._retryTimer) {
      return;
    }
    this._retryTimer = setInterval(() => {
      void this._retryPendingRewards();
    }, 60000);
    if (this._retryTimer && typeof this._retryTimer.unref === "function") {
      this._retryTimer.unref();
    }
  }

  stop() {
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    return true;
  }

  getStatus() {
    return {
      enabled: this._config.enabled,
      characterCount: Object.keys(this._state.characters || {}).length,
      pendingRewards: pendingKillCount(this._state),
    };
  }

  Handle_GetStatus() {
    return this.getStatus();
  }

  Handle_GetBountyProgress(_args, session) {
    const characterID = characterIDFromSession(session);
    if (!characterID) {
      throw new Error("BOUNTY_HUNTING_CHARACTER_REQUIRED");
    }
    const character = ensureCharacter(this._state, characterID, this._config.recentKillLimit);
    return marshalValue(buildSnapshot(
      character,
      this._config.progression,
      this._config.tiers,
      this._config.recentKillLimit,
    ));
  }

  _getDependencies() {
    if (this._dependencies) {
      return this._dependencies;
    }
    this._dependencies = {
      walletState: require(serverPath("services", "account", "walletState")),
      characterState: require(serverPath("services", "character", "characterState")),
      skillQueueNotifications: require(serverPath(
        "services",
        "skills",
        "training",
        "skillQueueNotifications",
      )),
      chatHub: require(serverPath("services", "chat", "chatHub")),
      sessionRegistry: require(serverPath("services", "chat", "sessionRegistry")),
      bountyRuntime: require(serverPath("services", "bounty", "bountyRuntime")),
    };
    return this._dependencies;
  }

  _saveState() {
    this._stateStore.save(this._state);
  }

  _queueForCharacter(characterID, task) {
    const key = String(characterID);
    const previous = this._queues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this._queues.get(key) === next) {
          this._queues.delete(key);
        }
      });
    this._queues.set(key, next);
    return next;
  }

  _resolveBountyISK(victimEntity, systemID) {
    try {
      const bountyRuntime = this._getDependencies().bountyRuntime;
      if (bountyRuntime && typeof bountyRuntime.resolveNpcBountyAmount === "function") {
        const result = bountyRuntime.resolveNpcBountyAmount(victimEntity, {solarSystemID: systemID});
        return Math.max(0, finite(result && result.amount, 0));
      }
    } catch (error) {
      log.debug(`[${MOD_ID}] bounty tier resolution failed: ${error.message}`);
    }
    return Math.max(0, finite(victimEntity && victimEntity.bounty, 0));
  }

  _buildKillRecord({eventKey, killID, characterID, victimEntity, finalAttacker, whenMs}) {
    const systemID = systemIDFromEntity(victimEntity);
    const bountyISK = this._resolveBountyISK(victimEntity, systemID);
    const tier = tierForBounty(this._config.tiers, bountyISK);
    const reward = {
      isk: Math.max(0, finite(tier.isk, 0)),
      skillPoints: Math.max(0, Math.floor(finite(tier.skillPoints, 0))),
      plexMinimum: Math.max(0, Math.floor(finite(tier.plexMinimum, 0))),
      plexMaximum: Math.max(0, Math.floor(finite(tier.plexMaximum, 0))),
      plex: choosePlex(eventKey, tier),
      xp: Math.max(0, Math.floor(finite(tier.xp, 0))),
    };
    return {
      eventKey,
      killID: positive(killID, 0),
      characterID,
      tier: String(tier.id || "low"),
      tierLabel: String(tier.label || tier.id || "Low"),
      npcName: String(
        victimEntity && (
          victimEntity.name ||
          victimEntity.displayName ||
          victimEntity.itemName ||
          victimEntity.typeName
        ) ||
          `NPC ${positive(victimEntity && victimEntity.typeID, 0) || "Unknown"}`,
      ),
      npcTypeID: positive(victimEntity && victimEntity.typeID, 0),
      systemID,
      bountyISK,
      reward,
      killedAtMs: Math.max(0, Math.floor(finite(whenMs, Date.now()))),
      finalAttackerShipTypeID: positive(finalAttacker && finalAttacker.typeID, 0),
      iskPaid: reward.isk <= 0,
      plexPaid: reward.plex <= 0,
      skillPointsPaid: reward.skillPoints <= 0,
      progressionApplied: false,
      notificationSent: false,
      status: "pending",
    };
  }

  recordNpcKill({
    targetEntity = null,
    finalAttacker = null,
    characterID: creditedCharacterID = 0,
    nativeBountyEligible = false,
    killID = 0,
    eventKey = "",
    whenMs = Date.now(),
  } = {}) {
    if (
      !this._config.enabled ||
      !targetEntity ||
      (!isNativeNpc(targetEntity) && nativeBountyEligible !== true)
    ) {
      return Promise.resolve({success: true, skipped: true});
    }
    const characterID = positive(
      creditedCharacterID,
      characterIDFromAttacker(finalAttacker || {}),
    );
    if (!characterID) {
      return Promise.resolve({success: true, skipped: true, reason: "FINAL_ATTACKER_CHARACTER_REQUIRED"});
    }
    const normalizedKillID = positive(killID, 0);
    const normalizedEventKey = String(
      eventKey ||
        (normalizedKillID
          ? `killmail:${normalizedKillID}`
          : `destruction:${systemIDFromEntity(targetEntity)}:${positive(targetEntity.itemID, 0)}:${Math.floor(finite(whenMs, Date.now()))}:${characterID}`),
    );
    const character = ensureCharacter(this._state, characterID, this._config.recentKillLimit);
    if (!character.kills[normalizedEventKey]) {
      character.kills[normalizedEventKey] = this._buildKillRecord({
        eventKey: normalizedEventKey,
        killID: normalizedKillID,
        characterID,
        victimEntity: targetEntity,
        finalAttacker,
        whenMs,
      });
      this._saveState();
    }
    return this._queueForCharacter(characterID, () => this._settleKill(characterID, normalizedEventKey));
  }

  async _payISK(characterID, kill) {
    if (kill.iskPaid === true) {
      return true;
    }
    const amount = Math.round(finite(kill.reward && kill.reward.isk, 0) * 100) / 100;
    if (amount <= 0) {
      kill.iskPaid = true;
      this._saveState();
      return true;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${kill.eventKey}:isk`;
    const walletState = this._getDependencies().walletState;
    let result;
    try {
      result = await walletState.adjustCharacterBalanceAsync(
        characterID,
        amount,
        {
          idempotencyKey,
          description: `Bounty hunting reward: ${kill.npcName}`,
          entryTypeID: walletState.JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD,
          ownerID1: characterID,
          ownerID2: kill.systemID || characterID,
          referenceID: kill.npcTypeID || kill.systemID || characterID,
        },
        {commandID: idempotencyKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(`[${MOD_ID}] ISK reward failed character=${characterID} event=${kill.eventKey}`);
      return false;
    }
    kill.iskPaid = true;
    this._saveState();
    return true;
  }

  async _payPLEX(characterID, kill) {
    if (kill.plexPaid === true) {
      return true;
    }
    const amount = Math.max(0, Math.floor(finite(kill.reward && kill.reward.plex, 0)));
    if (amount <= 0) {
      kill.plexPaid = true;
      this._saveState();
      return true;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${kill.eventKey}:plex`;
    const walletState = this._getDependencies().walletState;
    let result;
    try {
      result = await walletState.adjustCharacterPlexBalanceAsync(
        characterID,
        amount,
        {
          idempotencyKey,
          categoryMessageID: PLEX_LOG_CATEGORY.REWARD,
          summaryMessageID: PLEX_LOG_CATEGORY.REWARD,
          summaryText: `Bounty hunting reward: ${kill.npcName}`,
          description: `Bounty hunting reward: ${kill.npcName}`,
          ownerID1: characterID,
          ownerID2: kill.systemID || characterID,
          referenceID: kill.npcTypeID || kill.systemID || characterID,
        },
        {commandID: idempotencyKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(`[${MOD_ID}] PLEX reward failed character=${characterID} event=${kill.eventKey}`);
      return false;
    }
    kill.plexPaid = true;
    this._saveState();
    return true;
  }

  async _paySkillPoints(characterID, kill) {
    if (kill.skillPointsPaid === true) {
      return true;
    }
    const amount = Math.max(0, Math.floor(finite(kill.reward && kill.reward.skillPoints, 0)));
    if (amount <= 0) {
      kill.skillPointsPaid = true;
      this._saveState();
      return true;
    }
    const dependencies = this._getDependencies();
    const characterState = dependencies.characterState;
    if (!characterState || typeof characterState.updateCharacterRecord !== "function") {
      return false;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${kill.eventKey}:skill-points`;
    let duplicate = false;
    let freeSkillPoints = 0;
    let result;
    try {
      result = characterState.updateCharacterRecord(characterID, (record) => {
        const receipts = record.bountyHuntingRewardReceipts &&
          typeof record.bountyHuntingRewardReceipts === "object"
          ? {...record.bountyHuntingRewardReceipts}
          : {};
        const existing = receipts[idempotencyKey];
        if (existing) {
          duplicate = true;
          freeSkillPoints = Math.max(0, Math.floor(finite(record.freeSkillPoints, 0)));
          return record;
        }
        freeSkillPoints = Math.max(0, Math.floor(finite(record.freeSkillPoints, 0))) + amount;
        receipts[idempotencyKey] = {amount, appliedAtMs: Date.now()};
        return {
          ...record,
          freeSkillPoints,
          bountyHuntingRewardReceipts: receipts,
        };
      });
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      return false;
    }
    const store = this._database || database;
    const flushResult = typeof store.flushTableSync === "function"
      ? store.flushTableSync(characterState.CHARACTERS_TABLE || "characters")
      : {success: false, errorMsg: "CHARACTER_FLUSH_UNAVAILABLE"};
    if (!flushResult || flushResult.success !== true) {
      return false;
    }
    if (!duplicate && dependencies.skillQueueNotifications &&
      typeof dependencies.skillQueueNotifications.notifyFreeSkillPointsChanged === "function") {
      try {
        dependencies.skillQueueNotifications.notifyFreeSkillPointsChanged(characterID, freeSkillPoints);
      } catch (error) {
        log.debug(`[${MOD_ID}] skill-point notification failed: ${error.message}`);
      }
    }
    kill.skillPointsPaid = true;
    this._saveState();
    return true;
  }

  _sessionForCharacter(characterID) {
    const registry = this._getDependencies().sessionRegistry;
    return registry && typeof registry.findSessionByCharacterID === "function"
      ? registry.findSessionByCharacterID(characterID)
      : null;
  }

  _sendSummary(characterID, result) {
    if (!this._config.notifications.enabled || !result || !result.kill) {
      return;
    }
    const session = this._sessionForCharacter(characterID);
    const kill = result.kill;
    if (!session || kill.notificationSent === true) {
      return;
    }
    try {
      this._getDependencies().chatHub.sendSystemMessage(
        session,
        `[Bounty Hunting] ${kill.npcName}: +${kill.reward.isk.toLocaleString("en-US")} ISK, ` +
          `+${kill.reward.skillPoints.toLocaleString("en-US")} SP, +${kill.reward.plex} PLEX, ` +
          `+${kill.reward.xp} XP. Bounty Hunter Level ${result.levelAfter}.`,
      );
      kill.notificationSent = true;
      this._saveState();
    } catch (error) {
      log.debug(`[${MOD_ID}] reward notification failed: ${error.message}`);
    }
  }

  async _settleKill(characterID, eventKey) {
    const character = ensureCharacter(this._state, characterID, this._config.recentKillLimit);
    const kill = character.kills[eventKey];
    if (!kill || kill.status === "claimed") {
      return {success: true, duplicate: true};
    }
    if (!await this._payISK(characterID, kill)) return {success: false, pending: true};
    if (!await this._payPLEX(characterID, kill)) return {success: false, pending: true};
    if (!await this._paySkillPoints(characterID, kill)) return {success: false, pending: true};
    const result = awardKill(
      character,
      kill,
      this._config.progression,
      Date.now(),
      this._config.recentKillLimit,
    );
    if (!result.success) {
      return result;
    }
    this._saveState();
    this._sendSummary(characterID, result);
    log.info(
      `[${MOD_ID}] NPC kill rewarded character=${characterID} event=${eventKey} ` +
        `tier=${kill.tier} isk=${kill.reward.isk} sp=${kill.reward.skillPoints} ` +
        `plex=${kill.reward.plex} xp=${kill.reward.xp}`,
    );
    return result;
  }

  async _retryPendingRewards() {
    if (!this._config.enabled) {
      return;
    }
    for (const [characterID, character] of Object.entries(this._state.characters || {})) {
      for (const eventKey of Object.keys(character && character.kills || {})) {
        const kill = character.kills[eventKey];
        if (kill && kill.status !== "claimed") {
          await this._queueForCharacter(Number(characterID), () => this._settleKill(Number(characterID), eventKey));
        }
      }
    }
  }
}

module.exports = BountyHuntingService;
module.exports._testing = {
  characterIDFromAttacker,
  extractKillID,
  isNativeNpc,
  tierForBounty,
};
