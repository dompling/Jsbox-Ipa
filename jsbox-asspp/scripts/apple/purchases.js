// Apple App Store 已购列表。
//
// 这不是本地 downloads/ 目录的扫描，而是 Apple 的 Purchase DAAP 私有协议：
//   1. /login 建立购买记录会话；
//   2. /update 获取当前数据库 revision；
//   3. /databases/{revision}/items 读取已购买的 App 条目。
//
// items 请求使用 DMAP 二进制，必须按原始字节生成 SAP Action Signature。
// 账号会话、Cookie、DSID 和 storefront 全部从传入账号读取，不跨账号复用。

const config = require("../config");
const http = require("../lib/http");
const b64 = require("../lib/b64");
const sap = require("./sap");
const storeApi = require("./store");
const cookieLib = require("../lib/cookies");
const accountsStore = require("../store/accounts");
const settings = require("../store/settings");
const bag = require("./bag");
const diag = require("../lib/diag");
const session = require("./session");

const BASE_URL = "https://pd.itunes.apple.com/WebObjects/MZPurchaseDaap.woa/purchase";
const MEDIA_KIND = 131072;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_ENRICH_BATCH_SIZE = 20;
const OWNED_REQUEST_TIMEOUT_SECONDS = 20;

class PurchaseHistoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PurchaseHistoryError";
    this.code = code || "";
  }
}

function bytesOf(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => Number(item) & 0xff);
  if (value && Array.isArray(value.byteArray)) {
    return value.byteArray.map((item) => Number(item) & 0xff);
  }
  if (value && value.rawData) return bytesOf(value.rawData);
  if (typeof value === "string") return b64.utf8Encode(value);
  return [];
}

function requestData(body) {
  if (typeof $data !== "function") return body;
  const bytes = bytesOf(body);
  try {
    const value = $data({ byteArray: bytes });
    const actual = value && value.byteArray;
    if (Array.isArray(actual) && actual.length === bytes.length &&
        actual.every((byte, index) => byte === bytes[index])) {
      return value;
    }
  } catch (_e) {}
  throw new PurchaseHistoryError("无法保留已购请求的原始字节，请重试");
}

function accountGuid(account) {
  const guid = String(account && account.deviceIdentifier || "")
    .trim()
    .toUpperCase();
  if (!/^(?:[0-9A-F]{2}){6,20}$/.test(guid)) {
    throw new PurchaseHistoryError("账号缺少有效的设备标识，请重新登录");
  }
  return guid;
}

function timezoneName(now) {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    if (resolved && resolved.timeZone) return resolved.timeZone;
  } catch (_e) {}
  return "UTC";
}

function ownedHeaders(account, guid, now) {
  const offsetMinutes = -now.getTimezoneOffset();
  const storeFront =
    config.storeFrontHeaderFor(account, "") ||
    String(account && (account.storeFrontHeader || account.storeFront || ""));
  return {
    Accept: "*/*",
    "Accept-Language": "en-us",
    "Client-Cloud-DAAP-Request-Reason": "5",
    "Client-Cloud-Purchase-Daap-Version": "1.1/Configurator-2.0",
    "Client-DAAP-Version": "3.12",
    Date: now.toUTCString(),
    "iCloud-DSID": String(account.directoryServicesIdentifier || ""),
    "X-Apple-I-Client-Time": now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    "X-Apple-I-Locale": "en_US",
    "X-Apple-I-TimeZone": timezoneName(now),
    "X-Apple-Store-Front": storeFront,
    "X-Apple-TZ": String(offsetMinutes),
    "X-Dsid": String(account.directoryServicesIdentifier || ""),
    "X-Guid": guid,
    "X-Token": String(account.passwordToken || ""),
  };
}

function responseBytes(response) {
  return bytesOf(
    response && (response.rawData !== undefined ? response.rawData : response.data)
  );
}

function checkHTTP(label, response) {
  if (!response || response.failed) {
    throw new PurchaseHistoryError(
      `${label}失败：${httpError(response && response.error)}`
    );
  }
  const status = Number(response.status) || 0;
  if (status === 401 || status === 403) {
    throw new PurchaseHistoryError("登录已过期，请重新登录", String(status));
  }
  if (status < 200 || status >= 300) {
    throw new PurchaseHistoryError(`${label}失败：HTTP ${status || "未知"}`, String(status));
  }
}

