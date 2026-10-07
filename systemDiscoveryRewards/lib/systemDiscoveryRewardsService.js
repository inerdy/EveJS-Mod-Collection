"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const database = require(serverPath("gameStore"));
const log = require(serverPath("utils", "logger"));
const {
  buildDict,
  buildList,
} = require(serverPath("services", "_shared", "serviceHelpers"));
const {
  PLEX_LOG_CATEGORY,
} = require(serverPath("services", "account", "plexVaultLogState"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {
  createStateStore,
  normalizeCharacter,
} = require(path.join(__dirname, "state"));
const {
  awardDiscovery,
  buildSnapshot,
} = require(path.join(__dirname, "explorerProgression"));

const MOD_ID = "systemDiscoveryRewards";
const SERVICE_NAME = MOD_ID;
const TRAVEL_REASONS = new Set([
  "stargate-jump",
  "solar-jump",
  "clone-vat-jump",
]);

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
    session.characterID ||
    session.charID ||
    session.charid
  ), 0);
}

function targetSystemIDFromOptions(session, options = {}) {
  const descriptor = options.sceneDescriptor && typeof options.sceneDescriptor === "object"
    ? options.sceneDescriptor
    : {};
  return positive(
    options.systemID ||
    options.solarSystemID ||
    descriptor.locationID ||
    descriptor.systemID ||
    session && session._space && session._space.systemID,
    0,
  );
}

