"use strict";

// Executes EveJS's actual purchase matching and seeded-fill saga, with only
// persistence, wallets, inventory, and unrelated services held in memory.
const {loadModule, serverPath, quietLog} = require("./testHarness");

function createPurchaseHarness(marketDaemonClient) {
  const escrow = new Map();
  const inventory = [];
  const wallet = {balance: 10000000};
  const transactions = [];
  let nextSagaID = 1;
  const ok = () => ({success: true});
  const imports = {};
  for (const relative of [
    "services/corporation/corporationAuthority.js", "services/corporation/corpWalletState.js",
    "services/corporation/corporationRuntimeState.js", "services/industry/industryConstants.js",
    "services/industry/industryAccess.js", "services/inventory/itemCustody.js",
    "services/inventory/corporationOfficeInventoryObservers.js", "services/market/marketRuntimeState.js",
    "services/structure/structureConstants.js", "services/structure/structureServiceAuthority.js",
    "services/structure/structureProfilesState.js", "services/structure/structurePayloads.js",
    "services/cache/objectCacheRuntime.js",
  ]) imports[serverPath(relative)] = {};
  Object.assign(imports, {
    [serverPath("services/baseService.js")]: class BaseService {},
    [serverPath("utils/logger/index.js")]: quietLog,
    [serverPath("gameStore/index.js")]: {flushTableSync: ok},
    [serverPath("services/achievement/achievementRuntime.js")]: {recordMarketPurchase: ok, recordMarketSale: ok},
    [serverPath("common/machoErrors.js")]: {
      throwWrappedUserError: (name, details) => {throw new Error(details.info || name);},
      isMachoWrappedException: () => false,
    },
    [serverPath("services/_shared/serviceHelpers.js")]: {
      buildRowset: () => ({}), buildList: () => [], buildDict: () => ({}), buildKeyVal: () => ({}),
      normalizeBigInt: (value, fallback = 0n) => BigInt(value ?? fallback),
    },
    [serverPath("services/market/marketDaemonClient.js")]: {marketDaemonClient},
    [serverPath("services/account/walletState.js")]: {
      ACCOUNT_KEY: {CASH: 1000}, JOURNAL_ENTRY_TYPE: {MARKET_TRANSACTION: 2},
      getCharacterWallet: () => wallet,
      adjustCharacterBalanceAsync: async (_id, amount) => {
        wallet.balance = Math.round((wallet.balance + amount) * 100) / 100;
        return {success: true};
      },
      appendCharacterMarketTransactionAsync: async (_id, entry) => {transactions.push(entry);},
    },
    [serverPath("services/inventory/itemStore.js")]: {ITEM_FLAGS: {HANGAR: 4}},
    [serverPath("services/inventory/marketItemCustody.js")]: {
      grantSeedItem: (request) => {
        const item = {...request, itemID: inventory.length + 1};
        inventory.push(item);
        return {success: true, data: {changes: [{item, created: true}]}};
      },
    },
    [serverPath("services/inventory/itemTypeRegistry.js")]: {
      resolveItemByTypeID: (typeID) => ({typeID, name: String(typeID), groupID: 1}),
    },
    [serverPath("services/raffles/raffleInventory.js")]: {notifyInventoryChangesToCharacter() {}},
    [serverPath("services/chat/sessionRegistry.js")]: {getSessions: () => []},
    [serverPath("services/market/marketEscrowState.js")]: {
      allocateMarketSagaIDDurable: () => ({success: true, sagaID: nextSagaID++, idempotencyNamespace: "native-npc-test"}),
      getEscrowRecord: (id) => escrow.get(String(id)),
      listEscrowRecords: () => [...escrow.values()],
      putEscrowRecordDurable: (record) => {escrow.set(String(record.orderId), record); return ok();},
      removeEscrowRecordDurable: (id) => {escrow.delete(String(id)); return ok();},
    },
    [serverPath("services/market/marketTopology.js")]: {
      isSellOrderInRange: (order, stationID) => Number(order.station_id) === stationID,
      isBidOrderInRange: (order, stationID) => Number(order.station_id) === stationID,
    },
    [serverPath("services/market/marketRules.js")]: {},
    [serverPath("services/_shared/stationStaticData.js")]: {getStationRecord: () => ({corporationID: 1000001})},
    [serverPath("services/structure/structureState.js")]: {getStructureByID: () => null, tickStructures: () => []},
  });
  const proxy = loadModule(serverPath("services/market/marketProxyService.js"), imports,
    "module.exports.testPurchase = matchSellOrdersForBuyer;");
  return {purchase: proxy.testPurchase, wallet, inventory, escrow, transactions};
}

module.exports = {createPurchaseHarness};
