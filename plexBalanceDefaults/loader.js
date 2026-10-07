"use strict";

const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_ID = "plexbalancedefaults";
const MOD_VERSION = "0.1.0";
const DEFAULT_PLEX_BALANCE = 100;
const LEGACY_DEFAULT_PLEX_BALANCE = 2222;
const MIGRATION_VERSION = 2;
const MIGRATION_MARKER = "evejsPlexBalanceDefaultsVersion";
const INSTALLED = Symbol.for("evejs.plexBalanceDefaults.loaderInstalled");
const CHARACTER_STATE_PATCHED = Symbol.for(
  "evejs.plexBalanceDefaults.characterStatePatched",
);
const CHAR_SERVICE_PATCHED = Symbol.for(
  "evejs.plexBalanceDefaults.charServicePatched",
);
const ORIGINAL_CHARACTER_GET = Symbol.for(
  "evejs.plexBalanceDefaults.originalCharacterGet",
);
const ORIGINAL_APPLY_CHARACTER = Symbol.for(
  "evejs.plexBalanceDefaults.originalApplyCharacter",
);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TARGETS = Object.freeze({
  characterState: path.join(
    REPO_ROOT,
    "server",
    "src",
    "services",
    "character",
    "characterState.js",
  ),
  charService: path.join(
    REPO_ROOT,
    "server",
    "src",
    "services",
    "character",
    "charService.js",
  ),
  walletState: path.join(
    REPO_ROOT,
    "server",
    "src",
    "services",
    "account",
    "walletState.js",
  ),
  walletAuthorityOwnerState: path.join(
    REPO_ROOT,
    "server",
    "src",
    "services",
    "account",
    "walletAuthorityOwnerState.js",
  ),
});

let migrationState = null;
let authorityMigrationState = null;

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function logError(message, error = null) {
  console.error(`[${MOD_ID}] ${message}`);
  if (error && error.stack) {
    console.error(error.stack);
  }
}

function normalizeCharacterID(value) {
  const characterID = Math.trunc(Number(value) || 0);
  return characterID > 0 ? characterID : 0;
}

function hasOwn(object, property) {
  return Boolean(
    object && Object.prototype.hasOwnProperty.call(object, property),
  );
}

function hasValidPlexBalance(record) {
  const balance = Number(record && record.plexBalance);
  return Number.isSafeInteger(balance) && balance >= 0;
}

function isLegacyDefaultRecord(record) {
  return (
    !hasValidPlexBalance(record) ||
    Number(record.plexBalance) === LEGACY_DEFAULT_PLEX_BALANCE
  );
}

function patchInitialPlexTransaction(record) {
  if (!Array.isArray(record && record.plexVaultTransactions)) {
    return false;
  }

  const transaction = record.plexVaultTransactions.find((entry) => {
    const text = `${entry && entry.reason ? entry.reason : ""} ${
      entry && entry.summaryText ? entry.summaryText : ""
    }`.toLowerCase();
    return text.includes("initial character creation plex grant");
  });
  if (!transaction) {
    return false;
  }

  transaction.amount = DEFAULT_PLEX_BALANCE;
  transaction.balance = DEFAULT_PLEX_BALANCE;
  return true;
}

function getProjectedPlexBalance(characterID) {
  try {
    const walletAuthority = require(path.join(
      REPO_ROOT,
      "server",
      "src",
      "services",
      "account",
      "walletCommandAuthority",
    ));
    if (
      !walletAuthority ||
      typeof walletAuthority.isWalletAuthorityProcessEnabled !== "function" ||
      walletAuthority.isWalletAuthorityProcessEnabled() !== true
    ) {
      return null;
    }

    const projection = require(path.join(
      REPO_ROOT,
      "server",
      "src",
      "services",
      "account",
      "walletAuthorityProjection",
    ));
    const entry = projection.getCharacterBalanceProjection(characterID);
    const balance = Number(entry && entry.plexBalance);
    return Number.isSafeInteger(balance) && balance >= 0 ? balance : null;
  } catch (_error) {
    return null;
  }
}

function syncProjectedCharacterWallet(characterState, characterID, record) {
  const charId = normalizeCharacterID(characterID);
  if (!charId || !record) {
    return record;
  }

  const projectedPlexBalance = getProjectedPlexBalance(charId);
  if (
    projectedPlexBalance === null ||
    Number(record.plexBalance) === projectedPlexBalance
  ) {
    return record;
  }

  const writeResult = characterState.updateCharacterRecord(charId, (next) => {
    next.plexBalance = projectedPlexBalance;
    return next;
  });
  if (writeResult && writeResult.success && writeResult.data) {
    const originalGetCharacterRecord =
      characterState[ORIGINAL_CHARACTER_GET] || characterState.getCharacterRecord;
    return typeof originalGetCharacterRecord === "function"
      ? originalGetCharacterRecord.call(characterState, charId)
      : writeResult.data;
  }

  // A projection is still safer for this active login than the stale
  // character row. The next wallet-owner flush can retry the durable mirror.
  return {
    ...record,
    plexBalance: projectedPlexBalance,
  };
}

