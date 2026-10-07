"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const log = require(serverPath("utils", "logger"));
const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require(serverPath("services", "_shared", "serviceHelpers"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {
  createStateStore,
  defaultState,
} = require(path.join(__dirname, "state"));
const {
  buildGraph,
  hashUnit,
  listEligibleStations,
  resolveHubStations,
  selectDestination,
  securityClass,
  shortestJumpDistance,
} = require(path.join(__dirname, "routePlanner"));
const {
  calculateCargoVolume,
  calculateCargoTotals,
  calculateCollateral,
  calculateDeliveryDays,
  calculateReferenceValue,
  calculateReward,
} = require(path.join(__dirname, "reward"));
const {
  awardCompletion,
  buildSnapshot,
} = require(path.join(__dirname, "haulerProgression"));

const MOD_ID = "npcCourierContracts";
const SERVICE_NAME = "npcCourierContracts";
const CORP_ROLE_CONTRACT_MANAGER = 72057594037927936n;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const CONTRACT_TYPE_COURIER = 3;
const STATUS_OUTSTANDING = 0;
const STATUS_IN_PROGRESS = 1;
const STATUS_FINISHED_CONTRACTOR = 3;
const STATUS_FINISHED = 4;
const STATUS_CANCELLED = 5;
const STATUS_REJECTED = 6;
const STATUS_FAILED = 7;
const STATUS_DELETED = 8;
const DEFAULT_CORPORATION_CONTRACT_HANGAR_FLAG = 115;
const CORPORATION_CONTRACT_HANGAR_FLAGS = new Set([115, 116, 117, 118, 119, 120, 121]);
const ACTIVE_STATUSES = new Set([STATUS_OUTSTANDING, STATUS_IN_PROGRESS]);
const COMPLETED_STATUSES = new Set([STATUS_FINISHED_CONTRACTOR, STATUS_FINISHED]);
const FAILED_STATUSES = new Set([STATUS_CANCELLED, STATUS_REJECTED, STATUS_FAILED]);
// Use a dedicated notification name. OnRemoteMessage is a native EVE user
// message event and causes the client to display "Message not found" for a
// mod-defined message source.
const AUTOMATION_EVENT_NAME = "OnNpcCourierContractsAutomation";

function positive(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function corporationContractHangarFlag(config) {
  const configured = Math.trunc(Number(
    config && config.issuer && config.issuer.contractHangarFlagID,
  ));
  return CORPORATION_CONTRACT_HANGAR_FLAGS.has(configured)
    ? configured
    : DEFAULT_CORPORATION_CONTRACT_HANGAR_FLAG;
}

function currentFileTimeMs() {
  return BigInt(Date.now()) * FILETIME_TICKS_PER_MS + FILETIME_UNIX_EPOCH;
}

function fileTimeToMs(value) {
  try {
    const ticks = BigInt(String(value || "0"));
    if (ticks <= FILETIME_UNIX_EPOCH) {
      return 0;
    }
    return Number((ticks - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS);
  } catch (_error) {
    return 0;
  }
}

function isExpired(record, nowMs = Date.now()) {
  const expiresAtMs = fileTimeToMs(record && record.dateExpired);
  return expiresAtMs > 0 && expiresAtMs < nowMs;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function marshalHaulerProgressValue(value) {
  if (Array.isArray(value)) {
    return buildList(value.map((entry) => marshalHaulerProgressValue(entry)));
  }
  if (value && typeof value === "object") {
    return buildDict(Object.entries(value).map(([key, entry]) => [
      key,
      marshalHaulerProgressValue(entry),
    ]));
  }
  return value;
}

function replaceTemplate(template, values) {
  return String(template || "").replace(/\{([A-Za-z0-9_]+)\}/gu, (_match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : ""
  ));
}

function stationLabel(station) {
  return String(station && (station.stationName || station.itemName) || `Station ${station && station.stationID}`);
}

function systemLabel(station) {
  return String(station && station.solarSystemName || `System ${station && station.solarSystemID}`);
}

function statusIsActive(record, nowMs) {
  return Boolean(
    record &&
    ACTIVE_STATUSES.has(Number(record.status)) &&
    !isExpired(record, nowMs),
  );
}

function getSessionStationID(session) {
  return positive(session && (
    session.stationID ||
    session.stationid ||
    session.stationid2 ||
    session.stationLocationID ||
    session.locationid
  ), 0);
}

function getContractItemRow(record) {
  const rows = Array.isArray(record && record.items) ? record.items : [];
  return rows.find((row) => row && row.inCrate !== false) || rows[0] || null;
}

function decodeArgs(args, kwargs) {
  const candidate = Array.isArray(args) ? args[0] : args;
  const value = unwrapMarshalValue(candidate || kwargs || {});
  return value && typeof value === "object" ? value : {};
}

function getSessionCharacterID(session) {
  return positive(session && (
    session.characterID ||
    session.charid ||
    session.charID
  ), 0);
}

function getSessionSolarSystemID(session) {
  return positive(
    session && session._space && session._space.systemID,
    positive(
      session && session.solarsystemid2,
      positive(session && session.solarsystemid, 0),
    ),
  );
}

function sendAutomationNotification(session, payload) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  try {
    session.sendNotification(AUTOMATION_EVENT_NAME, "clientID", [
      marshalHaulerProgressValue(payload),
    ]);
    return true;
  } catch (error) {
    log.warn(`[${MOD_ID}] automation notification failed: ${error.message}`);
    return false;
  }
}

function buildStateEntryFromRecord(record, prefix) {
  const item = getContractItemRow(record);
  return {
    jobKey: `${prefix}${positive(record && record.contractID, 0)}`,
    contractID: positive(record && record.contractID, 0),
    state: "active",
    lastStatus: Number.isFinite(Number(record && record.status)) ? Number(record.status) : null,
    lastEvent: "discovered",
    originStationID: positive(record && record.startStationID, 0),
    destinationStationID: positive(record && record.endStationID, 0),
    typeID: positive(item && (item.itemTypeID || item.typeID), 0),
    quantity: positive(item && item.quantity, 0),
    itemID: positive(item && (item.itemID || item.escrowItemID), 0),
    reward: Math.max(0, finite(record && record.reward, 0)),
    collateral: Math.max(0, finite(record && record.collateral, 0)),
    jumps: 0,
    createdAtMs: Math.max(0, finite(record && record.createdAtMs, Date.now())),
    updatedAtMs: Date.now(),
  };
}

function buildContractInfo({
  config,
  origin,
  destination,
  item,
  itemMetadata,
  quantity,
  jumps,
}) {
  const volumeM3 = calculateCargoVolume(quantity, itemMetadata);
  const referenceValueISK = calculateReferenceValue(quantity, item);
  const reward = calculateReward({
    jumps,
    volumeM3,
    security: Math.min(finite(origin.security, 0), finite(destination.security, 0)),
    config,
  });
  const collateral = calculateCollateral(referenceValueISK, config);
  const deliveryDays = calculateDeliveryDays(jumps, config);
  const values = {
    item: itemMetadata && itemMetadata.name || `Type ${item.typeID}`,
    quantity,
    originSystem: systemLabel(origin),
    destinationSystem: systemLabel(destination),
    originStation: stationLabel(origin),
    destinationStation: stationLabel(destination),
    jumps,
  };
  return {
    contractType: CONTRACT_TYPE_COURIER,
    isPrivate: false,
    assignedToID: 0,
    minutesExpire: config.courier.offerExpirationMinutes,
    numDays: deliveryDays,
    startStationID: origin.stationID,
    destinationID: destination.stationID,
    price: 0,
    reward,
    collateral,
    title: `${config.templates.titlePrefix} ${replaceTemplate(config.templates.title, values)}`.slice(0, 200),
    description: replaceTemplate(config.templates.description, values),
    itemList: [],
    startStationDivision: corporationContractHangarFlag(config),
    requestItemTypeList: [],
    forCorp: true,
    multiContract: false,
    volumeM3,
    referenceValueISK,
    deliveryDays,
  };
}

function buildMultiCargoContractInfo({config, origin, destination, cargoItems, jumps}) {
  const totals = calculateCargoTotals(cargoItems);
  const first = cargoItems[0];
  const itemNames = cargoItems.map((entry) => `${entry.quantity} ${entry.metadata.name || `Type ${entry.item.typeID}`}`);
  const info = buildContractInfo({
    config,
    origin,
    destination,
    item: first.item,
    itemMetadata: first.metadata,
    quantity: first.quantity,
    jumps,
  });
  info.volumeM3 = totals.volumeM3;
  info.referenceValueISK = totals.referenceValueISK;
  info.reward = calculateReward({
    jumps,
    volumeM3: totals.volumeM3,
    security: Math.min(finite(origin.security, 0), finite(destination.security, 0)),
    config,
  });
  info.collateral = calculateCollateral(totals.referenceValueISK, config);
  info.itemSummary = itemNames.join(", ");
  info.title = `${config.templates.titlePrefix} ${replaceTemplate(config.templates.title, {
    item: `${cargoItems.length} cargo stacks`,
    originSystem: systemLabel(origin),
    destinationSystem: systemLabel(destination),
    jumps,
  })}`.slice(0, 200);
    info.description = `Transport ${itemNames.join(", ")} from ${stationLabel(origin)} to ${stationLabel(destination)}. ` +
    `Route: ${jumps} stargate jumps. Total volume: ${Math.round(totals.volumeM3 * 100) / 100} m3.`;
  return info;
}

class NpcCourierContractsService extends BaseService {
  constructor(options = {}) {
    super(SERVICE_NAME);
    this._config = options.config || loadConfig();
    this._database = options.database || null;
    this._dataDir = options.dataDir || this._resolveDataDir();
    this._stateStore = options.stateStore || createStateStore(
      path.join(this._dataDir, "npcCourierContracts", "state.json"),
    );
    this._state = this._stateStore.load();
    this._dependencies = options.dependencies || null;
    this._graph = null;
    this._eligibleStations = [];
    this._stationsByID = new Map();
    this._hubs = [];
    this._issuer = null;
    this._routeCache = new Map();
    this._ticker = null;
    this._startupTimer = null;
    this._tickInProgress = false;
    this._ready = false;
    this._lastError = "";
    this._fundingWarningIssued = false;
    this._automationLanes = new Map();

    if (this._config.enabled && options.autoStart !== false) {
      this._start();
    }
  }

  _resolveDataDir() {
    const database = this._database || require(serverPath("gameStore"));
    return database._dataDir || path.join(REPO_ROOT, "_local");
  }

  _start() {
    if (this._ticker || this._startupTimer) {
      return;
    }
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      void this.tick();
    }, this._config.initialDelayMs);
    if (this._startupTimer && typeof this._startupTimer.unref === "function") {
      this._startupTimer.unref();
    }
    this._ticker = setInterval(() => {
      void this.tick();
    }, this._config.tickIntervalMs);
    if (this._ticker && typeof this._ticker.unref === "function") {
      this._ticker.unref();
    }
  }

  stop() {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
    return true;
  }

  getStatus() {
    const entries = Object.values(this._state.contracts || {});
    const activeCount = entries.filter((entry) => entry.state === "active").length;
    return {
      enabled: this._config.enabled,
      ready: this._ready,
      issuerCorporationID: this._config.issuer.corporationID,
      issuerCharacterID: this._config.issuer.characterID,
      issuerValid: Boolean(this._issuer),
      eligibleStationCount: this._eligibleStations.length,
      hubCount: this._hubs.length,
      promotedOriginCount: this._state.promotedStationIDs.length,
      activeContractCount: activeCount,
      trackedContractCount: entries.length,
      lastTickAtMs: this._state.lastTickAtMs,
      lastError: this._lastError,
      treasuryTargetBalanceISK: this._config.treasury.targetBalanceISK,
      treasuryReplenishThresholdISK: this._config.treasury.targetBalanceISK *
        this._config.treasury.replenishThresholdRatio,
      treasuryLastFundingAtMs: this._state.treasury.lastFundingAtMs,
      treasuryReplenishmentCount: this._state.treasury.replenishmentCount,
    };
  }

  Handle_GetStatus() {
    return this.getStatus();
  }

  Handle_GetHaulerProgress(_args, session) {
    const characterID = getSessionCharacterID(session);
    return marshalHaulerProgressValue(buildSnapshot(
      this._state.haulerProgression,
      characterID,
      this._config.haulerProgression,
    ));
  }

  _getAutomationSettings(characterID) {
    const players = this._state.automation && this._state.automation.players;
    const configured = players && players[String(characterID)];
    return {
      autoRoute: Boolean(configured && configured.autoRoute === true),
      autoComplete: Boolean(configured && configured.autoComplete === true),
    };
  }

  _saveAutomationSettings(characterID, updates = {}) {
    const numericCharacterID = positive(characterID, 0);
    if (!numericCharacterID) {
      return {autoRoute: false, autoComplete: false};
    }
    if (!this._state.automation || typeof this._state.automation !== "object") {
      this._state.automation = {players: {}};
    }
    if (!this._state.automation.players || typeof this._state.automation.players !== "object") {
      this._state.automation.players = {};
    }
    const current = this._getAutomationSettings(numericCharacterID);
    const next = {
      autoRoute: Object.prototype.hasOwnProperty.call(updates, "autoRoute")
        ? updates.autoRoute === true
        : current.autoRoute,
      autoComplete: Object.prototype.hasOwnProperty.call(updates, "autoComplete")
        ? updates.autoComplete === true
        : current.autoComplete,
    };
    this._state.automation.players[String(numericCharacterID)] = next;
    this._stateStore.save(this._state);
    return next;
  }

  _ensureWorldNetwork(dependencies) {
    const world = dependencies.worldData.ensureLoaded();
    if (!this._graph) {
      this._graph = buildGraph(world.stargates || []);
    }
    if (this._eligibleStations.length === 0) {
      this._eligibleStations = listEligibleStations(
        world.stations || [],
        this._config.allowedSecurityClasses,
      );
      this._stationsByID = new Map(this._eligibleStations.map((station) => [station.stationID, station]));
    }
    return world;
  }

  _buildAutomationTarget(record, distance, dependencies) {
    const destinationStationID = positive(record && record.endStationID, 0);
    const station = this._stationsByID.get(destinationStationID) ||
      (typeof dependencies.worldData.getStationByID === "function"
        ? dependencies.worldData.getStationByID(destinationStationID)
        : null);
    if (!station) {
      return null;
    }
    return {
      contractID: positive(record && record.contractID, 0),
      destinationStationID,
      destinationStationName: String(station.stationName || station.itemName || `Station ${destinationStationID}`),
      destinationSolarSystemID: positive(
        record && record.endSolarSystemID,
        positive(station.solarSystemID, 0),
      ),
      destinationSolarSystemName: String(station.solarSystemName || `System ${station.solarSystemID}`),
      jumps: Math.max(0, Math.trunc(Number(distance) || 0)),
      acceptedAtMs: fileTimeToMs(record && record.dateAccepted) ||
        Math.max(0, finite(record && record.acceptedAtMs, 0)),
    };
  }

  _getNearestAcceptedContract(session, dependencies) {
    const characterID = getSessionCharacterID(session);
    if (!characterID || !dependencies || !dependencies.contractRuntime) {
      return null;
    }
    let world;
    try {
      world = this._ensureWorldNetwork(dependencies);
    } catch (error) {
      log.warn(`[${MOD_ID}] automation network unavailable: ${error.message}`);
      return null;
    }
    const currentSystemID = getSessionSolarSystemID(session) ||
      positive(
        typeof dependencies.worldData.getStationByID === "function"
          ? (dependencies.worldData.getStationByID(session && (
            session.stationID ||
            session.stationid ||
            session.stationid2 ||
            session.stationLocationID ||
            session.locationid
          )) || {}).solarSystemID
          : 0,
        0,
      );
    if (!currentSystemID || !world) {
      return null;
    }
    const candidates = dependencies.contractRuntime.listContractRecords()
      .filter((record) => (
        this._isGeneratedRecord(record) &&
        Number(record.status) === STATUS_IN_PROGRESS &&
        positive(record.acceptorID, 0) === characterID &&
        !isExpired(record)
      ))
      .map((record) => {
        const destinationStationID = positive(record.endStationID, 0);
        const station = this._stationsByID.get(destinationStationID) ||
          (typeof dependencies.worldData.getStationByID === "function"
            ? dependencies.worldData.getStationByID(destinationStationID)
            : null);
        const destinationSystemID = positive(
          record.endSolarSystemID,
          positive(station && station.solarSystemID, 0),
        );
        const distance = destinationSystemID
          ? shortestJumpDistance(this._graph, currentSystemID, destinationSystemID)
          : null;
        return {
          record,
          distance,
          target: distance === null ? null : this._buildAutomationTarget(record, distance, dependencies),
        };
      })
      .filter((entry) => entry.target && entry.distance !== null)
      .sort((left, right) => (
        left.distance - right.distance ||
        (left.target.acceptedAtMs || Number.MAX_SAFE_INTEGER) -
          (right.target.acceptedAtMs || Number.MAX_SAFE_INTEGER) ||
        left.target.contractID - right.target.contractID
      ));
    return candidates.length > 0 ? candidates[0].target : null;
  }

  _buildAutomationState(session) {
    const characterID = getSessionCharacterID(session);
    const settings = this._getAutomationSettings(characterID);
    let target = null;
    if (characterID) {
      try {
        target = this._getNearestAcceptedContract(session, this._getDependencies());
      } catch (error) {
        log.warn(`[${MOD_ID}] automation state lookup failed: ${error.message}`);
      }
    }
    return {
      autoRoute: settings.autoRoute,
      autoComplete: settings.autoComplete,
      routeTarget: target,
    };
  }

  Handle_GetAutomationState(_args, session) {
    const state = this._buildAutomationState(session);
    // The native acceptance/docking hooks are best-effort because Launcher
    // activation can occur after EveJS has cached those modules. The client
    // already polls this state while logged in, so use a docked-session poll
    // as a safe fallback for automatic completion.
    if (state.autoComplete) {
      const stationID = getSessionStationID(session);
      if (stationID) {
        void this.onDocked(session, 0, stationID);
      }
    }
    return marshalHaulerProgressValue(state);
  }

  Handle_SetAutomationSettings(args, session, kwargs) {
    const characterID = getSessionCharacterID(session);
    const payload = decodeArgs(args, kwargs);
    const settings = this._saveAutomationSettings(characterID, payload);
    const state = this._buildAutomationState(session);
    if (settings.autoRoute && state.routeTarget) {
      sendAutomationNotification(session, {
        action: "route",
        autoRoute: state.autoRoute,
        autoComplete: state.autoComplete,
        routeTarget: state.routeTarget,
      });
    }
    if (settings.autoComplete && getSessionStationID(session)) {
      void this.onDocked(session, 0, getSessionStationID(session));
    }
    return marshalHaulerProgressValue(state);
  }

  _notifyAutomationState(session, action, extra = {}) {
    const state = this._buildAutomationState(session);
    sendAutomationNotification(session, {
      action,
      ...extra,
      routeTarget: state.routeTarget,
      autoRoute: state.autoRoute,
      autoComplete: state.autoComplete,
    });
    return state;
  }

  async onContractAccepted(session, contractID) {
    const numericContractID = positive(contractID, 0);
    const state = this._buildAutomationState(session);
    if (state.autoRoute && state.routeTarget) {
      sendAutomationNotification(session, {
        action: "route",
        contractID: numericContractID,
        autoRoute: state.autoRoute,
        autoComplete: state.autoComplete,
        routeTarget: state.routeTarget,
      });
    }
    return state;
  }

  async onContractCompleted(session, contractID) {
    const dependencies = this._getDependencies();
    try {
      await this._reconcileContracts(dependencies, Date.now());
      this._stateStore.save(this._state);
    } catch (error) {
      log.warn(`[${MOD_ID}] completion reconciliation failed contract=${positive(contractID, 0)}: ${error.message}`);
    }
    return this._notifyAutomationState(session, "completion");
  }

  onDocked(session, _shipID, stationID) {
    const characterID = getSessionCharacterID(session);
    const normalizedStationID = positive(stationID, 0);
    if (!characterID || !normalizedStationID) {
      return Promise.resolve({success: false, skipped: true});
    }
    const previous = this._automationLanes.get(characterID) || Promise.resolve();
    const current = previous.then(() => this._completeContractsAtStation(
      session,
      characterID,
      normalizedStationID,
    ));
    this._automationLanes.set(characterID, current.catch(() => undefined));
    return current;
  }

  async _completeContractsAtStation(session, characterID, stationID) {
    const settings = this._getAutomationSettings(characterID);
    if (!settings.autoComplete) {
      return {success: false, skipped: true};
    }
    const dependencies = this._getDependencies();
    const records = dependencies.contractRuntime.listContractRecords()
      .filter((record) => (
        this._isGeneratedRecord(record) &&
        Number(record.status) === STATUS_IN_PROGRESS &&
        positive(record.acceptorID, 0) === characterID &&
        positive(record.endStationID, 0) === stationID &&
        !isExpired(record)
      ));
    const completed = [];
    const failed = [];
    for (const record of records) {
      const contractID = positive(record.contractID, 0);
      try {
        const result = await dependencies.contractRuntime.completeContract(
          contractID,
          STATUS_FINISHED,
          session,
        );
        if (result === true) {
          completed.push(contractID);
        } else {
          failed.push(contractID);
        }
      } catch (error) {
        failed.push(contractID);
        log.info(
          `[${MOD_ID}] automatic completion deferred contract=${contractID} ` +
          `station=${stationID} reason=${error.message}`,
        );
      }
    }
    if (completed.length > 0) {
      try {
        await this._reconcileContracts(dependencies, Date.now());
        this._stateStore.save(this._state);
      } catch (error) {
        log.warn(`[${MOD_ID}] dock completion reconciliation failed: ${error.message}`);
      }
    }
    this._notifyAutomationState(session, "docked", {
      completedContractIDs: completed,
      failedContractIDs: failed,
    });
    return {
      success: failed.length === 0,
      completedContractIDs: completed,
      failedContractIDs: failed,
    };
  }

  _getDependencies() {
    if (this._dependencies) {
      return this._dependencies;
    }
    this._dependencies = {
      worldData: require(serverPath("space", "worldData")),
      contractRuntime: require(serverPath("services", "contracts", "contractRuntimeState")),
      itemStore: require(serverPath("services", "inventory", "itemStore")),
      walletState: require(serverPath("services", "account", "walletState")),
      corpWalletState: require(serverPath("services", "corporation", "corpWalletState")),
      corporationState: require(serverPath("services", "corporation", "corporationState")),
      agentAuthority: require(serverPath("services", "agent", "agentAuthority")),
      sessionRegistry: require(serverPath("services", "chat", "sessionRegistry")),
    };
    return this._dependencies;
  }

  _resolveIssuer(dependencies) {
    const corporationID = this._config.issuer.corporationID;
    const characterID = this._config.issuer.characterID;
    const corporation = dependencies.corporationState.getCorporationRecord(corporationID);
    const character = dependencies.corporationState.getNpcCharacterOwnerRecord(characterID);
    const agent = dependencies.agentAuthority.getAgentByID(characterID);
    if (!corporation || corporation.isNPC !== true) {
      log.warn(`[${MOD_ID}] issuer corporation=${corporationID} is not a known NPC corporation`);
      return null;
    }
    if (
      !character ||
      !agent ||
      positive(agent.corporationID, 0) !== corporationID
    ) {
      log.warn(`[${MOD_ID}] issuer character=${characterID} is not a valid NPC representative for corporation=${corporationID}`);
      return null;
    }
    return {
      corporationID,
      characterID,
      corporation,
      character,
      session: {
        characterID,
        charid: characterID,
        corporationID,
        corpid: corporationID,
        allianceID: 0,
        corpAccountKey: this._config.issuer.walletAccountKey,
        corprole: CORP_ROLE_CONTRACT_MANAGER.toString(),
        rolesAtAll: CORP_ROLE_CONTRACT_MANAGER.toString(),
        characterName: character.ownerName,
        systemContractCleanup: true,
      },
    };
  }

  _resolveNetwork(dependencies) {
    const world = dependencies.worldData.ensureLoaded();
    if (!this._graph) {
      this._graph = buildGraph(world.stargates || []);
    }

    if (this._eligibleStations.length === 0) {
      this._eligibleStations = listEligibleStations(
        world.stations || [],
        this._config.allowedSecurityClasses,
      );
      this._stationsByID = new Map(this._eligibleStations.map((station) => [station.stationID, station]));
    }

    if (this._hubs.length === 0) {
      this._hubs = resolveHubStations(this._stationsByID, this._config.hubStationIDs);
      if (this._hubs.length === 0) {
        log.warn(`[${MOD_ID}] no configured origin hubs are valid for the current security filter`);
      }
    }

    if (!this._issuer) {
      this._issuer = this._resolveIssuer(dependencies);
    }
    this._ready = this._hubs.length > 0 && Boolean(this._issuer) && this._eligibleStations.length > 0;
    return this._ready;
  }

  async _ensureTreasury(dependencies, nowMs) {
    const treasuryConfig = this._config.treasury;
    if (!treasuryConfig || treasuryConfig.enabled === false || !this._issuer) {
      return true;
    }

    const corporationID = this._issuer.corporationID;
    const accountKey = this._config.issuer.walletAccountKey;
    const targetBalance = Math.max(0, finite(treasuryConfig.targetBalanceISK, 0));
    const threshold = targetBalance * Math.max(
      0,
      Math.min(1, finite(treasuryConfig.replenishThresholdRatio, 0)),
    );
    const currentBalance = finite(
      dependencies.corpWalletState.getCorporationWalletBalance(corporationID, accountKey),
      0,
    );
    const treasuryState = this._state.treasury || {
      fundingSequence: 0,
      initialSeedComplete: false,
      pendingFundingKey: "",
      pendingFundingAmountISK: 0,
      lastFundingAtMs: 0,
      lastFundingAmountISK: 0,
      totalFundedISK: 0,
      replenishmentCount: 0,
    };
    this._state.treasury = treasuryState;
    let fundingKey = String(treasuryState.pendingFundingKey || "");
    let fundingAmount = Math.max(0, finite(treasuryState.pendingFundingAmountISK, 0));
    const initialSeedRequired = treasuryState.initialSeedComplete !== true;
    if (targetBalance <= 0 || (
      currentBalance >= targetBalance &&
      !fundingKey
    )) {
      if (initialSeedRequired) {
        treasuryState.initialSeedComplete = true;
        this._stateStore.save(this._state);
      }
      return true;
    }
    if (currentBalance >= threshold && !initialSeedRequired && !fundingKey) {
      return true;
    }
    if (typeof dependencies.corpWalletState.adjustCorporationWalletDivisionBalanceAsync !== "function") {
      log.warn(`[${MOD_ID}] treasury cannot replenish: corporation wallet adjustment API is unavailable`);
      return false;
    }
    if (!fundingKey || fundingAmount <= 0) {
      treasuryState.fundingSequence = Math.max(
        0,
        Math.trunc(Number(treasuryState.fundingSequence) || 0),
      ) + 1;
      fundingKey = `${MOD_ID}:treasury:${corporationID}:${accountKey}:${treasuryState.fundingSequence}`;
      fundingAmount = Math.max(0, targetBalance - currentBalance);
      treasuryState.pendingFundingKey = fundingKey;
      treasuryState.pendingFundingAmountISK = fundingAmount;
      this._stateStore.save(this._state);
    }

    let result;
    try {
      result = await dependencies.corpWalletState.adjustCorporationWalletDivisionBalanceAsync(
        corporationID,
        accountKey,
        fundingAmount,
        {
          idempotencyKey: fundingKey,
          description: "NPC Courier Contracts treasury replenishment",
          entryTypeID: 10,
          ownerID1: corporationID,
          ownerID2: this._issuer.characterID,
          referenceID: treasuryState.fundingSequence,
        },
        {commandID: fundingKey, source: MOD_ID},
      );
    } catch (error) {
      result = {success: false, errorMsg: error && error.message || "unknown"};
    }

    if (!result || result.success !== true) {
      log.warn(
        `[${MOD_ID}] treasury replenishment failed corporation=${corporationID} ` +
        `amount=${fundingAmount.toFixed(2)} error=${result && result.errorMsg || "unknown"}`,
      );
      return false;
    }

    const duplicate = result.duplicate === true;
    treasuryState.pendingFundingKey = "";
    treasuryState.pendingFundingAmountISK = 0;
    treasuryState.initialSeedComplete = true;
    if (!duplicate) {
      treasuryState.lastFundingAtMs = nowMs;
      treasuryState.lastFundingAmountISK = fundingAmount;
      treasuryState.totalFundedISK = Math.max(0, finite(treasuryState.totalFundedISK, 0)) + fundingAmount;
      treasuryState.replenishmentCount = Math.max(
        0,
        Math.trunc(Number(treasuryState.replenishmentCount) || 0),
      ) + 1;
    }
    this._stateStore.save(this._state);
    const resultingBalance = result.data && result.data.balance;
    log.info(
      `[${MOD_ID}] treasury ${duplicate ? "replenishment replayed" : "replenished"} corporation=${corporationID} ` +
      `amount=${fundingAmount.toFixed(2)} balance=${finite(resultingBalance, currentBalance + fundingAmount).toFixed(2)}`,
    );
    return true;
  }

  _routeDistance(origin, destination) {
    const key = `${origin.solarSystemID}:${destination.solarSystemID}`;
    if (this._routeCache.has(key)) {
      return this._routeCache.get(key);
    }
    const distance = require(path.join(__dirname, "routePlanner"))
      .shortestJumpDistance(this._graph, origin.solarSystemID, destination.solarSystemID);
    this._routeCache.set(key, distance);
    return distance;
  }

  _isGeneratedRecord(record) {
    return Boolean(
      record &&
      Number(record.type) === CONTRACT_TYPE_COURIER &&
      positive(record.issuerCorpID, 0) === this._config.issuer.corporationID &&
      Number(record.status) !== STATUS_DELETED &&
      String(record.title || "").startsWith(this._config.templates.titlePrefix),
    );
  }

  _listGeneratedRecords(dependencies) {
    return dependencies.contractRuntime.listContractRecords()
      .filter((record) => this._isGeneratedRecord(record));
  }

  _addStationScore(stationID, amount) {
    const numericStationID = positive(stationID, 0);
    const numericAmount = finite(amount, 0);
    if (!numericStationID || numericAmount === 0) {
      return;
    }
    const key = String(numericStationID);
    this._state.stationScores[key] = Math.max(
      0,
      finite(this._state.stationScores[key], 0) + numericAmount,
    );
  }

  _decayActivity(nowMs) {
    const previousTick = finite(this._state.lastTickAtMs, 0);
    if (previousTick <= 0 || nowMs <= previousTick) {
      return;
    }
    const halfLife = Math.max(60000, this._config.activityHalfLifeMs);
    const factor = Math.pow(0.5, (nowMs - previousTick) / halfLife);
    for (const [stationID, score] of Object.entries(this._state.stationScores)) {
      const nextScore = finite(score, 0) * factor;
      if (nextScore < 0.01) {
        delete this._state.stationScores[stationID];
      } else {
        this._state.stationScores[stationID] = nextScore;
      }
    }
  }

  _updatePresenceActivity(dependencies) {
    const counts = new Map();
    const sessions = typeof dependencies.sessionRegistry.getSessions === "function"
      ? dependencies.sessionRegistry.getSessions()
      : [];
    for (const session of Array.isArray(sessions) ? sessions : []) {
      const stationID = getSessionStationID(session);
      if (!this._stationsByID.has(stationID)) {
        continue;
      }
      counts.set(stationID, (counts.get(stationID) || 0) + 1);
    }
    for (const [stationID, count] of counts.entries()) {
      this._addStationScore(
        stationID,
        Math.min(count, this._config.maxPresenceScorePerTick) * this._config.presenceWeightPerPlayer,
      );
    }
  }

  _updateMarketActivity() {
    const relativePath = String(this._config.marketStateRelativePath || "").trim();
    if (!relativePath || this._hubs.length === 0) {
      return;
    }
    const marketPath = path.join(this._dataDir, relativePath);
    try {
      const marketState = JSON.parse(fs.readFileSync(marketPath, "utf8"));
      const tickID = Math.max(0, Math.trunc(Number(marketState && marketState.tickID) || 0));
      if (tickID <= this._state.lastMarketTickID) {
        return;
      }
      for (const hub of this._hubs) {
        this._addStationScore(hub.stationID, this._config.marketActivityScore);
      }
      this._state.lastMarketTickID = tickID;
    } catch (_error) {
      // The market mod is optional. Missing or malformed state must not stop
      // courier generation.
    }
  }

  _promoteStations() {
    const hubIDs = new Set(this._hubs.map((station) => station.stationID));
    const promoted = new Set((this._state.promotedStationIDs || [])
      .map((stationID) => positive(stationID, 0))
      .filter((stationID) => this._stationsByID.has(stationID) && !hubIDs.has(stationID)));
    const candidates = this._eligibleStations
      .filter((station) => !hubIDs.has(station.stationID) && !promoted.has(station.stationID))
      .sort((left, right) => (
        finite(this._state.stationScores[String(right.stationID)], 0) -
        finite(this._state.stationScores[String(left.stationID)], 0) ||
        left.stationID - right.stationID
      ));
    for (const station of candidates) {
      if (promoted.size >= this._config.maxPromotedOrigins) {
        break;
      }
      const score = finite(this._state.stationScores[String(station.stationID)], 0);
      if (score < this._config.promotionThreshold) {
        break;
      }
      promoted.add(station.stationID);
      log.info(`[${MOD_ID}] promoted origin station=${station.stationID} name=${station.stationName} score=${score.toFixed(2)}`);
    }
    this._state.promotedStationIDs = [...promoted].sort((left, right) => left - right);
  }

  _originStations() {
    const byID = new Map(this._hubs.map((station) => [station.stationID, station]));
    for (const stationID of this._state.promotedStationIDs || []) {
      const station = this._stationsByID.get(positive(stationID, 0));
      if (station) {
        byID.set(station.stationID, station);
      }
    }
    return [...byID.values()].sort((left, right) => left.stationID - right.stationID);
  }

  async _payHaulerBonus(characterID, record, bonusISK, dependencies) {
    const bonus = Math.round((Number(bonusISK) || 0) * 100) / 100;
    if (bonus <= 0) {
      return true;
    }
    if (
      !dependencies.walletState ||
      typeof dependencies.walletState.adjustCharacterBalanceAsync !== "function" ||
      !dependencies.corpWalletState ||
      typeof dependencies.corpWalletState.adjustCorporationWalletDivisionBalanceAsync !== "function"
    ) {
      log.warn(`[${MOD_ID}] Hauler bonus payment APIs are unavailable contract=${record.contractID}`);
      return false;
    }
    const contractID = positive(record.contractID, 0);
    const corporationID = positive(record.issuerCorpID, this._config.issuer.corporationID);
    const accountKey = positive(
      record.issuerWallet && record.issuerWallet.accountKey,
      this._config.issuer.walletAccountKey,
    );
    const debitKey = `${MOD_ID}:hauler-bonus:${contractID}:debit`;
    let debit;
    try {
      debit = await dependencies.corpWalletState.adjustCorporationWalletDivisionBalanceAsync(
        corporationID,
        accountKey,
        -bonus,
        {
          idempotencyKey: debitKey,
          description: `Hauler level bonus for NPC courier ${contractID}`,
          entryTypeID: 93,
          ownerID1: corporationID,
          ownerID2: characterID,
          referenceID: contractID,
        },
        {commandID: debitKey, source: MOD_ID},
      );
    } catch (error) {
      debit = {success: false, errorMsg: error && error.message || "unknown"};
    }
    if (!debit || debit.success !== true) {
      log.warn(
        `[${MOD_ID}] Hauler bonus debit failed contract=${contractID} ` +
        `amount=${bonus.toFixed(2)} error=${debit && debit.errorMsg || "unknown"}`,
      );
      return false;
    }

    const creditKey = `${MOD_ID}:hauler-bonus:${contractID}:credit`;
    let credit;
    try {
      credit = await dependencies.walletState.adjustCharacterBalanceAsync(
        characterID,
        bonus,
        {
          idempotencyKey: creditKey,
          description: `Hauler level bonus for NPC courier ${contractID}`,
          entryTypeID: 33,
          ownerID1: characterID,
          ownerID2: corporationID,
          referenceID: contractID,
        },
        {commandID: creditKey, source: MOD_ID},
      );
    } catch (error) {
      credit = {success: false, errorMsg: error && error.message || "unknown"};
    }
    if (!credit || credit.success !== true) {
      log.warn(
        `[${MOD_ID}] Hauler bonus credit failed contract=${contractID} ` +
        `amount=${bonus.toFixed(2)} error=${credit && credit.errorMsg || "unknown"}`,
      );
      return false;
    }
    return true;
  }

  _hasHaulerAward(record) {
    const characterID = positive(
      record && record.packageOwnerID,
      positive(record && record.acceptorID, 0),
    );
    const contractID = positive(record && record.contractID, 0);
    if (!characterID || !contractID) {
      return false;
    }
    const player = this._state.haulerProgression &&
      this._state.haulerProgression.players &&
      this._state.haulerProgression.players[String(characterID)];
    return Boolean(
      player &&
      player.awardedContracts &&
      player.awardedContracts[String(contractID)],
    );
  }

  async _awardHaulerCompletion(record, entry, dependencies, nowMs) {
    const characterID = positive(
      record.packageOwnerID,
      positive(record.acceptorID, 0),
    );
    if (!characterID) {
      log.warn(`[${MOD_ID}] completed courier has no hauler character contract=${record.contractID}`);
      return true;
    }
    const nextProgression = JSON.parse(JSON.stringify(this._state.haulerProgression || {players: {}}));
    const awardResult = awardCompletion(
      nextProgression,
      characterID,
      {
        ...record,
        jumps: positive(entry.jumps, 0),
      },
      this._config.haulerProgression,
      this._config.reward.maximumISK,
      nowMs,
    );
    if (!awardResult.success) {
      log.warn(
        `[${MOD_ID}] Hauler XP award failed contract=${record.contractID} ` +
        `error=${awardResult.errorMsg || "unknown"}`,
      );
      return false;
    }
    if (awardResult.duplicate) {
      return true;
    }
    if (!await this._payHaulerBonus(
      characterID,
      record,
      awardResult.award.bonusISK,
      dependencies,
    )) {
      return false;
    }
    this._state.haulerProgression = nextProgression;
    this._stateStore.save(this._state);
    log.info(
      `[${MOD_ID}] Hauler progression character=${characterID} contract=${record.contractID} ` +
      `xp=${awardResult.award.xp} level=${awardResult.award.levelAfter} ` +
      `bonus=${awardResult.award.bonusISK.toFixed(2)}`,
    );
    return true;
  }

  async _observeContract(record, entry, nowMs, dependencies) {
    const status = Number(record.status);
    const expired = isExpired(record, nowMs) && status === STATUS_OUTSTANDING;
    const previousStatus = entry.lastStatus;
    if (status === STATUS_IN_PROGRESS && previousStatus !== STATUS_IN_PROGRESS && entry.lastEvent !== "accepted") {
      this._addStationScore(entry.originStationID, this._config.acceptanceScore);
      entry.lastEvent = "accepted";
      log.info(`[${MOD_ID}] contract accepted contract=${record.contractID}`);
    }
    const completed = COMPLETED_STATUSES.has(status);
    const wasAlreadyMarkedCompleted = entry.lastEvent === "completed";
    const needsHaulerAward = completed &&
      positive(record.packageOwnerID, positive(record.acceptorID, 0)) > 0 &&
      !this._hasHaulerAward(record);
    if (completed && (!wasAlreadyMarkedCompleted || needsHaulerAward)) {
      if (!await this._awardHaulerCompletion(record, entry, dependencies, nowMs)) {
        entry.lastStatus = Number.isFinite(status) ? status : null;
        entry.lastEvent = "completion-reward-pending";
        entry.state = "completed";
        entry.updatedAtMs = nowMs;
        return;
      }
      if (!wasAlreadyMarkedCompleted) {
        this._addStationScore(entry.originStationID, this._config.completionScore);
        this._addStationScore(entry.destinationStationID, this._config.completionScore);
      }
      entry.lastEvent = "completed";
      log.info(
        `[${MOD_ID}] contract completed${wasAlreadyMarkedCompleted ? " (Hauler award backfilled)" : ""} ` +
        `contract=${record.contractID}`,
      );
    } else if (FAILED_STATUSES.has(status) && entry.lastEvent !== "failed") {
      this._addStationScore(entry.originStationID, this._config.failureScore);
      entry.lastEvent = "failed";
      log.info(`[${MOD_ID}] contract failed contract=${record.contractID} status=${status}`);
    } else if (expired && entry.lastEvent !== "expired") {
      this._addStationScore(entry.originStationID, this._config.failureScore);
      entry.lastEvent = "expired";
      log.info(`[${MOD_ID}] contract expired contract=${record.contractID}`);
    }
    entry.lastStatus = Number.isFinite(status) ? status : null;
    entry.state = expired || FAILED_STATUSES.has(status)
      ? "expired"
      : COMPLETED_STATUSES.has(status)
        ? "completed"
        : "active";
    entry.updatedAtMs = nowMs;
  }

  async _reconcileContracts(dependencies, nowMs) {
    const generatedRecords = this._listGeneratedRecords(dependencies);
    const recordsByID = new Map(generatedRecords.map((record) => [positive(record.contractID, 0), record]));
    let changed = false;
    for (const [jobKey, entry] of Object.entries(this._state.contracts || {})) {
      if (entry.contractID <= 0) {
        continue;
      }
      const record = recordsByID.get(entry.contractID);
      if (!record) {
        if (entry.state !== "creating" && entry.state !== "recovery") {
          entry.state = "missing";
          entry.updatedAtMs = nowMs;
          changed = true;
        }
        continue;
      }
      await this._observeContract(record, entry, nowMs, dependencies);
      changed = true;
      this._state.contracts[jobKey] = entry;
    }
    for (const record of generatedRecords) {
      const contractID = positive(record.contractID, 0);
      const known = Object.values(this._state.contracts || {})
        .some((entry) => entry.contractID === contractID);
      if (!known) {
        const entry = buildStateEntryFromRecord(record, "contract:");
        this._state.contracts[entry.jobKey] = entry;
        await this._observeContract(record, entry, nowMs, dependencies);
        changed = true;
      }
    }
    return changed;
  }

  _activeRecords(dependencies, nowMs) {
    return this._listGeneratedRecords(dependencies)
      .filter((record) => statusIsActive(record, nowMs));
  }

  _extractGrantedItemID(result) {
    const data = result && result.data;
    const itemIDs = data && Array.isArray(data.itemIDs) ? data.itemIDs : [];
    if (itemIDs.length > 0) {
      return positive(itemIDs[0], 0);
    }
    const items = data && Array.isArray(data.items) ? data.items : [];
    return positive(items[0] && items[0].itemID, 0);
  }

  async _submitContract(entry, info, dependencies, nowMs) {
    const issuerSession = this._buildIssuerSession(entry.originStationID);
    let result;
    try {
      result = await dependencies.contractRuntime.createContract(
        info,
        issuerSession,
        {syncInventory: false, notify: false},
      );
    } catch (error) {
      result = {success: false, errorMsg: error.message};
    }
    const contractID = result && Array.isArray(result.contractIDs)
      ? positive(result.contractIDs[0], 0)
      : 0;
    if (!result || result.success !== true || !contractID) {
      entry.state = "recovery";
      entry.lastEvent = "contract-create-failed";
      entry.updatedAtMs = Date.now();
      this._stateStore.save(this._state);
      log.warn(`[${MOD_ID}] contract creation failed job=${entry.jobKey} error=${result && result.errorMsg || "unknown"}`);
      return null;
    }

    entry.contractID = contractID;
    entry.state = "active";
    entry.lastStatus = STATUS_OUTSTANDING;
    entry.lastEvent = "created";
    entry.updatedAtMs = nowMs;
    this._stateStore.save(this._state);
    log.info(
      `[${MOD_ID}] created contract=${contractID} origin=${entry.originStationID} ` +
      `destination=${entry.destinationStationID} jumps=${entry.jumps} item=${entry.typeID} ` +
      `quantity=${entry.quantity} reward=${info.reward} collateral=${info.collateral}`,
    );
    return result.contract || {contractID, status: STATUS_OUTSTANDING, ...info};
  }

  _prepareRecoveryCargo(entry, dependencies) {
    const itemStore = dependencies.itemStore;
    if (
      typeof itemStore.findItemById !== "function" ||
      typeof itemStore.updateInventoryItem !== "function"
    ) {
      return false;
    }
    const item = itemStore.findItemById(entry.itemID);
    if (
      !item ||
      positive(item.ownerID, 0) !== this._issuer.corporationID ||
      positive(item.locationID, 0) !== positive(entry.originStationID, 0) ||
      positive(item.typeID, 0) !== positive(entry.typeID, 0)
    ) {
      return false;
    }
    const contractHangarFlag = corporationContractHangarFlag(this._config);
    if (positive(item.flagID, 0) === contractHangarFlag) {
      return true;
    }
    const updateResult = itemStore.updateInventoryItem(
      entry.itemID,
      (current) => (
        positive(current.ownerID, 0) === this._issuer.corporationID &&
        positive(current.locationID, 0) === positive(entry.originStationID, 0) &&
        positive(current.typeID, 0) === positive(entry.typeID, 0)
          ? {...current, flagID: contractHangarFlag}
          : current
      ),
    );
    return Boolean(
      updateResult &&
      updateResult.success === true &&
      positive(updateResult.data && updateResult.data.flagID, 0) === contractHangarFlag,
    );
  }

  async _retryRecoveryEntries(dependencies, nowMs) {
    const entries = Object.values(this._state.contracts || {})
      .filter((entry) => (
        entry &&
        entry.state === "recovery" &&
        positive(entry.contractID, 0) === 0 &&
        positive(entry.itemID, 0) > 0
      ));
    for (const entry of entries) {
      const origin = this._stationsByID.get(positive(entry.originStationID, 0));
      const destination = this._stationsByID.get(positive(entry.destinationStationID, 0));
      const itemMetadata = dependencies.itemStore.getItemMetadata(entry.typeID);
      if (!origin || !destination || !itemMetadata) {
        continue;
      }
      if (!this._prepareRecoveryCargo(entry, dependencies)) {
        continue;
      }
      const item = {
        typeID: entry.typeID,
        referenceValueISK: 0,
      };
      const info = buildContractInfo({
        config: this._config,
        origin,
        destination,
        item,
        itemMetadata,
        quantity: entry.quantity,
        jumps: entry.jumps,
      });
      info.reward = entry.reward;
      info.collateral = entry.collateral;
      info.itemList = [[entry.itemID, entry.quantity]];
      await this._submitContract(entry, info, dependencies, nowMs);
    }
  }

  async _clearExistingContractsOnce(dependencies, nowMs) {
    if (
      this._config.clearExistingContractsOnce !== true &&
      this._config.wipeAllActiveContractsOnce !== true ||
      this._state.maintenance.legacyCleanupVersion >= this._config.legacyCleanupVersion ||
      !this._issuer
    ) {
      return;
    }

    if (this._config.wipeAllActiveContractsOnce === true) {
      if (typeof dependencies.contractRuntime.wipeActiveContracts !== "function") {
        log.warn(`[${MOD_ID}] full contract wipe is unavailable in this EveJS build`);
        return false;
      }
      const result = await dependencies.contractRuntime.wipeActiveContracts({
        notify: false,
        syncInventory: false,
      });
      if (!result || result.success !== true) {
        log.warn(
          `[${MOD_ID}] full contract wipe incomplete deleted=${result && result.deleted && result.deleted.length || 0} ` +
          `failed=${result && result.failed && result.failed.length || 0}`,
        );
        return false;
      }
      this._state.maintenance.existingContractsCleared = true;
      this._state.maintenance.legacyCleanupVersion = this._config.legacyCleanupVersion;
      this._stateStore.save(this._state);
      log.info(
        `[${MOD_ID}] cleared ${result.deleted.length} active contracts including player contracts`,
      );
      return true;
    }

    const records = this._listGeneratedRecords(dependencies)
      .filter((record) => ACTIVE_STATUSES.has(Number(record.status)) || Number(record.status) === STATUS_REJECTED);
    const contractIDs = records
      .filter((record) => Number(record.status) === STATUS_OUTSTANDING || Number(record.status) === STATUS_REJECTED)
      .map((record) => positive(record.contractID, 0))
      .filter(Boolean);
    const inProgress = records
      .filter((record) => Number(record.status) === STATUS_IN_PROGRESS)
      .map((record) => positive(record.contractID, 0))
      .filter(Boolean);
    if (inProgress.length > 0 && typeof dependencies.contractRuntime.completeContract === "function") {
      for (const contractID of inProgress) {
        const result = await dependencies.contractRuntime.completeContract(
          contractID,
          STATUS_FAILED,
          this._buildIssuerSession(this._hubs[0].stationID),
          {notify: false},
        );
        if (result !== true) {
          log.warn(`[${MOD_ID}] legacy in-progress cleanup pending contract=${contractID}`);
          return;
        }
      }
    }
    if (contractIDs.length > 0) {
      const result = await dependencies.contractRuntime.deleteMultipleContracts(
        contractIDs,
        this._buildIssuerSession(this._hubs[0].stationID),
        {notify: false},
      );
      if (!result || !Array.isArray(result.deleted) || result.deleted.length !== contractIDs.length) {
        log.warn(
          `[${MOD_ID}] legacy contract cleanup incomplete deleted=${result && result.deleted && result.deleted.length || 0} ` +
          `failed=${result && result.failed && result.failed.length || contractIDs.length}`,
        );
        return;
      }
    }
    if (this._listGeneratedRecords(dependencies).some((record) =>
      ACTIVE_STATUSES.has(Number(record.status)) || Number(record.status) === STATUS_REJECTED)) {
      log.warn(
        `[${MOD_ID}] legacy contract cleanup incomplete: generated active contracts remain`,
      );
      return;
    }
    this._state.maintenance.existingContractsCleared = true;
    this._state.maintenance.legacyCleanupVersion = this._config.legacyCleanupVersion;
    this._stateStore.save(this._state);
    log.info(`[${MOD_ID}] cleared ${records.length} existing NPC courier contracts for cargo model migration`);
    return true;
  }

  _buildIssuerSession(originStationID) {
    return {
      ...this._issuer.session,
      stationID: originStationID,
      stationid: originStationID,
      solarsystemid: this._stationsByID.get(originStationID).solarSystemID,
      solarsystemid2: this._stationsByID.get(originStationID).solarSystemID,
    };
  }

  _chooseCargo(seed, dependencies) {
    const catalog = this._config.cargoCatalog;
    const targetVolume = this._config.cargo.referenceVolumeM3 * (
      this._config.cargo.minimumLoadFraction +
      hashUnit(`${seed}:load`) * (
        this._config.cargo.maximumLoadFraction - this._config.cargo.minimumLoadFraction
      )
    );
    const stackCount = Math.min(
      catalog.length,
      this._config.cargo.minimumStackCount + Math.floor(
        hashUnit(`${seed}:stacks`) * (
          this._config.cargo.maximumStackCount - this._config.cargo.minimumStackCount + 1
        ),
      ),
    );
    const cargoItems = [];
    for (let index = 0; index < stackCount; index += 1) {
      const item = catalog[Math.floor(hashUnit(`${seed}:item:${index}`) * catalog.length)];
      const metadata = dependencies.itemStore.getItemMetadata(item.typeID);
      const volume = finite(metadata && metadata.volume, 0);
      if (!metadata || volume <= 0) continue;
      const remainingStacks = stackCount - index;
      const share = targetVolume / remainingStacks;
      const minimumQuantity = Math.max(1, Math.trunc(item.minimumQuantity));
      const maximumQuantity = Math.min(
        Math.max(minimumQuantity, Math.trunc(item.maximumQuantity)),
        Math.floor(item.maximumVolumeM3 / volume),
      );
      if (maximumQuantity < minimumQuantity) continue;
      const desired = Math.max(minimumQuantity, Math.round(share / volume));
      const quantity = Math.min(maximumQuantity, desired);
      cargoItems.push({item, metadata, quantity});
    }
    return cargoItems.length >= this._config.cargo.minimumStackCount ? cargoItems : null;
  }

  async _createOne(origin, activeTotal, dependencies, nowMs, routeOverride = null) {
    if (!this._issuer) {
      return null;
    }
    const originStations = this._originStations();
    const sequence = Math.max(0, Math.trunc(this._state.sequence || 0)) + 1;
    this._state.sequence = sequence;
    const tickSlot = Math.floor(nowMs / this._config.tickIntervalMs);
    const seed = `${tickSlot}:${origin.stationID}:${sequence}${routeOverride ? ":return" : ""}`;
    const jobKey = `job:${origin.stationID}:${tickSlot}:${sequence}`;
    const destinationChoice = routeOverride || selectDestination({
        origin,
        establishedStations: originStations,
        eligibleStations: this._eligibleStations,
        graph: this._graph,
        seed,
        hubDestinationWeight: this._config.hubDestinationWeight,
        shortHaulChance: this._config.shortHaulChance,
        shortHaulMaxJumps: this._config.shortHaulMaxJumps,
      });
    if (!destinationChoice) {
      log.warn(`[${MOD_ID}] no reachable destination for origin=${origin.stationID}`);
      this._stateStore.save(this._state);
      return null;
    }

    const destination = destinationChoice.station;
    const jumps = destinationChoice.jumps;
    const cargo = this._chooseCargo(seed, dependencies);
    if (!cargo) {
      log.warn(`[${MOD_ID}] cargo catalog could not produce a valid item for job=${jobKey}`);
      this._stateStore.save(this._state);
      return null;
    }
    const info = buildMultiCargoContractInfo({
      config: this._config,
      origin,
      destination,
      cargoItems: cargo,
      jumps,
    });
    const plexMinimum = this._config.plexReward.minimum;
    const plexMaximum = this._config.plexReward.maximum;
    info.plexReward = plexMinimum + Math.floor(
      hashUnit(`${seed}:plex`) * (plexMaximum - plexMinimum + 1),
    );
    info.description += ` Completion bonus: ${info.plexReward} PLEX in addition to the ISK reward.`;
    const walletBalance = dependencies.corpWalletState.getCorporationWalletBalance(
      this._issuer.corporationID,
      this._config.issuer.walletAccountKey,
    );
    if (
      finite(walletBalance, 0) < info.reward + this._config.issuer.minimumBalanceISK
    ) {
      if (!this._fundingWarningIssued) {
        log.warn(
          `[${MOD_ID}] issuer wallet is underfunded balance=${Number(walletBalance || 0).toFixed(2)} ` +
          `required=${(info.reward + this._config.issuer.minimumBalanceISK).toFixed(2)}; fund corporation=${this._issuer.corporationID} before generation`,
        );
        this._fundingWarningIssued = true;
      }
      return null;
    }
    this._fundingWarningIssued = false;

    const entry = {
      jobKey,
      contractID: 0,
      state: "creating",
      lastStatus: null,
      lastEvent: "creating",
      originStationID: origin.stationID,
      destinationStationID: destination.stationID,
      typeID: cargo[0].item.typeID,
      quantity: cargo.reduce((sum, entry) => sum + entry.quantity, 0),
      items: cargo.map((entry) => ({typeID: entry.item.typeID, quantity: entry.quantity, itemID: 0})),
      itemID: 0,
      reward: info.reward,
      collateral: info.collateral,
      jumps,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this._state.contracts[jobKey] = entry;
    this._stateStore.save(this._state);

    const receiptKey = `${MOD_ID}:${jobKey}:cargo`;
    const grantedItems = [];
    for (let index = 0; index < cargo.length; index += 1) {
      const entry = cargo[index];
      const grantResult = dependencies.itemStore.grantItemToOwnerLocationIdempotent(
        this._issuer.corporationID,
        origin.stationID,
        corporationContractHangarFlag(this._config),
        entry.item.typeID,
        entry.quantity,
        {
          receiptKey: `${receiptKey}:${index}`,
          receiptMetadata: {mod: MOD_ID, jobKey, stackIndex: index},
        },
      );
      if (!grantResult || grantResult.success !== true || grantResult.durable !== true) {
        entry.grantResult = grantResult;
        entry.grantFailed = true;
        break;
      }
      const itemID = this._extractGrantedItemID(grantResult);
      if (!itemID) {
        entry.grantFailed = true;
        break;
      }
      grantedItems.push({itemID, typeID: entry.item.typeID, quantity: entry.quantity});
    }
    if (grantedItems.length !== cargo.length) {
      entry.state = "recovery";
      entry.lastEvent = "cargo-grant-failed";
      entry.updatedAtMs = Date.now();
      this._stateStore.save(this._state);
      log.warn(`[${MOD_ID}] cargo grant failed job=${jobKey}`);
      return null;
    }
    entry.itemID = grantedItems[0].itemID;
    entry.items = grantedItems;
    info.itemList = grantedItems.map((item) => [item.itemID, item.quantity]);
    this._stateStore.save(this._state);
    const submitted = await this._submitContract(entry, info, dependencies, nowMs);
    if (!submitted) {
      return null;
    }

    const entries = [entry];
    if (
      !routeOverride &&
      this._config.generateReturnContracts === true &&
      activeTotal + entries.length < this._config.maxOutstandingContracts
    ) {
      const returnJumps = this._routeDistance(destination, origin);
      if (Number.isFinite(returnJumps) && returnJumps > 0) {
        const returnCreated = await this._createOne(
          destination,
          activeTotal + entries.length,
          dependencies,
          nowMs,
          {station: origin, jumps: returnJumps},
        );
        if (returnCreated && Array.isArray(returnCreated.entries)) {
          entries.push(...returnCreated.entries);
        } else {
          log.warn(`[${MOD_ID}] return contract creation failed for pair job=${jobKey}`);
        }
      } else {
        log.warn(
          `[${MOD_ID}] no reverse route for return contract origin=${destination.stationID} ` +
          `destination=${origin.stationID}`,
        );
      }
    }
    return {contract: submitted, entries};
  }

  async _fillContracts(dependencies, nowMs) {
    const activeRecords = this._activeRecords(dependencies, nowMs);
    const activeByOrigin = new Map();
    for (const record of activeRecords) {
      const originID = positive(record.startStationID, 0);
      activeByOrigin.set(originID, (activeByOrigin.get(originID) || 0) + 1);
    }
    let activeTotal = activeRecords.length;
    if (activeTotal >= this._config.maxOutstandingContracts) {
      return;
    }
    for (const origin of this._originStations()) {
      let originCount = activeByOrigin.get(origin.stationID) || 0;
      while (
        originCount < this._config.contractsPerOrigin &&
        activeTotal < this._config.maxOutstandingContracts
      ) {
        const created = await this._createOne(origin, activeTotal, dependencies, nowMs);
        if (!created) {
          break;
        }
        const createdEntries = Array.isArray(created.entries) ? created.entries : [];
        if (createdEntries.length === 0) {
          break;
        }
        for (const entry of createdEntries) {
          const createdOriginID = positive(entry.originStationID, 0);
          activeByOrigin.set(
            createdOriginID,
            (activeByOrigin.get(createdOriginID) || 0) + 1,
          );
        }
        originCount = activeByOrigin.get(origin.stationID) || 0;
        activeTotal += createdEntries.length;
      }
      activeByOrigin.set(origin.stationID, originCount);
      if (activeTotal >= this._config.maxOutstandingContracts) {
        break;
      }
    }
  }

  async tick(nowMs = Date.now()) {
    if (!this._config.enabled || this._tickInProgress) {
      return this.getStatus();
    }
    this._tickInProgress = true;
    const dependencies = this._getDependencies();
    try {
      if (!this._resolveNetwork(dependencies)) {
        this._lastError = "issuer or station network is unavailable";
        return this.getStatus();
      }
      this._decayActivity(nowMs);
      this._updatePresenceActivity(dependencies);
      this._updateMarketActivity();
      await this._ensureTreasury(dependencies, nowMs);
      await this._reconcileContracts(dependencies, nowMs);
      const cleanupResult = await this._clearExistingContractsOnce(dependencies, nowMs);
      if (cleanupResult === false) {
        return this.getStatus();
      }
      this._promoteStations();
      await this._retryRecoveryEntries(dependencies, nowMs);
      await this._fillContracts(dependencies, nowMs);
      this._state.lastTickAtMs = nowMs;
      this._stateStore.save(this._state);
      this._lastError = "";
    } catch (error) {
      this._lastError = String(error && error.message || error || "unknown error");
      log.warn(`[${MOD_ID}] tick failed: ${this._lastError}`);
    } finally {
      this._tickInProgress = false;
    }
    return this.getStatus();
  }
}

NpcCourierContractsService._testing = {
  buildContractInfo,
  fileTimeToMs,
  isExpired,
  normalizeState: (value) => require(path.join(__dirname, "state")).normalizeState(value),
  statusIsActive,
};

module.exports = NpcCourierContractsService;
