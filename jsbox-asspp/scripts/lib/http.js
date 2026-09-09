// JSBox $http 封装：
// - 统一注入 User-Agent 与手动 Cookie 头
// - 读取 Set-Cookie 用于多账号隔离
// - 处理 NSURLSession 自动跟随重定向导致的 body 丢失（重定向恢复）
//
// 说明：JSBox 的 $http 基于 NSURLSession，301/302 会被自动跟随并降级为 GET，
// 而 Apple auth/volumeStore 端点要求“重定向后仍以原 body 重新 POST”。
// 这里通过对比 最终 URL 与 目标 URL 检测是否发生过重定向，并把同样的
// plist body 重新 POST 到最终主机（等价于 ApplePackage 的重试循环）。
//
// 注意：JSBox 运行时对 WHATWG URL 的支持不保证与 Node 完全一致，凭据
// 端点校验与查询参数改写全部使用纯字符串解析，避免把登录链路押在
// `new URL()` 是否可用上。

const config = require("../config");
const cookieLib = require("./cookies");
const { assertActive, DownloadCancelledError } = require("./cancellation");
const { errorMessage } = require("./error");

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some(
    (k) => String(k).toLowerCase() === String(name).toLowerCase()
  );
}

// 轻量 URL 解析：只提取重定向恢复需要比较的 origin/pathname/search，
// 不依赖全局 URL 类。解析失败返回 null。
function parseUrl(raw) {
  const text = String(raw === null || raw === undefined ? "" : raw).trim();
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(
    text
  );
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const pathname = match[3] || "/";
  const search = match[4] || "";
  if (!authority) return null;
  return {
    origin: `${scheme}://${authority}`,
    pathname,
    search,
  };
}

// 结构化解析认证端点（https://[userinfo@]host[:port]/path?query）。
// 返回 null 表示格式不合法；不依赖全局 URL 类。
function parseCredentialURL(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(
    text
  );
  if (!match) return null;
  const protocol = `${match[1].toLowerCase()}:`;
  let authority = match[2];
  if (!authority) return null;

  let username = "";
  let password = "";
  const at = authority.indexOf("@");
  if (at >= 0) {
    const userInfo = authority.slice(0, at);
    const colon = userInfo.indexOf(":");
    username = colon >= 0 ? userInfo.slice(0, colon) : userInfo;
    password = colon >= 0 ? userInfo.slice(colon + 1) : "";
    authority = authority.slice(at + 1);
    if (!authority) return null;
  }

  let hostname = authority;
  let port = "";
  if (authority.indexOf(":") >= 0) {
    const lastColon = authority.lastIndexOf(":");
    port = authority.slice(lastColon + 1);
    hostname = authority.slice(0, lastColon);
    if (!/^\d+$/.test(port)) return null;
  }
  hostname = hostname.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
    hostname
  )) {
    return null;
  }

  return {
    protocol,
    username,
    password,
    hostname,
    port,
    pathname: match[3] || "",
    search: match[4] || "",
    hash: "",
    origin: `${protocol}//${authority}`,
    toString() {
      let out = this.origin;
      if (this.pathname) out += this.pathname;
      if (this.search) out += this.search;
      return out;
    },
  };
}

function responseBody(data) {
  if (typeof data === "string") return data;
  if (data === undefined || data === null) return "";
  try {
    return JSON.stringify(data);
  } catch (_e) {
    return "";
  }
}

// JSBox 文档把 request body 的二进制形式定义为 `$data`。字符串在不同版本
// 的桥接层上可能被当成表单对象重新编码，尤其是认证使用的
// `application/x-www-form-urlencoded` + XML plist 组合。登录签名针对的是
// 原始 UTF-8 字节，因此在真机运行时把字符串明确转换成 `$data`；Node 单测
// 没有 `$data` 时仍保留字符串，方便纯 JS 测试。
function requestBody(value) {
  if (typeof value !== "string" || typeof $data !== "function") return value;
  try {
    const data = $data({ string: value });
    return data === undefined || data === null ? value : data;
  } catch (_e) {
    return value;
  }
}

function normalizeResponse(resp, expectBinary) {
  const rawHeaders = (resp && resp.response && resp.response.headers) || {};
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[String(key).toLowerCase()] = value;
  }
  const data = resp && resp.data;
  const explicitRawData = resp && resp.rawData;
  return {
    status: (resp && resp.response && resp.response.statusCode) || 0,
    headers,
    finalUrl: (resp && resp.response && resp.response.url) || "",
    expectedContentLength:
      (resp && resp.response && resp.response.expectedContentLength) || 0,
    data,
    body: responseBody(data),
    // JSBox may expose binary data through `rawData` even for a normal
    // request (the SAP setup exchange is one example). Preserve it instead
    // of discarding it merely because the caller did not use download=true.
    rawData:
      explicitRawData !== undefined && explicitRawData !== null
        ? explicitRawData
        : expectBinary
        ? data
        : undefined,
  };
}

