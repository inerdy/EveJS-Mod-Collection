"use strict";

function positive(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function createBridgeState() {
  return {
    activeShipOverrides: new Map(),
    activeShipOverrideStacks: new Map(),
    aggressionByShip: new Map(),
    aggressionByCharacter: new Map(),
    hiveShipOwners: new Map(),
    defenseTraceAt: new Map(),
    lastHiveShipPruneAtMs: 0,
  };
}

function withActiveShipOverride(state, characterID, shipRecord, callback) {
  const key = String(positive(characterID));
  let stack = state.activeShipOverrideStacks.get(key);
  if (!stack) {
    stack = [];
    state.activeShipOverrideStacks.set(key, stack);
  }
  const entry = {shipRecord};
  stack.push(entry);
  state.activeShipOverrides.set(key, shipRecord);

  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    const currentStack = state.activeShipOverrideStacks.get(key);
    if (!currentStack) {
      return;
    }
    const entryIndex = currentStack.indexOf(entry);
    if (entryIndex < 0) {
      return;
    }
    currentStack.splice(entryIndex, 1);
    const currentEntry = currentStack[currentStack.length - 1];
    if (currentEntry) {
      state.activeShipOverrides.set(key, currentEntry.shipRecord);
    } else {
      state.activeShipOverrideStacks.delete(key);
      state.activeShipOverrides.delete(key);
    }
  };

  try {
    const result = callback();
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

module.exports = Object.freeze({
  createBridgeState,
  withActiveShipOverride,
});
