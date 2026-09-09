// 获取下载信息 / 版本列表 / 下载 IPA：
// 对应 ipatool appstore_download.go / appstore_list_versions.go 与
// 对应 ApplePackage Sources/ApplePackage/Commands/VersionFinder.swift 的
// 版本列表端点与 download 流程。
//
// 优先使用 downloaddispatch /r/redownload，失败后用 volumeStoreDownloadProduct
// 兜底；两个接口分别使用 appExtVrsId / externalVersionId 指定历史版本。

const config = require("../config");
const http = require("../lib/http");
const plist = require("../lib/plist");
const cookieLib = require("../lib/cookies");
const { errorMessage } = require("../lib/error");
const { isCancelled } = require("../lib/cancellation");

class DownloadError extends Error {
  constructor(message, code, updatedCookies) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.updatedCookies = updatedCookies || null;
    this.needsAppStore = String(code) === "9610";
  }
}

function assertVersionListContinues(options, cookies) {
  if (options && typeof options.shouldContinue === "function" && options.shouldContinue() === false) {
    throw new DownloadError("历史版本加载已取消", "version_list_cancelled", cookies);
  }
}

function base64FromString(value) {
  const b64 = require("../lib/b64");
  return b64.base64EncodeString(value);
}

function cookieUpdateMerger(snapshot) {
  const now = Date.now() / 1000;
  const deletions = snapshot.filter(cookie => cookie.expiresAt !== undefined && cookie.expiresAt <= now);
  return updates => cookieLib.mergeCookies(
    // 请求期间自然过期的基线条目不是服务端删除指令。
    cookieLib.mergeCookies(snapshot, []),
    deletions.concat(updates || []),
    { preserveExpired: true }
  );
}

async function requestDownloadInfo(account, app, externalVersionId, endpoint, requestCookies, options) {
  const deviceId = account.deviceIdentifier;
  const storeFront = config.storeFrontHeaderFor(account, "-1,29");
  const url = `https://${endpoint.host}${endpoint.path}`;
  let cookies = requestCookies;
  const mergeUpdates = cookieUpdateMerger(cookies);
  assertVersionListContinues(options, cookies);
  const payload = {
    creditDisplay: "",
    guid: deviceId,
    salableAdamId: app.id,
  };
  if (externalVersionId !== undefined && externalVersionId !== null && externalVersionId !== "") {
    payload[endpoint.externalVersionIdKey] = String(externalVersionId);
  }

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
          // 两个下载接口复用已登录会话和当前 storefront。
          "X-Token": account.passwordToken || "",
          "X-Apple-Store-Front": storeFront,
        },
        body: plist.buildPlist(payload),
        cookies,
        collectRedirectCookies: true,
        shouldContinue: options && options.shouldContinue,
      },
      (r) => r.status === 200 && plist.looksLikePlist(r.body),
      2
    );
  } catch (err) {
    cookies = mergeUpdates(err && err.updatedCookies || []);
    assertVersionListContinues(options, cookies);
    throw new DownloadError(errorMessage(err), err && err.code, cookies);
  }

  cookies = mergeUpdates((res.updatedCookies || []).concat(
    cookieLib.parseCookieHeaders(http.setCookiesFromResponse(res), res.finalUrl || url)
  ));
  // 在切换端点或处理 2034/2042、9610 前保留在途 Cookie，再检查取消。
  assertVersionListContinues(options, cookies);

  if (res.failed) {
    throw new DownloadError(errorMessage(res.error), res.error && res.error.code || "", cookies);
  }
  const statusCode = Number(res.status) || 0;
  const httpOK = statusCode >= 200 && statusCode < 300;
  const httpError = () => new DownloadError(`下载信息请求失败: HTTP ${statusCode || "未知"}`, `HTTP_${statusCode}`, cookies);
  if (!res.body) {
    if (!httpOK) throw httpError();
    throw new DownloadError("下载信息响应为空", "", cookies);
  }

  let dict;
  try {
    dict = plist.parsePlist(res.body);
  } catch (err) {
    if (!httpOK) throw httpError();
    throw new DownloadError(`无法解析下载响应: ${err.message}`, "", cookies);
  }

  const failureType = dict.failureType ? String(dict.failureType) : "";
  if (failureType) {
    switch (failureType) {
      case "2034":
      case "2042":
        throw new DownloadError("登录已过期，请重新登录", failureType, cookies);
      case "9610":
        throw new DownloadError("当前账号没有该 App 的许可证", "9610", cookies);
      default:
        throw new DownloadError(
          dict.customerMessage || `下载失败（${failureType}）`,
          failureType,
          cookies
        );
    }
  }
  if (!httpOK) throw httpError();
  const songList = dict.songList;
  if (!Array.isArray(songList) || !songList.length || !songList[0] || typeof songList[0] !== "object") {
    throw new DownloadError("响应中没有可用项目", "", cookies);
  }
  return { dict, cookies };
}