function migrateCharacterRecord(characterState, characterID, options = {}) {
  const charId = normalizeCharacterID(characterID);
  if (!charId || !characterState) {
    return { success: false, changed: false, reason: "invalid-character" };
  }

  const rawRecord =
    typeof characterState.peekCharacterRecord === "function"
      ? characterState.peekCharacterRecord(charId)
      : null;
  const originalGetCharacterRecord =
    characterState[ORIGINAL_CHARACTER_GET] || characterState.getCharacterRecord;
  const currentRecord =
    options.currentRecord ||
    (typeof originalGetCharacterRecord === "function"
      ? originalGetCharacterRecord.call(characterState, charId)
      : rawRecord);
  if (!currentRecord) {
    return { success: false, changed: false, reason: "character-not-found" };
  }

  const alreadyMigrated =
    Number(rawRecord && rawRecord[MIGRATION_MARKER]) === MIGRATION_VERSION;
  if (alreadyMigrated) {
    return {
      success: true,
      changed: false,
      characterID: charId,
      plexBalance: Number(currentRecord.plexBalance),
    };
  }

  const shouldUseNewDefault =
    options.forceDefault === true || isLegacyDefaultRecord(rawRecord);
  const writeResult = characterState.updateCharacterRecord(charId, (record) => {
    const previousBalance = Number(record.plexBalance);
    if (shouldUseNewDefault) {
      record.plexBalance = DEFAULT_PLEX_BALANCE;
      if (previousBalance !== DEFAULT_PLEX_BALANCE) {
        patchInitialPlexTransaction(record);
      }
    }
    record[MIGRATION_MARKER] = MIGRATION_VERSION;
    return record;
  });

  return {
    success: Boolean(writeResult && writeResult.success),
    changed: Boolean(writeResult && writeResult.success),
    characterID: charId,
    plexBalance:
      writeResult && writeResult.data
        ? Number(writeResult.data.plexBalance)
        : Number(currentRecord.plexBalance),
    errorMsg: writeResult && writeResult.errorMsg,
  };
}

