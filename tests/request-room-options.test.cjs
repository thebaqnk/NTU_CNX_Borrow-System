const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadRequestPage() {
  const html = fs.readFileSync("Request.html", "utf8");
  const inlineScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .find((script) => script.includes("function updateItems"));

  const floor = { value: "6" };
  const itemSelect = {
    innerHTML: "",
    options: [],
    appendChild(option) {
      this.options.push(option);
    },
  };

  const document = {
    addEventListener() {},
    createElement(tagName) {
      assert.equal(tagName, "option");
      return { value: "", innerHTML: "" };
    },
    getElementById(id) {
      return id === "floor" ? floor : itemSelect;
    },
  };

  const context = vm.createContext({
    URLSearchParams,
    console,
    document,
    fetch: async () => ({}),
    liff: {},
    Swal: {},
  });

  vm.runInContext(inlineScript, context);
  return { context, itemSelect };
}

test("out-of-hours borrowing offers meeting room A602 on floor 6", () => {
  const { context, itemSelect } = loadRequestPage();

  context.updateItems();

  assert.deepEqual(
    itemSelect.options.map(({ value, innerHTML }) => ({ value, label: innerHTML })),
    [{ value: "A602", label: "A602 (ประชุม 602)" }],
  );
});
