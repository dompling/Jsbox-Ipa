// 应用设置持久化（$prefs，见 docs.xteko.com foundation/prefs）。

const config = require("../config");
const http = require("../lib/http");

const PREFIX = "jasspp.";

function get(key, fallback) {
  const value = $prefs.get(`${PREFIX}${key}`);
  return value === undefined || value === null ? fallback : value;
}

function set(key, value) {
  if ($prefs.set(`${PREFIX}${key}`, value) === false) {
    throw new Error(`保存设置失败：${key}`);
  }
}

function region() {
  const code = String(get("region", config.DEFAULTS.region)).toUpperCase();
  return config.COUNTRY_STORE_MAP[code] ? code : config.DEFAULTS.region;
}

function setRegion(code) {
  const normalized = String(code || "").toUpperCase();
  if (config.COUNTRY_STORE_MAP[normalized]) set("region", normalized);
}

function chartKind() {
  const value = get("chartKind", config.DEFAULTS.chartKind);
  return config.CHART_KINDS.some((item) => item.key === value)
    ? value
    : config.DEFAULTS.chartKind;
}

function setChartKind(kind) {
  if (config.CHART_KINDS.some((item) => item.key === kind)) {
    set("chartKind", kind);
  }
}

function boundedLimit(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.max(1, parsed));
}

function chartLimit() {
  return boundedLimit(get("chartLimit", config.DEFAULTS.chartLimit), 25);
}

function setChartLimit(limit) {
  set("chartLimit", boundedLimit(limit, 25));
}

function searchLimit() {
  return boundedLimit(get("searchLimit", config.DEFAULTS.searchLimit), 25);
}

function authURLMode() {
  // auto | legacy | custom
  return get("authURLMode", "auto");
}

function setAuthURLMode(mode) {
  set("authURLMode", ["auto", "legacy", "custom"].includes(mode) ? mode : "auto");
}

function customAuthURL() {
  return get("customAuthURL", "");
}

function validateCustomAuthURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return http.validateCredentialTarget(raw, "认证端点").toString();
}

function setCustomAuthURL(url) {
  const normalized = validateCustomAuthURL(url);
  set("customAuthURL", normalized);
  return normalized;
}

const DEFAULT_PLIST_SERVER = config.DEFAULTS.plistServer;
const PLIST_SERVER_HOSTS = ["api.scripting.fun", "xiaobai.app"];

function validatePlistServer(value) {
  const parsed = require("../lib/url").parse(value);
  if (!parsed) throw new Error("Plist 服务不是有效 URL");
  if (parsed.protocol !== "https:") throw new Error("Plist 服务必须使用 HTTPS");
  if (!PLIST_SERVER_HOSTS.includes(parsed.hostname)) {
    throw new Error("Plist 服务必须使用受支持的 HTTPS 服务");
  }
  if (parsed.username || parsed.password) throw new Error("Plist 服务不能包含用户名或密码");
  if (parsed.hash) throw new Error("Plist 服务不能包含片段");
  if (parsed.port && parsed.port !== "443") throw new Error("Plist 服务只能使用标准 HTTPS 端口 443");
  return parsed.toString();
}

function plistServer() {
  try {
    return validatePlistServer(get("plistServer", DEFAULT_PLIST_SERVER));
  } catch (_e) {
    return DEFAULT_PLIST_SERVER;
  }
}

function setPlistServer(value) {
  const normalized = validatePlistServer(value);
  set("plistServer", normalized);
  return normalized;
}

const DEFAULT_SAP_API_URL = "";
const SAP_API_KEYCHAIN_DOMAIN = "com.jasspp.sap";
const SAP_API_TOKEN_KEY = "sapApiToken";
const INVALID_SAP_TOKEN = /[\s\u0000-\u001f\u007f]/;

// 已购原始字节签名由完整配置启用，旧 rawSapMode 偏好不再作为独立开关。
function rawSapMode() {
  if (!sapApiURL()) return "off";
  const token = sapApiToken().trim();
  return token && !INVALID_SAP_TOKEN.test(token) ? "api" : "off";
}

function validSapHost(host) {
  const ipv4 = (value) => {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) =>
      /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255
    );
  };
  if (host.startsWith("[") && host.endsWith("]")) {
    let value = host.slice(1, -1);
    if (value.includes(".")) {
      const lastColon = value.lastIndexOf(":");
      if (lastColon < 0 || !ipv4(value.slice(lastColon + 1))) return false;
      value = value.slice(0, lastColon + 1) + "0:0";
    }
    const halves = value.split("::");
    if (halves.length > 2) return false;
    const groups = halves.flatMap((half) => half ? half.split(":") : []);
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) &&
      (halves.length === 2 ? groups.length < 8 : groups.length === 8);
  }
  const hostname = host.replace(/\.$/, "");
  if (/^[0-9.]+$/.test(hostname)) return ipv4(hostname);
  return hostname.length <= 253 && hostname.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
  );
}

