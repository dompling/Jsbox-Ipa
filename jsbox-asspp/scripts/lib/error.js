// 错误消息归一化（JSBox error 对象字段见 docs.xteko.com object/error）。
// 原生 NSError 经 JSBox bridge 传回时通常没有 message，直接 String(error)
// 只会得到“[object NSError]”，需要优先读取本地化字段和 domain/code。

function readField(value, key) {
  try {
    const field = value && value[key];
    if (typeof field === "function") return field.call(value);
    return field;
  } catch (_e) {
    return undefined;
  }
}

function errorMessage(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;

  const nested = readField(err, "error");
  if (nested && nested !== err) {
    const nestedMessage = errorMessage(nested);
    if (nestedMessage && nestedMessage !== "未知错误") return nestedMessage;
  }

  for (const key of [
    "localizedDescription",
    "localizedFailureReason",
    "localizedRecoverySuggestion",
    "message",
    "description",
    "reason",
  ]) {
    const value = readField(err, key);
    if (value && typeof value !== "object") return String(value);
  }

  const domain = readField(err, "domain");
  const code = readField(err, "code");
  if (domain || code !== undefined) {
    return `原生错误${domain ? `（${domain}）` : ""}${
      code !== undefined ? ` [${code}]` : ""
    }`;
  }

  try {
    const text = String(err);
    if (text && text !== "[object Object]" && text !== "[object NSError]") {
      return text.replace(/^Error:\s*/, "");
    }
  } catch (_e) {}
  return "原生请求失败，请稍后重试";
}

// 会话失效判定：Apple 购买/下载链路用 2034/2042 或“登录已过期”等文案
// 标记会话不可用。多个模块（已购列表、购买、下载）共用同一判定，作为
// “触发自动重新签名登录并重试一次”的门槛。
function isSessionExpiredError(err) {
  if (!err) return false;
  const code = err && err.code !== undefined ? String(err.code) : "";
  if (code === "2034" || code === "2042") return true;
  const message = errorMessage(err);
  if (/(?:^|[^0-9])(2034|2042)(?:[^0-9]|$)/.test(message)) return true;
  return /(登录已过期|登录过期|会话已过期|会话已失效)/.test(message);
}

module.exports = {
  errorMessage,
  isSessionExpiredError,
};
