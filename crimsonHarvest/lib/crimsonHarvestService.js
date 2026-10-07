"use strict";

const path = require("node:path");
const BaseService = require(path.join(
  __dirname,
  "../../../server/src/services/baseService",
));

const EVENT_ID = "crimson_harvest";
const EVENT_SITE_ORIGIN = "crimson_harvest";
const EVENT_SPAWN_FAMILY = "crimson_harvest";
const POCHVEN_REGION_ID = 10000070;
const PUBLIC_POOL_PERCENT = 30;
const EVENT_SITE_ID_BASE = 6_570_000_000_000;
const EVENT_SITE_SLOT = 0;
const EVENT_MESSAGE =
  "Crimson Harvest is active from October 1 through November 3 UTC. " +
  "Scan for event sites and watch for public Crimson Harvest combat anomalies.";

const PUBLIC_TEMPLATE_IDS = Object.freeze([
  "client-dungeon:6402", // Crimson Gauntlet
  "client-dungeon:8923", // Tetrimon Base
  "client-dungeon:8926", // Crimson Gauntlet
  "client-dungeon:13471", // Tetrimon Base
  "client-dungeon:13472", // Crimson Gauntlet
]);

const SCAN_TEMPLATE_IDS = Object.freeze([
  "client-dungeon:13416", // Class 1 Biocybernetic Incident
  "client-dungeon:13327", // Class 2 Biocybernetic Incident
  "client-dungeon:13414", // Class 3 Biocybernetic Incident
]);

const LIFECYCLE_STATES = Object.freeze([
  "seeded",
  "active",
  "paused",
  "completed",
  "failed",
  "despawned",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function eventWindow(nowMs = Date.now()) {
  const date = new Date(toInt(nowMs, Date.now()));
  const year = date.getUTCFullYear();
  const startMs = Date.UTC(year, 9, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, 10, 4, 0, 0, 0, 0);
  const timestamp = date.getTime();
  return {
    year,
    startMs,
    endMs,
    active: timestamp >= startMs && timestamp < endMs,
  };
}

function isEventActive(nowMs = Date.now()) {
  return eventWindow(nowMs).active;
}

function normalizeSecurityBand(systemID, systemRecord = null) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID >= 31_000_000 && numericSystemID <= 31_999_999) {
    return "wormhole";
  }
  const securityStatus = Number(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
  );
  if (Number.isFinite(securityStatus) && securityStatus >= 0.45) {
    return "highsec";
  }
  if (Number.isFinite(securityStatus) && securityStatus >= 0) {
    return "lowsec";
  }
  return "nullsec";
}

function isPochvenSystem(systemID, systemRecord = null) {
  return toInt(systemRecord && systemRecord.regionID, 0) === POCHVEN_REGION_ID;
}

function isEligibleSystem(systemID, systemRecord = null) {
  if (!systemRecord || typeof systemRecord !== "object") {
    return false;
  }
  const band = normalizeSecurityBand(systemID, systemRecord);
  return ["highsec", "lowsec", "nullsec"].includes(band) &&
    !isPochvenSystem(systemID, systemRecord);
}

function poolForSystem(systemID, year) {
  return hashText(`${toInt(year, 0)}:${toInt(systemID, 0)}:pool`) % 100 < PUBLIC_POOL_PERCENT
    ? "public"
    : "scan";
}

function templateIDForSystem(systemID, year, pool) {
  const candidates = pool === "public" ? PUBLIC_TEMPLATE_IDS : SCAN_TEMPLATE_IDS;
  const index = hashText(`${toInt(year, 0)}:${toInt(systemID, 0)}:${pool}:template`) % candidates.length;
  return candidates[index];
}

function buildEventSiteID(systemID) {
  const numericSystemID = toInt(systemID, 0);
  return numericSystemID > 0
    ? EVENT_SITE_ID_BASE + numericSystemID * 1000 + 1
    : 0;
}

function resolveInstanceEventYear(instance) {
  return toInt(
    instance && instance.metadata && instance.metadata.eventYear,
    toInt(instance && instance.spawnState && instance.spawnState.eventYear, 0),
  );
}

function isEventInstance(instance) {
  return Boolean(
    instance && (
      String(instance.siteOrigin || "").toLowerCase() === EVENT_SITE_ORIGIN ||
      instance.runtimeFlags && instance.runtimeFlags.crimsonHarvest === true ||
      instance.metadata && instance.metadata.eventID === EVENT_ID
    ),
  );
}

function resolveSystemID(session, attached, options = {}) {
  const candidates = [
    options.systemID,
    options.sceneDescriptor && options.sceneDescriptor.locationID,
    attached && attached.systemID,
    attached && attached.solarSystemID,
    session && session.solarsystemid,
    session && session.solarsystemid2,
  ];
  for (const candidate of candidates) {
    const numeric = toInt(candidate, 0);
    if (numeric > 0) return numeric;
  }
  return 0;
}

