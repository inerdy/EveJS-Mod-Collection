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
  normalizeRewardBatch,
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

function pendingBatchCount(state) {
  let pending = 0;
  for (const character of Object.values(state.characters || {})) {
    for (const batch of Object.values(character && character.pendingRewardBatches || {})) {
      if (batch && batch.status !== "settled") {
        pending += 1;
      }
    }
  }
  return pending;
}

function payoutTimeForMs(value) {
  const numeric = Math.max(0, Math.floor(finite(value, 0)));
  return numeric > 0 ? String(numeric) : "";
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
    this._migratePendingBatches();

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
      diagnosticsEnabled: this._config.diagnostics.enabled,
      characterCount: Object.keys(this._state.characters || {}).length,
      pendingRewards: pendingBatchCount(this._state),
    };
  }

  recordHookDiagnostic({
    source = "unknown",
    eventKey = "",
    characterID = 0,
    targetEntity = null,
    nativeBountyEligible = false,
    outcome = "seen",
  } = {}) {
    if (!this._config.diagnostics.enabled) {
      return;
    }
    log.info(
      `[${MOD_ID}][debug] hook=${String(source)} outcome=${String(outcome)} ` +
        `event=${String(eventKey || "none")} character=${positive(characterID, 0)} ` +
        `target=${positive(targetEntity && targetEntity.itemID, 0)} ` +
        `kind=${String(targetEntity && targetEntity.kind || "unknown")} ` +
        `nativeEligible=${nativeBountyEligible === true}`,
    );
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

  _resolvePayoutSchedule({payoutAtMs = 0, payoutTime = "", whenMs = Date.now()} = {}) {
    const nowMs = Math.max(0, Math.floor(finite(whenMs, Date.now())));
    const nativePayoutAtMs = Math.max(0, Math.floor(finite(payoutAtMs, 0)));
    if (nativePayoutAtMs > 0) {
      return {
        payoutAtMs: nativePayoutAtMs,
        payoutTime: String(payoutTime || payoutTimeForMs(nativePayoutAtMs)),
      };
    }
    const delayMs = Math.max(1000, Math.floor(finite(this._config.payoutDelayMs, 20 * 60 * 1000)));
    const payoutAt = Math.ceil((nowMs + delayMs) / delayMs) * delayMs;
    return {
      payoutAtMs: payoutAt,
      payoutTime: payoutTimeForMs(payoutAt),
    };
  }

  _batchForCharacter(character, batchKey, schedule, createdAtMs) {
    if (!character.pendingRewardBatches || typeof character.pendingRewardBatches !== "object") {
      character.pendingRewardBatches = {};
    }
    if (!character.pendingRewardBatches[batchKey]) {
      character.pendingRewardBatches[batchKey] = normalizeRewardBatch({
        batchKey,
        payoutAtMs: schedule.payoutAtMs,
        payoutTime: schedule.payoutTime,
        createdAtMs,
      }, batchKey);
    }
    return character.pendingRewardBatches[batchKey];
  }

  _addKillToBatch(character, batch, kill) {
    if (batch.killKeys.includes(kill.eventKey)) {
      return false;
    }
    batch.killKeys.push(kill.eventKey);
    batch.killCount = batch.killKeys.length;
    batch.isk += Math.max(0, finite(kill.reward && kill.reward.isk, 0));
    batch.plex += Math.max(0, Math.floor(finite(kill.reward && kill.reward.plex, 0)));
    batch.skillPoints += Math.max(0, Math.floor(finite(kill.reward && kill.reward.skillPoints, 0)));
    return true;
  }

  _migratePendingBatches() {
    let changed = false;
    const delayMs = Math.max(1000, Math.floor(finite(this._config.payoutDelayMs, 20 * 60 * 1000)));
    for (const character of Object.values(this._state.characters || {})) {
      if (!character || !character.kills || !character.pendingRewardBatches) {
        continue;
      }
      for (const kill of Object.values(character.kills)) {
        if (!kill || !kill.eventKey || kill.status === "settled") {
          continue;
        }
        const fullyPaid = kill.iskPaid === true && kill.plexPaid === true && kill.skillPointsPaid === true;
        if (fullyPaid && kill.progressionApplied === true) {
          continue;
        }
        const baseTime = Math.max(0, Math.floor(finite(kill.killedAtMs, Date.now())));
        const payoutAtMs = Math.max(
          Date.now(),
          Math.ceil((baseTime + delayMs) / delayMs) * delayMs,
        );
        const batchKey = `legacy:${payoutAtMs}`;
        const batch = this._batchForCharacter(
          character,
          batchKey,
          {payoutAtMs, payoutTime: payoutTimeForMs(payoutAtMs)},
          baseTime,
        );
        if (!batch.killKeys.includes(kill.eventKey)) {
          batch.killKeys.push(kill.eventKey);
          batch.killCount = batch.killKeys.length;
          if (kill.iskPaid !== true) {
            batch.isk += Math.max(0, finite(kill.reward && kill.reward.isk, 0));
          }
          if (kill.plexPaid !== true) {
            batch.plex += Math.max(0, Math.floor(finite(kill.reward && kill.reward.plex, 0)));
          }
          if (kill.skillPointsPaid !== true) {
            batch.skillPoints += Math.max(0, Math.floor(finite(kill.reward && kill.reward.skillPoints, 0)));
          }
          changed = true;
        }
        batch.iskPaid = batch.isk <= 0;
        batch.plexPaid = batch.plex <= 0;
        batch.skillPointsPaid = batch.skillPoints <= 0;
      }
    }
    if (changed) {
      this._saveState();
    }
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
    payoutAtMs = 0,
    payoutTime = "",
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
    if (character.kills[normalizedEventKey]) {
      return Promise.resolve({success: true, duplicate: true, pendingPayout: true});
    }

    const kill = this._buildKillRecord({
      eventKey: normalizedEventKey,
      killID: normalizedKillID,
      characterID,
      victimEntity: targetEntity,
      finalAttacker,
      whenMs,
    });
    character.kills[normalizedEventKey] = kill;
    const progression = awardKill(
      character,
      kill,
      this._config.progression,
      Math.max(0, Math.floor(finite(whenMs, Date.now()))),
      this._config.recentKillLimit,
    );
    if (!progression.success) {
      return Promise.resolve(progression);
    }
    const schedule = this._resolvePayoutSchedule({payoutAtMs, payoutTime, whenMs});
    const batchKey = `payout:${schedule.payoutAtMs}`;
    const batch = this._batchForCharacter(
      character,
      batchKey,
      schedule,
      Math.max(0, Math.floor(finite(whenMs, Date.now()))),
    );
    this._addKillToBatch(character, batch, progression.kill);
    this._saveState();

    const nowMs = Date.now();
    if (batch.payoutAtMs > nowMs) {
      return Promise.resolve({
        success: true,
        recorded: true,
        pendingPayout: true,
        payoutAtMs: batch.payoutAtMs,
        kill: progression.kill,
      });
    }
    return this._queueForCharacter(characterID, () => this._settleBatch(characterID, batchKey));
  }

  async _payBatchISK(characterID, batch) {
    if (batch.iskPaid === true) {
      return true;
    }
    const amount = Math.round(finite(batch.isk, 0) * 100) / 100;
    if (amount <= 0) {
      batch.iskPaid = true;
      return true;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${batch.batchKey}:isk`;
    const walletState = this._getDependencies().walletState;
    let result;
    try {
      result = await walletState.adjustCharacterBalanceAsync(
        characterID,
        amount,
        {
          idempotencyKey,
          description: `Bounty hunting reward batch (${batch.killCount} NPC kills)`,
          entryTypeID: walletState.JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD,
          ownerID1: characterID,
          ownerID2: characterID,
          referenceID: characterID,
        },
        {commandID: idempotencyKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(`[${MOD_ID}] ISK reward batch failed character=${characterID} batch=${batch.batchKey}`);
      return false;
    }
    batch.iskPaid = true;
    return true;
  }

  async _payBatchPLEX(characterID, batch) {
    if (batch.plexPaid === true) {
      return true;
    }
    const amount = Math.max(0, Math.floor(finite(batch.plex, 0)));
    if (amount <= 0) {
      batch.plexPaid = true;
      return true;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${batch.batchKey}:plex`;
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
          summaryText: `Bounty hunting reward batch (${batch.killCount} NPC kills)`,
          description: `Bounty hunting reward batch (${batch.killCount} NPC kills)`,
          ownerID1: characterID,
          ownerID2: characterID,
          referenceID: characterID,
        },
        {commandID: idempotencyKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(`[${MOD_ID}] PLEX reward batch failed character=${characterID} batch=${batch.batchKey}`);
      return false;
    }
    batch.plexPaid = true;
    return true;
  }

  async _payBatchSkillPoints(characterID, batch) {
    if (batch.skillPointsPaid === true) {
      return true;
    }
    const amount = Math.max(0, Math.floor(finite(batch.skillPoints, 0)));
    if (amount <= 0) {
      batch.skillPointsPaid = true;
      return true;
    }
    const dependencies = this._getDependencies();
    const characterState = dependencies.characterState;
    if (!characterState || typeof characterState.updateCharacterRecord !== "function") {
      return false;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${batch.batchKey}:skill-points`;
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
    batch.skillPointsPaid = true;
    return true;
  }

  _sessionForCharacter(characterID) {
    const registry = this._getDependencies().sessionRegistry;
    return registry && typeof registry.findSessionByCharacterID === "function"
      ? registry.findSessionByCharacterID(characterID)
      : null;
  }

  _sendBatchSummary(characterID, character, batch) {
    if (!this._config.notifications.enabled || !batch || batch.notificationSent === true) {
      return;
    }
    const session = this._sessionForCharacter(characterID);
    if (!session) {
      return;
    }
    try {
      this._getDependencies().chatHub.sendSystemMessage(
        session,
        `[Bounty Hunting] ${batch.killCount} NPC kills: ` +
          `+${batch.isk.toLocaleString("en-US")} ISK, ` +
          `+${batch.skillPoints.toLocaleString("en-US")} SP, ` +
          `+${batch.plex} PLEX. Bounty Hunter Level ${character.level}.`,
      );
      batch.notificationSent = true;
      this._saveState();
    } catch (error) {
      log.debug(`[${MOD_ID}] reward notification failed: ${error.message}`);
    }
  }

  async _settleBatch(characterID, batchKey) {
    const character = ensureCharacter(this._state, characterID, this._config.recentKillLimit);
    const batch = character.pendingRewardBatches && character.pendingRewardBatches[batchKey];
    if (!batch || batch.status === "settled") {
      return {success: true, duplicate: true};
    }
    if (batch.payoutAtMs > Date.now()) {
      return {success: true, pending: true, payoutAtMs: batch.payoutAtMs};
    }
    if (!await this._payBatchISK(characterID, batch)) {
      this._saveState();
      return {success: false, pending: true};
    }
    if (!await this._payBatchPLEX(characterID, batch)) {
      this._saveState();
      return {success: false, pending: true};
    }
    if (!await this._payBatchSkillPoints(characterID, batch)) {
      this._saveState();
      return {success: false, pending: true};
    }

    for (const eventKey of batch.killKeys) {
      const kill = character.kills[eventKey];
      if (!kill) {
        continue;
      }
      kill.iskPaid = true;
      kill.plexPaid = true;
      kill.skillPointsPaid = true;
      if (kill.progressionApplied !== true) {
        awardKill(
          character,
          kill,
          this._config.progression,
          Date.now(),
          this._config.recentKillLimit,
        );
      }
      if (character.kills[eventKey]) {
        character.kills[eventKey].status = "settled";
      }
    }
    batch.status = "settled";
    batch.settledAtMs = Date.now();
    this._saveState();
    this._sendBatchSummary(characterID, character, batch);
    log.info(
      `[${MOD_ID}] NPC reward batch settled character=${characterID} batch=${batchKey} ` +
        `kills=${batch.killCount} isk=${batch.isk} sp=${batch.skillPoints} plex=${batch.plex}`,
    );
    return {success: true, settled: true, batch};
  }

  async _retryPendingRewards() {
    if (!this._config.enabled) {
      return;
    }
    for (const [characterID, character] of Object.entries(this._state.characters || {})) {
      for (const batchKey of Object.keys(character && character.pendingRewardBatches || {})) {
        const batch = character.pendingRewardBatches[batchKey];
        if (batch && batch.status !== "settled" && batch.payoutAtMs <= Date.now()) {
          await this._queueForCharacter(Number(characterID), () => (
            this._settleBatch(Number(characterID), batchKey)
          ));
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
