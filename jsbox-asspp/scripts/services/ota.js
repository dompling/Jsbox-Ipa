// 实验性 OTA 安装服务：JSBox 内启动本地 HTTP 服务，提供 manifest + IPA。
// 现代 iOS 通常要求可信 HTTPS，因此 UI 必须先展示限制并提供“分享 IPA”退路。

const otaLib = require("../lib/ota-manifest");
const format = require("../lib/format");
const library = require("../store/library");
const settings = require("../store/settings");

const HOST = "localhost";
// IPA-Tool-3.0 的 Plist 服务会把 IPA 指向 localhost:8000；端口必须固定，
// 随机端口会让远端清单拿到一个永远不存在的文件地址。
const PORT = 8000;
const SESSION_TTL_SECONDS = 15 * 60;
// 部分 JSBox/iOS 版本在本地网络权限弹窗或系统繁忙时，$server 的启动回调
// 会明显晚于 4 秒；固定端口下旧会话未释放时绑定也会静默失败。因此启动
// 阶段给足等待时间、允许一次重试，并先探测端口占用情况。
const START_TIMEOUT_SECONDS = 8;
const START_ATTEMPTS = 2;
const START_RETRY_DELAY_MS = 400;
const STOP_SETTLE_STEP_MS = 200;
const STOP_SETTLE_MAX_MS = 1000;
const SELF_PROBE_INTERVAL_SECONDS = 1;
const PROBE_PATH = "/__jasspp_ota_probe__";

let activeServer = null;
let startGeneration = 0;

function sessionToken() {
  return `${format.generateDeviceId()}${format.generateDeviceId()}`;
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
  return candidate.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function stopActive() {
  startGeneration++;
  if (!activeServer) return;
  const handle = activeServer;
  activeServer = null;
  try {
    handle.stop();
  } catch (_e) {}
}

// $delay 在 JSBox 中是主线程定时器；Node 单测里没有该全局时退回
// setTimeout。返回带 cancel 的句柄，settled 后清理挂起回调。
function schedule(seconds, callback) {
  if (typeof $delay === "function") {
    let timer = null;
    try {
      timer = $delay(seconds, callback);
    } catch (_e) {}
    return {
      cancel: () => {
        try {
          if (timer && typeof timer.invalidate === "function") timer.invalidate();
        } catch (_e) {}
      },
    };
  }
  const id = setTimeout(callback, Math.max(0, seconds * 1000));
  return { cancel: () => clearTimeout(id) };
}

function sleep(ms) {
  return new Promise((resolve) => {
    if (typeof $delay === "function") $delay(Math.max(0, ms) / 1000, resolve);
    else setTimeout(resolve, Math.max(0, ms));
  });
}

// 同一次安装（同一文件/包名/版本）再次触发时复用正在运行的服务，
// 避免在固定端口 8000 上重复绑定自相冲突。
function isSameRequest(handle, normalized) {
  const prev = handle && handle.request;
  if (!prev) return false;
  return (
    prev.fileName === normalized.fileName &&
    prev.bundleId === normalized.bundleId &&
    prev.version === normalized.version &&
    prev.title === normalized.title
  );
}

// 探测 8000 是否已有 HTTP 服务在监听：有响应（任意状态码）即视为占用。
// 刚 stop 的旧服务会短暂返回 404，因此由 portIsFreeAfterSettle 循环等待。
function probePortBusy(port) {
  if (
    typeof $http === "undefined" ||
    !$http ||
    typeof $http.request !== "function"
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (busy) => {
      if (done) return;
      done = true;
      resolve(busy);
    };
    try {
      $http.request({
        method: "GET",
        url: `http://127.0.0.1:${port}${PROBE_PATH}`,
        timeout: 1,
        handler: (resp) => {
          const status = resp && resp.response && resp.response.statusCode;
          finish(!!status && Number(status) > 0);
        },
      });
    } catch (_e) {
      finish(false);
    }
  });
}

// 在固定窗口内等待端口释放（刚 stop 的旧服务会短暂返回 404）。
// 返回 true 表示端口空闲；超时仍被占用则返回 false，由调用方重试
// 一轮后再判定为外部占用，避免把旧服务自己的延迟释放误报成冲突。
async function portIsFreeAfterSettle(port) {
  const startedAt = Date.now();
  for (;;) {
    if (!(await probePortBusy(port))) return true;
    if (Date.now() - startedAt >= STOP_SETTLE_MAX_MS) return false;
    await sleep(STOP_SETTLE_STEP_MS);
  }
}

function responseHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}

function defaultResponse(statusCode) {
  return {
    type: "default",
    props: { statusCode, headers: responseHeaders() },
  };
}

function isRegularFile(path) {
  if (!$file.exists(path)) return false;
  try {
    return typeof $file.isDirectory !== "function" || !$file.isDirectory(path);
  } catch (_e) {
    return false;
  }
}

