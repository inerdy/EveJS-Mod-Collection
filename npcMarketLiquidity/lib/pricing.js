"use strict";

const fs = require("node:fs");

const REAL_MARKET_SOURCES = new Set([
  "ccp-esi-average",
  "ccp-snapshot-jita-split",
]);

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function chooseTier(tiers, key) {
  const total = tiers.reduce((sum, tier) => sum + Math.max(0, Number(tier.weight) || 0), 0);
  if (!(total > 0)) return tiers[0] || null;
  let cursor = (hash(key) / 0xffffffff) * total;
  for (const tier of tiers) {
    cursor -= Math.max(0, Number(tier.weight) || 0);
    if (cursor <= 0) return tier;
  }
  return tiers[tiers.length - 1] || null;
}

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

function buildReference(book, minimumSpreadRatio = 0.02) {
  const rows = (Array.isArray(book && book.sells) ? book.sells : [])
    .concat(Array.isArray(book && book.buys) ? book.buys : [])
    .filter((row) => String(row && row.source || "").toLowerCase() !== "npc-passive");
  const sells = rows.filter((row) => row && row.bid === false && Number(row.price) > 0);
  const buys = rows.filter((row) => row && row.bid === true && Number(row.price) > 0);
  const bestAsk = sells.reduce((value, row) => Math.min(value, Number(row.price)), Infinity);
  const bestBid = buys.reduce((value, row) => Math.max(value, Number(row.price)), 0);
  if (!(bestAsk < Infinity) && !(bestBid > 0)) return null;
  const spread = Math.max(0, Number(minimumSpreadRatio) || 0);
  const askReference = bestAsk < Infinity ? bestAsk : bestBid * (1 + spread);
  const bidReference = bestBid > 0 ? bestBid : bestAsk * (1 - spread);
  return {
    bestAsk: bestAsk < Infinity ? bestAsk : null,
    bestBid: bestBid > 0 ? bestBid : null,
    askReference: Math.max(0.01, askReference),
    bidReference: Math.max(0.01, bidReference),
  };
}

function buildPrice(side, tier, reference, minimumSpreadRatio = 0.02) {
  const multiplier = Math.max(0.01, Number(tier && tier.multiplier) || 0);
  const spread = Math.max(0, Number(minimumSpreadRatio) || 0);
  let price = side === "buy"
    ? reference.bidReference * multiplier
    : reference.askReference * multiplier;
  if (side === "buy" && reference.bestAsk !== null) {
    price = Math.min(price, reference.bestAsk * Math.max(0.01, 1 - spread));
  }
  if (side === "sell" && reference.bestBid !== null) {
    price = Math.max(price, reference.bestBid * (1 + spread));
  }
  return roundPrice(Math.max(0.01, price));
}

function buildAveragePrice(reference) {
  if (!reference || typeof reference !== "object") return null;
  const ask = Number(reference.bestAsk);
  const bid = Number(reference.bestBid);
  if (Number.isFinite(ask) && ask > 0 && Number.isFinite(bid) && bid > 0) {
    return roundPrice((ask + bid) / 2);
  }
  if (Number.isFinite(ask) && ask > 0) return roundPrice(ask);
  if (Number.isFinite(bid) && bid > 0) return roundPrice(bid);
  return null;
}

function isRealMarketSource(source) {
  return REAL_MARKET_SOURCES.has(String(source || "").trim().toLowerCase());
}

function normalizeManifestEntry(value) {
  const price = Number(value && value.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    price: Math.max(0.01, roundPrice(price)),
    source: String(value && value.source || "manifest").trim() || "manifest",
    capturedAt: String(value && value.capturedAt || "").trim(),
  };
}

function loadPriceManifest(filePath, options = {}) {
  const result = {
    loaded: false,
    filePath: String(filePath || ""),
    generatedAt: "",
    sdeBuild: null,
    entries: new Map(),
    realEntries: 0,
    calculatedEntries: 0,
    skippedEntries: 0,
    error: "",
  };
  try {
    const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const prices = document && document.prices && typeof document.prices === "object"
      ? document.prices
      : {};
    const allowCalculated = options.allowCalculated !== false;
    for (const [typeID, rawEntry] of Object.entries(prices)) {
      const normalizedTypeID = Number(typeID);
      const entry = normalizeManifestEntry(rawEntry);
      if (!(normalizedTypeID > 0) || !entry) {
        result.skippedEntries += 1;
        continue;
      }
      const real = isRealMarketSource(entry.source);
      if (!real && !allowCalculated) {
        result.skippedEntries += 1;
        continue;
      }
      result.entries.set(normalizedTypeID, entry);
      if (real) result.realEntries += 1;
      else result.calculatedEntries += 1;
    }
    result.loaded = true;
    result.generatedAt = String(document && document.generatedAt || "");
    result.sdeBuild = document && document.sdeBuild != null ? document.sdeBuild : null;
  } catch (error) {
    result.error = String(error && error.message || error);
  }
  return result;
}

function buildManifestReference(entry) {
  const normalized = normalizeManifestEntry(entry);
  if (!normalized) return null;
  return {
    bestAsk: null,
    bestBid: null,
    askReference: normalized.price,
    bidReference: normalized.price,
    source: normalized.source,
    capturedAt: normalized.capturedAt,
  };
}

module.exports = {
  buildAveragePrice,
  buildManifestReference,
  buildPrice,
  buildReference,
  chooseTier,
  hash,
  isRealMarketSource,
  loadPriceManifest,
  normalizeManifestEntry,
  roundPrice,
};
