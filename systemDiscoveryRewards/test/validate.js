"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const {
  normalizeCharacter,
  normalizeState,
} = require(path.join(modRoot, "lib", "state"));
const {
  awardDiscovery,
  buildSnapshot,
  levelForXP,
  totalXPForLevel,
} = require(path.join(modRoot, "lib", "explorerProgression"));
const Service = require(path.join(modRoot, "lib", "systemDiscoveryRewardsService"));

function read(relativePath) {
  return fs.readFileSync(path.join(modRoot, relativePath), "utf8");
}

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "systemdiscoveryrewards");
assert.equal(manifest.displayName, "System Discovery Rewards");
assert.equal(manifest.version, "0.2.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.deepEqual(manifest.clientMenu, {
  apiVersion: 1,
  entrypoint: "client/menu.py",
});

const config = normalizeConfig(JSON.parse(read("config/discovery.json")));
assert.equal(config.enabled, true);
assert.equal(config.knownSpaceOnly, true);
assert.equal(config.knownSpaceMaxSystemID, 31000000);
assert.equal(config.reward.isk, 250000);
assert.equal(config.reward.xp, 100);
assert.equal(config.reward.skillPoints, 10000);
assert.equal(config.reward.plexMinimum, 1);
assert.equal(config.reward.plexMaximum, 3);
assert.equal(config.progression.maxLevel, 50);
assert.equal(config.progression.xpToNextLevelBase, 1000);
assert.equal(config.progression.xpToNextLevelPerLevel, 250);
assert.equal(levelForXP(999, config.progression), 1);
assert.equal(levelForXP(1000, config.progression), 2);
assert.equal(levelForXP(2250, config.progression), 3);
assert.equal(levelForXP(999999999, config.progression), 50);
assert.equal(totalXPForLevel(3, config.progression), 2250);

const progressionCharacter = normalizeCharacter({});
const firstAward = awardDiscovery(
  progressionCharacter,
  {
    systemID: 30000002,
    systemName: "Test System",
    discoveredAtMs: 1000,
    reward: {isk: 250000, xp: 100, plex: 2},
  },
  config.progression,
  1000,
  10,
);
assert.equal(firstAward.success, true);
assert.equal(firstAward.levelAfter, 1);
assert.equal(progressionCharacter.totalXP, 100);
assert.equal(buildSnapshot(progressionCharacter, config.progression).systemsDiscovered, 1);

const serviceConfig = normalizeConfig({
  ...JSON.parse(read("config/discovery.json")),
  enabled: true,
});
const visitedSystems = new Set([30000001]);
const walletCalls = [];
const notifications = [];
const skillPointNotifications = [];
const characterRecords = new Map([
  [42, {freeSkillPoints: 0}],
]);
let failPlexOnce = true;
let savedState = normalizeState({});
const fakeDependencies = {
  mapTelemetry: {
    listSolarSystemVisitRows: () => [...visitedSystems].map((systemID) => [null, systemID, 1]),
  },
  worldData: {
    getSolarSystemByID: (systemID) => ({
      solarSystemID: systemID,
      solarSystemName: `System ${systemID}`,
      security: systemID >= 30000000 && systemID < 31000000 ? 0.8 : -1,
    }),
  },
  walletState: {
    JOURNAL_ENTRY_TYPE: {AGENT_MISSION_REWARD: 33},
    adjustCharacterBalanceAsync: async (...args) => {
      walletCalls.push({kind: "isk", args});
      return {success: true};
    },
    adjustCharacterPlexBalanceAsync: async (...args) => {
      walletCalls.push({kind: "plex", args});
      if (failPlexOnce) {
        failPlexOnce = false;
        return {success: false, errorMsg: "TEST_RETRY"};
      }
      return {success: true};
    },
  },
  characterState: {
    CHARACTERS_TABLE: "characters",
    updateCharacterRecord: (characterID, updater) => {
      const current = characterRecords.get(Number(characterID));
      if (!current) return {success: false, errorMsg: "CHARACTER_NOT_FOUND"};
      const updated = updater(JSON.parse(JSON.stringify(current)));
      characterRecords.set(Number(characterID), updated);
      return {success: true, data: JSON.parse(JSON.stringify(updated))};
    },
  },
  skillQueueNotifications: {
    notifyFreeSkillPointsChanged: (characterID, amount) => {
      skillPointNotifications.push({characterID, amount});
    },
  },
  chatHub: {
    sendSystemMessage: (_session, message) => notifications.push(message),
  },
  sessionRegistry: {
    findSessionByCharacterID: () => null,
  },
};
const service = new Service({
  config: serviceConfig,
  database: {
    flushTableSync: () => ({success: true}),
  },
  stateStore: {
    load: () => normalizeState(savedState),
    save: (value) => {
      savedState = normalizeState(value);
      return savedState;
    },
  },
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "system-discovery-rewards-")),
  dependencies: fakeDependencies,
  autoStart: false,
});