function getRuntimeDependencies() {
  return {
    dungeonAuthority: require(path.join(
      __dirname,
      "../../../server/src/services/dungeon/dungeonAuthority",
    )),
    dungeonRuntime: require(path.join(
      __dirname,
      "../../../server/src/services/dungeon/dungeonRuntime",
    )),
    dungeonSiteAdapter: require(path.join(
      __dirname,
      "../../../server/src/services/dungeon/dungeonSiteAdapter",
    )),
    dungeonUniverseRuntime: require(path.join(
      __dirname,
      "../../../server/src/services/dungeon/dungeonUniverseRuntime",
    )),
    worldData: require(path.join(
      __dirname,
      "../../../server/src/space/worldData",
    )),
    pochvenPolicy: require(path.join(
      __dirname,
      "../../../server/src/space/pochvenPolicy",
    )),
    chatHub: require(path.join(
      __dirname,
      "../../../server/src/services/chat/chatHub",
    )),
  };
}

function buildEventDefinition(deps, systemID, nowMs = Date.now()) {
  const numericSystemID = toInt(systemID, 0);
  const window = eventWindow(nowMs);
  const systemRecord = deps.worldData.getSolarSystemByID(numericSystemID);
  const nativePochven = deps.pochvenPolicy &&
    typeof deps.pochvenPolicy.isPochvenSystem === "function" &&
    deps.pochvenPolicy.isPochvenSystem(numericSystemID, systemRecord);
  if (!window.active || !isEligibleSystem(numericSystemID, systemRecord) || nativePochven) {
    return null;
  }

  const pool = poolForSystem(numericSystemID, window.year);
  const templateID = templateIDForSystem(numericSystemID, window.year, pool);
  const sourceTemplate = deps.dungeonAuthority.getTemplateByID(templateID);
  if (!sourceTemplate) {
    throw new Error(`Crimson Harvest template is not available: ${templateID}`);
  }

  const publicSite = pool === "public";
  const template = {
    ...sourceTemplate,
    siteKind: publicSite ? "anomaly" : "signature",
    entryObjectTypeID: publicSite ? 28356 : 19728,
  };
  const siteID = buildEventSiteID(numericSystemID);
  const providerID = publicSite ? "sceneAnomalySite" : "sceneSignatureSite";
  const universeTesting = deps.dungeonUniverseRuntime._testing;
  const definition = universeTesting.buildUniverseSiteDefinition(
    template,
    "combat",
    numericSystemID,
    EVENT_SITE_SLOT,
    {
      // The builder supplies authoritative placement and dungeon state. The
      // event identity is rewritten below because this mod owns a separate
      // spawn family from EveJS's normal combat families.
      spawnFamilyKey: "combat",
      band: normalizeSecurityBand(numericSystemID, systemRecord),
      startedAtMs: toInt(nowMs, Date.now()),
      lifetimeMs: Math.max(60_000, window.endMs - toInt(nowMs, Date.now())),
      label: normalizeText(sourceTemplate.resolvedName, sourceTemplate.templateID),
      definitionDiscriminator: `${EVENT_ID}:${window.year}:${pool}`,
      siteOrigin: EVENT_SITE_ORIGIN,
      metadata: {
        eventID: EVENT_ID,
        eventYear: window.year,
        pool,
        originalTemplateID: templateID,
        spawnFamilyKey: EVENT_SPAWN_FAMILY,
      },
      spawnState: {
        eventID: EVENT_ID,
        eventYear: window.year,
        pool,
        originalTemplateID: templateID,
        spawnFamilyKey: EVENT_SPAWN_FAMILY,
      },
      runtimeFlags: {
        crimsonHarvest: true,
      },
    },
  );
  if (!definition) {
    return null;
  }

  const siteKey = deps.dungeonSiteAdapter.buildSiteKey(providerID, numericSystemID, siteID);
  definition.siteKey = siteKey;
  definition.siteKind = publicSite ? "anomaly" : "signature";
  definition.siteOrigin = EVENT_SITE_ORIGIN;
  definition.metadata = {
    ...definition.metadata,
    providerID,
    siteID,
    spawnFamilyKey: EVENT_SPAWN_FAMILY,
    eventID: EVENT_ID,
    eventYear: window.year,
    pool,
    originalTemplateID: templateID,
  };
  definition.spawnState = {
    ...definition.spawnState,
    siteID,
    spawnFamilyKey: EVENT_SPAWN_FAMILY,
    eventID: EVENT_ID,
    eventYear: window.year,
    pool,
    originalTemplateID: templateID,
    groupID: publicSite ? 885 : 502,
    entryObjectTypeID: publicSite ? 28356 : 19728,
  };
  definition.runtimeFlags = {
    ...definition.runtimeFlags,
    crimsonHarvest: true,
    universeSeeded: true,
    universePersistent: true,
    lazyMaterialized: true,
  };
  return definition;
}

