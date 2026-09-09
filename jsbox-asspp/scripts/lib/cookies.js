// 手动 Cookie 管理（纯 JS）。
// Cookie 合并逻辑与 ApplePackage Supplement/Accounts.swift 中
// Cookie 的读写行为对齐：
// 每个 Apple ID 独立维护 cookie 列表，避免 NSURLSession 全局 cookie 串号。

const urlUtil = require("./url");

// 解析一个或多个 Set-Cookie 响应头。
function parseCookieHeaders(setCookieHeaders, originUrl) {
  const cookies = [];
  let originHost = "";
  const origin = urlUtil.parse(originUrl || "");
  if (origin) originHost = String(origin.hostname || "").toLowerCase();
  const expandedHeaders = [];
  for (const value of setCookieHeaders || []) {
    expandedHeaders.push(...splitCombinedSetCookie(value));
  }
  for (const header of expandedHeaders) {
    const parts = String(header)
      .split(";")
      .map((s) => s.trim());
    if (parts.length === 0) continue;
    const eqIdx = parts[0].indexOf("=");
    if (eqIdx < 0) continue;
    const name = parts[0].substring(0, eqIdx).trim();
    const value = parts[0].substring(eqIdx + 1).trim();
    if (!name) continue;

    let path = "/";
    let domain = originHost || undefined;
    let hostOnly = !!originHost;
    let maxAgeSeconds;
    let expiresDate;
    let httpOnly = false;
    let secure = false;
    let validDomain = true;

    for (let i = 1; i < parts.length; i++) {
      const attrEq = parts[i].indexOf("=");
      const attrName = (attrEq >= 0 ? parts[i].substring(0, attrEq) : parts[i])
        .trim()
        .toLowerCase();
      const attrVal = attrEq >= 0 ? parts[i].substring(attrEq + 1).trim() : "";
      switch (attrName) {
        case "path":
          path = attrVal || "/";
          break;
        case "domain":
          domain = (attrVal.startsWith(".") ? attrVal.substring(1) : attrVal)
            .toLowerCase();
          hostOnly = false;
          if (!domain || (originHost && !matchesDomain(domain, originHost))) {
            validDomain = false;
          }
          break;
        case "max-age": {
          const maxAge = parseInt(attrVal, 10);
          if (!isNaN(maxAge)) maxAgeSeconds = maxAge;
          break;
        }
        case "expires": {
          const d = new Date(attrVal);
          if (!isNaN(d.getTime())) expiresDate = d.getTime() / 1000;
          break;
        }
        case "httponly":
          httpOnly = true;
          break;
        case "secure":
          secure = true;
          break;
      }
    }
    if (!validDomain) continue;
    const expiresAt =
      maxAgeSeconds !== undefined
        ? Date.now() / 1000 + maxAgeSeconds
        : expiresDate;
    cookies.push({
      name,
      value,
      path,
      domain,
      hostOnly,
      expiresAt,
      httpOnly,
      secure,
    });
  }
  return cookies;
}

function splitCombinedSetCookie(value) {
  const text = String(value || "");
  if (!text) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ",") continue;
    const rest = text.slice(i + 1);
    // Expires=Wed, 21 Oct... 中逗号后没有新的 cookie-name=，不能切分。
    if (!/^\s*[^=;,\s]+\s*=/.test(rest)) continue;
    parts.push(text.slice(start, i).trim());
    start = i + 1;
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function normalizedStoredCookie(cookie) {
  if (!cookie || typeof cookie !== "object") return null;
  const name = String(cookie.name || "");
  const value = String(cookie.value === undefined ? "" : cookie.value);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return null;
  if (/[\r\n;]/.test(value)) return null;
  const path = String(cookie.path || "/");
  const normalized = Object.assign({}, cookie, {
    name,
    value,
    path: path.startsWith("/") ? path : "/",
  });
  if (cookie.domain) {
    const domain = String(cookie.domain).replace(/^\./, "").toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) return null;
    normalized.domain = domain;
    return normalized;
  }
  // 旧版本未记录响应来源。历史会话仅用于 Apple Store 请求，因此把它
  // 限定在 itunes.apple.com 域内，兼顾迁移可用性且不再向任意主机泄漏。
  return Object.assign(normalized, {
    domain: "itunes.apple.com",
    hostOnly: false,
    legacyScoped: true,
  });
}

