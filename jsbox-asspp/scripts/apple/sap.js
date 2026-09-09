// SAP ActionSignature 适配层。
//
// scripting 版通过一个临时 WebView + 本地代理运行 sap.wasm。JSBox 没有
// scripting 的 WebViewController/HttpServer 类型，因此这里用官方 web 组件、
// $server 和 $http 组合出等价流程：
//   1. 本地 web 页面加载 assets/sap 下的页面和运行时脚本；
//   2. 首次使用从固定的 HTTPS 地址下载 sap.wasm，并缓存到应用沙盒；
//   3. 仅允许代理 https 且主机属于 Apple/mzstatic 家族的 SAP endpoint
//      （内置默认端点或 bag 动态下发的端点都走同一套白名单）；
//   4. 二进制响应以短暂的 Base64 JSON envelope 传给 WebView；
//   5. 签名结果只在当前请求内存中存在，不写入 prefs/keychain。
// 登录 plist 也先在 JSBox 侧编码成 UTF-8 Base64 再通过 notify 传入页面，
// 避免 XML 的换行、尖括号或非 ASCII 字符在 WebView 桥接层被隐式重编码。
//
// Node 单测没有 JSBox UI 运行时。为便于测试，调用方可以传入
// `signSap(xml)` / `signSapBytes(bytes)` 或 `sapSignature`；没有 JSBox 时
// 返回空签名（不会在真机路径发生，因为真机路径会在无法签名时直接抛错）。

const b64 = require("../lib/b64");
const http = require("../lib/http");
const { errorMessage } = require("../lib/error");
const nativeSap = require("./native-sap");

const CERTIFICATE_URL = "https://s.mzstatic.com/sap/setupCert.plist";
const SETUP_URL = "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy";
const PROXY_PATH = "/__jasspp_sap_proxy__";
const SIGNER_PAGE = "local://assets/sap/index.html";
const REMOTE_WASM_URL =
  "https://github.com/dompling/Jsbox-Ipa/raw/refs/heads/main/sap-signer/sap.wasm";
const WASM_CACHE_PATH = "cache/sap.wasm";
const WASM_CACHE_TEMP_PATH = "cache/sap.wasm.part";
const SIGN_TIMEOUT_SECONDS = 90;
const API_SIGN_TIMEOUT_SECONDS = 480;
const MAX_PROXY_BODY_BYTES = 1 << 20;
const UPSTREAM_TIMEOUT_SECONDS = 30;
const PORT_MIN = 31000;
const PORT_MAX = 51000;

// 内置 WASM 签名引擎来自 Apple ID Web 登录的 signSapSetup 流程：
// `sapWasmPrepareSetup` 会把待签名内容当作 XML plist 解析（要求包含 hex
// `guid`），因此它只能给登录 XML 签名。Apple 已购的 /update 表单与
// /databases/{rev}/items DMAP 需要像 ipatool 那样对请求原始字节签名，必须
// 走原生 StoreServices SAP 会话或外部注入的字节签名器，不能交给 WebView。
const SAP_XML_ONLY_LIMITATION =
  "当前 JSBox 内置签名引擎只能对包含 guid 的登录 XML plist 签名，" +
  "无法对已购 update/items 的请求原始字节做 ActionSignature。请在支持 " +
  "ObjC Runtime（TrollStore/越狱版 JSBox）中重试以启用 StoreServices " +
  "原生 SAP，或通过 signSapBytes 注入外部字节签名器。";

let queue = Promise.resolve();
let wasmCachePromise = null;

class SapSignatureError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "SapSignatureError";
    if (cause) this.cause = cause;
  }
}

function randomPort() {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
}

