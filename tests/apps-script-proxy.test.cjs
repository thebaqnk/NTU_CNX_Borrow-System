const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

function loadProxy() {
  try {
    return require(path.join(__dirname, "..", "api", "apps-script.js"));
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
}

function createResponse() {
  return {
    body: "",
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test("same-origin proxy follows Google redirects and preserves the JSON response", async () => {
  const proxy = loadProxy();
  assert.equal(typeof proxy, "function", "Vercel proxy route must exist");

  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          info: {
            id: "RETURN",
            floor: "-",
            room: "จุดคืนอุปกรณ์ (กลาง)",
            status: "",
            type: "POINT",
          },
          user: null,
          verified: false,
        });
      },
    };
  };

  const body = JSON.stringify({
    action: "getAppState",
    email: "U_TEST",
    id: "RETURN",
  });
  const response = createResponse();

  try {
    await proxy({ method: "POST", body }, response);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  const upstreamUrl = new URL(requests[0].url);
  assert.equal(upstreamUrl.origin, "https://script.google.com");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.redirect, "follow");
  assert.equal(requests[0].options.body, body);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(response.body), {
    info: {
      id: "RETURN",
      floor: "-",
      room: "จุดคืนอุปกรณ์ (กลาง)",
      status: "",
      type: "POINT",
    },
    user: null,
    verified: false,
  });
});

test("same-origin proxy rejects non-POST requests without contacting Google", async () => {
  const proxy = loadProxy();
  assert.equal(typeof proxy, "function", "Vercel proxy route must exist");

  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };
  const response = createResponse();

  try {
    await proxy({ method: "GET" }, response);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST");
});