async function downloadInfoCall(account, app, externalVersionId, options, parseResult) {
  // 账号旧快照中自然过期的 Cookie 不是服务器本次发出的删除更新。
  let cookies = cookieLib.mergeCookies(Array.isArray(account.cookies) ? account.cookies : [], []);
  const endpoints = [
    config.redownloadEndpoint(account.deviceIdentifier),
    config.volumeStoreEndpoint(account.pod, account.deviceIdentifier),
  ];
  for (let index = 0; index < endpoints.length; index++) {
    assertVersionListContinues(options, cookies);
    try {
      const result = await requestDownloadInfo(account, app, externalVersionId, endpoints[index], cookies, options);
      cookies = result.cookies;
      // 下载需要 URL/SINF，历史元数据只需要可用的项目；语义失败也应兜底。
      return parseResult(result);
    } catch (err) {
      // 本层 DownloadError 已包含完整会话快照；重合并旧快照会复活已删除的 Cookie。
      if (err && Array.isArray(err.updatedCookies)) cookies = err.updatedCookies;
      assertVersionListContinues(options, cookies);
      if (isCancelled(err) || String(err && err.code) === "version_list_cancelled" || index === endpoints.length - 1) {
        throw new DownloadError(errorMessage(err), err && err.code, cookies);
      }
    }
  }
}

// 获取指定 App 的下载信息（不下载文件本身）。
function getDownloadInfo(account, app, externalVersionId, options) {
  return downloadInfoCall(account, app, externalVersionId, options,
    ({ dict, cookies }) => {
      const item = dict.songList[0];
      const downloadURL = item.URL || item.url;
      if (!downloadURL) throw new DownloadError("缺少下载 URL", "", cookies);
      const metadata = item.metadata || {};
      const version = metadataFromDict(dict, externalVersionId, cookies);
      const sinfs = [];
      for (const sinfItem of item.sinfs || []) {
        if (sinfItem.id !== undefined && sinfItem.sinf) {
          let sinfBase64;
          if (typeof sinfItem.sinf === "string") {
            sinfBase64 = sinfItem.sinf;
          } else if (Array.isArray(sinfItem.sinf)) {
            // <data> 解析结果为字节数组
            const b64 = require("../lib/b64");
            sinfBase64 = b64.base64Encode(sinfItem.sinf);
          } else {
            throw new DownloadError("无效的 sinf 数据", "", cookies);
          }
          sinfs.push({ id: sinfItem.id, sinf: sinfBase64 });
        }
      }
      if (!sinfs.length) throw new DownloadError("响应中缺少 sinf", "", cookies);

      // 组装 iTunesMetadata（供后续工具使用/注入）
      const metadataDict = Object.assign({}, metadata);
      metadataDict["apple-id"] = account.email;
      metadataDict["userName"] = account.email;
      delete metadataDict.passwordToken;
      delete metadataDict["passwordToken"];

      return {
        downloadURL,
        requestedExternalVersionId: version.requestedExternalVersionId,
        externalVersionId: version.externalVersionId,
        sinfs,
        bundleShortVersionString: metadata.bundleShortVersionString,
        bundleVersion: metadata.bundleVersion,
        metadata: metadataDict,
        iTunesMetadataBase64: base64FromString(
          plist.buildPlist(metadataDict)
        ),
        versionIdentifiers: metadata.softwareVersionExternalIdentifiers || [],
        latestVersionIdentifier:
          metadata.softwareVersionExternalIdentifier,
        updatedCookies: cookies,
      };
    }
  );
}

