// 仅缓存完整的已购展示快照；账号凭据和 Apple 原始响应不进入对象缓存。

const SCHEMA = 1;
const TTL_MS = 15 * 60 * 1000;
const MAX_APPS = 10000;
const MAX_CACHE_CHARS = 4 * 1024 * 1024;
const TEXT_FIELDS = {
  name: 512, bundleID: 512, version: 128, purchaseDate: 64,
  artworkUrl: 2048, artworkUrl100: 2048, icon: 2048,
  artistName: 512, sellerName: 512, category: 256, primaryGenreName: 256,
  formattedPrice: 64, currency: 16, minimumOsVersion: 64, fileSizeBytes: 64,
  releaseDate: 64, trackViewUrl: 2048, description: 20000, releaseNotes: 10000,
};

function cacheKey(email, region) {
  const owner = String(email || "").trim().toLowerCase();
  const country = String(region || "").trim().toUpperCase();
  if (!owner || owner.length > 320 || !/^[A-Z]{2}$/.test(country)) return "";
  return `jasspp.purchased.v${SCHEMA}:${encodeURIComponent(owner)}:${country}`;
}

function idOf(value) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return "";
  const id = String(value).trim();
  return id && id.length <= 128 ? id : "";
}

function appMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = idOf(value.id);
  if (!id) return null;
  const app = { id, owned: true };
  for (const field of Object.keys(TEXT_FIELDS)) {
    if (typeof value[field] === "string") app[field] = value[field].slice(0, TEXT_FIELDS[field]);
  }
  for (const field of ["price", "averageUserRating", "userRatingCount"]) {
    if (typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0) app[field] = value[field];
  }
  if (value.price === null) app.price = null;
  for (const field of ["screenshotUrls", "genres"]) {
    if (Array.isArray(value[field])) {
      const limit = field === "genres" ? 128 : 2048;
      app[field] = value[field].filter((item) => typeof item === "string").slice(0, 20).map((item) => item.slice(0, limit));
    }
  }
  return app;
}

function snapshotOf(value) {
  if (!value || value.complete !== true || !Array.isArray(value.apps) || value.apps.length > MAX_APPS) return null;
  if (!Number.isInteger(value.totalCount) || value.totalCount !== value.apps.length) return null;
  if (!Number.isFinite(value.updatedAt) || value.updatedAt <= 0) return null;
  const apps = [];
  const ids = new Set();
  for (const valueApp of value.apps) {
    const app = appMetadata(valueApp);
    if (!app || ids.has(app.id)) return null;
    ids.add(app.id);
    apps.push(app);
  }
  const enrichedIds = Array.from(new Set(
    (Array.isArray(value.enrichedIds) ? value.enrichedIds : []).map(idOf).filter((id) => ids.has(id))
  ));
  return { schema: SCHEMA, complete: true, apps, totalCount: apps.length, enrichedIds, updatedAt: value.updatedAt };
}

function read(email, region, now) {
  try {
    const key = cacheKey(email, region);
    if (!key || typeof $cache === "undefined" || typeof $cache.get !== "function") return null;
    const stored = $cache.get(key);
    if (!stored || stored.schema !== SCHEMA) return null;
    const snapshot = snapshotOf(stored);
    if (!snapshot) return null;
    const time = now === undefined ? Date.now() : now;
    snapshot.stale = stored.invalidated === true || !Number.isFinite(time) || time < snapshot.updatedAt || time - snapshot.updatedAt >= TTL_MS;
    return snapshot;
  } catch (_e) {
    return null;
  }
}

function write(email, region, value) {
  try {
    const key = cacheKey(email, region);
    if (!key || typeof $cache === "undefined" || typeof $cache.set !== "function") return false;
    const oversized = value && Array.isArray(value.apps) && value.apps.length > MAX_APPS;
    const snapshot = snapshotOf(value);
    // 超限时保留旧数据及原时间，但下次必须刷新，不能让旧缓存掩盖新结果。
    if (oversized || (snapshot && JSON.stringify(snapshot).length > MAX_CACHE_CHARS)) {
      if (typeof $cache.get === "function") {
        const old = snapshotOf($cache.get(key));
        if (old) $cache.set(key, Object.assign(old, { invalidated: true }));
      }
      return false;
    }
    if (!snapshot) return false;
    return $cache.set(key, snapshot) !== false;
  } catch (_e) {
    return false;
  }
}

module.exports = { read, write, TTL_MS, MAX_APPS };
