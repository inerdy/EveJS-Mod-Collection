"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const shippedConfig = JSON.parse(
  fs.readFileSync(path.join(modRoot, "config", "cosmetics.json"), "utf8"),
);
for (const file of [".gitignore", "CHANGELOG.md", "LICENSE", "README.md", "loader.js"]) {
  assert.equal(fs.existsSync(path.join(modRoot, file)), true, `missing ${file}`);
}
assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "cosmeticstoreseeder");
assert.equal(manifest.displayName, "Cosmetic Store Seeder");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.equal(shippedConfig.enabled, true);
assert.equal(shippedConfig.seedVersion, 1);
assert.equal(shippedConfig.priceRanges.skin.min, 25);
assert.equal(shippedConfig.priceRanges.skin.max, 250);
assert.equal(shippedConfig.priceRanges.apparel.min, 5);
assert.equal(shippedConfig.priceRanges.apparel.max, 50);

const {
  collectCosmeticEntries,
  deterministicPrice,
  reconcileAuthority,
} = require("../lib/cosmeticStoreSeeder");

const config = {
  enabled: true,
  seedVersion: 1,
  priceSeed: "fixture-seed",
  categories: { skins: 9000005, apparel: 9000006 },
  permanentSkinGroupID: 1950,
  apparelCategoryID: 30,
  apparelGroupIDs: [1083, 1084, 1088, 1089, 1090, 1091, 1092],
  priceRanges: {
    skin: { min: 25, max: 250 },
    apparel: { min: 5, max: 50 },
  },
};

const entries = collectCosmeticEntries({
  config,
  itemTypesRoot: {
    types: [
      {
        typeID: 1001,
        groupID: 1950,
        categoryID: 91,
        name: "Fixture SKIN",
        groupName: "Permanent SKIN",
        iconID: null,
        published: true,
      },
      {
        typeID: 1002,
        groupID: 1950,
        categoryID: 91,
        name: "Manual SKIN",
        iconID: 1,
        published: true,
      },
      {
        typeID: 1003,
        groupID: 1952,
        categoryID: 91,
        name: "Timed SKIN",
        iconID: 1,
        published: true,
      },
      {
        typeID: 2001,
        groupID: 1089,
        categoryID: 30,
        name: "Fixture Top",
        iconID: 2,
        published: true,
      },
      {
        typeID: 2002,
        groupID: 1083,
        categoryID: 30,
        name: "Unpublished Glasses",
        iconID: 2,
        published: false,
      },
      {
        typeID: 3001,
        groupID: 9999,
        categoryID: 30,
        name: "Unsupported Item",
        iconID: 2,
        published: true,
      },
    ],
  },
  shipCosmeticsCatalogRoot: {
    licenseTypesByTypeID: {
      "1001": {
        licenseTypeID: 1001,
        duration: -1,
        published: true,
        groupPublished: true,
        skinID: 501,
        skinMaterialID: 601,
      },
      "1002": {
        licenseTypeID: 1002,
        duration: -1,
        published: true,
        groupPublished: true,
      },
      "1003": {
        licenseTypeID: 1003,
        duration: 30,
        published: true,
        groupPublished: true,
      },
    },
  },
  itemIconsRoot: {
    iconsByID: {
      "1": "res:/fixture/skin.png",
      "2": "res:/fixture/apparel.png",
    },
  },
});

assert.deepEqual(
  entries.map((entry) => entry.typeID),
  [1001, 1002, 2001],
);
assert.equal(entries[0].imageUrl, "res:/UI/Texture/Icons/SKINR.png");
assert.equal(
  deterministicPrice("skin", 1001, config),
  deterministicPrice("skin", 1001, config),
);
assert.ok(deterministicPrice("skin", 1001, config) >= 25);
assert.ok(deterministicPrice("skin", 1001, config) <= 250);
assert.ok(deterministicPrice("apparel", 2001, config) >= 5);
assert.ok(deterministicPrice("apparel", 2001, config) <= 50);

const authority = {
  meta: {},
  config: {},
  stores: {
    "4": {
      storeID: 4,
      name: "New Eden Store",
      categories: [{ id: 9000000, name: "Featured" }],
      products: [
        {
          id: 9100001,
          typeId: 1001,
          quantity: 1,
          productName: "Fixture SKIN",
        },
      ],
      offers: [
        {
          id: 9200001,
          storeOfferID: "cosmetic_skin_1001",
          offerPricings: [{ currency: "PLX", price: 123, basePrice: 123 }],
          products: [{ id: 9100001, typeId: 1001, quantity: 1 }],
          fulfillment: { kind: "item", typeID: 1001, quantity: 1 },
          generator: {
            id: "cosmeticStoreSeeder",
            pricePlex: 123,
            active: true,
          },
          canPurchase: true,
        },
        {
          id: 9200002,
          storeOfferID: "manual_skin",
          offerPricings: [{ currency: "PLX", price: 99, basePrice: 99 }],
          fulfillment: { kind: "item", typeID: 1002, quantity: 1 },
          canPurchase: true,
        },
        {
          id: 9200003,
          storeOfferID: "cosmetic_apparel_9999",
          products: [{ id: 9100003, typeId: 9999, quantity: 1 }],
          fulfillment: { kind: "item", typeID: 9999, quantity: 1 },
          generator: {
            id: "cosmeticStoreSeeder",
            pricePlex: 10,
            active: true,
          },
          canPurchase: true,
          tags: ["cosmetics"],
        },
      ],
    },
  },
  publicOffers: {},
  fastCheckout: {},
};

const first = reconcileAuthority(authority, entries, {
  config,
  version: "0.1.0",
});
const offers = first.authority.stores["4"].offers;
const byKey = new Map(offers.map((offer) => [offer.storeOfferID, offer]));

assert.equal(first.summary.created, 1);
assert.equal(first.summary.updated, 1);
assert.equal(first.summary.skippedExisting, 1);
assert.equal(first.summary.deprecated, 1);
assert.equal(byKey.get("cosmetic_skin_1001").offerPricings[0].price, 123);
assert.equal(byKey.get("cosmetic_skin_1001").label, null);
assert.equal(byKey.get("cosmetic_skin_1002"), undefined);
assert.equal(byKey.get("cosmetic_apparel_2001").fulfillment.typeID, 2001);
assert.equal(byKey.get("cosmetic_apparel_2001").label, null);
assert.equal(byKey.get("cosmetic_apparel_2001").canPurchase, true);
assert.equal(byKey.get("cosmetic_apparel_9999").canPurchase, false);
assert.ok(byKey.get("cosmetic_apparel_9999").tags.includes("deprecated"));

const second = reconcileAuthority(first.authority, entries, {
  config,
  version: "0.1.0",
});
assert.deepEqual(second.authority, first.authority);

console.log(
  "cosmeticStoreSeeder fixture validation passed: " +
    entries.length +
    " catalog entries, stable reconciliation, and safe deprecation.",
);
