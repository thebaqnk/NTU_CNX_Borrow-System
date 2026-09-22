const RETENTION_MAX_DATA_ROWS = 300;
const RETENTION_ARCHIVE_BATCH_ROWS = 100;
const RETENTION_HEADER_ROWS = 1;
const RETENTION_TRIGGER_HANDLER = "archiveOldRowsNightly";
const RETENTION_TIMEZONE = "Asia/Bangkok";
const RETENTION_TRIGGER_HOUR = 3;

const RETENTION_POLICIES = Object.freeze([
  Object.freeze({ sheet: "Logs", archive: "LogsArchive" }),
  Object.freeze({ sheet: "VerificationLogs", archive: "VerificationLogsArchive" }),
  Object.freeze({ sheet: "RequestOT", archive: "RequestOTArchive" })
]);

function retentionRowsToArchive_(dataRowCount) {
  if (dataRowCount < RETENTION_MAX_DATA_ROWS) return 0;
  return Math.floor(
    (dataRowCount - (RETENTION_MAX_DATA_ROWS - RETENTION_ARCHIVE_BATCH_ROWS))
      / RETENTION_ARCHIVE_BATCH_ROWS
  ) * RETENTION_ARCHIVE_BATCH_ROWS;
}

function retentionComparableValue_(value) {
  if (value instanceof Date) return { type: "date", value: value.getTime() };
  return { type: typeof value, value: value };
}

function retentionMatricesEqual_(left, right) {
  if (left.length !== right.length) return false;
  for (let rowIndex = 0; rowIndex < left.length; rowIndex++) {
    if (left[rowIndex].length !== right[rowIndex].length) return false;
    for (let columnIndex = 0; columnIndex < left[rowIndex].length; columnIndex++) {
      const leftValue = retentionComparableValue_(left[rowIndex][columnIndex]);
      const rightValue = retentionComparableValue_(right[rowIndex][columnIndex]);
      if (leftValue.type !== rightValue.type || leftValue.value !== rightValue.value) {
        return false;
      }
    }
  }
  return true;
}

function archiveRowsForPolicy_(spreadsheet, policy) {
  const sourceSheet = spreadsheet.getSheetByName(policy.sheet);
  if (!sourceSheet) return 0;

  const dataRowCount = Math.max(0, sourceSheet.getLastRow() - RETENTION_HEADER_ROWS);
  const rowsToArchive = retentionRowsToArchive_(dataRowCount);
  if (rowsToArchive === 0) return 0;

  const columnCount = sourceSheet.getLastColumn();
  if (columnCount === 0) return 0;

  const sourceHeader = sourceSheet.getRange(1, 1, 1, columnCount).getValues();
  let archiveSheet = spreadsheet.getSheetByName(policy.archive);
  if (!archiveSheet) archiveSheet = spreadsheet.insertSheet(policy.archive);

  if (archiveSheet.getLastRow() === 0) {
    archiveSheet.getRange(1, 1, 1, columnCount).setValues(sourceHeader);
  } else {
    const archiveHeader = archiveSheet.getRange(1, 1, 1, columnCount).getValues();
    if (!retentionMatricesEqual_(sourceHeader, archiveHeader)) {
      throw new Error("หัวตารางของ " + policy.archive + " ไม่ตรงกับ " + policy.sheet);
    }
  }

  const sourceValues = sourceSheet
    .getRange(RETENTION_HEADER_ROWS + 1, 1, rowsToArchive, columnCount)
    .getValues();
  const archiveStartRow = archiveSheet.getLastRow() + 1;
  archiveSheet
    .getRange(archiveStartRow, 1, rowsToArchive, columnCount)
    .setValues(sourceValues);

  SpreadsheetApp.flush();
  const archivedValues = archiveSheet
    .getRange(archiveStartRow, 1, rowsToArchive, columnCount)
    .getValues();
  if (!retentionMatricesEqual_(sourceValues, archivedValues)) {
    throw new Error("ตรวจสอบข้อมูลใน " + policy.archive + " ไม่สำเร็จ");
  }

  sourceSheet.deleteRows(RETENTION_HEADER_ROWS + 1, rowsToArchive);
  return rowsToArchive;
}

function archiveOldRowsNightly() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    return { status: "SKIPPED", reason: "LOCK_TIMEOUT" };
  }

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const results = RETENTION_POLICIES.map(function (policy) {
      return {
        sheet: policy.sheet,
        archive: policy.archive,
        archivedRows: archiveRowsForPolicy_(spreadsheet, policy)
      };
    });
    return { status: "SUCCESS", sheets: results };
  } finally {
    lock.releaseLock();
  }
}

function installArchiveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === RETENTION_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(RETENTION_TRIGGER_HANDLER)
    .timeBased()
    .atHour(RETENTION_TRIGGER_HOUR)
    .everyDays(1)
    .inTimezone(RETENTION_TIMEZONE)
    .create();

  return {
    status: "SUCCESS",
    handler: RETENTION_TRIGGER_HANDLER,
    timezone: RETENTION_TIMEZONE,
    hour: RETENTION_TRIGGER_HOUR
  };
}
