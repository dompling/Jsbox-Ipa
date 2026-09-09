// Apple ID 认证：对应 ipatool pkg/appstore/appstore_login.go 与
// Lakr233/Asspp 依赖的 ApplePackage Sources/ApplePackage/Commands/Authenticate.swift。
// 请求体（appleId/attempt/guid/password/rmp/why）与 scripting 版一致，
// 并在 JSBox 真机通过内置 SAP WASM 引擎生成 x-apple-actionsignature；
// 返回 Account 对象，调用方负责持久化。
//
// 2026-08 起 Apple 对第三方客户端认证做了限流/封堵：native 端点会间歇返回
// 204/301/302（多数无 Location）/403/404/5xx，稳定后同一请求又能拿到 plist。
// 因此这里参考 ipatool v2.3.2（PR #514）与社区修复：native -> legacy 多候选、
// 多轮次 + 退避重试；只有“凭据级”错误（验证码/账号被禁/坏密码）才立即终止。

const config = require("../config");
const http = require("../lib/http");
const plist = require("../lib/plist");
const bag = require("./bag");
const sap = require("./sap");
const { errorMessage } = require("../lib/error");

class AuthenticationError extends Error {
  constructor(message, codeRequired) {
    super(message);
    this.name = "AuthenticationError";
    this.codeRequired = !!codeRequired;
  }
}

// 纯字符串实现，避免依赖 JSBox 运行时的 WHATWG URL 支持。
function appendGuid(urlString, guid) {
  return http.appendQuery(urlString, "guid", guid);
}

function endpointWithGuid(urlString, guid) {
  // scripting 版的固定 p37 endpoint 不带查询参数；guid 只出现在 plist
  // body 中。其他 bag/native/legacy 端点保留历史实现的幂等 guid 参数。
  if (/^https:\/\/p\d+-buy\.itunes\.apple\.com\/WebObjects\/MZFinance\.woa\/wa\/authenticate(?:\?|$)/i.test(String(urlString || ""))) {
    return String(urlString);
  }
  return appendGuid(urlString, guid);
}