// Purchase DAAP can return HTTP 200 with an application-level error in the
// DMAP `mstt` field. Match ipatool's behavior instead of treating that body
// as a valid session/revision/items response.
function checkDMAPStatus(label, data) {
  const result = firstDMAPUint(data, "mstt");
  if (!result.found) return;
  if (result.value === 401 || result.value === 403) {
    throw new PurchaseHistoryError("登录已过期，请重新登录", String(result.value));
  }
  if (result.value !== 200) {
    throw new PurchaseHistoryError(
      `${label}返回 DAAP 状态 ${result.value}`,
      String(result.value)
    );
  }
}

function httpError(error) {
  if (!error) return "网络请求失败";
  return error.message || String(error);
}

function isContainer(tag) {
  return [
    "adbs", "adsr", "aply", "avdb", "mbcl", "mccr", "mcty", "mdcl",
    "mlcl", "mlit", "mlog", "msrv", "mupd",
  ].indexOf(tag) >= 0;
}

function validTag(bytes) {
  if (!bytes || bytes.length !== 4) return false;
  return bytes.every((value) => value >= 0x20 && value <= 0x7e);
}

function walkDMAP(data, depth, visit) {
  if (depth > 16) throw new PurchaseHistoryError("购买记录响应嵌套过深");
  if (!data || !data.length) return;
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < 8) {
      throw new PurchaseHistoryError(`购买记录响应缺少 DMAP 标签头（字节 ${offset}）`);
    }
    const tagBytes = data.slice(offset, offset + 4);
    if (!validTag(tagBytes)) {
      throw new PurchaseHistoryError(`购买记录响应包含无效 DMAP 标签（字节 ${offset}）`);
    }
    const length =
      (((data[offset + 4] << 24) >>> 0) |
        (data[offset + 5] << 16) |
        (data[offset + 6] << 8) |
        data[offset + 7]) >>> 0;
    const remaining = data.length - offset - 8;
    if (length > remaining) {
      throw new PurchaseHistoryError(
        `DMAP 标签 ${String.fromCharCode(...tagBytes)} 长度超出响应范围`
      );
    }
    const end = offset + 8 + length;
    const tag = String.fromCharCode(...tagBytes);
    const payload = data.slice(offset + 8, end);
    visit(tag, payload);
    if (isContainer(tag)) walkDMAP(payload, depth + 1, visit);
    offset = end;
  }
}

function firstDMAPUint(data, target) {
  let found = false;
  let result = 0;
  walkDMAP(data, 0, (tag, payload) => {
    if (found || tag !== target) return;
    if (payload.length === 4) {
      result =
        (((payload[0] << 24) >>> 0) |
          (payload[1] << 16) |
          (payload[2] << 8) |
          payload[3]) >>> 0;
    } else if (payload.length === 8) {
      // JavaScript Number 能安全表示本协议需要的 session/revision 范围。
      result = 0;
      for (const value of payload) result = result * 256 + value;
    } else {
      throw new PurchaseHistoryError(`DMAP 标签 ${target} 的整数长度无效`);
    }
    found = true;
  });
  return { value: result, found };
}

function dmapTag(name, payload) {
  const bytes = new Array(8 + (payload ? payload.length : 0)).fill(0);
  for (let index = 0; index < 4; index++) bytes[index] = name.charCodeAt(index) & 0xff;
  const length = payload ? payload.length : 0;
  bytes[4] = (length >>> 24) & 0xff;
  bytes[5] = (length >>> 16) & 0xff;
  bytes[6] = (length >>> 8) & 0xff;
  bytes[7] = length & 0xff;
  if (payload) for (let index = 0; index < payload.length; index++) bytes[8 + index] = payload[index];
  return bytes;
}

function dmapUint8(name, value) {
  return dmapTag(name, [Number(value) & 0xff]);
}

function dmapUint32(name, value) {
  const number = Number(value) >>> 0;
  return dmapTag(name, [
    (number >>> 24) & 0xff,
    (number >>> 16) & 0xff,
    (number >>> 8) & 0xff,
    number & 0xff,
  ]);
}

function dmapString(name, value) {
  return dmapTag(name, b64.utf8Encode(String(value || "")));
}