function isLoopback(address) {
  const raw = String(address || "").trim().toLowerCase();
  if (!raw) return false;
  if (/^localhost(?::\d+)?$/.test(raw)) return true;
  if (/^(?:\[::1\]|::1)(?::\d+)?$/.test(raw)) return true;
  const mapped = raw.match(/^(?:\[)?::ffff:(127(?:\.\d{1,3}){3})(?:\])?(?::\d+)?$/);
  const ipv4 = raw.match(/^(127(?:\.\d{1,3}){3})(?::\d+)?$/);
  const candidate = (mapped && mapped[1]) || (ipv4 && ipv4[1]);
  if (!candidate) return false;
  return candidate
    .split(".")
    .every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function bytesOf(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => Number(item) & 0xff);
  if (value && Array.isArray(value.byteArray)) {
    return value.byteArray.map((item) => Number(item) & 0xff);
  }
  if (value && value.rawData) return bytesOf(value.rawData);
  if (value && typeof value.string === "string") return b64.utf8Encode(value.string);
  if (typeof value === "string") return b64.utf8Encode(value);
  return [];
}

function binaryLength(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof ArrayBuffer !== "undefined") {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(value)) {
      return value.byteLength;
    }
  }
  try {
    if (value && Array.isArray(value.byteArray)) return value.byteArray.length;
  } catch (_e) {}
  return 0;
}

function hasWasmMagic(value) {
  let bytes = null;
  if (Array.isArray(value)) bytes = value;
  else if (value && Array.isArray(value.byteArray)) bytes = value.byteArray;
  if (!bytes || bytes.length < 4) return true;
  return bytes[0] === 0x00 && bytes[1] === 0x61 &&
    bytes[2] === 0x73 && bytes[3] === 0x6d;
}

function reportWasmProgress(handler, state) {
  if (typeof handler !== "function") return;
  try {
    handler(Object.assign({ stage: "download" }, state || {}));
  } catch (_e) {
    // UI progress must never interrupt authentication.
  }
}

function wasmProgressMessage(written, total) {
  const received = Math.max(0, Number(written) || 0);
  const expected = Math.max(0, Number(total) || 0);
  if (expected > 0) {
    return `正在下载 SAP 签名引擎… ${Math.round(Math.min(1, received / expected) * 100)}%`;
  }
  return `正在下载 SAP 签名引擎… 已接收 ${Math.round(received / (1024 * 1024))} MB`;
}

function hasWasmCache() {
  return typeof $file !== "undefined" && $file &&
    typeof $file.exists === "function" && $file.exists(WASM_CACHE_PATH) &&
    (!($file.isDirectory && $file.isDirectory(WASM_CACHE_PATH)));
}

async function cacheRemoteWasm(onProgress) {
  if (hasWasmCache()) {
    reportWasmProgress(onProgress, {
      cached: true,
      progress: 1,
      message: "SAP 签名引擎已缓存",
    });
    return;
  }
  if (typeof $file === "undefined" || !$file ||
      typeof $file.write !== "function" || typeof $file.move !== "function") {
    throw new SapSignatureError("当前 JSBox 不支持 SAP 签名引擎缓存");
  }

  if (typeof $file.mkdir === "function") $file.mkdir("cache");
  if (typeof $file.delete === "function" && $file.exists(WASM_CACHE_TEMP_PATH)) {
    $file.delete(WASM_CACHE_TEMP_PATH);
  }
  reportWasmProgress(onProgress, {
    cached: false,
    progress: 0,
    message: "正在连接 SAP 签名引擎下载服务…",
  });

  let response;
  try {
    response = await http.send({
      method: "GET",
      url: REMOTE_WASM_URL,
      download: true,
      showsProgress: false,
      timeout: 300,
      progress: (written, total) => {
        const expected = Number(total) || 0;
        const received = Number(written) || 0;
        reportWasmProgress(onProgress, {
          cached: false,
          written: received,
          total: expected,
          progress: expected > 0 ? Math.min(1, received / expected) : null,
          message: wasmProgressMessage(received, expected),
        });
      },
    });
  } catch (error) {
    throw new SapSignatureError("下载 SAP 签名引擎失败：" + errorMessage(error), error);
  }
  const status = Number(response && response.status) || 0;
  if (!response || response.failed || status < 200 || status >= 300) {
    throw new SapSignatureError(`下载 SAP 签名引擎失败：HTTP ${status || "未知"}`);
  }
  const data = response.rawData !== undefined && response.rawData !== null
    ? response.rawData
    : response.data;
  const size = binaryLength(data) || Number(response.expectedContentLength) || 0;
  if (!data || size < 1024 * 1024) {
    throw new SapSignatureError("下载的 SAP 签名引擎文件不完整");
  }
  if (!hasWasmMagic(data)) {
    throw new SapSignatureError("下载的 SAP 签名引擎文件格式无效");
  }
  const contentType = String(
    response.headers && response.headers["content-type"] || ""
  ).split(";", 1)[0].trim().toLowerCase();
  if (contentType && /^(?:text\/|application\/(?:json|xml))/.test(contentType)) {
    throw new SapSignatureError("下载的 SAP 签名引擎不是 WASM 文件");
  }
  if (!$file.write({ data, path: WASM_CACHE_TEMP_PATH })) {
    throw new SapSignatureError("无法保存 SAP 签名引擎缓存");
  }
  if (!$file.move({ src: WASM_CACHE_TEMP_PATH, dst: WASM_CACHE_PATH })) {
    throw new SapSignatureError("无法提交 SAP 签名引擎缓存");
  }
  reportWasmProgress(onProgress, {
    cached: true,
    written: size,
    total: size,
    progress: 1,
    message: "SAP 签名引擎下载完成",
  });
}

