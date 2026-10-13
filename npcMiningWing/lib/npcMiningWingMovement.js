"use strict";

const DEFAULT_STATION_UNDOCK_DISTANCE_METERS = 8_000;
const LAUNCH_LANE_SEPARATION_METERS = 500;

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function vector(value, fallback) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: finite(source && source.x, fallback.x),
    y: finite(source && source.y, fallback.y),
    z: finite(source && source.z, fallback.z),
  };
}

function normalizedVector(value, fallback) {
  const candidate = vector(value, fallback);
  const length = Math.sqrt(
    candidate.x * candidate.x +
      candidate.y * candidate.y +
      candidate.z * candidate.z,
  );
  if (!Number.isFinite(length) || length < 0.0001) {
    return {...fallback};
  }
  return {
    x: candidate.x / length,
    y: candidate.y / length,
    z: candidate.z / length,
  };
}

function buildStationLaunchSpaceState(runtime, station, ship, index = 0) {
  const stationPosition = vector(station && station.position, {
    x: 0,
    y: 0,
    z: 0,
  });
  const stationDirection = normalizedVector(
    station && (station.undockDirection || station.dockOrientation),
    {x: 1, y: 0, z: 0},
  );
  let hostSpawn = null;
  if (runtime && typeof runtime.getStationUndockSpawnState === "function") {
    try {
      hostSpawn = runtime.getStationUndockSpawnState(station, {
        shipTypeID: positive(ship && ship.typeID),
        selectionKey: positive(ship && ship.itemID),
        selectionStrategy: "hash",
      });
    } catch (_) {
      hostSpawn = null;
    }
  }

  const direction = normalizedVector(
    hostSpawn && hostSpawn.direction,
    stationDirection,
  );
  const fallbackPosition = {
    x: stationPosition.x + direction.x * DEFAULT_STATION_UNDOCK_DISTANCE_METERS,
    y: stationPosition.y + direction.y * DEFAULT_STATION_UNDOCK_DISTANCE_METERS,
    z: stationPosition.z + direction.z * DEFAULT_STATION_UNDOCK_DISTANCE_METERS,
  };
  const basePosition = vector(
    hostSpawn && hostSpawn.position,
    vector(station && station.undockPosition, fallbackPosition),
  );
  const laneIndex = Math.max(0, Math.trunc(Number(index) || 0));

  return {
    systemID: positive(
      station && (station.solarSystemID || station.solarsystemid || station.systemID) ||
        ship && ship.spaceState && ship.spaceState.systemID ||
        ship && ship.locationID,
    ),
    position: {
      x: basePosition.x,
      y: basePosition.y + laneIndex * LAUNCH_LANE_SEPARATION_METERS,
      z: basePosition.z,
    },
    velocity: {x: 0, y: 0, z: 0},
    direction,
    targetPoint: {
      x: basePosition.x,
      y: basePosition.y + laneIndex * LAUNCH_LANE_SEPARATION_METERS,
      z: basePosition.z,
    },
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: 2500,
    orbitDistance: 0,
  };
}

module.exports = Object.freeze({
  buildStationLaunchSpaceState,
});
