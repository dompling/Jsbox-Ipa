// 下载编排：尝试现有许可；仅缺少许可时获取免费许可，再下载并验证入库。

const http = require("../lib/http");
const purchase = require("../apple/purchase");
const download = require("../apple/download");
const store = require("../apple/store");
const accounts = require("../store/accounts");
const library = require("../store/library");
const format = require("../lib/format");
const cookieLib = require("../lib/cookies");
const ipaValidator = require("./ipa-validator");
const urlUtil = require("../lib/url");
const { errorMessage } = require("../lib/error");
const diag = require("../lib/diag");
const session = require("../apple/session");
const streamDownload = require("./stream-download");
const queue = require("./queue");
const ipaInjector = require("./ipa-injector");
const { createCancellation, assertActive, isCancelled, DownloadCancelledError } = require("../lib/cancellation");
const MIN_IPA_BYTES = 4096;
const ICON_TIMEOUT_SECONDS = 15;
const inFlight = new Map();

// 尽力清理 stageDownloadedData 落下的临时文件；文件已被移走时静默忽略。
function removeStagedFile(path) {
  if (!path) return;
  try {
    if (typeof $file !== "undefined" && $file && $file.exists && $file.exists(path)) {
      $file.delete(path);
    }
  } catch (_e) {}
}

// 将接口返回的 cookies 变更写回账号存储（登录/下载过程会刷新 cookie）。
function persistAccount(account, updatedCookies) {
  if (!updatedCookies) return account;
  const stored = accounts.getAccount(account.email);
  if (stored) {
    const cookies = cookieLib.mergeCookies(stored.cookies || [], updatedCookies);
    const updated = accounts.saveAccount(Object.assign({}, stored, { cookies }));
    // 后续购买 -> 下载必须使用本次请求刚刷新的 Cookie，不能继续拿旧快照。
    account.cookies = updated.cookies;
    return updated;
  }
  account.cookies = updatedCookies;
  return account;
}

function secureDownloadUrl(raw) {
  const parsed = urlUtil.parse(String(raw || ""));
  if (!parsed) throw new Error("下载地址无效");
  if (parsed.protocol !== "https:") throw new Error("IPA 下载必须使用 HTTPS");
  if (parsed.username || parsed.password) throw new Error("IPA 下载地址不能包含凭据");
  return parsed.toString();
}

function plainByteArray(data) {
  if (Array.isArray(data)) return data;
  try {
    if (data && Array.isArray(data.byteArray)) return data.byteArray;
  } catch (_e) {}
  return null;
}

// App 对象的图标 URL 优先级：100px 缩略图（可升级到 512px）> 通用图 > 兜底。
// 只接受 HTTPS，避免把任意 scheme 交给 $http。
function iconSourceOf(app) {
  const raw = String(
    (app && (app.artworkUrl100 || app.artworkUrl || app.icon)) || ""
  ).trim();
  if (!/^https:\/\//i.test(raw)) return "";
  return raw.indexOf("100x100") >= 0 ? raw.replace(/100x100/, "512x512") : raw;
}

// 图标必须是图片字节：优先看 content-type，拿不到可靠类型时再看魔数。
// 既不认识类型也没有字节头（例如 JSBox 原生 $data 不暴露 byteArray）
// 时按失败处理，宁可不用图标也不要把 HTML 存成 .icon。
function looksLikeIconBytes(data, contentType) {
  const type = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (/^image\//.test(type)) return true;
  const bytes = plainByteArray(data);
  if (!bytes || bytes.length < 12) return false;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return true;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return true;
  }
  return false;
}

// 下载完成后 best-effort 保存图标 sidecar：网络失败、类型不符或写盘失败
// 都不回滚 IPA，只记录诊断，列表随后自动回退到默认占位图标。
async function saveAppIcon(fileName, app) {
  const url = iconSourceOf(app);
  if (!url) return;
  try {
    const res = await http.send({
      method: "GET",
      url,
      // 按二进制下载取回，避免 JSBox 把图片字节当文本解析。
      download: true,
      showsProgress: false,
      timeout: ICON_TIMEOUT_SECONDS,
    });
    if (res.failed || res.status < 200 || res.status >= 300) return;
    const data = res.rawData !== undefined && res.rawData !== null
      ? res.rawData
      : res.data;
    if (data === undefined || data === null) return;
    if (!looksLikeIconBytes(data, res.headers && res.headers["content-type"])) return;
    library.saveIcon(fileName, data);
  } catch (_e) {
    diag.record({ area: "download", step: "icon-skip", url: url.slice(0, 160) });
  }
}

function canStructurallyValidateIpa() {
  return (
    typeof $file !== "undefined" &&
    $file &&
    typeof $file.write === "function" &&
    typeof $file.exists === "function" &&
    typeof $archiver !== "undefined" &&
    $archiver &&
    typeof $archiver.unzip === "function"
  );
}

function looksLikeZipBytes(bytes) {
  if (!bytes || bytes.length < 22) return false;
  if (
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return false;
  }
  // EOCD 最多可在末尾 65557 字节内（22 字节记录 + 65535 字节注释）。
  const start = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return true;
    }
  }
  return false;
}

