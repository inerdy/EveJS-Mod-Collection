"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"));
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
      packageFiles.push(entryPrefix.replace(/\\/g, "/"));
    }
  }
}
collectFiles(modRoot, "");
assert.deepEqual(packageFiles.sort(), [
  "LICENSE",
  "README.md",
  "assets/npc-mining-wing.png",
  "client/menu.py",
  "evejs-launcher.mod.json",
  "lib/npcMiningWingDroneBridge.js",
  "lib/npcMiningWingService.js",
  "loader.js",
  "test/validate.js",
]);

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "npcminingwing");
assert.equal(manifest.version, "0.10.1");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.equal(manifest.clientMenu.entrypoint, "client/menu.py");
assert.equal(manifest.clientMenu.apiVersion, 1);
const loader = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
assert.match(loader, /npcMiningWingService/);
assert.match(loader, /npcMiningWingDroneBridge/);
assert.match(loader, /automatic drone/);
const readme = fs.readFileSync(path.join(modRoot, "README.md"), "utf8");
assert.match(readme, /NPC Mining Wing lets a player deploy/u);
assert.match(readme, /native-only/u);
assert.match(readme, /Docker deployments are not supported/u);
assert.match(readme, /Wing Comms/u);
assert.match(readme, /gameStore\/npcMiningWing\/state\.json/u);
assert.match(readme, /six owned ships/u);
assert.match(readme, /collection ship/u);
const client = fs.readFileSync(path.join(modRoot, "client", "menu.py"), "utf8");
assert.match(client, /evejs_mod_menu/);
assert.doesNotMatch(client, /^import sm$/mu);
assert.match(client, /EveLabelMedium/u);
assert.doesNotMatch(client, /EveLabelSmall/u);
assert.doesNotMatch(client, /\basync\b|(?<![0-9a-fA-F])f['"]|:=/u);
assert.match(client, /_service\s*=\s*['"]npcMiningWing['"]/u);
assert.match(client, /sm\.RemoteSvc\(_service\)/u);
assert.match(client, /EnsureWingChat/u);
assert.match(client, /_join_wing_chat_client/u);
assert.match(client, /XmppChat/u);
assert.match(client, /blue\.pyos\.synchro\.SleepWallclock\(1000\)/u);
assert.match(client, /Recall Wing/u);
assert.match(client, /Ship Roster/u);
assert.match(client, /right-click a ship name for commands/u);
assert.match(client, /default_width\s*=\s*640/u);
assert.match(client, /class NpcMiningWingShipRow/u);
assert.match(client, /class NpcMiningWingShipLabel/u);
assert.match(client, /def GetMenu\(self\)/u);
assert.match(client, /state=uiconst\.UI_NORMAL/u);
assert.match(client, /_COLOR_SHIP/u);
assert.match(client, /_color_text\(_COLOR_SHIP, '<u>%s<\/u>'/u);
assert.match(client, /_COLOR_LABEL/u);
assert.match(client, /_COLOR_DRONE/u);
assert.match(client, /Cargo:/u);
assert.match(client, /Drones:/u);
assert.match(client, /height=88/u);
assert.match(client, /cargo_capacity/u);
assert.match(client, /pilotName/u);
assert.match(client, /ScrollContainer/u);
assert.match(client, /class NpcMiningWingTab/u);
assert.match(client, /Wing Ships/u);
assert.match(client, /All Ships/u);
assert.match(client, /def _select_tab\(self, tab_key\)/u);
assert.match(client, /def _status_color\(status\)/u);
assert.match(client, /_color_text\(_COLOR_MUTED, status_detail\)/u);
assert.match(client, /Follow Wing/u);
assert.match(client, /Collect Cargo from Ship/u);
assert.match(client, /SetCollectionShip/u);
assert.match(client, /SendCollectionShip/u);
assert.match(client, /COLLECTION SHIP/u);
assert.doesNotMatch(client, /carbonui\.control\.button/u);
assert.doesNotMatch(client, /label='Find'/u);
assert.doesNotMatch(client, /_add_command_row/u);
assert.match(client, /statusLabel/u);
assert.match(fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8"), /npcMiningWing/);
assert.match(fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8"), /getCharacterShipItems/);
assert.doesNotMatch(fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8"), /listCharacterShipItems/);
assert.match(fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8"), /JSON\.stringify\(/);
assert.match(fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8"), /unwrapMarshalValue/);
assert.match(fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8"), /function requestObject/);
assert.match(client, /json\.loads\(response\)/u);
const service = fs.readFileSync(path.join(modRoot, "lib", "npcMiningWingService.js"), "utf8");
const droneBridge = fs.readFileSync(
  path.join(modRoot, "lib", "npcMiningWingDroneBridge.js"),
  "utf8",
);
const miningRuntime = fs.readFileSync(
  path.join(modRoot, "..", "..", "server", "src", "services", "mining", "miningRuntime.js"),
  "utf8",
);
assert.match(service, /spaceRuntime/);
assert.match(service, /moveShipToSpace/);
assert.match(service, /spawnDynamicInventoryEntity/);
assert.match(service, /followDynamicEntity/);
assert.match(service, /stopDynamicEntity/);
assert.match(service, /startSessionlessWarpIngress/);
assert.match(service, /dockShipToLocation/);
assert.match(service, /returnLocationIDs/);
assert.match(service, /recallStationIDs/);
assert.match(service, /Handle_DeployWing/);
assert.match(service, /Handle_RecallWing/);
assert.match(service, /Handle_TransferCargo/);
assert.match(service, /Handle_SetCollectionShip/);
assert.match(service, /Handle_SendCollectionShip/);
assert.match(service, /collectionTrip/);
assert.match(service, /_availableCollectionShipID/);
assert.match(service, /collectionShipID/);
assert.match(service, /destinationShipID/);
assert.match(service, /getPreferredMiningHoldFlagForType/);
assert.match(service, /destinationHold/);
assert.match(service, /sendSystemMessage/);
assert.match(service, /Handle_EnsureWingChat/);
assert.match(service, /createPlayerChannel/);
assert.match(service, /WING_CHAT_DISPLAY_NAME/);
assert.match(service, /joinChannel:/u);
assert.match(service, /Wing Comms/);
assert.match(service, /friendlyErrorMessage/);
assert.match(service, /no-mining-module/);
assert.match(service, /MAX_WING_SHIPS/);
assert.match(service, /NPC_WING_MAX_SHIPS_EXCEEDED/);
assert.match(service, /CARGO_FOLLOW_RANGE_METERS/);
assert.match(service, /isMiningOutputItem/);
assert.match(service, /cargoReturn/);
assert.match(service, /cargo-waiting/);
assert.match(service, /NPC_WING_DESTINATION_HOLD_FULL/);
assert.match(service, /automatic: true/);
assert.match(service, /NPC_WING_COLLECTION_TRIP_ACTIVE/);
assert.match(service, /_transferCargoForShip/);
assert.match(service, /miningRuntimeState/);
assert.match(service, /_applyWingSkillProfile/);
assert.match(service, /runtimeOwnerCharacterID/);
assert.match(service, /pilotCharacterID\s*=\s*positive\(characterID\)/u);
assert.match(service, /activateGenericModule/);
assert.match(service, /_buildWingModuleSession/);
assert.match(service, /_deactivateWingMiningModules/);
assert.match(service, /followTransit/);
assert.match(service, /native mining activated/);
assert.doesNotMatch(service, /_mineOneCycle/);
assert.doesNotMatch(service, /computeMiningResult/);
assert.match(service, /getCachedCharacterSkillMap/);
assert.match(service, /buildShipResourceState/);
assert.match(service, /_resolveMiningModules/);
assert.match(service, /surfaceDistanceBetween/);
assert.match(service, /MINING_RANGE_BUFFER_METERS/);
assert.match(service, /_tickWingDroneDefense/);
assert.match(service, /getNpcMiningWingGroupAggression/);
assert.match(service, /_hiveDefenseThreats/);
assert.match(service, /npcMiningWingLeader/);
assert.match(service, /hiveDefenseOverrides/);
assert.match(service, /Hive defense/);
assert.match(droneBridge, /aggressionByCharacter/);
assert.match(droneBridge, /getNpcMiningWingGroupAggression/);
assert.match(droneBridge, /npcMiningWingLeader/);
assert.match(service, /_tickWingDroneAutomation/);
assert.match(service, /_maintainMiningDrones/);
assert.match(service, /WING_DRONE_MARKER_PREFIX/);
assert.match(service, /_prepareWingShipForDock/);
assert.match(service, /_recoverDockedWingDrones/);
assert.match(service, /_reattachWingDroneEntities/);
assert.match(service, /_droneResponseError/);
assert.match(service, /native drone runtime consumes the same wire shape/u);
assert.match(service, /Math\.max\(1, itemQuantity\(item\)\)/u);
assert.match(service, /compatibleDrones\.length > 0/u);
assert.match(service, /combatPaused/);
assert.match(service, /DRONE_RETRY_MS/);
assert.match(service, /DRONE_CATEGORY_ID/);
assert.match(service, /ice harvesting/);
assert.match(service, /augmented/);
assert.match(service, /excavator/);
assert.match(service, /deployedDroneCount/);
assert.match(service, /npcMiningWingController/);
assert.match(droneBridge, /launchDronesForWingShip/);
assert.match(droneBridge, /commandEngageForWingShip/);
assert.match(droneBridge, /commandMineForWingShip/);
assert.match(droneBridge, /commandReturnBayForWingShip/);
assert.match(droneBridge, /getNpcMiningWingAggression/);
assert.match(droneBridge, /resolveWingDroneCapabilities/);
assert.match(droneBridge, /noteIncomingAggression/);
assert.match(droneBridge, /getActiveShipRecord/);
assert.match(droneBridge, /activeShipOverrides/);
assert.doesNotMatch(service, /server[\\/]src[\\/].*write/);
assert.match(service, /getEntityTargetingStats/);
assert.match(service, /orbitShipEntity/);
assert.match(service, /target-incompatible/);
assert.match(service, /gate-follow/);
assert.match(service, /recallTransit/);
assert.match(service, /dockingStationIDs/);
assert.match(service, /dockingWithLeader/);
assert.match(service, /pendingDock/);
assert.match(service, /statusLabel/);
assert.match(service, /recallTargetSummary/);
assert.match(service, /follow-dock/);
assert.match(service, /_syncDockedShipToSession/);
assert.match(service, /_depositDockedMiningCargo/);
assert.match(service, /isMiningOutputItem/);
assert.match(service, /moveItemToLocation/);
assert.match(service, /ITEM_FLAGS\.HANGAR/);
assert.match(service, /station hangar/);
assert.match(service, /emitCfgLocation: true/);
assert.match(service, /deployedSystemID/);
assert.match(service, /NPC_WING_NOT_IN_SPACE/);
assert.match(client, /DeployWing/);
assert.match(client, /Deploy Wing/);
assert.match(client, /RecallWing/);
assert.match(client, /Recall Wing/);
assert.match(client, /TransferCargo/);
assert.match(client, /SetDestination/);
assert.match(miningRuntime, /runtimeOwnerCharacterID/);
assert.match(miningRuntime, /const persistedShipItem = findShipItemById/);
assert.match(miningRuntime, /entity\.skillMap instanceof Map/);
console.log("NPC Mining Wing manifest and package checks passed.");
