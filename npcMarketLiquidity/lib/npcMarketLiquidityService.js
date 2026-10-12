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
const {isBidOrderInRange} = require(serverPath("services", "market", "marketTopology"));
const {loadConfig} = require(path.join(__dirname, "config"));
const {createStateStore, normalizeState} = require(path.join(__dirname, "state"));
const {
  buildAveragePrice,
  buildManifestReference,
  buildPrice,
  buildReference,
  chooseTier,
  isRealMarketSource,
  loadPriceManifest,
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

function quantityForItem(item, config, overrides = {}) {
  const volume = Math.max(0.01, Number(item.volume) || 0.01);
  const targetOrderVolumeM3 = Math.max(
    0.01,
    Number(overrides.targetOrderVolumeM3) || config.targetOrderVolumeM3,
  );
  const maximumOrderQuantity = Math.max(
    1,
    Math.trunc(Number(overrides.maximumOrderQuantity) || config.maximumOrderQuantity),
  );
  return Math.max(
    config.minimumVolume,
    Math.min(
      maximumOrderQuantity,
      Math.max(1, Math.floor(targetOrderVolumeM3 / volume)),
    ),
  );
}

function resourceOrderOverrides(item, config, overrides = {}) {
  const resourceLiquidity = config && config.resourceLiquidity;
  const resourceTypeIDs = resourceLiquidity && Array.isArray(resourceLiquidity.typeIDs)
    ? resourceLiquidity.typeIDs
    : [];
  if (
    !resourceLiquidity ||
    resourceLiquidity.enabled === false ||
    !resourceTypeIDs.includes(positive(item && item.typeID))
  ) {
    return {...overrides};
  }
  return {
    ...overrides,
    targetOrderVolumeM3: resourceLiquidity.targetOrderVolumeM3,
    maximumOrderQuantity: resourceLiquidity.maximumOrderQuantity,
    replaceIfQuantityBelow: true,
  };
}

function orderSource(stationID, typeID, side, slot) {
  return `${SOURCE}:${stationID}:${typeID}:${side}:${slot}`;
}

const SYNTHETIC_BUY_SOURCES = new Set(["npc-passive", "seed"]);

function normalizedOrderIDForComparison(value) {
  return normalizedOrderID(value);
}

function isPlayerSellOrder(order) {
  return Boolean(
    order &&
    normalizedOrderIDForComparison(order.order_id) &&
    Boolean(order.bid) === false &&
    String(order.source || "").toLowerCase() === LEGACY_DAEMON_SOURCE &&
    positive(order.vol_remaining, 0) > 0 &&
    Number(order.price) > 0,
  );
}

function isSyntheticBuyOrder(order) {
  return Boolean(
    order &&
    Boolean(order.bid) === true &&
    SYNTHETIC_BUY_SOURCES.has(String(order.source || "").toLowerCase()) &&
    positive(order.vol_remaining, 0) > 0 &&
    Number(order.price) > 0,
  );
}

function buybackReferencePrice(reference, fallbackReference = null) {
  const bestBid = Number(reference && reference.bestBid);
  const bestAsk = Number(reference && reference.bestAsk);
  if (Number.isFinite(bestBid) && bestBid > 0) {
    if (Number.isFinite(bestAsk) && bestAsk > 0) {
      return (bestBid + bestAsk) / 2;
    }
    return Number(reference.bidReference) > 0
      ? Number(reference.bidReference)
      : bestBid;
  }
  const fallbackPrice = Number(
    fallbackReference && (
      fallbackReference.askReference ||
      fallbackReference.bidReference ||
      fallbackReference.price
    ),
  );
  if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) return fallbackPrice;
  const askReference = Number(reference && reference.askReference);
  const bidReference = Number(reference && reference.bidReference);
  if (Number.isFinite(askReference) && askReference > 0 &&
      Number.isFinite(bidReference) && bidReference > 0) {
    return (askReference + bidReference) / 2;
  }
  if (Number.isFinite(askReference) && askReference > 0) return askReference;
  if (Number.isFinite(bidReference) && bidReference > 0) return bidReference;
  return null;
}

function buybackPriceScore(orderPrice, referencePrice, settings) {
  const price = Number(orderPrice);
  const reference = Number(referencePrice);
  if (!(price > 0) || !(reference > 0)) return 0;
  const minimum = reference * Math.max(0.01, Number(settings && settings.minimumPriceRatio) || 0.01);
  const maximum = reference * Math.max(
    Number(settings && settings.maximumPriceRatio) || 0.01,
    Number(settings && settings.minimumPriceRatio) || 0.01,
  );
  if (price > maximum) return 0;
  if (price <= minimum || maximum <= minimum) return 1;
  return Math.max(0, Math.min(1, (maximum - price) / (maximum - minimum)));
}

