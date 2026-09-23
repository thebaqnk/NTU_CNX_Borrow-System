const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeExpiringCache {
  constructor() {
    this.nowSeconds = 0;
    this.values = new Map();
  }

  advance(seconds) {
    this.nowSeconds += seconds;
  }

  get(key) {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.nowSeconds) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  put(key, value, expirationSeconds = 600) {
    this.values.set(key, {
      value: String(value),
      expiresAt: this.nowSeconds + expirationSeconds,
    });
  }

  remove(key) {
    this.values.delete(key);
  }
}

class FakeRange {
  constructor(sheet, row, column, numRows = 1, numColumns = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  setNumberFormat(format) {
    this.sheet.formats.set(`${this.row}:${this.column}`, format);
    return this;
  }

  setValue(value) {
    return this.setValues([[value]]);
  }

  setValues(values) {
    for (let rowOffset = 0; rowOffset < this.numRows; rowOffset++) {
      const rowIndex = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= rowIndex) this.sheet.rows.push([]);
      for (let columnOffset = 0; columnOffset < this.numColumns; columnOffset++) {
        this.sheet.rows[rowIndex][this.column - 1 + columnOffset] = values[rowOffset][columnOffset];
      }
    }
    return this;
  }

  getValues() {
    this.sheet.reads.push({
      row: this.row,
      column: this.column,
      numRows: this.numRows,
      numColumns: this.numColumns,
      display: false,
    });
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? "",
      ),
    );
  }

  getDisplayValues() {
    this.sheet.reads.push({
      row: this.row,
      column: this.column,
      numRows: this.numRows,
      numColumns: this.numColumns,
      display: true,
    });
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) => {
        const value = this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? "";
        return value == null ? "" : String(value);
      }),
    );
  }
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows;
    this.formats = new Map();
    this.reads = [];
    this.wholeSheetReads = 0;
  }

  getDataRange() {
    return {
      getValues: () => {
        this.wholeSheetReads += 1;
        return this.rows.map((row) => [...row]);
      },
    };
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }
}