function validateDownloadResponse(res, observedBytes) {
  if (!res || res.failed) {
    throw new Error(`下载失败: ${errorMessage(res && res.error)}`);
  }
  const status = Number(res.status) || 0;
  if (status < 200 || status >= 300) throw new Error(`下载失败: HTTP ${status || "未知"}`);
  secureDownloadUrl(res.finalUrl);
  if (!res.rawData) throw new Error("下载失败: 响应中没有 IPA 数据");

  const contentType = String((res.headers && res.headers["content-type"]) || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/x-plist"
  ) {
    throw new Error(`下载失败: 返回了错误的内容类型 ${contentType}`);
  }

  // 单测和普通 JS 数据可廉价检查 ZIP 魔数；JSBox 原生 $data 不转成完整
  // byteArray，避免为大 IPA 再制造一份巨型 JS 数组。
  const bytes = plainByteArray(res.rawData);
  if (bytes && !looksLikeZipBytes(bytes)) {
    throw new Error("下载失败: 响应不是有效的 ZIP/IPA 数据");
  }
  const expected =
    Number(res.expectedContentLength) ||
    Number(res.headers && res.headers["content-length"]) ||
    0;
  const observed = Number(observedBytes) || 0;
  if (expected > 0 && observed > 0 && observed < expected) {
    throw new Error(`下载失败: 文件不完整（${observed}/${expected} 字节）`);
  }
  const size = observed > 0 ? observed : bytes ? bytes.length : expected > 0 ? expected : 0;
  if (size < MIN_IPA_BYTES) {
    throw new Error("下载失败: IPA 大小为空或明显异常");
  }
  // 原生 JSBox `$data` 可能不暴露 byteArray。若当前运行时也没有
  // `$archiver` 可在落盘后校验 Payload，就必须拒绝未知内容，不能仅凭
  // Content-Length 把 HTML/截断数据当作 IPA 入库。
  if (!bytes && !canStructurallyValidateIpa()) {
    throw new Error("下载失败: 当前运行时无法验证 IPA 数据");
  }
  return { data: res.rawData, size };
}

function accountRegion(account) {
  return String(accounts.accountRegion(account) || "").toUpperCase();
}

function assertOriginalAccount(account, email, region) {
  if (!email) throw new Error("下载账号无效，请重新登录");
  if (
    accounts.normalizeEmail(account && account.email) !== email ||
    accountRegion(account) !== region
  ) {
    throw new Error("下载账号或区域已变化，请重新选择账号和商店后重试");
  }
}

async function freeAppForLicense(account, app) {
  let resolved = app;
  const price = store.normalizePrice(app.price);
  // 已购列表为展示写入的 price:0 不一定是商店真实价格。服务器说无许可
  // 时先核实当前账号区域的价格，不能用旧 owned 标记为另一个账号获取。
  if (price === null || (price === 0 && app.owned === true)) {
    const region = accountRegion(account);
    if (!/^[A-Z]{2}$/.test(region)) {
      throw new purchase.PurchaseError("无法确认账号区域，请重新登录后再获取许可", "price_unknown");
    }
    let found;
    try {
      found = await store.lookupByIds([app.id], region);
    } catch (_err) {
      throw new purchase.PurchaseError("无法确认该 App 免费，请在 App Store 查看后重试", "price_unknown");
    }
    resolved = Array.isArray(found) && found.find(item => String(item.id) === String(app.id));
    if (!resolved || (app.bundleID && resolved.bundleID !== app.bundleID)) {
      throw new purchase.PurchaseError("无法确认此 App 的商店信息，请在 App Store 查看后重试", "price_unknown");
    }
  }
  purchase.assertFreePrice(resolved.price);
  return resolved;
}

