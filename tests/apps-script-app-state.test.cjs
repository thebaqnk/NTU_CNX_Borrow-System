const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeCache {
  constructor() {
    this.values = new Map();
  }

  get(key) {
    return this.values.get(key) ?? null;
  }

  put(key, value) {
    this.values.set(key, String(value));
  }

  remove(key) {
    this.values.delete(key);
  }
}

function loadAppState() {
  const cache = new FakeCache();
  const calls = { inventory: 0, user: 0, verified: 0 };
  let processed = null;
  const sourcePath = path.join(__dirname, "..", "apps-script", "AppState.gs");
  const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
  const context = {
    CacheService: { getScriptCache: () => cache },
    getInventoryData(id) {
      calls.inventory += 1;
      return { id, floor: "1", room: "101", status: "ถูกยืม", type: "ITEM" };
    },
    getUserData() {
      calls.user += 1;
      return { name: "Real User", phone: "0612345678", role: "บุคลากร" };
    },
    checkVerifyStatus() {
      calls.verified += 1;
      return true;
    },
    processAction(obj, lineId) {
      processed = { obj, lineId };
      return { status: "SUCCESS" };
    },
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return { cache, calls, context, getProcessed: () => processed };
}

test("getAppState returns a complete cached state after the QR handoff", () => {
  const fixture = loadAppState();

  assert.equal(typeof fixture.context.getAppState, "function");
  const first = fixture.context.getAppState("U_TEST", "ITEM01");
  const second = fixture.context.getAppState("U_TEST", "ITEM01");

  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    info: { id: "ITEM01", floor: "1", room: "101", status: "ถูกยืม", type: "ITEM" },
    user: { name: "Real User", phone: "0612345678", role: "บุคลากร" },
    verified: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  assert.deepEqual(fixture.calls, { inventory: 1, user: 1, verified: 1 });
});

test("processActionV2 ignores client profile fields and uses the server profile", () => {
  const fixture = loadAppState();

  assert.equal(typeof fixture.context.processActionV2, "function");
  const result = fixture.context.processActionV2(
    {
      id: "ITEM01",
      action: "คืนอุปกรณ์",
      name: "Spoofed User",
      phone: "0000000000",
      role: "ผู้ดูแลระบบ",
    },
    "U_TEST",
  );

  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.getProcessed())), {
    lineId: "U_TEST",
    obj: {
      id: "ITEM01",
      action: "คืนอุปกรณ์",
      name: "Real User",
      phone: "0612345678",
      role: "บุคลากร",
    },
  });
});

test("optimized action router distinguishes handled and legacy actions", () => {
  const fixture = loadAppState();

  assert.equal(typeof fixture.context.routeOptimizedAction_, "function");
  const optimized = fixture.context.routeOptimizedAction_({
    action: "getAppState",
    email: "U_TEST",
    id: "ITEM01",
  });
  const legacy = fixture.context.routeOptimizedAction_({ action: "getInventoryList" });

  assert.equal(optimized.handled, true);
  assert.equal(optimized.result.user.name, "Real User");
  assert.deepEqual(JSON.parse(JSON.stringify(legacy)), { handled: false });
});
