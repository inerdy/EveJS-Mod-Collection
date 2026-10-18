"use strict";

const log = require(require("./runtime").serverPath("utils", "logger"));
const {
  FALLBACK_CARGO_TYPES,
  KNOWN_MINERAL_TYPE_IDS,
  KNOWN_PLANETARY_TYPE_IDS,
  buildHaulerCargo,
  listCargoTypes,
  mergeKnownCargoTypes,
  resolveCargoCapacityM3,
} = require("./haulerCargo");
const {MOD_ID} = require("./constants");
const {finite, positive} = require("./util");

function resolveCargoCatalog(service, dependencies) {
  if (
    service._cargoCatalog &&
    (
      service._cargoCatalog.minerals.length > 0 ||
      service._cargoCatalog.planetary.length > 0
    )
  ) {
    return service._cargoCatalog;
  }
  const listItemTypes = dependencies.itemTypes && dependencies.itemTypes.listItemTypes;
  const itemTypes = typeof listItemTypes === "function" ? listItemTypes() : [];
  const resolveItemByTypeID = dependencies.itemTypes &&
    dependencies.itemTypes.resolveItemByTypeID;
  const knownTypes = [];
  if (typeof resolveItemByTypeID === "function") {
    for (const typeID of [...KNOWN_MINERAL_TYPE_IDS, ...KNOWN_PLANETARY_TYPE_IDS]) {
      const entry = resolveItemByTypeID(typeID);
      if (entry) {
        knownTypes.push(entry);
      }
    }
  }
  const catalog = mergeKnownCargoTypes(
    mergeKnownCargoTypes(listCargoTypes(itemTypes), knownTypes),
    FALLBACK_CARGO_TYPES,
  );
  if (catalog.minerals.length > 0 || catalog.planetary.length > 0) {
    service._cargoCatalog = catalog;
  }
  return catalog;
}

function storeHaulerCargo(entity, record, dependencies) {
  const stacks = Array.isArray(record && record.pendingWreckCargo)
    ? record.pendingWreckCargo
    : [];
  const entityID = positive(entity && entity.itemID, 0);
  const upsert = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.upsertNativeCargo;
  const allocate = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.allocateCargoID;
  const listCargo = dependencies &&
    dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.listNativeCargoForEntity;
  if (!entityID || stacks.length === 0 || typeof upsert !== "function" || typeof allocate !== "function") {
    return 0;
  }
  const stored = typeof listCargo === "function" ? listCargo(entityID) : [];
  const storedTypes = new Set(stored.map((row) => positive(row && row.typeID, 0)));
  let storedCount = 0;
  for (const stack of stacks) {
    const typeID = positive(stack && stack.typeID, 0);
    if (!typeID || storedTypes.has(typeID)) {
      continue;
    }
    const allocated = allocate({transient: entity.transient === true});
    const cargoID = allocated && allocated.success === true ? positive(allocated.data, 0) : 0;
    if (!cargoID) {
      continue;
    }
    const writeResult = upsert({
      cargoID,
      entityID,
      ownerID: positive(entity.ownerID || entity.characterID, 0),
      moduleID: 0,
      typeID,
      groupID: positive(stack.groupID, 0),
      categoryID: positive(stack.categoryID, 0),
      itemName: String(stack.itemName || "Item"),
      quantity: positive(stack.quantity, 1),
      singleton: false,
      flagID: positive(stack.flagID, 5),
      transient: entity.transient === true,
    }, {
      transient: entity.transient === true,
    });
    if (writeResult && writeResult.success === true) {
      storedCount += 1;
      storedTypes.add(typeID);
    }
  }
  return storedCount;
}

