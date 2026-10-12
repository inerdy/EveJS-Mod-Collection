"use strict";

function normalizeOwnerOrders(result) {
  if (!Array.isArray(result)) throw new Error("Invalid GetOwnerOrders response");
  return result.map((order) => ({...order.row, ...order}));
}

module.exports = {normalizeOwnerOrders};
