// 多账号存储：
// - 邮箱索引与“区域 -> 邮箱”绑定存 $prefs
// - token、cookies、DSID、设备 GUID 等完整会话存 $keychain
// - Apple ID 明文密码只在当前登录流程内存中使用，不做持久化
// - v2 明文 prefs 数据会在首次读取时迁移到 Keychain

const config = require("../config");

const LEGACY_PREFS_KEY = "jasspp.accounts.v2";
const INDEX_KEY = "jasspp.accounts.v3";
const ACTIVE_KEY = "jasspp.activeAccounts.v1";
const REGION_KEY = "jasspp.region";
const KEYCHAIN_DOMAIN = "com.jasspp.account";
const ACCOUNT_PREFIX = "account.";
const LEGACY_PASSWORD_PREFIX = "password.";
// 仅当用户开启「记住密码 / 失效自动重新登录」时，把明文 Apple ID 密码写进
// 独立的 Keychain 键。与 LEGACY_PASSWORD_PREFIX（旧版要清理的残留）不同名，
// 避免 readAll() 的 cleanupLegacyPasswords() 每次读取都把它误删。该键不会
// 被当成账号会话枚举；删除/清空账号时随域清理。
const AUTOLOGIN_PREFIX = "autologin.";
const cookieLib = require("../lib/cookies");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// 旧版本有时把 storefront 数字或完整的 `143465-1,29` 头直接写进了
// `store` 字段。统一成国家代码，保留独立的 storeFrontId 供 Apple 请求使用，
// 这样区域绑定、下载和设置页不会把同一个账号误判成“跨区”。
function normalizeStore(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const storeId = config.normalizeStoreFrontId(raw);
  return config.storeIdToCountry(storeId) || raw.toUpperCase();
}

