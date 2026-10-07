"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const rawConfig = JSON.parse(
  fs.readFileSync(path.join(modRoot, "config", "contracts.json"), "utf8"),
);
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const {
  buildGraph,
  hashUnit,
  listEligibleStations,
  selectDestination,
  shortestJumpDistance,
} = require(path.join(modRoot, "lib", "routePlanner"));
const {
  calculateCollateral,
  calculateDeliveryDays,
  calculateReward,
} = require(path.join(modRoot, "lib", "reward"));
const {
  createStateStore,
  normalizeState,
} = require(path.join(modRoot, "lib", "state"));
const serviceClass = require(path.join(modRoot, "lib", "npcCourierContractsService"));
const {buildSnapshot} = require(path.join(modRoot, "lib", "haulerProgression"));
const serverLogger = require(path.resolve(modRoot, "..", "..", "server", "src", "utils", "logger"));
const loaderSource = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
const clientSource = fs.readFileSync(path.join(modRoot, "client", "menu.py"), "utf8");
const serviceSource = fs.readFileSync(path.join(modRoot, "lib", "npcCourierContractsService.js"), "utf8");

const packageFiles = [];
function collectFiles(directory, prefix) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name === ".git") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    const entryPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(entryPath, entryPrefix);
    } else {
      packageFiles.push(entryPrefix.replace(/\\/gu, "/"));
    }
  }
}
collectFiles(modRoot, "");

assert.deepEqual(packageFiles.sort(), [
  "LICENSE",
  "README.md",
  "client/menu.py",
  "config/contracts.json",
  "evejs-launcher.mod.json",
  "lib/config.js",
  "lib/haulerProgression.js",
  "lib/npcCourierContractsService.js",
  "lib/reward.js",
  "lib/routePlanner.js",
  "lib/state.js",
  "loader.js",
  "test/validate.js",
]);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "npccouriercontracts");
assert.equal(manifest.displayName, "NPC Courier Contracts");
assert.equal(manifest.version, "0.6.4");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.deepEqual(manifest.clientMenu, {
  apiVersion: 1,
  entrypoint: "client/menu.py",
});
assert.match(loaderSource, /contractProxyService\.js/u);
assert.match(loaderSource, /dockSession/u);
assert.match(loaderSource, /patchCachedModule/u);
assert.match(clientSource, /GetAutomationState/u);
assert.match(clientSource, /SetAutomationSettings/u);
assert.match(clientSource, /clear_other_waypoints/u);
assert.match(clientSource, /system_set/u);
assert.match(clientSource, /_last_route_key/u);
assert.match(clientSource, /destinationStationID/u);
assert.match(clientSource, /'starmap', 'map', 'autoPilot', 'autopilot'/u);
assert.match(clientSource, /ScrollContainer/u);
assert.match(clientSource, /OnNpcCourierContractsAutomation/u);
assert.match(clientSource, /_poll_automation/u);
assert.match(serviceSource, /session\.stationid2/u);
assert.equal(clientSource.includes('OnRemoteMessage'), false);

const config = normalizeConfig(rawConfig);
assert.equal(config.enabled, true);
assert.equal(config.clearExistingContractsOnce, true);
assert.equal(config.wipeAllActiveContractsOnce, true);
assert.equal(config.legacyCleanupVersion, 5);
assert.equal(config.haulerProgression.maxLevel, 50);
assert.equal(config.haulerProgression.baseXPPerContract, 100);
assert.equal(config.haulerProgression.xpPerJump, 10);
assert.equal(config.haulerProgression.payoutBonusPerLevel, 0.03);
assert.equal(config.haulerProgression.xpToNextLevelBase, 1000);
assert.equal(config.haulerProgression.xpToNextLevelPerLevel, 250);
assert.equal(config.initialDelayMs, 30000);
assert.equal(config.tickIntervalMs, 300000);
assert.equal(config.contractsPerOrigin, 10);
assert.equal(config.maxOutstandingContracts, 200);
assert.equal(config.generateReturnContracts, true);
assert.equal(config.shortHaulChance, 0.35);
assert.equal(config.shortHaulMaxJumps, 5);
assert.equal(config.reward.perJumpISK, 450000);
assert.deepEqual(config.hubStationIDs, [60003760, 60008494, 60011866, 60004588, 60005686]);
assert.deepEqual(config.allowedSecurityClasses, ["high"]);
assert.equal(config.treasury.targetBalanceISK, 50000000000);
assert.equal(config.treasury.replenishThresholdRatio, 0.2);
assert.equal(config.issuer.corporationID, 1000148);
assert.equal(config.issuer.characterID, 3015955);
assert.equal(config.cargoCatalog.length, 5);
assert.equal(config.cargo.referenceVolumeM3, 10000);
assert.equal(config.cargo.minimumLoadFraction, 0.25);
assert.equal(config.cargo.maximumLoadFraction, 0.9);
assert.equal(config.plexReward.minimum, 10);
assert.equal(config.plexReward.maximum, 20);
assert.ok(config.cargoCatalog.every((entry) => entry.maximumQuantity >= entry.minimumQuantity));