function fileResponse(relativePath, contentType) {
  if (!isRegularFile(relativePath)) return defaultResponse(404);
  return {
    type: "file",
    props: {
      path: $file.absolutePath(relativePath),
      contentType: contentType || "application/octet-stream",
      headers: responseHeaders(),
    },
  };
}

function normalizeOptions(options) {
  if (!options || !library.isSafeFileName(options.fileName)) {
    throw new Error("OTA 安装文件名无效");
  }
  return {
    fileName: options.fileName,
    bundleId: otaLib.validateBundleId(options.bundleId),
    version: otaLib.validateVersion(options.bundleVersion || options.version),
    title: String(options.title || options.bundleId || options.fileName).slice(0, 120),
  };
}

function encodePlistMeta(options) {
  // 与 IPA-Tool-3.0 保持同一协议：服务端收到一个经过编码的
  // `name=...&bundleId=...` 参数，再生成 manifest。
  const meta = [
    `name=${String(options.title || "").replace(/[&=]/g, " ")}`,
    `bundleId=${String(options.bundleId || "")}`,
    `displayVersion=${String(options.version || "")}`,
    `fileName=${String(options.fileName || "")}`,
  ].join("&");
  return encodeURIComponent(meta);
}

function buildExternalInstallURL(options) {
  const server = settings.plistServer();
  const separator = server.indexOf("?") >= 0 ? "&" : "?";
  const endpoint = `${server}${separator}${encodePlistMeta(options)}`;
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(endpoint)}`;
}

// options: { fileName, bundleId, bundleVersion?, version?, title }
// 返回 { port, manifestUrl, ipaUrl, itmsUrl, stop }
async function startInstall(options) {
  const normalized = normalizeOptions(options);
  const ipaRelative = library.filePath(normalized.fileName);
  if (!isRegularFile(ipaRelative)) {
    throw new Error(`找不到 IPA 文件：${normalized.fileName}`);
  }
  // 重复触发同一安装时直接复用已运行的服务，不重复绑定 8000。
  if (activeServer && isSameRequest(activeServer, normalized)) {
    return activeServer;
  }
  // 固定端口 8000 上不可能同时存在两个服务：必须先停旧会话释放端口，
  // 再启动新会话。若新会话启动失败，旧安装链接随之失效，但失败时新
  // 链接本来就不会打开，UI 会提示改走“分享 IPA”。
  stopActive();
  const generation = ++startGeneration;
  try {
    const handle = await tryStartOnPort(PORT, normalized, ipaRelative);
    if (generation !== startGeneration) {
      handle.stop();
      throw new Error("OTA 安装请求已被新的请求替代");
    }
    activeServer = handle;
    return handle;
  } catch (err) {
    if (generation !== startGeneration) throw err;
    throw new Error(`无法启动本地安装服务（端口 ${PORT}）：${err.message || err}`);
  }
}

async function tryStartOnPort(port, options, ipaRelative) {
  let lastError = null;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    if (await portIsFreeAfterSettle(port)) {
      try {
        return await startOnce(port, options, ipaRelative);
      } catch (err) {
        lastError = err;
        if (attempt >= START_ATTEMPTS) break;
        // 短暂等待后重试一次：JSBox 的 stop 释放端口可能不是同步完成的。
        await sleep(START_RETRY_DELAY_MS);
        continue;
      }
    }
    lastError = new Error(
      `端口 ${port} 已被其他服务占用。请关闭占用该端口的应用或重启 JSBox 后重试，也可以选择“分享 IPA”。`
    );
    if (attempt >= START_ATTEMPTS) break;
    await sleep(START_RETRY_DELAY_MS);
  }
  throw lastError;
}

function startOnce(port, options, ipaRelative) {
  return new Promise((resolve, reject) => {
    const server = $server.new();
    const token = sessionToken();
    let settled = false;
    let stopped = false;
    let watchdog = null;
    let ttlTimer = null;
    let selfProbeTimer = null;
    let handle = null;

    const base = `http://${HOST}:${port}/${token}`;
    const manifestUrl = `${base}/manifest.plist`;
    const ipaUrl = `${base}/app.ipa`;
    const rootIpaUrl = `http://localhost:${port}/${encodeURIComponent(options.fileName)}`;
    const smallIconUrl = `${base}/icon57.png`;
    const largeIconUrl = `${base}/icon512.png`;
    const localItmsUrl = otaLib.buildItmsUrl(manifestUrl);
    const itmsUrl = buildExternalInstallURL(options);
    const manifestXml = otaLib.buildOtaManifest({
      ipaUrl,
      title: options.title,
      bundleId: options.bundleId,
      version: options.version,
      iconSmallUrl: smallIconUrl,
      iconLargeUrl: largeIconUrl,
    });

    function cancelTimers() {
      if (watchdog) {
        watchdog.cancel();
        watchdog = null;
      }
      if (ttlTimer) {
        ttlTimer.cancel();
        ttlTimer = null;
      }
      if (selfProbeTimer) {
        selfProbeTimer.cancel();
        selfProbeTimer = null;
      }
    }

    // 部分 JSBox 版本可能不派发 didStart：启动后周期性自检 manifest，
    // 能返回 200 说明本地服务实际已在监听，就按启动成功处理。
    function probeSelf() {
      if (
        typeof $http === "undefined" ||
        !$http ||
        typeof $http.request !== "function"
      ) {
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        try {
          $http.request({
            method: "GET",
            url: manifestUrl,
            timeout: 1,
            handler: (resp) => {
              const status = resp && resp.response && resp.response.statusCode;
              resolve(Number(status) === 200);
            },
          });
        } catch (_e) {
          resolve(false);
        }
      });
    }

    function scheduleSelfProbe() {
      if (settled) return;
      selfProbeTimer = schedule(SELF_PROBE_INTERVAL_SECONDS, () => {
        selfProbeTimer = null;
        probeSelf().then((ready) => {
          if (ready) onStarted();
          else if (!settled) scheduleSelfProbe();
        });
      });
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      cancelTimers();
      if (activeServer === handle) activeServer = null;
      try {
        server.stop();
      } catch (_e) {}
    }

    function onStarted() {
      if (settled) return;
      settled = true;
      cancelTimers();
      handle = {
        port,
        token,
        manifestUrl,
        ipaUrl,
        rootIpaUrl,
        localItmsUrl,
        itmsUrl,
        server,
        stop,
        request: options,
      };
      ttlTimer = schedule(SESSION_TTL_SECONDS, stop);
      resolve(handle);
    }

    server.listen({
      didStart: onStarted,
      didStop: () => {
        if (activeServer && activeServer.server === server) activeServer = null;
        if (!settled) {
          settled = true;
          cancelTimers();
          reject(new Error(`端口 ${port} 启动失败，底层服务已停止`));
        }
      },
      didDisconnect: () => {},
      didConnect: () => {},
    });

    const allowedPaths = {
      [`/${token}/manifest.plist`]: () => ({
        type: "data",
        props: {
          text: manifestXml,
          contentType: "application/xml; charset=utf-8",
          headers: responseHeaders(),
        },
      }),
      [`/${token}/app.ipa`]: () =>
        fileResponse(ipaRelative, "application/octet-stream"),
      // IPA-Tool-3.0 的远端 Plist 服务固定使用 localhost:8000/<fileName>。
      // 保留 token 路径供本地直连清单使用，同时限制文件名和 loopback 来源。
      [`/${options.fileName}`]: () =>
        fileResponse(ipaRelative, "application/octet-stream"),
      [`/${token}/icon57.png`]: () =>
        fileResponse("assets/icon57.png", "image/png"),
      [`/${token}/icon512.png`]: () =>
        fileResponse("assets/icon512.png", "image/png"),
    };

    server.addHandler({
      filter: () => "data",
      response: (request) => {
        if (!isLoopback(request.remoteAddress)) return defaultResponse(403);
        const method = String(request.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") return defaultResponse(405);
        const path = (request.path || "/").split("?")[0];
        const responder = allowedPaths[path];
        return responder ? responder() : defaultResponse(404);
      },
    });

    try {
      server.start({ port });
    } catch (error) {
      settled = true;
      stop();
      reject(error);
      return;
    }

    // 兜底：START_TIMEOUT_SECONDS 内既没有 didStart/didStop、自检也未
    // 成功，视为失败，并给出可操作的排查提示（本地网络权限 / 端口占用 /
    // 重启 JSBox）。
    watchdog = schedule(START_TIMEOUT_SECONDS, () => {
      if (settled) return;
      settled = true;
      stop();
      reject(
        new Error(
          `端口 ${port} 启动超时（${START_TIMEOUT_SECONDS} 秒内未收到启动回调）。` +
            `请检查 JSBox 的“本地网络”权限、确认没有其他应用占用端口 ${port}，` +
            "并重启 JSBox 后重试；也可以选择“分享 IPA”。"
        )
      );
    });
    scheduleSelfProbe();
  });
}

async function installToDevice(options) {
  const handle = await startInstall(options);
  return openInstallHandle(handle);
}

function openInstallHandle(handle) {
  try {
    const opened = $app.openURL(handle.itmsUrl);
    if (opened === false) throw new Error("系统拒绝打开 OTA 安装链接");
    return handle;
  } catch (err) {
    handle.stop();
    throw err;
  }
}

module.exports = {
  startInstall,
  installToDevice,
  stopActive,
  isLoopback,
  normalizeOptions,
  openInstallHandle,
  buildExternalInstallURL,
  encodePlistMeta,
  PORT,
  SESSION_TTL_SECONDS,
};
