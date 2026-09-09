const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

let values;
let secure;
const SAP_TOKEN_KEY = "com.jasspp.sap:sapApiToken";

function loadSettings() {
  delete require.cache[require.resolve("../scripts/store/settings")];
  return require("../scripts/store/settings");
}

beforeEach(() => {
  values = new Map();
  secure = new Map();
  global.$keychain = {
    get: (key, domain) => secure.get(`${domain}:${key}`),
    set: (key, value, domain) => {
      secure.set(`${domain}:${key}`, value);
      return true;
    },
    remove: (key, domain) => secure.delete(`${domain}:${key}`),
  };
  global.$prefs = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
      return true;
    },
  };
});

test("custom auth URL accepts only credential-free Apple HTTPS endpoints", () => {
  const settings = loadSettings();
  assert.match(
    settings.validateCustomAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast/"),
    /^https:\/\/auth\.itunes\.apple\.com\//
  );
  assert.throws(() => settings.validateCustomAuthURL("http://auth.itunes.apple.com/"), /HTTPS/);
  assert.throws(() => settings.validateCustomAuthURL("https://evil.example/"), /itunes\.apple\.com/);
  assert.throws(
    () => settings.validateCustomAuthURL("https://user:pass@auth.itunes.apple.com/"),
    /用户名或密码/
  );
  assert.throws(
    () => settings.validateCustomAuthURL("https://auth.itunes.apple.com:444/"),
    /443/
  );
});

test("stored limits and regions are normalized", () => {
  const settings = loadSettings();
  settings.setRegion("us");
  settings.setChartLimit(9999);
  assert.strictEqual(settings.region(), "US");
  assert.strictEqual(settings.chartLimit(), 200);
});

test("raw SAP signing is derived from complete configuration, including legacy saved modes", () => {
  const settings = loadSettings();
  assert.strictEqual(settings.rawSapMode(), "off");
  values.set("jasspp.sapApiURL", "https://sap.example.com/sign");
  secure.set(SAP_TOKEN_KEY, "saved-token");
  for (const mode of ["off", "api", "native", "webview", "invalid"]) {
    values.set("jasspp.rawSapMode", mode);
    assert.strictEqual(settings.rawSapMode(), "api", mode);
  }
  secure.delete(SAP_TOKEN_KEY);
  assert.strictEqual(settings.rawSapMode(), "off");
});

test("missing or invalid SAP configuration never enables the signer", () => {
  const settings = loadSettings();
  values.set("jasspp.rawSapMode", "api");
  values.set("jasspp.sapApiURL", "https://sap.example.com");
  for (const token of ["", "  ", "bad token", "bad\ntoken", "bad\u0000token"]) {
    secure.set(SAP_TOKEN_KEY, token);
    assert.strictEqual(settings.rawSapMode(), "off");
  }
  secure.set(SAP_TOKEN_KEY, "valid-token");
  for (const url of ["", "http://bad host", "ftp://sap.example.com"]) {
    values.set("jasspp.sapApiURL", url);
    assert.strictEqual(settings.rawSapMode(), "off");
  }
  values.set("jasspp.sapApiURL", "https://sap.example.com");
  global.$keychain.get = () => { throw new Error("locked"); };
  assert.strictEqual(settings.rawSapMode(), "off");
  delete global.$keychain;
  assert.strictEqual(settings.rawSapMode(), "off");
});

test("saving the SAP form commits both fields and clearing disables it without a mode flag", () => {
  const settings = loadSettings();
  settings.setSapConfig({ url: " https://SAP.example.com/proxy/sign/ ", token: " secret-token " });
  assert.strictEqual(settings.sapApiURL(), "https://sap.example.com/proxy");
  assert.strictEqual(settings.sapApiToken(), "secret-token");
  assert.strictEqual(settings.rawSapMode(), "api");
  assert.strictEqual(values.has("jasspp.rawSapMode"), false);
  assert.strictEqual(values.has("jasspp.sapApiToken"), false);
  settings.setSapConfig({ url: "", token: "" });
  assert.strictEqual(settings.sapApiURL(), "");
  assert.strictEqual(settings.sapApiToken(), "");
  assert.strictEqual(secure.has(SAP_TOKEN_KEY), false);
  assert.strictEqual(loadSettings().rawSapMode(), "off");
});

