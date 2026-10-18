"use strict";

const {
  hashSeed,
  unitFraction,
} = require("./routeEngine");

const MINERAL_GROUP_ID = 18;
const PLANETARY_RESOURCE_CATEGORY_ID = 42;
const PLANETARY_COMMODITY_CATEGORY_ID = 43;
const PLANETARY_CATEGORY_IDS = new Set([
  PLANETARY_RESOURCE_CATEGORY_ID,
  PLANETARY_COMMODITY_CATEGORY_ID,
]);
const PLANETARY_P0_GROUP_IDS = new Set([1032, 1033, 1035]);
const PLANETARY_P1_GROUP_ID = 1042;
const LIMITED_TIME_META_GROUP_IDS = new Set([14, 54]);
const CARGO_FLAG_ID = 5;
const FALLBACK_CAPACITY_M3 = 4800;
const FALLBACK_UNIT_VOLUME_M3 = 0.01;
const HIGH_SEC_MINERAL_TYPE_IDS = Object.freeze([34, 35, 36, 37]);
const KNOWN_MINERAL_TYPES = Object.freeze([
  [34, "Tritanium"],
  [35, "Pyerite"],
  [36, "Mexallon"],
  [37, "Isogen"],
].map(([typeID, name]) => ({
  typeID,
  name,
  groupID: MINERAL_GROUP_ID,
  categoryID: 4,
  volume: FALLBACK_UNIT_VOLUME_M3,
  published: true,
})));
const KNOWN_P0_TYPES = Object.freeze([
  [2073, "Microorganisms", 1035],
  [2267, "Base Metals", 1032],
  [2268, "Aqueous Liquids", 1033],
  [2270, "Noble Metals", 1032],
  [2272, "Heavy Metals", 1032],
  [2286, "Planktic Colonies", 1035],
  [2287, "Complex Organisms", 1035],
  [2288, "Carbon Compounds", 1035],
  [2305, "Autotrophs", 1035],
  [2306, "Non-CS Crystals", 1032],
  [2307, "Felsic Magma", 1032],
  [2308, "Suspended Plasma", 1033],
  [2309, "Ionic Solutions", 1033],
  [2310, "Noble Gas", 1033],
  [2311, "Reactive Gas", 1033],
].map(([typeID, name, groupID]) => ({
  typeID,
  name,
  groupID,
  categoryID: PLANETARY_RESOURCE_CATEGORY_ID,
  volume: FALLBACK_UNIT_VOLUME_M3,
  published: true,
})));
const KNOWN_P1_TYPES = Object.freeze([
  [2393, "Bacteria"],
  [2396, "Biofuels"],
  [2397, "Industrial Fibers"],
  [2398, "Oxidizing Compound"],
  [2399, "Precious Metals"],
  [2400, "Toxic Metals"],
  [2401, "Water"],
  [3645, "Oxygen"],
  [3683, "Proteins"],
  [3693, "Biomass"],
  [3779, "Chiral Structures"],
  [9828, "Silicon"],
].map(([typeID, name]) => ({
  typeID,
  name,
  groupID: PLANETARY_P1_GROUP_ID,
  categoryID: PLANETARY_COMMODITY_CATEGORY_ID,
  volume: FALLBACK_UNIT_VOLUME_M3,
  published: true,
})));
const KNOWN_PLANETARY_TYPES = Object.freeze([
  ...KNOWN_P0_TYPES,
  ...KNOWN_P1_TYPES,
]);
const KNOWN_MINERAL_TYPE_IDS = Object.freeze(KNOWN_MINERAL_TYPES.map((entry) => entry.typeID));
const KNOWN_PLANETARY_TYPE_IDS = Object.freeze(KNOWN_PLANETARY_TYPES.map((entry) => entry.typeID));
const KNOWN_P0_TYPE_IDS = Object.freeze(KNOWN_P0_TYPES.map((entry) => entry.typeID));
const KNOWN_P1_TYPE_IDS = Object.freeze(KNOWN_P1_TYPES.map((entry) => entry.typeID));
const FALLBACK_CARGO_TYPES = Object.freeze([
  ...KNOWN_MINERAL_TYPES,
  ...KNOWN_PLANETARY_TYPES,
]);

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cargoUnitVolume(entry) {
  const volume = finite(entry && entry.volume, 0);
  return volume > 0 ? volume : FALLBACK_UNIT_VOLUME_M3;
}

