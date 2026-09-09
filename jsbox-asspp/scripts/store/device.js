// Apple Store 请求使用的稳定设备 GUID。
// scripting 版把它持久化后复用；JSBox 中优先放入独立 Keychain domain，
// 只有旧版运行时不支持 Keychain 时才退回 prefs。GUID 本身不是密码，
// 但不应显示在日志、弹窗或分享内容中。

const format = require("../lib/format");

const DOMAIN = "com.jasspp.device";
const KEY = "store-guid.v1";
const PREF_KEY = "jasspp.device-guid.v1";
const HEX_RE = /^[0-9a-f]{12,32}$/i;

function valid(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return HEX_RE.test(normalized) ? normalized : "";
}

function readSecure() {
  try {
    if (typeof $keychain !== "undefined" && $keychain.get) {
      return valid($keychain.get(KEY, DOMAIN));
    }
  } catch (_e) {}
  return "";
}

function readPrefs() {
  try {
    if (typeof $prefs !== "undefined" && $prefs.get) return valid($prefs.get(PREF_KEY));
  } catch (_e) {}
  return "";
}

function write(value) {
  try {
    if (typeof $keychain !== "undefined" && $keychain.set) {
      const result = $keychain.set(KEY, value, DOMAIN);
      if (result !== false) {
        // 文档定义 set 返回成功状态；读回校验可以捕获“桥接调用没有真正落盘”。
        if (typeof $keychain.get !== "function" || readSecure() === value) {
          return value;
        }
      }
    }
  } catch (_e) {}
  try {
    if (typeof $prefs !== "undefined" && $prefs.set) {
      const result = $prefs.set(PREF_KEY, value);
      if (result !== false) {
        if (typeof $prefs.get !== "function" || readPrefs() === value) {
          return value;
        }
      }
    }
  } catch (_e) {}
  throw new Error("无法持久化设备标识，请检查 JSBox 存储权限后重试");
}

function getDeviceIdentifier() {
  const existing = readSecure() || readPrefs();
  if (existing) return existing;
  const generated = valid(format.generateDeviceId());
  if (!generated) throw new Error("无法生成有效的设备标识，请稍后重试");
  return write(generated);
}

module.exports = {
  getDeviceIdentifier,
  valid,
  DOMAIN,
  KEY,
  PREF_KEY,
};
