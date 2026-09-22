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

  getValues() {
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? "",
      ),
    );
  }

  setValues(values) {
    if (this.sheet.failWrites) throw new Error("archive write failed");
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
  constructor(rows = []) {
    this.rows = rows.map((row) => [...row]);
    this.failWrites = false;
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  deleteRows(rowPosition, howMany) {
    this.rows.splice(rowPosition - 1, howMany);
  }
}

function makeRows(count, prefix) {
  return [["ID", "Action"], ...Array.from({ length: count }, (_, index) => [
    `${prefix}-${index + 1}`,
    `action-${index + 1}`,
  ])];
}

function loadRetention({ sheets: initialSheets = new Map(), triggers = [] } = {}) {
  const sheets = new Map(initialSheets);
  const spreadsheet = {
    getSheetByName(name) {
      return sheets.get(name) || null;
    },
    insertSheet(name) {
      const sheet = new FakeSheet();
      sheets.set(name, sheet);
      return sheet;
    },
  };

  const lock = {
    acquired: false,
    released: false,
    tryLock() {
      this.acquired = true;
      return true;
    },
    releaseLock() {
      this.released = true;
    },
  };

  const createdTriggers = [];
  const deletedTriggers = [];
  const ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger(trigger) {
      deletedTriggers.push(trigger);
    },
    newTrigger(handler) {
      const config = { handler };
      const builder = {
        timeBased() { return this; },
        atHour(hour) { config.hour = hour; return this; },
        everyDays(days) { config.days = days; return this; },
        inTimezone(timezone) { config.timezone = timezone; return this; },
        create() { createdTriggers.push(config); return config; },
      };
      return builder;
    },
  };

  const sourcePath = path.join(__dirname, "..", "apps-script", "Retention.gs");
  const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
  const context = {
    Date,
    JSON,
    LockService: { getDocumentLock: () => lock },
    Math,
    Object,
    ScriptApp,
    SpreadsheetApp: {
      flush() {},
      getActiveSpreadsheet: () => spreadsheet,
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__retention = {
      archiveOldRowsNightly: typeof archiveOldRowsNightly === "function" ? archiveOldRowsNightly : null,
      installArchiveTrigger: typeof installArchiveTrigger === "function" ? installArchiveTrigger : null
    };`,
    context,
  );

  return {
    app: context.__retention,
    createdTriggers,
    deletedTriggers,
    lock,
    sheets,
  };
}

test("archives the oldest 100 rows when Logs reaches 300 data rows", () => {
  const fixture = loadRetention({
    sheets: new Map([["Logs", new FakeSheet(makeRows(300, "log"))]]),
  });

  assert.equal(typeof fixture.app.archiveOldRowsNightly, "function");
  const result = fixture.app.archiveOldRowsNightly();

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "SUCCESS",
    sheets: [
      { sheet: "Logs", archive: "LogsArchive", archivedRows: 100 },
      { sheet: "VerificationLogs", archive: "VerificationLogsArchive", archivedRows: 0 },
      { sheet: "RequestOT", archive: "RequestOTArchive", archivedRows: 0 },
    ],
  });
  assert.equal(fixture.sheets.get("Logs").rows.length, 201);
  assert.deepEqual(fixture.sheets.get("Logs").rows[0], ["ID", "Action"]);
  assert.deepEqual(fixture.sheets.get("Logs").rows[1], ["log-101", "action-101"]);
  assert.equal(fixture.sheets.get("LogsArchive").rows.length, 101);
  assert.deepEqual(fixture.sheets.get("LogsArchive").rows[1], ["log-1", "action-1"]);
  assert.deepEqual(fixture.sheets.get("LogsArchive").rows[100], ["log-100", "action-100"]);
  assert.equal(fixture.lock.acquired, true);
  assert.equal(fixture.lock.released, true);
});

test("keeps 299 data rows and never touches Users or Inventory", () => {
  const users = new FakeSheet(makeRows(400, "user"));
  const inventory = new FakeSheet(makeRows(400, "item"));
  const fixture = loadRetention({
    sheets: new Map([
      ["Logs", new FakeSheet(makeRows(299, "log"))],
      ["Users", users],
      ["Inventory", inventory],
    ]),
  });

  assert.equal(typeof fixture.app.archiveOldRowsNightly, "function");
  fixture.app.archiveOldRowsNightly();

  assert.equal(fixture.sheets.get("Logs").rows.length, 300);
  assert.equal(fixture.sheets.has("LogsArchive"), false);
  assert.equal(users.rows.length, 401);
  assert.equal(inventory.rows.length, 401);
  assert.equal(fixture.sheets.has("UsersArchive"), false);
  assert.equal(fixture.sheets.has("InventoryArchive"), false);
});

test("archives multiple 100-row batches until fewer than 300 data rows remain", () => {
  const fixture = loadRetention({
    sheets: new Map([
      ["Logs", new FakeSheet(makeRows(401, "log"))],
      ["VerificationLogs", new FakeSheet(makeRows(300, "verify"))],
      ["RequestOT", new FakeSheet(makeRows(300, "request"))],
    ]),
  });

  assert.equal(typeof fixture.app.archiveOldRowsNightly, "function");
  fixture.app.archiveOldRowsNightly();

  assert.equal(fixture.sheets.get("Logs").rows.length, 202);
  assert.equal(fixture.sheets.get("LogsArchive").rows.length, 201);
  assert.equal(fixture.sheets.get("VerificationLogs").rows.length, 201);
  assert.equal(fixture.sheets.get("VerificationLogsArchive").rows.length, 101);
  assert.equal(fixture.sheets.get("RequestOT").rows.length, 201);
  assert.equal(fixture.sheets.get("RequestOTArchive").rows.length, 101);
});

test("does not delete source rows when the archive write fails", () => {
  const logs = new FakeSheet(makeRows(300, "log"));
  const archive = new FakeSheet([["ID", "Action"]]);
  archive.failWrites = true;
  const fixture = loadRetention({
    sheets: new Map([
      ["Logs", logs],
      ["LogsArchive", archive],
    ]),
  });

  assert.equal(typeof fixture.app.archiveOldRowsNightly, "function");
  assert.throws(() => fixture.app.archiveOldRowsNightly(), /archive write failed/);
  assert.equal(logs.rows.length, 301);
  assert.equal(fixture.lock.released, true);
});

test("installs one daily archive trigger at 03:00 Asia/Bangkok", () => {
  const oldArchiveTrigger = { getHandlerFunction: () => "archiveOldRowsNightly" };
  const unrelatedTrigger = { getHandlerFunction: () => "anotherJob" };
  const fixture = loadRetention({ triggers: [oldArchiveTrigger, unrelatedTrigger] });

  assert.equal(typeof fixture.app.installArchiveTrigger, "function");
  const result = fixture.app.installArchiveTrigger();

  assert.deepEqual(fixture.deletedTriggers, [oldArchiveTrigger]);
  assert.deepEqual(fixture.createdTriggers, [{
    handler: "archiveOldRowsNightly",
    hour: 3,
    days: 1,
    timezone: "Asia/Bangkok",
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "SUCCESS",
    handler: "archiveOldRowsNightly",
    timezone: "Asia/Bangkok",
    hour: 3,
  });
});