// 把重定向 Location 解析成绝对 URL（Location 可能是绝对或协议相对/路径相对）。
function resolveRedirectLocation(location, target) {
  const loc = String(location || "").trim();
  if (!loc) return "";
  if (/^https?:\/\//i.test(loc)) return loc;
  if (loc.indexOf("//") === 0) return `https:${loc}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(loc)) return "";
  const parsedTarget = http.parseUrl(String(target || ""));
  const origin = /^(https?:\/\/[^/?#]+)/i.exec(String(target || ""));
  if (!origin) return "";
  if (loc.indexOf("/") === 0) return `${origin[1]}${loc}`;
  if (loc.indexOf("?") === 0) {
    return `${origin[1]}${(parsedTarget && parsedTarget.pathname) || "/"}${loc}`;
  }
  const path = (parsedTarget && parsedTarget.pathname) || "/";
  const directory = path.slice(0, path.lastIndexOf("/") + 1) || "/";
  const segments = `${directory}${loc}`.split("/");
  const normalized = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length) normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return `${origin[1]}/${normalized.join("/")}`;
}

// 轮次间隔（毫秒）。Apple 按请求频率限流，失败后需要留出时间窗再试。
const DEFAULT_RETRY_DELAYS = [1200, 2500, 4000, 6000, 8000];
const MAX_TRIES = 6;

// 应视为“瞬时抖动”的响应状态：换候选端点继续重试，而不是直接判死。
const TRANSIENT_STATUSES = [204, 301, 302, 403, 404, 429, 500, 502, 503, 504];

// 抽取 Apple 各种包装后的 plist：<Document><Protocol><plist>…、纯 plist、裸 <dict>。
function extractLoginPlist(body) {
  const text = String(body || "");
  const plistStart = text.indexOf("<plist");
  if (plistStart >= 0) {
    const plistEnd = text.indexOf("</plist>", plistStart);
    if (plistEnd >= 0) return text.slice(plistStart, plistEnd + 8);
  }
  const dictStart = text.indexOf("<dict>");
  if (dictStart >= 0) {
    const dictEnd = text.lastIndexOf("</dict>");
    if (dictEnd >= 0) {
      return `<plist version="1.0">${text.slice(dictStart, dictEnd + 7)}</plist>`;
    }
  }
  return text;
}

// 把 Apple 的非 plist 错误正文压缩成可读片段，方便在弹窗里直接看到原因。
function bodySnippet(body) {
  const text = String(body || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 160) : "";
}

// 登录响应可接受 <plist> 或裸 <dict>（ipatol 参考实现同样容忍后一种）。
function isLoginPlist(body) {
  return plist.looksLikePlist(body) || String(body || "").indexOf("<dict") >= 0;
}

function sleep(ms) {
  return new Promise((resolve) => {
    if (typeof $delay === "function") {
      $delay(Math.max(0, ms) / 1000, resolve);
    } else {
      setTimeout(resolve, Math.max(0, ms));
    }
  });
}

function buildLoginBody(email, password, code, guid) {
  return plist
    .buildPlist({
      appleId: String(email || ""),
      attempt: "1",
      guid: String(guid || ""),
      password: `${String(password || "")}${String(code || "").replace(/\s+/g, "")}`,
      rmp: "0",
      why: "signIn",
    })
    .trim();
}

async function authenticate(options) {
  options = options || {};
  const email = options.email;
  const password = options.password;
  const code = options.code || "";
  const guid = options.deviceId;
  if (!email || !password || !guid) {
    throw new AuthenticationError("请输入 Apple ID、密码和设备标识");
  }
  if (code && !/^\d{6}$/.test(String(code).replace(/\s+/g, ""))) {
    throw new AuthenticationError("验证码必须是 6 位数字", true);
  }
  const retryDelays = Array.isArray(options.retryDelays)
    ? options.retryDelays
    : DEFAULT_RETRY_DELAYS;
  let cookies = options.existingCookies ? [...options.existingCookies] : [];

  // 候选端点：native（bag/默认）优先，随后 legacy MZFinance；尊重用户显式覆盖。
  let candidates = [];
  if (options.authURLOverride) {
    const validated = http
      .validateCredentialTarget(options.authURLOverride, "认证端点")
      .toString();
    candidates = [endpointWithGuid(validated, guid)];
  } else {
    let bagURL = "";
    try {
      const fetched = await bag.fetchBag(guid);
      if (fetched && fetched.authURL) {
        bagURL = http
          .validateCredentialTarget(fetched.authURL, "Bag 认证端点")
          .toString();
      }
    } catch (_err) {
      bagURL = "";
    }
    if (!bagURL) bagURL = config.ENDPOINTS.defaultAuthURL(guid);
    if (options.preferScriptingEndpoint) {
      candidates = [
        config.ENDPOINTS.scriptingAuthURL,
        appendGuid(config.ENDPOINTS.defaultAuthURL(guid), guid),
        endpointWithGuid(config.ENDPOINTS.legacyAuthURL, guid),
      ];
    } else if (bagURL.indexOf("/native/") >= 0) {
      candidates = [
        appendGuid(bagURL, guid),
        endpointWithGuid(config.ENDPOINTS.legacyAuthURL, guid),
        endpointWithGuid(config.ENDPOINTS.scriptingAuthURL, guid),
      ];
    } else {
      // bag 给出的 legacy 端点最近常被 Apple 直接拒绝（空 403），
      // 仍把官方 native 端点放第一候选。
      candidates = [
        appendGuid(config.ENDPOINTS.defaultAuthURL(guid), guid),
        appendGuid(bagURL, guid),
        endpointWithGuid(config.ENDPOINTS.legacyAuthURL, guid),
        endpointWithGuid(config.ENDPOINTS.scriptingAuthURL, guid),
      ];
    }
    const seen = [];
    candidates = candidates.filter((url) => {
      if (seen.indexOf(url) >= 0) return false;
      seen.push(url);
      return true;
    });
  }

  let storeFront = "";
  let storeFrontHeader = "";
  let pod = "";
  let transientSeen = [];

  // scripting 版固定使用 attempt=1，并在需要时把六位验证码直接拼到
  // 密码末尾。所有字段显式写成 string，等价于 scripting 的
  // `plist.build(...).replaceAll("integer", "string")`，签名和实际 body
  // 因而始终是同一份 XML 字节。
  const body = buildLoginBody(email, password, code, guid);
  let actionSignature = "";
  try {
    actionSignature = await sap.sign(body, options);
  } catch (error) {
    throw new AuthenticationError(
      `Apple 登录签名失败：${errorMessage(error)}`
    );
  }
  const requestHeaders = {
    // Apple 当前 scripting/Go 客户端均使用 form-urlencoded；
    // application/x-apple-plist 会被部分 pod 直接返回 403/空响应。
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (actionSignature) requestHeaders["x-apple-actionsignature"] = actionSignature;

  const isValid = (res) => res.status === 200 && isLoginPlist(res.body);

  // 发起一次请求并合入 Cookie / storefront / pod；若 Apple 给了带 Location 的
  // 3xx，返回 follow 地址（由主循环原地重试，等价于 ApplePackage 的重试循环）。
  async function tryOnce(target) {
    let res;
    try {
      res = await http.sendWithRedirectRecovery(
        {
          method: "POST",
          url: target,
          headers: requestHeaders,
          body,
          cookies,
        },
        isValid,
        2
      );
    } catch (error) {
      // 不把请求体/密码带进错误文本；重定向安全错误仍然可以让主循环
      // 继续到下一个 Apple 候选端点。
      return {
        res: {
          status: 0,
          finalUrl: target,
          headers: {},
          body: "",
          failed: true,
          error,
        },
      };
    }

    cookies = cookieLibMerge(
      cookies,
      http.setCookiesFromResponse(res),
      res.finalUrl || target
    );

    const lowerHeaders = res.headers || {};
    const storeHeader = lowerHeaders["x-set-apple-store-front"];
    if (storeHeader) {
      const rawHeader = Array.isArray(storeHeader)
        ? storeHeader[0]
        : storeHeader;
      const normalizedHeader = config.normalizeStoreFrontHeader(rawHeader);
      if (normalizedHeader) {
        storeFrontHeader = normalizedHeader;
        storeFront = config.normalizeStoreFrontId(normalizedHeader);
      }
    }
    const podHeader = lowerHeaders["pod"];
    const normalizedPod = config.normalizePod(
      Array.isArray(podHeader) ? podHeader[0] : podHeader
    );
    if (normalizedPod) pod = normalizedPod;

    if (res.status >= 300 && res.status < 400) {
      const location = lowerHeaders["location"];
      if (location) {
        const resolved = resolveRedirectLocation(location, target);
        let next;
        try {
          next = http
            .validateCredentialTarget(resolved, "重定向认证端点")
            .toString();
        } catch (_err) {
          return { res, follow: "" };
        }
        return { res, follow: endpointWithGuid(next, guid) };
      }
    }
    return { res };
  }

  // 解析 plist：成功返回 Account；凭据级错误抛 AuthenticationError。
  function resolvePlist(dict, tryIndex, status) {
    if (!dict || typeof dict !== "object") {
      throw new AuthenticationError("Apple 认证响应格式无效");
    }
    const failureType =
      dict.failureType === undefined || dict.failureType === null
        ? ""
        : String(dict.failureType);
    const customerMessage = String(dict.customerMessage || "");

    // 验证码错误（ApplePackage: failureType 5005 -> invalid2FACode）
    if (failureType === "5005") {
      throw new AuthenticationError("验证码不正确，请重新输入", true);
    }

    // 二步验证码要求（ipatool: MZFinance.BadLogin.Configurator_message）
    if (
      failureType === "" &&
      !code &&
      customerMessage === "MZFinance.BadLogin.Configurator_message"
    ) {
      throw new AuthenticationError("需要两步验证码", true);
    }

    if (failureType === "" && customerMessage === "MZFinance.BadLogin.AccountDisabled_message") {
      throw new AuthenticationError("Apple ID 已被停用");
    }

    // 某些 pod 用 -5000 表示暂时不可用；只对首轮允许切换候选端点。
    if (failureType === "-5000" && tryIndex === 0) {
      return null;
    }

    if (failureType) {
      const message =
        (dict.dialog && (dict.dialog.explanation || dict.dialog.message)) ||
        customerMessage ||
        `Apple 登录失败（${failureType}）`;
      throw new AuthenticationError(message);
    }

    const failureMessage =
      (dict.dialog && (dict.dialog.explanation || dict.dialog.message)) ||
      dict.customerMessage;
    if (Number(status) !== 200) {
      throw new AuthenticationError(`Apple 认证返回 HTTP ${status || "未知"}`);
    }
    const accountInfo = dict.accountInfo;
    if (!accountInfo) {
      throw new AuthenticationError(failureMessage || "账号信息缺失");
    }
    const address = accountInfo.address;
    if (!address) {
      throw new AuthenticationError(failureMessage || "账号地址信息缺失");
    }

    const storeCountry = config.storeIdToCountry(storeFront);
    const passwordToken = String(dict.passwordToken || "");
    const dsPersonId = String(dict.dsPersonId === undefined || dict.dsPersonId === null ? "" : dict.dsPersonId);
    if (!passwordToken || !dsPersonId) {
      throw new AuthenticationError("Apple 认证响应缺少会话令牌，请稍后重试");
    }

    // storefront 由 Apple 的响应头返回，是账号所属区域的唯一可信来源。
    // 没有它就不能安全地绑定区域，也不能拿当前 UI 区域代替。
    if (!storeFront) {
      throw new AuthenticationError("Apple 认证响应缺少商店区域，请稍后重试");
    }

    return {
      email,
      appleId: accountInfo.appleId || email,
      store: storeCountry || storeFront,
      storeFrontId: storeFront,
      storeFrontHeader: storeFrontHeader || storeFront,
      firstName: address.firstName || "",
      lastName: address.lastName || "",
      passwordToken,
      directoryServicesIdentifier: dsPersonId,
      cookies,
      deviceIdentifier: guid,
      pod,
      createdAt: new Date().toISOString(),
    };
  }

  let candidateIndex = 0;
  let redirectCount = 0;
  for (let tryIndex = 0; tryIndex < MAX_TRIES; tryIndex++) {
    const target = candidates[candidateIndex % candidates.length];
    const { res, follow } = await tryOnce(target);
    if (follow) {
      redirectCount += 1;
      if (redirectCount > 3) {
        transientSeen.push({ status: res.status, snippet: "重定向次数过多" });
      } else {
      candidates[candidateIndex % candidates.length] = follow;
      continue; // pod 重定向属于同一次尝试，立即重发
      }
    }

    if (res.status === 200 && isLoginPlist(res.body)) {
      let dict;
      try {
        dict = plist.parsePlist(extractLoginPlist(res.body));
      } catch (_parseErr) {
        transientSeen.push({ status: 200, snippet: "无法解析 plist" });
        if (tryIndex < MAX_TRIES - 1) {
          await sleep(retryDelays[Math.min(tryIndex, retryDelays.length - 1)]);
          candidateIndex = (candidateIndex + 1) % candidates.length;
          continue;
        }
        throw new AuthenticationError(
          "Apple 认证服务暂不可用：返回内容无法解析，请稍后再试"
        );
      }
      const account = resolvePlist(dict, tryIndex, res.status);
      if (account) return account;
      // -5000 首轮失败：落到下方按瞬时抖动处理
    }

    // 无论是否判定为瞬时抖动，都保留最后一次诊断，便于错误里看到 Apple 原样返回。
    transientSeen.push({
      status: res.status,
      snippet: bodySnippet(res.body),
    });

    if (tryIndex >= MAX_TRIES - 1) break;
    await sleep(retryDelays[Math.min(tryIndex, retryDelays.length - 1)]);
    candidateIndex = (candidateIndex + 1) % candidates.length;
  }

  const last = transientSeen[transientSeen.length - 1] || {};
  const statusText = last.status ? `HTTP ${last.status}` : "未知状态";
  const snippet = last.snippet ? `：${last.snippet}` : "（空响应）";
  throw new AuthenticationError(
    `Apple 认证服务暂不可用（${statusText}${snippet}）。` +
      "Apple 近期对第三方登录限流，连续快速请求会被拒绝；请等待 1-2 分钟后再试。"
  );
}

// 局部 require 避免循环依赖（cookies 为纯 JS 模块）。
function cookieLibMerge(existing, setCookieHeaders, originUrl) {
  const cookieLib = require("../lib/cookies");
  return cookieLib.extractAndMergeCookies(setCookieHeaders, existing, originUrl);
}

module.exports = {
  authenticate,
  AuthenticationError,
  extractLoginPlist,
  buildLoginBody,
  resolveRedirectLocation,
};