function concatBytes(...parts) {
  const result = [];
  for (const part of parts) {
    if (part && part.length) result.push(...part);
  }
  return result;
}

function itemsBody(sessionID, revision, query, now) {
  const payload = concatBytes(
    dmapUint32("mstc", Math.floor(now.getTime() / 1000)),
    dmapUint32("mlid", sessionID),
    dmapUint8("mikd", 2),
    dmapUint32("musr", revision),
    dmapUint32("mder", 0),
    dmapString("mque", query),
    dmapTag("aetl", [])
  );
  return dmapTag("adsr", payload);
}

function purchaseQuery() {
  return `('com.apple.itunes.extended\\-media\\-kind:${MEDIA_KIND}')`;
}

async function signedHeaders(account, guid, body, options, stepLabel) {
  const headers = ownedHeaders(account, guid, new Date());
  diag.record({
    area: "purchased",
    step: stepLabel || "sign",
    attempting: true,
    rawSapMode: options && options.rawSapMode,
  });
  let signature;
  try {
    signature = await sap.signBytes(bytesOf(body), options);
  } catch (error) {
    const rawMessage = error && (error.message || String(error));
    diag.record({
      area: "purchased",
      step: stepLabel || "sign",
      signed: false,
      error: rawMessage,
    });
    // 内置 WASM 只会把待签名内容当登录 XML plist 解析（真机报 “decode XML
    // body / property list”）。这属于签名器能力不足，不是请求内容问题：
    // 把难懂的 Go plist 错误翻译成能指导下一步的说明，原始错误保留在后面。
    if (
      error instanceof Error &&
      rawMessage &&
      /(?:decode .*?XML body|XML body is empty|error parsing text property list)/i.test(rawMessage)
    ) {
      error.message =
        `Apple 已购请求需要原始字节 ActionSignature，但内置签名引擎只支持登录 XML plist。` +
        `${sap.SAP_XML_ONLY_LIMITATION}（原始错误：${rawMessage}）`;
    }
    // 保留签名器内部的子步骤定位信息（[证书下载]/[准备签名]/[交换
    // setup]/[完成签名]），只补上这是哪一步业务请求。
    if (stepLabel && error instanceof Error && error.message.indexOf("[") !== 0) {
      error.message = `[${stepLabel}] ${error.message}`;
    }
    throw error;
  }
  diag.record({
    area: "purchased",
    step: stepLabel || "sign",
    signed: true,
    signatureBytes: signature ? signature.length : 0,
  });
  if (signature) headers["X-Apple-ActionSignature"] = String(signature);
  return headers;
}

async function sendOwnedRequest(account, guid, label, request, options) {
  let response;
  try {
    response = await http.send({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      cookies: account.cookies || [],
      timeout: OWNED_REQUEST_TIMEOUT_SECONDS,
    });
  } catch (error) {
    diag.record({ area: "purchased", step: label, sent: true, error: httpError(error) });
    throw error;
  }
  try {
    checkHTTP(label, response);
  } catch (error) {
    diag.record({
      area: "purchased",
      step: label,
      sent: true,
      httpStatus: Number(response && response.status) || 0,
      error: error && (error.message || String(error)),
    });
    throw error;
  }
  const setCookies = http.setCookiesFromResponse(response);
  if (setCookies.length) {
    const mergedCookies = cookieLib.extractAndMergeCookies(
      setCookies,
      account.cookies || [],
      response.finalUrl || request.url
    );
    account.cookies = mergedCookies;
    // Cookie 刷新失败不能让已返回的购买记录消失；当前请求仍使用内存中的
    // 合并结果，下一次请求再由账号页提示重新登录或修复。
    try {
      const stored = accountsStore.getAccount(account.email);
      if (stored) accountsStore.saveAccount(Object.assign({}, stored, { cookies: mergedCookies }));
    } catch (_e) {}
  }
  const bytes = responseBytes(response);
  diag.record({
    area: "purchased",
    step: label,
    ok: true,
    httpStatus: Number(response.status) || 0,
    bytes: bytes.length,
  });
  if (!bytes.length) {
    const empty = new PurchaseHistoryError(`${label}返回空响应`);
    diag.record({ area: "purchased", step: label, error: empty.message });
    throw empty;
  }
  return bytes;
}