function setCookiesFromResponse(res) {
  return cookieLib.collectSetCookieHeaders(res.headers);
}

// 发起单个请求（自动处理 UA / Cookie / body 编码）。
function send(options) {
  const cancellation = options.cancellation;
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let settled = false;
  let unsubscribe = null;
  let requestHandle = null;
  let requestReturned = false;
  let cancelAttempted = false;

  function finish(callback, value) {
    if (settled) return;
    settled = true;
    requestHandle = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    callback(value);
  }

  function cancelNativeRequest() {
    if (settled || !cancellation || !cancellation.cancelled || !requestReturned || cancelAttempted) return;
    cancelAttempted = true;
    // 官方文档没有承诺 $http 返回可取消句柄；仅对实际存在的能力尝试中止。
    // 无句柄、返回 false 或抛错时等待 handler 收尾，不提前宣称网络已停止。
    try {
      if (requestHandle && typeof requestHandle.cancel === "function" && requestHandle.cancel() !== false) {
        finish(reject, new DownloadCancelledError());
      }
    } catch (_e) {}
  }

  const headers = Object.assign({}, options.headers || {});
  if (!hasHeader(headers, "User-Agent")) {
    headers["User-Agent"] = config.USER_AGENT;
  }
  const cookieList = options.cookies || [];
  if (cookieList.length && !hasHeader(headers, "Cookie")) {
    const cookieHeader = cookieLib.buildCookieHeader(cookieList, options.url);
    if (cookieHeader) headers["Cookie"] = cookieHeader;
  }

  const requestOptions = {
    method: options.method || "GET",
    url: options.url,
    header: headers,
    // 榜单、搜索和认证请求不应把全局导航栏留在“加载中”；下载流程
    // 会显式传入 showsProgress: true，继续展示真实下载进度。
    showsProgress: options.showsProgress === undefined ? false : options.showsProgress,
    handler(resp) {
      if (settled) return;
      try {
        assertActive(cancellation);
        const normalized = normalizeResponse(resp, !!options.download);
        normalized.error = resp && resp.error;
        if (resp && resp.error) {
          normalized.failed = true;
        }
        assertActive(cancellation);
        finish(resolve, normalized);
      } catch (err) {
        finish(reject, cancellation && cancellation.cancelled ? new DownloadCancelledError() : err);
      }
    },
  };

  if (options.body !== undefined && options.body !== null) {
    // 文本 plist 保持字符串；$data/二进制请求体必须原样交给 JSBox，
    // 否则 String($data) 会把 SAP setup 请求破坏成 “[object Object]”。
    const body = options.body;
    requestOptions.body =
      typeof body === "string"
        ? requestBody(body)
        : typeof body === "number" || typeof body === "boolean"
        ? String(body)
        : body;
  }
  if (options.timeout) requestOptions.timeout = options.timeout;
  if (options.showsProgress !== undefined)
    requestOptions.showsProgress = options.showsProgress;
  if (options.progress) {
    requestOptions.progress = function (...args) {
      if (!settled && !(cancellation && cancellation.cancelled)) {
        return options.progress.apply(this, args);
      }
    };
  }
  if (options.message) requestOptions.message = options.message;
  if (options.backgroundFetch !== undefined)
    requestOptions.backgroundFetch = options.backgroundFetch;

  // 注意：不要先把 $http.request / $http.download 取出再调用。
  // 它们是 JSBox 暴露的 OC 实例方法，剥离 receiver 后裸调用会触发
  // “self type check failed for Objective-C instance method”桥接错误。
  try {
    assertActive(cancellation);
    if (cancellation) unsubscribe = cancellation.subscribe(cancelNativeRequest);
    assertActive(cancellation);
    if (options.download) {
      requestHandle = $http.download(requestOptions);
    } else {
      requestHandle = $http.request(requestOptions);
    }
    requestReturned = true;
    // handler 可能同步执行；取消也可能发生在原生方法返回句柄之前。
    if (settled) requestHandle = null;
    else cancelNativeRequest();
  } catch (err) {
    finish(reject, cancellation && cancellation.cancelled ? new DownloadCancelledError() : err);
  }
  return promise;
}