const progressionService = new serviceClass({
  config: {...config, enabled: false},
  autoStart: false,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "npc-courier-progress-")),
});
const progressionWireState = progressionService.Handle_GetHaulerProgress({}, {characterID: 9000001});
assert.equal(progressionWireState.type, "dict");
assert.ok(progressionWireState.entries.some(([key]) => key === "maxLevel"));
assert.ok(progressionWireState.entries.some(([key, value]) => key === "recentAwards" && value.type === "list"));
assert.deepEqual(
  buildSnapshot({players: {}}, 9000001, config.haulerProgression),
  {
    totalXP: 0,
    level: 1,
    contractsCompleted: 0,
    totalJumps: 0,
    totalVolumeM3: 0,
    lastAward: null,
    recentAwards: [],
    awardedContracts: {},
    maxLevel: 50,
    levelStartXP: 0,
    xpIntoLevel: 0,
    xpForNextLevel: 1000,
    progressPercent: 0,
    payoutBonusPercent: 0,
  },
);

const graph = buildGraph([
  {solarSystemID: 30000001, destinationSolarSystemID: 30000002},
  {solarSystemID: 30000002, destinationSolarSystemID: 30000003},
  {solarSystemID: 30000003, destinationSolarSystemID: 30000004},
]);
assert.equal(shortestJumpDistance(graph, 30000001, 30000004), 3);
assert.equal(shortestJumpDistance(graph, 30000004, 30000001), 3);
assert.equal(shortestJumpDistance(graph, 30000001, 39999999), null);
assert.equal(hashUnit("same-seed"), hashUnit("same-seed"));

const eligibleStations = listEligibleStations([
  {
    stationID: 60000001,
    stationName: "Origin",
    solarSystemID: 30000001,
    solarSystemName: "Origin",
    security: 0.9,
  },
  {
    stationID: 60000002,
    stationName: "Destination",
    solarSystemID: 30000004,
    solarSystemName: "Destination",
    security: 0.8,
  },
  {
    stationID: 60000003,
    stationName: "Lowsec",
    solarSystemID: 30000005,
    solarSystemName: "Lowsec",
    security: 0.2,
  },
], ["high"]);
assert.deepEqual(eligibleStations.map((station) => station.stationID), [60000001, 60000002]);

const origin = eligibleStations[0];
const destination = eligibleStations[1];
const selected = selectDestination({
  origin,
  establishedStations: [origin],
  eligibleStations,
  graph,
  seed: "courier-test",
  hubDestinationWeight: 1,
});
assert.ok(selected);
assert.equal(selected.station.stationID, destination.stationID);
assert.equal(selected.jumps, 3);

const shortHaulGraph = buildGraph([
  {solarSystemID: 30000001, destinationSolarSystemID: 30000002},
  {solarSystemID: 30000002, destinationSolarSystemID: 30000003},
  {solarSystemID: 30000003, destinationSolarSystemID: 30000004},
  {solarSystemID: 30000004, destinationSolarSystemID: 30000005},
  {solarSystemID: 30000005, destinationSolarSystemID: 30000006},
]);
const shortHaulStations = listEligibleStations([
  {
    stationID: 60000001,
    stationName: "Short Origin",
    solarSystemID: 30000001,
    security: 0.9,
  },
  {
    stationID: 60000002,
    stationName: "Short Destination",
    solarSystemID: 30000003,
    security: 0.8,
  },
  {
    stationID: 60000004,
    stationName: "Long Destination",
    solarSystemID: 30000006,
    security: 0.7,
  },
]);
const shortHaulSelection = selectDestination({
  origin: shortHaulStations[0],
  establishedStations: [shortHaulStations[0]],
  eligibleStations: shortHaulStations,
  graph: shortHaulGraph,
  seed: "short-haul-test",
  hubDestinationWeight: 1,
  shortHaulChance: 1,
  shortHaulMaxJumps: 3,
});
assert.ok(shortHaulSelection);
assert.equal(shortHaulSelection.station.stationID, 60000002);
assert.ok(shortHaulSelection.jumps <= 3);