function parseOwnedApp(data) {
  const app = {
    id: "",
    name: "",
    bundleID: "",
    version: "",
    purchaseDate: "",
    price: 0,
  };
  walkDMAP(data, 0, (tag, payload) => {
    if (tag === "aeSI") {
      const parsed = payload.length === 8
        ? payload.reduce((value, item) => value * 256 + item, 0)
        : payload.length === 4
        ? (((payload[0] << 24) >>> 0) |
            (payload[1] << 16) |
            (payload[2] << 8) |
            payload[3]) >>> 0
        : 0;
      if (parsed) app.id = String(parsed);
    } else if (tag === "aeBI") {
      app.bundleID = b64.utf8Decode(payload);
    } else if (tag === "aeLN") {
      app.name = b64.utf8Decode(payload);
    } else if (tag === "minm" && !app.name) {
      app.name = b64.utf8Decode(payload);
    } else if (tag === "aePd") {
      app.version = b64.utf8Decode(payload);
    } else if (tag === "asdp") {
      if (payload.length === 4) {
        const timestamp =
          (((payload[0] << 24) >>> 0) |
            (payload[1] << 16) |
            (payload[2] << 8) |
            payload[3]) >>> 0;
        app.purchaseDate = new Date(timestamp * 1000).toISOString();
      }
    }
  });
  return app;
}

function parseOwnedApps(data) {
  const apps = [];
  const seen = new Set();
  walkDMAP(data, 0, (tag, payload) => {
    if (tag !== "mlit") return;
    const app = parseOwnedApp(payload);
    if (!app.id || seen.has(app.id)) return;
    seen.add(app.id);
    apps.push(app);
  });
  return apps;
}

function sortedByPurchaseDate(apps) {
  return apps.slice().sort((left, right) => {
    const l = left.purchaseDate ? Date.parse(left.purchaseDate) : 0;
    const r = right.purchaseDate ? Date.parse(right.purchaseDate) : 0;
    if (!l && !r) return 0;
    if (!l) return 1;
    if (!r) return -1;
    return r - l;
  });
}

function pageOf(apps, page, limit) {
  const start = (page - 1) * limit;
  if (start < 0 || start >= apps.length) return [];
  return apps.slice(start, Math.min(start + limit, apps.length));
}

function mergedOwnedApp(owned, publicItem) {
  const found = publicItem || {};
  return Object.assign({}, found, owned, {
    id: owned.id,
    owned: true,
    name: owned.name || found.name || "未命名 App",
    bundleID: owned.bundleID || found.bundleID || "",
    version: owned.version || found.version || "",
    price: 0,
  });
}

async function notify(options, name, ...args) {
  const handler = options && options[name];
  if (typeof handler !== "function") return;
  try {
    await handler(...args);
  } catch (_e) {
    // UI progress callbacks must never invalidate a successfully decoded
    // Apple response or make the purchase history request fail.
  }
}

async function enrichApps(apps, region, options) {
  let result = apps.map((owned) => mergedOwnedApp(owned, null));
  if (options && options.enrich === false) return result;
  const max = Math.max(0, Math.min(
    apps.length,
    Number(options && options.enrichLimit) || 200
  ));
  const batchSize = Math.max(
    1,
    Math.min(200, Number(options && options.enrichBatchSize) || DEFAULT_ENRICH_BATCH_SIZE)
  );
  for (let start = 0; start < max; start += batchSize) {
    const end = Math.min(start + batchSize, max);
    const ids = apps.slice(start, end).map((app) => app.id).filter(Boolean);
    const map = {};
    try {
      const found = await storeApi.lookupByIds(ids, region);
      for (const item of found || []) map[String(item.id)] = item;
    } catch (error) {
      if (options && options.failOnLookupError === true) throw error;
      // 购买记录本身已经是真实数据；公开 lookup 失败时保留 DAAP 字段。
    }
    for (let index = start; index < end; index++) {
      result[index] = mergedOwnedApp(apps[index], map[String(apps[index].id)]);
    }
    await notify(options, "onApps", result.slice(), {
      stage: "enrich",
      enrichedCount: end,
      visibleCount: result.length,
      complete: end >= max,
    });
  }
  return result;
}

