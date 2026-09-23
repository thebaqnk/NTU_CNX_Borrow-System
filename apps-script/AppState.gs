const APP_STATE_USER_CACHE_SECONDS = 300;
const APP_STATE_MISSING_USER_CACHE_SECONDS = 30;
const APP_STATE_INVENTORY_CACHE_SECONDS = 20;
const APP_STATE_VERIFY_TRUE_CACHE_SECONDS = 900;
const APP_STATE_VERIFY_FALSE_CACHE_SECONDS = 30;
const APP_STATE_MISSING_USER_MARKER = "__APP_STATE_MISSING_USER__";

function appStateCache_() {
  return CacheService.getScriptCache();
}

function cacheKeyPart_(value) {
  return encodeURIComponent(value == null ? "" : String(value).trim());
}

function userCacheKey_(lineId) {
  return "user:" + cacheKeyPart_(lineId);
}

function inventoryCacheKey_(id) {
  return "inventory:" + cacheKeyPart_(String(id || "").trim().toUpperCase());
}

function verificationCacheKey_(lineId) {
  return "verification:" + cacheKeyPart_(lineId);
}

function readCachedJson_(key) {
  const cache = appStateCache_();
  const cached = cache.get(key);
  if (!cached) return null;
  try {
    return JSON.parse(cached);
  } catch (error) {
    cache.remove(key);
    return null;
  }
}

function getCachedUserData_(lineId, readContext) {
  const key = userCacheKey_(lineId);
  const cached = readCachedJson_(key);
  if (cached) {
    return cached.marker === APP_STATE_MISSING_USER_MARKER ? null : cached;
  }

  const user = getUserData(lineId, readContext);
  if (user) {
    appStateCache_().put(key, JSON.stringify(user), APP_STATE_USER_CACHE_SECONDS);
  } else {
    appStateCache_().put(
      key,
      JSON.stringify({ marker: APP_STATE_MISSING_USER_MARKER }),
      APP_STATE_MISSING_USER_CACHE_SECONDS
    );
  }
  return user;
}

function setCachedUserData_(lineId, user) {
  if (!lineId || !user) return;
  appStateCache_().put(userCacheKey_(lineId), JSON.stringify(user), APP_STATE_USER_CACHE_SECONDS);
}

function clearCachedUserData_(lineId) {
  appStateCache_().remove(userCacheKey_(lineId));
}

function getCachedInventoryData_(id) {
  const key = inventoryCacheKey_(id);
  const cached = readCachedJson_(key);
  if (cached) return cached;

  const inventory = getInventoryData(id);
  if (inventory) {
    appStateCache_().put(key, JSON.stringify(inventory), APP_STATE_INVENTORY_CACHE_SECONDS);
  }
  return inventory;
}

function clearCachedInventoryData_(id) {
  appStateCache_().remove(inventoryCacheKey_(id));
}

function getCachedVerifyStatus_(lineId, readContext) {
  const cache = appStateCache_();
  const key = verificationCacheKey_(lineId);
  const cached = cache.get(key);
  if (cached === "1") return true;
  if (cached === "0") return false;

  const verified = checkVerifyStatus(lineId, readContext) === true;
  cache.put(
    key,
    verified ? "1" : "0",
    verified ? APP_STATE_VERIFY_TRUE_CACHE_SECONDS : APP_STATE_VERIFY_FALSE_CACHE_SECONDS
  );
  return verified;
}

function setCachedVerifyStatus_(lineId, verified) {
  if (!lineId) return;
  appStateCache_().put(
    verificationCacheKey_(lineId),
    verified ? "1" : "0",
    verified ? APP_STATE_VERIFY_TRUE_CACHE_SECONDS : APP_STATE_VERIFY_FALSE_CACHE_SECONDS
  );
}

function getAppState(lineId, id) {
  const readContext = {};
  return {
    info: getCachedInventoryData_(id),
    user: getCachedUserData_(lineId, readContext),
    verified: getCachedVerifyStatus_(lineId, readContext)
  };
}

function processActionV2(obj, lineId) {
  const normalizedLineId = lineId == null ? "" : String(lineId).trim();
  const id = obj && obj.id != null ? String(obj.id).trim() : "";
  const action = obj && obj.action != null ? String(obj.action).trim() : "";
  if (!normalizedLineId || !id || ["ยืมอุปกรณ์", "คืนอุปกรณ์"].indexOf(action) === -1) {
    return { status: "error", message: "ข้อมูลคำขอไม่ถูกต้อง" };
  }

  const user = getCachedUserData_(normalizedLineId);
  if (!user || !user.name || !user.phone || !user.role) {
    return { status: "error", message: "ข้อมูลโปรไฟล์ไม่สมบูรณ์ กรุณาตรวจสอบข้อมูลอีกครั้ง" };
  }

  const result = processAction({
    id: id,
    action: action,
    name: String(user.name).trim(),
    phone: String(user.phone).trim(),
    role: String(user.role).trim()
  }, normalizedLineId);

  if (result && result.status === "SUCCESS") {
    clearCachedInventoryData_(id);
  }
  return result;
}

function routeOptimizedAction_(contents) {
  if (contents.action === "getAppState") {
    return { handled: true, result: getAppState(contents.email, contents.id) };
  }
  if (contents.action === "processActionV2") {
    return { handled: true, result: processActionV2(contents.obj, contents.email) };
  }
  return { handled: false };
}