class CrimsonHarvestService extends BaseService {
  constructor() {
    super("crimsonHarvest");
    this._deps = null;
    this._startupPromise = null;
    this._started = false;
    this._lastCleanupKey = null;
    this._systemLanes = new Map();
    this._notifiedSessions = new WeakSet();
  }

  getDependencies() {
    if (!this._deps) {
      this._deps = getRuntimeDependencies();
    }
    return this._deps;
  }

  start() {
    if (this._startupPromise) {
      return this._startupPromise;
    }
    this._started = true;
    this._startupPromise = Promise.resolve()
      .then(() => this.cleanupExpiredEventSites(Date.now()))
      .catch((error) => {
        console.warn(`[crimsonHarvest] startup cleanup failed safely: ${error.message}`);
        return null;
      });
    return this._startupPromise;
  }

  runSerialized(systemID, work) {
    const key = String(toInt(systemID, 0));
    const previous = this._systemLanes.get(key) || Promise.resolve();
    const current = previous.then(work, work);
    this._systemLanes.set(key, current.catch(() => undefined));
    return current;
  }

  listEventInstances() {
    const runtime = this.getDependencies().dungeonRuntime;
    return LIFECYCLE_STATES.flatMap((lifecycleState) => runtime.listInstancesByLifecycle(
      lifecycleState,
      { full: true },
    )).filter(isEventInstance);
  }

  cleanupExpiredEventSites(nowMs = Date.now()) {
    const window = eventWindow(nowMs);
    const cleanupKey = `${window.active ? "active" : "inactive"}:${window.year}`;
    if (this._lastCleanupKey === cleanupKey) {
      return { removedCount: 0, skipped: true };
    }
    this._lastCleanupKey = cleanupKey;
    const runtime = this.getDependencies().dungeonRuntime;
    const stale = this.listEventInstances().filter((instance) => (
      !window.active || resolveInstanceEventYear(instance) !== window.year
    ));
    if (stale.length <= 0) {
      return { removedCount: 0, skipped: false };
    }
    return runtime.purgeInstances(
      stale.map((instance) => instance.instanceID),
      { source: "crimsonHarvest.cleanup" },
    );
  }

  reconcileSystem(systemID, nowMs = Date.now()) {
    return this.runSerialized(systemID, async () => {
      const deps = this.getDependencies();
      const numericSystemID = toInt(systemID, 0);
      const cleanup = this.cleanupExpiredEventSites(nowMs);
      const systemRecord = deps.worldData.getSolarSystemByID(numericSystemID);
      if (!isEventActive(nowMs) || !isEligibleSystem(numericSystemID, systemRecord)) {
        return { success: true, skipped: true, cleanup };
      }
      const definition = buildEventDefinition(deps, numericSystemID, nowMs);
      const result = deps.dungeonRuntime.reconcileUniverseSeededInstances(
        definition ? [definition] : [],
        {
          systemIDs: [numericSystemID],
          siteOriginFilter: [EVENT_SITE_ORIGIN],
          nowMs: toInt(nowMs, Date.now()),
        },
      );
      return {
        success: true,
        skipped: false,
        cleanup,
        pool: definition && definition.metadata && definition.metadata.pool,
        templateID: definition && definition.templateID,
        ...result,
      };
    });
  }

  async handleSessionAttached(session, attached, options = {}) {
    await this.start();
    const nowMs = Date.now();
    const active = isEventActive(nowMs);
    if (active && session && typeof session === "object" && !this._notifiedSessions.has(session)) {
      this._notifiedSessions.add(session);
      try {
        this.getDependencies().chatHub.sendSystemMessage(session, EVENT_MESSAGE);
      } catch (error) {
        console.warn(`[crimsonHarvest] connection notification failed safely: ${error.message}`);
      }
    }
    const systemID = resolveSystemID(session, attached, options);
    if (systemID > 0) {
      return this.reconcileSystem(systemID, nowMs);
    }
    return { success: true, skipped: true, reason: "system_not_resolved" };
  }

  Handle_GetStatus() {
    const window = eventWindow(Date.now());
    return {
      active: window.active,
      year: window.year,
      publicPoolPercent: PUBLIC_POOL_PERCENT,
      siteOrigin: EVENT_SITE_ORIGIN,
      spawnFamilyKey: EVENT_SPAWN_FAMILY,
    };
  }
}

module.exports = CrimsonHarvestService;
module.exports._testing = Object.freeze({
  EVENT_ID,
  EVENT_SITE_ORIGIN,
  EVENT_SPAWN_FAMILY,
  EVENT_MESSAGE,
  PUBLIC_TEMPLATE_IDS,
  SCAN_TEMPLATE_IDS,
  eventWindow,
  isEventActive,
  normalizeSecurityBand,
  isPochvenSystem,
  isEligibleSystem,
  poolForSystem,
  templateIDForSystem,
  buildEventSiteID,
  isEventInstance,
  resolveInstanceEventYear,
  buildEventDefinition,
});