async function runOwnedApps(account, options) {
  const opts = options || {};
  let rawSapMode = opts.rawSapMode;
  if (!rawSapMode) {
    try {
      rawSapMode = settings.rawSapMode();
    } catch (_e) {
      rawSapMode = "off";
    }
  }
  const flow = Object.assign({}, opts, { rawSapMode });
  const inferredRegion =
    opts.region ||
    config.storeIdToCountry(
      account && (account.storeFrontHeader || account.storeFront || account.store)
    ) ||
    String(account && account.store || "").toUpperCase();
  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  const guid = accountGuid(account);
  flow.guid = guid;
  if (!account.directoryServicesIdentifier || !account.passwordToken) {
    throw new PurchaseHistoryError("账号会话不完整，请重新登录");
  }
  // 显式传入的配置（包括空值）优先；只为缺失字段读取已保存设置。
  if (rawSapMode === "api") {
    for (const key of ["sapApiURL", "sapApiToken"]) {
      if (!Object.prototype.hasOwnProperty.call(opts, key)) {
        try {
          flow[key] = settings[key]();
        } catch (_e) {
          flow[key] = "";
        }
      }
    }
  }
  if (!sap.supportsRawBodySigning(flow)) {
    throw new PurchaseHistoryError(
      "暂时无法读取 App Store 已购记录。" +
        sap.rawSignerUnavailableMessage(rawSapMode === "api" ? flow : undefined),
      "RAW_SAP_SIGNER_UNAVAILABLE"
    );
  }

  const query = purchaseQuery();

  const usesRemoteAPI = rawSapMode === "api" && typeof flow.signSapBytes !== "function" &&
    !flow.sapSignature && !(typeof globalThis !== "undefined" && typeof globalThis.__jassppSignSapBytes === "function");
  // 远程服务自行管理 SAP setup/cert；只有本地或注入签名器需要读取 bag。
  if (!usesRemoteAPI) {
    let sapBagConfig;
    try {
      sapBagConfig = await bag.fetchSAPConfig(guid);
    } catch (_e) {
      sapBagConfig = { sapSetupURL: "", sapCertURL: "" };
    }
    diag.record({
      area: "purchased",
      step: "bag",
      bagOK: Boolean(sapBagConfig.sapSetupURL && sapBagConfig.sapCertURL),
    });
    if (sapBagConfig.sapSetupURL) flow.setupURL = sapBagConfig.sapSetupURL;
    if (sapBagConfig.sapCertURL) flow.certificateURL = sapBagConfig.sapCertURL;
  }

  await notify(flow, "onProgress", {
    stage: "login",
    title: "正在连接 App Store…",
    message: "正在建立购买记录会话",
  });
  const loginData = await sendOwnedRequest(
    account,
    guid,
    "购买记录登录",
    {
      method: "POST",
      url: `${BASE_URL}/login`,
      headers: ownedHeaders(account, guid, new Date()),
    },
    flow
  );
  checkDMAPStatus("购买记录登录", loginData);
  const loginSession = firstDMAPUint(loginData, "mlid");
  diag.record({
    area: "purchased",
    step: "login-parse",
    sessionFound: loginSession.found,
    session: loginSession.found ? loginSession.value : null,
  });
  if (!loginSession.found || loginSession.value > 0xffffffff) {
    throw new PurchaseHistoryError(
      `购买记录登录响应缺少有效会话（收到 ${loginData.length} 字节）`
    );
  }

  await notify(flow, "onProgress", {
    stage: "update",
    title: "正在查询购买记录…",
    message: "正在读取已购数据库版本",
  });
  const updateBody = requestData(`session-id=${loginSession.value}&revision-number=(null)&query=${query}`);
  await notify(flow, "onProgress", {
    stage: "update-sign",
    title: "正在准备购买记录签名…",
    message: "正在签名数据库更新请求",
  });
  const updateHeaders = await signedHeaders(account, guid, updateBody, flow, "update-sign");
  await notify(flow, "onProgress", {
    stage: "update-request",
    title: "正在查询购买记录…",
    message: "正在请求已购数据库版本",
  });
  const updateData = await sendOwnedRequest(
    account,
    guid,
    "更新购买记录",
    {
      method: "POST",
      url: `${BASE_URL}/update`,
      headers: Object.assign(
        { "Content-Type": "application/x-www-form-urlencoded" },
        updateHeaders
      ),
      body: updateBody,
    },
    flow
  );
  checkDMAPStatus("更新购买记录", updateData);
  const revision = firstDMAPUint(updateData, "musr");
  diag.record({
    area: "purchased",
    step: "update-parse",
    revisionFound: revision.found,
    revision: revision.found ? revision.value : null,
  });
  if (!revision.found || revision.value > 0xffffffff) {
    throw new PurchaseHistoryError(
      `购买记录更新响应缺少有效版本（收到 ${updateData.length} 字节）`
    );
  }

  await notify(flow, "onProgress", {
    stage: "items",
    title: "正在读取已购 App…",
    message: "正在准备已购 App 请求",
  });
  const now = new Date();
  const itemBody = requestData(itemsBody(loginSession.value, revision.value, query, now));
  await notify(flow, "onProgress", {
    stage: "items-sign",
    title: "正在准备已购 App…",
    message: "正在签名已购列表请求",
  });
  const itemHeaders = await signedHeaders(account, guid, itemBody, flow, "items-sign");
  await notify(flow, "onProgress", {
    stage: "items-request",
    title: "正在读取已购 App…",
    message: "Apple 正在返回购买记录，收到完整数据后会立即显示",
  });
  const itemData = await sendOwnedRequest(
    account,
    guid,
    "读取已购 App",
    {
      method: "POST",
      url: `${BASE_URL}/databases/${revision.value}/items`,
      headers: Object.assign(
        { "Content-Type": "application/x-dmap-tagged" },
        itemHeaders
      ),
      body: itemBody,
    },
    flow
  );
  checkDMAPStatus("读取已购 App", itemData);
  await notify(flow, "onProgress", {
    stage: "items-parse",
    title: "正在整理已购 App…",
    message: "已收到购买记录，正在显示列表",
  });
  const rawApps = sortedByPurchaseDate(parseOwnedApps(itemData));
  diag.record({ area: "purchased", step: "items-parse", apps: rawApps.length });
  const visibleRawApps = pageOf(rawApps, page, limit);
  const initialApps = visibleRawApps.map((app) => mergedOwnedApp(app, null));
  await notify(flow, "onApps", initialApps.slice(), {
    stage: "records",
    enrichedCount: 0,
    visibleCount: initialApps.length,
    totalCount: rawApps.length,
    complete: flow.enrich === false || initialApps.length === 0,
  });
  const apps = await enrichApps(visibleRawApps, inferredRegion, flow);
  const result = {
    apps,
    totalCount: rawApps.length,
    count: apps.length,
    page,
    limit,
  };
  if (opts.includeAllApps === true) {
    // 一次记录请求供页面本地分页与搜索；未知字段留给后续公开信息补全。
    result.allApps = rawApps.map((app) => Object.assign({}, app, { owned: true }));
  }
  return result;
}

