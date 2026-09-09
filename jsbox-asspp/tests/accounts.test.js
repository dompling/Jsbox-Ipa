const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

let prefs;
let keychain;
let failingPrefKey;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadStore() {
  delete require.cache[require.resolve("../scripts/store/accounts")];
  return require("../scripts/store/accounts");
}

beforeEach(() => {
  prefs = new Map();
  keychain = new Map();
  failingPrefKey = "";
  global.$prefs = {
    get: (key) => clone(prefs.get(key)),
    set: (key, value) => {
      if (key === failingPrefKey) return false;
      prefs.set(key, clone(value));
      return true;
    },
  };
  global.$keychain = {
    set: (key, value, domain) => {
      keychain.set(`${domain}:${key}`, String(value));
      return true;
    },
    get: (key, domain) => keychain.get(`${domain}:${key}`),
    remove: (key, domain) => keychain.delete(`${domain}:${key}`),
    clear: (domain) => {
      for (const key of [...keychain.keys()]) {
        if (key.startsWith(`${domain}:`)) keychain.delete(key);
      }
      return true;
    },
    keys: (domain) =>
      [...keychain.keys()]
        .filter((key) => key.startsWith(`${domain}:`))
        .map((key) => key.slice(domain.length + 1)),
  };
});

test("account sessions are stored in Keychain without retaining the plaintext password", () => {
  const store = loadStore();
  store.saveAccount({
    email: " User@Example.com ",
    password: "secret",
    passwordToken: "token",
    directoryServicesIdentifier: "123",
    cookies: [{ name: "session", value: "abc", domain: "itunes.apple.com" }],
    store: "US",
  });

  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), ["user@example.com"]);
  assert.strictEqual(prefs.has("jasspp.accounts.v2"), false);
  const serialized = keychain.get(
    "com.jasspp.account:account.user@example.com"
  );
  assert.match(serialized, /"passwordToken":"token"/);
  assert.doesNotMatch(serialized, /"password":/);
  assert.strictEqual(
    keychain.get("com.jasspp.account:password.user@example.com"),
    undefined
  );
  assert.strictEqual(store.getAccount("USER@example.com").store, "US");
});

test("legacy prefs accounts migrate to secure account records", () => {
  prefs.set("jasspp.accounts.v2", [
    {
      email: "legacy@example.com",
      passwordToken: "legacy-token",
      cookies: [],
      store: "CN",
    },
  ]);

  const store = loadStore();
  const accounts = store.listAccounts();

  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].passwordToken, "legacy-token");
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), ["legacy@example.com"]);
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v2"), []);
  assert.match(
    keychain.get("com.jasspp.account:account.legacy@example.com"),
    /legacy-token/
  );
});

test("clearAccounts clears session index, active bindings and Keychain", () => {
  const store = loadStore();
  store.saveAccount({ email: "one@example.com", password: "one", store: "US" });
  store.setActiveForRegion("US", "one@example.com");
  store.clearAccounts();

  assert.deepStrictEqual(store.listAccounts(), []);
  assert.deepStrictEqual(prefs.get("jasspp.activeAccounts.v1"), {});
  assert.strictEqual(keychain.size, 0);
});

test("removeAccount keeps credentials when account index update fails", () => {
  const store = loadStore();
  store.saveAccount({ email: "one@example.com", password: "one", store: "US" });
  store.setActiveForRegion("US", "one@example.com");
  failingPrefKey = "jasspp.accounts.v3";

  assert.throws(() => store.removeAccount("one@example.com"), /账号索引/);
  assert.ok(keychain.has("com.jasspp.account:account.one@example.com"));
  assert.strictEqual(
    keychain.get("com.jasspp.account:password.one@example.com"),
    undefined
  );
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), ["one@example.com"]);
});

test("clearAccounts rolls preferences back when Keychain clearing fails", () => {
  const store = loadStore();
  store.saveAccount({ email: "one@example.com", password: "one", store: "US" });
  store.setActiveForRegion("US", "one@example.com");
  global.$keychain.clear = () => false;

  assert.throws(() => store.clearAccounts(), /钥匙串/);
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), ["one@example.com"]);
  assert.deepStrictEqual(prefs.get("jasspp.activeAccounts.v1"), {
    US: "one@example.com",
  });
});

test("malformed account index is rebuilt from valid Keychain sessions", () => {
  prefs.set("jasspp.accounts.v3", { broken: true });
  keychain.set(
    "com.jasspp.account:account.saved@example.com",
    JSON.stringify({ email: "saved@example.com", store: "CN", cookies: [] })
  );
  const store = loadStore();

  assert.strictEqual(store.listAccounts()[0].email, "saved@example.com");
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), ["saved@example.com"]);
});