// 校验仅用于已购 SAP 服务，不改变登录或其他请求的 URL 规则。
function validateSapApiURL(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return "";
  const parts = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!parts || /[\s\\\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("SAP 服务地址不是有效 URL");
  }
  if (!/^https?$/i.test(parts[1])) {
    throw new Error("SAP 服务地址必须使用 HTTP 或 HTTPS");
  }
  if (parts[2].includes("@")) {
    throw new Error("SAP 服务地址不能包含用户名或密码");
  }
  if (parts[5]) throw new Error("SAP 服务地址不能包含片段");
  if (parts[4]) throw new Error("SAP 服务地址不能包含查询参数");
  const authority = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(parts[2]);
  if (!authority || !validSapHost(authority[1])) {
    throw new Error("SAP 服务地址不是有效 URL");
  }
  const port = authority[2] ? Number(authority[2]) : 0;
  if (authority[2] && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("SAP 服务地址端口必须在 1 到 65535 之间");
  }
  if (typeof URL === "function") {
    try {
      new URL(raw);
    } catch (_e) {
      throw new Error("SAP 服务地址不是有效 URL");
    }
  }
  const parsed = require("../lib/url").parse(raw);
  if (!parsed) throw new Error("SAP 服务地址不是有效 URL");
  const hostname = parsed.hostname.includes(":") && !parsed.hostname.startsWith("[")
    ? `[${parsed.hostname}]` : parsed.hostname;
  const standardPort = parsed.protocol === "https:" ? 443 : 80;
  const origin = `${parsed.protocol}//${hostname}${port && port !== standardPort ? `:${port}` : ""}`;
  const path = parsed.pathname.replace(/\/+$/, "").replace(/(?:\/sign)+$/, "");
  // JSBox 没有 URL 类时仍规范化路径；保留已有 %HH，避免重复编码。
  const encodedPath = encodeURI(path).replace(/%25([0-9a-f]{2})/gi, "%$1");
  return `${origin}${encodedPath}`;
}

function sapApiURL() {
  try {
    return validateSapApiURL(get("sapApiURL", DEFAULT_SAP_API_URL));
  } catch (_e) {
    return "";
  }
}

function setSapApiURL(value) {
  const normalized = validateSapApiURL(value);
  set("sapApiURL", normalized);
  if (get("sapApiURL", "") !== normalized) {
    throw new Error("保存 SAP 服务地址失败，请重试");
  }
  return normalized;
}

function keychainTokenAvailable() {
  return (
    typeof $keychain !== "undefined" &&
    !!$keychain &&
    typeof $keychain.get === "function" &&
    typeof $keychain.set === "function"
  );
}

function secureSapToken() {
  const value = $keychain.get(SAP_API_TOKEN_KEY, SAP_API_KEYCHAIN_DOMAIN);
  return value === undefined || value === null ? "" : String(value);
}

function clearLegacySapToken() {
  if (!get(SAP_API_TOKEN_KEY, "")) return;
  set(SAP_API_TOKEN_KEY, "");
  if (get(SAP_API_TOKEN_KEY, "")) throw new Error("旧 Token 清理失败");
}

// Token 只使用 Keychain。旧 prefs 值必须写入并读回成功后才清除；
// 钥匙串不可用时不向 prefs 回退，Node 测试也使用相同的存储契约。
function sapApiToken() {
  if (!keychainTokenAvailable()) return "";
  try {
    const token = secureSapToken();
    if (token) {
      try { clearLegacySapToken(); } catch (_e) {}
      return token;
    }
    const legacy = String(get(SAP_API_TOKEN_KEY, "") || "").trim();
    return legacy ? setSapApiToken(legacy) : "";
  } catch (_e) {
    return "";
  }
}

function setSapApiToken(value) {
  const token = String(value === undefined || value === null ? "" : value).trim();
  if (!keychainTokenAvailable()) {
    throw new Error("保存 SAP API Token 失败：JSBox 钥匙串不可用");
  }
  try {
    if (token) {
      if ($keychain.set(SAP_API_TOKEN_KEY, token, SAP_API_KEYCHAIN_DOMAIN) === false || secureSapToken() !== token) {
        throw new Error("钥匙串写入校验失败");
      }
    } else if (secureSapToken()) {
      if (typeof $keychain.remove !== "function" ||
          $keychain.remove(SAP_API_TOKEN_KEY, SAP_API_KEYCHAIN_DOMAIN) === false ||
          secureSapToken()) {
        throw new Error("钥匙串删除校验失败");
      }
    }
    clearLegacySapToken();
    return token;
  } catch (_e) {
    throw new Error("保存 SAP API Token 失败，请检查钥匙串和存储权限");
  }
}

function setSapConfig(value) {
  const url = validateSapApiURL(value.url);
  const token = String(value.token === undefined || value.token === null ? "" : value.token).trim();
  if (Boolean(url) !== Boolean(token)) {
    throw new Error("请填写服务地址和 API Token，或清空配置");
  }
  if (token && INVALID_SAP_TOKEN.test(token)) {
    throw new Error("API Token 不能包含空格、换行或控制字符");
  }
  // 地址先清空并读回，防止 Token 写入失败时把旧凭据发给新服务。
  // 失败后不恢复旧地址：Keychain 可能已经修改，保留表单供用户重试。
  setSapApiURL("");
  setSapApiToken(token);
  if (url) setSapApiURL(url);
}

// 计算登录时应使用的认证端点：'' 表示走 bag 自动发现。
function effectiveAuthURLOverride() {
  const mode = authURLMode();
  if (mode === "legacy") return config.ENDPOINTS.legacyAuthURL;
  if (mode === "custom") {
    // 历史版本可能存下过无法通过校验的自定义值；登录不应因此失败，
    // 失效时按自动发现（''）处理。
    try {
      return validateCustomAuthURL(customAuthURL());
    } catch (_err) {
      return "";
    }
  }
  return "";
}

module.exports = {
  region,
  setRegion,
  chartKind,
  setChartKind,
  chartLimit,
  setChartLimit,
  searchLimit,
  authURLMode,
  setAuthURLMode,
  customAuthURL,
  setCustomAuthURL,
  validateCustomAuthURL,
  effectiveAuthURLOverride,
  plistServer,
  setPlistServer,
  validatePlistServer,
  rawSapMode,
  DEFAULT_SAP_API_URL,
  validateSapApiURL,
  sapApiURL,
  setSapApiURL,
  sapApiToken,
  setSapApiToken,
  setSapConfig,
};
