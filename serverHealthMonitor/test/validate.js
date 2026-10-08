"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(modRoot, "evejs-launcher.mod.json"), "utf8"));
const {normalizeConfig} = require(path.join(modRoot, "lib", "config"));
const Service = require(path.join(modRoot, "lib", "healthMonitorService"));
const testing = Service._testing;

function read(relativePath) {
  return fs.readFileSync(path.join(modRoot, relativePath), "utf8");
}

assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.id, "serverhealthmonitor");
assert.equal(manifest.displayName, "Server Health Monitor");
assert.equal(manifest.version, "0.1.0");
assert.deepEqual(manifest.supportedBackends, ["native"]);
assert.equal(manifest.activation.strategy, "loader_rename");
assert.equal(manifest.restart, "game_server");
assert.deepEqual(manifest.compatibility.evejsVersions, ["0.12.9"]);
assert.deepEqual(manifest.clientMenu, {apiVersion: 1, entrypoint: "client/menu.py"});

const config = normalizeConfig(JSON.parse(read("config/health-monitor.json")));
assert.equal(config.enabled, true);
assert.equal(config.sampleIntervalMs, 1000);
assert.equal(config.historyMinutes, 5);
assert.equal(config.thresholds.degradedEventLoopDelayMs, 100);
assert.equal(config.thresholds.stalledEventLoopDelayMs, 2000);
assert.equal(config.logging.maxBytes, 5242880);

assert.equal(testing.classifyStatus({
  eventLoopDelayMs: 10,
  tickDurationMs: 50,
  tickLatenessMs: 5,
  thresholds: config.thresholds,
}), "healthy");
assert.equal(testing.classifyStatus({
  eventLoopDelayMs: 150,
  tickDurationMs: 50,
  tickLatenessMs: 5,
  thresholds: config.thresholds,
}), "degraded");
assert.equal(testing.classifyStatus({
  eventLoopDelayMs: 2500,
  tickDurationMs: 50,
  tickLatenessMs: 5,
  thresholds: config.thresholds,
}), "stalled");
assert.equal(testing.classifyStatus({
  eventLoopDelayMs: 10,
  tickDurationMs: 3000,
  tickLatenessMs: 5,
  thresholds: config.thresholds,
}), "stalled");
assert.equal(testing.hasGMAccess({role: "18014398509481984"}), true);
assert.equal(testing.hasGMAccess({role: "0"}), false);
assert.equal(testing.hasGMAccess(null), false);
assert.equal(testing.metricAverage([{value: 10}, {value: 20}], "value"), 15);
assert.equal(testing.metricMaximum([{value: 10}, {value: 20}], "value"), 20);

const dataDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "health-monitor-"));
let runtimeTick = {
  tickDurationMs: 18,
  latenessMs: 4,
  actualIntervalMs: 100,
  targetTickIntervalMs: 100,
  sceneCount: 1,
  tickedSceneCount: 1,
};
const service = new Service({
  config,
  autoStart: false,
  dataDir,
  runtime: {
    scenes: new Map([[1, {sessions: new Map([[1, {}]])}]]),
    _testing: {
      getLastRuntimeTickSummary: () => runtimeTick,
    },
  },
});
service._nextSampleAtMs = Date.now();
const firstSample = service._sample();
assert.equal(firstSample.status, "healthy");
assert.equal(firstSample.sessions, 1);
assert.equal(firstSample.sceneCount, 1);
const snapshot = service.getHealthStatus();
assert.equal(snapshot.status, "healthy");
assert.equal(snapshot.current.tickDurationMs, 18);
assert.equal(snapshot.current.sessions, 1);
assert.equal(snapshot.history.length, 1);
runtimeTick = {...runtimeTick, tickDurationMs: 3000};
service._nextSampleAtMs = Date.now() - 1;
assert.equal(service._sample().status, "stalled");
runtimeTick = {...runtimeTick, tickDurationMs: 18};
service._nextSampleAtMs = Date.now() + config.sampleIntervalMs;
assert.equal(service._sample().status, "healthy");
const incidentLog = fs.readFileSync(
  path.join(dataDir, "serverHealthMonitor", "health-events.jsonl"),
  "utf8",
).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
assert.deepEqual(incidentLog.map((entry) => entry.event), ["stalled", "recovered"]);
assert.ok(incidentLog[1].durationMs >= 0);
service.stop();
assert.throws(
  () => service.Handle_GetHealthStatus({}, {role: "0"}),
  /SERVER_HEALTH_MONITOR_GM_ONLY/u,
);
const gmSnapshot = JSON.parse(
  service.Handle_GetHealthStatus({}, {role: "18014398509481984"}),
);
assert.equal(gmSnapshot.status, "healthy");

const client = read("client/menu.py");
assert.match(client, /Server Health Monitor/u);
assert.match(client, /ScrollContainer/u);
assert.match(client, /GetHealthStatus/u);
assert.match(client, /Recent health history/u);
assert.match(client, /Systems loaded/u);
assert.match(client, /Active sessions/u);
assert.match(client, /_client_is_gm/u);
assert.match(client, /mods\.register/u);

const loader = read("loader.js");
assert.match(loader, /servicemanager\.js/u);
assert.match(loader, /serverHealthMonitor/u);
assert.match(loader, /normalizedPath/u);

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
  "config/health-monitor.json",
  "evejs-launcher.mod.json",
  "lib/config.js",
  "lib/healthMonitorService.js",
  "loader.js",
  "test/validate.js",
]);

console.log("Server Health Monitor manifest, thresholds, sampling, dashboard, logging, and package checks passed.");