const shortReward = calculateReward({
  jumps: 3,
  volumeM3: 100,
  security: 0.9,
  config,
});
const longReward = calculateReward({
  jumps: 8,
  volumeM3: 100,
  security: 0.9,
  config,
});
assert.ok(longReward > shortReward);
assert.equal(calculateReward({jumps: 34, volumeM3: 0, security: 0.9, config}), 15325000);
assert.ok(calculateReward({jumps: 3, volumeM3: 100, security: -0.1, config}) > shortReward);
assert.equal(calculateCollateral(100000, config), 125000);
assert.equal(calculateDeliveryDays(1, config), 2);

const normalizedState = normalizeState({
  sequence: 7,
  promotedStationIDs: [60000003, 60000003],
  stationScores: {"60000003": 22.5},
  contracts: {
    first: {
      contractID: 980000001,
      originStationID: 60000001,
      destinationStationID: 60000002,
      lastEvent: "created",
    },
  },
});
assert.equal(normalizedState.sequence, 7);
assert.deepEqual(normalizedState.promotedStationIDs, [60000003]);
assert.equal(normalizedState.contracts.first.lastEvent, "created");
assert.equal(normalizedState.treasury.replenishmentCount, 0);
assert.equal(normalizedState.maintenance.existingContractsCleared, false);
assert.equal(normalizedState.schemaVersion, 2);
assert.deepEqual(normalizedState.automation.players, {});
const automationState = normalizeState({
  automation: {
    players: {
      "9000001": {autoRoute: true, autoComplete: false},
      "9000002": {autoRoute: false, autoComplete: true},
    },
  },
});
assert.deepEqual(automationState.automation.players, {
  "9000001": {autoRoute: true, autoComplete: false},
  "9000002": {autoRoute: false, autoComplete: true},
});

const temporaryStateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-npc-courier-"));
const stateStore = createStateStore(path.join(temporaryStateDirectory, "state.json"));
const savedState = stateStore.save(normalizedState);
assert.equal(stateStore.load().sequence, savedState.sequence);
fs.rmSync(temporaryStateDirectory, {recursive: true, force: true});

const service = new serviceClass({
  config: normalizeConfig({...rawConfig, enabled: false}),
  stateStore: {load: () => normalizeState({}), save: (value) => normalizeState(value)},
  dataDir: os.tmpdir(),
  autoStart: false,
});
assert.equal(service.getStatus().enabled, false);
const contractInfo = serviceClass._testing.buildContractInfo({
  config,
  origin: {...origin, security: 0.9},
  destination: {...destination, security: 0.8},
  item: config.cargoCatalog[0],
  itemMetadata: {name: "Tritanium", volume: 0.01},
  quantity: 10000,
  jumps: 3,
});
assert.equal(contractInfo.contractType, 3);
assert.equal(contractInfo.startStationID, origin.stationID);
assert.equal(contractInfo.destinationID, destination.stationID);
assert.equal(contractInfo.startStationDivision, 115);
assert.ok(contractInfo.reward > 0);
assert.ok(contractInfo.collateral > 0);

