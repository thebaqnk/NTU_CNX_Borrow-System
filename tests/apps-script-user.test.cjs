const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows;
    this.formats = new Map();
  }

  getDataRange() {
    return { getValues: () => this.rows.map((row) => [...row]) };
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }
}

function loadUserScript() {
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
    Date,
    LockService: { getDocumentLock: () => lock },
    Number,
    SpreadsheetApp: {
      flush() {},
      getActiveSpreadsheet: () => spreadsheet,
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "apps-script", "User.gs"), "utf8");
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__app = { getUserData, saveUserData, recordVerify, checkVerifyStatus };`,
    context,
  );
  return { app: context.__app, sheets };
}

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
  assert.deepEqual(
    JSON.parse(JSON.stringify(fixture.app.getUserData("U_TEST"))),
    { name: "Debug User", phone: "0612345678", role: "บุคลากร" },
  );
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
  assert.equal(fixture.app.checkVerifyStatus("U_TEST"), true);
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
