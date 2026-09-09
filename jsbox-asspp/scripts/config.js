// 全局配置与常量。保持纯 JS（不依赖 JSBox 全局对象），便于在 Node 中单测。
// 协议细节参考本仓库 ipatool-sapfix（pkg/appstore）与 Lakr233/Asspp 依赖的
// ApplePackage（Sources/ApplePackage，MIT）。

const APP = {
  name: "JAsspp",
  version: "0.2.1",
  author: "ipatool-sapfix",
};

// Apple 私有 Store API 使用的 User-Agent（与 Configurator 一致，
// 见 ApplePackage Configuration/Configuration.swift userAgent）。
const USER_AGENT =
  "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6";

// 国家代码 -> App Store 店铺编号（storefront）。
// 来源：ApplePackage Configuration/Configuration.swift countryCodeMap (MIT)。
const COUNTRY_STORE_MAP = {
  AE: "143481", AG: "143540", AI: "143538", AL: "143575", AM: "143524",
  AO: "143564", AR: "143505", AT: "143445", AU: "143460", AZ: "143568",
  BB: "143541", BD: "143490", BE: "143446", BG: "143526", BH: "143559",
  BM: "143542", BN: "143560", BO: "143556", BR: "143503", BS: "143539",
  BW: "143525", BY: "143565", BZ: "143555", CA: "143455", CH: "143459",
  CI: "143527", CL: "143483", CN: "143465", CO: "143501", CR: "143495",
  CY: "143557", CZ: "143489", DE: "143443", DK: "143458", DM: "143545",
  DO: "143508", DZ: "143563", EC: "143509", EE: "143518", EG: "143516",
  ES: "143454", FI: "143447", FR: "143442", GB: "143444", GD: "143546",
  GE: "143615", GH: "143573", GR: "143448", GT: "143504", GY: "143553",
  HK: "143463", HN: "143510", HR: "143494", HU: "143482", ID: "143476",
  IE: "143449", IL: "143491", IN: "143467", IS: "143558", IT: "143450",
  IQ: "143617", JM: "143511", JO: "143528", JP: "143462", KE: "143529",
  KN: "143548", KR: "143466", KW: "143493", KY: "143544", KZ: "143517",
  LB: "143497", LC: "143549", LI: "143522", LK: "143486", LT: "143520",
  LU: "143451", LV: "143519", MD: "143523", MG: "143531", MK: "143530",
  ML: "143532", MN: "143592", MO: "143515", MS: "143547", MT: "143521",
  MU: "143533", MV: "143488", MX: "143468", MY: "143473", NE: "143534",
  NG: "143561", NI: "143512", NL: "143452", NO: "143457", NP: "143484",
  NZ: "143461", OM: "143562", PA: "143485", PE: "143507", PH: "143474",
  PK: "143477", PL: "143478", PT: "143453", PY: "143513", QA: "143498",
  RO: "143487", RS: "143500", RU: "143469", SA: "143479", SE: "143456",
  SG: "143464", SI: "143499", SK: "143496", SN: "143535", SR: "143554",
  SV: "143506", TC: "143552", TH: "143475", TN: "143536", TR: "143480",
  TT: "143551", TW: "143470", TZ: "143572", UA: "143492", UG: "143537",
  US: "143441", UY: "143514", UZ: "143566", VC: "143550", VE: "143502",
  VG: "143543", VN: "143471", YE: "143571", ZA: "143472",
};

// 公开 iTunes API 与私有 Store API 端点。
const ENDPOINTS = {
  iTunesDomain: "itunes.apple.com",
  bagURL: (guid) => `https://init.itunes.apple.com/bag.xml?guid=${guid}`,
  defaultAuthURL: (guid) =>
    `https://auth.itunes.apple.com/auth/v1/native/fast/?guid=${guid}`,
  legacyAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
  // scripting 版当前使用的固定 pod 认证入口；保留为回退候选，
  // 不能替代首选的 bag/native 发现流程。
  scriptingAuthURL:
    "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
  purchasePath: "/WebObjects/MZFinance.woa/wa/buyProduct",
};

// 购买接口主机（可选 p<pod>- 前缀）。
function purchaseAPIHost(pod) {
  const normalized = normalizePod(pod);
  if (normalized) return `p${normalized}-buy.itunes.apple.com`;
  return "buy.itunes.apple.com";
}

// volumeStore 下载接口主机。
function storeAPIHost(pod) {
  const normalized = normalizePod(pod);
  if (normalized) return `p${normalized}-buy.itunes.apple.com`;
  return "p25-buy.itunes.apple.com";
}

