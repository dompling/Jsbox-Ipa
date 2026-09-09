// IPA 包结构校验。
//
// `$http.download` 返回的是完整 `$data`，因此不能只看 HTTP 200 或
// Content-Length：错误页、截断包和伪造响应都可能满足这些条件。JSBox 2.0+
// 提供 `$archiver.unzip({path, dest})`，这里把下载先落到唯一临时文件，再在
// 私有临时目录解压，确认存在唯一的 `Payload/*.app/Info.plist`。

const CACHE_DIR = "cache";
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const UNZIP_TIMEOUT_MS = 120 * 1000;
const otaMetadata = require("../lib/ota-manifest");

function nonce() {
  return `${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
}

function bytesOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.byteArray)) return data.byteArray;
  if (data && data.rawData) return bytesOf(data.rawData);
  return null;
}

function looksLikeZip(data) {
  const bytes = bytesOf(data);
  if (!bytes || bytes.length < 22) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
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

function safeDelete(path) {
  try {
    if (typeof $file === "undefined" || !$file.exists(path)) return true;
    return $file.delete(path) !== false;
  } catch (_e) {
    return false;
  }
}

function removeTree(path) {
  if (typeof $file === "undefined" || !$file.exists(path)) return;
  if (!$file.isDirectory || !$file.isDirectory(path)) {
    safeDelete(path);
    return;
  }
  for (const name of $file.list(path) || []) {
    if (!name || name === "." || name === ".." || name.includes("/")) continue;
    removeTree(`${path}/${name}`);
  }
  safeDelete(path);
}

function ensureDir(path) {
  if ($file.exists(path)) {
    if ($file.isDirectory && !$file.isDirectory(path)) throw new Error("临时路径被文件占用");
    return;
  }
  if ($file.mkdir(path) === false) throw new Error("创建 IPA 校验目录失败");
}

async function unzipAtPath(path, dest) {
  if (typeof $archiver === "undefined" || !$archiver || typeof $archiver.unzip !== "function") {
    throw new Error("当前 JSBox 不支持 IPA 结构校验");
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
      if (value === false) finish(new Error("IPA ZIP 解压失败"));
      else finish(null, value === undefined ? true : value);
    };
    timer = setTimeout(
      () => finish(new Error("IPA ZIP 解压超时，请删除临时文件后重试")),
      UNZIP_TIMEOUT_MS
    );
    try {
      const result = $archiver.unzip({ path, dest, handler: done });
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

// `$archiver` 应该阻止 ZIP 路径穿越，但不同 JSBox 版本底层实现可能不同。
// 解压后再检查每一级目录名，避免后续读取/删除逻辑触碰校验目录之外的路径。
function validateExtractedTree(path, depth, counter) {
  const level = Number(depth) || 0;
  const seen = counter || { value: 0 };
  if (level > 32) throw new Error("IPA ZIP 目录层级过深");
  if (!$file.exists(path)) throw new Error("IPA 解压目录不存在");
  if ($file.isDirectory && !$file.isDirectory(path)) {
    throw new Error("IPA 解压目标不是目录");
  }
  if (!$file.list || !$file.isDirectory) return;
  for (const name of $file.list(path) || []) {
    seen.value += 1;
    if (seen.value > 100000) throw new Error("IPA ZIP 文件数量异常");
    const item = String(name || "");
    if (
      !item ||
      item === "." ||
      item === ".." ||
      item.includes("/") ||
      item.includes("\\") ||
      item.includes("\0")
    ) {
      throw new Error("IPA ZIP 包含不安全的路径");
    }
    const child = `${path}/${item}`;
    if ($file.isDirectory(child)) validateExtractedTree(child, level + 1, seen);
  }
}

function appBundlePath(extractDir) {
  const payload = `${extractDir}/Payload`;
  if (!$file.exists(payload) || ($file.isDirectory && !$file.isDirectory(payload))) return "";
  const apps = ($file.list(payload) || []).filter((name) => {
    if (!/^[^/\\]+\.app$/i.test(name)) return false;
    const path = `${payload}/${name}`;
    return !$file.isDirectory || $file.isDirectory(path);
  });
  if (apps.length !== 1) return "";
  return `${payload}/${apps[0]}`;
}

function parseInfoPlist(infoPath) {
  try {
    const value = $file.read(infoPath);
    const text = value && typeof value.string === "string" ? value.string : "";
    if (!text || text.indexOf("<plist") < 0) return null;
    return require("../lib/plist").parsePlist(text);
  } catch (_e) {
    return null;
  }
}

function verifyMetadata(info, expected) {
  const readable = !!info && typeof info === "object" && !Array.isArray(info);
  const field = key => readable && typeof info[key] === "string" ? info[key].trim() : "";
  const expectedBundle = String(expected && expected.bundleId || "").trim();
  const actualBundle = field("CFBundleIdentifier");
  const actualBuild = field("CFBundleVersion");
  if (readable && expectedBundle && actualBundle !== expectedBundle) {
    throw new Error("IPA 的 Bundle ID 与下载元数据不一致");
  }
  let metadataVerified = false;
  try {
    otaMetadata.validateBundleId(actualBundle);
    const build = otaMetadata.validateVersion(actualBuild);
    metadataVerified = !!expectedBundle && actualBundle === expectedBundle && build === actualBuild;
  } catch (_err) {}
  // 历史 API 的版本字符串可能陈旧；实际 Info.plist 的版本才用于入库。
  // binary plist 当前不可读，结构成功不代表身份和版本验证成功。
  return {
    metadataReadable: readable,
    metadataVerified,
    bundleId: actualBundle,
    shortVersion: field("CFBundleShortVersionString"),
    bundleVersion: actualBuild,
  };
}

// 把整包数据落成唯一临时 .ipa 文件并返回路径；调用方负责结束后的清理。
// 下载流程用它把下载缓冲立刻写盘、随后释放内存引用，再从磁盘解压校验并
// 把同一份文件移入下载库，避免大 IPA 的 $data 在解压/保存期间长期驻留。
function stageDownloadedData(data) {
  if (!data) throw new Error("IPA 数据为空");
  if (
    typeof $file === "undefined" ||
    !$file ||
    typeof $file.write !== "function"
  ) {
    throw new Error("当前 JSBox 不支持写入临时 IPA 文件");
  }
  ensureDir(CACHE_DIR);
  const tempPath = `${CACHE_DIR}/jasspp-ipa-${nonce()}.ipa`;
  if (!$file.write({ path: tempPath, data })) {
    throw new Error("写入 IPA 校验临时文件失败");
  }
  return tempPath;
}

// 从已经落盘的 IPA 文件校验结构并核对元数据；不删除源文件，调用方负责清理。
// 真正的 JSBox 运行时从路径解压，避免把整包再载入内存做结构检查。
async function validateDownloadedFile(path, expected) {
  if (!path) throw new Error("IPA 文件路径为空");
  if (
    typeof $file === "undefined" ||
    typeof $archiver === "undefined" ||
    !$file ||
    !$file.exists ||
    !$file.exists(path)
  ) {
    throw new Error("当前 JSBox 无法从磁盘校验 IPA");
  }
  const token = nonce();
  const extractDir = `${CACHE_DIR}/jasspp-ipa-${token}`;
  try {
    ensureDir(extractDir);
    await unzipAtPath(path, extractDir);
    validateExtractedTree(extractDir);
    const appPath = appBundlePath(extractDir);
    if (!appPath) throw new Error("IPA 缺少唯一的 Payload/*.app 目录");
    const infoPath = `${appPath}/Info.plist`;
    if (!$file.exists(infoPath)) throw new Error("IPA 缺少 Payload 应用的 Info.plist");
    return {
      verified: true,
      appPath: appPath.replace(`${extractDir}/`, ""),
      ...verifyMetadata(parseInfoPlist(infoPath), expected),
    };
  } finally {
    removeTree(extractDir);
  }
}

async function validateDownloadedIpa(data, expected) {
  if (!data) throw new Error("IPA 数据为空");

  // Node 单测/旧版运行时只能看到 byteArray 时，至少检查 ZIP 头尾；
  // 真正的 JSBox 运行时继续走磁盘解压和 Payload 校验。
  if (typeof $file === "undefined" || typeof $archiver === "undefined") {
    if (!looksLikeZip(data)) throw new Error("下载内容不是有效的 ZIP/IPA");
    return { verified: false, reason: "当前运行时没有 archiver" };
  }

  const tempPath = stageDownloadedData(data);
  try {
    return await validateDownloadedFile(tempPath, expected);
  } finally {
    safeDelete(tempPath);
  }
}

function normalizeArtifacts(sinfs, metadataBase64) {
  const result = [];
  for (const item of Array.isArray(sinfs) ? sinfs.slice(0, 256) : []) {
    if (!item || item.id === undefined || item.id === null) continue;
    const value = String(item.sinf || "").replace(/\s+/g, "");
    if (!value || value.length > MAX_ARTIFACT_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) continue;
    result.push({ id: String(item.id), sinf: value });
  }
  const metadata = String(metadataBase64 || "").replace(/\s+/g, "");
  return {
    sinfs: result,
    iTunesMetadataBase64:
      metadata && metadata.length <= MAX_ARTIFACT_BYTES * 2 && /^[A-Za-z0-9+/]*={0,2}$/.test(metadata)
        ? metadata
        : "",
  };
}

module.exports = {
  stageDownloadedData,
  validateDownloadedFile,
  validateDownloadedIpa,
  looksLikeZip,
  normalizeArtifacts,
  bytesOf,
  ensureDir,
  removeTree,
  unzipAtPath,
  appBundlePath,
};
