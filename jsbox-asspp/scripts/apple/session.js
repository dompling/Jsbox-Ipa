// 会话保鲜：账号会话被 Apple 判定失效（2034/2042 或“登录已过期”）时，
// 若该账号在登录时开启「记住密码」，这里用 Keychain 里保存的密码自动重新
// 签名登录（auth.authenticate），把新会话写回本地并让调用方重试一次，实现
// “无感重登”——不再需要用户手动去账号页重跑一遍登录流程。
//
// 说明：自动重登沿用与首次登录一致的多候选/签名流程。若 Apple 罕见地要求
// 六位双重认证验证码（codeRequired），不会死循环或偷偷失败，而是返回
// refreshable:false，交由上层走原有“请重新登录”提示。

const auth = require("./auth");
const accounts = require("../store/accounts");
const settings = require("../store/settings");
const deviceStore = require("../store/device");
const { isSessionExpiredError } = require("../lib/error");

function enabledFor(account) {
  return !!(account && account.autoRelogin);
}

// 尝试用已保存密码刷新账号会话。返回：
//   { refreshable:true, account }                成功，account 为新会话
//   { refreshable:false, reason:"no-secret" }    未开启记住密码/无密码
//   { refreshable:false, reason:"code-required" }需要两步验证码，无法静默
//   { refreshable:false, reason:"auth-failed" }  密码错误/账号停用等
async function refreshAccount(account) {
  const email = accounts.normalizeEmail(account && account.email);
  if (!email) return { refreshable: false, reason: "no-account" };
  const stored = accounts.getAccount(email);
  if (!enabledFor(account) && !enabledFor(stored)) {
    return { refreshable: false, reason: "no-secret" };
  }
  const password = accounts.getAutoLoginPassword(email);
  if (!password) return { refreshable: false, reason: "no-secret" };

  const source = account && (account.deviceIdentifier || account.cookies)
    ? account
    : stored;
  const deviceId =
    (source && source.deviceIdentifier) || deviceStore.getDeviceIdentifier();
  try {
    const fresh = await auth.authenticate({
      email,
      password,
      deviceId,
      existingCookies: source ? source.cookies : [],
      authURLOverride: settings.effectiveAuthURLOverride(),
      // 与首次登录一致：优先固定带 SAP 签名的 scripting pod 入口。
      preferScriptingEndpoint: true,
    });
    // 合并保留 autoRelogin 与旧展示字段，passwordToken/Cookie/区域以新会话为准。
    const merged = Object.assign({}, stored || {}, fresh, {
      email: accounts.normalizeEmail(email),
      autoRelogin: true,
    });
    accounts.saveAccount(merged);
    return { refreshable: true, account: merged };
  } catch (err) {
    if (err instanceof auth.AuthenticationError && err.codeRequired) {
      return { refreshable: false, reason: "code-required" };
    }
    return { refreshable: false, reason: "auth-failed" };
  }
}

// 运行 run(account)；若 run 因会话失效抛错，且账号可自动重登，则刷新会话后
// 用新会话把 run 重跑一次。仍失败或不可自动重登时抛出原错误。
async function withFreshSession(account, run) {
  try {
    return await run(account);
  } catch (err) {
    if (!isSessionExpiredError(err)) throw err;
    const refreshed = await refreshAccount(account);
    if (!refreshed.refreshable) throw err;
    return await run(refreshed.account);
  }
}

module.exports = {
  enabledFor,
  refreshAccount,
  withFreshSession,
};