function volumeStoreEndpoint(pod, guid) {
  return {
    host: storeAPIHost(pod),
    path: `/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=${guid}`,
    externalVersionIdKey: "externalVersionId",
  };
}

function redownloadEndpoint(guid) {
  return {
    host: "downloaddispatch.itunes.apple.com",
    path: `/r/redownload?guid=${guid}`,
    externalVersionIdKey: "appExtVrsId",
  };
}

// 公开 API：搜索 / 查询 / 榜单。
function searchURL(term, country, limit, entity) {
  const params = [
    "media=software",
    `entity=${encodeURIComponent(entity || "software")}`,
    `country=${encodeURIComponent(country)}`,
    `term=${encodeURIComponent(term)}`,
    `limit=${limit || 25}`,
  ];
  return `https://itunes.apple.com/search?${params.join("&")}`;
}

const SEARCH_ENTITIES = [
  { key: "software", title: "iPhone" },
  { key: "iPadSoftware", title: "iPad" },
];

function lookupURL(ids, country) {
  const list = Array.isArray(ids) ? ids.join(",") : String(ids);
  return `https://itunes.apple.com/lookup?id=${encodeURIComponent(
    list
  )}&country=${encodeURIComponent(country)}`;
}

function lookupByBundleURL(bundleId, country) {
  return `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(
    bundleId
  )}&country=${encodeURIComponent(country)}`;
}

// iTunes RSS 榜单（按国家、类型、可选分类）。
// kind: topfreeapplications | toppaidapplications | topgrossingapplications
function chartFeedURL(country, kind, limit, genreId) {
  let url = `https://itunes.apple.com/${encodeURIComponent(
    String(country).toLowerCase()
  )}/rss/${kind}/limit=${limit || 25}`;
  if (genreId) url += `/genre=${encodeURIComponent(genreId)}`;
  url += "/json";
  return url;
}

const CHART_KINDS = [
  { key: "topfreeapplications", title: "免费榜" },
  { key: "toppaidapplications", title: "付费榜" },
  { key: "topgrossingapplications", title: "畅销榜" },
];

const DEFAULTS = {
  region: "CN",
  chartKind: "topfreeapplications",
  chartLimit: 25,
  searchLimit: 25,
  downloadDir: "downloads",
  plistServer: "https://api.scripting.fun/ipa-plist",
};

function countryToStoreId(code) {
  return COUNTRY_STORE_MAP[String(code || "").toUpperCase()];
}

// Apple 返回的 storefront 既可能是纯 ID（143465），也可能是完整请求头
// （143465-1,29）。只接受数字结构，避免把任意响应文本拼进后续请求头。
function normalizeStoreFrontHeader(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw || raw.length > 64) return "";
  return /^\d+(?:-\d+(?:,\d+)*)?$/.test(raw) ? raw : "";
}

function normalizeStoreFrontId(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return "";
  const header = normalizeStoreFrontHeader(raw);
  if (header) return header.split("-")[0];
  return countryToStoreId(raw);
}

// 生成购买/下载请求所需的 storefront 头。已有完整头时原样保留；只有
// 纯 ID 或国家码时才补上对应 API 的默认后缀。
function storeFrontHeaderFor(account, suffix) {
  const raw = normalizeStoreFrontHeader(account && account.storeFrontHeader);
  if (raw && raw.indexOf("-") >= 0) return raw;
  const id =
    normalizeStoreFrontId(raw) ||
    normalizeStoreFrontId(account && account.storeFrontId) ||
    normalizeStoreFrontId(account && account.store);
  if (!id) return "";
  return `${id}${suffix || ""}`;
}

// Pod 头有时会带 p 前缀；规范化后再拼主机名，避免出现 pp42-buy。
function normalizePod(value) {
  let raw = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  if (raw.startsWith("p")) raw = raw.slice(1);
  return /^\d{1,8}$/.test(raw) ? raw : "";
}

function storeIdToCountry(storeId) {
  const id = normalizeStoreFrontId(storeId);
  for (const [code, value] of Object.entries(COUNTRY_STORE_MAP)) {
    if (value === String(id)) return code;
  }
  return undefined;
}

module.exports = {
  APP,
  USER_AGENT,
  COUNTRY_STORE_MAP,
  ENDPOINTS,
  DEFAULTS,
  CHART_KINDS,
  SEARCH_ENTITIES,
  purchaseAPIHost,
  storeAPIHost,
  volumeStoreEndpoint,
  redownloadEndpoint,
  searchURL,
  lookupURL,
  lookupByBundleURL,
  chartFeedURL,
  countryToStoreId,
  storeIdToCountry,
  normalizeStoreFrontHeader,
  normalizeStoreFrontId,
  storeFrontHeaderFor,
  normalizePod,
};