async function getLicensedDownloadInfo(account, app, externalVersionId, licensing, options) {
  const state = licensing || { attempted: false };
  const request = async () => {
    download.assertVersionListContinues(options, account.cookies);
    let info;
    try {
      info = await download.getDownloadInfo(account, app, externalVersionId, options);
    } catch (err) {
      persistAccount(account, err.updatedCookies);
      download.assertVersionListContinues(options, account.cookies);
      throw err;
    }
    persistAccount(account, info.updatedCookies);
    download.assertVersionListContinues(options, account.cookies);
    return info;
  };
  try {
    return await request();
  } catch (err) {
    if (String(err.code) !== "9610" || state.attempted) throw err;
  }
  download.assertVersionListContinues(options, account.cookies);
  const freeApp = await freeAppForLicense(account, app);
  download.assertVersionListContinues(options, account.cookies);
  state.attempted = true;
  try {
    const result = await purchase.purchaseApp(account, freeApp, options);
    persistAccount(account, result.updatedCookies);
  } catch (err) {
    persistAccount(account, err.updatedCookies);
    download.assertVersionListContinues(options, account.cookies);
    throw err;
  }
  download.assertVersionListContinues(options, account.cookies);
  return request();
}

function listVersions(account, app, options) {
  const email = accounts.normalizeEmail(account && account.email);
  const region = accountRegion(account);
  const licensing = { attempted: false };
  return session.withFreshSession(account, async (acc) => {
    download.assertVersionListContinues(options, acc.cookies);
    assertOriginalAccount(acc, email, region);
    try {
      const info = await getLicensedDownloadInfo(acc, app, undefined, licensing, options);
      const result = await download.listVersions(acc, app, info, options);
      persistAccount(acc, result.updatedCookies);
      download.assertVersionListContinues(options, acc.cookies);
      return result;
    } catch (err) {
      persistAccount(acc, err.updatedCookies);
      // 必须在 withFreshSession 收到 2034/2042 之前转成非登录错误。
      download.assertVersionListContinues(options, acc.cookies);
      throw err;
    }
  });
}

async function fetchIpaData(info, message, onProgress, options) {
  const downloadUrl = secureDownloadUrl(info.downloadURL);
  const opts = options || {};
  assertActive(opts.cancellation);
  let observedBytes = 0;
  const res = await http.send({
    method: "GET",
    url: downloadUrl,
    download: true,
    cancellation: opts.cancellation,
    // 列表/详情页把真实字节进度显示在当前 App 的获取胶囊里；
    // 同时开启 JSBox 的全局下载浮层会遮住页面并造成两个进度状态。
    // 没有局部回调的历史版本下载仍保留系统进度提示。
    showsProgress: opts.showNativeProgress === undefined
      ? typeof onProgress !== "function"
      : !!opts.showNativeProgress,
    message: message || "正在下载 IPA…",
    progress: (written, total) => {
      if (opts.cancellation && opts.cancellation.cancelled) return;
      const count = Number(written) || 0;
      if (count > observedBytes) observedBytes = count;
      if (onProgress) onProgress(written, total);
    },
    backgroundFetch: true,
  });
  assertActive(opts.cancellation);
  if (!res.finalUrl) res.finalUrl = downloadUrl;
  return validateDownloadResponse(res, observedBytes);
}

