"use strict";

const crypto = require("node:crypto");

const GENERATOR_ID = "cosmeticStoreSeeder";
const MOD_VERSION = "0.1.0";
const LEGACY_STORE_ID = 4;
const DEFAULT_IMAGE_URL = "res:/ui/texture/icons/7_64_15.png";
const DEFAULT_SKIN_IMAGE_URL = "res:/UI/Texture/Icons/SKINR.png";

const DEFAULT_CONFIG = {
  enabled: true,
  seedVersion: 1,
  priceSeed: "cosmetic-store-v1",
  categories: {
    skins: 9000005,
    apparel: 9000006,
  },
  permanentSkinGroupID: 1950,
  apparelCategoryID: 30,
  apparelGroupIDs: [1083, 1084, 1088, 1089, 1090, 1091, 1092],
  priceRanges: {
    skin: { min: 25, max: 250 },
    apparel: { min: 5, max: 50 },
  },
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function toBoolean(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function normalizeRange(value, fallback) {
  const source = isObject(value) ? value : {};
  const fallbackMin = toPositiveInteger(fallback.min, 1);
  const fallbackMax = Math.max(
    fallbackMin,
    toPositiveInteger(fallback.max, fallbackMin),
  );
  const min = toPositiveInteger(source.min, fallbackMin);
  const max = Math.max(min, toPositiveInteger(source.max, fallbackMax));
  return { min, max };
}

function normalizeConfig(input = {}) {
  const source = isObject(input) ? input : {};
  const sourceCategories = isObject(source.categories) ? source.categories : {};
  const sourceRanges = isObject(source.priceRanges) ? source.priceRanges : {};
  const configuredGroups = Array.isArray(source.apparelGroupIDs)
    ? source.apparelGroupIDs
        .map((value) => toPositiveInteger(value, 0))
        .filter(Boolean)
    : DEFAULT_CONFIG.apparelGroupIDs;

  return {
    enabled: toBoolean(source.enabled, DEFAULT_CONFIG.enabled),
    seedVersion: toPositiveInteger(
      source.seedVersion,
      DEFAULT_CONFIG.seedVersion,
    ),
    priceSeed:
      typeof source.priceSeed === "string" && source.priceSeed.trim()
        ? source.priceSeed.trim()
        : DEFAULT_CONFIG.priceSeed,
    categories: {
      skins: toPositiveInteger(
        sourceCategories.skins,
        DEFAULT_CONFIG.categories.skins,
      ),
      apparel: toPositiveInteger(
        sourceCategories.apparel,
        DEFAULT_CONFIG.categories.apparel,
      ),
    },
    permanentSkinGroupID: toPositiveInteger(
      source.permanentSkinGroupID,
      DEFAULT_CONFIG.permanentSkinGroupID,
    ),
    apparelCategoryID: toPositiveInteger(
      source.apparelCategoryID,
      DEFAULT_CONFIG.apparelCategoryID,
    ),
    apparelGroupIDs: [...new Set(configuredGroups)],
    priceRanges: {
      skin: normalizeRange(
        sourceRanges.skin,
        DEFAULT_CONFIG.priceRanges.skin,
      ),
      apparel: normalizeRange(
        sourceRanges.apparel,
        DEFAULT_CONFIG.priceRanges.apparel,
      ),
    },
  };
}

function hashToInt(seed, kind, typeID) {
  const digest = crypto
    .createHash("sha256")
    .update(String(seed) + "|" + String(kind) + "|" + String(typeID))
    .digest();
  return digest.readUInt32BE(0);
}

function deterministicPrice(kind, typeID, config = DEFAULT_CONFIG) {
  const normalized = normalizeConfig(config);
  const range =
    kind === "skin"
      ? normalized.priceRanges.skin
      : normalized.priceRanges.apparel;
  const span = range.max - range.min + 1;
  return range.min + hashToInt(normalized.priceSeed, kind, typeID) % span;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function getIconUrl(item, itemIconsRoot, kind = "") {
  const iconMap =
    itemIconsRoot && isObject(itemIconsRoot.iconsByID)
      ? itemIconsRoot.iconsByID
      : {};
  const iconID = item && item.iconID;
  const iconURL =
    iconID === null || iconID === undefined
      ? ""
      : iconMap[String(iconID)] || iconMap[iconID];
  return typeof iconURL === "string" && iconURL.trim()
    ? iconURL.trim()
    : kind === "skin"
      ? DEFAULT_SKIN_IMAGE_URL
      : DEFAULT_IMAGE_URL;
}

function findLicenseEntry(typeID, shipCosmeticsCatalogRoot) {
  const licenseMap =
    shipCosmeticsCatalogRoot &&
    isObject(shipCosmeticsCatalogRoot.licenseTypesByTypeID)
      ? shipCosmeticsCatalogRoot.licenseTypesByTypeID
      : {};
  const direct = licenseMap[String(typeID)] || licenseMap[typeID];
  if (direct) return direct;
  return (
    Object.values(licenseMap).find(
      (entry) =>
        toPositiveInteger(entry && entry.licenseTypeID, 0) === typeID,
    ) || null
  );
}

function collectCosmeticEntries(options = {}) {
  const config = normalizeConfig(options.config);
  const itemTypesRoot = options.itemTypesRoot || {};
  const shipCosmeticsCatalogRoot = options.shipCosmeticsCatalogRoot || {};
  const itemIconsRoot = options.itemIconsRoot || {};
  const itemTypes = Array.isArray(itemTypesRoot.types)
    ? itemTypesRoot.types
    : [];
  const apparelGroups = new Set(config.apparelGroupIDs);
  const entries = [];

  for (const item of itemTypes) {
    const typeID = toPositiveInteger(item && item.typeID, 0);
    if (!typeID || item.published === false) {
      continue;
    }

    const groupID = toPositiveInteger(item.groupID, 0);
    const categoryID = toPositiveInteger(item.categoryID, 0);
    const isPermanentSkin =
      groupID === config.permanentSkinGroupID && categoryID === 91;

    if (isPermanentSkin) {
      const license = findLicenseEntry(typeID, shipCosmeticsCatalogRoot);
      if (
        !license ||
        Number(license.duration) !== -1 ||
        license.published === false ||
        license.groupPublished === false ||
        license.missingSkinDefinition === true
      ) {
        continue;
      }
      entries.push({
        kind: "skin",
        typeID,
        name: String(item.name || license.typeName || ("SKIN " + typeID)),
        groupID,
        groupName: String(
          item.groupName || license.groupName || "Permanent SKIN",
        ),
        imageUrl: getIconUrl(item, itemIconsRoot, "skin"),
        skinID: toPositiveInteger(license.skinID, 0),
        skinMaterialID: toPositiveInteger(license.skinMaterialID, 0),
        licenseTypeID: toPositiveInteger(license.licenseTypeID, typeID),
      });
      continue;
    }

    if (categoryID === config.apparelCategoryID && apparelGroups.has(groupID)) {
      entries.push({
        kind: "apparel",
        typeID,
        name: String(item.name || ("Appearance item " + typeID)),
        groupID,
        groupName: String(item.groupName || "Character Apparel"),
        imageUrl: getIconUrl(item, itemIconsRoot, "apparel"),
      });
    }
  }

  return entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "skin" ? -1 : 1;
    }
    return left.typeID - right.typeID;
  });
}