test("invalid or incomplete SAP form input preserves the existing configuration", () => {
  const settings = loadSettings();
  values.set("jasspp.sapApiURL", "https://old.example.com");
  secure.set(SAP_TOKEN_KEY, "old-token");
  for (const value of [
    { url: "https://new.example.com", token: "" },
    { url: "", token: "new-token" },
    { url: "http://bad host", token: "new-token" },
    { url: "https://new.example.com", token: "bad token" },
    { url: "https://new.example.com", token: "bad\u0000token" },
  ]) {
    assert.throws(() => settings.setSapConfig(value), /地址|Token|填写/);
    assert.strictEqual(settings.sapApiURL(), "https://old.example.com");
    assert.strictEqual(settings.sapApiToken(), "old-token");
  }
});

test("failed address clearing cannot change the saved SAP token, even with false success", () => {
  const settings = loadSettings();
  values.set("jasspp.sapApiURL", "https://old.example.com");
  secure.set(SAP_TOKEN_KEY, "old-token");
  for (const set of [() => false, () => true, () => { throw new Error("denied"); }]) {
    global.$prefs.set = set;
    assert.throws(() => settings.setSapConfig({ url: "https://new.example.com", token: "new-token" }), /保存|denied/);
    assert.strictEqual(values.get("jasspp.sapApiURL"), "https://old.example.com");
    assert.strictEqual(secure.get(SAP_TOKEN_KEY), "old-token");
  }
});

test("failed SAP token writes leave signing disabled instead of pairing the new host with old credentials", () => {
  const settings = loadSettings();
  for (const set of [
    () => false,
    () => true,
    () => { throw new Error("denied"); },
    (key, value, domain) => { secure.set(`${domain}:${key}`, value); return false; },
  ]) {
    values.set("jasspp.sapApiURL", "https://old.example.com");
    secure.set(SAP_TOKEN_KEY, "old-token");
    global.$keychain.set = set;
    assert.throws(() => settings.setSapConfig({ url: "https://new.example.com", token: "new-token" }), /Token.*失败|钥匙串/);
    assert.strictEqual(settings.sapApiURL(), "");
    assert.strictEqual(settings.rawSapMode(), "off");
  }
});

test("failed final SAP address commit cannot report success or enable a mismatched configuration", () => {
  const settings = loadSettings();
  for (const failure of [false, true]) {
    values.set("jasspp.sapApiURL", "https://old.example.com");
    secure.set(SAP_TOKEN_KEY, "old-token");
    global.$prefs.set = (key, value) => {
      if (key === "jasspp.sapApiURL" && value) return failure;
      values.set(key, value);
      return true;
    };
    assert.throws(() => settings.setSapConfig({ url: "https://new.example.com", token: "new-token" }), /保存/);
    assert.strictEqual(settings.sapApiURL(), "");
    assert.strictEqual(settings.sapApiToken(), "new-token");
    assert.strictEqual(settings.rawSapMode(), "off");
  }
});

test("failed Token removal still disables the SAP signer and keeps the error visible to callers", () => {
  const settings = loadSettings();
  values.set("jasspp.sapApiURL", "https://old.example.com");
  secure.set(SAP_TOKEN_KEY, "old-token");
  global.$keychain.remove = () => false;
  assert.throws(() => settings.setSapConfig({ url: "", token: "" }), /Token.*失败|钥匙串/);
  assert.strictEqual(settings.rawSapMode(), "off");
  assert.strictEqual(settings.sapApiURL(), "");
  assert.strictEqual(secure.get(SAP_TOKEN_KEY), "old-token");
});

