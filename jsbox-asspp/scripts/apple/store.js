// 公开 iTunes API 封装：搜索 / lookup / 榜单（RSS）。
// 不需要 Apple ID 认证，与 ipatool 的 appstore_search / 榜单能力对应。

const config = require("../config");
const http = require("../lib/http");
const format = require("../lib/format");
const { errorMessage } = require("../lib/error");

// 公开接口可能缺少价格；未知不能变成可获取的免费许可。
function normalizePrice(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    value = Number(text);
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// 将 iTunes API 返回的原始字段映射为应用内统一结构（对应 ipatool 的
// appstore_search / Lookup 结果字段与 ApplePackage Models/Software）。
function mapSoftware(raw) {
  const price = normalizePrice(raw.price);
  return {
    id: String(raw.trackId),
    bundleID: raw.bundleId,
    name: raw.trackName,
    version: raw.version,
    price,
    formattedPrice: price === null ? "价格未知" : format.formatPrice(price, raw.currency, raw.formattedPrice),
    currency: raw.currency,
    artistName: raw.artistName,
    sellerName: raw.sellerName,
    description: raw.description,
    averageUserRating: raw.averageUserRating,
    userRatingCount: raw.userRatingCount,
    artworkUrl: raw.artworkUrl512 || raw.artworkUrl100,
    artworkUrl100: raw.artworkUrl100,
    screenshotUrls: raw.screenshotUrls || [],
    minimumOsVersion: raw.minimumOsVersion,
    fileSizeBytes: raw.fileSizeBytes,
    releaseDate: raw.currentVersionReleaseDate || raw.releaseDate,
    releaseNotes: raw.releaseNotes,
    primaryGenreName: raw.primaryGenreName,
    genres: raw.genres || [],
    trackViewUrl: raw.trackViewUrl,
    raw,
  };
}

async function requestJSON(url) {
  const res = await http.send({ method: "GET", url });
  if (res.failed) throw new Error(errorMessage(res.error));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`iTunes API 返回 HTTP ${res.status}`);
  }
  const json = http.parseJSON(
    res.data !== undefined && res.data !== null ? res.data : res.body
  );
  if (!json) throw new Error("iTunes API 返回非 JSON 数据");
  return json;
}

async function searchApps(term, country, limit, entity) {
  const url = config.searchURL(
    term,
    country,
    limit || config.DEFAULTS.searchLimit,
    entity || "software"
  );
  const json = await requestJSON(url);
  return (json.results || []).map(mapSoftware);
}

async function lookupByIds(ids, country) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return [];
  const url = config.lookupURL(list.slice(0, 200), country);
  const json = await requestJSON(url);
  return (json.results || []).map(mapSoftware);
}

async function lookupByBundleId(bundleId, country) {
  const url = config.lookupByBundleURL(bundleId, country);
  const json = await requestJSON(url);
  const results = json.results || [];
  return results.length ? mapSoftware(results[0]) : null;
}

// RSS 榜单解析：entry 可能是数组或单个对象。
function mapChartEntry(raw) {
  const idAttrs = (raw.id && raw.id.attributes) || {};
  const images = raw["im:image"] || [];
  const imageList = Array.isArray(images) ? images : [images];
  const icon =
    imageList.length > 0
      ? imageList[imageList.length - 1].label
      : undefined;
  const price = (raw["im:price"] && raw["im:price"].attributes) || {};
  const amount = normalizePrice(price.amount);
  const artist = (raw["im:artist"] && raw["im:artist"].label) || "";
  const category =
    (raw.category && raw.category.attributes && raw.category.attributes.label) ||
    "";
  return {
    id: String(idAttrs["im:id"] || ""),
    name: (raw["im:name"] && raw["im:name"].label) || "",
    artistName: artist,
    icon,
    formattedPrice: amount === null ? "价格未知" : format.formatPrice(amount, price.currency),
    price: amount,
    category,
  };
}

async function fetchChart(kind, country, limit) {
  const url = config.chartFeedURL(
    country,
    kind,
    limit || config.DEFAULTS.chartLimit
  );
  const json = await requestJSON(url);
  const feed = json.feed || {};
  const entries = feed.entry || [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map(mapChartEntry);
}

module.exports = {
  normalizePrice,
  mapSoftware,
  searchApps,
  lookupByIds,
  lookupByBundleId,
  fetchChart,
  mapChartEntry,
};