function patchCharacterState(characterState) {
  if (
    !characterState ||
    typeof characterState !== "object" ||
    characterState[CHARACTER_STATE_PATCHED]
  ) {
    return false;
  }
  if (typeof characterState.getCharacterRecord !== "function") {
    throw new Error("characterState.getCharacterRecord is unavailable");
  }
  if (typeof characterState.updateCharacterRecord !== "function") {
    throw new Error("characterState.updateCharacterRecord is unavailable");
  }

  const originalGetCharacterRecord = characterState.getCharacterRecord;
  const originalApplyCharacterToSession = characterState.applyCharacterToSession;
  Object.defineProperty(characterState, ORIGINAL_CHARACTER_GET, {
    configurable: false,
    enumerable: false,
    value: originalGetCharacterRecord,
    writable: false,
  });
  if (typeof originalApplyCharacterToSession === "function") {
    Object.defineProperty(characterState, ORIGINAL_APPLY_CHARACTER, {
      configurable: false,
      enumerable: false,
      value: originalApplyCharacterToSession,
      writable: false,
    });
  }
  characterState.DEFAULT_PLEX_BALANCE = DEFAULT_PLEX_BALANCE;
  characterState.getCharacterRecord = function patchedGetCharacterRecord(
    characterID,
    ...args
  ) {
    const record = originalGetCharacterRecord.call(this, characterID, ...args);
    const charId = normalizeCharacterID(characterID);
    if (!record || !charId) {
      return record;
    }

    let currentRecord = record;
    try {
      const migration = migrateCharacterRecord(characterState, charId, {
        currentRecord: record,
        forceDefault: false,
      });
      if (migration.success && migration.changed) {
        currentRecord = originalGetCharacterRecord.call(this, charId, ...args);
      }
    } catch (error) {
      logError(`could not migrate character ${charId}; keeping current record`, error);
    }
    return syncProjectedCharacterWallet(characterState, charId, currentRecord);
  };

  if (typeof originalApplyCharacterToSession === "function") {
    characterState.applyCharacterToSession = function patchedApplyCharacterToSession(
      session,
      characterID,
      ...args
    ) {
      const result = originalApplyCharacterToSession.call(
        this,
        session,
        characterID,
        ...args,
      );
      const projectedPlexBalance = getProjectedPlexBalance(characterID);
      if (
        result &&
        result.success === true &&
        projectedPlexBalance !== null &&
        session &&
        Number(session.plexBalance) !== projectedPlexBalance
      ) {
        session.plexBalance = projectedPlexBalance;
      }
      return result;
    };
  }

  Object.defineProperty(characterState, CHARACTER_STATE_PATCHED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}

function patchCharService(CharService) {
  if (
    !CharService ||
    !CharService.prototype ||
    CharService.prototype[CHAR_SERVICE_PATCHED]
  ) {
    return false;
  }
  const originalCreate = CharService.prototype.Handle_CreateCharacterWithDoll;
  if (typeof originalCreate !== "function") {
    throw new Error("CharService.Handle_CreateCharacterWithDoll is unavailable");
  }

  const originalSelect = CharService.prototype.Handle_SelectCharacterID;
  if (typeof originalSelect === "function") {
    CharService.prototype.Handle_SelectCharacterID = function patchedSelect(
      args,
      session,
      kwargs,
    ) {
      try {
        const resolver =
          CharService._testing && CharService._testing.resolveCharacterRequestId;
        const characterID =
          typeof resolver === "function"
            ? resolver(args, kwargs, 0)
            : Array.isArray(args)
              ? args[0]
              : 0;
        const characterState = require(TARGETS.characterState);
        const current = characterState.getCharacterRecord(characterID);
        syncProjectedCharacterWallet(characterState, characterID, current);
      } catch (error) {
        logError("could not mirror the wallet projection before character selection", error);
      }
      return originalSelect.call(this, args, session, kwargs);
    };
  }

  CharService.prototype.Handle_CreateCharacterWithDoll = function patchedCreate(
    ...args
  ) {
    const result = originalCreate.apply(this, args);
    const characterID = normalizeCharacterID(result);
    if (characterID) {
      try {
        const characterState = require(TARGETS.characterState);
        migrateCharacterRecord(characterState, characterID, {
          forceDefault: true,
        });
      } catch (error) {
        logError(
          `new character ${characterID} was created, but its PLEX default could not be applied`,
          error,
        );
      }
    }
    return result;
  };

  Object.defineProperty(CharService.prototype, CHAR_SERVICE_PATCHED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}

function patchTarget(filename, exported) {
  const resolved = path.resolve(filename);
  if (resolved === path.resolve(TARGETS.characterState)) {
    patchCharacterState(exported);
    runStartupMigrationIfReady();
  } else if (resolved === path.resolve(TARGETS.charService)) {
    patchCharService(exported);
    runStartupMigrationIfReady();
  } else if (resolved === path.resolve(TARGETS.walletAuthorityOwnerState)) {
    runWalletAuthorityMigrationIfReady();
  }
  return exported;
}

function patchCachedTargets() {
  for (const filename of Object.values(TARGETS)) {
    let resolved;
    try {
      resolved = require.resolve(filename);
    } catch (_error) {
      continue;
    }
    const cached = require.cache[resolved];
    if (cached) {
      patchTarget(resolved, cached.exports);
    }
  }
}

function installHook() {
  if (Module._load[INSTALLED]) {
    return { installed: false, previousLoad: Module._load };
  }

  const previousLoad = Module._load;
  function hookedLoad(request, parent, isMain) {
    const exported = previousLoad.call(this, request, parent, isMain);
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (_error) {
      return exported;
    }
    patchTarget(resolved, exported);
    return exported;
  }

  hookedLoad[INSTALLED] = true;
  Module._load = hookedLoad;
  return { installed: true, previousLoad, hookedLoad };
}

function currentGameStoreRole() {
  return String(process.env.EVEJS_GAMESTORE_OWNER_ROLE || "")
    .trim()
    .toLowerCase();
}

function canMutateCharacterTable() {
  return new Set(["world", "standalone", "maintenance"]).has(
    currentGameStoreRole(),
  );
}

function migrateExistingCharacters() {
  const characterState = require(TARGETS.characterState);
  const summary = {
    checked: 0,
    changed: 0,
    preserved: 0,
    failed: [],
  };

  const characterIDs =
    typeof characterState.listCharacterIDs === "function"
      ? characterState.listCharacterIDs()
      : [];
  for (const characterID of characterIDs) {
    summary.checked += 1;
    try {
      const before =
        typeof characterState.peekCharacterRecord === "function"
          ? characterState.peekCharacterRecord(characterID)
          : null;
      const result = migrateCharacterRecord(characterState, characterID, {
        forceDefault: true,
      });
      if (!result.success) {
        summary.failed.push(`${characterID}: ${result.errorMsg || result.reason}`);
      } else if (result.changed) {
        summary.changed += 1;
      } else if (before) {
        summary.preserved += 1;
      }
    } catch (error) {
      summary.failed.push(`${characterID}: ${error.message}`);
    }
  }

  return summary;
}

function migrateWalletAuthorityRecords() {
  if (
    process.env.EVEJS_WALLET_AUTHORITY_OWNER !== "1" &&
    currentGameStoreRole() !== "wallet"
  ) {
    return { checked: 0, changed: 0, skipped: true, failed: [] };
  }

  const ownerState = require(TARGETS.walletAuthorityOwnerState);
  if (typeof ownerState.listOwnedRecords !== "function") {
    return { checked: 0, changed: 0, skipped: false, failed: ["listOwnedRecords unavailable"] };
  }

  const summary = { checked: 0, changed: 0, skipped: false, failed: [] };
  for (const record of ownerState.listOwnedRecords()) {
    const characterID = normalizeCharacterID(record && record.characterID);
    if (!characterID) {
      continue;
    }
    summary.checked += 1;
    const alreadyMigrated =
      Number(record[MIGRATION_MARKER]) === MIGRATION_VERSION;
    const shouldUseNewDefault = !alreadyMigrated;
    if (!shouldUseNewDefault && alreadyMigrated) {
      continue;
    }
    const result = ownerState.updateCharacterRecord(characterID, (next) => {
      if (shouldUseNewDefault) {
        next.plexBalance = DEFAULT_PLEX_BALANCE;
      }
      next[MIGRATION_MARKER] = MIGRATION_VERSION;
      return next;
    });
    if (result && result.success) {
      summary.changed += 1;
    } else {
      summary.failed.push(`${characterID}: ${(result && result.errorMsg) || "WRITE_ERROR"}`);
    }
  }
  return summary;
}

function runStartupMigrationIfReady() {
  if (migrationState || !canMutateCharacterTable()) {
    return migrationState;
  }

  let resolved;
  try {
    resolved = require.resolve(TARGETS.characterState);
  } catch (_error) {
    return null;
  }
  const cached = require.cache[resolved];
  if (!cached) {
    return null;
  }

  migrationState = { active: true, pending: true };
  try {
    const characterState = cached.exports;
    patchCharacterState(characterState);
    const migration = migrateExistingCharacters();
    migrationState = { active: true, pending: false, migration };
    log(
      `v${MOD_VERSION} active — default PLEX ${DEFAULT_PLEX_BALANCE}; ` +
        `migrated ${migration.changed}/${migration.checked} existing characters`,
    );
    if (migration.failed.length > 0) {
      logError(`migration failures: ${migration.failed.join("; ")}`);
    }
  } catch (error) {
    migrationState = { active: true, pending: false, error };
    logError("startup migration failed; gameplay hooks remain active", error);
  }
  return migrationState;
}

function runWalletAuthorityMigrationIfReady() {
  if (authorityMigrationState) {
    return authorityMigrationState;
  }
  if (
    process.env.EVEJS_WALLET_AUTHORITY_OWNER !== "1" &&
    currentGameStoreRole() !== "wallet"
  ) {
    return null;
  }

  let resolved;
  try {
    resolved = require.resolve(TARGETS.walletAuthorityOwnerState);
  } catch (_error) {
    return null;
  }
  if (!require.cache[resolved]) {
    return null;
  }

  authorityMigrationState = { active: true, pending: true };
  try {
    const migration = migrateWalletAuthorityRecords();
    authorityMigrationState = {
      active: true,
      pending: false,
      migration,
    };
    if (migration.failed.length > 0) {
      logError(
        `wallet-authority migration failures: ${migration.failed.join("; ")}`,
      );
    }
  } catch (error) {
    authorityMigrationState = { active: true, pending: false, error };
    logError("wallet-authority migration failed", error);
  }
  return authorityMigrationState;
}

function install() {
  if (!isMainThread) {
    return { active: false, reason: "worker-thread" };
  }
  const hookState = installHook();
  patchCachedTargets();

  runStartupMigrationIfReady();
  runWalletAuthorityMigrationIfReady();
  log(`v${MOD_VERSION} loader active — default PLEX ${DEFAULT_PLEX_BALANCE}`);

  return {
    active: true,
    hookState,
    migration: migrationState,
    authorityMigration: authorityMigrationState,
  };
}

let installResult;
try {
  installResult = install();
} catch (error) {
  logError("loader failed before activation", error);
  installResult = { active: false, reason: "exception", error };
}

module.exports = Object.freeze({
  MOD_ID,
  MOD_VERSION,
  DEFAULT_PLEX_BALANCE,
  LEGACY_DEFAULT_PLEX_BALANCE,
  MIGRATION_MARKER,
  MIGRATION_VERSION,
  TARGETS,
  install,
  installResult,
  _testing: Object.freeze({
    hasValidPlexBalance,
    isLegacyDefaultRecord,
    migrateCharacterRecord,
    patchInitialPlexTransaction,
    normalizeCharacterID,
  }),
});
