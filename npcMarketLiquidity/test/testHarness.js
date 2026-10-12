"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {createRequire} = require("node:module");
const serverRoot = path.resolve(__dirname, "../../../server/src");
const serverPath = (relative) => path.join(serverRoot, relative);
const quietLog = {log() {}, info() {}, warn() {}, error() {}, debug() {}};

function loadModule(filename, imports, extraExports = "") {
  const nativeRequire = createRequire(filename);
  const module = {exports: {}};
  const requireMock = (request) => {
    if (Object.prototype.hasOwnProperty.call(imports, request)) return imports[request];
    const resolved = nativeRequire.resolve(request);
    if (Object.prototype.hasOwnProperty.call(imports, resolved)) return imports[resolved];
    if (resolved.startsWith(serverRoot + path.sep)) {
      throw new Error(`Unmocked server dependency: ${resolved}`);
    }
    return nativeRequire(request);
  };
  const code = fs.readFileSync(filename, "utf8");
  vm.runInNewContext(`(function(require, module, exports, __dirname) {\n${code}\n${extraExports}\n})`,
    {console: quietLog, Buffer, setTimeout, clearTimeout, setInterval, clearInterval},
    {filename})(requireMock, module, module.exports, path.dirname(filename));
  return module.exports;
}

function loadService({marketDaemonClient, items = [], hooks = {}}) {
  const imports = {
    [serverPath("services/baseService.js")]: class BaseService {},
    [serverPath("utils/logger/index.js")]: quietLog,
    [serverPath("config/dataRoot.js")]: {resolveDataRootPath: () => "unused-test-state"},
    [serverPath("services/inventory/itemTypeRegistry.js")]: {listItemTypes: () => items},
    [serverPath("services/_shared/stationStaticData.js")]: {
      getStationRecord: (_session, stationID) => ({stationID, regionID: 10000002}),
    },
    [serverPath("services/market/marketDaemonClient.js")]: {marketDaemonClient},
    [serverPath("services/market/marketTopology.js")]: {isBidOrderInRange: () => true},
    [serverPath("services/market/marketProxyService.js")]: {__testHooks: hooks},
  };
  return {imports, Service: loadModule(path.resolve(__dirname, "../lib/npcMarketLiquidityService.js"), imports)};
}

module.exports = {loadModule, loadService, serverPath, quietLog};