test("a legacy prefs Token enables configured SAP only after verified Keychain migration", () => {
  const settings = loadSettings();
  values.set("jasspp.sapApiURL", "https://sap.example.com");
  values.set("jasspp.rawSapMode", "off");
  values.set("jasspp.sapApiToken", "legacy-token");
  const originalSet = global.$keychain.set;
  global.$keychain.set = () => false;
  assert.strictEqual(settings.rawSapMode(), "off");
  assert.strictEqual(values.get("jasspp.sapApiToken"), "legacy-token");
  global.$keychain.set = originalSet;
  assert.strictEqual(settings.rawSapMode(), "api");
  assert.strictEqual(values.get("jasspp.sapApiToken"), "");
  settings.setSapConfig({ url: "", token: "" });
  assert.strictEqual(loadSettings().rawSapMode(), "off");
  assert.strictEqual(settings.sapApiToken(), "");
});

test("third-party SAP signer URL starts unconfigured and preserves explicitly saved addresses", () => {
  const settings = loadSettings();
  assert.strictEqual(settings.sapApiURL(), "");
  assert.strictEqual(settings.DEFAULT_SAP_API_URL, "");
  values.set("jasspp.sapApiURL", "http://127.0.0.1:18080");
  assert.strictEqual(settings.sapApiURL(), "http://127.0.0.1:18080");
  assert.strictEqual(
    settings.setSapApiURL("http://192.168.1.10:18080/"),
    "http://192.168.1.10:18080"
  );
  assert.strictEqual(
    settings.setSapApiURL("https://sap.example.com/sign-service"),
    "https://sap.example.com/sign-service"
  );
  assert.throws(() => settings.setSapApiURL("ftp://host/x"), /HTTP 或 HTTPS/);
  assert.throws(() => settings.setSapApiURL("http://user:pass@host:18080"), /用户名或密码/);
  assert.throws(() => settings.setSapApiURL("http://host:18080/path#frag"), /片段/);
  assert.throws(() => settings.setSapApiURL("http://host:18080/path?x=1"), /查询参数/);
  assert.strictEqual(settings.setSapApiURL(""), "");
  assert.strictEqual(settings.sapApiURL(), "");
});

test("SAP URL validation works with and without a native URL parser", () => {
  const originalURL = global.URL;
  try {
    for (const nativeURL of [originalURL, undefined]) {
      global.URL = nativeURL;
      const settings = loadSettings();
      for (const [input, expected] of [
        ["https://sap.example.com/sign", "https://sap.example.com"],
        ["https://SAP.example.com:443/proxy/sap/sign/", "https://sap.example.com/proxy/sap"],
        ["https://sap.example.com/proxy/sap/", "https://sap.example.com/proxy/sap"],
        ["http://192.168.1.20:18080/sign", "http://192.168.1.20:18080"],
        ["http://sap-server.local:18080", "http://sap-server.local:18080"],
        ["http://[::1]:18080/sign", "http://[::1]:18080"],
        ["https://sap.example.com/签名/sign", "https://sap.example.com/%E7%AD%BE%E5%90%8D"],
        ["https://sap.example.com/proxy/%E7%AD%BE%E5%90%8D/sign/", "https://sap.example.com/proxy/%E7%AD%BE%E5%90%8D"],
        ["https://sap.example.com/proxy/%2F/签名/sign", "https://sap.example.com/proxy/%2F/%E7%AD%BE%E5%90%8D"],
        ["https://sap.example.com/proxy/%252F/sign", "https://sap.example.com/proxy/%252F"],
      ]) {
        assert.strictEqual(settings.validateSapApiURL(input), expected, input);
        assert.strictEqual(settings.validateSapApiURL(expected), expected, "normalization must be idempotent");
      }
      for (const input of [
        "http://bad host", "http://host:99999", "http://host:0", "http://host:abc",
        "http://999.1.1.1", "http://[::::]", "http://-bad.example", "http://host\\other",
      ]) {
        assert.throws(() => settings.validateSapApiURL(input), /有效|端口/, input);
      }
    }
  } finally {
    global.URL = originalURL;
  }
});

