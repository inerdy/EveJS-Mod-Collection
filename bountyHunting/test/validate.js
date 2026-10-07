"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"));
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const {normalizeState} = require(path.join(modRoot, "lib", "state"));
const {
  awardKill,
  buildSnapshot,
  levelForXP,
  totalXPForLevel,
} = require(path.join(modRoot, "lib", "bountyProgression"));
const Service = require(path.join(modRoot, "lib", "bountyHuntingService"));
const serviceTesting = Service._testing;

function read(relativePath) {
  return fs.readFileSync(path.join(modRoot, relativePath), "utf8");
}

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "bountyhunting");
assert.equal(manifest.displayName, "Bounty Hunting");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.deepEqual(manifest.clientMenu, {apiVersion: 1, entrypoint: "client/menu.py"});

const config = normalizeConfig(JSON.parse(read("config/bounty-hunting.json")));
assert.equal(config.enabled, true);
assert.equal(config.progression.maxLevel, 50);
assert.equal(config.progression.xpToNextLevelBase, 1000);
assert.equal(config.progression.xpToNextLevelPerLevel, 250);
assert.equal(config.payoutDelayMs, 1200000);
assert.equal(config.tiers.length, 4);
assert.equal(config.tiers[0].isk, 25000);
assert.equal(config.tiers[3].plexMaximum, 2);
assert.equal(levelForXP(999, config.progression), 1);
assert.equal(levelForXP(1000, config.progression), 2);
assert.equal(levelForXP(2250, config.progression), 3);
assert.equal(levelForXP(999999999, config.progression), 50);
assert.equal(totalXPForLevel(3, config.progression), 2250);

const migrated = normalizeState({
  characters: {
    "42": {totalXP: 100, totalKills: 1},
    "43": {totalXP: 0},
  },
});
assert.equal(migrated.schemaVersion, 2);
assert.equal(migrated.characters["42"].totalKills, 1);
assert.equal(migrated.characters["43"].totalXP, 0);
assert.deepEqual(normalizeState({}).characters, {});

const progressionCharacter = normalizeState({}).characters;
const character = require(path.join(modRoot, "lib", "bountyProgression"))
  .normalizeCharacter({totalXP: 900, totalKills: 0, killsByTier: {}});
const award = awardKill(
  character,
  {
    eventKey: "killmail:1",
    tier: "standard",
    tierLabel: "Standard",
    npcName: "Test Rat",
    bountyISK: 25000,
    reward: {isk: 75000, skillPoints: 2500, plex: 1, xp: 100},
  },
  config.progression,
  1000,
  10,
);
assert.equal(award.success, true);
assert.equal(award.levelAfter, 2);
assert.equal(character.totalXP, 1000);
assert.equal(character.totalKills, 1);
assert.equal(character.killsByTier.standard, 1);
assert.equal(buildSnapshot(character, config.progression, config.tiers).totalKills, 1);
assert.equal(awardKill(character, {eventKey: "killmail:1"}, config.progression).duplicate, true);
assert.deepEqual(progressionCharacter, {});

assert.equal(serviceTesting.isNativeNpc({nativeNpc: true}), true);
assert.equal(serviceTesting.isNativeNpc({npcEntityType: "concord"}), true);
assert.equal(serviceTesting.isNativeNpc({kind: "ship", characterID: 123}), false);
assert.equal(serviceTesting.characterIDFromAttacker({pilotCharacterID: 42}), 42);
assert.equal(serviceTesting.extractKillID({data: {killID: 99}}), 99);
assert.equal(serviceTesting.tierForBounty(config.tiers, 0).id, "low");
assert.equal(serviceTesting.tierForBounty(config.tiers, 10000).id, "standard");
assert.equal(serviceTesting.tierForBounty(config.tiers, 100000).id, "elite");
assert.equal(serviceTesting.tierForBounty(config.tiers, 1000000).id, "boss");

