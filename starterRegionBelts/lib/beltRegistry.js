"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "belts.json");
const CONFIG = Object.freeze(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
const STATIC_ASTEROID_ITEM_ID_BASE = 5_000_000_000_000;
const STATIC_ASTEROID_ITEM_ID_STRIDE = 512;
let worldData = null;

function getWorldData() {
  if (!worldData) {
    worldData = require(path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "server",
      "src",
      "space",
      "worldData",
    ));
  }
  return worldData;
}

function positive(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return number > 0 ? number : fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function vector(value, fallback = {x: 0, y: 0, z: 0}) {
  return {
    x: finite(value && value.x, fallback.x),
    y: finite(value && value.y, fallback.y),
    z: finite(value && value.z, fallback.z),
  };
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnitVector(seed) {
  const first = hashText(`${seed}:theta`) / 0xffffffff;
  const second = hashText(`${seed}:z`) / 0xffffffff;
  const theta = first * Math.PI * 2;
  const z = (second * 2) - 1;
  const radial = Math.sqrt(Math.max(0, 1 - (z * z)));
  return {
    x: radial * Math.cos(theta),
    y: radial * Math.sin(theta),
    z,
  };
}

function addScaledVector(origin, direction, distance) {
  return {
    x: origin.x + (direction.x * distance),
    y: origin.y + (direction.y * distance),
    z: origin.z + (direction.z * distance),
  };
}

function beltIDForSystem(systemID) {
  return positive(CONFIG.beltIDBase) + positive(systemID);
}

function chooseAnchor(system) {
  // Read the native celestial map directly while the registry is being built.
  // The loader also exposes custom belts through getCelestialsForSystem(), so
  // calling that public wrapper here would recursively rebuild the registry.
  const world = getWorldData();
  const loaded = world.ensureLoaded();
  const celestials = (loaded.celestialsBySystem.get(system.solarSystemID) || [])
    .filter(Boolean);
  return celestials.find((entry) => (
    String(entry.kind || "").toLowerCase() === "planet"
  )) || celestials.find((entry) => (
    String(entry.kind || "").toLowerCase() !== "sun" && Number(entry.groupID) !== 6
  )) || celestials[0] || null;
}

function buildBelt(system) {
  const systemID = positive(system && system.solarSystemID);
  const beltID = beltIDForSystem(systemID);
  const anchor = chooseAnchor(system) || {};
  const anchorPosition = vector(anchor.position || system.position);
  const direction = seededUnitVector(systemID);
  const placementDistance = Math.max(
    100000,
    finite(CONFIG.placementDistanceMeters, 1000000),
  );
  const security = finite(system.security, finite(system.securityStatus, 1));
  const systemName = String(
    system.solarSystemName || `System ${systemID}`,
  );

  return {
    itemID: beltID,
    typeID: 15,
    groupID: 9,
    categoryID: 2,
    groupName: "Asteroid Belt",
    solarSystemID: systemID,
    constellationID: positive(system.constellationID),
    regionID: positive(system.regionID, positive(CONFIG.regionID)),
    orbitID: positive(anchor.itemID, systemID),
    position: addScaledVector(anchorPosition, direction, placementDistance),
    radius: 30000,
    itemName: `${systemName} - ${CONFIG.itemNameSuffix}`,
    security,
    securityClass: "B",
    celestialIndex: positive(anchor.celestialIndex, 1),
    orbitIndex: 1,
    kind: "asteroidBelt",
    fieldSeed: beltID,
    fieldStyleID: String(CONFIG.fieldStyleID || "empire_highsec_standard"),
    asteroidCount: positive(CONFIG.asteroidCount, 24),
    clusterCount: positive(CONFIG.clusterCount, 4),
    fieldRadiusMeters: Math.max(12000, finite(CONFIG.fieldRadiusMeters, 32000)),
    clusterRadiusMeters: Math.max(2500, finite(CONFIG.clusterRadiusMeters, 6000)),
    verticalSpreadMeters: Math.max(900, finite(CONFIG.verticalSpreadMeters, 4000)),
    largeAsteroidCount: positive(CONFIG.largeAsteroidCount, 1),
    generatedBy: "starterRegionBelts",
  };
}

function buildRegistry() {
  const systems = getWorldData()
    .getSolarSystems()
    .filter((system) => Number(system.regionID) === positive(CONFIG.regionID))
    .sort((left, right) => positive(left.solarSystemID) - positive(right.solarSystemID));
  const belts = systems.map(buildBelt);
  const bySystem = new Map();
  const byID = new Map();
  for (const belt of belts) {
    bySystem.set(belt.solarSystemID, belt);
    byID.set(belt.itemID, belt);
  }
  return Object.freeze({
    systems,
    belts,
    bySystem,
    byID,
  });
}

let registry = null;

function ensureRegistry() {
  if (!registry) {
    registry = buildRegistry();
  }
  return registry;
}

function getTargetSystemIDs() {
  return ensureRegistry().systems.map((system) => positive(system.solarSystemID));
}

function getBeltsForSystem(systemID) {
  const belt = ensureRegistry().bySystem.get(positive(systemID));
  return belt ? [clone(belt)] : [];
}

function getAllBelts() {
  return ensureRegistry().belts.map(clone);
}

function getBeltByID(itemID) {
  const belt = ensureRegistry().byID.get(positive(itemID));
  return belt ? clone(belt) : null;
}

function mergeBelts(nativeBelts, customBelts) {
  const merged = [];
  const seen = new Set();
  for (const belt of [...(Array.isArray(nativeBelts) ? nativeBelts : []), ...customBelts]) {
    const itemID = positive(belt && belt.itemID);
    if (!itemID || seen.has(itemID)) {
      continue;
    }
    seen.add(itemID);
    merged.push(belt);
  }
  return merged;
}

function buildAsteroidItemID(beltID, asteroidIndex) {
  return (
    STATIC_ASTEROID_ITEM_ID_BASE +
    (positive(beltID) * STATIC_ASTEROID_ITEM_ID_STRIDE) +
    positive(asteroidIndex)
  );
}

function buildLocationRow(belt) {
  return [
    positive(belt.itemID),
    belt.itemName,
    positive(belt.solarSystemID),
    finite(belt.position && belt.position.x),
    finite(belt.position && belt.position.y),
    finite(belt.position && belt.position.z),
    null,
  ];
}

function extractList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "list" &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  return [];
}

function augmentLocationTuple(result, args) {
  if (!Array.isArray(result) || result.length < 2 || !Array.isArray(result[1])) {
    return result;
  }
  const requestedIDs = extractList(args && args.length > 0 ? args[0] : null)
    .map(positive)
    .filter(Boolean);
  if (requestedIDs.length <= 0) {
    return result;
  }
  const rows = result[1].slice();
  const rowIndexByID = new Map();
  rows.forEach((row, index) => {
    const rowID = positive(row && row[0]);
    if (rowID && !rowIndexByID.has(rowID)) {
      rowIndexByID.set(rowID, index);
    }
  });
  for (const itemID of requestedIDs) {
    const belt = ensureRegistry().byID.get(itemID);
    if (!belt) {
      continue;
    }
    const locationRow = buildLocationRow(belt);
    if (rowIndexByID.has(itemID)) {
      rows[rowIndexByID.get(itemID)] = locationRow;
    } else {
      rowIndexByID.set(itemID, rows.length);
      rows.push(locationRow);
    }
  }
  return [result[0], rows];
}

module.exports = Object.freeze({
  CONFIG,
  STATIC_ASTEROID_ITEM_ID_BASE,
  STATIC_ASTEROID_ITEM_ID_STRIDE,
  augmentLocationTuple,
  buildAsteroidItemID,
  buildBelt,
  getAllBelts,
  getBeltsForSystem,
  getBeltByID,
  getTargetSystemIDs,
  mergeBelts,
  _testing: Object.freeze({
    buildRegistry,
    chooseAnchor,
    seededUnitVector,
  }),
});
