const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function response(payload, options = {}) {
  const body = options.rawBody ?? JSON.stringify(payload);

  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    },
  };
}

function loadIndex(fetchSteps, options = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const source = scripts.find((script) => script.includes("const LIFF_ID"));
  assert.ok(source, "inline application script must exist");

  const elements = new Map();
  for (const id of [
    "emojiDisplay",
    "statusText",
    "loadingScreen",
    "contentArea",
    "pageHeader",
    "profileBox",
    "uNameDisp",
    "uPhoneDisp",
    "verifyStatus",
    "regForm",
    "uRole",
    "uName",
    "uPhone",
    "actionArea",
  ]) {
    elements.set(id, {
      classList: { add() {}, remove() {} },
      innerHTML: "",
      innerText: "",
      value: "",
    });
  }

  let reloadCount = 0;
  const location = {
    href: "https://example.test/?id=RETURN",
    search: "?id=RETURN",
    reload() {
      reloadCount += 1;
    },
  };
  const swalCalls = [];
  const scheduleTimer = setTimeout;
  const cancelTimer = clearTimeout;
  let step = 0;
  const context = {
    AbortController,
    URLSearchParams,
    console: { error() {}, log() {} },
    document: {
      addEventListener() {},
      getElementById(id) {
        return elements.get(id);
      },
    },
    fetch: async (...args) => {
      const handler = fetchSteps[step++];
      assert.ok(handler, `unexpected fetch #${step}`);
      const handlerResult = Promise.resolve().then(() => handler(...args));
      const signal = args[1] && args[1].signal;
      if (!signal) return handlerResult;
      if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const aborted = new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
      return Promise.race([handlerResult, aborted]);
    },
    liff: {
      async getProfile() {
        return { userId: "U_TEST" };
      },
      async init() {},
      isLoggedIn() {
        return true;
      },
      login() {},
    },
    location,
    setInterval() {
      return 0;
    },
    clearInterval() {},
    setTimeout(callback, delay = 0) {
      const scaledDelay = options.timerScale
        ? Math.ceil(delay / options.timerScale)
        : 0;
      return scheduleTimer(callback, scaledDelay);
    },
    clearTimeout(timer) {
      cancelTimer(timer);
    },
    Swal: {
      fire(...args) {
        swalCalls.push(args);
        return Promise.resolve({});
      },
      showLoading() {},
    },
  };
  context.window = { location };

  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__app = { callGAS, doAction, doVerify, init, saveUser, sys };`,
    context,
  );

  return {
    app: context.__app,
    elements,
    getReloadCount: () => reloadCount,
    getSwalCalls: () => swalCalls,
    location,
    response,
  };
}

test("QR handoff loads inventory, profile, and verification in one request", async () => {
  const requests = [];
  const fixture = loadIndex([
    async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response({
        info: {
          id: "ITEM01",
          floor: "1",
          room: "101",
          status: "ถูกยืม",
          type: "ITEM",
        },
        user: {
          name: "Debug User",
          phone: "0612345678",
          role: "บุคลากร",
        },
        verified: true,
      });
    },
  ]);

  await fixture.app.init();

  assert.deepEqual(requests, [
    { action: "getAppState", email: "U_TEST", id: "RETURN" },
  ]);
  assert.equal(fixture.elements.get("uNameDisp").innerText, "Debug User (บุคลากร)");
  assert.equal(fixture.elements.get("uPhoneDisp").innerText, "📞 0612345678");
});

test("QR handoff falls back to legacy reads when the combined request stalls", { timeout: 1000 }, async () => {
  const requests = [];
  const recordRequest = (options) => requests.push(JSON.parse(options.body));
  const fixture = loadIndex([
    async (_url, options) => {
      recordRequest(options);
      return new Promise(() => {});
    },
    async (_url, options) => {
      recordRequest(options);
      return response({
        id: "RETURN",
        room: "จุดคืนอุปกรณ์",
        status: "พร้อมใช้งาน",
        type: "POINT",
      });
    },
    async (_url, options) => {
      recordRequest(options);
      return response({
        name: "Debug User",
        phone: "0612345678",
        role: "บุคลากร",
      });
    },
    async (_url, options) => {
      recordRequest(options);
      return response(true);
    },
  ]);

  await fixture.app.init();

  assert.deepEqual(requests.map(({ action }) => action), [
    "getAppState",
    "getInventoryData",
    "getUserData",
    "checkVerifyStatus",
  ]);
  assert.equal(fixture.elements.get("uNameDisp").innerText, "Debug User (บุคลากร)");
  assert.equal(fixture.elements.get("uPhoneDisp").innerText, "📞 0612345678");
});

test("QR handoff waits for a slow successful combined response without starting legacy reads", { timeout: 1000 }, async () => {
  const requests = [];
  const recordRequest = (options) => requests.push(JSON.parse(options.body));
  const fixture = loadIndex([
    async (_url, options) => {
      recordRequest(options);
      await new Promise((resolve) => setTimeout(resolve, 17));
      return response({
        info: {
          id: "A602",
          floor: 6,
          room: "ประชุม 602",
          status: "พร้อมใช้งาน",
          type: "ITEM",
        },
        user: {
          name: "Debug User",
          phone: "0612345678",
          role: "บุคลากร",
        },
        verified: false,
      });
    },
    async (_url, options) => {
      recordRequest(options);
      return response({
        id: "A602",
        floor: 6,
        room: "ประชุม 602",
        status: "พร้อมใช้งาน",
        type: "ITEM",
      });
    },
    async (_url, options) => {
      recordRequest(options);
      return response({
        name: "Debug User",
        phone: "0612345678",
        role: "บุคลากร",
      });
    },
    async (_url, options) => {
      recordRequest(options);
      return response(false);
    },
  ], { timerScale: 1000 });

  await fixture.app.init();

  assert.deepEqual(requests.map(({ action }) => action), ["getAppState"]);
  assert.equal(fixture.elements.get("uNameDisp").innerText, "Debug User (บุคลากร)");
  assert.equal(fixture.elements.get("uPhoneDisp").innerText, "📞 0612345678");
});

test("QR handoff allows slow legacy reads after the combined request fails", { timeout: 1000 }, async () => {
  const requests = [];
  const slowResponse = async (options, payload) => {
    requests.push(JSON.parse(options.body));
    await new Promise((resolve) => setTimeout(resolve, 17));
    return response(payload);
  };
  const fixture = loadIndex([
    async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response({}, { ok: false, status: 500 });
    },
    async (_url, options) => slowResponse(options, {
      id: "A602",
      floor: 6,
      room: "ประชุม 602",
      status: "พร้อมใช้งาน",
      type: "ITEM",
    }),
    async (_url, options) => slowResponse(options, {
      name: "Debug User",
      phone: "0612345678",
      role: "บุคลากร",
    }),
    async (_url, options) => slowResponse(options, false),
  ], { timerScale: 1000 });

  await fixture.app.init();

  assert.deepEqual(requests.map(({ action }) => action), [
    "getAppState",
    "getInventoryData",
    "getUserData",
    "checkVerifyStatus",
  ]);
  assert.equal(fixture.elements.get("uNameDisp").innerText, "Debug User (บุคลากร)");
  assert.equal(fixture.elements.get("uPhoneDisp").innerText, "📞 0612345678");
});

test("return action sends no personal data from the browser", async () => {
  const requests = [];
  const fixture = loadIndex([
    async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response({ status: "SUCCESS" });
    },
  ]);
  fixture.app.sys.email = "U_TEST";
  fixture.app.sys.id = "ITEM01";

  await fixture.app.doAction("คืนอุปกรณ์");

  assert.deepEqual(requests, [
    {
      action: "processActionV2",
      email: "U_TEST",
      obj: { id: "ITEM01", action: "คืนอุปกรณ์" },
    },
  ]);
  assert.equal(fixture.location.href, "ReturnSuccess.html");
});

test("profile save accepts a successful read-back after an ambiguous write response", async () => {
  const fixture = loadIndex([
    async () => {
      throw new Error("redirect response lost");
    },
    async () =>
      response({
        name: "Debug User",
        phone: "0612345678",
        role: "บุคลากร",
      }),
  ]);

  fixture.elements.get("uName").value = "Debug User";
  fixture.elements.get("uPhone").value = "0612345678";
  fixture.elements.get("uRole").value = "บุคลากร";

  await fixture.app.saveUser();

  assert.equal(fixture.getReloadCount(), 1);
});

test("return-point confirmation accepts a successful status read-back after an ambiguous write response", async () => {
  const fixture = loadIndex([
    async () => {
      throw new Error("redirect response lost");
    },
    async () => response(true),
  ]);

  await fixture.app.doVerify();

  assert.equal(fixture.location.href, "VerifySuccess.html");
});
