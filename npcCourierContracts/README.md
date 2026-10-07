# NPC Courier Contracts

NPC Courier Contracts is a native-only EveJS mod that creates public courier contracts from major trade hubs and gradually promotes active NPC stations into additional contract origins.

Version `0.6.4` fixes station-level automatic routing and ensures dock
automation remains hooked when the launcher activates the mod after EveJS has
already loaded its core modules or exposes the docked station through an
alternate session field. It also includes the persistent 50-level
Hauler progression with a
Hauler Progression and Courier Automation window in the launcher Mods menu. NPC courier completions
award XP, and each level after Level 1 adds 3% to future courier payout up to
the existing 50,000,000 ISK cap.

The generator can also create a separate return contract for each route. For
example, a Jita-to-Amarr contract may be accompanied by an independent
Amarr-to-Jita contract with its own cargo, reward, collateral, and contract ID.

Completed NPC courier contracts that were observed before the Hauler tracker
was active are backfilled once, using contract-ID idempotency.

The default progression curve now requires 1,000 XP for Level 2, increasing by
250 XP for each subsequent level.

The mod uses EveJS's live `contractProxy`/`contractRuntimeState` path and adds a small client Mods-menu window for Hauler progression. It does not modify the market server or the native Contracts service; players still use the normal EVE Contracts interface for accepting and completing courier work.

Courier Automation is disabled by default for every character. Open the
Hauler Progression entry in the in-game Mods menu to enable either option:

- Automatic Routing replaces the current destination with the drop-off solar
  system of the nearest accepted personal NPC courier contract. The exact
  destination station is still required for delivery.
- Automatic Dock Completion checks matching contracts after a successful dock
  at their destination station. EveJS's native contract completion validates
  the intact package and cargo before paying the reward and returning the
  collateral.

If the package is missing, damaged, or otherwise invalid, the contract stays
active and the mod retries on a later successful dock. When no accepted NPC
courier remains, the mod leaves the current route unchanged.

## Compatibility and installation

- EveJS 0.12.9
- Native backend
- A game-server restart after enabling, disabling, or updating the mod
- A funded NPC issuer corporation cash division

The Launcher should discover the mod from `mods/npcCourierContracts` like the other native loader mods. The default issuer is InterBus corporation `1000148`, represented by NPC character `3015955`. Both can be changed in `config/contracts.json`.

The mod includes a bounded NPC treasury for the default single-player economy. It seeds the issuer corporation's cash division to 50,000,000,000 ISK when the balance is below the 20% threshold of 10,000,000,000 ISK, then replenishes it back to 50,000,000,000 ISK. Funding uses EveJS's normal corporation-wallet authority and is recorded with an idempotent receipt, so a restart cannot duplicate the same replenishment. Disable `treasury.enabled` if you prefer to fund the issuer manually. If treasury replenishment fails and the wallet is underfunded, the server continues normally and generation pauses.

## Default behavior

The generator waits 30 seconds after server startup and then runs every five minutes. It maintains up to ten outstanding contracts per origin and up to 200 generated contracts overall. Return-route generation is enabled by default, so the actual total depends on available reverse routes and the global cap.

Initial origins are:

- Jita IV - Moon 4 - Caldari Navy Assembly Plant (`60003760`)
- Amarr VIII - Emperor Family Academy (`60008494`)
- Dodixie IX - Moon 20 - Federation Navy Assembly Plant (`60011866`)
- Rens VI - Moon 8 - Brutor Tribe Treasury (`60004588`)
- Hek VIII - Moon 12 - Boundless Creation Factory (`60005686`)

Contracts contain multiple real NPC-owned cargo stacks. Acceptance moves the package and its contents into the hauler's ship cargo hold, so cargo capacity, ship loss, wreck recovery, delivery, collateral, expiration, and failure all matter. The default cargo catalog uses ordinary mineral commodities with type IDs 34 through 38.