function metadataFromDict(dict, externalVersionId, cookies) {
  const songList = dict && dict.songList;
  const item = Array.isArray(songList) ? songList[0] : null;
  const metadata = (item && item.metadata) || {};
  const requested = String(externalVersionId === undefined || externalVersionId === null ? "" : externalVersionId);
  const actual = String(metadata.softwareVersionExternalIdentifier || "");
  if (requested && actual && requested !== actual) {
    throw new DownloadError("响应版本与请求版本不匹配", "version_mismatch", cookies);
  }
  return {
    // id 供历史列表发起请求；实际响应身份单独保存，不能由请求补齐。
    id: requested || actual,
    requestedExternalVersionId: requested,
    externalVersionId: actual,
    displayVersion: String(
      metadata.bundleShortVersionString || metadata.displayVersion || ""
    ),
    buildVersion: String(metadata.bundleVersion || metadata.buildVersion || ""),
  };
}

// 只读取指定版本的元数据，不要求响应中包含可下载的 sinf/URL。
// Apple 对历史版本的下载信息在不同区域返回字段不完全一致，因此这里
// 保留空版本号，由 UI 明确显示“版本号未知”，而不是猜测内部 ID。
function getVersionMetadata(account, app, externalVersionId, options) {
  return downloadInfoCall(account, app, externalVersionId, options, result => ({
    ...metadataFromDict(result.dict, externalVersionId, result.cookies),
    updatedCookies: result.cookies,
  }));
}

function normalizeNumericVersionPart(value) {
  const normalized = String(value).replace(/^0+(?=\d)/, "");
  return normalized || "0";
}