function categoryRecord(categoryID, kind) {
  const isSkin = kind === "skin";
  return {
    id: categoryID,
    name: isSkin ? "Ship SKINs" : "Apparel",
    href: "/store/4/categories/" + (isSkin ? "ship-skins" : "apparel"),
    parent: { id: 9000000 },
    tags: isSkin ? ["cosmetics", "skins"] : ["cosmetics", "apparel"],
  };
}

function buildDescription(entry) {
  return entry.kind === "skin"
    ? "Permanent ship SKIN license for " + entry.name + "."
    : "Character appearance item: " + entry.name + ".";
}

function buildProduct(entry, productID) {
  return {
    id: productID,
    typeId: entry.typeID,
    quantity: 1,
    productName: entry.name,
    imageUrl: entry.imageUrl,
  };
}

function buildPreview(entry, description) {
  return entry.kind === "skin"
    ? {
        imageMode: "generated",
        accent: "#3aa9d9",
        secondary: "#12364a",
        foreground: "#effbff",
        badge: "SKIN",
        title: entry.name,
        subtitle: description,
      }
    : {
        imageMode: "generated",
        accent: "#d28dff",
        secondary: "#351b4d",
        foreground: "#fff5ff",
        badge: "APPAREL",
        title: entry.name,
        subtitle: description,
      };
}

