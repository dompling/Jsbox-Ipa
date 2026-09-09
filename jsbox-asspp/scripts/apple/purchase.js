// 获取 App 许可证（免费 App）：
// 对应 ipatool pkg/appstore/appstore_purchase.go 与 ApplePackage
// Sources/ApplePackage/Commands/Purchase.swift。

const config = require("../config");
const http = require("../lib/http");
const plist = require("../lib/plist");
const cookieLib = require("../lib/cookies");
const { errorMessage } = require("../lib/error");
const { normalizePrice } = require("./store");
const { DownloadCancelledError } = require("../lib/cancellation");

class PurchaseError extends Error {
  constructor(message, code, updatedCookies, needsAppStore) {
    super(message);
    this.name = "PurchaseError";
    this.code = code;
    this.updatedCookies = updatedCookies || null;
    this.needsAppStore = !!needsAppStore || ["paid_app", "price_unknown", "2059"].includes(code);
  }
}

function assertPurchaseContinues(options, cookies) {
  if (!options || typeof options.shouldContinue !== "function" || options.shouldContinue() !== false) return;
  const error = new DownloadCancelledError();
  error.updatedCookies = cookies;
  throw error;
}

async function requestPurchase(account, app, pricingParameters, requestCookies, options) {
  assertPurchaseContinues(options, requestCookies || account.cookies);
  const deviceId = account.deviceIdentifier;
  const host = config.purchaseAPIHost(account.pod);
  const path = config.ENDPOINTS.purchasePath;
  const url = `https://${host}${path}`;
  const storeFront = config.storeFrontHeaderFor(account, "-1");

  const payload = plist.buildPlist({
    appExtVrsId: "0",
    hasAskedToFulfillPreorder: "true",
    buyWithoutAuthorization: "true",
    hasDoneAgeCheck: "true",
    guid: deviceId,
    needDiv: "0",
    origPage: `Software-${app.id}`,
    origPageLocation: "Buy",
    price: "0",
    pricingParameters,
    productType: "C",
    salableAdamId: app.id,
  });

  let res;
  try {
    res = await http.sendWithRedirectRecovery(
      {
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/x-apple-plist",
          "iCloud-DSID": account.directoryServicesIdentifier,
          "X-Dsid": account.directoryServicesIdentifier,
          "X-Apple-Store-Front": storeFront,
          "X-Token": account.passwordToken,
        },
        body: payload,
        cookies: requestCookies || account.cookies,
        shouldContinue: options && options.shouldContinue,
      },
      (r) => r.status === 200 && plist.looksLikePlist(r.body),
      2
    );
  } catch (err) {
    throw new PurchaseError(errorMessage(err), err && err.code, requestCookies || account.cookies);
  }

  const updatedCookies = cookieLib.extractAndMergeCookies(
    http.setCookiesFromResponse(res),
    requestCookies || account.cookies,
    res.finalUrl || url
  );
  assertPurchaseContinues(options, updatedCookies);

  if (res.failed) {
    throw new PurchaseError(errorMessage(res.error), "", updatedCookies);
  }
  const statusCode = Number(res.status) || 0;
  const httpOK = statusCode >= 200 && statusCode < 300;
  const httpError = (code) => new PurchaseError(`获取许可失败: HTTP ${statusCode || "未知"}`, code || `HTTP_${statusCode}`, updatedCookies);

  let dict;
  try {
    dict = plist.parsePlist(res.body);
  } catch (err) {
    if (!httpOK) throw httpError();
    throw new PurchaseError(`无法解析购买响应: ${err.message}`, "", updatedCookies);
  }

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage;
    switch (failureType) {
      case "5002":
        // 许可证已存在：视为成功（与 ipatool 行为一致）
        if (!httpOK) throw httpError(failureType);
        return { updatedCookies };
      case "2059":
        throw new PurchaseError(
          "该 App 暂时不可购买（2059）",
          "2059",
          updatedCookies
        );
      case "2034":
      case "2042":
        throw new PurchaseError(
          "登录已过期，请重新登录",
          failureType,
          updatedCookies
        );
      default: {
        if (customerMessage === "Your password has changed.") {
          throw new PurchaseError(
            "密码已更改，请重新登录",
            failureType,
            updatedCookies
          );
        }
        if (customerMessage === "Subscription Required") {
          throw new PurchaseError("需要先在 App Store 确认订阅", failureType, updatedCookies, true);
        }
        const action = dict.action;
        if (action) {
          const actionUrl = action.url || action.URL;
          if (actionUrl && String(actionUrl).endsWith("termsPage")) {
            throw new PurchaseError(
              "需要先同意服务条款（在 Safari 打开 Apple 页面）",
              failureType,
              updatedCookies,
              true
            );
          }
        }
        throw new PurchaseError(
          customerMessage || `购买失败（${failureType}）`,
          failureType,
          updatedCookies,
          true
        );
      }
    }
  }

  if (!httpOK) throw httpError();
  const jingleDocType = dict.jingleDocType;
  const status = dict.status;
  if (jingleDocType !== "purchaseSuccess" || status !== 0) {
    // 5002 = 许可证已存在，视为成功（与 ipatool 行为一致）。
    if (dict.failureType === config.RETRYABLE_FAILURE_TYPE) {
      return { updatedCookies };
    }
    throw new PurchaseError("购买失败：未返回成功状态", "", updatedCookies);
  }
  return { updatedCookies };
}

function assertFreePrice(value) {
  const price = normalizePrice(value);
  if (price === null) throw new PurchaseError("无法确认该 App 免费，请在 App Store 查看后重试", "price_unknown");
  if (price !== 0) throw new PurchaseError("当前账号没有此 App 的许可，请先在 App Store 购买", "paid_app");
}

async function purchaseApp(account, app, options) {
  assertFreePrice(app && app.price);
  try {
    return await requestPurchase(account, app, "STDQ", undefined, options);
  } catch (err) {
    assertPurchaseContinues(options, err.updatedCookies || account.cookies);
    if (err instanceof PurchaseError && err.code === "2059") {
      return await requestPurchase(
        account,
        app,
        "GAME",
        err.updatedCookies || account.cookies,
        options
      );
    }
    throw err;
  }
}

module.exports = {
  assertFreePrice,
  purchaseApp,
  PurchaseError,
};