async function downloadToLibrary(account, app, externalVersionId, options) {
  const opts = options || {};
  const downloadAccountEmail = accounts.normalizeEmail(account && account.email);
  const cancellation = opts.cancellation;
  assertActive(cancellation);
  const onProgress = opts.onProgress;
  const taskId = opts.queueTaskId;
  function report(patch) {
    if (cancellation && cancellation.cancelled) return;
    if (taskId === undefined || taskId === null) return;
    queue.update(taskId, patch);
  }
  // 把下载字节进度同时转发给页面胶囊和下载页任务行；总大小未知时
  // 停留在“下载中”并只显示已接收字节数。
  const wrappedProgress = (written, total) => {
    if (cancellation && cancellation.cancelled) return;
    if (typeof onProgress === "function") onProgress(written, total);
    const received = Number(written) || 0;
    const expected = Number(total) || 0;
    report({
      status: "downloading",
      progress: expected > 0 ? 0.06 + 0.86 * Math.min(1, received / expected) : 0.1,
      downloadProgress: expected > 0 ? Math.min(1, received / expected) : null,
      message:
        expected > 0
          ? `正在下载 · ${format.formatBytes(received)} / ${format.formatBytes(expected)}`
          : `正在下载 · 已接收 ${format.formatBytes(received)}`,
    });
  };
  report({
    status: "preparing",
    progress: 0.02,
    message: `正在获取 ${app.name} 的下载信息…`,
  });
  const continuation = cancellation
    ? Object.assign({}, opts, { shouldContinue: () => !cancellation.cancelled })
    : opts;
  const info = await getLicensedDownloadInfo(account, app, externalVersionId, opts.licensing, continuation);
  assertActive(cancellation);
  const requestedVersion = String(externalVersionId === undefined || externalVersionId === null ? "" : externalVersionId);
  const historical = !!requestedVersion;
  const message = `${app.name} ${historical ? `历史版本 ${requestedVersion}` : info.bundleShortVersionString || "最新版"}`;
  report({
    status: "downloading",
    progress: 0.06,
    message: `正在下载 ${message}…`,
  });

  // 先拿到一个已落盘的唯一临时文件路径（可能来自 Range 分块下载，也可能是
  // 整包下载后立即写盘），随后从磁盘解压校验、把同一份文件移入下载库。
  // 大包优先走内存有界的分块下载：整包 $http.download 会把几百 MB 载入内存，
  // 下载到 99% 后做校验/入库时容易 OOM 闪退。
  let stagedPath = "";
  let fileSize = 0;
  let kind = "full";
  try {
    const chunked = await streamDownload.tryChunkedDownload(info, wrappedProgress, opts);
    // 先接管分段合并文件，再检查取消，确保任何退出路径都会清理它。
    if (chunked && chunked.ok) stagedPath = chunked.path;
    assertActive(cancellation);
    if (chunked && chunked.fatal) throw new Error(chunked.reason || "分段下载失败，请重试");
    if (chunked && chunked.ok) {
      fileSize = Number(chunked.size) || 0;
      kind = "chunked";
    } else {
      const fetched = await fetchIpaData(info, message, wrappedProgress, opts);
      assertActive(cancellation);
      fileSize = Number(fetched.size) || 0;
      stagedPath = ipaValidator.stageDownloadedData(fetched.data);
      // stage 已完成写盘，释放大 $data 引用。
      fetched.data = null;
    }
    diag.record({
      area: "download",
      step: kind === "chunked" ? "chunked-staged" : "full-staged",
      size: fileSize,
      chunkedFallback: kind === "full" && chunked && !chunked.ok ? chunked.reason || "" : "",
    });
    report({ status: "verifying", progress: 0.95, message: "下载完成，正在校验安装包…" });
    const expectedBundle = app.bundleID || (info.metadata && info.metadata.softwareVersionBundleId) || "";
    const packageVerification = await ipaValidator.validateDownloadedFile(stagedPath, {
      bundleId: expectedBundle,
    });
    assertActive(cancellation);
    const readable = packageVerification.metadataReadable === true;
    const shortVersion = String(readable ? packageVerification.shortVersion || "" : historical ? "" : info.bundleShortVersionString || "");
    const bundleVersion = String(readable ? packageVerification.bundleVersion || "" : historical ? "" : info.bundleVersion || "");
    const versionSource = readable ? "ipa" : !historical && (shortVersion || bundleVersion) ? "api" : "unknown";
    const versionLabel = shortVersion || (readable && bundleVersion ? `构建 ${bundleVersion}` : "版本号未知");
    const meta = {
      name: format.sanitizeFileName(`${app.name} ${versionLabel}`),
      appId: app.id,
      bundleId: readable ? packageVerification.bundleId || expectedBundle : expectedBundle,
      title: app.name,
      accountEmail: downloadAccountEmail,
      version: versionLabel,
      shortVersion,
      bundleVersion,
      requestedExternalVersionId: requestedVersion,
      externalVersionId: String(info.externalVersionId || ""),
      metadataVerified: packageVerification.metadataVerified === true,
      versionSource,
      size: fileSize,
    };
    const artifacts = ipaValidator.normalizeArtifacts(
      info.sinfs,
      info.iTunesMetadataBase64
    );
    diag.record({
      area: "download",
      step: "verified-from-disk",
      verified: !!packageVerification.verified,
    });
    const baseMeta = Object.assign({}, meta, {
      packageVerified: !!packageVerification.verified,
      packageAppPath: packageVerification.appPath || "",
      sinfs: artifacts.sinfs,
      iTunesMetadataBase64: artifacts.iTunesMetadataBase64,
      sinfInjected: false,
    });

    // 第一步：先保存未注入的原始包。这样即使后续注入失败，归档里
    // 也始终有一份可以分享、或点按“修复授权（重新注入 SINF）”再次尝试
    // 的原包，不会让一次授权失败把整个下载拖回不可用状态。
    report({ status: "saving", progress: 0.97, message: "正在保存原始安装包…" });
    assertActive(cancellation);
    if (typeof opts.onCommit === "function") opts.onCommit();
    const record = library.saveDownloadedFile(stagedPath, baseMeta);
    // 原始包已 move 入库，不再由本流程负责清理。
    stagedPath = "";
    report({ status: "verifying", progress: 0.98, message: "原始安装包已保存" });
    diag.record({
      area: "download",
      step: "committed",
      fileName: record.fileName || "",
    });
    // 图标不阻塞下载完成回调：入库成功后异步取图并写 sidecar，
    // 失败只记诊断，不会让下载按钮卡在收尾阶段。
    saveAppIcon(record.fileName, app);

    // 第二步：用刚入库的原始包自动生成“已注入授权”的副本。Apple 下载
    // 信息里带有当前 Apple ID 的 SINF/iTunesMetadata，写回后分享/OTA 出去
    // 就是带授权的包。注入失败不阻塞下载：原始包保留，可稍后再次尝试。
    const injectable =
      !!packageVerification.verified &&
      artifacts.sinfs.length > 0 &&
      ipaInjector.canRezip();
    let injectedRecord = null;
    let injectFailed = "";
    if (injectable) {
      report({
        status: "injecting",
        progress: 0.985,
        message: "正在生成已注入授权的副本…",
      });
      try {
        const injected = await ipaInjector.injectAndSave(record, {
          progress: (message) => {
            report({ status: "injecting", progress: 0.985, message });
          },
        });
        injectedRecord = injected.record;
        diag.record({
          area: "download",
          step: "sinf-injected",
          fileName: injectedRecord.fileName || "",
          sinfWrites: injected.sinfWrites,
          metadataInjected: injected.metadataInjected,
          source: injected.source,
        });
        saveAppIcon(injectedRecord.fileName, app);
      } catch (err) {
        injectFailed = String((err && err.message) || err).slice(0, 300);
        diag.record({
          area: "download",
          step: "sinf-inject-failed",
          fileName: record.fileName || "",
          message: injectFailed,
        });
      }
    } else if (artifacts.sinfs.length > 0) {
      diag.record({
        area: "download",
        step: "sinf-inject-skipped",
        fileName: record.fileName || "",
        reason: packageVerification.verified
          ? "当前运行时不支持重新打包"
          : "IPA 结构校验未通过",
      });
    }

    report({
      status: "verifying",
      progress: 1,
      message: injectedRecord ? "原始包与授权副本均已保存" : "已保存到归档",
    });
    // UI 只需要本地记录；不要把 SINF、iTunesMetadata 与刷新后的 Cookie
    // 长时间挂在返回对象上。record 优先指向注入副本，注入失败时回落到
    // 未注入的原始包；original 始终指向被保留的原始包。
    return {
      record: injectedRecord || record,
      original: record,
      injected: !!injectedRecord,
      injectFailed,
    };
  } finally {
    removeStagedFile(stagedPath);
  }
}