function loadHaulerCargoFromCatalog(service, entity, record, dependencies) {
  const entityID = positive(entity.itemID, 0);
  const listCargo = dependencies.nativeNpcStore &&
    dependencies.nativeNpcStore.listNativeCargoForEntity;
  if (typeof listCargo === "function") {
    const stored = listCargo(entityID).filter((row) => (
      positive(row && row.moduleID, 0) === 0 &&
      positive(row && row.quantity, 0) > 0
    ));
    if (stored.length > 0) {
      record.cargoLoaded = true;
      if (!Array.isArray(record.pendingWreckCargo) || record.pendingWreckCargo.length === 0) {
        record.pendingWreckCargo = stored.map((row) => ({
          typeID: positive(row.typeID, 0),
          groupID: positive(row.groupID, 0),
          categoryID: positive(row.categoryID, 0),
          itemName: String(row.itemName || "Item"),
          quantity: positive(row.quantity, 0),
          volume: finite(row.volume, 0.01) || 0.01,
        }));
      }
      return;
    }
  }

  record.cargoAttempts = finite(record.cargoAttempts, 0) + 1;
  const catalog = resolveCargoCatalog(service, dependencies);
  const typeRecord = dependencies.itemTypes &&
    typeof dependencies.itemTypes.resolveItemByTypeID === "function"
    ? dependencies.itemTypes.resolveItemByTypeID(positive(entity.typeID, 0))
    : null;
  const attributes = entity.passiveDerivedState && entity.passiveDerivedState.attributes;
  const stacks = buildHaulerCargo({
    seed: `${record.seed}:cargo:${record.legIndex}`,
    capacityM3: resolveCargoCapacityM3([
      typeRecord && typeRecord.capacity,
      attributes && (attributes[38] ?? attributes["38"]),
      entity.capacity,
    ]),
    mineralTypes: catalog.minerals,
    planetaryTypes: catalog.planetary,
  });
  if (stacks.length === 0) {
    log.warn(
      `[${MOD_ID}] cargo catalog empty entity=${entityID} profile=${record.profileID}`,
    );
    return;
  }
  record.pendingWreckCargo = stacks.map((stack) => ({...stack}));

  const kept = (Array.isArray(entity.nativeCargoItems) ? entity.nativeCargoItems : [])
    .filter((item) => positive(item && item.moduleID, 0) > 0);
  const loaded = [];
  let storedCount = 0;
  for (const stack of stacks) {
    const allocated = dependencies.nativeNpcStore &&
      typeof dependencies.nativeNpcStore.allocateCargoID === "function"
      ? dependencies.nativeNpcStore.allocateCargoID({transient: entity.transient === true})
      : null;
    const cargoID = allocated && allocated.success === true
      ? positive(allocated.data, 0)
      : 0;
    const itemID = cargoID > 0 ? cargoID : -(loaded.length + 1);
    const cargoItem = {
      itemID,
      ownerID: positive(entity.ownerID || entity.characterID, 0),
      locationID: entityID,
      moduleID: 0,
      typeID: stack.typeID,
      groupID: stack.groupID,
      categoryID: stack.categoryID,
      quantity: stack.quantity,
      stacksize: stack.quantity,
      singleton: 0,
      flagID: stack.flagID,
      itemName: stack.itemName,
      volume: stack.volume,
    };
    loaded.push(cargoItem);
    if (
      cargoID <= 0 ||
      !dependencies.nativeNpcStore ||
      typeof dependencies.nativeNpcStore.upsertNativeCargo !== "function"
    ) {
      continue;
    }
    const writeResult = dependencies.nativeNpcStore.upsertNativeCargo({
      cargoID,
      entityID,
      ownerID: cargoItem.ownerID,
      moduleID: 0,
      typeID: stack.typeID,
      groupID: stack.groupID,
      categoryID: stack.categoryID,
      itemName: stack.itemName,
      quantity: stack.quantity,
      singleton: false,
      flagID: stack.flagID,
      transient: entity.transient === true,
    }, {
      transient: entity.transient === true,
    });
    if (writeResult && writeResult.success === true) {
      storedCount += 1;
    } else {
      log.warn(
        `[${MOD_ID}] cargo store failed entity=${entityID} type=${stack.typeID} ` +
        `reason=${writeResult && writeResult.errorMsg || "UNKNOWN"}`,
      );
    }
  }
  entity.nativeCargoItems = kept.concat(loaded);
  if (storedCount > 0) {
    record.cargoLoaded = true;
  }
  log.info(
    `[${MOD_ID}] cargo entity=${entityID} stacks=${loaded.length} stored=${storedCount} ` +
    `profile=${record.profileID}`,
  );
}

function loadHaulerCargo(service, entity, record, dependencies) {
  try {
    loadHaulerCargoFromCatalog(service, entity, record, dependencies);
  } catch (error) {
    record.cargoAttempts = finite(record.cargoAttempts, 0) + 1;
    log.warn(
      `[${MOD_ID}] cargo load failed entity=${entity && entity.itemID} ` +
      `profile=${record.profileID}: ${error.message}`,
    );
  }
}

module.exports = {
  loadHaulerCargo,
  resolveCargoCatalog,
  storeHaulerCargo,
};