// 带“重定向恢复”的请求：validate(res) 判断响应是否有效；
// 若无效且最终 URL 的主机/路径与目标不同，则用相同 body 重发到最终 URL。
async function sendWithRedirectRecovery(options, validate, maxRecovery = 3) {
  let targetUrl = options.url;
  let lastRes = null;
  let recoveries = 0;
  const collectCookies = options.collectRedirectCookies === true;
  let requestCookies = options.cookies || [];
  const updatedCookies = [];

  try {
    for (;;) {
      const requestOptions = Object.assign({}, options, { url: targetUrl });
      if (collectCookies) {
        validateCredentialTarget(targetUrl, "下载请求端点");
        requestOptions.cookies = requestCookies;
      }
      lastRes = await send(requestOptions);
      const current = parseUrl(targetUrl);
      const final = parseUrl(lastRes.finalUrl);
      const currentSame = !current || !final || (
        final.origin === current.origin &&
        final.pathname === current.pathname &&
        final.search === current.search
      );
      if (lastRes.finalUrl && !final) {
        throw new Error("认证请求返回了无法解析的重定向地址");
      }
      // 传入原始字符串而不是 parseUrl() 的普通对象：认证端点校验需要
      // 协议/主机/端口等字段，String({ ... }) 会变成 [object Object]。
      if (!currentSame && !isAllowedRecoveryTarget(targetUrl, lastRes.finalUrl)) {
        throw new Error("认证请求遇到不安全的重定向，已停止处理响应");
      }
      if (collectCookies) {
        const responseURL = lastRes.finalUrl || targetUrl;
        validateCredentialTarget(responseURL, "下载响应来源");
        // 原生响应未给 URL 时保留本次请求来源，避免上层退回最初的主机。
        lastRes.finalUrl = responseURL;
        const responseCookies = cookieLib.parseCookieHeaders(setCookiesFromResponse(lastRes), responseURL);
        requestCookies = cookieLib.mergeCookies(requestCookies, responseCookies);
        // 每次响应按其实际来源解析，不能把中间 Set-Cookie 绑定到最终主机。
        // 累计的是结构化更新，保留过期删除指令，供上层按顺序合并。
        updatedCookies.push(...responseCookies);
        lastRes.updatedCookies = updatedCookies.slice();
      }
      // 下载取消后仍交回安全的在途响应，供上层保存 Cookie，但不继续重放。
      if (typeof options.shouldContinue === "function" && options.shouldContinue() === false) return lastRes;
      if (!validate || validate(lastRes)) return lastRes;

      if (!current || !final) return lastRes;
      if (
        currentSame ||
        recoveries >= maxRecovery
      ) {
        return lastRes;
      }

      targetUrl = `${final.origin}${final.pathname}${final.search}`;
      recoveries++;
    }
  } catch (err) {
    if (!collectCookies) throw err;
    // 原生桥接错误不保证可写；用普通 Error 承载更新，同时保留原始错误码。
    const failure = new Error(errorMessage(err));
    failure.code = err && err.code;
    failure.updatedCookies = updatedCookies.slice();
    throw failure;
  }
}

function isAppleStoreHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "itunes.apple.com" || host.endsWith(".itunes.apple.com");
}

function validateCredentialTarget(value, label) {
  const parsed = parseCredentialURL(value);
  if (!parsed) throw new Error(`${label || "认证端点"}不是有效 URL`);
  if (parsed.protocol !== "https:") {
    throw new Error(`${label || "认证端点"}必须使用 HTTPS`);
  }
  if (!isAppleStoreHost(parsed.hostname)) {
    throw new Error(`${label || "认证端点"}必须属于 itunes.apple.com`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label || "认证端点"}不能包含用户名或密码`);
  }
  // Apple 的凭据端点应走标准 TLS 端口；禁止通过自定义端口把密码送到
  // 同域名下另一个监听服务。
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`${label || "认证端点"}只能使用标准 HTTPS 端口 443`);
  }
  return parsed;
}

// 在 URL 上设置/替换查询参数（纯字符串实现，幂等）。
function appendQuery(urlString, name, value) {
  const text = String(urlString || "");
  const encodedValue = encodeURIComponent(String(value === undefined ? "" : value));
  const namePattern = new RegExp(`([?&])${name}=[^&]*`);
  if (text.indexOf("?") >= 0) {
    if (namePattern.test(text)) {
      return text.replace(namePattern, `$1${name}=${encodedValue}`);
    }
    return `${text}&${name}=${encodedValue}`;
  }
  return `${text}?${name}=${encodedValue}`;
}

// Credential-bearing POST bodies must never be replayed to an unrelated host.
function isAllowedRecoveryTarget(current, next) {
  if (!current || !next) return false;
  try {
    const from = validateCredentialTarget(current, "当前认证端点");
    const to = validateCredentialTarget(next, "重定向认证端点");
    return isAppleStoreHost(from.hostname) && isAppleStoreHost(to.hostname);
  } catch (_e) {
    return false;
  }
}

function parseJSON(text) {
  if (!text) return null;
  if (typeof text === "object") return text;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

module.exports = {
  send,
  sendWithRedirectRecovery,
  normalizeResponse,
  setCookiesFromResponse,
  parseJSON,
  hasHeader,
  parseUrl,
  appendQuery,
  isAllowedRecoveryTarget,
  validateCredentialTarget,
  requestBody,
};
