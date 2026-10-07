"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);
const BaseService = require(serverPath("services", "baseService"));
const log = require(serverPath("utils", "logger"));
const {resolveDataRootPath} = require(serverPath("config", "dataRoot"));
const {listItemTypes} = require(serverPath("services", "inventory", "itemTypeRegistry"));
const {getStationRecord} = require(serverPath("services", "_shared", "stationStaticData"));
const {marketDaemonClient} = require(serverPath("services", "market", "marketDaemonClient"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {createStateStore, normalizeState} = require(path.join(__dirname, "state"));
const {
  buildAveragePrice,
  buildPrice,
  buildReference,
  chooseTier,
} = require(path.join(__dirname, "pricing"));
const {isConfigured: isDiscordConfigured, sendWebhook} = require(path.join(__dirname, "discord"));

const MOD_ID = "npcMarketLiquidity";
const SOURCE = "npc-passive";
const LEGACY_DAEMON_SOURCE = "player";
const NPC_OWNER_ID = 0;
const REQUIRED_DAEMON_CAPABILITY = "idempotent-fill-v1";
const managedOrderIDs = new Set();

function positive(value, fallback = 0) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : fallback;
}

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

function rewriteLegacyOrderSources(result) {
  if (!result || typeof result !== "object") return result;
  const rewrite = (rows) => (Array.isArray(rows) ? rows : []).map((row) => {
    if (
      row &&
      managedOrderIDs.has(normalizedOrderID(row.order_id)) &&
      String(row.source || "").toLowerCase() === LEGACY_DAEMON_SOURCE
    ) {
      return {...row, source: SOURCE};
    }
    return row;
  });
  return {
    ...result,
    sells: rewrite(result.sells),
    buys: rewrite(result.buys),
  };
}

function eligibleItem(item) {
  return Boolean(
    item &&
    item.published !== false &&
    positive(item.typeID) > 0 &&
    positive(item.marketGroupID) > 0 &&
    Number(item.volume) > 0 &&
    positive(item.portionSize, 1) > 0,
  );
}

function quantityForItem(item, config) {
  const volume = Math.max(0.01, Number(item.volume) || 0.01);
  return Math.max(
    config.minimumVolume,
    Math.min(
      config.maximumOrderQuantity,
      Math.max(1, Math.floor(config.targetOrderVolumeM3 / volume)),
    ),
  );
}

function orderSource(stationID, typeID, side, slot) {
  return `${SOURCE}:${stationID}:${typeID}:${side}:${slot}`;
}

class NpcMarketLiquidityService extends BaseService {
  constructor(options = {}) {
    super(MOD_ID);
    this._config = options.config || loadConfig();
    this._stateStore = options.stateStore || createStateStore(
      resolveDataRootPath("gameStore", MOD_ID, "state.json"),
    );
    this._state = normalizeState(this._stateStore.load());
    this._ticker = null;
    this._startupTimer = null;
    this._tickInProgress = false;
    this._items = null;
    this._daemonCapabilityVerified = false;
    this._daemonStartedAt = "";
    this._marketRestarted = false;
    this._lastStatus = {state: "created", created: 0, replaced: 0, skipped: 0};
    for (const orderID of Array.isArray(this._state.managedOrderIDs) ? this._state.managedOrderIDs : []) {
      registerManagedOrderID(orderID);
    }
    if (this._config.enabled && options.autoStart !== false) this._start();
  }

  _start() {
    if (this._ticker || this._startupTimer) return;
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      void this.tick();
    }, this._config.initialDelayMs);
    this._startupTimer.unref?.();
    this._ticker = setInterval(() => void this.tick(), this._config.tickIntervalMs);
    this._ticker.unref?.();
  }

  stop() {
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._ticker) clearInterval(this._ticker);
    this._startupTimer = null;
    this._ticker = null;
    return true;
  }

  getStatus() {
    return {
      ...this._lastStatus,
      enabled: this._config.enabled,
      dryRun: this._config.dryRun,
      compatibilityMode: "legacy-player-order-bridge",
      discordWebhookConfigured: isDiscordConfigured(this._config.discordWebhookUrl),
      managedOrderCount: managedOrderIDs.size,
      lastTickAtMs: this._state.lastTickAtMs,
      statePath: this._stateStore.filePath,
    };
  }

  _listItems() {
    if (!this._items) {
      const fuelTypeID = positive(this._config.hubFuelSeed && this._config.hubFuelSeed.typeID);
      this._items = listItemTypes()
        .filter(eligibleItem)
        .filter((item) => !this._config.hubFuelSeed.enabled || positive(item.typeID) !== fuelTypeID)
        .sort((left, right) => positive(left.typeID) - positive(right.typeID));
    }
    return this._items;
  }

  _fuelSeedItem() {
    if (!this._config.hubFuelSeed.enabled) return null;
    return listItemTypes().find((item) =>
      eligibleItem(item) && positive(item.typeID) === positive(this._config.hubFuelSeed.typeID)) || null;
  }

  _loadHub(stationID) {
    const station = getStationRecord(null, stationID);
    if (!station || positive(station.stationID) !== stationID || positive(station.regionID) <= 0) {
      throw new Error(`configured hub station ${stationID} is not available`);
    }
    return station;
  }

  async _listExistingOrders() {
    const result = await marketDaemonClient.call("GetOwnerOrders", {owner_id: 0, is_corp: false});
    const orders = Array.isArray(result)
      ? result.filter((order) => (
        Number(order && order.owner_id) === NPC_OWNER_ID &&
        order && order.is_corp !== true &&
        String(order.source || "").toLowerCase() === LEGACY_DAEMON_SOURCE &&
        String(order.state || "open").toLowerCase() === "open"
      ))
      : [];
    replaceManagedOrderIDs(orders);
    this._state.managedOrderIDs = [...managedOrderIDs];
    return orders;
  }

  async _ensureDaemonSupport() {
    const health = await marketDaemonClient.call("Health", {});
    const capabilities = Array.isArray(health && health.capabilities)
      ? health.capabilities.map(String)
      : [];
    if (!this._daemonCapabilityVerified && !capabilities.includes(REQUIRED_DAEMON_CAPABILITY)) {
      throw new Error(
        `market daemon does not expose the standard ${REQUIRED_DAEMON_CAPABILITY} compatibility API`,
      );
    }
    const nextStartedAt = String(health && health.started_at || "");
    if (this._daemonStartedAt && nextStartedAt && this._daemonStartedAt !== nextStartedAt) {
      this._marketRestarted = true;
    } else {
      this._marketRestarted = Boolean(
        this._state.marketStartedAt &&
        nextStartedAt &&
        this._state.marketStartedAt !== nextStartedAt,
      );
    }
    this._daemonStartedAt = nextStartedAt;
    this._daemonCapabilityVerified = true;
  }

  _fuelSeedOrders(stationID, itemTypeID, existing) {
    return existing.filter((order) => (
      String(order.state || "open").toLowerCase() === "open" &&
      Number(order.station_id) === Number(stationID) &&
      Number(order.type_id) === Number(itemTypeID) &&
      Boolean(order.bid) === false &&
      String(order.source || "").toLowerCase() === LEGACY_DAEMON_SOURCE
    ));
  }

  async _processFuelSeed(station, item, existing, nowMs) {
    const result = {created: 0, replaced: 0, skipped: 0, failed: 0};
    if (!this._config.hubFuelSeed.enabled) return result;
    if (!item) {
      result.skipped = 1;
      return result;
    }

    const stationKey = String(station.stationID);
    const configured = this._config.hubFuelSeed;
    const openOrders = this._fuelSeedOrders(station.stationID, item.typeID, existing);
    if (openOrders.length > 0) {
      const current = openOrders.sort((left, right) => Number(left.order_id) - Number(right.order_id))[0];
      this._state.fuelSeedByStation[stationKey] = {
        ...(this._state.fuelSeedByStation[stationKey] || {}),
        orderID: String(current.order_id || ""),
      };
      result.skipped = 1;
      return result;
    }

    const previous = this._state.fuelSeedByStation[stationKey];
    const repairMissingSeed = Boolean(
      previous &&
      configured.repairAfterMarketRestart &&
      this._marketRestarted,
    );
    if (previous && !repairMissingSeed) {
      result.skipped = 1;
      return result;
    }

    try {
      const summary = await marketDaemonClient.call("GetStationAsks", {
        station_id: station.stationID,
      });
      const row = (Array.isArray(summary) ? summary : []).find((entry) =>
        Number(entry && entry.type_id) === Number(item.typeID),
      );
      const reference = row
        ? {
          bestAsk: Number(row.best_ask_price) > 0 ? Number(row.best_ask_price) : null,
          bestBid: Number(row.best_bid_price) > 0 ? Number(row.best_bid_price) : null,
        }
        : null;
      const price = buildAveragePrice(reference);
      if (!(price > 0)) {
        result.skipped = 1;
        return result;
      }
      if (this._config.dryRun) {
        log.info(
          `[${MOD_ID}] dry-run fuel seed station=${station.stationID} ` +
          `type=${item.typeID} price=${price} quantity=${configured.quantity}`,
        );
        return result;
      }

      const placed = await marketDaemonClient.call("PlaceOrder", {
        owner_id: NPC_OWNER_ID,
        is_corp: false,
        station_id: station.stationID,
        type_id: item.typeID,
        price,
        quantity: configured.quantity,
        min_volume: this._config.minimumVolume,
        duration_days: this._config.durationDays,
        range_value: 32767,
        bid: false,
        source: LEGACY_DAEMON_SOURCE,
      });
      const orderID = registerManagedOrderID(placed && placed.order_id);
      existing.push({
        order_id: orderID,
        owner_id: NPC_OWNER_ID,
        is_corp: false,
        state: "open",
        source: LEGACY_DAEMON_SOURCE,
        station_id: station.stationID,
        type_id: item.typeID,
        bid: false,
        issued_at: new Date().toISOString(),
      });
      this._state.fuelSeedByStation[stationKey] = {
        orderID,
        seededAtMs: nowMs,
        price,
        quantity: configured.quantity,
      };
      result.created = 1;
    } catch (error) {
      result.failed = 1;
      log.warn(`[${MOD_ID}] fuel seed failed station=${station.stationID}: ${error.message}`);
    }
    return result;
  }

  async _placeOrder(station, item, side, slot, reference, existing) {
    const tiers = side === "buy" ? this._config.buyTiers : this._config.sellTiers;
    const tier = chooseTier(tiers, `${station.stationID}:${item.typeID}:${side}:${slot}`);
    const price = buildPrice(side, tier, reference, this._config.minimumSpreadRatio);
    const current = existing
      .filter((order) => (
        String(order.state || "open").toLowerCase() === "open" &&
        Number(order.station_id) === station.stationID &&
        Number(order.type_id) === item.typeID &&
        Boolean(order.bid) === (side === "buy") &&
        String(order.source || "").toLowerCase() === LEGACY_DAEMON_SOURCE
      ))
      .sort((left, right) => Number(left.order_id) - Number(right.order_id))[slot];
    let replaced = false;
    if (current) {
      const issuedAt = Date.parse(String(current.issued_at || ""));
      if (Number.isFinite(issuedAt) && Date.now() - issuedAt < this._config.staleAfterMs) return {created: false, replaced: false};
      if (!this._config.dryRun) await marketDaemonClient.call("CancelOrder", {order_id: current.order_id});
      if (!this._config.dryRun) {
        const currentIndex = existing.indexOf(current);
        if (currentIndex >= 0) existing.splice(currentIndex, 1);
        unregisterManagedOrderID(current.order_id);
      }
      replaced = true;
    }
    const quantity = quantityForItem(item, this._config);
    if (this._config.dryRun) {
      log.info(`[${MOD_ID}] dry-run ${side} ${item.name} type=${item.typeID} station=${station.stationID} price=${price} quantity=${quantity} tier=${tier.id}`);
      return {created: false, replaced, dryRun: true};
    }
    const placed = await marketDaemonClient.call("PlaceOrder", {
      owner_id: 0,
      is_corp: false,
      station_id: station.stationID,
      type_id: item.typeID,
      price,
      quantity,
      min_volume: this._config.minimumVolume,
      duration_days: this._config.durationDays,
      range_value: 32767,
      bid: side === "buy",
      // Older daemons only expose the normal player-order source. The loader
      // bridge rewrites managed owner-0 orders to SOURCE for EveJS fill logic.
      source: LEGACY_DAEMON_SOURCE,
    });
    registerManagedOrderID(placed && placed.order_id);
    existing.push({
      order_id: placed && placed.order_id,
      owner_id: NPC_OWNER_ID,
      is_corp: false,
      state: "open",
      source: LEGACY_DAEMON_SOURCE,
      station_id: station.stationID,
      type_id: item.typeID,
      bid: side === "buy",
      issued_at: new Date().toISOString(),
    });
    return {created: true, replaced};
  }

  async _processHub(station, items, existing, nowMs) {
    const key = String(station.stationID);
    const start = Math.min(this._state.cursorByStation[key] || 0, items.length);
    const selected = [];
    for (let offset = 0; offset < Math.min(this._config.itemsPerHubPerTick, items.length); offset += 1) {
      selected.push(items[(start + offset) % items.length]);
    }
    this._state.cursorByStation[key] = items.length > 0
      ? (start + selected.length) % items.length
      : 0;
    const seedHubs = new Set((this._config.hubFuelSeed.hubStationIDs || []).map(Number));
    const fuelSeedResult = seedHubs.has(Number(station.stationID))
      ? await this._processFuelSeed(station, this._fuelSeedItem(), existing, nowMs)
      : {created: 0, replaced: 0, skipped: 0, failed: 0};
    let created = fuelSeedResult.created;
    let replaced = 0;
    let skipped = fuelSeedResult.skipped;
    let failed = fuelSeedResult.failed;
    let openAtHub = existing.filter((order) => String(order.state) === "open" && positive(order.station_id) === station.stationID).length;
    for (const item of selected) {
      if (openAtHub >= this._config.maxActiveOrdersPerHub) break;
      const book = await marketDaemonClient.call("GetOrders", {region_id: station.regionID, type_id: item.typeID});
      const reference = buildReference(book, this._config.minimumSpreadRatio);
      if (!reference) {
        skipped += 1;
        continue;
      }
      for (const side of ["buy", "sell"]) {
        for (let slot = 0; slot < this._config.ordersPerSide; slot += 1) {
          const result = await this._placeOrder(station, item, side, slot, reference, existing);
          if (result.created) created += 1;
          if (result.replaced) replaced += 1;
          if (result.created && !result.replaced) openAtHub += 1;
        }
      }
    }
    log.info(`[${MOD_ID}] hub=${station.stationID} processed=${selected.length} created=${created} replaced=${replaced} skipped=${skipped} at=${nowMs}`);
    return {
      stationID: station.stationID,
      stationName: station.stationName || String(station.stationID),
      created,
      replaced,
      skipped,
      failed,
      fuelSeed: fuelSeedResult,
    };
  }

  async _notifyDiscord(totals, hubs, nowMs) {
    const changeCount = totals.created + totals.replaced + totals.failed;
    const seedActivity = totals.seedCreated + totals.seedSkipped + totals.seedFailed;
    if (!isDiscordConfigured(this._config.discordWebhookUrl)) return;
    if (changeCount === 0 && seedActivity === 0 && !this._config.discordNotifyWhenEmpty) return;
    const lines = [
      "NPC Market Liquidity update",
      `Time: ${new Date(nowMs).toISOString()}`,
      `Created: ${totals.created} | Replaced: ${totals.replaced} | ` +
        `Skipped: ${totals.skipped} | Failed: ${totals.failed}`,
      `Oxygen seed: created ${totals.seedCreated} | skipped ${totals.seedSkipped} | failed ${totals.seedFailed}`,
      ...hubs
        .filter((hub) => hub.created > 0 || hub.replaced > 0 || hub.skipped > 0 || hub.failed > 0 ||
          hub.fuelSeed && (hub.fuelSeed.created > 0 || hub.fuelSeed.skipped > 0 || hub.fuelSeed.failed > 0))
        .map((hub) => `- ${hub.stationName} (${hub.stationID}): created ${hub.created}, replaced ${hub.replaced}, skipped ${hub.skipped}, failed ${hub.failed}; ` +
          `fuel seed created ${hub.fuelSeed.created}, skipped ${hub.fuelSeed.skipped}, failed ${hub.fuelSeed.failed}`),
    ];
    try {
      await sendWebhook(this._config.discordWebhookUrl, lines.join("\n"));
    } catch (error) {
      log.warn(`[${MOD_ID}] Discord notification failed: ${String(error && error.message || error)}`);
    }
  }

  async tick(nowMs = Date.now()) {
    if (!this._config.enabled || this._tickInProgress) return this.getStatus();
    this._tickInProgress = true;
    const totals = {
      created: 0,
      replaced: 0,
      skipped: 0,
      failed: 0,
      seedCreated: 0,
      seedSkipped: 0,
      seedFailed: 0,
    };
    const hubs = [];
    try {
      await this._ensureDaemonSupport();
      const items = this._listItems();
      const existing = await this._listExistingOrders();
      for (const stationID of this._config.hubStationIDs) {
        const station = this._loadHub(stationID);
        const result = await this._processHub(station, items, existing, nowMs);
        hubs.push(result);
        totals.created += result.created;
        totals.replaced += result.replaced;
        totals.skipped += result.skipped;
        totals.failed += result.failed;
        totals.seedCreated += result.fuelSeed.created;
        totals.seedSkipped += result.fuelSeed.skipped;
        totals.seedFailed += result.fuelSeed.failed;
      }
      this._state.lastTickAtMs = nowMs;
      this._state.marketStartedAt = this._daemonStartedAt;
      this._state.createdOrders += totals.created;
      this._state.replacedOrders += totals.replaced;
      this._state.skippedItems += totals.skipped;
      this._state.managedOrderIDs = [...managedOrderIDs];
      this._state.lastError = "";
      this._stateStore.save(this._state);
      this._lastStatus = {state: "ok", ...totals};
      await this._notifyDiscord(totals, hubs, nowMs);
    } catch (error) {
      this._state.lastError = String(error && error.message || error);
      this._state.managedOrderIDs = [...managedOrderIDs];
      this._stateStore.save(this._state);
      this._lastStatus = {state: "error", ...totals, error: this._state.lastError};
      log.warn(`[${MOD_ID}] tick failed: ${this._state.lastError}`);
    } finally {
      this._tickInProgress = false;
    }
    return this.getStatus();
  }
}

module.exports = NpcMarketLiquidityService;
module.exports._testing = {
  buildAveragePrice,
  eligibleItem,
  quantityForItem,
  orderSource,
  registerManagedOrderID,
  rewriteLegacyOrderSources,
};
