// 本地 SINF / iTunesMetadata 注入（第一版，实验性）。
//
// Apple 下载响应会在下载 IPA 的同时返回该账号的 SINF（FairPlay 授权）与
// iTunesMetadata。项目目前只把它们存进 sidecar，OTA 安装的是未注入的
// 原始加密包，因此设备没有该账号授权缓存时安装后无法打开。
//
// 本模块把 sidecar 里的授权数据写回 IPA：
// - Payload/<App>.app/SC_Info/*.sinf（按 Manifest.plist / *.supp 推导路径）
// - 包根目录 iTunesMetadata.plist
//
// JSBox 的 $archiver 只能整体解压 / 压缩，不能原地更新 zip，因此这里采用
// “低内存解压 → 写入授权文件 → 整体重新压缩”的流程，大包会慢且占用临时
// 磁盘空间。后续优化方向：bplist 转换、重新打包后结构复验、更省时的增量
// zip 更新方案。

const b64 = require("../lib/b64");
const plist = require("../lib/plist");
const library = require("../store/library");
const validator = require("./ipa-validator");

const CACHE_DIR = "cache";
const STEP_TIMEOUT_MS = 20 * 60 * 1000;

function nonce() {
  return `${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
}

// 与 IPA-Tool-3.0 一致：SC_Info 里的 .supp 文件名与应写入的 .sinf 同名，
// 版本后缀（.vN）要去掉。例如 `Demo.v3.supp` -> `SC_Info/Demo.sinf`。
function sinfTargetFromSupp(suppName) {
  const raw = String(suppName || "");
  if (!/\.supp$/i.test(raw)) return "";
  const name = raw.replace(/\.supp$/i, "");
  if (!name) return "";
  const stem = name.replace(/\.v\d+$/i, "");
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe ? `SC_Info/${safe}.sinf` : "";
}

// Manifest.plist 的 SinfPaths 通常就是 `SC_Info/<executable>.sinf` 形式；
// 也可能只给文件名。统一收敛成 app 目录下的相对路径，拒绝任何越界输入。
function normalizeSinfRelPath(value) {
  let path = String(value || "").replace(/\\/g, "/").trim();
  if (!path || path.startsWith("/") || path.includes("\0")) return "";
  if (!/\.sinf$/i.test(path)) return "";
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".."
    )
  ) {
    return "";
  }
  if (path.startsWith("SC_Info/")) return path;
  if (segments.length === 1) return `SC_Info/${path}`;
  return "";
}

function sinfTargetFromExecutable(executable) {
  const stem = String(executable || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return stem ? `SC_Info/${stem}.sinf` : "";
}

function readPlistFile(path) {
  try {
    if (typeof $file === "undefined" || !$file.exists(path)) return null;
    const value = $file.read(path);
    const text =
      value && typeof value.string === "string"
        ? value.string
        : value && typeof value.rawData === "string"
          ? value.rawData
          : "";
    if (!text || text.indexOf("<plist") < 0) return null;
    return plist.parsePlist(text);
  } catch (_e) {
    return null;
  }
}

function listEntryNames(dir) {
  if (typeof $file === "undefined" || !$file.exists(dir)) return [];
  if ($file.isDirectory && !$file.isDirectory(dir)) return [];
  if (!$file.list) return [];
  const result = [];
  for (const name of $file.list(dir) || []) {
    const value = String(name || "");
    if (
      !value ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      continue;
    }
    result.push(value);
  }
  return result;
}

// 返回 { targets: [{ relPath, sinf }], source }，targets 的 relPath 都相对
// app 目录（例如 `SC_Info/Demo.sinf`），sinf 为原始 base64。
function planSinfTargets(appDir, sinfs) {
  const items = Array.isArray(sinfs) ? sinfs : [];
  if (!items.length) throw new Error("记录中没有 SINF，无法注入授权");

  const scDir = `${appDir}/SC_Info`;
  if ($file.exists(scDir) && $file.isDirectory(scDir)) {
    const manifestPath = `${scDir}/Manifest.plist`;
    const manifest = $file.exists(manifestPath) ? readPlistFile(manifestPath) : null;
    const paths =
      manifest && Array.isArray(manifest.SinfPaths) ? manifest.SinfPaths : null;
    if (paths && paths.length) {
      const targets = [];
      for (let index = 0; index < items.length; index++) {
        const relPath = normalizeSinfRelPath(paths[index]);
        if (relPath) targets.push({ relPath, sinf: items[index].sinf });
      }
      if (targets.length) return { targets, source: "Manifest.plist" };
    }

    const suppNames = listEntryNames(scDir)
      .filter((name) => /\.supp$/i.test(name))
      .sort();
    if (suppNames.length) {
      const targets = [];
      for (let index = 0; index < Math.min(suppNames.length, items.length); index++) {
        const relPath = sinfTargetFromSupp(suppNames[index]);
        if (relPath) targets.push({ relPath, sinf: items[index].sinf });
      }
      if (targets.length) return { targets, source: "SC_Info/*.supp" };
    }
  }

  const info = readPlistFile(`${appDir}/Info.plist`);
  const executable = info && info.CFBundleExecutable;
  if (typeof executable === "string") {
    const relPath = sinfTargetFromExecutable(executable);
    if (relPath) {
      return { targets: [{ relPath, sinf: items[0].sinf }], source: "Info.plist" };
    }
  }

  throw new Error(
    "无法定位 SINF 写入位置：IPA 中缺少可用的 SC_Info/Manifest.plist、*.supp 或 Info.plist"
  );
}

function dataFromBytes(bytes) {
  if (typeof $data === "function") return $data({ byteArray: bytes });
  return bytes;
}

function dataFromText(text) {
  if (typeof $data === "function") return $data({ string: String(text) });
  return String(text);
}

function writeBytesFile(path, base64Value) {
  const bytes = b64.base64Decode(String(base64Value || "").replace(/\s+/g, ""));
  if (!bytes || !bytes.length) throw new Error("SINF 数据为空或不是有效的 base64");
  if (!$file.write({ path, data: dataFromBytes(bytes) })) {
    throw new Error(`写入 SINF 失败：${path}`);
  }
}

function writeTextFile(path, text) {
  if (!$file.write({ path, data: dataFromText(text) })) {
    throw new Error(`写入文件失败：${path}`);
  }
}

function decodeMetadataText(base64Value) {
  try {
    const text = b64.base64DecodeString(String(base64Value || "").replace(/\s+/g, ""));
    return text && text.indexOf("<plist") >= 0 ? text : "";
  } catch (_e) {
    return "";
  }
}

function writePlannedTargets(appDir, plan) {
  const scDir = `${appDir}/SC_Info`;
  if (!$file.exists(scDir)) validator.ensureDir(scDir);
  for (const target of plan.targets) {
    writeBytesFile(`${appDir}/${target.relPath}`, target.sinf);
  }
  return plan.targets.length;
}

// JSBox 有能力把解压后的目录整体重新打包成 zip 时才能注入；下载流程用
// 它决定是否值得尝试（缺 archiver 时直接跳过，避免白等一轮）。
function canRezip() {
  return (
    typeof $file !== "undefined" &&
    !!$file &&
    typeof $file.exists === "function" &&
    typeof $archiver !== "undefined" &&
    !!$archiver &&
    typeof $archiver.zip === "function"
  );
}

function safeDeleteFile(path) {
  try {
    if (
      typeof $file !== "undefined" &&
      $file &&
      $file.exists &&
      $file.exists(path)
    ) {
      return $file.delete(path) !== false;
    }
  } catch (_e) {}
  return true;
}

function zipDirectory(directory, dest) {
  if (
    typeof $archiver === "undefined" ||
    !$archiver ||
    typeof $archiver.zip !== "function"
  ) {
    throw new Error("当前 JSBox 不支持把注入结果重新打包为 IPA");
  }
  let settled = false;
  let timer = null;
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const done = (value) => {
      if (value === false) finish(new Error("IPA 重新打包失败"));
      else finish(null, value === undefined ? true : value);
    };
    timer = setTimeout(
      () => finish(new Error("IPA 重新打包超时，请清理 cache 后重试")),
      STEP_TIMEOUT_MS
    );
    try {
      const result = $archiver.zip({ directory, dest, handler: done });
      if (result && typeof result.then === "function") {
        result.then(done).catch((error) => finish(error));
      } else if (result !== undefined) {
        done(result);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function appDirectoryPath(extractDir, record) {
  if (record && record.packageAppPath) {
    const rel = String(record.packageAppPath).replace(/^\/+/, "");
    if (/^Payload\/[^/\\]+\.app$/.test(rel)) {
      const candidate = `${extractDir}/${rel}`;
      if (
        $file.exists(candidate) &&
        (!$file.isDirectory || $file.isDirectory(candidate))
      ) {
        return candidate;
      }
    }
  }
  const found = validator.appBundlePath(extractDir);
  if (!found) throw new Error("IPA 缺少唯一的 Payload/*.app 目录");
  return found;
}

function injectedMeta(record) {
  const baseTitle = String(
    record && (record.title || record.fileName.replace(/\.ipa$/i, ""))
  ).trim();
  const version = String((record && record.version) || "").trim();
  const stem = version ? `${baseTitle} ${version}` : baseTitle;
  return {
    name: `${stem} 已注入SINF`,
    appId: String((record && record.appId) || ""),
    bundleId: String((record && record.bundleId) || ""),
    title: `${baseTitle}（已注入SINF）`,
    accountEmail: String((record && record.accountEmail) || ""),
    version,
    shortVersion: String((record && record.shortVersion) || ""),
    bundleVersion: String((record && record.bundleVersion) || ""),
    requestedExternalVersionId: String((record && record.requestedExternalVersionId) || ""),
    externalVersionId: String((record && record.externalVersionId) || ""),
    packageVerified: !!(record && record.packageVerified),
    metadataVerified: !!record && record.metadataVerified === true,
    versionSource: String((record && record.versionSource) || ""),
    packageAppPath: String((record && record.packageAppPath) || ""),
    // 修复入口生成的新文件本身就是注入后的包，标记后列表直接显示
    // “已注入授权”，也不会再把它当成待修复记录。
    sinfInjected: true,
  };
}

// 低层入口：把 srcPath 指向的 IPA 解压，写入 SINF/iTunesMetadata 后整体
// 重打包到 destPath（缺省为 cache 下唯一路径）。
// 成功返回 { destPath, sinfWrites, metadataInjected, source }；destPath 在
// 成功后会保留给调用方 move/入库，失败路径由调用方或本函数 finally 清理。
// 解压用的私有临时目录无论成败都会删除。
async function injectIpaFile(options) {
  const opts = options || {};
  const srcPath = String(opts.srcPath || "");
  const sinfs = Array.isArray(opts.sinfs) ? opts.sinfs : [];
  if (!srcPath) throw new Error("IPA 源文件路径为空");
  if (!sinfs.length) throw new Error("记录中没有 SINF，无法注入授权");
  if (
    typeof $file === "undefined" ||
    !$file ||
    !$file.exists ||
    !$file.exists(srcPath)
  ) {
    throw new Error("IPA 源文件不存在");
  }
  const destPath =
    String(opts.destPath || "") ||
    `${CACHE_DIR}/jasspp-injected-${nonce()}.ipa`;
  const token = nonce();
  const workRoot = `${CACHE_DIR}/jasspp-inject-${token}`;
  const extractDir = `${workRoot}/extracted`;
  const progress = typeof opts.progress === "function" ? opts.progress : null;
  validator.ensureDir(CACHE_DIR);
  validator.ensureDir(extractDir);
  let completed = false;
  try {
    if (progress) progress("正在解压 IPA…");
    await validator.unzipAtPath(srcPath, extractDir);

    const appDir = appDirectoryPath(extractDir, {
      packageAppPath: opts.packageAppPath,
    });
    const plan = planSinfTargets(appDir, sinfs);

    if (progress) progress("正在写入 SINF…");
    const sinfWrites = writePlannedTargets(appDir, plan);

    let metadataInjected = false;
    const metadataText = decodeMetadataText(opts.iTunesMetadataBase64);
    if (metadataText) {
      writeTextFile(`${extractDir}/iTunesMetadata.plist`, metadataText);
      metadataInjected = true;
    }

    if (progress) progress("正在重新打包 IPA…");
    await zipDirectory(extractDir, destPath);
    if (!$file.exists(destPath)) {
      throw new Error("IPA 重新打包后文件不存在");
    }
    completed = true;
    return { destPath, sinfWrites, metadataInjected, source: plan.source };
  } finally {
    // 解压内容与空目录一定删除；destPath 与源文件交给调用方决定去留。
    validator.removeTree(workRoot);
    // 失败路径（解压/写入/重打包抛错）可能留下半成品 destPath，在这里清掉；
    // 成功返回后 destPath 由调用方负责 move 或删除。
    if (!completed) safeDeleteFile(destPath);
  }
}

// 已入库记录版入口：把记录对应的 IPA 解压、写入 SINF/iTunesMetadata、重新
// 打包并以「（已注入SINF）」后缀另存一份。成功返回
// { record, sinfWrites, metadataInjected }；失败抛出错误且不污染库。
async function injectAndSave(record, options) {
  const fileName = String((record && record.fileName) || "");
  if (!library.isSafeFileName(fileName)) throw new Error("无效的 IPA 文件名");
  const opts = options || {};
  if (opts.progress && typeof opts.progress === "function") {
    opts.progress("准备注入…");
  }

  const destPath = `${CACHE_DIR}/jasspp-injected-${nonce()}.ipa`;
  try {
    const result = await injectIpaFile({
      srcPath: library.filePath(fileName),
      destPath,
      sinfs: record.sinfs,
      iTunesMetadataBase64: record.iTunesMetadataBase64,
      packageAppPath: record.packageAppPath,
      progress: opts.progress,
    });
    const meta = injectedMeta(record);
    const saved = library.saveDownloadedFile(destPath, meta);
    return {
      record: saved,
      sinfWrites: result.sinfWrites,
      metadataInjected: result.metadataInjected,
      source: result.source,
    };
  } finally {
    // 入库成功后文件已被 move 走；未入库的残留（含重打包失败的部分文件）
    // 在这里清掉。
    safeDeleteFile(destPath);
  }
}

module.exports = {
  injectAndSave,
  injectIpaFile,
  canRezip,
  sinfTargetFromSupp,
  sinfTargetFromExecutable,
  normalizeSinfRelPath,
  planSinfTargets,
  decodeMetadataText,
  injectedMeta,
};
