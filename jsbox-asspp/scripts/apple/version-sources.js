// 第三方历史版本映射：参考 IPA-Tool-3.0。
// 只用于补全 externalVersionId -> 可读版本号；失败必须静默，不影响 Apple 官方列表。

const http = require("../lib/http");

const SOURCES = [
  {
    name: "timbrd",
    url: (appId) => `https://api.timbrd.com/apple/app-version/index.php?id=${encodeURIComponent(String(appId))}`,
    parse(data) {
      const list = Array.isArray(data) ? data : [];
      return list.slice().reverse().map(item => ({
        id: String(item && item.external_identifier || ""),
        displayVersion: String(item && item.bundle_version || "").trim(),
      }));
    },
  },
  {
    name: "bilin",
    url: (appId) => `https://apis.bilin.eu.org/history/${encodeURIComponent(String(appId))}`,
    parse(data) {
      const list = data && Array.isArray(data.data) ? data.data : [];
      return list.map(item => ({
        id: String(item && item.external_identifier || ""),
        displayVersion: String(item && item.bundle_version || "").trim(),
      }));
    },
  },
];

function jsonOf(response) {
  if (!response) return null;
  if (response.data && typeof response.data === "object") return response.data;
  const body = response.body !== undefined ? response.body : response.data;
  if (typeof body !== "string" || !body.trim()) return null;
  return JSON.parse(body);
}

function normalize(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item && item.id || "").trim();
    const displayVersion = String(item && item.displayVersion || "").trim();
    if (!id || !displayVersion || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      requestedExternalVersionId: id,
      externalVersionId: id,
      displayVersion,
      buildVersion: "",
    });
  }
  return out;
}

async function fetchSource(source, appId) {
  try {
    const response = await http.send({
      method: "GET",
      url: source.url(appId),
      timeout: 8,
      showsProgress: false,
    });
    const status = Number(response && response.status) || 0;
    if (!response || response.failed || status < 200 || status >= 300) return [];
    return normalize(source.parse(jsonOf(response)));
  } catch (_e) {
    return [];
  }
}

async function fetchVersionMap(appId) {
  const id = String(appId || "").trim();
  if (!id) return [];
  const results = await Promise.all(SOURCES.map(source => fetchSource(source, id)));
  const best = results.reduce((current, value) => value.length > current.length ? value : current, []);
  return best;
}

module.exports = {
  SOURCES,
  fetchVersionMap,
  normalize,
};