function accountRegion(account) {
  const store = normalizeStore(account && account.store);
  if (store && config.COUNTRY_STORE_MAP[store]) return store;
  const storeFrontId =
    config.normalizeStoreFrontId(account && account.storeFrontHeader) ||
    config.normalizeStoreFrontId(account && account.storeFront) ||
    config.normalizeStoreFrontId(account && account.storeFrontId) ||
    config.normalizeStoreFrontId(account && account.store);
  return config.storeIdToCountry(storeFrontId) || "";
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function setPref(key, value) {
  if ($prefs.set(key, value) === false) {
    throw new Error("保存账号索引失败");
  }
}

function restorePrefs(snapshots) {
  for (const snapshot of snapshots || []) {
    try {
      $prefs.set(snapshot.key, clone(snapshot.value));
    } catch (_e) {}
  }
}

// $prefs 与 Keychain 没有跨存储事务。所有多步更新都保留快照并在失败时
// 尽力恢复，避免出现“列表仍有账号、会话却已丢失”的半提交状态。
function applyPrefs(updates) {
  const snapshots = updates.map((item) => ({
    key: item.key,
    value: clone($prefs.get(item.key)),
  }));
  try {
    for (const item of updates) setPref(item.key, item.value);
  } catch (err) {
    restorePrefs(snapshots);
    throw err;
  }
  return () => restorePrefs(snapshots);
}

function accountKey(email) {
  return `${ACCOUNT_PREFIX}${normalizeEmail(email)}`;
}

function keychainKeys(required) {
  if (!$keychain.keys) {
    if (required) throw new Error("当前 JSBox 不支持安全枚举钥匙串");
    return null;
  }
  try {
    return $keychain.keys(KEYCHAIN_DOMAIN) || [];
  } catch (err) {
    if (required) throw new Error("读取钥匙串索引失败");
    return null;
  }
}

function secureAccountEmails(keys) {
  const source = keys === undefined ? keychainKeys() || [] : keys || [];
  return source
    .filter((key) => String(key).startsWith(ACCOUNT_PREFIX))
    .map((key) => normalizeEmail(String(key).slice(ACCOUNT_PREFIX.length)))
    .filter(Boolean);
}

function normalizeIndex(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const emails = [];
  for (const item of raw) {
    const email = normalizeEmail(typeof item === "string" ? item : item && item.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function readIndex() {
  const raw = $prefs.get(INDEX_KEY);
  const keys = keychainKeys();
  const secureEmails = secureAccountEmails(keys);
  const legacyEmails = normalizeIndex(legacyRawEmails());
  const available = new Set([...secureEmails, ...legacyEmails]);
  // keys() 可用时顺手剔除没有任何会话/旧记录的幽灵索引。
  const recovered = normalizeIndex(raw).filter(
    (email) => keys === null || available.has(email)
  );
  // 每次都与可枚举的 Keychain 会话合并：若上次运行在“会话已写入、索引
  // 尚未提交”之间退出，账号仍能恢复。密码键不会被当成账号。
  for (const email of [...secureEmails, ...legacyEmails]) {
    if (!recovered.includes(email)) recovered.push(email);
  }
  return normalizeIndex(recovered);
}

function legacyRawEmails() {
  const raw = $prefs.get(LEGACY_PREFS_KEY);
  return Array.isArray(raw) ? raw.map((item) => item && item.email) : [];
}

function cleanupLegacyPasswords() {
  for (const key of keychainKeys() || []) {
    if (!String(key).startsWith(LEGACY_PASSWORD_PREFIX)) continue;
    try {
      $keychain.remove(key, KEYCHAIN_DOMAIN);
    } catch (_e) {}
  }
}

function restoreKeychain(items) {
  for (const item of items || []) {
    try {
      $keychain.set(item.key, item.value, KEYCHAIN_DOMAIN);
    } catch (_e) {}
  }
}

function snapshotKeychain() {
  const snapshots = [];
  for (const key of keychainKeys(true)) {
    const value = $keychain.get(key, KEYCHAIN_DOMAIN);
    if (value !== undefined && value !== null) snapshots.push({ key, value });
  }
  return snapshots;
}

function writeIndex(emails) {
  const seen = new Set();
  const normalized = [];
  for (const value of emails || []) {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    normalized.push(email);
  }
  setPref(INDEX_KEY, normalized);
}

function normalizeAccount(account) {
  if (!account || !account.email) return null;
  const rawStore = String(account.store || "").trim();
  const rawStoreFrontHeader =
    config.normalizeStoreFrontHeader(account.storeFrontHeader) ||
    config.normalizeStoreFrontHeader(account.storeFront);
  const legacyStoreFrontHeader = config.normalizeStoreFrontHeader(rawStore);
  const storeFrontId =
    config.normalizeStoreFrontId(account.storeFrontId) ||
    config.normalizeStoreFrontId(rawStoreFrontHeader) ||
    config.normalizeStoreFrontId(legacyStoreFrontHeader) ||
    config.normalizeStoreFrontId(rawStore);
  const store =
    normalizeStore(rawStore) || config.storeIdToCountry(storeFrontId) || "";
  const stored = Object.assign({}, account, {
    email: normalizeEmail(account.email),
    store,
    storeFrontId: String(storeFrontId || ""),
    // 保留 Apple 返回的完整 storefront 头；旧记录只有数字 ID 时也保留
    // 数字形式，后续请求会按接口需要补后缀。
    storeFrontHeader:
      rawStoreFrontHeader || legacyStoreFrontHeader || String(storeFrontId || ""),
    pod: config.normalizePod(account.pod),
    directoryServicesIdentifier:
      account.directoryServicesIdentifier === undefined ||
      account.directoryServicesIdentifier === null
        ? ""
        : String(account.directoryServicesIdentifier),
    deviceIdentifier: String(account.deviceIdentifier || "").trim().toUpperCase(),
    cookies: cookieLib.mergeCookies(
      [],
      Array.isArray(account.cookies) ? account.cookies : []
    ),
  });
  delete stored.password;
  return stored;
}

function readSecureAccount(email) {
  const raw = $keychain.get(accountKey(email), KEYCHAIN_DOMAIN);
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = normalizeAccount(JSON.parse(raw));
    return parsed && parsed.email === normalizeEmail(email) ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function writeSecureAccount(account) {
  const stored = normalizeAccount(account);
  if (!stored) throw new Error("账号缺少 email");
  const ok = $keychain.set(
    accountKey(stored.email),
    JSON.stringify(stored),
    KEYCHAIN_DOMAIN
  );
  if (ok === false) throw new Error("无法把账号会话写入钥匙串");
  return stored;
}

function legacyAccounts() {
  const raw = $prefs.get(LEGACY_PREFS_KEY);
  return Array.isArray(raw) ? raw.map(normalizeAccount).filter(Boolean) : [];
}

function migrateLegacyAccounts() {
  const legacy = legacyAccounts();
  if (!legacy.length) return;
  const index = readIndex();
  let complete = true;
  for (const account of legacy) {
    try {
      const rawSecure = $keychain.get(accountKey(account.email), KEYCHAIN_DOMAIN);
      const current = readSecureAccount(account.email);
      // 已有安全会话优先，旧 prefs 只能补充缺失展示字段，不能覆盖更新的
      // token/Cookie。损坏的安全记录也不覆盖，留给“需要修复”入口处理。
      if (rawSecure !== undefined && rawSecure !== null && !current) {
        complete = false;
        if (!index.includes(account.email)) index.push(account.email);
        continue;
      }
      writeSecureAccount(current ? Object.assign({}, account, current) : account);
      if (!index.includes(account.email)) index.push(account.email);
    } catch (_e) {
      complete = false;
    }
  }
  if (index.length) writeIndex(index);
  if (complete) setPref(LEGACY_PREFS_KEY, []);
}

function readAll() {
  cleanupLegacyPasswords();
  migrateLegacyAccounts();
  const result = [];
  const seen = new Set();
  const index = readIndex();
  const rawIndex = $prefs.get(INDEX_KEY);
  if (JSON.stringify(normalizeIndex(rawIndex)) !== JSON.stringify(index)) {
    // 修复索引失败不应阻止读取已经安全保存在 Keychain 的会话。
    try {
      writeIndex(index);
    } catch (_e) {}
  }
  for (const email of index) {
    const account = readSecureAccount(email);
    if (!account || seen.has(account.email)) continue;
    seen.add(account.email);
    result.push(account);
  }
  // Keychain 写入失败时保留并临时读取旧数据，避免迁移过程造成账号消失。
  for (const account of legacyAccounts()) {
    if (seen.has(account.email)) continue;
    seen.add(account.email);
    result.push(account);
  }
  return result;
}

function storageIssues() {
  const candidates = normalizeIndex([
    ...readIndex(),
    ...secureAccountEmails(),
  ]);
  const issues = [];
  for (const email of candidates) {
    const raw = $keychain.get(accountKey(email), KEYCHAIN_DOMAIN);
    if (!raw) continue;
    if (!readSecureAccount(email)) {
      issues.push({ email, type: "corrupt-session" });
    }
  }
  return issues;
}

function listAccounts() {
  return clone(readAll());
}

function getAccount(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  const secure = readSecureAccount(key);
  if (secure) return clone(secure);
  const legacy = legacyAccounts().find((acc) => acc.email === key);
  return legacy ? clone(legacy) : null;
}

function saveAccount(account) {
  const normalizedEmail = normalizeEmail(account && account.email);
  if (!normalizedEmail) throw new Error("账号缺少 email");

  const previousRaw = $keychain.get(accountKey(normalizedEmail), KEYCHAIN_DOMAIN);
  const existing =
    readSecureAccount(normalizedEmail) ||
    legacyAccounts().find((item) => item.email === normalizedEmail) ||
    {};
  const stored = normalizeAccount(
    Object.assign({}, existing, account, { email: normalizedEmail })
  );

  let rollbackPrefs = null;
  try {
    writeSecureAccount(stored);
    const index = readIndex();
    if (!index.includes(normalizedEmail)) index.push(normalizedEmail);
    const legacy = legacyAccounts();
    const remainingLegacy = legacy.filter((item) => item.email !== normalizedEmail);
    const updates = [{ key: INDEX_KEY, value: index }];
    if (remainingLegacy.length !== legacy.length) {
      updates.push({ key: LEGACY_PREFS_KEY, value: remainingLegacy });
    }
    rollbackPrefs = applyPrefs(updates);
    return clone(stored);
  } catch (err) {
    if (rollbackPrefs) rollbackPrefs();
    if (previousRaw !== undefined && previousRaw !== null) {
      $keychain.set(accountKey(normalizedEmail), previousRaw, KEYCHAIN_DOMAIN);
    } else {
      $keychain.remove(accountKey(normalizedEmail), KEYCHAIN_DOMAIN);
    }
    throw err;
  }
}

function autoLoginKey(email) {
  return `${AUTOLOGIN_PREFIX}${normalizeEmail(email)}`;
}

// 保存用于“失效自动重新登录”的 Apple ID 密码。传入空值表示清除。
function saveAutoLoginPassword(email, password) {
  const key = autoLoginKey(email);
  if (!$keychain || typeof $keychain.set !== "function") {
    throw new Error("当前 JSBox 不支持安全保存登录凭据");
  }
  if (!password) {
    removeAutoLoginPassword(email);
    return true;
  }
  const ok = $keychain.set(key, String(password), KEYCHAIN_DOMAIN);
  if (ok === false) throw new Error("无法把登录凭据写入钥匙串");
  return true;
}

// 读取用于自动重登的密码；未开启/未保存时返回 null。
function getAutoLoginPassword(email) {
  const key = autoLoginKey(email);
  if (!$keychain || typeof $keychain.get !== "function") return null;
  try {
    const value = $keychain.get(key, KEYCHAIN_DOMAIN);
    return value === undefined || value === null ? null : String(value);
  } catch (_e) {
    return null;
  }
}

function removeAutoLoginPassword(email) {
  const key = autoLoginKey(email);
  if (!$keychain || typeof $keychain.remove !== "function") return;
  try {
    if ($keychain.get(key, KEYCHAIN_DOMAIN) !== undefined) {
      $keychain.remove(key, KEYCHAIN_DOMAIN);
    }
  } catch (_e) {}
}

function activeMap() {
  const value = $prefs.get(ACTIVE_KEY);
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.assign({}, value)
    : {};
}

function removeAccount(email) {
  const key = normalizeEmail(email);
  if (!key) return false;
  const secureKey = accountKey(key);
  const legacyPasswordKey = `${LEGACY_PASSWORD_PREFIX}${key}`;
  const autoLoginKeyName = autoLoginKey(key);
  const previousAccount = $keychain.get(secureKey, KEYCHAIN_DOMAIN);
  const previousPassword = $keychain.get(legacyPasswordKey, KEYCHAIN_DOMAIN);
  const previousAutoLogin = $keychain.get(autoLoginKeyName, KEYCHAIN_DOMAIN);
  const active = activeMap();
  for (const region of Object.keys(active)) {
    if (normalizeEmail(active[region]) === key) delete active[region];
  }

  const updates = [
    { key: INDEX_KEY, value: readIndex().filter((item) => item !== key) },
    {
      key: LEGACY_PREFS_KEY,
      value: legacyAccounts().filter((item) => item.email !== key),
    },
    { key: ACTIVE_KEY, value: active },
  ];

  try {
    if (
      previousAccount !== undefined &&
      previousAccount !== null &&
      $keychain.remove(secureKey, KEYCHAIN_DOMAIN) === false
    ) {
      throw new Error("删除钥匙串账号会话失败");
    }
    if (
      previousPassword !== undefined &&
      previousPassword !== null &&
      $keychain.remove(legacyPasswordKey, KEYCHAIN_DOMAIN) === false
    ) {
      throw new Error("删除旧版钥匙串密码失败");
    }
    if (previousAutoLogin !== undefined && previousAutoLogin !== null) {
      $keychain.remove(autoLoginKeyName, KEYCHAIN_DOMAIN);
    }
    applyPrefs(updates);
  } catch (err) {
    if (previousAccount !== undefined && previousAccount !== null) {
      $keychain.set(secureKey, previousAccount, KEYCHAIN_DOMAIN);
    }
    if (previousPassword !== undefined && previousPassword !== null) {
      $keychain.set(legacyPasswordKey, previousPassword, KEYCHAIN_DOMAIN);
    }
    if (previousAutoLogin !== undefined && previousAutoLogin !== null) {
      $keychain.set(autoLoginKeyName, previousAutoLogin, KEYCHAIN_DOMAIN);
    }
    throw err;
  }
  return true;
}

function clearAccounts() {
  const snapshots = snapshotKeychain();
  const updates = [
    { key: INDEX_KEY, value: [] },
    { key: LEGACY_PREFS_KEY, value: [] },
    { key: ACTIVE_KEY, value: {} },
  ];
  try {
    const ok = $keychain.clear(KEYCHAIN_DOMAIN);
    if (ok === false) throw new Error("清除钥匙串账号失败");
    applyPrefs(updates);
  } catch (err) {
    restoreKeychain(snapshots);
    throw err;
  }
}

function activeEmailForRegion(region) {
  return normalizeEmail(activeMap()[String(region || "").toUpperCase()]);
}

function setActiveForRegion(region, email) {
  const code = String(region || "").toUpperCase();
  if (!code) throw new Error("缺少区域");
  const active = activeMap();
  const normalized = normalizeEmail(email);
  if (normalized) {
    const account = getAccount(normalized);
    if (!account) throw new Error("找不到要绑定的账号");
    if (accountRegion(account) !== code) {
      throw new Error(`账号区域不匹配：需要 ${code} 区账号`);
    }
    // 一个 Apple ID 只属于一个 storefront；清掉旧区域的遗留绑定，
    // 避免切换账号后两个区域同时指向同一会话。
    for (const boundRegion of Object.keys(active)) {
      if (normalizeEmail(active[boundRegion]) === normalized) {
        delete active[boundRegion];
      }
    }
    active[code] = normalized;
  } else delete active[code];
  setPref(ACTIVE_KEY, active);
}

// 激活账号时以 Apple 登录响应保存的 storefront 为准，同时切换全局当前区域。
// 这是登录和快速切换账号共用的入口，避免“当前选 CN、实际账号是 US”时继续
// 使用错误的区域请求头或把账号绑定到错误区域。
function activateAccount(email) {
  const normalized = normalizeEmail(email);
  const account = getAccount(normalized);
  if (!account) throw new Error("找不到要激活的账号");

  const code = accountRegion(account);
  if (!code || !config.COUNTRY_STORE_MAP[code]) {
    throw new Error("账号缺少有效的 App Store 区域，请重新登录");
  }

  const active = activeMap();
  for (const boundRegion of Object.keys(active)) {
    if (normalizeEmail(active[boundRegion]) === normalized) {
      delete active[boundRegion];
    }
  }
  active[code] = normalized;

  // $prefs 没有事务；统一用 applyPrefs，区域或活动账号任一写入失败时
  // 两者都会恢复到修改前的状态。
  applyPrefs([
    { key: REGION_KEY, value: code },
    { key: ACTIVE_KEY, value: active },
  ]);
  return clone(account);
}

// 为区域选择账号：只返回明确绑定或 storefront 匹配的账号，绝不静默跨区。
function accountForRegion(region) {
  const code = String(region || "").toUpperCase();
  const all = readAll();
  if (!all.length) return null;
  const activeEmail = activeEmailForRegion(code);
  if (activeEmail) {
    const found = all.find((acc) => acc.email === activeEmail);
    if (found && accountRegion(found) === code) {
      return clone(found);
    }
  }
  const matched = all.find((acc) => accountRegion(acc) === code);
  if (matched) return clone(matched);
  return null;
}

function requireAccountForRegion(region) {
  const account = accountForRegion(region);
  if (!account) {
    const code = String(region || "").toUpperCase();
    const err = new Error(`该设备还没有可用的 ${code} 区账号，请先在“账号”中添加`);
    err.noAccount = true;
    throw err;
  }
  return account;
}

module.exports = {
  listAccounts,
  getAccount,
  saveAccount,
  removeAccount,
  clearAccounts,
  activeEmailForRegion,
  setActiveForRegion,
  activateAccount,
  accountForRegion,
  requireAccountForRegion,
  normalizeEmail,
  normalizeStore,
  accountRegion,
  saveAutoLoginPassword,
  getAutoLoginPassword,
  removeAutoLoginPassword,
  storageIssues,
};
