"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_VERSION = 3;

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    lastTickAtMs: 0,
    cursorByStation: {},
    managedOrderIDs: [],
    createdOrders: 0,
    replacedOrders: 0,
    skippedItems: 0,
    marketStartedAt: "",
    fuelSeedByStation: {},
    lastError: "",
  };
}

function normalizeState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const cursors = source.cursorByStation && typeof source.cursorByStation === "object"
    ? source.cursorByStation
    : {};
  const cursorByStation = {};
  for (const [key, cursor] of Object.entries(cursors)) {
    cursorByStation[String(key)] = Math.max(0, Math.trunc(Number(cursor) || 0));
  }
  const managedOrderIDs = [...new Set(
    (Array.isArray(source.managedOrderIDs) ? source.managedOrderIDs : [])
      .map((orderID) => String(orderID || "").trim())
      .filter((orderID) => /^\d+$/.test(orderID) && BigInt(orderID) > 0n),
  )];
  const fuelSeedByStation = {};
  const sourceFuelSeeds = source.fuelSeedByStation && typeof source.fuelSeedByStation === "object"
    ? source.fuelSeedByStation
    : {};
  for (const [stationID, value] of Object.entries(sourceFuelSeeds)) {
    if (!/^\d+$/.test(String(stationID)) || !value || typeof value !== "object") continue;
    fuelSeedByStation[String(stationID)] = {
      orderID: String(value.orderID || "").trim(),
      seededAtMs: Math.max(0, Number(value.seededAtMs) || 0),
      price: Math.max(0, Number(value.price) || 0),
      quantity: Math.max(0, Math.trunc(Number(value.quantity) || 0)),
    };
  }
  return {
    schemaVersion: STATE_VERSION,
    lastTickAtMs: Math.max(0, Number(source.lastTickAtMs) || 0),
    cursorByStation,
    managedOrderIDs,
    createdOrders: Math.max(0, Math.trunc(Number(source.createdOrders) || 0)),
    replacedOrders: Math.max(0, Math.trunc(Number(source.replacedOrders) || 0)),
    skippedItems: Math.max(0, Math.trunc(Number(source.skippedItems) || 0)),
    marketStartedAt: String(source.marketStartedAt || ""),
    fuelSeedByStation,
    lastError: String(source.lastError || ""),
  };
}

function createStateStore(filePath) {
  const resolvedPath = path.resolve(filePath);
  return Object.freeze({
    filePath: resolvedPath,
    load() {
      try {
        return normalizeState(JSON.parse(fs.readFileSync(resolvedPath, "utf8")));
      } catch (error) {
        if (error && error.code !== "ENOENT") throw error;
        return defaultState();
      }
    },
    save(value) {
      const normalized = normalizeState(value);
      fs.mkdirSync(path.dirname(resolvedPath), {recursive: true});
      fs.writeFileSync(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      return normalized;
    },
  });
}

module.exports = {STATE_VERSION, createStateStore, defaultState, normalizeState};