function systemName(system, systemID) {
  return String(
    system && (system.solarSystemName || system.itemName || system.name) ||
    `System ${systemID}`,
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

function ensureCharacter(state, characterID) {
  const key = String(characterID);
  if (!state.characters[key]) {
    state.characters[key] = normalizeCharacter({});
  }
  return state.characters[key];
}

function pendingKey(characterID, systemID) {
  return `${characterID}:${systemID}`;
}

class SystemDiscoveryRewardsService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._database = options.database || null;
    this._dataDir = options.dataDir || this._resolveDataDir();
    this._stateStore = options.stateStore || createStateStore(
      path.join(this._dataDir, "systemDiscoveryRewards", "state.json"),
    );
    this._state = this._stateStore.load();
    this._dependencies = options.dependencies || null;
    this._retryTimer = null;
    this._settling = new Set();

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
    let characters = 0;
    let pendingRewards = 0;
    for (const character of Object.values(this._state.characters || {})) {
      characters += 1;
      for (const discovery of Object.values(character.discoveries || {})) {
        if (discovery && discovery.status !== "claimed") {
          pendingRewards += 1;
        }
      }
    }
    return {
      enabled: this._config.enabled,
      characterCount: characters,
      pendingRewards,
    };
  }

  Handle_GetStatus() {
    return this.getStatus();
  }

  Handle_GetDiscoveryProgress(_args, session) {
    const characterID = characterIDFromSession(session);
    if (!characterID) {
      throw new Error("SYSTEM_DISCOVERY_CHARACTER_REQUIRED");
    }
    const character = ensureCharacter(this._state, characterID);
    return marshalValue(buildSnapshot(character, this._config.progression));
  }

  _getDependencies() {
    if (this._dependencies) {
      return this._dependencies;
    }
    this._dependencies = {
      mapTelemetry: require(serverPath("services", "map", "mapTelemetryState")),
      walletState: require(serverPath("services", "account", "walletState")),
      characterState: require(serverPath("services", "character", "characterState")),
      skillQueueNotifications: require(serverPath(
        "services",
        "skills",
        "training",
        "skillQueueNotifications",
      )),
      worldData: require(serverPath("space", "worldData")),
      chatHub: require(serverPath("services", "chat", "chatHub")),
      sessionRegistry: require(serverPath("services", "chat", "sessionRegistry")),
    };
    return this._dependencies;
  }

  _isKnownSpaceSystem(systemID) {
    const numericSystemID = positive(systemID, 0);
    if (!numericSystemID) {
      return false;
    }
    if (this._config.knownSpaceOnly && numericSystemID >= this._config.knownSpaceMaxSystemID) {
      return false;
    }
    return Boolean(this._getDependencies().worldData.getSolarSystemByID(numericSystemID));
  }

  _hasMapVisit(characterID, systemID) {
    const rows = this._getDependencies().mapTelemetry.listSolarSystemVisitRows(characterID);
    return rows.some((row) => positive(row && row[1], 0) === systemID);
  }

  /**
   * Called before the native attach path records its map visit. Returning a
   * candidate here lets the loader distinguish a genuinely new arrival from
   * login, docking, and reattachment activity.
   */
  prepareArrival(session, options = {}) {
    if (!this._config.enabled) {
      return null;
    }
    const characterID = characterIDFromSession(session);
    const reason = String(options.universeSiteReconcileReason || "");
    const systemID = targetSystemIDFromOptions(session, options);
    if (!characterID || !TRAVEL_REASONS.has(reason) || !this._isKnownSpaceSystem(systemID)) {
      return null;
    }
    try {
      if (this._hasMapVisit(characterID, systemID)) {
        return null;
      }
    } catch (error) {
      log.warn(
        `[${MOD_ID}] map telemetry lookup failed character=${characterID} ` +
        `system=${systemID}: ${error.message}`,
      );
      return null;
    }
    const system = this._getDependencies().worldData.getSolarSystemByID(systemID);
    return {
      characterID,
      systemID,
      systemName: systemName(system, systemID),
      security: Number.isFinite(Number(system && system.security))
        ? Number(system.security)
        : null,
    };
  }

  _createPendingDiscovery(candidate) {
    const range = this._config.reward.plexMaximum - this._config.reward.plexMinimum + 1;
    const plex = this._config.reward.plexMinimum + (
      range > 0
        ? hashString(`${candidate.characterID}:${candidate.systemID}:plex`) % range
        : 0
    );
    return {
      systemID: candidate.systemID,
      systemName: candidate.systemName,
      security: candidate.security,
      discoveredAtMs: Date.now(),
      reward: {
        isk: this._config.reward.isk,
        xp: this._config.reward.xp,
        skillPoints: this._config.reward.skillPoints,
        plex,
      },
      iskPaid: false,
      skillPointsPaid: false,
      plexPaid: false,
      progressionApplied: false,
      status: "pending",
    };
  }

  _saveState() {
    this._stateStore.save(this._state);
  }

  async _payISK(characterID, systemID, discovery) {
    if (discovery.iskPaid === true) {
      return true;
    }
    const amount = Math.round(finite(discovery.reward && discovery.reward.isk, 0) * 100) / 100;
    if (amount <= 0) {
      discovery.iskPaid = true;
      this._saveState();
      return true;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${systemID}:isk`;
    let result;
    try {
      result = await this._getDependencies().walletState.adjustCharacterBalanceAsync(
        characterID,
        amount,
        {
          idempotencyKey,
          description: `System discovery reward: ${discovery.systemName}`,
          entryTypeID: this._getDependencies().walletState.JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD,
          ownerID1: characterID,
          ownerID2: systemID,
          referenceID: systemID,
        },
        {commandID: idempotencyKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(
        `[${MOD_ID}] ISK reward failed character=${characterID} system=${systemID} ` +
        `error=${result && result.errorMsg || "unknown"}`,
      );
      return false;
    }
    discovery.iskPaid = true;
    this._saveState();
    return true;
  }

  async _payPLEX(characterID, systemID, discovery) {
    if (discovery.plexPaid === true) {
      return true;
    }
    const amount = Math.max(0, Math.floor(finite(discovery.reward && discovery.reward.plex, 0)));
    if (amount <= 0) {
      discovery.plexPaid = true;
      this._saveState();
      return true;
    }
    const idempotencyKey = `${MOD_ID}:${characterID}:${systemID}:plex`;
    let result;
    try {
      result = await this._getDependencies().walletState.adjustCharacterPlexBalanceAsync(
        characterID,
        amount,
        {
          idempotencyKey,
          categoryMessageID: PLEX_LOG_CATEGORY.REWARD,
          summaryMessageID: PLEX_LOG_CATEGORY.REWARD,
          summaryText: `System discovery reward: ${discovery.systemName}`,
          description: `System discovery reward: ${discovery.systemName}`,
          ownerID1: characterID,
          ownerID2: systemID,
          referenceID: systemID,
        },
        {commandID: idempotencyKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(
        `[${MOD_ID}] PLEX reward failed character=${characterID} system=${systemID} ` +
        `error=${result && result.errorMsg || "unknown"}`,
      );
      return false;
    }
    discovery.plexPaid = true;
    this._saveState();
    return true;
  }

  async _paySkillPoints(characterID, systemID, discovery) {
    if (discovery.skillPointsPaid === true) {
      return true;
    }
    const amount = Math.max(0, Math.floor(finite(
      discovery.reward && discovery.reward.skillPoints,
      0,
    )));
    if (amount <= 0) {
      discovery.skillPointsPaid = true;
      this._saveState();
      return true;
    }

    const idempotencyKey = `${MOD_ID}:${characterID}:${systemID}:skill-points`;
    const dependencies = this._getDependencies();
    const characterState = dependencies.characterState;
    if (!characterState || typeof characterState.updateCharacterRecord !== "function") {
      log.warn(
        `[${MOD_ID}] skill-point reward failed character=${characterID} system=${systemID} ` +
        "error=CHARACTER_STATE_UNAVAILABLE",
      );
      return false;
    }

    let duplicate = false;
    let keyConflict = false;
    let freeSkillPoints = 0;
    let result;
    try {
      result = characterState.updateCharacterRecord(characterID, (record) => {
        const receipts = record.systemDiscoveryRewardReceipts &&
          typeof record.systemDiscoveryRewardReceipts === "object"
          ? {...record.systemDiscoveryRewardReceipts}
          : {};
        const existing = receipts[idempotencyKey];
        if (existing) {
          duplicate = true;
          keyConflict = Math.floor(finite(existing.amount, 0)) !== amount;
          freeSkillPoints = Math.max(0, Math.floor(finite(record.freeSkillPoints, 0)));
          return record;
        }
        freeSkillPoints = Math.max(0, Math.floor(finite(record.freeSkillPoints, 0))) + amount;
        receipts[idempotencyKey] = {
          amount,
          appliedAtMs: Date.now(),
        };
        return {
          ...record,
          freeSkillPoints,
          systemDiscoveryRewardReceipts: receipts,
        };
      });
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    if (!result || result.success !== true) {
      log.warn(
        `[${MOD_ID}] skill-point reward failed character=${characterID} system=${systemID} ` +
        `error=${result && result.errorMsg || "unknown"}`,
      );
      return false;
    }
    if (keyConflict) {
      log.warn(
        `[${MOD_ID}] skill-point reward idempotency conflict character=${characterID} ` +
        `system=${systemID}`,
      );
      return false;
    }

    const store = this._database || database;
    const flushResult = typeof store.flushTableSync === "function"
      ? store.flushTableSync(characterState.CHARACTERS_TABLE || "characters")
      : {success: false, errorMsg: "DATABASE_FLUSH_UNAVAILABLE"};
    if (!flushResult || flushResult.success !== true) {
      log.warn(
        `[${MOD_ID}] skill-point reward flush failed character=${characterID} system=${systemID} ` +
        `error=${flushResult && flushResult.errorMsg || "unknown"}`,
      );
      return false;
    }
    if (!duplicate && dependencies.skillQueueNotifications &&
      typeof dependencies.skillQueueNotifications.notifyFreeSkillPointsChanged === "function") {
      try {
        dependencies.skillQueueNotifications.notifyFreeSkillPointsChanged(
          characterID,
          freeSkillPoints,
        );
      } catch (error) {
        log.debug(`[${MOD_ID}] skill-point notification failed: ${error.message}`);
      }
    }
    discovery.skillPointsPaid = true;
    this._saveState();
    return true;
  }

  _sendSummary(session, characterID, result) {
    if (!session || !result || !result.discovery) {
      return;
    }
    const reward = result.discovery.reward;
    const levelText = result.levelAfter >= this._config.progression.maxLevel
      ? `Explorer Level ${result.levelAfter} (MAX)`
      : `Explorer Level ${result.levelAfter}`;
    try {
      this._getDependencies().chatHub.sendSystemMessage(
        session,
        `[System Discovery] Discovered ${result.discovery.systemName}: ` +
        `+${reward.isk.toLocaleString("en-US")} ISK, ` +
        `+${reward.skillPoints.toLocaleString("en-US")} SP, +${reward.xp} XP, ` +
        `+${reward.plex} PLEX. ${levelText}.`,
      );
    } catch (error) {
      log.debug(`[${MOD_ID}] discovery notification failed: ${error.message}`);
    }
  }

  async _settleDiscovery(characterID, systemID, session = null) {
    const key = pendingKey(characterID, systemID);
    if (this._settling.has(key)) {
      return false;
    }
    this._settling.add(key);
    try {
      const character = ensureCharacter(this._state, characterID);
      const discoveries = character.discoveries || (character.discoveries = {});
      let discovery = discoveries[String(systemID)];
      if (!discovery) {
        const system = this._getDependencies().worldData.getSolarSystemByID(systemID);
        discovery = this._createPendingDiscovery({
          characterID,
          systemID,
          systemName: systemName(system, systemID),
          security: Number.isFinite(Number(system && system.security))
            ? Number(system.security)
            : null,
        });
        discoveries[String(systemID)] = discovery;
        this._saveState();
      }
      if (discovery.status === "claimed") {
        return false;
      }
      if (!await this._payISK(characterID, systemID, discovery)) {
        return false;
      }
      if (!await this._payPLEX(characterID, systemID, discovery)) {
        return false;
      }
      if (!await this._paySkillPoints(characterID, systemID, discovery)) {
        return false;
      }
      const result = awardDiscovery(
        character,
        discovery,
        this._config.progression,
        Date.now(),
        this._config.recentDiscoveryLimit,
      );
      if (!result.success) {
        log.warn(
          `[${MOD_ID}] Explorer XP award failed character=${characterID} system=${systemID}`,
        );
        return false;
      }
      this._saveState();
      this._sendSummary(session, characterID, result);
      log.info(
        `[${MOD_ID}] discovery claimed character=${characterID} system=${systemID} ` +
        `isk=${discovery.reward.isk} sp=${discovery.reward.skillPoints} ` +
        `plex=${discovery.reward.plex} xp=${discovery.reward.xp} ` +
        `level=${result.levelAfter}`,
      );
      return true;
    } catch (error) {
      log.warn(
        `[${MOD_ID}] discovery settlement failed character=${characterID} system=${systemID}: ${error.message}`,
      );
      return false;
    } finally {
      this._settling.delete(key);
    }
  }

  async handleArrival(candidate, session = null) {
    if (!candidate || !this._config.enabled) {
      return {success: false, skipped: true};
    }
    const success = await this._settleDiscovery(
      candidate.characterID,
      candidate.systemID,
      session,
    );
    return {success, characterID: candidate.characterID, systemID: candidate.systemID};
  }

  async _retryPendingRewards() {
    for (const [characterID, character] of Object.entries(this._state.characters || {})) {
      for (const [systemID, discovery] of Object.entries(character.discoveries || {})) {
        if (!discovery || discovery.status === "claimed") {
          continue;
        }
        const sessionRegistry = this._getDependencies().sessionRegistry;
        const session = sessionRegistry && typeof sessionRegistry.findSessionByCharacterID === "function"
          ? sessionRegistry.findSessionByCharacterID(Number(characterID))
          : null;
        await this._settleDiscovery(Number(characterID), Number(systemID), session);
      }
    }
  }
}

module.exports = SystemDiscoveryRewardsService;
module.exports._testing = {
  characterIDFromSession,
  targetSystemIDFromOptions,
  hashString,
};
