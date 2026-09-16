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

function loadIndex(fetchSteps) {
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
    reload() {
      reloadCount += 1;
    },
  };
  const swalCalls = [];
  let step = 0;
  const context = {
    URLSearchParams,
    console,
    document: {
      addEventListener() {},
      getElementById(id) {
        return elements.get(id);
      },
    },
    fetch: async (...args) => {
      const handler = fetchSteps[step++];
      assert.ok(handler, `unexpected fetch #${step}`);
      return handler(...args);
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
    setTimeout(callback) {
      callback();
      return 0;
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
  vm.runInContext(`${source}\nthis.__app = { callGAS, doVerify, saveUser };`, context);

  return {
    app: context.__app,
    elements,
    getReloadCount: () => reloadCount,
    getSwalCalls: () => swalCalls,
    location,
    response,
  };
}

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