test("an incomplete account index is reconciled with Keychain sessions", () => {
  prefs.set("jasspp.accounts.v3", ["first@example.com"]);
  keychain.set(
    "com.jasspp.account:account.first@example.com",
    JSON.stringify({ email: "first@example.com", store: "US", cookies: [] })
  );
  keychain.set(
    "com.jasspp.account:account.second@example.com",
    JSON.stringify({ email: "second@example.com", store: "CN", cookies: [] })
  );
  const store = loadStore();

  assert.deepStrictEqual(
    store.listAccounts().map((item) => item.email),
    ["first@example.com", "second@example.com"]
  );
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), [
    "first@example.com",
    "second@example.com",
  ]);
});

test("corrupt Keychain sessions are retained and reported for recovery", () => {
  prefs.set("jasspp.accounts.v3", ["broken@example.com"]);
  keychain.set(
    "com.jasspp.account:account.broken@example.com",
    "{not-json"
  );
  const store = loadStore();

  assert.deepStrictEqual(store.listAccounts(), []);
  assert.deepStrictEqual(store.storageIssues(), [
    {
      email: "broken@example.com",
      type: "corrupt-session",
    },
  ]);
  assert.strictEqual(
    keychain.get("com.jasspp.account:account.broken@example.com"),
    "{not-json"
  );
});

test("saveAccount rolls back both Keychain and index when legacy cleanup fails", () => {
  prefs.set("jasspp.accounts.v2", [
    { email: "legacy@example.com", passwordToken: "old", cookies: [] },
  ]);
  failingPrefKey = "jasspp.accounts.v2";
  const store = loadStore();

  assert.throws(
    () => store.saveAccount({ email: "legacy@example.com", passwordToken: "new" }),
    /账号索引/
  );
  assert.strictEqual(
    keychain.has("com.jasspp.account:account.legacy@example.com"),
    false
  );
  assert.strictEqual(prefs.get("jasspp.accounts.v3"), undefined);
  assert.strictEqual(prefs.get("jasspp.accounts.v2")[0].passwordToken, "old");
});

test("clearAccounts does not touch Keychain when a preference update fails", () => {
  const store = loadStore();
  store.saveAccount({ email: "one@example.com", password: "one", store: "US" });
  failingPrefKey = "jasspp.accounts.v2";

  assert.throws(() => store.clearAccounts(), /账号索引/);
  assert.ok(keychain.has("com.jasspp.account:account.one@example.com"));
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v3"), ["one@example.com"]);
});

test("legacy plaintext password entries are removed during account loading", () => {
  keychain.set(
    "com.jasspp.account:account.one@example.com",
    JSON.stringify({ email: "one@example.com", store: "US", cookies: [] })
  );
  keychain.set("com.jasspp.account:password.one@example.com", "old-secret");
  const store = loadStore();

  assert.strictEqual(store.listAccounts().length, 1);
  assert.strictEqual(
    keychain.has("com.jasspp.account:password.one@example.com"),
    false
  );
});

test("account selection never silently falls back to another storefront", () => {
  const store = loadStore();
  store.saveAccount({ email: "us@example.com", store: "US", cookies: [] });

  assert.strictEqual(store.accountForRegion("CN"), null);
  assert.throws(() => store.requireAccountForRegion("CN"), /CN 区/);
  assert.throws(
    () => store.setActiveForRegion("CN", "us@example.com"),
    /区域不匹配/
  );
});

test("activating an account switches the current region to its saved storefront", () => {
  prefs.set("jasspp.region", "CN");
  const store = loadStore();
  store.saveAccount({ email: "us@example.com", store: "US", cookies: [] });

  const active = store.activateAccount("us@example.com");

  assert.strictEqual(active.email, "us@example.com");
  assert.strictEqual(active.store, "US");
  assert.strictEqual(prefs.get("jasspp.region"), "US");
  assert.strictEqual(store.activeEmailForRegion("US"), "us@example.com");
  assert.strictEqual(store.activeEmailForRegion("CN"), "");
});

test("account activation rolls back its region binding when region persistence fails", () => {
  prefs.set("jasspp.region", "CN");
  const store = loadStore();
  store.saveAccount({ email: "cn@example.com", store: "CN", cookies: [] });
  store.saveAccount({ email: "us@example.com", store: "US", cookies: [] });
  store.setActiveForRegion("CN", "cn@example.com");
  failingPrefKey = "jasspp.region";

  assert.throws(() => store.activateAccount("us@example.com"), /保存账号索引/);
  assert.strictEqual(prefs.get("jasspp.region"), "CN");
  assert.strictEqual(store.activeEmailForRegion("CN"), "cn@example.com");
  assert.strictEqual(store.activeEmailForRegion("US"), "");
});

test("legacy numeric storefronts are normalized without losing the storefront id", () => {
  const store = loadStore();
  store.saveAccount({
    email: "numeric@example.com",
    store: "143465-1,29",
    passwordToken: "token",
    directoryServicesIdentifier: "123",
  });

  const account = store.getAccount("numeric@example.com");
  assert.strictEqual(account.store, "CN");
  assert.strictEqual(account.storeFrontId, "143465");
  assert.strictEqual(store.accountRegion(account), "CN");
  assert.strictEqual(store.accountForRegion("CN").email, "numeric@example.com");
});

