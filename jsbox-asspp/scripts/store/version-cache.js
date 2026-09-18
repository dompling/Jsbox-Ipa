// 历史版本缓存：按 Apple ID + Store 区域 + App ID 隔离。
// 列表与版本元数据分层保存：刷新列表时保留仍存在 ID 的已解析元数据，
// 每解析出一个版本号立即落盘，退出页面后再次进入可以直接命中。

const SCHEMA = 1;
const MAX_IDS = 2000;
const MAX_CACHE_CHARS = 2 * 1024 * 1024;

function normalizePart(value, max) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text && text.length <= max ? text : "";
}

function cacheKey(email, region, appId) {
  const owner = normalizePart(email, 320).toLowerCase();
  const country = normalizePart(region, 8).toUpperCase();
  const id = normalizePart(appId, 128);
  if (!owner || !/^[A-Z]{2}$/.test(country) || !id) return "";
  return `jasspp.versions.v${SCHEMA}:${encodeURIComponent(owner)}:${country}:${encodeURIComponent(id)}`;
}

function versionOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = normalizePart(value.id, 128);
  if (!id) return null;
  const result = {
    id,
    requestedExternalVersionId: normalizePart(value.requestedExternalVersionId || id, 128),
    externalVersionId: normalizePart(value.externalVersionId, 128),
    displayVersion: normalizePart(value.displayVersion, 128),
    buildVersion: normalizePart(value.buildVersion, 128),
  };
  // 只有真正解析出版本信息，或 externalVersionId 已确认与请求 ID 一致，才算可复用。
  if (!result.displayVersion && !result.buildVersion && result.externalVersionId !== id) return null;
  if (result.requestedExternalVersionId && result.requestedExternalVersionId !== id) return null;
  if (result.externalVersionId && result.externalVersionId !== id) return null;
  result.requestedExternalVersionId = id;
  return result;
}

function snapshotOf(value) {
  if (!value || value.schema !== SCHEMA || !Array.isArray(value.identifiers)) return null;
  const ids = [];
  const seen = new Set();
  for (const raw of value.identifiers) {
    const id = normalizePart(raw, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > MAX_IDS) return null;
  }
  const versions = {};
  const source = value.versions && typeof value.versions === "object" ? value.versions : {};
  for (const id of ids) {
    const version = versionOf(source[id]);
    if (version) versions[id] = version;
  }
  const latest = normalizePart(value.latest, 128);
  return {
    schema: SCHEMA,
    identifiers: ids,
    latest: latest && ids.includes(latest) ? latest : (ids[0] || ""),
    versions,
    updatedAt: Number.isFinite(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : 0,
  };
}

function read(email, region, appId) {
  try {
    const key = cacheKey(email, region, appId);
    if (!key || typeof $cache === "undefined" || typeof $cache.get !== "function") return null;
    return snapshotOf($cache.get(key));
  } catch (_e) {
    return null;
  }
}

function commit(key, snapshot) {
  if (!key || typeof $cache === "undefined" || typeof $cache.set !== "function") return false;
  const normalized = snapshotOf(snapshot);
  if (!normalized) return false;
  const serialized = JSON.stringify(normalized);
  if (serialized.length > MAX_CACHE_CHARS) return false;
  return $cache.set(key, normalized) !== false;
}

function writeList(email, region, appId, value) {
  try {
    const key = cacheKey(email, region, appId);
    if (!key) return false;
    const old = read(email, region, appId);
    const incoming = Array.from(new Set((value && value.identifiers || []).map(id => normalizePart(id, 128)).filter(Boolean)));
    if (incoming.length > MAX_IDS) return false;
    const versions = {};
    if (old && old.versions) {
      for (const id of incoming) if (old.versions[id]) versions[id] = old.versions[id];
    }
    return commit(key, {
      schema: SCHEMA,
      identifiers: incoming,
      latest: normalizePart(value && value.latest, 128),
      versions,
      updatedAt: Date.now(),
    });
  } catch (_e) {
    return false;
  }
}

function setVersion(email, region, appId, value) {
  try {
    const version = versionOf(value);
    if (!version) return false;
    const key = cacheKey(email, region, appId);
    if (!key) return false;
    const old = read(email, region, appId) || {
      schema: SCHEMA,
      identifiers: [version.id],
      latest: "",
      versions: {},
      updatedAt: Date.now(),
    };
    if (!old.identifiers.includes(version.id)) old.identifiers.push(version.id);
    old.versions[version.id] = version;
    return commit(key, old);
  } catch (_e) {
    return false;
  }
}

function knownVersions(email, region, appId) {
  const snapshot = read(email, region, appId);
  if (!snapshot) return [];
  return snapshot.identifiers.map(id => snapshot.versions[id]).filter(Boolean);
}

module.exports = {
  SCHEMA,
  MAX_IDS,
  read,
  writeList,
  setVersion,
  knownVersions,
  cacheKey,
};