const newArrival = service.prepareArrival(
  {characterID: 42},
  {systemID: 30000002, universeSiteReconcileReason: "stargate-jump"},
);
assert.equal(newArrival.systemID, 30000002);

async function validateAsync() {
  await service.handleArrival(newArrival, {characterID: 42});
  assert.equal(savedState.characters["42"].discoveries["30000002"].status, "pending");
  assert.equal(savedState.characters["42"].discoveries["30000002"].iskPaid, true);
  assert.equal(savedState.characters["42"].discoveries["30000002"].skillPointsPaid, false);
  assert.equal(savedState.characters["42"].discoveries["30000002"].plexPaid, false);
  await service.handleArrival(newArrival, {characterID: 42});
  assert.equal(savedState.characters["42"].discoveries["30000002"].status, "claimed");
  assert.equal(savedState.characters["42"].discoveries["30000002"].iskPaid, true);
  assert.equal(savedState.characters["42"].discoveries["30000002"].skillPointsPaid, true);
  assert.equal(savedState.characters["42"].discoveries["30000002"].plexPaid, true);
  assert.equal(savedState.characters["42"].totalXP, 100);
  assert.equal(savedState.characters["42"].totalSkillPoints, 10000);
  assert.equal(savedState.characters["42"].systemsDiscovered, 1);
  assert.equal(characterRecords.get(42).freeSkillPoints, 10000);
  assert.deepEqual(skillPointNotifications, [{characterID: 42, amount: 10000}]);
  assert.equal(walletCalls.filter((call) => call.kind === "isk").length, 1);
  assert.equal(walletCalls.filter((call) => call.kind === "plex").length, 2);
  assert.equal(notifications.length, 1);

  await service.handleArrival(newArrival, {characterID: 42});
  assert.equal(walletCalls.filter((call) => call.kind === "isk").length, 1);
  assert.equal(walletCalls.filter((call) => call.kind === "plex").length, 2);
  assert.equal(notifications.length, 1);

  assert.equal(
    service.prepareArrival(
      {characterID: 42},
      {systemID: 30000001, universeSiteReconcileReason: "stargate-jump"},
    ),
    null,
  );
  assert.equal(
    service.prepareArrival(
      {characterID: 42},
      {systemID: 30000003, universeSiteReconcileReason: "space-login"},
    ),
    null,
  );
  assert.equal(
    service.prepareArrival(
      {characterID: 42},
      {systemID: 31000001, universeSiteReconcileReason: "solar-jump"},
    ),
    null,
  );

  const wireState = service.Handle_GetDiscoveryProgress({}, {characterID: 42});
  assert.equal(wireState.type, "dict");
  assert.ok(wireState.entries.some(([key]) => key === "level"));
  assert.ok(wireState.entries.some(([key, value]) => (
    key === "recentDiscoveries" && value.type === "list"
  )));

  service.stop();
  const loader = read("loader.js");
  assert.match(loader, /serviceManager\.js/u);
  assert.match(loader, /spaceRuntime.*sessions\.js/u);
  assert.match(loader, /prepareArrival/u);
  assert.match(loader, /handleArrival/u);

  const client = read("client/menu.py");
  assert.match(client, /System Discovery Rewards/u);
  assert.match(client, /GetDiscoveryProgress/u);
  assert.match(client, /mods\.register/u);
  assert.match(client, /totalSkillPoints/u);
  assert.match(client, /totalPlex/u);

  const packageFiles = [];
  function collect(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === ".git") continue;
      const entryPath = path.join(directory, entry.name);
      const entryPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(entryPath, entryPrefix);
      else packageFiles.push(entryPrefix.replace(/\\/g, "/"));
    }
  }
  collect(modRoot);
  assert.deepEqual(packageFiles.sort(), [
    "LICENSE",
    "README.md",
    "client/menu.py",
    "config/discovery.json",
    "evejs-launcher.mod.json",
    "lib/config.js",
    "lib/explorerProgression.js",
    "lib/state.js",
    "lib/systemDiscoveryRewardsService.js",
    "loader.js",
    "test/validate.js",
  ]);

  console.log("System Discovery Rewards manifest, progression, payout, skill-point grant, hook, UI, and package checks passed.");
}

validateAsync().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