// 对外入口：已购是私有协议，任何一步失败都把最近几条真机诊断记录拼进
// 错误文本，让 JSBox 页面的失败提示能直接看到到底是 bag / login / update
// / items / 签名哪一步出的问题，方便真机定位。成功路径不附加任何诊断。
async function listOwnedApps(account, options) {
  try {
    // 会话失效时（2034/2042）用记住的密码自动重新签名登录并重试一次，
    // 让“读取已购”在账号重新可用后直接继续，不再要求用户手动重登。
    return await session.withFreshSession(account, (acc) => runOwnedApps(acc, options));
  } catch (error) {
    diag.record({
      area: "purchased",
      step: "failed",
      error: error && (error.message || String(error)),
    });
    if (error instanceof Error && error.message && error.message.indexOf("[诊断]") < 0) {
      const tail = diag.tailText(6).trim();
      if (tail) error.message += `\n\n[诊断]\n${tail}`;
    }
    throw error;
  }
}

module.exports = {
  BASE_URL,
  MEDIA_KIND,
  OWNED_REQUEST_TIMEOUT_SECONDS,
  PurchaseHistoryError,
  bytesOf,
  dmapTag,
  dmapUint8,
  dmapUint32,
  dmapString,
  itemsBody,
  firstDMAPUint,
  checkDMAPStatus,
  walkDMAP,
  parseOwnedApp,
  parseOwnedApps,
  sortedByPurchaseDate,
  pageOf,
  mergedOwnedApp,
  enrichApps,
  listOwnedApps,
  purchaseQuery,
};
