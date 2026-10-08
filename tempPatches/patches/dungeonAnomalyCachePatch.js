const path = require("node:path");

const PATCH_FLAG = Symbol.for("evejs.tempPatches.dungeonAnomalyCachePatchInstalled");
const ACTIVE_STATES = new Set(["seeded", "active", "paused"]);
const COMBAT_ARCHETYPE_ID = 24;
const SERVER_SRC_PATH = path.resolve(__dirname, "..", "..", "..", "server", "src");
const RUNTIME_STATE_PATH = path.join(
  SERVER_SRC_PATH,
  "services",
  "dungeon",
  "dungeonRuntimeState.js",
);
const AUTHORITY_PATH = path.join(
  SERVER_SRC_PATH,
  "services",
  "dungeon",
  "dungeonAuthority.js",
);
const SERVICE_HELPERS_PATH = path.join(
  SERVER_SRC_PATH,
  "services",
  "_shared",
  "serviceHelpers.js",
);

function log(message) {
  console.log(`[temppatches] ${message}`);
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function buildPositionPayload(position, buildList) {
  if (!position || typeof position !== "object") {
    return null;
  }
  return buildList([
    Number(position.x) || 0,
    Number(position.y) || 0,
    Number(position.z) || 0,
  ]);
}

function buildCombatProjection(state, getTemplateByID, helpers) {
  const entriesBySystem = new Map();
  const countsBySystem = new Map();
  const instancesByID = state && state.instancesByID && typeof state.instancesByID === "object"
    ? state.instancesByID
    : {};

  for (const instance of Object.values(instancesByID)) {
    if (!instance || typeof instance !== "object") {
      continue;
    }
    if (!ACTIVE_STATES.has(normalizeText(instance.lifecycleState, "").toLowerCase())) {
      continue;
    }
    if (normalizeText(instance.instanceScope, "shared").toLowerCase() !== "shared") {
      continue;
    }
    if (normalizeText(instance.siteKind, "").toLowerCase() !== "anomaly") {
      continue;
    }

    const template = typeof getTemplateByID === "function"
      ? getTemplateByID(normalizeText(instance.templateID, ""))
      : null;
    const archetypeID = toInt(instance.archetypeID, 0) || toInt(template && template.archetypeID, 0);
    if (archetypeID !== COMBAT_ARCHETYPE_ID) {
      continue;
    }

    const instanceID = Math.max(0, toInt(instance.instanceID, 0));
    const solarSystemID = Math.max(0, toInt(instance.solarSystemID, 0));
    const dungeonID = Math.max(
      0,
      toInt(instance.sourceDungeonID, 0) || toInt(template && template.sourceDungeonID, 0),
    );
    if (instanceID <= 0 || solarSystemID <= 0 || dungeonID <= 0) {
      continue;
    }

    const record = {
      instanceID,
      solarSystemID,
      dungeonID,
      archetypeID,
      factionID: toInt(instance.factionID, 0) || toInt(template && template.factionID, 0) || null,
      difficulty: toInt(instance.difficulty, 0) || toInt(template && template.difficulty, 0) || 1,
      entryObjectTypeID:
        toInt(instance.entryObjectTypeID, 0) || toInt(template && template.entryObjectTypeID, 0) || null,
      dungeonNameID:
        toInt(instance.dungeonNameID, 0) || toInt(template && template.dungeonNameID, 0) || null,
      positionPayload: buildPositionPayload(instance.position, helpers.buildList),
    };
    if (!entriesBySystem.has(solarSystemID)) {
      entriesBySystem.set(solarSystemID, []);
    }
    entriesBySystem.get(solarSystemID).push(record);
    countsBySystem.set(solarSystemID, (countsBySystem.get(solarSystemID) || 0) + 1);
  }

  for (const records of entriesBySystem.values()) {
    records.sort((left, right) => (
      left.instanceID - right.instanceID || left.dungeonID - right.dungeonID
    ));
  }

  const buildEntry = (record) => {
    const fields = [
      ["dungeonID", record.dungeonID],
      ["instanceID", record.instanceID],
      ["siteID", record.instanceID],
      ["archetypeID", record.archetypeID || null],
      ["factionID", record.factionID || null],
      ["difficulty", record.difficulty || 1],
      ["entryObjectTypeID", record.entryObjectTypeID || null],
      ["dungeonNameID", record.dungeonNameID || null],
    ];
    if (record.positionPayload) {
      fields.push(["position", record.positionPayload]);
    }
    return helpers.buildKeyVal(fields);
  };

  const entries = helpers.buildDict(
    [...entriesBySystem.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([solarSystemID, records]) => [
        solarSystemID,
        helpers.buildList(records.map(buildEntry)),
      ]),
  );
  const counts = helpers.buildDict(
    [...countsBySystem.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([solarSystemID, count]) => [solarSystemID, count]),
  );
  return {entries, counts};
}

function buildLiveCombatProjection() {
  const runtimeState = require(RUNTIME_STATE_PATH);
  const authority = require(AUTHORITY_PATH);
  const helpers = require(SERVICE_HELPERS_PATH);
  return buildCombatProjection(
    runtimeState.loadState(),
    (templateID) => authority.getTemplateSelectionDescriptorByID(templateID),
    helpers,
  );
}

function patchDungeonInstanceCacheMgrService(service) {
  const prototype = service && service.prototype;
  if (!prototype || prototype[PATCH_FLAG]) {
    return false;
  }
  if (
    typeof prototype.Handle_GetCombatAnomalyInstances !== "function" ||
    typeof prototype.Handle_GetCombatAnomaliesCount !== "function"
  ) {
    throw new Error("Dungeon instance cache manager does not expose combat anomaly methods");
  }

  const originalGetInstances = prototype.Handle_GetCombatAnomalyInstances;
  const originalGetCount = prototype.Handle_GetCombatAnomaliesCount;
  prototype.Handle_GetCombatAnomalyInstances = function tempPatchesGetCombatAnomalyInstances() {
    try {
      return buildLiveCombatProjection().entries;
    } catch (error) {
      log(`combat anomaly projection failed; using native handler: ${error.message}`);
      return originalGetInstances.call(this);
    }
  };
  prototype.Handle_GetCombatAnomaliesCount = function tempPatchesGetCombatAnomaliesCount() {
    try {
      return buildLiveCombatProjection().counts;
    } catch (error) {
      log(`combat anomaly count projection failed; using native handler: ${error.message}`);
      return originalGetCount.call(this);
    }
  };

  Object.defineProperty(prototype, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  log("combat anomaly cache projection patch installed");
  return true;
}

module.exports = Object.freeze({
  COMBAT_ARCHETYPE_ID,
  patchDungeonInstanceCacheMgrService,
  _testing: Object.freeze({
    ACTIVE_STATES,
    buildCombatProjection,
  }),
});