function isTimeLimitedItem(entry) {
  const metaGroupID = Number(entry && (entry.metaGroupID ?? entry.metaGroupId));
  if (LIMITED_TIME_META_GROUP_IDS.has(metaGroupID)) {
    return true;
  }
  const labels = [
    entry && entry.metaGroupName,
    entry && entry.name,
  ].map((value) => String(value || "").toLowerCase());
  return labels.some((label) => (
    /\blimited[-\s]?time\b/.test(label) ||
    /\bexpired\b/.test(label) ||
    /\bevent crate\b/.test(label)
  ));
}

function isPublishedCargoType(entry) {
  return Boolean(
    entry &&
    Number(entry.typeID) > 0 &&
    String(entry.name || "").trim() &&
    entry.published !== false &&
    !isTimeLimitedItem(entry),
  );
}

function isHighSecMineral(entry) {
  return Boolean(
    Number(entry && entry.groupID) === MINERAL_GROUP_ID &&
    HIGH_SEC_MINERAL_TYPE_IDS.includes(Number(entry && entry.typeID)),
  );
}

function isPlanetaryP0(entry) {
  const typeID = Number(entry && entry.typeID);
  const groupID = Number(entry && entry.groupID);
  const categoryID = Number(entry && entry.categoryID);
  return Boolean(
    KNOWN_P0_TYPE_IDS.includes(typeID) ||
    (
      categoryID === PLANETARY_RESOURCE_CATEGORY_ID &&
      PLANETARY_P0_GROUP_IDS.has(groupID)
    ),
  );
}

function isPlanetaryP1(entry) {
  const typeID = Number(entry && entry.typeID);
  const groupID = Number(entry && entry.groupID);
  return Boolean(
    KNOWN_P1_TYPE_IDS.includes(typeID) ||
    groupID === PLANETARY_P1_GROUP_ID,
  );
}

function isPlanetaryP0OrP1(entry) {
  return isPlanetaryP0(entry) || isPlanetaryP1(entry);
}

function dedupeCargoTypes(entries) {
  const seen = new Set();
  const deduped = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const typeID = Number(entry && entry.typeID);
    if (!isPublishedCargoType(entry) || seen.has(typeID)) {
      continue;
    }
    seen.add(typeID);
    deduped.push(entry);
  }
  return deduped;
}

function listCargoTypes(itemTypes = []) {
  const types = Array.isArray(itemTypes) ? itemTypes : [];
  return {
    minerals: dedupeCargoTypes(types.filter(isHighSecMineral)),
    planetary: dedupeCargoTypes(types.filter(isPlanetaryP0OrP1)),
  };
}

function mergeKnownCargoTypes(catalog, resolvedTypes = []) {
  const extra = listCargoTypes(resolvedTypes);
  return {
    minerals: dedupeCargoTypes([
      ...(catalog && catalog.minerals || []),
      ...extra.minerals,
    ]),
    planetary: dedupeCargoTypes([
      ...(catalog && catalog.planetary || []),
      ...extra.planetary,
    ]),
  };
}

function resolveCargoCapacityM3(values, fallback = FALLBACK_CAPACITY_M3) {
  const sources = Array.isArray(values) ? values : [];
  for (const value of sources) {
    const capacity = finite(value, 0);
    if (capacity > 0) {
      return capacity;
    }
  }
  return Math.max(0, finite(fallback, FALLBACK_CAPACITY_M3));
}

function pickTypes(types, count, seed) {
  const entries = Array.isArray(types) ? types.filter(isPublishedCargoType) : [];
  const sorted = [...entries].sort((left, right) => (
    hashSeed(`${seed}:${left.typeID}`) - hashSeed(`${seed}:${right.typeID}`)
  ));
  return sorted.slice(0, Math.max(0, Math.min(sorted.length, count)));
}

