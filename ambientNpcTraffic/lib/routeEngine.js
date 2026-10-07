"use strict";

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(value, fallback = {x: 0, y: 0, z: 0}) {
  return {
    x: finite(value && value.x, fallback.x),
    y: finite(value && value.y, fallback.y),
    z: finite(value && value.z, fallback.z),
  };
}

function hashSeed(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unitFraction(value) {
  return (hashSeed(value) % 1000000) / 1000000;
}

function choose(values, seed) {
  const entries = Array.isArray(values) ? values.filter(Boolean) : [];
  if (entries.length <= 0) {
    return null;
  }
  return entries[hashSeed(seed) % entries.length];
}

function normalizeAnchor(entity) {
  const itemID = toPositiveInt(entity && entity.itemID, 0);
  if (!itemID || !entity || !entity.position) {
    return null;
  }
  return {
    itemID,
    kind: String(entity.kind || "").trim().toLowerCase(),
    itemName: String(entity.itemName || entity.slimName || "Anchor"),
    position: cloneVector(entity.position),
    destinationID: toPositiveInt(entity.destinationID, 0),
    destinationSolarSystemID: toPositiveInt(entity.destinationSolarSystemID, 0),
  };
}

function listAnchors(staticEntities) {
  const entities = Array.isArray(staticEntities) ? staticEntities : [];
  const normalized = entities.map(normalizeAnchor).filter(Boolean);
  const stations = normalized.filter((entry) => entry.kind === "station");
  const gates = normalized.filter((entry) => entry.kind === "stargate");
  const planets = normalized.filter((entry) => entry.kind === "planet");
  const fallback = normalized.filter((entry) => (
    entry.kind === "moon" || entry.kind === "asteroidbelt" || entry.kind === "celestial"
  ));
  return {
    all: normalized,
    stations,
    gates,
    planets,
    fallback,
  };
}

function chooseOriginAnchor(anchors, seed) {
  return choose(
    anchors.stations.length > 0
      ? anchors.stations
      : anchors.gates.length > 0
        ? anchors.gates
        : anchors.planets.length > 0
          ? anchors.planets
          : anchors.fallback.length > 0
            ? anchors.fallback
            : anchors.all,
    `${seed}:origin`,
  );
}

function chooseLocalDestination(anchors, origin, seed) {
  const candidates = (anchors.stations.length > 0
    ? anchors.stations
    : anchors.gates.length > 0
      ? anchors.gates
      : anchors.planets.length > 0
        ? anchors.planets
        : anchors.all
  ).filter((entry) => entry.itemID !== toPositiveInt(origin && origin.itemID, 0));
  return choose(candidates.length > 0 ? candidates : [origin], `${seed}:local-destination`);
}

function chooseTransitGate(anchors, seed) {
  return choose(
    anchors.gates.filter((entry) => entry.destinationSolarSystemID > 0 && entry.destinationID > 0),
    `${seed}:transit-gate`,
  );
}

function buildRoutePlan({systemID, staticEntities, seed, crossSystemChance = 0.35}) {
  const numericSystemID = toPositiveInt(systemID, 0);
  const anchors = listAnchors(staticEntities);
  const origin = chooseOriginAnchor(anchors, seed);
  if (!origin) {
    return null;
  }

  const gate = chooseTransitGate(anchors, seed);
  const useTransit = Boolean(
    gate &&
    gate.destinationSolarSystemID !== numericSystemID &&
    unitFraction(`${seed}:cross-system`) < Math.max(0, Math.min(1, Number(crossSystemChance) || 0)),
  );
  const destination = useTransit
    ? gate
    : chooseLocalDestination(anchors, origin, seed);

  return {
    routeKind: useTransit ? "cross-system" : "local",
    systemID: numericSystemID,
    currentAnchorID: origin.itemID,
    currentAnchorName: origin.itemName,
    destinationAnchorID: destination ? destination.itemID : origin.itemID,
    destinationAnchorName: destination ? destination.itemName : origin.itemName,
    destinationSystemID: useTransit
      ? gate.destinationSolarSystemID
      : numericSystemID,
    destinationGateID: useTransit ? gate.destinationID : 0,
  };
}

function buildApproachPoint(anchor, seed, distanceMeters) {
  const origin = cloneVector(anchor && anchor.position);
  const angle = unitFraction(`${seed}:angle`) * Math.PI * 2;
  const elevation = (unitFraction(`${seed}:elevation`) * 2) - 1;
  const planarScale = Math.sqrt(Math.max(0, 1 - (elevation * elevation)));
  const distance = Math.max(1000, finite(distanceMeters, 10000));
  return {
    x: origin.x + (Math.cos(angle) * planarScale * distance),
    y: origin.y + (elevation * distance),
    z: origin.z + (Math.sin(angle) * planarScale * distance),
  };
}

function distanceSquared(left, right) {
  const a = cloneVector(left);
  const b = cloneVector(right);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

module.exports = {
  buildApproachPoint,
  buildRoutePlan,
  choose,
  distanceSquared,
  hashSeed,
  listAnchors,
  normalizeAnchor,
  unitFraction,
};
