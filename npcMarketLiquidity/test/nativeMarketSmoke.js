"use strict";

// Optional native integration smoke: launches an EXISTING daemon executable
// with a newly created disposable market DB and random loopback ports. No
// production config, market data, GameStore, wallet, or inventory is opened.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const {spawn} = require("node:child_process");
const {DatabaseSync} = require("node:sqlite");
const {loadService} = require("./testHarness");
const {normalizeConfig} = require("../lib/config");
const {createPurchaseHarness} = require("./purchaseHarness");
const repoRoot = path.resolve(__dirname, "../../..");

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve);});
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function rpc(port, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: "127.0.0.1", port});
    let buffer = "";
    socket.setTimeout(5000, () => socket.destroy(new Error(`RPC timeout: ${method}`)));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({id: 1, method, params}) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.split("\n")[0]);
        if (!response.ok) throw new Error(response.error);
        resolve(response.result);
      } catch (error) {reject(error);}
    });
    socket.on("end", () => {if (!buffer.includes("\n")) reject(new Error("RPC closed without response"));});
  });
}

async function main() {
  const executable = path.resolve(process.argv[2] || path.join(repoRoot,
    "externalservices/market-server/target/release/market-server.exe"));
  assert.ok(fs.existsSync(executable), `Supply an existing market daemon executable: ${executable}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-native-npc-test-"));
  const databasePath = path.join(root, "market.sqlite");
  const configPath = path.join(root, "market.toml");
  let daemon;
  let exitPromise;
  let output = "";
  try {
    const commonSource = fs.readFileSync(path.join(repoRoot,
      "externalservices/market-server/crates/market-common/src/lib.rs"), "utf8");
    const schema = commonSource.match(/pub const SCHEMA_SQL: &str = r#"([\s\S]*?)"#;/)[1];
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(schema);
      db.prepare("INSERT INTO manifest VALUES ('manifest_json', ?)").run(JSON.stringify({
        schema_version: 1, generated_at: new Date().toISOString(), static_data_dir: root,
        database_path: databasePath, region_count: 1, solar_system_count: 1, station_count: 1,
        market_type_count: 1, seed_row_count: 0, default_quantity_per_station_type: 100000,
        seed_buy_orders_enabled: true, history_days_seeded: 0, seed_markup_percent: 0,
        station_jitter_percent: 0, region_jitter_percent: 0,
      }));
      db.exec("INSERT INTO regions VALUES (10000043, 'Domain'); " +
        "INSERT INTO solar_systems VALUES (30002187, 10000043, 20000322, 'Amarr', 0.9); " +
        "INSERT INTO stations VALUES (60008494, 30002187, 20000322, 10000043, 'Amarr hub', 0.9); " +
        "INSERT INTO market_types VALUES (17887, 1, 4, 1, 'Oxygen Isotopes', 'Fuel', 600, 0.15, 1, 1);");
    } finally {db.close();}
    const httpPort = await freePort();
    let rpcPort = await freePort();
    while (rpcPort === httpPort) rpcPort = await freePort();
    fs.writeFileSync(configPath, `[network]\nport = ${httpPort}\n[rpc]\nenabled = true\nport = ${rpcPort}\n` +
      `[storage]\ndatabase_path = '${databasePath.replace(/\\/g, "/")}'\n[logging]\nlog_level = "warn"\n`);
    daemon = spawn(executable, ["--config", configPath, "serve"], {cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    daemon.stdout.on("data", (data) => {output = (output + data).slice(-8000);});
    daemon.stderr.on("data", (data) => {output = (output + data).slice(-8000);});
    let spawnError;
    exitPromise = new Promise((resolve) => {
      daemon.once("exit", resolve);
      daemon.once("error", (error) => {spawnError = error; resolve();});
    });
    const deadline = Date.now() + 15000;
    let health;
    while (!health && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (daemon.exitCode !== null) throw new Error(`Test daemon exited: ${output}`);
      try {health = await rpc(rpcPort, "Health");}
      catch (error) {
        if (error.code !== "ECONNREFUSED") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(health, `Test daemon did not start: ${output}`);
    assert.ok(health.capabilities.includes("npc-passive-orders-v1"), "This executable lacks native NPC support");
    const calls = [];
    const marketDaemonClient = {call: (method, params) => {
      calls.push(method);
      return rpc(rpcPort, method, params);
    }};
    const config = normalizeConfig({});
    const {Service} = loadService({marketDaemonClient, items: [{typeID: 17887,
      name: "Oxygen Isotopes", published: true, marketGroupID: 1, volume: 0.15, portionSize: 1}]});
    const service = new Service({autoStart: false, config,
      stateStore: {load: () => ({}), save() {}}});
    service._manifestReference = () => ({askReference: 600, bidReference: 500});
    await service._ensureDaemonSupport();
    const existing = await service._listExistingOrders();
    const result = await service._processFuelSeed({stationID: 60008494},
      config.fuelSeeds.find((fuel) => fuel.typeID === 17887), existing, Date.now());
    assert.equal(result.created, 1);
    const orderID = existing[0].order_id;
    const book = await marketDaemonClient.call("GetOrders", {region_id: 10000043, type_id: 17887});
    assert.equal(book.sells[0].source, "npc-passive");
    assert.equal(book.sells[0].order_id, orderID);

    // Run the ACTUAL EveJS purchase matching and fill saga against the real
    // daemon; only the game-side persistence/wallet/inventory are fixtures.
    const game = createPurchaseHarness(marketDaemonClient);
    const beforeBalance = game.wallet.balance;
    calls.length = 0;
    const purchase = await game.purchase({buyerCharacterID: 90000001, regionID: 10000043,
      typeID: 17887, maxPrice: 1000, requestedQuantity: 3, orderRange: -1,
      currentStationID: 60008494, currentSolarSystemID: 30002187});
    assert.equal(purchase.boughtQuantity, 3);
    assert.equal(game.wallet.balance, beforeBalance - book.sells[0].price * 3);
    assert.equal(game.inventory.length, 1);
    assert.equal(game.inventory[0].quantity, 3);
    assert.equal(game.inventory[0].locationID, 60008494);
    assert.equal(game.escrow.size, 0, "completed saga leaves no pending escrow");
    assert.deepEqual(calls, ["GetOrders", "FillOrder"], "no purchase-time GetOwnerOrders scan");
    const refreshed = await marketDaemonClient.call("GetOrders", {region_id: 10000043, type_id: 17887});
    assert.equal(refreshed.sells[0].vol_remaining, 99997);

    // Native bids must also survive the daemon's merged-book source filter.
    await service._placeOrder({stationID: 60008494}, {typeID: 17887, volume: 0.15},
      "buy", 0, {bestAsk: 600, bestBid: 500, askReference: 600, bidReference: 500}, existing,
      {quantityPerOrder: 10});
    const bidBook = await marketDaemonClient.call("GetOrders", {region_id: 10000043, type_id: 17887});
    assert.equal(bidBook.buys[0].source, "npc-passive");
    assert.equal(bidBook.buys[0].vol_remaining, 10);

    // Negative control reproduces the reported bug in this disposable DB:
    // player-labelled owner-0 sells still correctly require seller escrow.
    await marketDaemonClient.call("PlaceOrder", {owner_id: 0, is_corp: false,
      station_id: 60008494, type_id: 17887, price: 1, quantity: 100,
      bid: false, source: "player"});
    const balanceAfterPurchase = game.wallet.balance;
    await assert.rejects(game.purchase({buyerCharacterID: 90000001, regionID: 10000043,
      typeID: 17887, maxPrice: 1000, requestedQuantity: 1, orderRange: -1,
      currentStationID: 60008494, currentSolarSystemID: 30002187}), /missing escrow state/);
    assert.equal(game.wallet.balance, balanceAfterPurchase);
    assert.equal(game.inventory.length, 1);
    console.log("Native smoke passed: mod fuel -> stored npc-passive -> EveJS purchase -> wallet debit, item delivery, quantity 100000 to 99997; native bid visible");
  } finally {
    if (daemon && daemon.exitCode === null && !daemon.killed) daemon.kill();
    if (exitPromise) await exitPromise;
    // Only remove the unique fixture directory created above, never a supplied path.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("evejs-native-npc-test-"));
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}

main().catch((error) => {console.error(error); process.exitCode = 1;});
