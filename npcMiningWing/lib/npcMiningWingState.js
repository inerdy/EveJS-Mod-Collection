"use strict";

const MAX_RUNTIME_FAILURE_BACKOFF_MS = 10_000;
const MIN_RUNTIME_FAILURE_BACKOFF_MS = 1_000;
const RUNTIME_FAILURE_LOG_INTERVAL_MS = 5_000;

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function markCollectionUnavailableStates(character, now = Date.now(), retryMs = 1_000) {
  if (!character || !character.miningShipStates || typeof character.miningShipStates !== "object") {
    return false;
  }
  const collectionShipID = positive(character.collectionShipID);
  const deployedShipIDs = Array.isArray(character.deployedShipIDs)
    ? character.deployedShipIDs.map(positive).filter(Boolean)
    : [];
  let changed = false;
  for (const shipID of deployedShipIDs) {
    if (shipID === collectionShipID) {
      continue;
    }
    const miningState = character.miningShipStates[String(shipID)];
    if (!miningState || typeof miningState !== "object") {
      continue;
    }
    const nextCycleAtMs = now + Math.max(1, Number(retryMs) || 1_000);
    if (
      miningState.status !== "cargo-waiting" ||
      miningState.lastError !== "NPC_WING_COLLECTION_UNAVAILABLE" ||
      Number(miningState.nextCycleAtMs) <= now
    ) {
      miningState.status = "cargo-waiting";
      miningState.lastError = "NPC_WING_COLLECTION_UNAVAILABLE";
      miningState.nextCycleAtMs = nextCycleAtMs;
      changed = true;
    }
  }
  return changed;
}

function stripRuntimeMiningDeadlines(miningShipStates) {
  for (const miningState of Object.values(miningShipStates || {})) {
    if (miningState && typeof miningState === "object") {
      // This is a runtime scheduler deadline, not recovery state. Persisting
      // it causes the 500 ms ticker to rewrite the file continuously.
      delete miningState.nextCycleAtMs;
    }
  }
}

function serializePersistentMiningStates(miningShipStates) {
  const snapshot = JSON.parse(JSON.stringify(miningShipStates || {}));
  stripRuntimeMiningDeadlines(snapshot);
  return JSON.stringify(snapshot);
}

function serializePersistentState(state) {
  const snapshot = JSON.parse(JSON.stringify(state || {}));
  for (const character of Object.values(snapshot.characters || {})) {
    if (!character || !character.miningShipStates) {
      continue;
    }
    stripRuntimeMiningDeadlines(character.miningShipStates);
  }
  return JSON.stringify(snapshot, null, 2);
}

function deferCollectionTrip(
  trip,
  now = Date.now(),
  retryMs = 4_000,
  errorCode = "NPC_WING_COLLECTION_RETURN_PENDING",
) {
  if (!trip || typeof trip !== "object") {
    return false;
  }
  trip.failureCount = Math.max(0, Number(trip.failureCount) || 0) + 1;
  trip.lastError = String(errorCode || "NPC_WING_COLLECTION_RETURN_PENDING");
  trip.readyAtMs = now + Math.max(1, Number(retryMs) || 4_000);
  return true;
}

function clearCollectionTripRetry(trip) {
  if (!trip || typeof trip !== "object") {
    return false;
  }
  const changed =
    Number(trip.failureCount) !== 0 ||
    String(trip.lastError || "") !== "";
  trip.failureCount = 0;
  trip.lastError = "";
  return changed;
}

function nextRuntimeFailure(previous, error, now = Date.now()) {
  const previousFailure = previous && typeof previous === "object" ? previous : {};
  const count = Math.max(0, Number(previousFailure.count) || 0) + 1;
  const backoffMs = Math.min(
    MAX_RUNTIME_FAILURE_BACKOFF_MS,
    Math.max(
      MIN_RUNTIME_FAILURE_BACKOFF_MS,
      MIN_RUNTIME_FAILURE_BACKOFF_MS * (2 ** Math.min(count - 1, 4)),
    ),
  );
  const message = String(error && error.message || error || "Unknown runtime failure");
  const lastLoggedAtMs = Math.max(0, Number(previousFailure.lastLoggedAtMs) || 0);
  const shouldLog =
    !previousFailure.message ||
    previousFailure.message !== message ||
    now - lastLoggedAtMs >= RUNTIME_FAILURE_LOG_INTERVAL_MS;
  return {
    count,
    message,
    nextRetryAtMs: now + backoffMs,
    lastLoggedAtMs: shouldLog ? now : lastLoggedAtMs,
    shouldLog,
    backoffMs,
  };
}

function runtimeFailureIsCoolingDown(failure, now = Date.now()) {
  return Boolean(
    failure &&
    Number(failure.nextRetryAtMs) > now,
  );
}

function miningHandoffIsReady(miningState, now = Date.now()) {
  const nextCycleAtMs = Math.max(
    0,
    Number(miningState && miningState.nextCycleAtMs) || 0,
  );
  return nextCycleAtMs <= now;
}

module.exports = Object.freeze({
  clearCollectionTripRetry,
  deferCollectionTrip,
  markCollectionUnavailableStates,
  miningHandoffIsReady,
  nextRuntimeFailure,
  serializePersistentMiningStates,
  runtimeFailureIsCoolingDown,
  serializePersistentState,
});