function ensureWasmCache(onProgress) {
  if (!wasmCachePromise) {
    wasmCachePromise = cacheRemoteWasm(onProgress).catch((error) => {
      wasmCachePromise = null;
      throw error;
    });
  }
  return wasmCachePromise;
}

function requestQueryValue(request, key) {
  const query = request && request.query;
  if (query && query[key] !== undefined && query[key] !== null) {
    return Array.isArray(query[key]) ? query[key][0] : query[key];
  }
  const raw = String((request && (request.url || request.target)) || "");
  const match = new RegExp(`[?&]${key}=([^&#]*)`, "i").exec(raw);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch (_e) {
    return "";
  }
}

function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === String(name).toLowerCase()) return value;
  }
  return "";
}

function resolveTarget(request) {
  const value = String(requestQueryValue(request, "url") || "").trim();
  if (isAllowedSAPUpstream(value)) return value;
  throw new Error("不是允许的 SAP endpoint");
}

// SAP 代理只允许 https 且主机属于 Apple SAP 家族的端点。证书在
// mzstatic.com，signSapSetup 在 *.itunes.apple.com/*.apple.com；bag 动态
// 下发的端点也在同一批主机里，因此这里不绑定固定 URL，只锁主机。
function isAllowedSAPUpstream(value) {
  const match = /^(https):\/\/([^/?#]+)(\/.*)?$/i.exec(String(value || "").trim());
  if (!match) return false;
  if (match[1].toLowerCase() !== "https") return false;
  const authority = String(match[2]).toLowerCase();
  if (authority.indexOf("@") >= 0) return false;
  const hostname = authority.split(":")[0];
  return (
    hostname === "mzstatic.com" ||
    hostname.endsWith(".mzstatic.com") ||
    hostname === "apple.com" ||
    hostname.endsWith(".apple.com")
  );
}

// 调用方可在 options 里传入 bag 下发的 SAP 端点；只挑合法字符串字段，
// 避免把任意对象内容透传给签名页。
function webOptions(options) {
  const opts = options || {};
  const result = {};
  if (typeof opts.setupURL === "string" && opts.setupURL) result.setupURL = opts.setupURL;
  if (typeof opts.certificateURL === "string" && opts.certificateURL) {
    result.certificateURL = opts.certificateURL;
  }
  return result;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Origin",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}

function envelopeResponse(status, contentType, bytes, message) {
  const payload = Array.isArray(bytes) ? bytes : b64.utf8Encode(String(message || ""));
  return {
    type: "data",
    props: {
      statusCode: Number(status) || 502,
      contentType: "application/json; charset=utf-8",
      headers: corsHeaders(),
      text: JSON.stringify({
        ok: Number(status) >= 200 && Number(status) < 300,
        status: Number(status) || 502,
        contentType: contentType || "application/octet-stream",
        base64: b64.base64Encode(payload),
        message: message ? String(message).slice(0, 240) : "",
      }),
    },
  };
}

async function forward(request, target) {
  const method = String(request.method || "GET").toUpperCase();
  if (method === "GET") {
    return http.send({
      method: "GET",
      url: target,
      headers: { Accept: "*/*" },
      timeout: UPSTREAM_TIMEOUT_SECONDS,
    });
  }
  if (method !== "POST") throw new Error("SAP proxy 只支持 GET/POST");
  const body = request && request.data
    ? request.data
    : request && request.text
    ? typeof $data === "function"
      ? $data({ string: request.text })
      : request.text
    : undefined;
  return http.send({
    method: "POST",
    url: target,
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-plist",
    },
    body,
    timeout: UPSTREAM_TIMEOUT_SECONDS,
  });
}

async function handleProxyRequest(request) {
  const method = String((request && request.method) || "GET").toUpperCase();
  if (!isLoopback(request && request.remoteAddress)) {
    return envelopeResponse(403, "text/plain", [], "仅允许本机 SAP 请求");
  }
  if (method === "OPTIONS") {
    return {
      type: "default",
      props: { statusCode: 204, headers: corsHeaders() },
    };
  }
  if (method !== "GET" && method !== "POST") {
    return envelopeResponse(405, "text/plain", [], "method not allowed");
  }

  try {
    const target = resolveTarget(request);
    if (method === "POST") {
    const contentType = String(
        (request && (request.contentType || headerValue(request.headers, "content-type"))) || ""
      ).toLowerCase();
      if (contentType && contentType.split(";", 1)[0].trim() !== "application/x-plist") {
        return envelopeResponse(415, "text/plain", [], "Content-Type 必须为 application/x-plist");
      }
      const declaredLength = Number(request && request.contentLength) || 0;
      if (declaredLength > MAX_PROXY_BODY_BYTES) {
        return envelopeResponse(413, "text/plain", [], "SAP 请求体过大");
      }
      const requestBytes = bytesOf(request && (request.data || request.text));
      if (requestBytes.length > MAX_PROXY_BODY_BYTES) {
        return envelopeResponse(413, "text/plain", [], "SAP 请求体过大");
      }
    }
    const response = await forward(request, target);
    const headers = response.headers || {};
    const contentType = headers["content-type"] || headers["Content-Type"] || "application/octet-stream";
    const bytes = bytesOf(response.rawData || response.data || response.body);
    return envelopeResponse(response.status, contentType, bytes, response.error && response.error.message);
  } catch (error) {
    return envelopeResponse(502, "text/plain", [], error && (error.message || String(error)));
  }
}

function startProxy() {
  if (typeof $server === "undefined" || !$server || typeof $server.new !== "function") {
    throw new SapSignatureError("当前 JSBox 不支持本地 SAP 代理服务");
  }

  return new Promise((resolve, reject) => {
    const server = $server.new();
    const port = randomPort();
    let settled = false;
    let timer = null;

    const stop = () => {
      try {
        server.stop();
      } catch (_e) {}
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop();
      reject(error);
    };

    server.addHandler({
      filter: (rules) => {
        const path = String((rules && rules.path) || "").split("?", 1)[0];
        const urlPath = String((rules && rules.url) || "").split("?", 1)[0];
        if (path === PROXY_PATH || urlPath === PROXY_PATH) return "data";
        return "default";
      },
      asyncResponse: (request, completion) => {
        handleProxyRequest(request)
          .then((response) => completion(response))
          .catch((error) => completion(envelopeResponse(502, "text/plain", [], error)));
      },
    });

    server.listen({
      didStart: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          url: `http://127.0.0.1:${port}${PROXY_PATH}`,
          stop,
        });
      },
      didStop: () => {
        if (!settled) finishError(new SapSignatureError("SAP 代理服务启动失败"));
      },
    });

    try {
      server.start({ port });
    } catch (error) {
      finishError(error);
      return;
    }
    timer = setTimeout(() => finishError(new SapSignatureError("SAP 代理服务启动超时")), 4000);
  });
}

