// iOS StoreServices 原始请求体签名器。
//
// 登录 XML 继续使用内置 WASM；Purchase DAAP 的表单和 DMAP 必须签真实
// NSData。iOS 13+ 的 StoreServices 暴露 SSVFairPlaySAPSession，这里只在
// JSBox Runtime 能力和私有类均可用时启用，任何加载失败都安全关闭。

const b64 = require("../lib/b64");
const { errorMessage } = require("../lib/error");

const STORE_SERVICES_BUNDLE = "/System/Library/PrivateFrameworks/StoreServices.framework";
const STORE_SERVICES_BINARY = `${STORE_SERVICES_BUNDLE}/StoreServices`;
const ITUNES_STORE_BUNDLE = "/System/Library/PrivateFrameworks/iTunesStore.framework";
const ITUNES_STORE_BINARY = `${ITUNES_STORE_BUNDLE}/iTunesStore`;
// Purchase DAAP must not leave the UI spinning while a private StoreServices
// callback is unavailable on a device. XML login keeps its own longer timeout;
// this signer is only used for raw form/DMAP purchase requests.
const SIGN_TIMEOUT_SECONDS = 18;

let checked = false;
let session = null;
let unavailableReason = "";
let queue = Promise.resolve();
const pendingBlocks = new Set();

class NativeSapError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "NativeSapError";
    if (cause) this.cause = cause;
  }
}

function hasRuntime() {
  return (
    typeof $objc === "function" &&
    typeof $block === "function" &&
    typeof $data === "function"
  );
}

function tryLoadBundle(bundlePath) {
  try {
    const bundle = $objc("NSBundle").invoke("bundleWithPath:", bundlePath);
    if (bundle) bundle.invoke("load");
  } catch (_e) {}
}

function tryDlopen(binaryPath) {
  try {
    if (typeof dlopen !== "function" && typeof $defc === "function") {
      $defc("dlopen", "void *, char *, int");
    }
    if (typeof dlopen === "function") dlopen(binaryPath, 1);
  } catch (_e) {}
}

function loadPrivateFrameworks() {
  tryLoadBundle(STORE_SERVICES_BUNDLE);
  tryDlopen(STORE_SERVICES_BINARY);
  // iTunesStore 为 SSVFairPlaySAPSession 注入 sharedDefaultSession，使用
  // App Store 自己的 URL bag。加载失败时仍可回退到 StoreServices 的 init。
  tryLoadBundle(ITUNES_STORE_BUNDLE);
  tryDlopen(ITUNES_STORE_BINARY);
}

function createSession() {
  if (checked) return session;
  checked = true;
  if (!hasRuntime()) {
    unavailableReason = "当前 JSBox 缺少 Objective-C Runtime 能力";
    return null;
  }

  try {
    loadPrivateFrameworks();
    const sessionClass = $objc("SSVFairPlaySAPSession");
    try {
      session = sessionClass.invoke("sharedDefaultSession");
    } catch (_e) {
      session = sessionClass.invoke("alloc.init");
    }
    if (!session) throw new Error("SSVFairPlaySAPSession 不可用");
    if (typeof $objc_retain === "function") $objc_retain(session);
    return session;
  } catch (error) {
    session = null;
    unavailableReason = `无法加载 iOS StoreServices SAP 会话：${errorMessage(error)}`;
    return null;
  }
}

function isAvailable() {
  return !!createSession();
}

function availabilityReason() {
  createSession();
  return unavailableReason || "";
}

function objcText(value) {
  if (!value) return "";
  try {
    const description = value.invoke("localizedDescription");
    return String(description && typeof description.jsValue === "function"
      ? description.jsValue()
      : description || "");
  } catch (_e) {
    try {
      return String(typeof value.jsValue === "function" ? value.jsValue() : value);
    } catch (_ignored) {
      return "";
    }
  }
}

function signatureBase64(value) {
  if (!value) return "";
  if (Array.isArray(value.byteArray)) return b64.base64Encode(value.byteArray);
  try {
    const encoded = value.invoke("base64EncodedStringWithOptions:", 0);
    const text = encoded && typeof encoded.jsValue === "function"
      ? encoded.jsValue()
      : encoded;
    if (text) return String(text);
  } catch (_e) {}
  try {
    const converted = typeof value.jsValue === "function" ? value.jsValue() : value;
    if (converted && Array.isArray(converted.byteArray)) {
      return b64.base64Encode(converted.byteArray);
    }
  } catch (_e) {}
  return "";
}

function signOnce(bytes) {
  const activeSession = createSession();
  if (!activeSession) {
    return Promise.reject(
      new NativeSapError(availabilityReason() || "iOS StoreServices SAP 会话不可用")
    );
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let timeout = null;
    let completion = null;
    const finish = (error, signature) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (completion) pendingBlocks.delete(completion);
      if (error) reject(error);
      else resolve(signature);
    };

    try {
      const data = $data({ byteArray: bytes });
      const nativeData = data && typeof data.ocValue === "function" ? data.ocValue() : data;
      completion = $block("void, NSData *, NSError *", (signature, error) => {
        const errorText = objcText(error);
        if (errorText) {
          finish(new NativeSapError(`系统 SAP 签名失败：${errorText}`));
          return;
        }
        const encoded = signatureBase64(signature);
        if (!encoded) {
          finish(new NativeSapError("系统 SAP 签名返回空结果"));
          return;
        }
        finish(null, encoded);
      });
      pendingBlocks.add(completion);
      timeout = setTimeout(
        () => finish(
          new NativeSapError(
            `系统 SAP 原始请求体签名超时（${SIGN_TIMEOUT_SECONDS} 秒），当前 JSBox/iOS 可能不支持已购接口签名，请稍后重试`
          )
        ),
        SIGN_TIMEOUT_SECONDS * 1000
      );
      activeSession.invoke("signData:completionBlock:", nativeData, completion);
    } catch (error) {
      finish(new NativeSapError(`无法调用系统 SAP 签名器：${errorMessage(error)}`, error));
    }
  });
}

function sign(bytes) {
  const list = Array.isArray(bytes) ? bytes.map((value) => Number(value) & 0xff) : [];
  if (!list.length) return Promise.reject(new NativeSapError("待签名请求体为空"));
  const operation = queue.then(() => signOnce(list));
  queue = operation.catch(() => {});
  return operation;
}

module.exports = {
  isAvailable,
  availabilityReason,
  sign,
  NativeSapError,
  SIGN_TIMEOUT_SECONDS,
  STORE_SERVICES_BUNDLE,
  ITUNES_STORE_BUNDLE,
};
