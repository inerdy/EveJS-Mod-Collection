"use strict";

function toPositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashUnit(value) {
  return hashString(value) / 4294967296;
}

function addEdge(graph, sourceSystemID, destinationSystemID) {
  const source = toPositiveInteger(sourceSystemID, 0);
  const destination = toPositiveInteger(destinationSystemID, 0);
  if (!source || !destination || source === destination) {
    return;
  }
  if (!graph.has(source)) {
    graph.set(source, new Set());
  }
  if (!graph.has(destination)) {
    graph.set(destination, new Set());
  }
  graph.get(source).add(destination);
  graph.get(destination).add(source);
}

function buildGraph(stargates = []) {
  const graph = new Map();
  for (const stargate of Array.isArray(stargates) ? stargates : []) {
    addEdge(
      graph,
      stargate && stargate.solarSystemID,
      stargate && stargate.destinationSolarSystemID,
    );
  }
  return graph;
}

function shortestJumpDistance(graph, sourceSystemID, destinationSystemID) {
  const source = toPositiveInteger(sourceSystemID, 0);
  const destination = toPositiveInteger(destinationSystemID, 0);
  if (!source || !destination) {
    return null;
  }
  if (source === destination) {
    return 0;
  }
  const visited = new Set([source]);
  const queue = [{systemID: source, distance: 0}];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const neighbor of graph.get(current.systemID) || []) {
      if (visited.has(neighbor)) {
        continue;
      }
      const distance = current.distance + 1;
      if (neighbor === destination) {
        return distance;
      }
      visited.add(neighbor);
      queue.push({systemID: neighbor, distance});
    }
  }
  return null;
}

function securityClass(securityLevel) {
  const security = Number(securityLevel);
  if (!Number.isFinite(security)) {
    return "null";
  }
  if (security >= 0.5) {
    return "high";
  }
  if (security >= 0) {
    return "low";
  }
  return "null";
}

function listEligibleStations(stations, allowedSecurityClasses = ["high"]) {
  const allowed = new Set(Array.isArray(allowedSecurityClasses) ? allowedSecurityClasses : ["high"]);
  return (Array.isArray(stations) ? stations : [])
    .filter((station) => {
      const stationID = toPositiveInteger(station && station.stationID, 0);
      const systemID = toPositiveInteger(station && station.solarSystemID, 0);
      return stationID > 0 && systemID > 0 && allowed.has(securityClass(station.security));
    })
    .map((station) => ({
      stationID: toPositiveInteger(station.stationID, 0),
      stationName: String(station.stationName || station.itemName || `Station ${station.stationID}`),
      solarSystemID: toPositiveInteger(station.solarSystemID, 0),
      solarSystemName: String(station.solarSystemName || `System ${station.solarSystemID}`),
      security: Number(station.security),
      securityClass: securityClass(station.security),
      corporationID: toPositiveInteger(station.corporationID, 0),
    }))
    .sort((left, right) => left.stationID - right.stationID);
}

function resolveHubStations(stationsByID, stationIDs = []) {
  const result = [];
  const seen = new Set();
  for (const stationID of Array.isArray(stationIDs) ? stationIDs : []) {
    const numericID = toPositiveInteger(stationID, 0);
    const station = stationsByID.get(numericID);
    if (!station || seen.has(numericID)) {
      continue;
    }
    seen.add(numericID);
    result.push(station);
  }
  return result;
}

function selectDestination({
  origin,
  establishedStations = [],
  eligibleStations = [],
  graph,
  seed,
  hubDestinationWeight = 0.7,
  shortHaulChance = 0,
  shortHaulMaxJumps = 5,
}) {
  if (!origin || !graph) {
    return null;
  }
  const originID = toPositiveInteger(origin.stationID, 0);
  const establishedIDs = new Set(
    establishedStations.map((station) => toPositiveInteger(station && station.stationID, 0)),
  );
  const established = establishedStations.filter((station) => (
    station && toPositiveInteger(station.stationID, 0) !== originID
  ));
  const expansion = eligibleStations.filter((station) => (
    station &&
    toPositiveInteger(station.stationID, 0) !== originID &&
    !establishedIDs.has(toPositiveInteger(station.stationID, 0))
  ));
  const preferEstablished = hashUnit(`${seed}:destination-pool`) < Math.max(0, Math.min(1, Number(hubDestinationWeight) || 0));
  const firstPool = preferEstablished ? established : expansion;
  const secondPool = preferEstablished ? expansion : established;
  const pools = [firstPool, secondPool];
  const useShortHaul =
    hashUnit(`${seed}:short-haul`) < Math.max(0, Math.min(1, Number(shortHaulChance) || 0));
  const maximumShortHaulJumps = Math.max(1, Math.trunc(Number(shortHaulMaxJumps) || 5));

  for (const pool of pools) {
    const candidates = pool
      .map((station) => ({
        station,
        jumps: shortestJumpDistance(graph, origin.solarSystemID, station.solarSystemID),
      }))
      .filter((entry) => entry.jumps !== null && entry.jumps > 0)
      .sort((left, right) => left.station.stationID - right.station.stationID);
    const selectedCandidates = useShortHaul
      ? candidates.filter((entry) => entry.jumps <= maximumShortHaulJumps)
      : candidates;
    if (selectedCandidates.length > 0) {
      const index = Math.floor(hashUnit(`${seed}:destination`) * selectedCandidates.length);
      return selectedCandidates[Math.min(index, selectedCandidates.length - 1)];
    }
  }
  return null;
}

module.exports = {
  buildGraph,
  hashString,
  hashUnit,
  listEligibleStations,
  resolveHubStations,
  securityClass,
  selectDestination,
  shortestJumpDistance,
};