// scripting 版先用本地 HTTP 服务承载 signer 页面。local:// 能加载 HTML，
// 但部分 JSBox/WebKit 版本无法 fetch(local://.../sap.wasm)，只返回 NSError。
// 改为同源 HTTP 后，HTML、脚本和 WASM 都从同一个临时服务读取。
async function startSignerResources(onProgress) {
  if (typeof $server === "undefined" || !$server || typeof $server.start !== "function") {
    throw new SapSignatureError("当前 JSBox 不支持本地签名资源服务");
  }

  let cachedWasm = true;
  try {
    await ensureWasmCache(onProgress);
  } catch (error) {
    // 兼容仍然内置 sap.wasm 的旧包；新包没有该文件时继续抛出远程下载错误。
    if (!(typeof $file !== "undefined" && $file &&
        typeof $file.exists === "function" && $file.exists("assets/sap/sap.wasm"))) {
      throw error;
    }
    cachedWasm = false;
    reportWasmProgress(onProgress, {
      cached: true,
      progress: 1,
      message: "使用内置 SAP 签名引擎",
    });
  }

  const port = randomPort();
  let server;
  try {
    // 根目录服务同时暴露本地页面和 cache/sap.wasm；页面本身仍只允许加载
    // assets/sap 下的固定脚本，WASM 通过显式 URL 指向原子写入的缓存文件。
    server = $server.start({ port, path: "" });
  } catch (error) {
    throw new SapSignatureError(
      "签名资源服务启动失败：" + errorMessage(error),
      error
    );
  }
  if (!server || typeof server.stop !== "function") {
    throw new SapSignatureError("签名资源服务未返回可停止的服务器");
  }

  return {
    url: `http://127.0.0.1:${port}/assets/sap/index.html`,
    wasmURL: cachedWasm
      ? `http://127.0.0.1:${port}/cache/sap.wasm`
      : `http://127.0.0.1:${port}/assets/sap/sap.wasm`,
    stop: () => {
      try {
        server.stop();
      } catch (_e) {}
    },
  };
}

function resultValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, "error") && result.error) {
    throw new Error(errorMessage(result.error));
  }
  if (result && Object.prototype.hasOwnProperty.call(result, "result")) return result.result;
  return result;
}

function popSignerPage() {
  try {
    if ($ui && typeof $ui.pop === "function") $ui.pop();
  } catch (_e) {}
}

async function signInWebView(payload) {
  const proxy = await startProxy();
  let resources;
  try {
    resources = await startSignerResources(payload && payload.onProgress);
  } catch (error) {
    proxy.stop();
    throw error;
  }
  reportWasmProgress(payload && payload.onProgress, {
    stage: "login",
    cached: true,
    progress: null,
    message: "正在登录 Apple ID…",
  });
  const viewId = `jasspp-sap-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const options = {
    proxyURL: proxy.url,
    proxyEncoding: "base64-json",
    wasmURL: resources.wasmURL,
  };
  // bag 动态下发的 SAP 端点会随 payload.options 一并交给签名页。
  Object.assign(options, (payload && payload.options) || {});

  try {
    const signature = await new Promise((resolve, reject) => {
      let finished = false;
      let pageLoaded = false;
      let timeout = null;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }
        resolve(String(value || ""));
      };

      timeout = setTimeout(
        () => finish(new SapSignatureError("SAP 签名超时，请稍后重试")),
        SIGN_TIMEOUT_SECONDS * 1000
      );

      try {
        $ui.push({
          props: {
            title: "安全登录",
            bgcolor: $color("systemBackground"),
            theme: "auto",
          },
          events: {
            dealloc: () => {
              if (!finished) finish(new SapSignatureError("SAP 签名页面已关闭"));
            },
          },
          views: [
            {
              type: "web",
              props: {
                id: viewId,
                url: resources.url || SIGNER_PAGE,
                opaque: false,
                showsProgress: true,
                scrollEnabled: false,
                allowsNavigation: false,
              },
              layout: $layout.fill,
              events: {
                sapReady: (first, second) => {
                  const message = second === undefined ? first : second;
                  const payload = message && message.message ? message.message : message || {};
                  if (payload.requestId && payload.requestId !== viewId) return;
                },
                sapSigned: (first, second) => {
                  const message = second === undefined ? first : second;
                  const payload = message && message.message ? message.message : message || {};
                  if (payload.requestId && payload.requestId !== viewId) return;
                  const value = String(payload.signature || "");
                  if (!value) {
                    finish(new SapSignatureError("SAP 签名引擎返回空结果"));
                    popSignerPage();
                    return;
                  }
                  finish(null, value);
                  popSignerPage();
                },
                sapFailed: (first, second) => {
                  const message = second === undefined ? first : second;
                  const payload = message && message.message ? message.message : message || {};
                  if (payload.requestId && payload.requestId !== viewId) return;
                  finish(
                    new SapSignatureError(
                      "Apple 登录签名失败：" + errorMessage(payload.error || "SAP 签名失败")
                    )
                  );
                  popSignerPage();
                },
                didFinish: (sender) => {
                  if (finished || pageLoaded) return;
                  pageLoaded = true;
                  try {
                    const request = {
                      requestId: viewId,
                      ...(payload || {}),
                      options,
                    };
                    if (typeof sender.notify === "function") {
                      sender.notify({ event: "sapStart", message: request });
                      return;
                    }
                    // 某些旧版 JSBox 没有 notify；exec 只能返回同步值，
                    // 异步结果仍由页面通过 $notify 回传。
                    const startScript = `window.sapStart(${JSON.stringify(request)}); true;`;
                    const started = sender.exec(startScript);
                    if (started && typeof started.then === "function") {
                      started.then(resultValue).catch((error) => {
                        finish(
                          new SapSignatureError(
                            "Apple 登录签名失败：" + errorMessage(error),
                            error
                          )
                        );
                        popSignerPage();
                      });
                    } else {
                      resultValue(started);
                    }
                  } catch (error) {
                    finish(
                      new SapSignatureError(
                        "Apple 登录签名失败：" + errorMessage(error),
                        error
                      )
                    );
                    popSignerPage();
                  }
                },
                didFail: (_sender, _navigation, error) => {
                  finish(
                    new SapSignatureError(
                      "加载 SAP 签名资源失败：" + errorMessage(error),
                      error
                    )
                  );
                  popSignerPage();
                },
                didClose: () => {
                  if (!finished) finish(new SapSignatureError("SAP 签名页面已关闭"));
                },
              },
            },
          ],
        });
      } catch (error) {
        finish(new SapSignatureError("无法打开 SAP 签名页面", error));
      }
    });
    if (!signature) throw new SapSignatureError("SAP 签名结果为空");
    return signature;
  } finally {
    resources.stop();
    proxy.stop();
  }
}

function sign(xml, options) {
  const value = String(xml || "");
  if (!value) return Promise.reject(new SapSignatureError("待签名请求体为空"));
  const opts = options || {};

  if (typeof opts.signSap === "function") {
    return Promise.resolve(opts.signSap(value));
  }
  if (opts.sapSignature) return Promise.resolve(String(opts.sapSignature));
  if (typeof globalThis !== "undefined" && typeof globalThis.__jassppSignSap === "function") {
    return Promise.resolve(globalThis.__jassppSignSap(value));
  }

  // 纯 Node 单测没有任何 JSBox UI/Server 全局时返回空签名；一旦处于
  // 部分 JSBox 环境却缺少其中一个能力，必须失败关闭，不能把未签名密码
  // 请求发送给 Apple。
  const hasUi = typeof $ui !== "undefined";
  const hasServer = typeof $server !== "undefined";
  if (!hasUi && !hasServer) {
    return Promise.resolve("");
  }
  if (!hasUi || !hasServer) {
    return Promise.reject(new SapSignatureError("当前 JSBox 缺少 SAP 签名所需的 UI/Server 能力"));
  }

    const operation = queue.then(() =>
      signInWebView({
        // 页面走 signBytes，但输入仍是 XML plist 的原始 UTF-8 字节；这只
        // 改变跨桥传输形式，不改变 SAP 的签名内容。
        bodyBase64: b64.base64Encode(b64.utf8Encode(value)),
        options: webOptions(opts),
        onProgress: opts.onProgress,
      })
    );
  queue = operation.catch(() => {});
  return operation;
}

function supportsRawBodySigning(options) {
  const opts = options || {};
  if (typeof opts.signSapBytes === "function") return true;
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.__jassppSignSapBytes === "function"
  ) return true;
  // 第三方 HTTP 签名服务：需要已启用 api 模式且填了服务地址与 Token。
  if (opts.rawSapMode === "api") {
    return !!apiSignerConfig(opts);
  }
  // 原生 SSVFairPlaySAPSession 理论上能对任意原始字节签名，但在 JSBox 里
  // 可能直接卡住主线程，因此必须由用户显式选择 native 模式后才启用。
  // WebView 里的 WASM 只是登录 XML 签名器（见 SAP_XML_ONLY_LIMITATION），
  // 仅 webview 试验模式下才放行，用于把失败原因完整暴露出来。
  if (opts.rawSapMode === "native") {
    try {
      return nativeSap.isAvailable();
    } catch (_e) {
      return false;
    }
  }
  if (opts.rawSapMode === "webview") {
    return (
      typeof $ui !== "undefined" &&
      typeof $server !== "undefined"
    );
  }
  return false;
}

function rawSignerUnavailableMessage() {
  return "请在设置的「已购签名」中填写服务地址与 API Token。";
}

function rawSignerReject() {
  try {
    const reason = nativeSap.availabilityReason();
    if (reason) {
      return Promise.reject(
        new SapSignatureError(`${rawSignerUnavailableMessage()}${reason}`)
      );
    }
  } catch (_e) {}
  return Promise.reject(new SapSignatureError(rawSignerUnavailableMessage()));
}

// 第三方 HTTP 签名服务配置：sap-signer 服务部署在独立进程/容器，
// 通过 `POST /sign` 用 Bearer Token 换取原始字节的 ActionSignature。
// options 里必须同时带服务地址与 Token（由设置页填写后经已购流程传入）。
function apiSignerConfig(options) {
  const opts = options || {};
  if (opts.rawSapMode !== "api") return null;
  if (typeof opts.sapApiURL !== "string" || typeof opts.sapApiToken !== "string") return null;
  const token = opts.sapApiToken.trim();
  if (!token || /[\s\u0000-\u001f\u007f]/.test(token)) return null;
  try {
    const url = require("../store/settings").validateSapApiURL(opts.sapApiURL);
    return url ? { url, token } : null;
  } catch (_e) {
    return null;
  }
}

async function signBytesWithApi(bytes, config, guid) {
  const targetURL = `${config.url}/sign`;
  let res;
  try {
    res = await http.send({
      method: "POST",
      url: targetURL,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        guid,
        bodyBase64: b64.base64Encode(bytes),
      }),
      timeout: API_SIGN_TIMEOUT_SECONDS,
    });
  } catch (error) {
    throw new SapSignatureError(
      `第三方 SAP 签名服务请求失败：${errorMessage(error)}`
    );
  }
  if (res && res.failed) {
    throw new SapSignatureError(
      `第三方 SAP 签名服务请求失败：${errorMessage(res.error)}`
    );
  }
  // 官方 $http API 没有禁用自动重定向的文档选项。这里只拒收地址改变的
  // 响应，不重放带 Token 的请求，也不能保证 NSURLSession 尚未自动转发。
  const urlUtil = require("../lib/url");
  const expected = urlUtil.parse(targetURL);
  const final = urlUtil.parse(res && res.finalUrl);
  if (!final || final.username || final.password || final.hash ||
      final.origin !== expected.origin || final.pathname !== expected.pathname ||
      final.search !== expected.search) {
    throw new SapSignatureError("SAP 服务返回地址发生变化或无法验证，请使用无重定向的签名地址");
  }
  const status = Number(res && res.status) || 0;
  const payload =
    res && res.data !== undefined && res.data !== null
      ? res.data
      : res && res.body;
  const parsed = http.parseJSON(payload);
  if (status < 200 || status >= 300) {
    const detail =
      parsed && String(parsed.message || parsed.error || "").trim();
    throw new SapSignatureError(
      `第三方 SAP 签名服务返回 HTTP ${status || "未知"}` +
        (detail ? `：${detail}` : "")
    );
  }
  const signature = parsed && parsed.signature;
  if (typeof signature !== "string" || !signature ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature) ||
      b64.base64Encode(b64.base64Decode(signature)) !== signature) {
    throw new SapSignatureError("SAP 服务返回的签名不是有效的标准 Base64");
  }
  if (typeof parsed.guid !== "string" || parsed.guid.toUpperCase() !== guid) {
    throw new SapSignatureError("SAP 服务返回的 GUID 与请求不一致");
  }
  if (!Number.isInteger(parsed.bytesSigned) || parsed.bytesSigned !== bytes.length) {
    throw new SapSignatureError("SAP 服务返回的签名字节数与请求不一致");
  }
  return signature;
}

function signBytes(bytes, options) {
  const list = bytesOf(bytes);
  if (!list.length) return Promise.reject(new SapSignatureError("待签名请求体为空"));
  const opts = options || {};
  if (typeof opts.signSapBytes === "function") {
    return Promise.resolve(opts.signSapBytes(list));
  }
  if (opts.sapSignature) return Promise.resolve(String(opts.sapSignature));
  if (typeof globalThis !== "undefined" && typeof globalThis.__jassppSignSapBytes === "function") {
    return Promise.resolve(globalThis.__jassppSignSapBytes(list));
  }
  // 第三方签名服务与原生/WebView 一样需要用户显式选择 api 模式；请求体只
  // 以 Base64 传给签名服务，签名服务不会拿到账号 Cookie/Token。
  if (options && options.rawSapMode === "api") {
    const config = apiSignerConfig(options);
    if (!config) {
      return Promise.reject(
        new SapSignatureError(rawSignerUnavailableMessage({ rawSapMode: "api" }))
      );
    }
    const guid = String(options.guid || "").trim().toUpperCase();
    if (!/^(?:[0-9A-F]{2}){1,20}$/.test(guid)) {
      return Promise.reject(new SapSignatureError("SAP 请求 GUID 必须是 1 到 20 个完整十六进制字节"));
    }
    // 服务端串行处理并限制排队时长；远程调用不占用登录 WebView 的队列。
    return signBytesWithApi(list, config, guid);
  }
  // 原生 StoreServices 与 WebView WASM 都只在用户显式选择对应模式后启用：
  // 两者都可能长时间占用/卡住 JSBox 主线程，不能让已购流程默认触碰。
  if (opts.rawSapMode === "native") {
    try {
      if (nativeSap.isAvailable()) return nativeSap.sign(list);
    } catch (error) {
      return Promise.reject(
        new SapSignatureError(
          `原生 StoreServices SAP 调用失败：${error && (error.message || String(error))}`
        )
      );
    }
  }
  const hasUi = typeof $ui !== "undefined";
  const hasServer = typeof $server !== "undefined";
  if (opts.rawSapMode === "webview" && hasUi && hasServer) {
    const operation = queue.then(() =>
      signInWebView({
        // WebView bridge 只传 Base64，确保 DMAP 0x00、非 ASCII 和换行均不被
        // JSBox 的字符串桥接层重新编码。注意：当前打包的 WASM 只能解析
        // 登录 XML plist（见 SAP_XML_ONLY_LIMITATION），此处仅作为将来
        // 支持原始字节的 WASM 二进制保留的最后尝试，失败信息由调用方翻译。
        bodyBase64: b64.base64Encode(list),
        options: webOptions(opts),
      })
    );
    queue = operation.catch(() => {});
    return operation;
  }
  return rawSignerReject();
}

module.exports = {
  sign,
  signBytes,
  supportsRawBodySigning,
  rawSignerUnavailableMessage,
  SapSignatureError,
  isLoopback,
  bytesOf,
  resolveTarget,
  isAllowedSAPUpstream,
  webOptions,
  PROXY_PATH,
  CERTIFICATE_URL,
  SETUP_URL,
  REMOTE_WASM_URL,
  WASM_CACHE_PATH,
  hasWasmCache,
  ensureWasmCache,
  wasmProgressMessage,
  hasWasmMagic,
  SAP_XML_ONLY_LIMITATION,
};
