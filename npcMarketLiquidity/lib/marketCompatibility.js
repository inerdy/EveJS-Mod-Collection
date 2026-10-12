"use strict";

const NPC_PASSIVE_SOURCE = "npc-passive";
const PLAYER_SOURCE = "player";
const managedOrderIDs = new Set();

function normalizedOrderID(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && BigInt(text) > 0n ? text : "";
}

function registerManagedOrderID(value) {
  const orderID = normalizedOrderID(value);
  if (orderID) managedOrderIDs.add(orderID);
  return orderID;
}

function unregisterManagedOrderID(value) {
  const orderID = normalizedOrderID(value);
  if (orderID) managedOrderIDs.delete(orderID);
}

function replaceManagedOrderIDs(orders) {
  managedOrderIDs.clear();
  for (const order of Array.isArray(orders) ? orders : []) {
    registerManagedOrderID(order && order.order_id);
  }
  return [...managedOrderIDs];
}

function normalizeOwnerOrders(result) {
  if (!Array.isArray(result)) throw new Error("Invalid GetOwnerOrders response");
  return result.map((order) => ({...order.row, ...order}));
}

function createCompatibleCall(originalCall) {
  return async function compatibleCall(method, params, options) {
    const result = await originalCall(method, params, options);
    if (method !== "GetOrders" || !result || typeof result !== "object") return result;

    // Old daemons store these reserved NPC orders with source "player".
    // Rewrite only IDs from the mod's once-per-tick ownership snapshot; never
    // make an additional GetOwnerOrders RPC on a market-book request.
    const rewrite = (rows) => (Array.isArray(rows) ? rows : []).map((row) => (
      row &&
      managedOrderIDs.has(normalizedOrderID(row.order_id)) &&
      String(row.source || "").toLowerCase() === PLAYER_SOURCE
        ? {...row, source: NPC_PASSIVE_SOURCE}
        : row
    ));
    const compatibleResult = {...result};
    if (Array.isArray(result.sells)) compatibleResult.sells = rewrite(result.sells);
    if (Array.isArray(result.buys)) compatibleResult.buys = rewrite(result.buys);
    return compatibleResult;
  };
}

module.exports = {
  createCompatibleCall,
  managedOrderIDs,
  normalizeOwnerOrders,
  normalizedOrderID,
  registerManagedOrderID,
  replaceManagedOrderIDs,
  unregisterManagedOrderID,
};
