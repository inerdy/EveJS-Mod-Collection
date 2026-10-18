"use strict";

const path = require("node:path");

const REPO_ROOT = path.resolve(
  process.env.EVEJS_ROOT || path.resolve(__dirname, "..", "..", ".."),
);
const serverPath = (...segments) => path.join(REPO_ROOT, "server", "src", ...segments);

let runtimeDependencies = null;

function getRuntimeDependencies() {
  if (runtimeDependencies) {
    return runtimeDependencies;
  }
  runtimeDependencies = Object.freeze({
    npcRuntime: require(serverPath("space", "npc", "npcRuntime")),
    npcService: require(serverPath("space", "npc", "npcService")),
    destinyMovement: require(serverPath("space", "runtime", "destinyMovementEngine")),
    itemTypes: require(serverPath("services", "inventory", "itemTypeRegistry")),
    nativeNpcStore: require(serverPath("space", "npc", "nativeNpcStore")),
    spaceRuntime: require(serverPath("space", "runtime")),
    stargateRadius: require(serverPath("space", "stargateRadius")),
  });
  return runtimeDependencies;
}

module.exports = {
  REPO_ROOT,
  getRuntimeDependencies,
  serverPath,
};