function buildGeneratedOffer(entry, options = {}) {
  const config = normalizeConfig(options.config);
  const offerKey =
    "cosmetic_" + entry.kind + "_" + String(entry.typeID);
  const price = toPositiveInteger(
    options.pricePlex,
    deterministicPrice(entry.kind, entry.typeID, config),
  );
  const description = buildDescription(entry);
  const categoryID =
    entry.kind === "skin"
      ? config.categories.skins
      : config.categories.apparel;
  const product = buildProduct(
    entry,
    toPositiveInteger(options.productID, 1),
  );

  return {
    id: toPositiveInteger(options.offerID, 1),
    storeOfferID: offerKey,
    name: entry.name,
    description,
    href: "/store/4/offers/" + slugify(offerKey),
    offerPricings: [
      {
        currency: "PLX",
        price,
        basePrice: price,
      },
    ],
    imageUrl: entry.imageUrl,
    products: [product],
    categories: [{ id: categoryID }],
    // The legacy client treats label as a structured object. A plain string
    // makes create_label_from_json index into text and crashes the store UI.
    label: null,
    thirdpartyinfo: null,
    canPurchase: true,
    singlePurchase: false,
    tags:
      entry.kind === "skin"
        ? ["cosmetics", "skins"]
        : ["cosmetics", "apparel"],
    preview: buildPreview(entry, description),
    fulfillment: {
      kind: "item",
      typeID: entry.typeID,
      quantity: 1,
    },
    generator: {
      id: GENERATOR_ID,
      version: String(options.version || MOD_VERSION),
      seedVersion: config.seedVersion,
      kind: entry.kind,
      typeID: entry.typeID,
      pricePlex: price,
      active: true,
    },
  };
}

function isGeneratedOffer(offer) {
  if (!isObject(offer)) return false;
  if (offer.generator && offer.generator.id === GENERATOR_ID) return true;
  const storeOfferID = String(offer.storeOfferID || "");
  return (
    storeOfferID.indexOf("cosmetic_skin_") === 0 ||
    storeOfferID.indexOf("cosmetic_apparel_") === 0
  );
}

function getOfferKey(offer) {
  return String(offer && offer.storeOfferID ? offer.storeOfferID : "");
}