function startDownload(account, app, externalVersionId, options) {
  const opts = options || {};
  const email = accounts.normalizeEmail(account && account.email);
  const region = String(opts.region || accountRegion(account)).toUpperCase();
  const version = String(externalVersionId === undefined || externalVersionId === null ? "" : externalVersionId);
  const key = JSON.stringify([email, region, String(app.id), version]);
  const existing = inFlight.get(key);
  if (existing) {
    if (typeof opts.onProgress === "function") {
      existing.listeners.add(opts.onProgress);
      if (existing.progress && !existing.cancellation.cancelled) {
        try { opts.onProgress(...existing.progress); } catch (_err) {}
      }
    }
    notifyTask(opts, existing.control);
    if (opts.retryTaskId && opts.retryTaskId !== existing.task.id) queue.remove(opts.retryTaskId);
    return existing.promise;
  }
  const retry = opts.retryTaskId && queue.snapshot().find(task => task.id === opts.retryTaskId);
  const task = retry || queue.begin({
    app, region, externalVersionId: version, accountEmail: email,
  });
  const entry = {
    task, listeners: new Set(), progress: null, promise: null,
    cancellation: createCancellation(), committed: false, settled: false,
  };
  entry.control = {
    id: task.id,
    name: task.app.name,
    canCancel: () => !entry.settled && !entry.committed && !entry.cancellation.cancelled,
    cancel: () => entry.control.canCancel() && cancelDownload(task.id),
    subscribe: listener => entry.cancellation.subscribe(listener),
  };
  if (typeof opts.onProgress === "function") entry.listeners.add(opts.onProgress);
  const onProgress = (written, total) => {
    if (entry.cancellation.cancelled || entry.settled) return;
    entry.progress = [written, total];
    for (const listener of entry.listeners) {
      try { listener(written, total); } catch (_err) {}
    }
  };
  inFlight.set(key, entry);
  queue.update(task.id, {
    status: "preparing",
    cancellable: true,
    progress: 0.01,
    downloadProgress: null,
    message: `准备下载 ${app.name}…`,
  });
  const licensing = { attempted: false };
  // 微任务启动前已注册任务与 Promise，多个页面可立即加入同一条下载。
  entry.promise = Promise.resolve().then(() => {
    assertActive(entry.cancellation);
    return session.withFreshSession(account, async (acc) => {
      assertActive(entry.cancellation);
      assertOriginalAccount(acc, email, region);
      try {
        return await downloadToLibrary(acc, app, version || undefined, Object.assign({}, opts, {
          onProgress, licensing, queueTaskId: task.id, cancellation: entry.cancellation,
          onCommit: () => {
            assertActive(entry.cancellation);
            entry.committed = true;
            queue.update(task.id, { cancellable: false });
          },
        }));
      } catch (err) {
        // Cookie 已由下载信息/许可层持久化；取消不能再进入自动重登分支。
        assertActive(entry.cancellation);
        throw err;
      }
    });
  }).then(result => {
    entry.settled = true;
    queue.finish(task.id);
    return result;
  }, err => {
    entry.settled = true;
    if (entry.cancellation.cancelled || isCancelled(err)) {
      queue.remove(task.id);
      throw new DownloadCancelledError();
    }
    queue.fail(task.id, err);
    throw err;
  }).finally(() => {
    inFlight.delete(key);
    entry.listeners.clear();
  });
  notifyTask(opts, entry.control);
  return entry.promise;
}