test("account normalization preserves a safe full storefront header and normalizes pod", () => {
  const store = loadStore();
  store.saveAccount({
    email: "header@example.com",
    store: "CN",
    storeFrontHeader: "143465-1,29",
    pod: "p42",
  });

  const account = store.getAccount("header@example.com");
  assert.strictEqual(account.storeFrontId, "143465");
  assert.strictEqual(account.storeFrontHeader, "143465-1,29");
  assert.strictEqual(account.pod, "42");
  assert.strictEqual(store.accountRegion(account), "CN");
});

test("unsafe storefront headers are discarded instead of being persisted", () => {
  const store = loadStore();
  store.saveAccount({
    email: "unsafe-header@example.com",
    store: "CN",
    storeFrontHeader: "https://evil.example/collect",
  });

  const account = store.getAccount("unsafe-header@example.com");
  assert.strictEqual(account.storeFrontHeader, "143465");
  assert.strictEqual(account.storeFrontId, "143465");
});

test("legacy migration never overwrites a newer secure session", () => {
  prefs.set("jasspp.accounts.v2", [
    {
      email: "same@example.com",
      passwordToken: "old-token",
      directoryServicesIdentifier: "old-dsid",
      store: "US",
    },
  ]);
  keychain.set(
    "com.jasspp.account:account.same@example.com",
    JSON.stringify({
      email: "same@example.com",
      passwordToken: "new-token",
      directoryServicesIdentifier: "new-dsid",
      store: "US",
    })
  );
  const store = loadStore();

  const account = store.listAccounts()[0];
  assert.strictEqual(account.passwordToken, "new-token");
  assert.strictEqual(account.directoryServicesIdentifier, "new-dsid");
  assert.deepStrictEqual(prefs.get("jasspp.accounts.v2"), []);
});

test("legacy migration preserves a corrupt secure record for explicit repair", () => {
  prefs.set("jasspp.accounts.v2", [
    { email: "broken@example.com", passwordToken: "legacy-token", store: "CN" },
  ]);
  keychain.set(
    "com.jasspp.account:account.broken@example.com",
    "{not-json"
  );
  const store = loadStore();

  assert.strictEqual(store.listAccounts()[0].passwordToken, "legacy-token");
  assert.deepStrictEqual(store.storageIssues(), [
    { email: "broken@example.com", type: "corrupt-session" },
  ]);
  assert.strictEqual(
    keychain.get("com.jasspp.account:account.broken@example.com"),
    "{not-json"
  );
});

test("auto-login password is stored in a dedicated Keychain key and never counted as an account", () => {
  const store = loadStore();
  store.saveAccount({
    email: "alice@example.com",
    passwordToken: "tok",
    directoryServicesIdentifier: "1",
    cookies: [],
    store: "US",
  });
  store.saveAutoLoginPassword("alice@example.com", "pw-secret");

  assert.strictEqual(
    keychain.get("com.jasspp.account:autologin.alice@example.com"),
    "pw-secret"
  );
  assert.strictEqual(store.getAutoLoginPassword("alice@example.com"), "pw-secret");
  // 只枚举 account. 前缀，autologin 键不会让账号数量或列表变化。
  assert.deepStrictEqual(store.listAccounts().map((a) => a.email), ["alice@example.com"]);
  // 账号会话本身绝不能包含明文密码。
  assert.doesNotMatch(
    keychain.get("com.jasspp.account:account.alice@example.com"),
    /pw-secret/
  );
});

test("autoRelogin flag is retained on the account while the password stays out of it", () => {
  const store = loadStore();
  store.saveAccount({
    email: "bob@example.com",
    passwordToken: "tok",
    directoryServicesIdentifier: "2",
    cookies: [],
    store: "US",
    autoRelogin: true,
  });
  const serialized = keychain.get("com.jasspp.account:account.bob@example.com");
  assert.match(serialized, /"autoRelogin":true/);
  assert.strictEqual(store.getAccount("bob@example.com").autoRelogin, true);
});

test("removeAccount also clears the stored auto-login password", () => {
  const store = loadStore();
  store.saveAccount({
    email: "carol@example.com",
    passwordToken: "tok",
    directoryServicesIdentifier: "3",
    cookies: [],
    store: "US",
    autoRelogin: true,
  });
  store.saveAutoLoginPassword("carol@example.com", "pw-secret");
  store.removeAccount("carol@example.com");
  assert.strictEqual(store.getAutoLoginPassword("carol@example.com"), null);
  assert.strictEqual(
    keychain.get("com.jasspp.account:autologin.carol@example.com"),
    undefined
  );
});
