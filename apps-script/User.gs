const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

function normalizeText_(value) {
  return value == null ? "" : String(value).trim();
}

function getSpreadsheetForRead_(readContext) {
  if (!readContext) return SpreadsheetApp.getActiveSpreadsheet();
  if (!readContext.spreadsheet) {
    readContext.spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }
  return readContext.spreadsheet;
}

function readSheetRows_(sheet, numColumns, useDisplayValues) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const range = sheet.getRange(2, 1, lastRow - 1, numColumns);
  return useDisplayValues ? range.getDisplayValues() : range.getValues();
}

function getUserData(lineId, readContext) {
  const normalizedLineId = normalizeText_(lineId);
  if (!normalizedLineId) return null;

  const sheet = getSpreadsheetForRead_(readContext).getSheetByName("Users");
  if (!sheet) return null;

  const data = readSheetRows_(sheet, 4, true);
  for (let i = 0; i < data.length; i++) {
    if (normalizeText_(data[i][0]) === normalizedLineId) {
      return {
        name: normalizeText_(data[i][1]),
        phone: normalizeText_(data[i][2]),
        role: normalizeText_(data[i][3])
      };
    }
  }
  return null;
}

function saveUserData(lineId, obj) {
  const normalizedLineId = normalizeText_(lineId);
  const name = normalizeText_(obj && obj.name);
  const phone = normalizeText_(obj && obj.phone);
  const role = normalizeText_(obj && (obj.role || obj.position)) || "ไม่ระบุ";

  if (!normalizedLineId || !name || !phone) {
    return { status: "error", message: "ข้อมูลโปรไฟล์ไม่ครบ" };
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Users") || ss.insertSheet("Users");
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 4).setValues([["LineID", "name", "phone", "role"]]);
    }

    const data = readSheetRows_(sheet, 1, true);
    let targetRow = sheet.getLastRow() + 1;
    for (let i = 0; i < data.length; i++) {
      if (normalizeText_(data[i][0]) === normalizedLineId) {
        targetRow = i + 2;
        break;
      }
    }

    sheet.getRange(targetRow, 1).setNumberFormat("@").setValue(normalizedLineId);
    sheet.getRange(targetRow, 2).setValue(name);
    sheet.getRange(targetRow, 3).setNumberFormat("@").setValue(phone);
    sheet.getRange(targetRow, 4).setValue(role);
    SpreadsheetApp.flush();

    const savedUser = { name: name, phone: phone, role: role };
    if (typeof setCachedUserData_ === "function") {
      setCachedUserData_(normalizedLineId, savedUser);
    }
    return { status: "SUCCESS", user: savedUser };
  } finally {
    lock.releaseLock();
  }
}

function recordVerify(lineId, verificationType) {
  const normalizedLineId = normalizeText_(lineId);
  const normalizedType = normalizeText_(verificationType).toUpperCase() || "RETURN";
  if (!normalizedLineId) {
    return { status: "error", message: "ไม่พบ LineID" };
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("VerificationLogs") || ss.insertSheet("VerificationLogs");
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 4).setValues([["LineID", "VerificationType", "Timestamp", "Status"]]);
    }

    const now = new Date();
    const data = readSheetRows_(sheet, 3, false);
    for (let i = data.length - 1; i >= 0; i--) {
      const timestamp = new Date(data[i][2]).getTime();
      if (normalizeText_(data[i][0]) === normalizedLineId
          && normalizeText_(data[i][1]).toUpperCase() === normalizedType
          && Number.isFinite(timestamp)
          && now.getTime() - timestamp >= 0
          && now.getTime() - timestamp < VERIFICATION_WINDOW_MS) {
        if (typeof setCachedVerifyStatus_ === "function") {
          setCachedVerifyStatus_(normalizedLineId, true);
        }
        return { status: "SUCCESS", verified: true, duplicate: true };
      }
    }

    const targetRow = sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1, 1, 4).setValues([[normalizedLineId, normalizedType, now, "SUCCESS"]]);
    SpreadsheetApp.flush();
    if (typeof setCachedVerifyStatus_ === "function") {
      setCachedVerifyStatus_(normalizedLineId, true);
    }
    return { status: "SUCCESS", verified: true };
  } finally {
    lock.releaseLock();
  }
}

function checkVerifyStatus(lineId, readContext) {
  const normalizedLineId = normalizeText_(lineId);
  if (!normalizedLineId) return false;

  const sheet = getSpreadsheetForRead_(readContext).getSheetByName("VerificationLogs");
  if (!sheet) return false;

  const data = readSheetRows_(sheet, 4, false);
  const now = new Date().getTime();
  for (let i = data.length - 1; i >= 0; i--) {
    const timestamp = new Date(data[i][2]).getTime();
    const status = normalizeText_(data[i][3]).toUpperCase();
    if (normalizeText_(data[i][0]) === normalizedLineId
        && normalizeText_(data[i][1]).toUpperCase() === "RETURN"
        && (!status || status === "SUCCESS")
        && Number.isFinite(timestamp)
        && now - timestamp >= 0
        && now - timestamp < VERIFICATION_WINDOW_MS) {
      return true;
    }
  }
  return false;
}