function notifyTask(options, control) {
  if (typeof options.onTask === "function") {
    try { options.onTask(control); } catch (_err) {}
  }
}

function downloadControl(taskId) {
  for (const entry of inFlight.values()) {
    if (entry.task.id === taskId) return entry.control;
  }
  return null;
}

function canCancelDownload(taskId) {
  const control = downloadControl(taskId);
  return !!control && control.canCancel();
}

function cancelDownload(taskId) {
  for (const entry of inFlight.values()) {
    if (entry.task.id !== taskId || !entry.control.canCancel()) continue;
    entry.cancellation.cancel();
    queue.update(taskId, { status: "cancelling", message: "正在取消…", cancellable: false });
    return true;
  }
  return false;
}

function downloadLatest(account, app, options) {
  return startDownload(account, app, undefined, options);
}

function downloadVersion(account, app, externalVersionId, options) {
  return startDownload(account, app, externalVersionId, options);
}

function retryDownload(task) {
  try {
    const account = accounts.getAccount(task && task.accountEmail);
    if (!account) throw new Error("原下载账号已删除或不可用，请重新添加该账号后重试");
    if (accountRegion(account) !== task.region) throw new Error("原下载账号区域已变化，请重新选择 App");
    return startDownload(account, task.app, task.externalVersionId, {
      region: task.region, retryTaskId: task.id,
    });
  } catch (err) {
    if (task) queue.fail(task.id, err);
    return Promise.reject(err);
  }
}

module.exports = {
  listVersions,
  retryDownload,
  downloadControl,
  canCancelDownload,
  cancelDownload,
  downloadToLibrary,
  downloadLatest,
  downloadVersion,
  persistAccount,
  secureDownloadUrl,
  validateDownloadResponse,
  looksLikeZipBytes,
  fetchIpaData,
  canStructurallyValidateIpa,
  iconSourceOf,
  looksLikeIconBytes,
  saveAppIcon,
};
