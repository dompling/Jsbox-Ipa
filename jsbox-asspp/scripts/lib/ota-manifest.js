// OTA 安装清单（Manifest.plist）构建（纯 JS，可在 Node 单测）。
// 结构参考 Asspp Installer+Compute.swift 与 Apple OTA 安装规范：
// itms-services://?action=download-manifest&url=<https|http 清单地址>

const plist = require("./plist");
const url = require("./url");

function escapeXML(str) {
  return plist.escapeXML(str);
}

function validateHttpUrl(value, label) {
  const parsed = url.parse(value);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`OTA 清单中的 ${label} 必须使用 http/https`);
  }
  if (!parsed.hostname) {
    throw new Error(`OTA 清单中的 ${label} 不是有效 URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`OTA 清单中的 ${label} 不能包含凭据`);
  }
  if (parsed.hash) {
    throw new Error(`OTA 清单中的 ${label} 不能包含片段`);
  }
  return parsed.toString();
}

function validateBundleId(value) {
  const bundleId = String(value || "").trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId) ||
    bundleId.includes("..") ||
    bundleId.endsWith(".")
  ) {
    throw new Error("OTA 清单中的 bundleId 无效");
  }
  return bundleId;
}

function validateVersion(value) {
  const version = String(value || "").trim();
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) {
    throw new Error("OTA 清单中的 bundle 版本无效");
  }
  return version.slice(0, 64);
}

// options: { ipaUrl, title, bundleId, version, iconSmallUrl?, iconLargeUrl? }
function buildOtaManifest(options) {
  if (!options || !options.ipaUrl || !options.bundleId) {
    throw new Error("OTA 清单缺少 ipaUrl / bundleId");
  }
  const ipaUrl = validateHttpUrl(options.ipaUrl, "ipaUrl");
  const bundleId = validateBundleId(options.bundleId);
  const assets = [
    {
      kind: "software-package",
      url: ipaUrl,
    },
  ];
  if (options.iconSmallUrl) {
    assets.push({
      kind: "display-image",
      url: validateHttpUrl(options.iconSmallUrl, "iconSmallUrl"),
    });
  }
  if (options.iconLargeUrl) {
    assets.push({
      kind: "full-size-image",
      url: validateHttpUrl(options.iconLargeUrl, "iconLargeUrl"),
    });
  }
  const manifest = {
    items: [
      {
        assets,
        metadata: {
          "bundle-identifier": bundleId,
          "bundle-version": validateVersion(options.version),
          kind: "software",
          title: options.title || options.bundleId,
        },
      },
    ],
  };
  return plist.buildPlist(manifest);
}

// 生成 itms-services 唤起链接。
function buildItmsUrl(manifestUrl) {
  const normalized = validateHttpUrl(manifestUrl, "manifestUrl");
  return (
    "itms-services://?action=download-manifest&url=" +
    encodeURIComponent(normalized)
  );
}

module.exports = {
  buildOtaManifest,
  buildItmsUrl,
  escapeXML,
  validateHttpUrl,
  validateBundleId,
  validateVersion,
};
