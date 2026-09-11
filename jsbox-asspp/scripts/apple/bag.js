// 获取 Apple 的 bag（端点定义），提取 authenticateAccount。
// 对应 ipatool pkg/appstore/appstore_bag.go（urlBag.authenticateAccount）与
// Lakr233/Asspp 依赖的 ApplePackage Sources/ApplePackage/Commands/Bag.swift。

const config = require("../config");
const http = require("../lib/http");
const plist = require("../lib/plist");

const NATIVE_AUTH_HOST = "auth.itunes.apple.com";

// bag 只用于发现端点，不能让第一次网络往返无限期拖住登录遮罩。
const BAG_TIMEOUT_SECONDS = 20;

// SAP 引擎需要 setup 证书与 signSapSetup 两个端点。ipatool 从 bag 里读取
// sign-sap-setup / sign-sap-setup-cert / sign-sap-version，而不是写死；
// 本地 SAP WASM 引擎只实现 legacy(v1/version=200)，因此只有当 bag 明确给
// 出 version 200（或缺省）时才采纳 bag 端点，否则回退内置默认值。
const SAP_SUPPORTED_VERSION = 200;
const NO_SAP = Object.freeze({ sapSetupURL: "", sapCertURL: "" });

// 真实 bag 响应会把 plist 包在 <Document><Protocol><plist>…</plist></Protocol></Document>
// 里（裸 plist 也是合法响应）。先截取 <plist> 片段再交给 plist 解析器，
// 与 ApplePackage Bag.swift 的 extractPlistData 行为一致。
function extractPlist(xml) {
  const text = String(xml || "");
  const start = text.indexOf("<plist");
  if (start < 0) return text;
  const end = text.indexOf("</plist>", start);
  if (end < 0) return text;
  return text.slice(start, end + "</plist>".length);
}

// bag 中的 native 认证端点缺少 /fast/ 子路径，直接访问会 301 到 HTML。
// 与 ApplePackage normalizedAuthEndpoint 行为一致；legacy 端点原样返回。
// 纯字符串实现，不依赖全局 URL 类（JSBox 运行时不保证与 Node 一致）。
function normalizeAuthURL(rawURL) {
  let url;
  try {
    url = http.validateCredentialTarget(rawURL, "Bag 认证端点").toString();
  } catch (_e) {
    return "";
  }
  const queryIndex = url.indexOf("?");
  const base = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const query = queryIndex >= 0 ? url.slice(queryIndex) : "";
  const match = /^https:\/\/([^/]+)(\/.*)?$/.exec(base);
  if (!match) return "";
  const host = match[1].toLowerCase();
  if (host !== NATIVE_AUTH_HOST) return `${base}${query}`;
  let path = match[2] || "/";
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.endsWith("/fast")) path += "/fast";
  return `https://${host}${path}/${query}`;
}

// 只放行 https 且主机属于 Apple SAP 家族的端点；登录/本地代理不能把
// 任意 URL 拼进签名请求。mzstatic.com 承载 setupCert，itunes/apple.com
// 承载 signSapSetup。
function isAppleSAPHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "mzstatic.com" ||
    host.endsWith(".mzstatic.com") ||
    host === "apple.com" ||
    host.endsWith(".apple.com")
  );
}

// 规范化 SAP 端点；非法返回 ""（调用方据此回退默认端点）。
function normalizeSAPEndpoint(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw || raw.length > 256) return "";
  const match = /^(https):\/\/([^/?#]+)(\/.*)?$/.exec(raw);
  if (!match) return "";
  if (match[1].toLowerCase() !== "https") return "";
  const host = match[2].toLowerCase();
  if (host.indexOf("@") >= 0) return "";
  if (!isAppleSAPHost(host.split(":")[0])) return "";
  if (!match[3]) return "";
  return raw;
}

function normalizeSAPVersion(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? number : null;
}

// 从解析后的 plist dict 抽取 SAP 配置。返回对象字段缺失/非法时为空串，
// 调用方自行决定是否采纳（version 必须 200 或缺省）。
function parseSAPConfig(dict) {
  const urlBag = dict && dict.urlBag;
  const root = dict || {};
  const pick = (key) => {
    const value =
      (urlBag && urlBag[key]) !== undefined && urlBag[key] !== null
        ? urlBag[key]
        : root[key];
    return value;
  };
  return {
    setupURL: normalizeSAPEndpoint(pick("sign-sap-setup")),
    certificateURL: normalizeSAPEndpoint(pick("sign-sap-setup-cert")),
    version: normalizeSAPVersion(pick("sign-sap-version")),
  };
}

function sapConfigResult(config) {
  const versionSupported =
    config.version === null || config.version === SAP_SUPPORTED_VERSION;
  if (versionSupported && config.setupURL && config.certificateURL) {
    return {
      sapSetupURL: config.setupURL,
      sapCertURL: config.certificateURL,
    };
  }
  // bag 缺失/非 legacy 版本/端点非法时返回空配置，由签名层回退内置默认。
  return { sapSetupURL: "", sapCertURL: "" };
}

async function fetchBag(guid) {
  // bag 只是用来发现端点，任何失败都不致命：一律回退到默认 native/fast 端点，
  // 保证登录链路不会因为“端点格式异常”卡死。
  const fallback = config.ENDPOINTS.defaultAuthURL(guid);
  const url = config.ENDPOINTS.bagURL(guid);
  let res;
  try {
    res = await http.send({
      method: "GET",
      url,
      headers: { Accept: "application/xml" },
      timeout: BAG_TIMEOUT_SECONDS,
    });
  } catch (_err) {
    return Object.assign({ authURL: fallback }, NO_SAP);
  }
  if (res.failed || !res.body) return Object.assign({ authURL: fallback }, NO_SAP);
  let dict;
  try {
    dict = plist.parsePlist(extractPlist(res.body));
  } catch (_e) {
    // 非 plist（HTML 错误页 / 区域拦截页等）同样回退默认端点。
    return Object.assign({ authURL: fallback }, NO_SAP);
  }
  const urlBag = dict && dict.urlBag;
  // authenticateAccount 旧格式在 urlBag 内层，新格式移到 plist 根（ApplePackage）。
  const authURL =
    (dict && dict.authenticateAccount) ||
    (urlBag && urlBag.authenticateAccount);
  // SAP 端点解析不依赖认证端点是否存在：已购等私有接口可能只关心 SAP
  // setup/cert，此时仍要把 SAP 字段带出去，而不是提前回退成空配置。
  const sapResult = sapConfigResult(parseSAPConfig(dict));
  if (!authURL) return Object.assign({ authURL: fallback }, sapResult);
  const normalized = normalizeAuthURL(authURL);
  return Object.assign({ authURL: normalized || fallback }, sapResult);
}

// 已购链路专用的 SAP 端点发现：返回 { sapSetupURL, sapCertURL }，无论 bag
// 是否可达/是否给出 SAP 字段都不会抛错；拿不到就用空串让签名层回退内置默认。
async function fetchSAPConfig(guid) {
  try {
    const result = await fetchBag(guid);
    return {
      sapSetupURL: String(result && result.sapSetupURL || ""),
      sapCertURL: String(result && result.sapCertURL || ""),
    };
  } catch (_e) {
    return Object.assign({}, NO_SAP);
  }
}

module.exports = {
  fetchBag,
  fetchSAPConfig,
  normalizeAuthURL,
  extractPlist,
  isAppleSAPHost,
  normalizeSAPEndpoint,
  normalizeSAPVersion,
  parseSAPConfig,
  sapConfigResult,
  SAP_SUPPORTED_VERSION,
};
