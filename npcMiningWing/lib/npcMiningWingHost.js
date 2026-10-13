"use strict";

const path = require("node:path");

const configuredEvejsRoot = String(process.env.EVEJS_ROOT || "").trim();
const EVEJS_ROOT = configuredEvejsRoot
  ? path.resolve(configuredEvejsRoot)
  : path.resolve(__dirname, "..", "..", "..");

function hostPath(...segments) {
  return path.join(EVEJS_ROOT, ...segments);
}

function serverPath(...segments) {
  return hostPath("server", "src", ...segments);
}

module.exports = Object.freeze({
  EVEJS_ROOT,
  hostPath,
  serverPath,
});
