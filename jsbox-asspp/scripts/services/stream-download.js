// 大 IPA 按 Range 分段落盘，验证后通过 $file.merge 合并。
// 仅未开始分段的能力探测可回退整包；分段完整性或磁盘错误必须终止。
const http = require("../lib/http");
const config = require("../config");
const { assertActive, isCancelled, DownloadCancelledError } = require("../lib/cancellation");

const TMP_DIR = config.DEFAULTS.downloadDir + "/.stream";
const CHUNK_THRESHOLD_BYTES = 48 * 1024 * 1024;
// JSBox 只明确记录了 byteArray 的实际字节读取能力。将单片限制为 4 MiB，
// 避免验证时把原来的 16 MiB 一次扩展成大型 JavaScript 数组。
const CHUNK_SIZE = 4 * 1024 * 1024;
const CHUNK_RETRY_COUNT = 2;
const MERGE_CHUNK_SIZE = 4 * 1024 * 1024;

function integrityError(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function safeSecureUrl(raw) {
  const value = String(raw || "").trim();
  const match = /^https:\/\/([^/?#]+)/i.exec(value);
  if (!match || /[\s\\\x00-\x1f\x7f]/.test(value)) {
    throw integrityError("IPA 下载必须使用有效的 HTTPS 地址");
  }
  if (match[1].indexOf("@") >= 0) {
    throw integrityError("IPA 下载地址不能包含凭据");
  }
  return value;
}

function resourceKey(raw) {
  const value = safeSecureUrl(raw);
  const match = /^https:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(?:#.*)?$/i.exec(value);
  if (!match) throw integrityError("无法确认下载资源地址");
  // ETag 只在同一个资源内具有比较意义。保留路径和查询参数，避免把不同
  // CDN 资源仅凭相同 ETag 合并；忽略不参与请求的 fragment 和默认端口。
  return "https://" + match[1].toLowerCase().replace(/:443$/, "") +
    (match[2] || "/") + (match[3] || "");
}

function positiveInteger(value) {
  if (!/^\d+$/.test(String(value === undefined || value === null ? "" : value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function supportsFileMerge() {
  return typeof $file !== "undefined" && $file &&
    ["merge", "write", "delete", "exists", "mkdir"].every((key) => typeof $file[key] === "function");
}

function ensureDir(path) {
  if ($file.exists(path)) return !$file.isDirectory || $file.isDirectory(path);
  return $file.mkdir(path) !== false;
}

function safeDelete(path) {
  try {
    if (path && typeof $file !== "undefined" && $file.exists(path)) $file.delete(path);
  } catch (_e) {}
}

function cleanupParts(parts) {
  for (const part of parts) safeDelete(part);
}

function sleep(ms, cancellation) {
  return new Promise((resolve, reject) => {
    let finished = false, unsubscribe = null, timer;
    function finish(error) {
      if (finished) return;
      finished = true;
      if (unsubscribe) unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    if (cancellation) {
      unsubscribe = cancellation.subscribe(() => finish(new DownloadCancelledError()));
      if (finished) { unsubscribe(); return; }
    }
    try {
      if (typeof $delay === "function") $delay(ms / 1000, () => finish());
      else timer = setTimeout(() => finish(), ms);
    } catch (error) {
      finish(error);
    }
  });
}

function assertIdentityEncoding(headers) {
  const encoding = String(headers["content-encoding"] || "").trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw integrityError("下载分片使用了压缩传输，无法核对字节范围");
  }
}

function strongETag(value) {
  // RFC 9110 entity-tag；弱验证器不能用于 If-Match。
  return /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value || "");
}

// 未提供 Range/长度或 HEAD 不可用时允许原整包路径；不安全重定向不回退。
async function probe(rawUrl, options) {
  const cancellation = options && options.cancellation;
  assertActive(cancellation);
  const url = safeSecureUrl(rawUrl);
  let res;
  try {
    res = await http.send({
      method: "HEAD", url, timeout: 15,
      headers: { "Accept-Encoding": "identity" },
      cancellation,
    });
  } catch (error) {
    if (isCancelled(error)) throw error;
    assertActive(cancellation);
    return null;
  }
  assertActive(cancellation);
  if (res && isCancelled(res.error)) throw res.error;
  if (!res) return null;
  if (res.finalUrl) safeSecureUrl(res.finalUrl);
  const status = Number(res.status) || 0;
  if (res.failed || status < 200 || status >= 300) return null;
  if (!res.finalUrl) throw integrityError("无法确认下载资源地址");
  const finalUrl = safeSecureUrl(res.finalUrl);
  if (!res.headers) return null;
  const length = positiveInteger(res.headers["content-length"]);
  const ranges = String(res.headers["accept-ranges"] || "").trim().toLowerCase();
  if (!length || ranges !== "bytes") return null;
  assertIdentityEncoding(res.headers);
  return {
    length, finalUrl,
    etag: String(res.headers.etag || "").trim(),
    lastModified: String(res.headers["last-modified"] || "").trim(),
  };
}

function dataLength(data) {
  if (Array.isArray(data)) return data.length;
  if (typeof ArrayBuffer !== "undefined") {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(data)) return data.byteLength;
  }
  // 只转换已经通过状态和范围检查的有界分片，不读取整包的 byteArray。
  let bytes;
  try {
    bytes = data && data.byteArray;
  } catch (_e) {
    throw integrityError("无法读取下载分片的实际长度");
  }
  if (Array.isArray(bytes)) return bytes.length;
  if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(bytes)) {
    return bytes.byteLength;
  }
  throw integrityError("无法确认下载分片的实际长度");
}

function validateChunk(res, start, end, total, validators) {
  const status = Number(res.status) || 0;
  if (status !== 206) {
    throw integrityError(status === 412
      ? "下载资源已变化，请重新下载"
      : "服务器未返回指定分片（HTTP " + (status || "未知") + "）");
  }
  const headers = res.headers || {};
  assertIdentityEncoding(headers);
  const contentType = String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (/^(text|multipart)\//.test(contentType) ||
      ["application/json", "application/xml", "application/x-plist"].includes(contentType)) {
    throw integrityError("服务器返回了无效的下载分片");
  }
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(String(headers["content-range"] || "").trim());
  if (!range || Number(range[1]) !== start || Number(range[2]) !== end ||
      positiveInteger(range[3]) !== total) {
    throw integrityError("下载分片的字节范围不一致");
  }
  const expected = end - start + 1;
  if (headers["content-length"] !== undefined && positiveInteger(headers["content-length"]) !== expected) {
    throw integrityError("下载分片的长度信息不一致");
  }
  const etag = String(headers.etag || "").trim();
  const modified = String(headers["last-modified"] || "").trim();
  if ((validators.etag && etag && validators.etag !== etag) ||
      (validators.lastModified && modified && validators.lastModified !== modified)) {
    throw integrityError("下载资源已变化，请重新下载");
  }
  const actual = dataLength(res.rawData);
  if (actual !== expected) throw integrityError("下载分片不完整，请重试");
  if (!validators.etag && etag) validators.etag = etag;
  if (!validators.lastModified && modified) validators.lastModified = modified;
  return actual;
}

async function fetchChunk(url, start, end, total, validators, options) {
  const cancellation = options && options.cancellation;
  const headers = { Range: "bytes=" + start + "-" + end, "Accept-Encoding": "identity" };
  if (strongETag(validators.etag)) headers["If-Match"] = validators.etag;
  for (let attempt = 0; attempt < CHUNK_RETRY_COUNT; attempt++) {
    assertActive(cancellation);
    try {
      const res = await http.send({
        method: "GET", url, headers, download: true, showsProgress: false,
        backgroundFetch: true, timeout: 60, cancellation,
      });
      assertActive(cancellation);
      if (res && isCancelled(res.error)) throw res.error;
      if (res && res.finalUrl) safeSecureUrl(res.finalUrl);
      if (!res || res.failed) throw new Error("下载分片失败");
      if (Number(res.status) === 429 || Number(res.status) >= 500) {
        throw new Error("下载服务暂时不可用");
      }
      if (Number(res.status) === 206 &&
          (!res.finalUrl || resourceKey(res.finalUrl) !== resourceKey(url))) {
        throw integrityError("下载资源地址发生变化或无法确认，请重试");
      }
      const size = validateChunk(res, start, end, total, validators);
      assertActive(cancellation);
      return { data: res.rawData, size };
    } catch (error) {
      if (isCancelled(error)) throw error;
      assertActive(cancellation);
      if (error && error.fatal) throw error;
      if (attempt === CHUNK_RETRY_COUNT - 1) {
        throw new Error("下载分片失败，请重试");
      }
      await sleep(1500, cancellation);
    }
  }
}

function mergeParts(parts, dest) {
  const result = $file.merge({ files: parts, dest, chunkSize: MERGE_CHUNK_SIZE });
  if (result === false || !$file.exists(dest) || ($file.isDirectory && $file.isDirectory(dest))) {
    throw new Error("合并下载分片失败");
  }
}

// options 携带 HEAD 的 ETag / Last-Modified；没有强验证器时只能核对可见标识、
// 范围和长度，不能证明多段内容来自同一个未变化的实体。
async function downloadChunked(rawUrl, total, onProgress, options) {
  const opts = options || {};
  const cancellation = opts.cancellation;
  assertActive(cancellation);
  if (!supportsFileMerge()) return { ok: false, reason: "no-file-merge" };
  const parts = [];
  let dest = "";
  try {
    const url = safeSecureUrl(rawUrl);
    if (!Number.isSafeInteger(total) || total <= 0) throw integrityError("下载文件长度无效");
    if (!ensureDir(TMP_DIR)) throw new Error("无法创建分片下载目录");
    const token = Date.now() + "-" + Math.floor(Math.random() * 1e9);
    dest = TMP_DIR + "/.stream-" + token + ".ipa";
    const validators = {
      etag: String(opts.etag || "").trim(),
      lastModified: String(opts.lastModified || "").trim(),
    };
    let written = 0;
    while (written < total) {
      assertActive(cancellation);
      const end = written + Math.min(CHUNK_SIZE, total - written) - 1;
      const chunk = await fetchChunk(url, written, end, total, validators, opts);
      assertActive(cancellation);
      const part = TMP_DIR + "/.stream-" + token + ".part" + parts.length;
      // 写入返回 false 或抛错时，也要清掉可能已创建的当前分片。
      parts.push(part);
      if (!$file.write({ path: part, data: chunk.data })) throw new Error("写入下载分片失败");
      written += chunk.size;
      assertActive(cancellation);
      if (typeof onProgress === "function") {
        try { onProgress(written, total); } catch (_e) {}
      }
    }
    assertActive(cancellation);
    mergeParts(parts, dest);
    cleanupParts(parts);
    assertActive(cancellation);
    return { ok: true, path: dest, size: written };
  } catch (error) {
    cleanupParts(parts);
    safeDelete(dest);
    if (isCancelled(error)) throw error;
    assertActive(cancellation);
    return { ok: false, fatal: true, reason: (error && error.message) || "分片下载失败" };
  }
}

async function tryChunkedDownload(info, onProgress, options) {
  const opts = options || {};
  assertActive(opts.cancellation);
  if (opts.chunkDownload === false) return { ok: false, reason: "disabled" };
  if (!supportsFileMerge()) return { ok: false, reason: "no-file-merge" };
  try {
    const probed = await probe(info && info.downloadURL, opts);
    assertActive(opts.cancellation);
    if (!probed) return { ok: false, reason: "range-unsupported" };
    if (probed.length < CHUNK_THRESHOLD_BYTES) return { ok: false, reason: "too-small" };
    return await downloadChunked(probed.finalUrl, probed.length, onProgress, Object.assign({}, opts, probed));
  } catch (error) {
    if (isCancelled(error)) throw error;
    assertActive(opts.cancellation);
    return { ok: false, fatal: true, reason: (error && error.message) || "无法确认下载分片信息" };
  }
}

module.exports = {
  CHUNK_THRESHOLD_BYTES, CHUNK_SIZE, downloadChunked, tryChunkedDownload, probe, supportsFileMerge,
};
