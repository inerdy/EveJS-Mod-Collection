"use strict";

function normalizeOwnerOrders(result) {
  if (!Array.isArray(result)) throw new Error("Invalid GetOwnerOrders response");
  return result.map((order) => ({...order.row, ...order}));
}

function isNpcOrder(order) {
  return order && (order.owner_id === 0 || order.owner_id === "0") &&
    order.is_corp === false && order.state === "open" &&
    ["player", "npc-passive"].includes(order.source);
}

function createCompatibleCall(originalCall) {
  return async function compatibleCall(method, params, options) {
    const result = await originalCall(method, params, options);
    if (method !== "GetOrders") return result;
    // Order-book rows omit ownership. Verify against the current daemon data,
    // not saved IDs, which can be reused after a market database rebuild.
    const owners = normalizeOwnerOrders(await originalCall(
      "GetOwnerOrders", {owner_id: 0, is_corp: false}, options,
    ));
    const npcIDs = new Set(owners.filter(isNpcOrder).map((order) => String(order.order_id)));
    const rewrite = (rows) => (rows || []).map((row) =>
      row.source === "player" && npcIDs.has(String(row.order_id))
        ? {...row, source: "npc-passive"} : row);
    return {...result, sells: rewrite(result.sells), buys: rewrite(result.buys)};
  };
}

module.exports = {normalizeOwnerOrders, createCompatibleCall};