test("SAP token is written only to Keychain and clearing verifies removal", () => {
  const settings = loadSettings();
  assert.strictEqual(settings.sapApiToken(), "");
  settings.setSapApiToken("  token-abc  ");
  assert.strictEqual(settings.sapApiToken(), "token-abc");
  assert.strictEqual(secure.get(SAP_TOKEN_KEY), "token-abc");
  assert.strictEqual(values.has("jasspp.sapApiToken"), false);
  settings.setSapApiToken("");
  assert.strictEqual(settings.sapApiToken(), "");
  assert.strictEqual(secure.has(SAP_TOKEN_KEY), false);
});

test("SAP token removal rejects failed, missing, throwing and ineffective keychain operations", () => {
  for (const remove of [() => false, undefined, () => { throw new Error("denied"); }, () => true]) {
    const settings = loadSettings();
    secure.set(SAP_TOKEN_KEY, "still-secret");
    global.$keychain.remove = remove;
    assert.throws(() => settings.setSapApiToken(""), /Token.*失败|钥匙串/);
    assert.strictEqual(secure.get(SAP_TOKEN_KEY), "still-secret");
  }
});

test("SAP token writes fail closed when Keychain is unavailable or does not persist", () => {
  const settings = loadSettings();
  for (const set of [() => false, () => true, () => { throw new Error("denied"); }]) {
    global.$keychain.set = set;
    assert.throws(() => settings.setSapApiToken("sensitive-token"), /Token.*失败|钥匙串/);
    assert.strictEqual(values.has("jasspp.sapApiToken"), false);
  }
  delete global.$keychain;
  values.set("jasspp.sapApiToken", "legacy-secret");
  assert.strictEqual(settings.sapApiToken(), "");
  assert.throws(() => settings.setSapApiToken("sensitive-token"), /Token.*失败|钥匙串/);
  assert.strictEqual(values.get("jasspp.sapApiToken"), "legacy-secret");
});

test("legacy SAP tokens migrate only after a verified Keychain write", () => {
  const settings = loadSettings();
  values.set("jasspp.sapApiToken", "legacy-secret");
  const originalSet = global.$keychain.set;
  global.$keychain.set = () => false;
  assert.strictEqual(settings.sapApiToken(), "");
  assert.strictEqual(values.get("jasspp.sapApiToken"), "legacy-secret");
  global.$keychain.set = originalSet;
  assert.strictEqual(settings.sapApiToken(), "legacy-secret");
  assert.strictEqual(secure.get(SAP_TOKEN_KEY), "legacy-secret");
  assert.strictEqual(values.get("jasspp.sapApiToken"), "");
  values.set("jasspp.sapApiToken", "stale-secret");
  assert.strictEqual(settings.sapApiToken(), "legacy-secret");
  assert.strictEqual(values.get("jasspp.sapApiToken"), "");
  settings.setSapApiToken("");
  assert.strictEqual(loadSettings().sapApiToken(), "");
});

test("setting writes report persistence failures", () => {
  global.$prefs.set = () => false;
  const settings = loadSettings();
  assert.throws(() => settings.setRegion("US"), /保存设置失败/);
});

test("Plist service settings accept only the supported HTTPS endpoints", () => {
  const settings = loadSettings();
  assert.match(settings.plistServer(), /^https:\/\/api\.scripting\.fun\//);
  assert.match(
    settings.setPlistServer("https://xiaobai.app/install"),
    /^https:\/\/xiaobai\.app\//
  );
  assert.throws(() => settings.setPlistServer("http://api.scripting.fun/ipa-plist"), /HTTPS/);
  assert.throws(() => settings.setPlistServer("https://evil.example/install"), /受支持/);
  assert.throws(
    () => settings.setPlistServer("https://user:pass@api.scripting.fun/ipa-plist"),
    /用户名或密码/
  );
});