const walletCalls = [];
const notifications = [];
const skillNotifications = [];
const characterRecords = new Map([
  [42, {freeSkillPoints: 0}],
  [43, {freeSkillPoints: 0}],
  [44, {freeSkillPoints: 0}],
]);
let failPlexOnce = true;
let savedState = normalizeState({});
const fakeDependencies = {
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
      return {success: true, data: updated};
    },
  },
  skillQueueNotifications: {
    notifyFreeSkillPointsChanged: (characterID, amount) => {
      skillNotifications.push({characterID, amount});
    },
  },
  chatHub: {
    sendSystemMessage: (_session, message) => notifications.push(message),
  },
  sessionRegistry: {
    findSessionByCharacterID: (characterID) => ({characterID}),
  },
  bountyRuntime: {
    resolveNpcBountyAmount: (entity) => ({eligible: true, amount: entity.bounty || 0}),
  },
};

const service = new Service({
  config,
  database: {flushTableSync: () => ({success: true})},
  stateStore: {
    load: () => normalizeState(savedState),
    save: (value) => {
      savedState = normalizeState(value);
      return savedState;
    },
  },
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "bounty-hunting-")),
  dependencies: fakeDependencies,
  autoStart: false,
});

async function validateAsync() {
  const npc = {
    kind: "ship",
    nativeNpc: true,
    itemID: 7001,
    typeID: 1234,
    systemID: 30000001,
    name: "Test Rat",
    bounty: 25000,
  };
  const futurePayoutAtMs = Date.now() + 60000;
  const first = await service.recordNpcKill({
    targetEntity: npc,
    finalAttacker: {characterID: 42, typeID: 587},
    killID: 1001,
    whenMs: 1000,
    payoutAtMs: futurePayoutAtMs,
  });
  assert.equal(first.success, true);
  assert.equal(first.recorded, true);
  assert.equal(first.pendingPayout, true);
  assert.equal(savedState.characters["42"].kills["killmail:1001"].status, "recorded");
  assert.equal(walletCalls.length, 0);

  const second = await service.recordNpcKill({
    targetEntity: {
      ...npc,
      itemID: 7004,
      name: "Second Test Rat",
    },
    finalAttacker: {characterID: 42, typeID: 587},
    killID: 1002,
    whenMs: 2000,
    payoutAtMs: futurePayoutAtMs,
  });
  assert.equal(second.success, true);
  assert.equal(second.recorded, true);
  assert.equal(savedState.characters["42"].totalKills, 2);
  assert.equal(savedState.characters["42"].totalXP, 100);
  assert.equal(savedState.characters["42"].totalISK, 150000);
  assert.equal(savedState.characters["42"].totalSkillPoints, 5000);
  assert.equal(savedState.characters["42"].totalPlex, 2);
  const batchKey = `payout:${futurePayoutAtMs}`;
  assert.equal(savedState.characters["42"].pendingRewardBatches[batchKey].killCount, 2);
  assert.equal(savedState.characters["42"].pendingRewardBatches[batchKey].isk, 150000);
  assert.equal(savedState.characters["42"].pendingRewardBatches[batchKey].plex, 2);
  assert.equal(savedState.characters["42"].pendingRewardBatches[batchKey].skillPoints, 5000);
  assert.equal(savedState.characters["42"].pendingRewardBatches[batchKey].status, "pending");
  const pendingSnapshot = buildSnapshot(
    savedState.characters["42"],
    config.progression,
    config.tiers,
  );
  assert.equal(pendingSnapshot.pendingReward.killCount, 2);
  assert.equal(pendingSnapshot.pendingReward.isk, 150000);

  service._state.characters["42"].pendingRewardBatches[batchKey].payoutAtMs = 1;
  const partialSettlement = await service._settleBatch(42, batchKey);
  assert.equal(partialSettlement.success, false);
  assert.equal(partialSettlement.pending, true);
  assert.equal(walletCalls.filter((call) => call.kind === "isk").length, 1);
  assert.equal(walletCalls.filter((call) => call.kind === "plex").length, 1);
  assert.equal(skillNotifications.length, 0);
  const partialSnapshot = buildSnapshot(
    savedState.characters["42"],
    config.progression,
    config.tiers,
  );
  assert.equal(partialSnapshot.pendingReward.isk, 0);
  assert.equal(partialSnapshot.pendingReward.plex, 2);
  assert.equal(partialSnapshot.pendingReward.skillPoints, 5000);

  const retry = await service._settleBatch(42, batchKey);
  assert.equal(retry.success, true);
  assert.equal(retry.settled, true);
  assert.equal(savedState.characters["42"].pendingRewardBatches[batchKey].status, "settled");
  assert.equal(savedState.characters["42"].kills["killmail:1001"].status, "settled");
  assert.equal(savedState.characters["42"].kills["killmail:1002"].status, "settled");
  assert.equal(characterRecords.get(42).freeSkillPoints, 5000);
  assert.equal(walletCalls.filter((call) => call.kind === "isk").length, 1);
  assert.equal(walletCalls.filter((call) => call.kind === "plex").length, 2);
  assert.equal(skillNotifications.length, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /2 NPC kills/u);

  const duplicate = await service.recordNpcKill({
    targetEntity: npc,
    finalAttacker: {characterID: 42},
    killID: 1001,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(savedState.characters["42"].totalKills, 2);
  assert.equal(walletCalls.filter((call) => call.kind === "isk").length, 1);

  const droneResult = await service.recordNpcKill({
    targetEntity: {
      kind: "drone",
      nativeNpc: true,
      itemID: 7002,
      typeID: 1235,
      systemID: 30000001,
      name: "NPC Drone",
      bounty: 0,
    },
    finalAttacker: {characterID: 43},
    whenMs: 2000,
    payoutAtMs: futurePayoutAtMs + 60000,
  });
  assert.equal(droneResult.success, true);
  assert.equal(savedState.characters["43"].totalKills, 1);

  const nativeBountyResult = await service.recordNpcKill({
    targetEntity: {
      kind: "ship",
      itemID: 7003,
      typeID: 1236,
      systemID: 30000001,
      name: "Native Metadata Rat",
      bounty: 25000,
    },
    finalAttacker: {},
    characterID: 44,
    nativeBountyEligible: true,
    eventKey: "npc:30000001:7003",
    payoutAtMs: futurePayoutAtMs + 60000,
  });
  assert.equal(nativeBountyResult.success, true);
  assert.equal(savedState.characters["44"].totalKills, 1);

  const playerResult = await service.recordNpcKill({
    targetEntity: {kind: "ship", characterID: 9001, itemID: 8001, bounty: 1000000},
    finalAttacker: {characterID: 42},
    killID: 2001,
  });
  assert.equal(playerResult.skipped, true);
  assert.equal(savedState.characters["42"].totalKills, 2);

  const wireState = service.Handle_GetBountyProgress({}, {characterID: 42});
  assert.equal(wireState.type, "dict");
  assert.ok(wireState.entries.some(([key]) => key === "level"));
  assert.ok(wireState.entries.some(([key, value]) => (
    key === "recentKills" && value.type === "list"
  )));

  const disabled = new Service({
    config: normalizeConfig({enabled: false}),
    stateStore: {load: () => normalizeState({}), save: () => {}},
    dependencies: fakeDependencies,
    autoStart: false,
  });
  const disabledResult = await disabled.recordNpcKill({
    targetEntity: npc,
    finalAttacker: {characterID: 42},
    killID: 999,
  });
  assert.equal(disabledResult.skipped, true);
  disabled.stop();
  service.stop();

  const loader = read("loader.js");
  assert.match(loader, /serviceManager\.js/u);
  assert.match(loader, /killmailTracker\.js/u);
  assert.match(loader, /SPACE_RUNTIME_SUFFIX/u);
  assert.match(loader, /BOUNTY_RUNTIME_SUFFIX/u);
  assert.match(loader, /recordNpcBountyKill/u);
  assert.match(loader, /eventKeyForTarget/u);
  assert.match(loader, /droneInterop/u);
  assert.match(loader, /applyWeaponDamageToTarget/u);
  assert.match(loader, /patchCachedModule/u);
  assert.match(loader, /enqueueKillmailFromDestruction/u);
  assert.match(loader, /recordKillmailFromDestruction/u);

  const client = read("client/menu.py");
  assert.match(client, /Bounty Hunting/u);
  assert.match(client, /ScrollContainer/u);
  assert.match(client, /GetBountyProgress/u);
  assert.match(client, /mods\.register/u);
  assert.match(client, /recentKills/u);

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
    "config/bounty-hunting.json",
    "evejs-launcher.mod.json",
    "lib/bountyHuntingService.js",
    "lib/bountyProgression.js",
    "lib/config.js",
    "lib/state.js",
    "loader.js",
    "test/validate.js",
  ]);

  console.log("Bounty Hunting manifest, configuration, progression, reward settlement, idempotency, loader, UI, and package checks passed.");
}

validateAsync().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