function loadUserScript() {
  const cache = new FakeExpiringCache();
  const metrics = { activeSpreadsheetReads: 0, inventoryReads: 0 };
  const sheets = new Map([
    ["Users", new FakeSheet([["LineID", "name", "phone", "role"]])],
    ["VerificationLogs", new FakeSheet([["LineID", "VerificationType", "Timestamp", "Status"]])],
  ]);
  const spreadsheet = {
    getSheetByName(name) {
      return sheets.get(name) || null;
    },
    insertSheet(name) {
      const sheet = new FakeSheet([]);
      sheets.set(name, sheet);
      return sheet;
    },
  };
  const lock = { waitLock() {}, releaseLock() {} };
  const context = {
    CacheService: {
      getScriptCache: () => cache,
    },
    Date,
    getInventoryData(id) {
      metrics.inventoryReads += 1;
      return { id, floor: "6", room: "A602", status: "ว่าง", type: "ITEM" };
    },
    LockService: { getDocumentLock: () => lock },
    Number,
    SpreadsheetApp: {
      flush() {},
      getActiveSpreadsheet: () => {
        metrics.activeSpreadsheetReads += 1;
        return spreadsheet;
      },
    },
  };
  const appStatePath = path.join(__dirname, "..", "apps-script", "AppState.gs");
  const appStateSource = fs.existsSync(appStatePath) ? fs.readFileSync(appStatePath, "utf8") : "";
  const source = `${appStateSource}\n${fs.readFileSync(path.join(__dirname, "..", "apps-script", "User.gs"), "utf8")}`;
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__app = { getAppState, getUserData, saveUserData, recordVerify, checkVerifyStatus };`,
    context,
  );
  return { app: context.__app, cache, metrics, sheets };
}

test("getAppState opens the spreadsheet once and avoids whole-sheet reads", () => {
  const fixture = loadUserScript();
  fixture.sheets.get("Users").rows.push(["U_TEST", "Real User", "0612345678", "บุคลากร"]);
  fixture.sheets.get("VerificationLogs").rows.push([
    "U_TEST",
    "RETURN",
    new Date(Date.now() - 60_000),
    "SUCCESS",
  ]);

  const result = fixture.app.getAppState("U_TEST", "A602");

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    info: { id: "A602", floor: "6", room: "A602", status: "ว่าง", type: "ITEM" },
    user: { name: "Real User", phone: "0612345678", role: "บุคลากร" },
    verified: true,
  });
  assert.equal(fixture.metrics.activeSpreadsheetReads, 1);
  assert.equal(fixture.sheets.get("Users").wholeSheetReads, 0);
  assert.equal(fixture.sheets.get("VerificationLogs").wholeSheetReads, 0);
});

test("getAppState caches a missing user so retries do not reread Users", () => {
  const fixture = loadUserScript();

  const first = fixture.app.getAppState("U_MISSING", "A602");
  const second = fixture.app.getAppState("U_MISSING", "A602");

  assert.equal(first.user, null);
  assert.equal(first.verified, false);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  assert.equal(fixture.metrics.activeSpreadsheetReads, 1);
  assert.equal(fixture.sheets.get("Users").wholeSheetReads, 0);
});

test("getAppState does not reread a false verification status after six seconds", () => {
  const fixture = loadUserScript();
  fixture.sheets.get("Users").rows.push(["U_TEST", "Real User", "0612345678", "บุคลากร"]);

  const first = fixture.app.getAppState("U_TEST", "A602");
  fixture.cache.advance(6);
  const second = fixture.app.getAppState("U_TEST", "A602");

  assert.equal(first.verified, false);
  assert.equal(second.verified, false);
  assert.equal(fixture.metrics.activeSpreadsheetReads, 1);
  assert.equal(fixture.sheets.get("VerificationLogs").reads.length, 0);
});

test("saveUserData preserves the leading zero in phone numbers", () => {
  const fixture = loadUserScript();

  const result = fixture.app.saveUserData("U_TEST", {
    name: "Debug User",
    phone: "0612345678",
    role: "บุคลากร",
  });

  assert.equal(result.status, "SUCCESS");
  assert.equal(fixture.sheets.get("Users").rows[1][2], "0612345678");
  assert.equal(fixture.sheets.get("Users").formats.get("2:3"), "@");
  assert.deepEqual(JSON.parse(fixture.cache.get("user:U_TEST")), {
    name: "Debug User",
    phone: "0612345678",
    role: "บุคลากร",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(fixture.app.getUserData("U_TEST"))),
    { name: "Debug User", phone: "0612345678", role: "บุคลากร" },
  );
});

test("saveUserData scans only the LineID column when updating a profile", () => {
  const fixture = loadUserScript();
  const users = fixture.sheets.get("Users");
  users.rows.push(["U_TEST", "Old Name", "0600000000", "นักศึกษา", "unused"]);

  const result = fixture.app.saveUserData("U_TEST", {
    name: "New Name",
    phone: "0612345678",
    role: "บุคลากร",
  });

  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(users.rows[1].slice(0, 4), ["U_TEST", "New Name", "0612345678", "บุคลากร"]);
  assert.equal(users.wholeSheetReads, 0);
  assert.deepEqual(users.reads, [
    { row: 2, column: 1, numRows: 1, numColumns: 1, display: true },
  ]);
});

test("recordVerify is idempotent inside the verification window", () => {
  const fixture = loadUserScript();

  const first = fixture.app.recordVerify("U_TEST", "RETURN");
  const second = fixture.app.recordVerify("U_TEST", "RETURN");

  assert.equal(first.status, "SUCCESS");
  assert.equal(second.status, "SUCCESS");
  assert.equal(second.duplicate, true);
  assert.equal(fixture.sheets.get("VerificationLogs").rows.length, 2);
  assert.equal(fixture.sheets.get("VerificationLogs").rows[1][3], "SUCCESS");
  assert.equal(fixture.cache.get("verification:U_TEST"), "1");
  assert.equal(fixture.app.checkVerifyStatus("U_TEST"), true);
});

test("recordVerify scans only the three columns needed for duplicate detection", () => {
  const fixture = loadUserScript();
  const verificationLogs = fixture.sheets.get("VerificationLogs");
  verificationLogs.rows.push([
    "U_TEST",
    "RETURN",
    new Date(Date.now() - 60_000),
    "SUCCESS",
    "unused",
  ]);

  const result = fixture.app.recordVerify("U_TEST", "RETURN");

  assert.equal(result.duplicate, true);
  assert.equal(verificationLogs.wholeSheetReads, 0);
  assert.deepEqual(verificationLogs.reads, [
    { row: 2, column: 1, numRows: 1, numColumns: 3, display: false },
  ]);
});

test("checkVerifyStatus accepts historical rows with a blank status", () => {
  const fixture = loadUserScript();
  fixture.sheets.get("VerificationLogs").rows.push([
    "U_OLD",
    "RETURN",
    new Date(Date.now() - 60_000),
    "",
  ]);

  assert.equal(fixture.app.checkVerifyStatus("U_OLD"), true);
});
