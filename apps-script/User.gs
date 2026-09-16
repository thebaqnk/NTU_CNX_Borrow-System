const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

function normalizeText_(value) {
  return value == null ? "" : String(value).trim();
}

function getUserData(lineId) {
  const normalizedLineId = normalizeText_(lineId);
  if (!normalizedLineId) return null;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
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

    const data = sheet.getDataRange().getValues();
    let targetRow = sheet.getLastRow() + 1;
    for (let i = 1; i < data.length; i++) {
      if (normalizeText_(data[i][0]) === normalizedLineId) {
        targetRow = i + 1;
        break;
      }
    }

    sheet.getRange(targetRow, 1).setNumberFormat("@").setValue(normalizedLineId);
    sheet.getRange(targetRow, 2).setValue(name);
    sheet.getRange(targetRow, 3).setNumberFormat("@").setValue(phone);
    sheet.getRange(targetRow, 4).setValue(role);
    SpreadsheetApp.flush();

    return { status: "SUCCESS", user: { name: name, phone: phone, role: role } };
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
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      const timestamp = new Date(data[i][2]).getTime();
      if (normalizeText_(data[i][0]) === normalizedLineId
          && normalizeText_(data[i][1]).toUpperCase() === normalizedType
          && Number.isFinite(timestamp)
          && now.getTime() - timestamp >= 0
          && now.getTime() - timestamp < VERIFICATION_WINDOW_MS) {
        return { status: "SUCCESS", verified: true, duplicate: true };
      }
    }

    const targetRow = sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1, 1, 4).setValues([[normalizedLineId, normalizedType, now, "SUCCESS"]]);
    SpreadsheetApp.flush();
    return { status: "SUCCESS", verified: true };
  } finally {
    lock.releaseLock();
  }
}

function checkVerifyStatus(lineId) {
  const normalizedLineId = normalizeText_(lineId);
  if (!normalizedLineId) return false;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("VerificationLogs");
  if (!sheet) return false;

  const data = sheet.getDataRange().getValues();
  const now = new Date().getTime();
  for (let i = data.length - 1; i >= 1; i--) {
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