Rewards increase with shortest stargate jump distance, cargo volume, and route security risk. The default jump component is 450,000 ISK per jump. By default, 35% of generated contracts prefer a destination within 5 jumps when one is available; the configured collateral is based on the cargo's reference value.

Successful courier delivery also awards a random 10–20 PLEX completion bonus. PLEX is paid directly to the accepting character's PLEX balance after the cargo reaches its destination; failed or abandoned contracts do not pay it.

All reachable high-security NPC stations may be destinations. A station gains activity from player presence, accepted/completed courier contracts, and optional market ticks read from the existing `_local/npcMarket/state.json` when that file is available. Stations reaching the promotion threshold can become new origins. Player-owned structures are not used by the first version.

## Configuration

Edit `mods/npcCourierContracts/config/contracts.json` while the Game server is
stopped, then restart the Game server. Important settings include:

- `contractsPerOrigin`, `maxOutstandingContracts`, and `generateReturnContracts`
- `clearExistingContractsOnce` runs the versioned cleanup before new generation. Set `wipeAllActiveContractsOnce` to `true` for a one-time wipe of all outstanding, rejected, and in-progress contracts, including player contracts; completed/failed history is preserved. In-progress courier collateral and reward escrow are returned, the wrapper is removed, and any remaining cargo is left in the ship.
- `legacyCleanupVersion` increments when a new courier cargo model requires another one-time cleanup
- `hubStationIDs`
- `issuer.corporationID`, `issuer.characterID`, `issuer.walletAccountKey`, and `issuer.contractHangarFlagID` (`115` through `121`)
- `treasury.enabled`, `treasury.targetBalanceISK`, and `treasury.replenishThresholdRatio`
- `allowedSecurityClasses`
- `shortHaulChance` and `shortHaulMaxJumps`
- `promotionThreshold` and `maxPromotedOrigins`
- `reward` and `collateral` formula values
- `cargo.referenceVolumeM3`, `cargo.minimumLoadFraction`, `cargo.maximumLoadFraction`, and stack-count limits
- `cargoCatalog`
- `plexReward.minimum` and `plexReward.maximum`
- `haulerProgression.maxLevel`, XP awards, level thresholds, and payout bonus
- Contract title and description templates

Courier Automation settings are stored per character in the runtime state and
are changed in-game. They are not server-wide configuration options.

Generated runtime state is stored outside the package at:

```text
<EVEJS data root>/npcCourierContracts/state.json
```

The state tracks activity scores, promoted stations, generated contract IDs, idempotent cargo jobs, and treasury replenishment receipts so reconnects and server restarts do not create duplicate packages or deposits. If a contract creation attempt fails after cargo is granted, the next tick repairs that package's corporation-hangar flag and retries it before generating new cargo.

## Disabling and removal

Set `enabled` to `false` and restart the Game server. Existing contracts remain governed by EveJS's normal contract lifecycle; disabling the mod stops new generation. After confirming no generated contracts remain, the `npcCourierContracts` state directory can be removed if a completely fresh generator state is desired.

Do not delete the state directory while generated contracts are still active unless you intentionally want the generator to stop tracking them. Existing courier escrow remains owned by the native contract runtime.

## GitHub installation

Clone this repository into the EveJS `mods` directory, enable it in the EveJS
Launcher, and restart the Game server:

```powershell
git clone <repository-url> mods/npcCourierContracts
```

Replace `<repository-url>` with the GitHub URL for this project. To update an
existing checkout, run `git pull` from `mods/npcCourierContracts`. Keep
`evejs-launcher.mod.json` directly inside that directory.

This is a native-only EveJS mod. Docker deployments are not supported.

## License and maintenance

This project is released under the MIT License. See [LICENSE](LICENSE).

If the project becomes unmaintained, you may continue working on it, modify
it, and release your own version. Please keep the original author credit to
**Troublesum** in the documentation and source distribution.

## What this mod is

NPC Courier Contracts generates public courier contracts from NPC stations,
including physical cargo with a real volume requirement. It uses EveJS's
native contract runtime so the contracts appear and behave through the normal
EVE Contracts interface.
