// 本地 IPA 文件管理：原子保存、元数据 sidecar、恢复、删除与分享。

const config = require("../config");
const format = require("../lib/format");
const b64 = require("../lib/b64");
const plist = require("../lib/plist");
const accounts = require("./accounts");

const DIR = config.DEFAULTS.downloadDir;
const LEGACY_PREFS_KEY = "jasspp.library.v1";
const META_SUFFIX = ".meta.json";
const ICON_SUFFIX = ".icon";
const MAX_ARTIFACT_TEXT = 16 * 1024 * 1024;
const MAX_ACCOUNT_METADATA_TEXT = 64 * 1024;
const metadataAccountCache = new Map();

function ensureDir() {
  if ($file.exists(DIR)) {
    if ($file.isDirectory && !$file.isDirectory(DIR)) {
      throw new Error("下载目录被同名文件占用");
    }
    return;
  }
  if ($file.mkdir(DIR) === false) throw new Error("创建下载目录失败");
}

function isSafeFileName(fileName) {
  const value = String(fileName || "");
  return (
    value.length > 4 &&
    value.length <= 180 &&
    value.toLowerCase().endsWith(".ipa") &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function assertSafeFileName(fileName) {
  if (!isSafeFileName(fileName)) throw new Error("无效的 IPA 文件名");
  return String(fileName);
}

function filePath(fileName) {
  return `${DIR}/${assertSafeFileName(fileName)}`;
}

function metaPath(fileName) {
  return `${filePath(fileName)}${META_SUFFIX}`;
}

// 图标 sidecar 与 IPA 同目录但后缀不是 .ipa，listFiles() 的
// isSafeFileName 过滤不会把它当成可下载 App 列出来。
function iconPath(fileName) {
  return `${filePath(fileName)}${ICON_SUFFIX}`;
}

function textData(text) {
  return typeof $data === "function" ? $data({ string: String(text) }) : String(text);
}

function dataText(data) {
  if (typeof data === "string") return data;
  if (data && typeof data.string === "string") return data.string;
  return "";
}

function safeDelete(path) {
  if (!$file.exists(path)) return true;
  return $file.delete(path) !== false;
}

// `$file.list()` 返回的是目录项名称，名称本身不能证明它是普通文件。
// 不把目录（例如一个叫 `Fake.ipa` 的目录）当作可下载/可分享的 IPA，
// 避免后续的 OTA file response 或删除操作越过预期的文件边界。
function isRegularFile(path) {
  if (!$file.exists(path)) return false;
  try {
    return typeof $file.isDirectory !== "function" || !$file.isDirectory(path);
  } catch (_e) {
    return false;
  }
}

function tempPath(path, label) {
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  return `${path}.${label || "tmp"}-${nonce}`;
}

function writeNewFile(path, data) {
  const temp = tempPath(path, "partial");
  try {
    if (!$file.write({ data, path: temp })) throw new Error("写入临时文件失败");
    if (!$file.exists(temp)) throw new Error("临时文件写入后不存在");
    if (!$file.move({ src: temp, dst: path })) throw new Error("提交文件失败");
  } catch (err) {
    safeDelete(temp);
    throw err;
  }
}

function stageFile(path, data, label) {
  const temp = tempPath(path, label || "partial");
  try {
    if (!$file.write({ data, path: temp })) throw new Error("写入临时文件失败");
    if (!$file.exists(temp)) throw new Error("临时文件写入后不存在");
    return temp;
  } catch (err) {
    safeDelete(temp);
    throw err;
  }
}

function commitFile(temp, path) {
  if (!$file.move({ src: temp, dst: path })) throw new Error("提交文件失败");
}

function restoreFile(path, data) {
  try {
    if ($file.exists(path)) return true;
    return $file.write({ path, data }) !== false && $file.exists(path);
  } catch (_e) {
    return false;
  }
}

function storedAccountEmail(value) {
  if (typeof value !== "string") return "";
  const email = accounts.normalizeEmail(value);
  return email.length <= 320 && !/[\s\u0000-\u001f\u007f]/.test(email) ? email : "";
}

function legacyAccountEmail(encodedMetadata) {
  // 只读已保存的小型 XML 元数据，不为显示账号解包整个 IPA。
  if (!encodedMetadata || encodedMetadata.length > MAX_ACCOUNT_METADATA_TEXT) return "";
  if (metadataAccountCache.has(encodedMetadata)) return metadataAccountCache.get(encodedMetadata);
  let email = "";
  try {
    const metadata = plist.parsePlist(b64.base64DecodeString(encodedMetadata));
    for (const key of ["apple-id", "userName"]) {
      const candidate = storedAccountEmail(metadata && metadata[key]);
      if (/^[^@]+@[^@]+$/.test(candidate)) {
        email = candidate;
        break;
      }
    }
  } catch (_e) {}
  // 避免刷新按钮/列表时重复解码；缓存最多约 2MB 原始文本。
  if (metadataAccountCache.size >= 32) metadataAccountCache.delete(metadataAccountCache.keys().next().value);
  metadataAccountCache.set(encodedMetadata, email);
  return email;
}

function normalizeRecord(value, fallbackFileName) {
  if (!value || typeof value !== "object") return null;
  const fileName = String(value.fileName || fallbackFileName || "");
  if (!isSafeFileName(fileName)) return null;
  const size = Number(value.size);
  const versionSource = ["ipa", "api", "unknown"].includes(value.versionSource) ? value.versionSource : "";
  const sinfs = [];
  for (const item of Array.isArray(value.sinfs) ? value.sinfs.slice(0, 256) : []) {
    if (!item || item.id === undefined || item.id === null) continue;
    const encoded = String(item.sinf || "").replace(/\s+/g, "");
    if (!encoded || encoded.length > MAX_ARTIFACT_TEXT || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
    sinfs.push({ id: String(item.id), sinf: encoded });
  }
  const rawMetadata = String(value.iTunesMetadataBase64 || "").replace(/\s+/g, "");
  const iTunesMetadataBase64 =
    rawMetadata && rawMetadata.length <= MAX_ARTIFACT_TEXT && /^[A-Za-z0-9+/]*={0,2}$/.test(rawMetadata)
      ? rawMetadata
      : "";
  return {
    fileName,
    appId: String(value.appId || ""),
    bundleId: String(value.bundleId || ""),
    title: String(value.title || fileName.replace(/\.ipa$/i, "")),
    accountEmail: storedAccountEmail(value.accountEmail) || legacyAccountEmail(iTunesMetadataBase64),
    version: versionSource === "unknown" ? "版本号未知" : String(value.version || value.shortVersion || ""),
    shortVersion: versionSource === "unknown" ? "" : String(value.shortVersion || (!versionSource && value.version) || ""),
    // bundleVersion 会写进 OTA manifest，不能拿“最新版”等展示文案冒充。
    bundleVersion: versionSource === "unknown" ? "" : String(value.bundleVersion || ""),
    requestedExternalVersionId: String(value.requestedExternalVersionId || ""),
    externalVersionId: String(value.externalVersionId || ""),
    size: Number.isFinite(size) && size > 0 ? size : 0,
    createdAt: String(value.createdAt || ""),
    recovered: !!value.recovered,
    packageVerified: !!value.packageVerified,
    metadataVerified: value.metadataVerified === true && versionSource === "ipa" && value.packageVerified === true,
    versionSource,
    packageAppPath: /^[^/\\]+\.app$/i.test(String(value.packageAppPath || "").replace(/^Payload\//, ""))
      ? `Payload/${String(value.packageAppPath || "").replace(/^Payload\//, "")}`
      : "",
    // 下载时是否已把 SINF/iTunesMetadata 写回 IPA；旧记录为 false。
    sinfInjected: !!value.sinfInjected,
    sinfs,
    iTunesMetadataBase64,
  };
}

function readMetadata(fileName) {
  const path = metaPath(fileName);
  if (!$file.exists(path)) return null;
  try {
    const parsed = JSON.parse(dataText($file.read(path)));
    if (parsed && parsed.fileName && String(parsed.fileName) !== String(fileName)) {
      return null;
    }
    const normalized = normalizeRecord(Object.assign({}, parsed, { fileName }), fileName);
    if (!normalized) return null;
    attachIconPath(normalized);
    return normalized;
  } catch (_e) {
    return null;
  }
}

// iconPath 是运行时派生的本地文件路径，不写进 sidecar JSON；
// 有图标 sidecar 时附加到记录上，供列表行读取图标。
function attachIconPath(record) {
  const path = iconPath(record.fileName);
  if ($file.exists(path) && isRegularFile(path)) record.iconPath = path;
  return record;
}

function writeMetadata(record) {
  const normalized = normalizeRecord(record, record && record.fileName);
  if (!normalized) throw new Error("IPA 元数据无效");
  writeNewFile(metaPath(normalized.fileName), textData(JSON.stringify(normalized)));
  return normalized;
}

function legacyRecords() {
  const value = $prefs.get(LEGACY_PREFS_KEY);
  return Array.isArray(value) ? value.map((item) => normalizeRecord(item)).filter(Boolean) : [];
}

function migrateLegacyMetadata() {
  const legacy = legacyRecords();
  if (!legacy.length) return;
  let complete = true;
  for (const record of legacy) {
    const path = filePath(record.fileName);
    const metadataPath = metaPath(record.fileName);
    if (!isRegularFile(path)) continue;
    if ($file.exists(metadataPath) && readMetadata(record.fileName)) continue;
    try {
      if ($file.exists(metadataPath) && !safeDelete(metadataPath)) {
        throw new Error("无法替换损坏的 IPA 元数据");
      }
      writeMetadata(record);
    } catch (_e) {
      complete = false;
    }
  }
  if (complete) $prefs.set(LEGACY_PREFS_KEY, []);
}

function uniqueFileName(baseName) {
  const stem = format.sanitizeFileName(baseName || "download").slice(0, 150);
  let candidate = `${stem}.ipa`;
  let suffix = 2;
  while (
    $file.exists(`${DIR}/${candidate}`) ||
    $file.exists(`${DIR}/${candidate}${META_SUFFIX}`) ||
    $file.exists(`${DIR}/${candidate}${ICON_SUFFIX}`)
  ) {
    candidate = `${stem}_${suffix}.ipa`;
    suffix++;
  }
  return candidate;
}

// 把下载到的 App 图标作为独立 sidecar 存到 IPA 旁边。
// 图标只是展示资产：保存失败不应影响 IPA 本身，调用方负责 best-effort。
function saveIcon(fileName, data) {
  assertSafeFileName(fileName);
  if (data === undefined || data === null) throw new Error("图标数据为空");
  const target = iconPath(fileName);
  writeNewFile(target, data);
  return target;
}

// 读取 IPA 的图标 sidecar；不存在时返回 null（列表行回退到默认占位）。
function iconData(fileName) {
  const path = iconPath(fileName);
  if (!$file.exists(path) || !isRegularFile(path)) return null;
  return $file.read(path);
}

// data: $data；meta: {name, appId, bundleId, version, bundleVersion, size}
function save(data, meta) {
  if (!data) throw new Error("IPA 数据为空");
  ensureDir();
  const fileName = uniqueFileName((meta && meta.name) || "download");
  const record = normalizeRecord(
    Object.assign({}, meta || {}, {
      fileName,
      createdAt: new Date().toISOString(),
    }),
    fileName
  );
  const ipaPath = filePath(fileName);
  const metadataPath = metaPath(fileName);
  let ipaTemp = "";
  let metadataTemp = "";
  try {
    ipaTemp = stageFile(ipaPath, data, "download");
    metadataTemp = stageFile(
      metadataPath,
      textData(JSON.stringify(record)),
      "metadata"
    );
    // 先发布 IPA，后发布 sidecar。若进程在两步之间退出，IPA 会以“待恢复”
    // 记录显示，而不会留下一个隐藏 IPA 的孤立元数据文件。
    commitFile(ipaTemp, ipaPath);
    ipaTemp = "";
    commitFile(metadataTemp, metadataPath);
    metadataTemp = "";
  } catch (err) {
    if (ipaTemp) safeDelete(ipaTemp);
    if (metadataTemp) safeDelete(metadataTemp);
    safeDelete(ipaPath);
    safeDelete(metadataPath);
    throw new Error(`保存 IPA 失败：${err.message || err}`);
  }
  return Object.assign({}, record, { path: ipaPath });
}

// 把已经落盘且校验通过的 IPA 源文件移入下载库并发布 sidecar。
// 与 save(data) 不同，这里不持有整包 $data：下载流程先把原始数据写到
// 唯一临时文件后立刻释放内存引用，再在磁盘上解压校验，最后把同一份文件
// move 到最终路径，避免“下载缓冲 + 解压 + 二次写盘”同时驻留造成内存峰值。
function saveDownloadedFile(srcPath, meta) {
  if (!srcPath) throw new Error("IPA 源文件路径为空");
  ensureDir();
  if (
    typeof $file === "undefined" ||
    !$file.exists ||
    !$file.exists(srcPath) ||
    ($file.isDirectory && $file.isDirectory(srcPath))
  ) {
    throw new Error("IPA 源文件不存在");
  }
  const fileName = uniqueFileName((meta && meta.name) || "download");
  const record = normalizeRecord(
    Object.assign({}, meta || {}, {
      fileName,
      createdAt: new Date().toISOString(),
    }),
    fileName
  );
  const ipaPath = filePath(fileName);
  const metadataPath = metaPath(fileName);
  let metadataTemp = "";
  try {
    // 先发布 IPA：把校验通过的临时文件直接 move 到最终位置，不再复制整包。
    if (!$file.move({ src: srcPath, dst: ipaPath })) {
      throw new Error("移动校验后的 IPA 到下载目录失败");
    }
    metadataTemp = stageFile(
      metadataPath,
      textData(JSON.stringify(record)),
      "metadata"
    );
    commitFile(metadataTemp, metadataPath);
    metadataTemp = "";
  } catch (err) {
    if (metadataTemp) safeDelete(metadataTemp);
    safeDelete(metadataPath);
    throw new Error(`保存 IPA 失败：${err.message || err}`);
  }
  return Object.assign({}, record, { path: ipaPath });
}

function recoveredRecord(fileName) {
  const record = normalizeRecord({
    fileName,
    title: fileName.replace(/\.ipa$/i, ""),
    recovered: true,
  });
  return attachIconPath(record);
}

function listFiles() {
  ensureDir();
  migrateLegacyMetadata();
  const names = ($file.list(DIR) || []).filter(
    (name) => isSafeFileName(name) && isRegularFile(`${DIR}/${name}`)
  );
  const records = names.map((fileName) => readMetadata(fileName) || recoveredRecord(fileName));
  records.sort((a, b) => {
    const left = Date.parse(a.createdAt || "") || 0;
    const right = Date.parse(b.createdAt || "") || 0;
    return right - left || a.fileName.localeCompare(b.fileName);
  });
  return records;
}

// 只认已提交到本地库的文件；历史版本的 ID 不能用 App 当前版本号替代。
function findDownloaded(app, requestedVersion) {
  const soft = app || {};
  const appId = String(soft.id || soft.appId || "").trim();
  const bundleId = String(soft.bundleID || soft.bundleId || "").trim();
  const requested = requestedVersion === undefined ? soft : requestedVersion || {};
  const versionId = String(requested.externalVersionId || "").trim();
  const version = String(requested.displayVersion || requested.shortVersion || requested.version || "").trim();
  if ((!appId && !bundleId) || (!versionId && !/^\d+(?:\.\d+)*$/.test(version))) return null;
  if (typeof $file === "undefined" || !$file || typeof $file.list !== "function") return null;

  let records;
  try {
    records = listFiles();
  } catch (_e) {
    return null;
  }
  return records.find((record) => {
    if (record.recovered) return false;
    if (appId && record.appId && appId !== record.appId) return false;
    if (bundleId && record.bundleId && bundleId !== record.bundleId) return false;
    const sameApp = (appId && appId === record.appId) || (bundleId && bundleId === record.bundleId);
    if (!sameApp) return false;
    if (versionId) return versionId === record.externalVersionId;
    if (record.versionSource === "unknown" || (record.versionSource === "api" && record.requestedExternalVersionId)) return false;
    const savedVersion = String(record.shortVersion || record.version || "").trim();
    return /^\d+(?:\.\d+)*$/.test(savedVersion) && savedVersion === version;
  }) || null;
}

function remove(fileName) {
  const path = filePath(fileName);
  const metadataPath = metaPath(fileName);
  const icon = iconPath(fileName);
  const ipaPathExists = $file.exists(path);
  const metadataPathExists = $file.exists(metadataPath);
  const iconExists = $file.exists(icon) && isRegularFile(icon);
  if (ipaPathExists && !isRegularFile(path)) {
    throw new Error("IPA 路径不是普通文件");
  }
  if (metadataPathExists && !isRegularFile(metadataPath)) {
    throw new Error("IPA 元数据路径不是普通文件");
  }
  const ipaExists = isRegularFile(path);
  const metadataExists = isRegularFile(metadataPath);
  // 删除前先读取 IPA、元数据与图标三份原始数据，保证任一步失败时可以
  // 把可见文件和 sidecar 恢复；否则“删到一半”会把用户的下载变成孤儿。
  const ipaData = ipaExists ? $file.read(path) : undefined;
  const metadataData = metadataExists ? $file.read(metadataPath) : undefined;
  const iconDataValue = iconExists ? $file.read(icon) : undefined;
  if (ipaExists && (ipaData === undefined || ipaData === null)) {
    throw new Error("读取 IPA 文件失败");
  }
  if (metadataExists && (metadataData === undefined || metadataData === null)) {
    throw new Error("读取 IPA 元数据失败");
  }
  if (iconExists && (iconDataValue === undefined || iconDataValue === null)) {
    throw new Error("读取 IPA 图标失败");
  }

  const previousLegacy = $prefs.get(LEGACY_PREFS_KEY);
  const remaining = legacyRecords().filter((item) => item.fileName !== fileName);

  // 先提交旧索引，再做物理删除。索引写失败时绝不触碰文件；物理删除
  // 失败时回滚索引并尽力恢复已经删除的文件。
  if ($prefs.set(LEGACY_PREFS_KEY, remaining) === false) {
    throw new Error("清理旧版 IPA 索引失败");
  }

  try {
    if (metadataExists) {
      if (!$file.delete(metadataPath) || $file.exists(metadataPath)) {
        throw new Error("删除 IPA 元数据失败");
      }
    }
    if (ipaExists) {
      if (!$file.delete(path) || $file.exists(path)) {
        throw new Error("删除 IPA 文件失败");
      }
    }
    if (iconExists) {
      if (!$file.delete(icon) || $file.exists(icon)) {
        throw new Error("删除 IPA 图标失败");
      }
    }
  } catch (err) {
    const restoredMetadata = !metadataExists || restoreFile(metadataPath, metadataData);
    const restoredIpa = !ipaExists || restoreFile(path, ipaData);
    const restoredIcon = !iconExists || restoreFile(icon, iconDataValue);
    try {
      $prefs.set(LEGACY_PREFS_KEY, previousLegacy);
    } catch (_e) {}
    if (!restoredMetadata || !restoredIpa || !restoredIcon) {
      throw new Error(`${err.message || err}（回滚文件失败，请立即备份下载目录）`);
    }
    throw err;
  }
  return true;
}

function read(fileName) {
  const path = filePath(fileName);
  if (!isRegularFile(path)) throw new Error("找不到 IPA 文件或路径不是普通文件");
  return $file.read(path);
}

// $share.sheet 分享二进制数据时必须显式带文件名（name），否则收件端只会
// 收到没有扩展名/名称的通用数据，无法识别为 .ipa。优先用下载时记录的
// “App 名称 + 版本号”拼分享名，找不到元数据时退回磁盘文件名。
function shareDisplayName(fileName) {
  const meta = readMetadata(fileName);
  if (meta && !meta.recovered && meta.title) {
    const title = String(meta.title).replace(/\s+/g, " ").trim();
    const version = String(meta.version || "").replace(/\s+/g, " ").trim();
    if (title) {
      const stem = version ? `${title} ${version}` : title;
      const cleaned = stem
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
        .trim()
        .slice(0, 150);
      if (cleaned) return `${cleaned.replace(/\.ipa$/i, "")}.ipa`;
    }
  }
  return fileName;
}

function share(fileName, handler) {
  const file = read(fileName);
  if (!file) {
    if (handler) handler(false);
    return;
  }
  $share.sheet({
    items: [{ name: shareDisplayName(fileName), data: file }],
    handler: (success) => {
      if (handler) handler(success);
    },
  });
}

module.exports = {
  save,
  saveDownloadedFile,
  saveIcon,
  iconData,
  listFiles,
  findDownloaded,
  remove,
  share,
  read,
  isSafeFileName,
  filePath,
  DIR,
};