function compareNumericVersionParts(left, right) {
  const a = normalizeNumericVersionPart(left);
  const b = normalizeNumericVersionPart(right);
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

// CFBundleShortVersionString 通常是点分数字；同时兼容常见的 SemVer
// 预发布后缀。使用字符串比较数字段，避免超大版本段超过 JS 安全整数。
function parseSemanticVersion(value) {
  const match = String(value || "")
    .trim()
    .match(/^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: match[1].split("."),
    prerelease: match[2] ? match[2].split(".") : null,
  };
}

function compareSemanticVersions(left, right) {
  const coreLength = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < coreLength; i++) {
    const result = compareNumericVersionParts(
      left.core[i] === undefined ? "0" : left.core[i],
      right.core[i] === undefined ? "0" : right.core[i]
    );
    if (result) return result;
  }

  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  const prereleaseLength = Math.max(
    left.prerelease.length,
    right.prerelease.length
  );
  for (let i = 0; i < prereleaseLength; i++) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return compareNumericVersionParts(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function sortVersions(versions, latestId) {
  const latest = String(latestId || "");
  return versions
    .map((version, index) => ({
      version,
      index,
      parsed: parseSemanticVersion(version && version.displayVersion),
      latest: latest && String(version && version.id || "") === latest,
    }))
    .sort((left, right) => {
      if (left.latest !== right.latest) return left.latest ? -1 : 1;
      if (left.parsed && right.parsed) {
        const result = compareSemanticVersions(left.parsed, right.parsed);
        if (result) return -result;
      } else if (left.parsed || right.parsed) {
        return left.parsed ? -1 : 1;
      }
      // 明确用原始下标兜底，避免依赖不同 JSBox 版本的 sort 稳定性。
      return left.index - right.index;
    })
    .map((entry) => entry.version);
}

function versionDisplayFields(version) {
  return {
    id: String(version.id || ""),
    requestedExternalVersionId: String(version.requestedExternalVersionId || ""),
    externalVersionId: String(version.externalVersionId || ""),
    displayVersion: String(version.displayVersion || ""),
    buildVersion: String(version.buildVersion || ""),
  };
}

// 版本列表（需已购买）。可选增量快照固定 ID 顺序，最终结果保留语义排序。
async function listVersions(account, app, initialInfo, options) {
  const opts = options || {};
  const initialCookies = cookieLib.mergeCookies(Array.isArray(account.cookies) ? account.cookies : [], []);
  const mergeInitialCookies = cookieUpdateMerger(initialCookies);
  if (!initialInfo) assertVersionListContinues(opts, initialCookies);
  let info;
  try {
    info = initialInfo || await getDownloadInfo(account, app, undefined, opts);
  } catch (err) {
    err.updatedCookies = mergeInitialCookies(err.updatedCookies || []);
    assertVersionListContinues(opts, err.updatedCookies);
    throw err;
  }
  let updatedCookies = mergeInitialCookies(info.updatedCookies || []);
  assertVersionListContinues(opts, updatedCookies);
  const rawIdentifiers = Array.isArray(info.versionIdentifiers)
    ? info.versionIdentifiers
    : info.versionIdentifiers
    ? [info.versionIdentifiers]
    : [];
  const identifiers = rawIdentifiers.map((v) => String(v)).filter(Boolean);
  const latestId = info.latestVersionIdentifier
    ? String(info.latestVersionIdentifier)
    : identifiers.length
    ? identifiers[identifiers.length - 1]
    : "";
  const ids = Array.from(new Set(
    // Apple 的列表通常按旧到新返回；IPA 3.0 同样先反转列表。
    // latestId 单独置顶也兼容它未出现在历史数组中的响应。
    (latestId ? [latestId] : []).concat(identifiers.slice().reverse())
  ));
  const latestMetadata = metadataFromDict(
    {
      songList: [{ metadata: {
        bundleShortVersionString: info.bundleShortVersionString,
        bundleVersion: info.bundleVersion,
        softwareVersionExternalIdentifier: info.externalVersionId || "",
      } }],
    },
    latestId,
    updatedCookies
  );
  const workingAccount = Object.assign({}, account, {
    cookies: updatedCookies,
  });
  const known = new Map();
  for (const value of Array.isArray(opts.knownVersions) ? opts.knownVersions : []) {
    if (!value || typeof value !== "object") continue;
    const version = versionDisplayFields(value);
    if (!ids.includes(version.id) || known.has(version.id)) continue;
    if (version.requestedExternalVersionId && version.requestedExternalVersionId !== version.id) continue;
    if (version.externalVersionId && version.externalVersionId !== version.id) continue;
    version.requestedExternalVersionId = version.id;
    known.set(version.id, version);
  }
  const resolved = new Set();
  const versions = ids.map(id => {
    const version = id === latestId && (latestMetadata.displayVersion || latestMetadata.buildVersion)
      ? latestMetadata
      : known.get(id);
    if (version) resolved.add(id);
    return version || versionDisplayFields({ id, requestedExternalVersionId: id });
  });
  function publish() {
    if (typeof opts.onVersions !== "function") return;
    const snapshot = Object.freeze({
      versions: Object.freeze(versions.map(value => Object.freeze(versionDisplayFields(value)))),
      latest: latestId,
      resolvedIds: Object.freeze(ids.filter(id => resolved.has(id))),
      resolvedCount: resolved.size,
      totalCount: ids.length,
      complete: resolved.size === ids.length,
    });
    try {
      const result = opts.onVersions(snapshot);
      // 展示回调既不能改写协议数据，也不能因同步/异步异常中断请求。
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
    } catch (_err) {}
  }
  publish();

  // 顺序读取，避免同一账号的 Cookie 更新在并发请求中互相覆盖。
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    if (resolved.has(id)) continue;
    assertVersionListContinues(opts, updatedCookies);
    const mergeVersionCookies = cookieUpdateMerger(updatedCookies);
    try {
      const version = await getVersionMetadata(workingAccount, app, id, opts);
      updatedCookies = mergeVersionCookies(version.updatedCookies || []);
      workingAccount.cookies = updatedCookies;
      assertVersionListContinues(opts, updatedCookies);
      versions[index] = version;
      resolved.add(id);
      publish();
    } catch (err) {
      err.updatedCookies = mergeVersionCookies(err.updatedCookies || []);
      assertVersionListContinues(opts, err.updatedCookies);
      throw err;
    }
  }
  assertVersionListContinues(opts, updatedCookies);

  return {
    identifiers,
    latest: latestId,
    versions: sortVersions(versions, latestId),
    updatedCookies,
  };
}

module.exports = {
  getDownloadInfo,
  getVersionMetadata,
  metadataFromDict,
  sortVersions,
  listVersions,
  assertVersionListContinues,
  DownloadError,
};
