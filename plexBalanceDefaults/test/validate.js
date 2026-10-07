"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"),
);
for (const file of [".gitignore", "CHANGELOG.md", "LICENSE", "README.md", "loader.js"]) {
  assert.equal(fs.existsSync(path.join(modRoot, file)), true, `missing ${file}`);
}
assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "plexbalancedefaults");
assert.equal(manifest.displayName, "PLEX Balance Defaults");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);

const loader = require("../loader");

assert.equal(loader.MOD_VERSION, manifest.version);
assert.equal(loader.DEFAULT_PLEX_BALANCE, 100);
assert.equal(loader.LEGACY_DEFAULT_PLEX_BALANCE, 2222);
assert.equal(loader._testing.normalizeCharacterID("42"), 42);
assert.equal(loader._testing.normalizeCharacterID("not-a-character"), 0);
assert.equal(
  loader._testing.isLegacyDefaultRecord({ plexBalance: 2222 }),
  true,
);
assert.equal(
  loader._testing.isLegacyDefaultRecord({ plexBalance: 100 }),
  false,
);
assert.equal(
  loader._testing.isLegacyDefaultRecord({ plexBalance: 0 }),
  false,
);

const records = {
  "42": {
    plexBalance: 2222,
    plexVaultTransactions: [
      {
        amount: 2222,
        balance: 2222,
        reason: "Initial character creation PLEX grant",
      },
    ],
  },
};
const fakeCharacterState = {
  peekCharacterRecord(characterID) {
    return records[String(characterID)] || null;
  },
  getCharacterRecord(characterID) {
    return records[String(characterID)] || null;
  },
  updateCharacterRecord(characterID, updater) {
    const key = String(characterID);
    const next = updater(JSON.parse(JSON.stringify(records[key])));
    records[key] = next;
    return { success: true, data: next };
  },
};
const migrated = loader._testing.migrateCharacterRecord(
  fakeCharacterState,
  42,
  { forceDefault: true },
);
assert.equal(migrated.success, true);
assert.equal(records["42"].plexBalance, 100);
assert.equal(records["42"].evejsPlexBalanceDefaultsVersion, 2);
assert.equal(records["42"].plexVaultTransactions[0].balance, 100);

records["42"].plexBalance = 45;
const repeatMigration = loader._testing.migrateCharacterRecord(
  fakeCharacterState,
  42,
  { forceDefault: true },
);
assert.equal(repeatMigration.success, true);
assert.equal(repeatMigration.changed, false);
assert.equal(records["42"].plexBalance, 45);

const transactionRecord = {
  plexVaultTransactions: [
    {
      amount: 2222,
      balance: 2222,
      reason: "Initial character creation PLEX grant",
    },
  ],
};
assert.equal(loader._testing.patchInitialPlexTransaction(transactionRecord), true);
assert.equal(transactionRecord.plexVaultTransactions[0].amount, 100);
assert.equal(transactionRecord.plexVaultTransactions[0].balance, 100);

console.log("plexBalanceDefaults validation passed");