function cookieKey(cookie) {
  return [
    cookie && cookie.name,
    String((cookie && cookie.domain) || "").toLowerCase(),
    (cookie && cookie.path) || "/",
  ].join("\n");
}

// 按 name + domain + path 合并（新 cookie 覆盖同作用域旧 cookie）。
// 下载/历史结果跨层交接时可保留过期记录作为删除更新，最终持久化仍默认过滤。
function mergeCookies(existing, newCookies, options) {
  const dict = new Map();
  const now = Date.now() / 1000;
  const preserveExpired = options && options.preserveExpired === true;
  for (const rawCookie of existing || []) {
    const cookie = normalizedStoredCookie(rawCookie);
    if (!cookie) continue;
    if (!preserveExpired && cookie.expiresAt !== undefined && cookie.expiresAt <= now) continue;
    dict.set(cookieKey(cookie), cookie);
  }
  for (const rawCookie of newCookies || []) {
    const cookie = normalizedStoredCookie(rawCookie);
    if (!cookie) continue;
    const key = cookieKey(cookie);
    if (!preserveExpired && cookie.expiresAt !== undefined && cookie.expiresAt <= now) dict.delete(key);
    else dict.set(key, cookie);
  }
  return Array.from(dict.values());
}

// 从 Set-Cookie 头合并进现有列表。
function extractAndMergeCookies(setCookieHeaders, existingCookies, originUrl) {
  const headers = (setCookieHeaders || []).filter(Boolean);
  if (headers.length === 0) return existingCookies || [];
  return mergeCookies(existingCookies, parseCookieHeaders(headers, originUrl));
}

function matchesDomain(cookieDomain, host) {
  const normalized = String(cookieDomain).toLowerCase();
  const requestHost = String(host).toLowerCase();
  return (
    requestHost === normalized || requestHost.endsWith("." + normalized)
  );
}

function matchesPath(cookiePath, requestPath) {
  if (cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

// 从 headers 字典中取出所有 set-cookie（值可能是字符串或数组）。
function collectSetCookieHeaders(headers) {
  const found = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== "set-cookie") continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) found.push(...splitCombinedSetCookie(item));
  }
  return found;
}

// 按 url 过滤出可用于请求的 Cookie 头字符串。
function buildCookieHeader(cookies, url) {
  const parsed = urlUtil.parse(url);
  if (!parsed) return "";
  const host = parsed.hostname;
  const path = parsed.pathname || "/";
  const scheme = parsed.protocol;
  const valid = [];
  const now = Date.now() / 1000;
  for (const rawCookie of cookies || []) {
    const cookie = normalizedStoredCookie(rawCookie);
    if (!cookie) continue;
    if (!cookie.name || !cookie.value) continue;
    if (!cookie.domain) continue;
    if (cookie.hostOnly) {
      if (String(cookie.domain).toLowerCase() !== String(host).toLowerCase()) continue;
    } else if (!matchesDomain(cookie.domain, host)) continue;
    if (!matchesPath(cookie.path || "/", path)) continue;
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) continue;
    if (cookie.secure && scheme !== "https:") continue;
    valid.push({
      header: `${cookie.name}=${cookie.value}`,
      pathLength: String(cookie.path || "/").length,
    });
  }
  valid.sort((a, b) => b.pathLength - a.pathLength);
  return valid.map((item) => item.header).join("; ");
}

module.exports = {
  parseCookieHeaders,
  mergeCookies,
  extractAndMergeCookies,
  collectSetCookieHeaders,
  buildCookieHeader,
  splitCombinedSetCookie,
};