function buybackChance(orderPrice, referencePrice, settings) {
  const baseChance = Math.max(0, Math.min(1, Number(settings && settings.chancePerTick) || 0));
  return baseChance * buybackPriceScore(orderPrice, referencePrice, settings);
}

function getMarketProxyFillHooks() {
  try {
    const MarketProxyService = require(serverPath("services", "market", "marketProxyService"));
    return MarketProxyService && MarketProxyService.__testHooks
      ? MarketProxyService.__testHooks
      : null;
  } catch (error) {
    return null;
  }
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
    this._oreTicker = null;
    this._oreStartupTimer = null;
    this._tickInProgress = false;
    this._items = null;
    this._oreItems = null;
    this._resourceItems = null;
    this._priceManifest = null;
    this._daemonCapabilityVerified = false;
    this._daemonStartedAt = "";
    this._marketRestarted = false;
    this._buybackHookWarningLogged = false;
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
    if (this._config.oreLiquidity.enabled) {
      this._oreStartupTimer = setTimeout(() => {
        this._oreStartupTimer = null;
        void this.tick({oreOnly: true});
      }, this._config.initialDelayMs);
      this._oreStartupTimer.unref?.();
      this._oreTicker = setInterval(
        () => void this.tick({oreOnly: true}),
        this._config.oreLiquidity.tickIntervalMs,
      );
      this._oreTicker.unref?.();
    }
  }

  stop() {
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._ticker) clearInterval(this._ticker);
    if (this._oreStartupTimer) clearTimeout(this._oreStartupTimer);
    if (this._oreTicker) clearInterval(this._oreTicker);
    this._startupTimer = null;
    this._ticker = null;
    this._oreStartupTimer = null;
    this._oreTicker = null;
    return true;
  }

  getStatus() {
    return {
      ...this._lastStatus,
      enabled: this._config.enabled,
      dryRun: this._config.dryRun,
      playerSellBuyback: this._config.playerSellBuyback,
      compatibilityMode: "legacy-player-order-bridge",
      discordWebhookConfigured: isDiscordConfigured(this._config.discordWebhookUrl),
      managedOrderCount: managedOrderIDs.size,
      lastTickAtMs: this._state.lastTickAtMs,
      statePath: this._stateStore.filePath,
      priceManifest: this._priceManifestStatus(),
    };
  }

  _priceManifestStatus() {
    return {
      enabled: this._config.priceManifestEnabled,
      path: this._config.priceManifestPath,
      loaded: Boolean(this._priceManifest && this._priceManifest.loaded),
      generatedAt: this._priceManifest ? this._priceManifest.generatedAt : "",
      entries: this._priceManifest ? this._priceManifest.entries.size : 0,
      realEntries: this._priceManifest ? this._priceManifest.realEntries : 0,
      calculatedEntries: this._priceManifest ? this._priceManifest.calculatedEntries : 0,
      skippedEntries: this._priceManifest ? this._priceManifest.skippedEntries : 0,
      error: this._priceManifest ? this._priceManifest.error : "",
    };
  }

  _loadPriceManifest() {
    if (!this._config.priceManifestEnabled) return null;
    if (this._priceManifest) return this._priceManifest;
    this._priceManifest = loadPriceManifest(this._config.priceManifestPath, {
      allowCalculated: this._config.allowCalculatedManifestPrices,
    });
    if (this._priceManifest.loaded) {
      log.info(
        `[${MOD_ID}] loaded price manifest entries=${this._priceManifest.entries.size} ` +
        `real=${this._priceManifest.realEntries} calculated=${this._priceManifest.calculatedEntries} ` +
        `generatedAt=${this._priceManifest.generatedAt || "unknown"}`,
      );
    } else {
      log.warn(
        `[${MOD_ID}] price manifest unavailable path=${this._config.priceManifestPath}: ` +
        this._priceManifest.error,
      );
    }
    return this._priceManifest;
  }

  _manifestReference(typeID) {
    const manifest = this._loadPriceManifest();
    const entry = manifest && manifest.entries.get(positive(typeID));
    return buildManifestReference(entry);
  }

  _listItems() {
    if (!this._items) {
      const fuelTypeIDs = new Set((this._config.fuelSeeds || []).map((seed) => positive(seed && seed.typeID)));
      this._items = listItemTypes()
        .filter(eligibleItem)
        .filter((item) => !fuelTypeIDs.has(positive(item.typeID)))
        .sort((left, right) => positive(left.typeID) - positive(right.typeID));
    }
    return this._items;
  }

  _listOreItems() {
    if (!this._oreItems) {
      const oreTypeIDs = new Set(this._config.oreLiquidity.typeIDs.map(Number));
      this._oreItems = listItemTypes()
        .filter(eligibleItem)
        .filter((item) => oreTypeIDs.has(positive(item.typeID)))
        .sort((left, right) => positive(left.typeID) - positive(right.typeID));
    }
    return this._oreItems;
  }

  _listResourceItems() {
    if (!this._resourceItems) {
      const resourceTypeIDs = new Set(this._config.resourceLiquidity.typeIDs.map(Number));
      this._resourceItems = listItemTypes()
        .filter(eligibleItem)
        .filter((item) => resourceTypeIDs.has(positive(item.typeID)))
        .sort((left, right) => positive(left.typeID) - positive(right.typeID));
    }
    return this._resourceItems;
  }

  _listShipItems() {
    if (!this._shipItems) {
      this._shipItems = listItemTypes()
        .filter(eligibleItem)
        .filter((item) => Number(item.categoryID) === 6)
        .sort((left, right) => positive(left.typeID) - positive(right.typeID));
    }
    return this._shipItems;
  }

  _fuelSeedItem(typeID) {
    return listItemTypes().find((item) =>
      eligibleItem(item) && positive(item.typeID) === positive(typeID)) || null;
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

  async _cleanupDuplicateFuelOrders(existing) {
    if (this._state.fuelDuplicateCleanupCompleted) {
      return {cancelled: 0, failed: 0, skipped: true};
    }

    const hubIDs = new Set((this._config.hubStationIDs || []).map(Number));
    const fuelTypeIDs = new Set((this._config.fuelSeeds || [])
      .filter((seed) => seed && seed.enabled !== false)
      .map((seed) => Number(seed.typeID)));
    const groups = new Map();
    for (const order of existing) {
      if (
        !order ||
        Number(order.owner_id) !== NPC_OWNER_ID ||
        order.is_corp === true ||
        String(order.source || "").toLowerCase() !== LEGACY_DAEMON_SOURCE ||
        String(order.state || "open").toLowerCase() !== "open" ||
        Boolean(order.bid) ||
        !hubIDs.has(Number(order.station_id)) ||
        !fuelTypeIDs.has(Number(order.type_id))
      ) continue;
      const key = `${Number(order.station_id)}:${Number(order.type_id)}`;
      const rows = groups.get(key) || [];
      rows.push(order);
      groups.set(key, rows);
    }

    let cancelled = 0;
    let failed = 0;
    for (const [key, rows] of groups) {
      rows.sort((left, right) => Number(left.order_id) - Number(right.order_id));
      for (const duplicate of rows.slice(1)) {
        try {
          await marketDaemonClient.call("CancelOrder", {order_id: duplicate.order_id});
          const index = existing.indexOf(duplicate);
          if (index >= 0) existing.splice(index, 1);
          unregisterManagedOrderID(duplicate.order_id);
          cancelled += 1;
        } catch (error) {
          failed += 1;
          log.warn(
            `[${MOD_ID}] duplicate fuel cleanup failed order=${duplicate.order_id} ` +
            `key=${key}: ${String(error && error.message || error)}`,
          );
        }
      }
    }

    if (failed === 0) {
      this._state.fuelDuplicateCleanupCompleted = true;
    }
    if (cancelled > 0 || failed > 0) {
      log.info(
        `[${MOD_ID}] duplicate fuel cleanup cancelled=${cancelled} failed=${failed}`,
      );
    }
    return {cancelled, failed, skipped: false};
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

  async _processFuelSeed(station, configured, existing, nowMs) {
    const result = {created: 0, replaced: 0, skipped: 0, failed: 0};
    if (!configured || configured.enabled === false) return result;
    const item = this._fuelSeedItem(configured.typeID);
    if (!item) {
      result.skipped = 1;
      return result;
    }

    const stationKey = String(station.stationID);
    const seedKey = `${stationKey}:${configured.typeID}`;
    const openOrders = this._fuelSeedOrders(station.stationID, item.typeID, existing);
    if (openOrders.length > 0) {
      const current = openOrders.sort((left, right) => Number(left.order_id) - Number(right.order_id))[0];
      this._state.fuelSeedByStation[seedKey] = {
        ...(this._state.fuelSeedByStation[seedKey] || {}),
        orderID: String(current.order_id || ""),
        typeID: configured.typeID,
      };
      result.skipped = 1;
      return result;
    }

    // The state file is only a record of what we seeded previously. It is not
    // authoritative: the market database may have been rebuilt, an order may
    // have expired, or an administrator may have removed an order manually.
    // Once the live-order check above finds no open seed, always reconcile it
    // on this tick instead of waiting for a market-daemon restart or trusting
    // the old state entry.

    try {
      const summary = await marketDaemonClient.call("GetStationAsks", {
        station_id: station.stationID,
      });
      const row = (Array.isArray(summary) ? summary : []).find((entry) =>
        Number(entry && entry.type_id) === Number(item.typeID),
      );
      let reference = row
        ? {
          bestAsk: Number(row.best_ask_price) > 0 ? Number(row.best_ask_price) : null,
          bestBid: Number(row.best_bid_price) > 0 ? Number(row.best_bid_price) : null,
        }
        : null;
      let referenceSource = "local-market";
      let price = buildAveragePrice(reference);
      if (!(price > 0)) {
        reference = this._manifestReference(item.typeID);
        referenceSource = reference ? `manifest:${reference.source}` : "";
        price = buildAveragePrice(reference);
      }
      if (!(price > 0)) {
        result.skipped = 1;
        return result;
      }
      if (this._config.dryRun) {
        log.info(
          `[${MOD_ID}] dry-run fuel seed station=${station.stationID} ` +
          `type=${item.typeID} price=${price} source=${referenceSource} quantity=${configured.quantity}`,
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
      this._state.fuelSeedByStation[seedKey] = {
        orderID,
        typeID: configured.typeID,
        seededAtMs: nowMs,
        price,
        quantity: configured.quantity,
        referenceSource,
      };
      result.created = 1;
    } catch (error) {
      result.failed = 1;
      log.warn(`[${MOD_ID}] fuel seed failed station=${station.stationID}: ${error.message}`);
    }
    return result;
  }

  async _placeOrder(station, item, side, slot, reference, existing, overrides = {}) {
    const orderOverrides = resourceOrderOverrides(item, this._config, overrides);
    const tiers = side === "buy" ? this._config.buyTiers : this._config.sellTiers;
    const tier = chooseTier(tiers, `${station.stationID}:${item.typeID}:${side}:${slot}`);
    const price = buildPrice(side, tier, reference, this._config.minimumSpreadRatio);
    const quantity = quantityForItem(item, this._config, orderOverrides);
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
      const quantityField = ["vol_remaining", "volume_remain", "quantity"]
        .find((field) => Object.prototype.hasOwnProperty.call(current, field));
      const remainingQuantity = quantityField
        ? positive(current[quantityField], 0)
        : 0;
      const needsQuantityRefresh = orderOverrides.replaceIfQuantityBelow === true &&
        Boolean(quantityField) && remainingQuantity < quantity;
      if (
        !needsQuantityRefresh &&
        Number.isFinite(issuedAt) &&
        Date.now() - issuedAt < this._config.staleAfterMs
      ) {
        return {created: false, replaced: false};
      }
      if (!this._config.dryRun) await marketDaemonClient.call("CancelOrder", {order_id: current.order_id});
      if (!this._config.dryRun) {
        const currentIndex = existing.indexOf(current);
        if (currentIndex >= 0) existing.splice(currentIndex, 1);
        unregisterManagedOrderID(current.order_id);
      }
      replaced = true;
    }
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

  _shouldBuyPlayerSellOrders(item, overrides = {}) {
    const settings = this._config.playerSellBuyback;
    if (!settings || settings.enabled === false || overrides.buyback === false) return false;
    if (
      overrides.mode !== "resource" &&
      this._config.resourceLiquidity.enabled &&
      this._config.resourceLiquidity.typeIDs.includes(positive(item && item.typeID))
    ) {
      return false;
    }
    if (!settings.resourceOnly) return true;
    return this._config.resourceLiquidity.typeIDs.includes(positive(item && item.typeID));
  }

  _buybackQuantityForItem(item) {
    const configuredMaximum = positive(
      this._config.playerSellBuyback.maximumQuantityPerOrder,
      0,
    );
    if (configuredMaximum > 0) return configuredMaximum;
    const overrides = resourceOrderOverrides(item, this._config);
    return quantityForItem(item, this._config, overrides);
  }

  async _settlePlayerSellOrderWithNpc(station, item, sellOrder, fillQuantity) {
    const hooks = getMarketProxyFillHooks();
    if (!hooks || typeof hooks.applySellOrderCrossingAfterModify !== "function") {
      if (!this._buybackHookWarningLogged) {
        this._buybackHookWarningLogged = true;
        log.warn(
          `[${MOD_ID}] player sell buyback is unavailable: ` +
          "EveJS market fill hooks are missing",
        );
      }
      return {filledQuantity: 0, unavailable: true};
    }

    const orderID = normalizedOrderID(sellOrder && sellOrder.order_id);
    if (!orderID) return {filledQuantity: 0};
    const current = await marketDaemonClient.call("GetOrder", {order_id: orderID});
    const currentState = String(current && current.state || "open").toLowerCase();
    const currentRemaining = positive(
      current && current.vol_remaining,
      positive(sellOrder && sellOrder.vol_remaining, 0),
    );
    const price = Number(current && current.price) || Number(sellOrder && sellOrder.price) || 0;
    if (currentState !== "open" || currentRemaining <= 0 || !(price > 0)) {
      return {filledQuantity: 0, stale: true};
    }

    const quantity = Math.min(
      currentRemaining,
      Math.max(1, positive(fillQuantity, 1)),
    );
    const regionID = positive(
      current && current.region_id,
      positive(sellOrder && sellOrder.region_id, 0),
    );
    const book = regionID > 0
      ? await marketDaemonClient.call("GetOrders", {
        region_id: regionID,
        type_id: positive(item && item.typeID, positive(sellOrder && sellOrder.type_id, 0)),
      })
      : null;
    const competingPlayerBuy = (Array.isArray(book && book.buys) ? book.buys : []).some((order) => (
      String(order && order.source || "").toLowerCase() === LEGACY_DAEMON_SOURCE &&
      Boolean(order && order.bid) === true &&
      positive(order && order.vol_remaining, 0) > 0 &&
      Number(order && order.price) + 0.0001 >= price &&
      isBidOrderInRange(
        order,
        positive(current && current.station_id, positive(sellOrder && sellOrder.station_id, 0)),
        positive(current && current.solar_system_id, positive(sellOrder && sellOrder.solar_system_id, 0)),
      )
    ));
    if (competingPlayerBuy) {
      return {filledQuantity: 0, skippedForPlayerBid: true};
    }

    let temporaryBuyOrderID = "";
    try {
      const placed = await marketDaemonClient.call("PlaceOrder", {
        owner_id: NPC_OWNER_ID,
        is_corp: false,
        station_id: positive(station && station.stationID, 0) ||
          positive(sellOrder && sellOrder.station_id, 0) ||
          positive(current && current.station_id, 0),
        type_id: positive(item && item.typeID, positive(current && current.type_id, 0)),
        price,
        quantity,
        min_volume: this._config.minimumVolume,
        duration_days: 1,
        range_value: 32767,
        bid: true,
        source: LEGACY_DAEMON_SOURCE,
      });
      temporaryBuyOrderID = registerManagedOrderID(placed && placed.order_id);
      if (!temporaryBuyOrderID) {
        throw new Error("market daemon did not return a buyback order ID");
      }

      // The crossing helper is the same settlement path used when a player
      // modifies a sell order into a crossing price. Limit the temporary row's
      // visible remaining volume so one tick cannot consume the whole listing.
      const orderForCrossing = {
        ...current,
        order_id: orderID,
        row: {
          ...current,
          order_id: orderID,
          price,
          vol_remaining: quantity,
          type_id: positive(item && item.typeID, positive(current && current.type_id, 0)),
        },
      };
      const crossingResponse = await hooks.applySellOrderCrossingAfterModify(
        null,
        orderForCrossing,
        price,
      );
      const after = await marketDaemonClient.call("GetOrder", {order_id: orderID });
      const afterRemaining = positive(after && after.vol_remaining, 0);
      const filledQuantity = Math.max(0, currentRemaining - afterRemaining);
      return {
        filledQuantity: Math.min(currentRemaining, filledQuantity),
        crossingResponse,
      };
    } finally {
      if (temporaryBuyOrderID) {
        try {
          const temporary = await marketDaemonClient.call("GetOrder", {
            order_id: temporaryBuyOrderID,
          });
          if (String(temporary && temporary.state || "open").toLowerCase() === "open" &&
              positive(temporary && temporary.vol_remaining, 0) > 0) {
            await marketDaemonClient.call("CancelOrder", {order_id: temporaryBuyOrderID});
          }
        } catch (error) {
          log.warn(
            `[${MOD_ID}] buyback cleanup failed order=${temporaryBuyOrderID}: ` +
            String(error && error.message || error),
          );
        }
        unregisterManagedOrderID(temporaryBuyOrderID);
      }
    }
  }

  async _buyPlayerSellOrders(station, item, book, fallbackReference) {
    const result = {
      evaluated: 0,
      attempted: 0,
      filledOrders: 0,
      filledQuantity: 0,
      failed: 0,
      skipped: 0,
    };
    const settings = this._config.playerSellBuyback;
    if (!settings || settings.enabled === false) return result;
    const sellOrders = (Array.isArray(book && book.sells) ? book.sells : [])
      .filter(isPlayerSellOrder)
      .sort((left, right) => (
        Number(left.price) - Number(right.price) ||
        Number(left.order_id) - Number(right.order_id)
      ));
    if (sellOrders.length === 0) return result;

    const maxOrders = Math.max(1, positive(settings.maxOrdersPerHubPerTick, 1));
    const random = Math.random;
    for (const sellOrder of sellOrders) {
      if (result.attempted >= maxOrders) break;
      const candidateBook = {
        sells: (Array.isArray(book && book.sells) ? book.sells : [])
          .filter((row) => normalizedOrderIDForComparison(row && row.order_id) !== normalizedOrderIDForComparison(sellOrder.order_id)),
        buys: Array.isArray(book && book.buys) ? book.buys : [],
      };
      const candidateReference = buildReference(
        candidateBook,
        this._config.minimumSpreadRatio,
      ) || fallbackReference;
      const manifestReference = this._manifestReference(item.typeID);
      const referencePrice = buybackReferencePrice(candidateReference, manifestReference);
      const price = Number(sellOrder.price) || 0;
      const chance = buybackChance(price, referencePrice, settings);
      result.evaluated += 1;
      if (!(chance > 0) || random() >= chance) {
        result.skipped += 1;
        continue;
      }

      result.attempted += 1;
      const quantity = Math.min(
        positive(sellOrder.vol_remaining, 0),
        this._buybackQuantityForItem(item),
      );
      if (quantity <= 0) {
        result.skipped += 1;
        continue;
      }
      if (this._config.dryRun) {
        log.info(
          `[${MOD_ID}] dry-run player sell buyback item=${item.name} ` +
          `type=${item.typeID} station=${station.stationID} order=${sellOrder.order_id} ` +
          `price=${price} quantity=${quantity} chance=${chance.toFixed(4)}`,
        );
        continue;
      }

      try {
        const settled = await this._settlePlayerSellOrderWithNpc(station, item, sellOrder, quantity);
        const filledQuantity = positive(settled && settled.filledQuantity, 0);
        if (filledQuantity > 0) {
          result.filledOrders += 1;
          result.filledQuantity += filledQuantity;
          log.info(
            `[${MOD_ID}] NPC bought player sell order=${sellOrder.order_id} ` +
            `type=${item.typeID} quantity=${filledQuantity} price=${price} ` +
            `station=${station.stationID}`,
          );
        }
      } catch (error) {
        result.failed += 1;
        log.warn(
          `[${MOD_ID}] player sell buyback failed order=${sellOrder.order_id} ` +
          `type=${item.typeID}: ${String(error && error.message || error)}`,
        );
      }
    }
    return result;
  }

  async _processHub(station, items, existing, nowMs, overrides = {}) {
    const key = String(overrides.cursorKey || station.stationID);
    const priorityPass = overrides.priority === true;
    const start = priorityPass
      ? 0
      : Math.min(this._state.cursorByStation[key] || 0, items.length);
    const selected = [];
    const itemLimit = priorityPass
      ? items.length
      : Math.min(
        Number.isFinite(Number(overrides.itemsPerHubPerTick))
          ? Math.max(1, Math.trunc(Number(overrides.itemsPerHubPerTick)))
          : this._config.itemsPerHubPerTick,
        items.length,
      );
    for (let offset = 0; offset < itemLimit; offset += 1) {
      selected.push(items[(start + offset) % items.length]);
    }
    if (!priorityPass) {
      this._state.cursorByStation[key] = items.length > 0
      ? (start + selected.length) % items.length
      : 0;
    }
    const fuelSeedResult = {created: 0, replaced: 0, skipped: 0, failed: 0, entries: []};
    for (const configured of overrides.skipFuelSeeds || priorityPass ? [] : this._config.fuelSeeds || []) {
      const seedHubs = new Set((configured.hubStationIDs || []).map(Number));
      if (configured.enabled === false || !seedHubs.has(Number(station.stationID))) continue;
      const result = await this._processFuelSeed(station, configured, existing, nowMs);
      fuelSeedResult.entries.push({typeID: configured.typeID, name: configured.name, ...result});
      fuelSeedResult.created += result.created;
      fuelSeedResult.replaced += result.replaced;
      fuelSeedResult.skipped += result.skipped;
      fuelSeedResult.failed += result.failed;
    }
    let created = fuelSeedResult.created;
    let replaced = 0;
    let skipped = fuelSeedResult.skipped;
    let failed = fuelSeedResult.failed;
    let manifestFallback = 0;
    let calculatedFallback = 0;
    let buybackEvaluated = 0;
    let buybackAttempted = 0;
    let buybackOrders = 0;
    let buybackQuantity = 0;
    let buybackFailed = 0;
    let openAtHub = existing.filter((order) => String(order.state) === "open" && positive(order.station_id) === station.stationID).length;
    for (const item of selected) {
      if (openAtHub >= this._config.maxActiveOrdersPerHub) break;
      const book = await marketDaemonClient.call("GetOrders", {region_id: station.regionID, type_id: item.typeID});
      let reference = buildReference(book, this._config.minimumSpreadRatio);
      if (!reference) {
        reference = this._manifestReference(item.typeID);
        if (!reference) {
          skipped += 1;
          continue;
        }
        manifestFallback += 1;
        if (!isRealMarketSource(reference.source)) calculatedFallback += 1;
      }
      const sides = overrides.buyOnly === true ? ["buy"] : ["buy", "sell"];
      const ordersPerSide = Number.isFinite(Number(overrides.ordersPerItem))
        ? Math.max(1, Math.trunc(Number(overrides.ordersPerItem)))
        : this._config.ordersPerSide;
      for (const side of sides) {
        for (let slot = 0; slot < ordersPerSide; slot += 1) {
          const result = await this._placeOrder(
            station,
            item,
            side,
            slot,
            reference,
            existing,
            overrides,
          );
          if (result.created) created += 1;
          if (result.replaced) replaced += 1;
          if (result.created && !result.replaced) openAtHub += 1;
        }
      }
      if (this._shouldBuyPlayerSellOrders(item, overrides)) {
        const buyback = await this._buyPlayerSellOrders(station, item, book, reference);
        buybackEvaluated += buyback.evaluated;
        buybackAttempted += buyback.attempted;
        buybackOrders += buyback.filledOrders;
        buybackQuantity += buyback.filledQuantity;
        buybackFailed += buyback.failed;
      }
    }
    log.info(
      `[${MOD_ID}] hub=${station.stationID} mode=${overrides.mode || (priorityPass ? "ore-buy" : "standard")} ` +
      `processed=${selected.length} created=${created} ` +
      `replaced=${replaced} skipped=${skipped} manifestFallback=${manifestFallback} ` +
      `calculatedFallback=${calculatedFallback} buybackOrders=${buybackOrders} ` +
      `buybackQuantity=${buybackQuantity} buybackFailed=${buybackFailed} at=${nowMs}`,
    );
    return {
      stationID: station.stationID,
      stationName: station.stationName || String(station.stationID),
      created,
      replaced,
      skipped,
      failed,
      manifestFallback,
      calculatedFallback,
      buybackEvaluated,
      buybackAttempted,
      buybackOrders,
      buybackQuantity,
      buybackFailed,
      fuelSeed: fuelSeedResult,
    };
  }

  async _notifyDiscord(totals, hubs, nowMs) {
    const changeCount = totals.created + totals.replaced + totals.failed + totals.buybackOrders + totals.buybackFailed;
    const seedActivity = totals.seedCreated + totals.seedSkipped + totals.seedFailed;
    if (!isDiscordConfigured(this._config.discordWebhookUrl)) return;
    if (changeCount === 0 && seedActivity === 0 && !this._config.discordNotifyWhenEmpty) return;
    const lines = [
      "NPC Market Liquidity update",
      `Time: ${new Date(nowMs).toISOString()}`,
      `Created: ${totals.created} | Replaced: ${totals.replaced} | ` +
        `Skipped: ${totals.skipped} | Failed: ${totals.failed}`,
      `Manifest fallback: ${totals.manifestFallback} | Calculated fallback: ${totals.calculatedFallback}`,
      `Player sell buyback: ${totals.buybackOrders} orders | ${totals.buybackQuantity} units | failed ${totals.buybackFailed}`,
      `Fuel seeds: created ${totals.seedCreated} | skipped ${totals.seedSkipped} | failed ${totals.seedFailed}`,
      ...hubs
        .filter((hub) => hub.created > 0 || hub.replaced > 0 || hub.skipped > 0 || hub.failed > 0 ||
          hub.buybackOrders > 0 || hub.buybackFailed > 0 ||
          hub.fuelSeed && (hub.fuelSeed.created > 0 || hub.fuelSeed.skipped > 0 || hub.fuelSeed.failed > 0))
        .map((hub) => `- ${hub.stationName} (${hub.stationID}): created ${hub.created}, replaced ${hub.replaced}, skipped ${hub.skipped}, failed ${hub.failed}; ` +
          `buyback ${hub.buybackOrders}/${hub.buybackQuantity}, buyback failed ${hub.buybackFailed}; ` +
          `fuel seeds created ${hub.fuelSeed.created}, skipped ${hub.fuelSeed.skipped}, failed ${hub.fuelSeed.failed}`),
    ];
    try {
      await sendWebhook(this._config.discordWebhookUrl, lines.join("\n"));
    } catch (error) {
      log.warn(`[${MOD_ID}] Discord notification failed: ${String(error && error.message || error)}`);
    }
  }

  async tick(options = {}) {
    const nowMs = typeof options === "number" && Number.isFinite(options)
      ? options
      : Date.now();
    const oreOnly = options && typeof options === "object" && options.oreOnly === true;
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
      manifestFallback: 0,
      calculatedFallback: 0,
      buybackEvaluated: 0,
      buybackAttempted: 0,
      buybackOrders: 0,
      buybackQuantity: 0,
      buybackFailed: 0,
    };
    const hubs = [];
    try {
      await this._ensureDaemonSupport();
      const items = oreOnly ? this._listOreItems() : this._listItems();
      const orderOverrides = oreOnly
        ? {
          priority: true,
          buyOnly: true,
          ordersPerItem: this._config.oreLiquidity.ordersPerItem,
          targetOrderVolumeM3: this._config.oreLiquidity.targetOrderVolumeM3,
          maximumOrderQuantity: this._config.oreLiquidity.maximumOrderQuantity,
          replaceIfQuantityBelow: true,
        }
        : {};
      const existing = await this._listExistingOrders();
      await this._cleanupDuplicateFuelOrders(existing);
      for (const stationID of this._config.hubStationIDs) {
        const station = this._loadHub(stationID);
        if (!oreOnly && this._config.shipLiquidity.enabled) {
          const shipResult = await this._processHub(
            station,
            this._listShipItems(),
            existing,
            nowMs,
            {
              mode: "ships",
              buyback: false,
              skipFuelSeeds: true,
              cursorKey: `ship:${stationID}`,
              itemsPerHubPerTick: this._config.shipLiquidity.itemsPerHubPerTick,
              ordersPerSide: this._config.shipLiquidity.ordersPerSide,
              targetOrderVolumeM3: this._config.shipLiquidity.targetOrderVolumeM3,
              maximumOrderQuantity: this._config.shipLiquidity.maximumOrderQuantity,
            },
          );
          hubs.push(shipResult);
          totals.created += shipResult.created;
          totals.replaced += shipResult.replaced;
          totals.skipped += shipResult.skipped;
          totals.failed += shipResult.failed;
          totals.manifestFallback += shipResult.manifestFallback;
          totals.calculatedFallback += shipResult.calculatedFallback;
        }
        if (!oreOnly && this._config.resourceLiquidity.enabled) {
          const resourceResult = await this._processHub(
            station,
            this._listResourceItems(),
            existing,
            nowMs,
            {
              mode: "resource",
              priority: true,
              buyback: true,
              ordersPerItem: this._config.ordersPerSide,
              replaceIfQuantityBelow: true,
            },
          );
          hubs.push(resourceResult);
          totals.created += resourceResult.created;
          totals.replaced += resourceResult.replaced;
          totals.skipped += resourceResult.skipped;
          totals.failed += resourceResult.failed;
          totals.manifestFallback += resourceResult.manifestFallback;
          totals.calculatedFallback += resourceResult.calculatedFallback;
          totals.buybackEvaluated += resourceResult.buybackEvaluated;
          totals.buybackAttempted += resourceResult.buybackAttempted;
          totals.buybackOrders += resourceResult.buybackOrders;
          totals.buybackQuantity += resourceResult.buybackQuantity;
          totals.buybackFailed += resourceResult.buybackFailed;
          totals.seedCreated += resourceResult.fuelSeed.created;
          totals.seedSkipped += resourceResult.fuelSeed.skipped;
          totals.seedFailed += resourceResult.fuelSeed.failed;
        }
        const result = await this._processHub(
          station,
          items,
          existing,
          nowMs,
          {...orderOverrides, buyback: !oreOnly},
        );
        hubs.push(result);
        totals.created += result.created;
        totals.replaced += result.replaced;
        totals.skipped += result.skipped;
        totals.failed += result.failed;
        totals.manifestFallback += result.manifestFallback;
        totals.calculatedFallback += result.calculatedFallback;
        totals.buybackEvaluated += result.buybackEvaluated;
        totals.buybackAttempted += result.buybackAttempted;
        totals.buybackOrders += result.buybackOrders;
        totals.buybackQuantity += result.buybackQuantity;
        totals.buybackFailed += result.buybackFailed;
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
  buybackChance,
  buybackPriceScore,
  buybackReferencePrice,
  isPlayerSellOrder,
  resourceOrderOverrides,
  registerManagedOrderID,
  rewriteLegacyOrderSources,
};