async function validateServiceLifecycle() {
  const fakeRecords = [];
  let fakeBalance = 0;
  let fundingCalls = 0;
  const grantedFlags = [];
  const appliedFundingKeys = new Map();
  let savedState = normalizeState({});
  const fakeConfig = normalizeConfig({
    ...rawConfig,
    enabled: true,
    clearExistingContractsOnce: false,
    wipeAllActiveContractsOnce: false,
    initialDelayMs: 0,
    tickIntervalMs: 1000,
    contractsPerOrigin: 1,
    maxOutstandingContracts: 2,
    maxPromotedOrigins: 0,
    hubStationIDs: [60000001],
    issuer: {
      corporationID: 9000001,
      characterID: 9000002,
      walletAccountKey: 1000,
      minimumBalanceISK: 0,
    },
    cargo: {minimumStackCount: 2, maximumStackCount: 2},
    cargoCatalog: [34, 35].map((typeID) => ({
      typeID,
      minimumQuantity: 10000,
      maximumQuantity: 10000,
      referenceValueISK: 2,
      maximumVolumeM3: 2000,
    })),
  });
  let nextContractID = 980000001;
  const fakeDependencies = {
    worldData: {
      ensureLoaded: () => ({
        stargates: [{
          solarSystemID: 30000001,
          destinationSolarSystemID: 30000002,
        }],
        stations: [
          {
            stationID: 60000001,
            stationName: "Origin Station",
            solarSystemID: 30000001,
            solarSystemName: "Origin",
            security: 0.9,
          },
          {
            stationID: 60000002,
            stationName: "Destination Station",
            solarSystemID: 30000002,
            solarSystemName: "Destination",
            security: 0.8,
          },
        ],
      }),
    },
    contractRuntime: {
      listContractRecords: () => fakeRecords,
      createContract: async (info) => {
        const contractID = nextContractID;
        nextContractID += 1;
        const contract = {
          contractID,
          type: 3,
          status: 0,
          issuerCorpID: fakeConfig.issuer.corporationID,
          title: info.title,
          startStationID: info.startStationID,
          endStationID: info.destinationID,
          reward: info.reward,
          collateral: info.collateral,
          createdAtMs: Date.now(),
          dateExpired: (BigInt(Date.now()) * 10000n + 116444736000000000n + 864000000000n).toString(),
          items: info.itemList.map(([itemID, quantity], index) => ({
            itemID,
            itemTypeID: index === 0 ? 34 : 35,
            quantity,
            inCrate: true,
          })),
        };
        fakeRecords.push(contract);
        return {success: true, contractIDs: [contract.contractID], contract};
      },
    },
    itemStore: {
      ITEM_FLAGS: {HANGAR: 4},
      getItemMetadata: () => ({name: "Tritanium", volume: 0.01}),
      grantItemToOwnerLocationIdempotent: (_ownerID, _locationID, flagID, typeID) => {
        grantedFlags.push(flagID);
        return {
        success: true,
        durable: true,
        data: {itemIDs: [typeID === 34 ? 90000001 : 90000002]},
        };
      },
    },
    corpWalletState: {
      getCorporationWalletBalance: () => fakeBalance,
      adjustCorporationWalletDivisionBalanceAsync: async (_corporationID, _accountKey, delta, options) => {
        const key = String(options && options.idempotencyKey || "");
        if (appliedFundingKeys.has(key)) {
          return {success: true, duplicate: true, data: {balance: fakeBalance}};
        }
        fakeBalance += delta;
        fundingCalls += 1;
        appliedFundingKeys.set(key, delta);
        return {success: true, data: {balance: fakeBalance}};
      },
    },
    corporationState: {
      getCorporationRecord: () => ({isNPC: true}),
      getNpcCharacterOwnerRecord: () => ({ownerName: "Courier Representative"}),
    },
    agentAuthority: {
      getAgentByID: () => ({corporationID: fakeConfig.issuer.corporationID}),
    },
    sessionRegistry: {
      getSessions: () => [],
    },
  };
  const service = new serviceClass({
    config: fakeConfig,
    stateStore: {
      load: () => normalizeState(savedState),
      save: (value) => {
        savedState = normalizeState(value);
        return savedState;
      },
    },
    dataDir: os.tmpdir(),
    dependencies: fakeDependencies,
    autoStart: false,
  });

  const originalLogger = {
    info: serverLogger.info,
    warn: serverLogger.warn,
    error: serverLogger.error,
  };
  serverLogger.info = () => {};
  serverLogger.warn = () => {};
  serverLogger.error = () => {};
  try {
    await service.tick(1000000);
    assert.equal(fakeRecords.length, 2);
    assert.deepEqual(
      fakeRecords.map((record) => [record.startStationID, record.endStationID]),
      [[60000001, 60000002], [60000002, 60000001]],
    );
    assert.deepEqual(grantedFlags, [115, 115, 115, 115]);
    assert.equal(service.getStatus().activeContractCount, 2);
    assert.equal(fakeBalance, 50000000000);
    assert.equal(fundingCalls, 1);
    assert.equal(savedState.treasury.initialSeedComplete, true);
    assert.equal(savedState.treasury.replenishmentCount, 1);
    await service.tick(1001000);
    assert.equal(fakeRecords.length, 2);
    assert.equal(fundingCalls, 1);

    fakeBalance = 9000000000;
    await service.tick(1001500);
    assert.equal(fakeBalance, 50000000000);
    assert.equal(fundingCalls, 2);
    assert.equal(savedState.treasury.replenishmentCount, 2);

    const replayKey = "npcCourierContracts:treasury:9000001:1000:999";
    service._state.treasury.pendingFundingKey = replayKey;
    service._state.treasury.pendingFundingAmountISK = 50000000000;
    appliedFundingKeys.set(replayKey, 50000000000);
    const replenishmentCountBeforeReplay = service._state.treasury.replenishmentCount;
    await service.tick(1001800);
    assert.equal(service._state.treasury.pendingFundingKey, "");
    assert.equal(service._state.treasury.replenishmentCount, replenishmentCountBeforeReplay);
    assert.equal(fundingCalls, 2);

    fakeRecords[0].status = 1;
    await service.tick(1002000);
    assert.ok(savedState.stationScores["60000001"] >= fakeConfig.acceptanceScore);

    fakeRecords[0].status = 4;
    await service.tick(1003000);
    assert.ok(savedState.stationScores["60000002"] >= fakeConfig.completionScore);
  } finally {
    service.stop();
    serverLogger.info = originalLogger.info;
    serverLogger.warn = originalLogger.warn;
    serverLogger.error = originalLogger.error;
  }
}