function allocateStacks(types, volumeM3, seed, typeCount = null) {
  const budget = Math.max(0, finite(volumeM3, 0));
  if (budget <= 0) {
    return [];
  }
  const count = typeCount === null
    ? 2 + (hashSeed(`${seed}:count`) % 3)
    : Math.max(1, Math.trunc(finite(typeCount, 1)));
  const picked = pickTypes(types, count, seed);
  if (picked.length === 0) {
    return [];
  }
  const weights = picked.map((_entry, index) => 0.25 + unitFraction(`${seed}:weight:${index}`));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const stacks = [];
  for (let index = 0; index < picked.length; index += 1) {
    const entry = picked[index];
    const unitVolume = cargoUnitVolume(entry);
    const quantity = Math.floor((budget * (weights[index] / weightSum)) / unitVolume);
    if (quantity <= 0) {
      continue;
    }
    stacks.push({
      typeID: Number(entry.typeID),
      groupID: Number(entry.groupID) || 0,
      categoryID: Number(entry.categoryID) || 0,
      itemName: String(entry.name || `type ${entry.typeID}`),
      volume: unitVolume,
      quantity,
      flagID: CARGO_FLAG_ID,
    });
  }
  return stacks;
}

function buildHaulerCargo({
  seed,
  capacityM3,
  mineralTypes = [],
  planetaryTypes = [],
} = {}) {
  const capacity = Math.max(0, finite(capacityM3, 0));
  if (capacity <= 0) {
    return [];
  }
  const fillFraction = 0.25 + (unitFraction(`${seed}:fill`) * 0.7);
  const filledVolume = capacity * fillFraction;
  const minerals = mineralTypes.filter(isHighSecMineral);
  const planetary = planetaryTypes.filter(isPlanetaryP0OrP1);
  if (minerals.length === 0 && planetary.length === 0) {
    return [];
  }
  if (planetary.length === 0 || (minerals.length > 0 && unitFraction(`${seed}:kind`) < 0.5)) {
    const mineralCount = 1 + (hashSeed(`${seed}:mineral-count`) % 2);
    return allocateStacks(minerals, filledVolume, `${seed}:minerals`, mineralCount);
  }
  return allocateStacks(planetary, filledVolume, `${seed}:planetary`);
}

const WRECK_HANGAR_FLAG_ID = 4;

function buildWreckLootRecord(wreck, stack, wreckItemID) {
  const quantity = Math.max(1, Math.trunc(finite(stack && stack.quantity, 0)));
  return {
    wreckItemID: Math.trunc(Number(wreckItemID) || 0),
    wreckID: Math.trunc(Number(wreck && wreck.wreckID) || 0),
    ownerID: Math.trunc(Number(wreck && wreck.ownerID) || 0),
    locationID: Math.trunc(Number(wreck && wreck.wreckID) || 0),
    flagID: WRECK_HANGAR_FLAG_ID,
    typeID: Math.trunc(Number(stack && stack.typeID) || 0),
    groupID: Math.trunc(Number(stack && stack.groupID) || 0),
    categoryID: Math.trunc(Number(stack && stack.categoryID) || 0),
    itemName: String(stack && stack.itemName || "Item"),
    quantity,
    singleton: false,
    customInfo: "",
    sourceKind: "cargo",
    moduleID: 0,
    volume: cargoUnitVolume(stack),
    transient: Boolean(wreck && wreck.transient === true),
  };
}

function cargoVolumeM3(stacks) {
  return (Array.isArray(stacks) ? stacks : []).reduce((sum, stack) => (
    sum + (Math.max(0, finite(stack && stack.quantity, 0)) * Math.max(0, finite(stack && stack.volume, 0)))
  ), 0);
}

module.exports = {
  CARGO_FLAG_ID,
  FALLBACK_CAPACITY_M3,
  FALLBACK_UNIT_VOLUME_M3,
  FALLBACK_CARGO_TYPES,
  HIGH_SEC_MINERAL_TYPE_IDS,
  KNOWN_MINERAL_TYPE_IDS,
  KNOWN_P0_TYPE_IDS,
  KNOWN_P1_TYPE_IDS,
  KNOWN_PLANETARY_TYPE_IDS,
  MINERAL_GROUP_ID,
  PLANETARY_CATEGORY_IDS,
  PLANETARY_P0_GROUP_IDS,
  PLANETARY_P1_GROUP_ID,
  WRECK_HANGAR_FLAG_ID,
  buildHaulerCargo,
  buildWreckLootRecord,
  cargoUnitVolume,
  cargoVolumeM3,
  isHighSecMineral,
  isPlanetaryP0OrP1,
  isTimeLimitedItem,
  listCargoTypes,
  mergeKnownCargoTypes,
  resolveCargoCapacityM3,
};
