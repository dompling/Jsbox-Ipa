// 统一的安装入口。
// OTA 需实际验证 IPA 的 App 身份和构建号；授权注入不能替代元数据验证。

const common = require("./common");
const library = require("../store/library");
const ota = require("../services/ota");
const otaMetadata = require("../lib/ota-manifest");

function unavailableReason(record) {
  if (!record || !record.fileName) return "找不到 IPA 文件记录";
  if (record.recovered) return "这个 IPA 缺少可信元数据，只能先分享或重新下载";
  if (!record.packageVerified) return "这个 IPA 尚未通过 Payload/Info.plist 结构校验，请重新下载";
  if (record.metadataVerified !== true) return "这个 IPA 的身份和构建版本尚未验证，请重新验证或重新下载";
  if (!record.bundleId) return "缺少 Bundle ID，不能生成安装清单";
  if (!record.bundleVersion) return "缺少真实 CFBundleVersion，不能生成安装清单";
  try {
    otaMetadata.validateBundleId(record.bundleId);
    if (otaMetadata.validateVersion(record.bundleVersion) !== record.bundleVersion) return "构建版本无效，不能生成安装清单";
  } catch (_err) {
    return "Bundle ID 或构建版本无效，不能生成安装清单";
  }
  return "";
}

function share(record) {
  try {
    library.share(record.fileName);
  } catch (err) {
    common.alertError(err);
  }
}

function prompt(record) {
  const unavailable = unavailableReason(record);
  if (unavailable) {
    common.alert({
      title: "暂不能尝试 OTA",
      message: `${unavailable}。\n\n你仍可把 IPA 分享到文件 App、AltStore、TrollStore 或其他签名工具。`,
      actions: [
        { title: "分享 IPA", handler: () => share(record) },
        { title: "取消" },
      ],
    });
    return;
  }

  common.alert({
    title: "实验性 OTA 安装",
    message:
      "将按 IPA-Tool-3.0 的方式通过 HTTPS Plist 服务生成安装清单，本地 IPA 文件由 JSBox 的 8000 端口提供。若系统仍提示无法连接或无法验证，这是 iOS 对本地 HTTP / 原始 App Store IPA 的限制。\n\n建议优先分享 IPA 到其他签名或安装工具。",
    actions: [
      { title: "仍然尝试", handler: () => launch(record) },
      { title: "分享 IPA", handler: () => share(record) },
      { title: "取消" },
    ],
  });
}

async function launch(record) {
  if (unavailableReason(record)) {
    prompt(record);
    return;
  }
  const handle = await common.runWithLoading("正在启动安装服务…", async () => {
    return await ota.installToDevice({
      fileName: record.fileName,
      bundleId: record.bundleId,
      bundleVersion: record.bundleVersion,
      title: record.title || record.fileName,
    });
  });
  if (!handle) return;

  common.alert({
    title: "已打开安装清单",
    message:
      "这不代表已经安装成功。请查看 iOS 后续提示；不要从多任务界面关闭 JSBox。本地服务固定运行在 8000 端口，并会在 15 分钟后自动停止。若出现“无法连接 127.0.0.1”，请返回并选择“分享 IPA”。",
    actions: [
      {
        title: "停止本地服务",
        style:
          typeof $alertActionType !== "undefined"
            ? $alertActionType.destructive
            : undefined,
        handler: () => {
          ota.stopActive();
          common.toast("本地安装服务已停止");
        },
      },
      { title: "分享 IPA", handler: () => share(record) },
      { title: "知道了" },
    ],
  });
}

// info 是下载流程的完整结果（含 original / injected / injectFailed）。
// 注入失败时 record 会回落到未注入的原始包，这里把“可再次尝试”的入口
// 一起提示给用户，避免以为自动生成的授权副本失败后没有补救办法。
function downloadComplete(record, info) {
  const retryHint =
    info && info.injected === false && info.injectFailed
      ? "\n\nSINF 注入失败，原始包已归档，可在“归档”中点按“修复授权”重试。"
      : "";
  common.alert({
    title: "下载完成",
    message: `已保存：${record.fileName}${retryHint}\n建议分享至“文件”或其他位置留作备份。`,
    actions: [
      { title: "OTA 安装", handler: () => prompt(record) },
      { title: "分享 IPA", handler: () => share(record) },
      { title: "好" },
    ],
  });
}

module.exports = {
  prompt,
  launch,
  share,
  downloadComplete,
  unavailableReason,
};
