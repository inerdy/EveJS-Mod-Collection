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

function buildInlineApproachPoint(originPosition, destinationPosition, distanceFromDestination) {
  const destination = cloneVector(destinationPosition);
  const origin = cloneVector(originPosition, destination);
  const dx = origin.x - destination.x;
  const dy = origin.y - destination.y;
  const dz = origin.z - destination.z;
  const magnitude = Math.hypot(dx, dy, dz);
  const distance = Math.max(0, finite(distanceFromDestination, 0));
  if (magnitude <= 1) {
    return {
      x: destination.x + distance,
      y: destination.y,
      z: destination.z,
    };
  }
  const scale = distance / magnitude;
  return {
    x: destination.x + (dx * scale),
    y: destination.y + (dy * scale),
    z: destination.z + (dz * scale),
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

const GATE_JUMP_LANDING_MIN_METERS = 1000;
const GATE_JUMP_LANDING_MAX_METERS = 2000;
const WARP_EXIT_SCATTER_MIN_METERS = 1000;
const WARP_EXIT_SCATTER_MAX_METERS = 2000;

function clampMeters(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function resolveExitSurfaceMeters(
  chosenSurfaceMeters,
  minSurfaceMeters,
  maxSurfaceMeters,
  seed,
) {
  const minSurface = Math.max(0, finite(minSurfaceMeters, 0));
  const maxSurface = Math.max(minSurface, finite(maxSurfaceMeters, minSurface));
  const chosen = clampMeters(finite(chosenSurfaceMeters, maxSurface), minSurface, maxSurface);
  const scatter = WARP_EXIT_SCATTER_MIN_METERS + (
    unitFraction(`${seed}:exit-scatter`) *
    (WARP_EXIT_SCATTER_MAX_METERS - WARP_EXIT_SCATTER_MIN_METERS)
  );
  const fitting = [chosen - scatter, chosen + scatter].filter((value) => (
    value >= minSurface && value <= maxSurface
  ));
  if (fitting.length === 1) {
    return fitting[0];
  }
  if (fitting.length > 1) {
    return fitting[unitFraction(`${seed}:exit-side`) < 0.5 ? 0 : 1];
  }
  const span = maxSurface - minSurface;
  if (span <= 0) {
    return minSurface;
  }
  return minSurface + (unitFraction(`${seed}:exit-window`) * span);
}

function buildInlineGateExitPoint(
  originPosition,
  gatePosition,
  gateRadius = 0,
  {
    chosenSurfaceMeters = 0,
    minSurfaceMeters = 0,
    maxSurfaceMeters = 0,
    seed = "",
  } = {},
) {
  const surfaceMeters = resolveExitSurfaceMeters(
    chosenSurfaceMeters,
    minSurfaceMeters,
    maxSurfaceMeters,
    seed,
  );
  return buildInlineApproachPoint(
    originPosition,
    gatePosition,
    Math.max(0, finite(gateRadius, 0)) + surfaceMeters,
  );
}

function buildGateJumpLandingPoint(anchor, seed, gateRadius = 0, originPosition = null) {
  return buildInlineGateExitPoint(
    originPosition,
    anchor && anchor.position,
    gateRadius,
    {
      chosenSurfaceMeters: (GATE_JUMP_LANDING_MIN_METERS + GATE_JUMP_LANDING_MAX_METERS) / 2,
      minSurfaceMeters: GATE_JUMP_LANDING_MIN_METERS,
      maxSurfaceMeters: GATE_JUMP_LANDING_MAX_METERS,
      seed: `${seed}:jump-exit`,
    },
  );
}

function distanceSquared(left, right) {
  const a = cloneVector(left);
  const b = cloneVector(right);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function isHaulerProfile(profileID) {
  return String(profileID || "").toLowerCase().includes("hauler");
}

function chooseGateLanding(seed) {
  return unitFraction(`${seed}:gate-landing`) < 0.5 ? "approach" : "jump";
}

function canStartWarp(from, to, minimumMeters = 150000) {
  const minimum = Math.max(0, finite(minimumMeters, 150000));
  return distanceSquared(from, to) >= (minimum * minimum);
}

function isWithinGateJumpRange(position, gatePosition, gateRadius, jumpRangeMeters = 2500) {
  const range = Math.max(0, finite(jumpRangeMeters, 2500));
  const centerDistance = Math.sqrt(distanceSquared(position, gatePosition));
  const surfaceDistance = Math.max(0, centerDistance - Math.max(0, finite(gateRadius, 0)));
  return surfaceDistance <= range;
}

function vectorMagnitude(value) {
  const vector = cloneVector(value);
  return Math.hypot(vector.x, vector.y, vector.z);
}

function unitDot(left, right) {
  const leftMagnitude = vectorMagnitude(left);
  const rightMagnitude = vectorMagnitude(right);
  if (leftMagnitude <= 0 || rightMagnitude <= 0) {
    return 0;
  }
  const a = cloneVector(left);
  const b = cloneVector(right);
  return (
    (a.x * b.x) +
    (a.y * b.y) +
    (a.z * b.z)
  ) / (leftMagnitude * rightMagnitude);
}

const WARP_SCRAMBLER_FAMILY = "warpScrambler";
const WARP_DISRUPTOR_FAMILY = "warpDisruptor";

function listActiveWarpPointFamilies(incomingEffects) {
  const families = [];
  if (!incomingEffects || typeof incomingEffects.values !== "function") {
    return families;
  }
  for (const record of incomingEffects.values()) {
    if (!record || !record.family) {
      continue;
    }
    const rangeMultiplier = Number(record.rangeMultiplier);
    if (!Number.isFinite(rangeMultiplier) || rangeMultiplier <= 0) {
      continue;
    }
    const strength = Number(record.scrambleStrength);
    if (Number.isFinite(strength) && Math.abs(strength) <= 1e-6) {
      continue;
    }
    families.push(String(record.family));
  }
  return families;
}

function shipHasWarpCoreStabilizer(seed) {
  return unitFraction(`${seed}:warp-stab`) < 0.5;
}

function warpDepartureDenial({
  families = [],
  microwarpdriveBlocked = false,
  inBubble = false,
  hasWarpCoreStabilizer = false,
} = {}) {
  if (inBubble) {
    return "bubble";
  }
  const active = Array.isArray(families) ? families : [];
  if (microwarpdriveBlocked === true || active.includes(WARP_SCRAMBLER_FAMILY)) {
    return "scram";
  }
  if (active.includes(WARP_DISRUPTOR_FAMILY) && hasWarpCoreStabilizer !== true) {
    return "disrupt";
  }
  return null;
}

function isWarpEntryReady(entity, targetPoint, minimumSpeedFraction = 0.75) {
  if (!entity || !entity.position || !targetPoint) {
    return false;
  }
  const maxVelocity = Math.max(0, finite(entity.maxVelocity, 0));
  const velocity = cloneVector(entity.velocity);
  const speed = vectorMagnitude(velocity);
  if (maxVelocity <= 0 || (speed / maxVelocity) <= Math.max(0, finite(minimumSpeedFraction, 0.75))) {
    return false;
  }
  const toTarget = {
    x: finite(targetPoint.x, 0) - finite(entity.position.x, 0),
    y: finite(targetPoint.y, 0) - finite(entity.position.y, 0),
    z: finite(targetPoint.z, 0) - finite(entity.position.z, 0),
  };
  return unitDot(velocity, toTarget) >= 0.99;
}

module.exports = {
  GATE_JUMP_LANDING_MAX_METERS,
  GATE_JUMP_LANDING_MIN_METERS,
  WARP_DISRUPTOR_FAMILY,
  WARP_EXIT_SCATTER_MAX_METERS,
  WARP_EXIT_SCATTER_MIN_METERS,
  WARP_SCRAMBLER_FAMILY,
  buildApproachPoint,
  buildGateJumpLandingPoint,
  buildInlineApproachPoint,
  buildInlineGateExitPoint,
  resolveExitSurfaceMeters,
  buildRoutePlan,
  canStartWarp,
  choose,
  chooseGateLanding,
  distanceSquared,
  hashSeed,
  isHaulerProfile,
  isWarpEntryReady,
  isWithinGateJumpRange,
  listActiveWarpPointFamilies,
  listAnchors,
  normalizeAnchor,
  shipHasWarpCoreStabilizer,
  unitFraction,
  warpDepartureDenial,
};