function getPlexPrice(offer, fallback) {
  const generatedPrice = toPositiveInteger(
    offer && offer.generator && offer.generator.pricePlex,
    0,
  );
  if (generatedPrice) return generatedPrice;
  const pricing = Array.isArray(offer && offer.offerPricings)
    ? offer.offerPricings.find(
        (value) =>
          String((value && value.currency) || "").toUpperCase() === "PLX" &&
          toPositiveInteger(value && value.price, 0),
      )
    : null;
  return toPositiveInteger(pricing && pricing.price, fallback);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureStore(authority) {
  const next = isObject(authority) ? authority : {};
  if (!isObject(next.meta)) next.meta = {};
  if (!isObject(next.config)) next.config = {};
  if (!isObject(next.stores)) next.stores = {};
  if (!isObject(next.publicOffers)) next.publicOffers = {};
  if (!isObject(next.fastCheckout)) next.fastCheckout = {};

  const existing = isObject(next.stores[String(LEGACY_STORE_ID)])
    ? next.stores[String(LEGACY_STORE_ID)]
    : {};
  existing.storeID = toPositiveInteger(existing.storeID, LEGACY_STORE_ID);
  existing.name = String(existing.name || "New Eden Store");
  existing.categories = ensureArray(existing.categories);
  existing.products = ensureArray(existing.products);
  existing.offers = ensureArray(existing.offers);
  next.stores[String(LEGACY_STORE_ID)] = existing;
  return { authority: next, store: existing };
}

function ensureCategory(store, categoryID, kind) {
  const found = store.categories.some(
    (category) => toPositiveInteger(category && category.id, 0) === categoryID,
  );
  if (!found) {
    store.categories.push(categoryRecord(categoryID, kind));
  }
}

function maxNumericID(records) {
  return ensureArray(records).reduce(
    (maximum, record) =>
      Math.max(maximum, toPositiveInteger(record && record.id, 0)),
    0,
  );
}

function findProductIndex(store, productID) {
  return store.products.findIndex(
    (product) => toPositiveInteger(product && product.id, 0) === productID,
  );
}

function updateGeneratedOffer(store, offer, entry, options = {}) {
  const config = normalizeConfig(options.config);
  const fallbackPrice = deterministicPrice(entry.kind, entry.typeID, config);
  const price = getPlexPrice(offer, fallbackPrice);
  const currentProductID =
    toPositiveInteger(
      offer && Array.isArray(offer.products) && offer.products[0]
        ? offer.products[0].id
        : 0,
      0,
    ) || toPositiveInteger(options.productID, 1);
  const currentOfferID = toPositiveInteger(
    offer && offer.id,
    options.offerID || 1,
  );
  const replacement = buildGeneratedOffer(entry, {
    config,
    offerID: currentOfferID,
    productID: currentProductID,
    pricePlex: price,
    version: options.version,
  });
  Object.assign(offer, replacement);

  const productIndex = findProductIndex(store, currentProductID);
  if (productIndex >= 0) {
    Object.assign(store.products[productIndex], replacement.products[0]);
  } else {
    store.products.push(replacement.products[0]);
  }
  return offer;
}

function reconcileAuthority(authority, entries, options = {}) {
  const config = normalizeConfig(options.config);
  const version = String(options.version || MOD_VERSION);
  const before = cloneValue(authority || {});
  const ensured = ensureStore(cloneValue(authority || {}));
  const nextAuthority = ensured.authority;
  const store = ensured.store;
  ensureCategory(store, config.categories.skins, "skin");
  ensureCategory(store, config.categories.apparel, "apparel");

  const offers = store.offers;
  const generatedByKey = new Map();
  const manualItemTypeIDs = new Set();
  for (const offer of offers) {
    if (isGeneratedOffer(offer)) {
      const key = getOfferKey(offer);
      if (key && !generatedByKey.has(key)) {
        generatedByKey.set(key, offer);
      }
      continue;
    }
    const fulfillment = offer && offer.fulfillment;
    if (fulfillment && String(fulfillment.kind || "") === "item") {
      const typeID = toPositiveInteger(fulfillment.typeID, 0);
      if (typeID) manualItemTypeIDs.add(typeID);
    }
  }

  let nextOfferID = maxNumericID(offers) + 1;
  let nextProductID = maxNumericID(store.products) + 1;
  const activeKeys = new Set();
  const summary = {
    discovered: Array.isArray(entries) ? entries.length : 0,
    created: 0,
    updated: 0,
    skippedExisting: 0,
    deprecated: 0,
    active: 0,
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalizedTypeID = toPositiveInteger(entry && entry.typeID, 0);
    if (
      !normalizedTypeID ||
      (entry.kind !== "skin" && entry.kind !== "apparel")
    ) {
      continue;
    }
    const normalizedEntry = {
      ...entry,
      typeID: normalizedTypeID,
      name: String(entry.name || ("Cosmetic item " + normalizedTypeID)),
      imageUrl:
        typeof entry.imageUrl === "string" && entry.imageUrl.trim()
          ? entry.imageUrl
          : DEFAULT_IMAGE_URL,
    };
    const key =
      "cosmetic_" + normalizedEntry.kind + "_" + String(normalizedTypeID);
    const existingGenerated = generatedByKey.get(key);
    if (existingGenerated) {
      updateGeneratedOffer(store, existingGenerated, normalizedEntry, {
        config,
        version,
      });
      activeKeys.add(key);
      summary.updated += 1;
      continue;
    }
    if (manualItemTypeIDs.has(normalizedTypeID)) {
      summary.skippedExisting += 1;
      continue;
    }

    const offer = buildGeneratedOffer(normalizedEntry, {
      config,
      offerID: nextOfferID,
      productID: nextProductID,
      version,
    });
    nextOfferID += 1;
    nextProductID += 1;
    offers.push(offer);
    store.products.push(offer.products[0]);
    activeKeys.add(key);
    summary.created += 1;
  }

  for (const offer of offers) {
    if (!isGeneratedOffer(offer)) continue;
    const key = getOfferKey(offer);
    if (activeKeys.has(key)) {
      if (offer.canPurchase !== true) {
        offer.canPurchase = true;
      }
      if (offer.generator && offer.generator.active !== true) {
        offer.generator.active = true;
      }
      continue;
    }
    const wasActive =
      offer.canPurchase !== false ||
      !(
        offer.tags &&
        Array.isArray(offer.tags) &&
        offer.tags.includes("deprecated")
      );
    offer.canPurchase = false;
    offer.tags = ensureArray(offer.tags);
    if (!offer.tags.includes("deprecated")) {
      offer.tags.push("deprecated");
    }
    offer.generator = isObject(offer.generator)
      ? offer.generator
      : { id: GENERATOR_ID };
    offer.generator.active = false;
    if (wasActive) summary.deprecated += 1;
  }

  summary.active = offers.filter(
    (offer) => isGeneratedOffer(offer) && offer.canPurchase !== false,
  ).length;
  nextAuthority.meta.cosmeticStoreSeeder = {
    id: GENERATOR_ID,
    version,
    seedVersion: config.seedVersion,
    generatedOfferCount: summary.active,
  };

  return {
    authority: nextAuthority,
    summary,
    changed: JSON.stringify(before) !== JSON.stringify(nextAuthority),
  };
}

function readDatabaseTable(database, tableName) {
  if (!database || typeof database.read !== "function") {
    throw new Error("GameStore database API is unavailable");
  }
  const result = database.read(tableName, "/");
  if (!result || result.success !== true || !result.data) {
    throw new Error(
      "Unable to read " +
        tableName +
        ": " +
        String((result && result.errorMsg) || "READ_FAILED"),
    );
  }
  return cloneValue(result.data);
}

function seedCosmeticStore(options = {}) {
  const config = normalizeConfig(options.config);
  if (!config.enabled) {
    return { success: true, skipped: true, reason: "DISABLED" };
  }
  const database = options.database;
  const itemTypesRoot = readDatabaseTable(database, "itemTypes");
  const shipCosmeticsCatalogRoot = readDatabaseTable(
    database,
    "shipCosmeticsCatalog",
  );
  const itemIconsRoot = readDatabaseTable(database, "itemIcons");
  if (
    !Array.isArray(itemTypesRoot.types) ||
    !isObject(shipCosmeticsCatalogRoot.licenseTypesByTypeID)
  ) {
    throw new Error("Cosmetic catalog tables are incomplete");
  }

  const entries = collectCosmeticEntries({
    itemTypesRoot,
    shipCosmeticsCatalogRoot,
    itemIconsRoot,
    config,
  });
  const currentAuthority = readDatabaseTable(database, "newEdenStore");
  const reconciliation = reconcileAuthority(currentAuthority, entries, {
    config,
    version: options.version || MOD_VERSION,
  });
  if (!reconciliation.changed) {
    return {
      success: true,
      changed: false,
      entries,
      summary: reconciliation.summary,
    };
  }

  if (typeof database.write !== "function") {
    throw new Error("GameStore write API is unavailable");
  }
  const writeResult = database.write(
    "newEdenStore",
    "/",
    reconciliation.authority,
    { force: true },
  );
  if (!writeResult || writeResult.success !== true) {
    throw new Error(
      "Unable to write newEdenStore: " +
        String((writeResult && writeResult.errorMsg) || "WRITE_FAILED"),
    );
  }
  if (typeof database.flushTableSync === "function") {
    const flushResult = database.flushTableSync("newEdenStore");
    if (!flushResult || flushResult.success !== true) {
      throw new Error(
        "Unable to flush newEdenStore: " +
          String((flushResult && flushResult.errorMsg) || "FLUSH_FAILED"),
      );
    }
  }
  try {
    const storeState = require(
      "../../../server/src/services/newEdenStore/storeState",
    );
    if (storeState && typeof storeState.resetStoreCaches === "function") {
      storeState.resetStoreCaches();
    }
  } catch (_) {
    // The write is durable even if the service cache module was not loaded yet.
  }
  return {
    success: true,
    changed: true,
    entries,
    summary: reconciliation.summary,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_URL,
  DEFAULT_SKIN_IMAGE_URL,
  GENERATOR_ID,
  MOD_VERSION,
  buildGeneratedOffer,
  collectCosmeticEntries,
  deterministicPrice,
  isGeneratedOffer,
  normalizeConfig,
  reconcileAuthority,
  seedCosmeticStore,
};