async function validateAutomation() {
  const automationConfig = normalizeConfig({
    ...rawConfig,
    enabled: false,
    issuer: {corporationID: 9000001, characterID: 9000002},
    allowedSecurityClasses: ["high"],
  });
  const stations = [
    {
      stationID: 60000001,
      stationName: "Origin Station",
      solarSystemID: 30000001,
      solarSystemName: "Origin",
      security: 0.9,
    },
    {
      stationID: 60000002,
      stationName: "Near Drop-off",
      solarSystemID: 30000002,
      solarSystemName: "Near System",
      security: 0.8,
    },
    {
      stationID: 60000003,
      stationName: "Far Drop-off",
      solarSystemID: 30000003,
      solarSystemName: "Far System",
      security: 0.7,
    },
    {
      stationID: 60000004,
      stationName: "Other Drop-off",
      solarSystemID: 30000004,
      solarSystemName: "Other System",
      security: 0.7,
    },
  ];
  const automationRecords = [
    {
      contractID: 990000001,
      type: 3,
      status: 1,
      issuerCorpID: automationConfig.issuer.corporationID,
      title: "[NPC Courier] Near route",
      acceptorID: 7000001,
      endStationID: 60000002,
      acceptedAtMs: 100,
    },
    {
      contractID: 990000002,
      type: 3,
      status: 1,
      issuerCorpID: automationConfig.issuer.corporationID,
      title: "[NPC Courier] Far route",
      acceptorID: 7000001,
      endStationID: 60000003,
      acceptedAtMs: 200,
    },
    {
      contractID: 990000006,
      type: 3,
      status: 1,
      issuerCorpID: automationConfig.issuer.corporationID,
      title: "[NPC Courier] Same station route",
      acceptorID: 7000001,
      endStationID: 60000002,
      acceptedAtMs: 150,
    },
    {
      contractID: 990000003,
      type: 3,
      status: 1,
      issuerCorpID: automationConfig.issuer.corporationID,
      title: "[NPC Courier] Corporation route",
      acceptorID: 7000002,
      endStationID: 60000002,
      acceptedAtMs: 50,
    },
    {
      contractID: 990000004,
      type: 3,
      status: 4,
      issuerCorpID: automationConfig.issuer.corporationID,
      title: "[NPC Courier] Completed route",
      acceptorID: 7000001,
      endStationID: 60000002,
      acceptedAtMs: 1,
    },
    {
      contractID: 990000005,
      type: 3,
      status: 1,
      issuerCorpID: 9000003,
      title: "[NPC Courier] Other issuer",
      acceptorID: 7000001,
      endStationID: 60000002,
      acceptedAtMs: 1,
    },
  ];
  const notifications = [];
  const notificationNames = [];
  const completionCalls = [];
  let savedState = normalizeState({});
  const world = {
    stargates: [
      {solarSystemID: 30000001, destinationSolarSystemID: 30000002},
      {solarSystemID: 30000002, destinationSolarSystemID: 30000003},
      {solarSystemID: 30000001, destinationSolarSystemID: 30000004},
    ],
    stations,
  };
  const automationDependencies = {
    worldData: {
      ensureLoaded: () => world,
      getStationByID: (stationID) => stations.find((station) => station.stationID === Number(stationID)) || null,
    },
    contractRuntime: {
      listContractRecords: () => automationRecords,
      completeContract: async (contractID) => {
        completionCalls.push(contractID);
        const record = automationRecords.find((entry) => entry.contractID === contractID);
        if (!record || contractID === 990000002) {
          return false;
        }
        record.status = 4;
        return true;
      },
    },
    walletState: {
      adjustCharacterBalanceAsync: async () => ({success: true}),
    },
    corpWalletState: {
      adjustCorporationWalletDivisionBalanceAsync: async () => ({success: true}),
    },
  };
  const session = {
    characterID: 7000001,
    solarsystemid2: 30000001,
    sendNotification: (name, _scope, payload) => {
      notificationNames.push(name);
      notifications.push(payload);
    },
  };
  const service = new serviceClass({
    config: automationConfig,
    stateStore: {
      load: () => normalizeState(savedState),
      save: (value) => {
        savedState = normalizeState(value);
        return savedState;
      },
    },
    dataDir: os.tmpdir(),
    dependencies: automationDependencies,
    autoStart: false,
  });

  const defaults = service.Handle_GetAutomationState({}, session);
  assert.ok(defaults.entries.some(([key, value]) => key === "autoRoute" && value === false));
  assert.ok(defaults.entries.some(([key, value]) => key === "autoComplete" && value === false));

  const routeEnabled = service.Handle_SetAutomationSettings([{autoRoute: true}], session);
  assert.equal(routeEnabled.entries.find(([key]) => key === "autoRoute")[1], true);
  assert.equal(
    routeEnabled.entries.find(([key]) => key === "routeTarget")[1].entries
      .find(([key]) => key === "contractID")[1],
    990000001,
  );
  assert.ok(notifications.some((payload) => (
    payload[0].entries.some(([key, value]) => key === "autoRoute" && value === true)
  )));
  assert.ok(notificationNames.includes("OnNpcCourierContractsAutomation"));
  service.Handle_SetAutomationSettings([{autoComplete: true}], session);
  const target = service._getNearestAcceptedContract(session, automationDependencies);
  assert.equal(target.contractID, 990000001);
  assert.equal(target.jumps, 1);

  const dockResult = await service.onDocked(session, 0, 60000002);
  assert.deepEqual(dockResult.completedContractIDs, [990000001, 990000006]);
  assert.deepEqual(completionCalls, [990000001, 990000006]);
  assert.equal(automationRecords[0].status, 4);
  assert.equal(automationRecords[2].status, 4);
  assert.ok(notifications.some((payload) => (
    payload[0].entries.some(([key, value]) => key === "action" && value === "docked")
  )));

  const wrongStation = await service.onDocked(session, 0, 60000001);
  assert.deepEqual(wrongStation.completedContractIDs, []);
  assert.deepEqual(wrongStation.failedContractIDs, []);
  assert.deepEqual(completionCalls, [990000001, 990000006]);

  const firstRetry = await service.onDocked(session, 0, 60000003);
  const secondRetry = await service.onDocked(session, 0, 60000003);
  assert.deepEqual(firstRetry.failedContractIDs, [990000002]);
  assert.deepEqual(secondRetry.failedContractIDs, [990000002]);
  assert.deepEqual(completionCalls, [990000001, 990000006, 990000002, 990000002]);

  service.Handle_SetAutomationSettings([{autoComplete: false}], session);
  const disabledDock = await service.onDocked(session, 0, 60000003);
  assert.equal(disabledDock.skipped, true);
  assert.deepEqual(completionCalls, [990000001, 990000006, 990000002, 990000002]);

  // The launcher may expose the current station through stationid2 after a
  // session transition. The state request fallback must still complete
  // eligible contracts without another settings toggle.
  automationRecords[0].status = 1;
  automationRecords[2].status = 1;
  session.stationID = 0;
  session.stationid = 0;
  session.stationid2 = 0;
  service.Handle_SetAutomationSettings([{autoComplete: true}], session);
  session.stationid2 = 60000002;
  service.Handle_GetAutomationState({}, session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completionCalls, [
    990000001,
    990000006,
    990000002,
    990000002,
    990000001,
    990000006,
  ]);
}

validateServiceLifecycle()
  .then(validateAutomation)
  .then(() => {
    console.log("NPC Courier Contracts manifest, configuration, routing, rewards, state, lifecycle, automation, and package checks passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
