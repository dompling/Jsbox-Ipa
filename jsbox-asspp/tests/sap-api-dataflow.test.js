const { test } = require("node:test");
const assert = require("node:assert/strict");

const purchases = require("../scripts/apple/purchases");
const settings = require("../scripts/store/settings");
const b64 = require("../scripts/lib/b64");

for (const useSavedConfig of [false, true]) {
test(useSavedConfig
  ? "saved SAP configuration automatically signs the real purchased wire bodies without a mode option"
  : "real remote SAP adapter signs exactly the Apple update and DMAP wire bodies", async () => {
  const previousHTTP = global.$http;
  const previousData = global.$data;
  const previousURL = settings.sapApiURL;
  const previousToken = settings.sapApiToken;
  const previousPrefs = global.$prefs;
  const previousKeychain = global.$keychain;
  const requests = [];
  const sapBodies = [];
  const signatures = ["AP+A", "AQD/"];
  const account = {
    email: "owned@example.com",
    deviceIdentifier: "00112233aabb",
    directoryServicesIdentifier: "987654321",
    passwordToken: "apple-password-token",
    store: "US",
    storeFrontHeader: "143441-1,29",
    cookies: [{ name: "itspod", value: "apple-cookie-secret", domain: "itunes.apple.com", path: "/", secure: true }],
  };
  global.$data = (input) => {
    const bytes = input.byteArray ? input.byteArray.slice() : b64.utf8Encode(input.string || "");
    return { byteArray: bytes, string: Buffer.from(bytes).toString("utf8"), base64: b64.base64Encode(bytes) };
  };
  if (useSavedConfig) {
    const prefs = new Map([["jasspp.rawSapMode", "off"]]);
    const keychain = new Map();
    global.$prefs = {
      get: (key) => prefs.get(key),
      set: (key, value) => { prefs.set(key, value); return true; },
    };
    global.$keychain = {
      get: (key, domain) => keychain.get(`${domain}:${key}`),
      set: (key, value, domain) => { keychain.set(`${domain}:${key}`, value); return true; },
      remove: (key, domain) => keychain.delete(`${domain}:${key}`),
    };
    settings.setSapConfig({ url: "https://sap.example.com/proxy/sap/sign/", token: "remote-bearer-secret" });
  } else {
    settings.sapApiURL = () => "https://sap.example.com/proxy/sap/sign/";
    settings.sapApiToken = () => "remote-bearer-secret";
  }
  global.$http = {
    request(options) {
      requests.push(options);
      const response = { statusCode: 200, headers: {}, url: options.url };
      if (options.url === "https://sap.example.com/proxy/sap/sign") {
        const payload = JSON.parse(options.body.string);
        const decoded = b64.base64Decode(payload.bodyBase64);
        sapBodies.push(decoded);
        assert.deepEqual(Object.keys(payload).sort(), ["bodyBase64", "guid"]);
        assert.equal(payload.guid, "00112233AABB");
        assert.equal(options.header.Authorization, "Bearer remote-bearer-secret");
        assert.equal(options.timeout, 480);
        assert.equal(options.header.Cookie, undefined);
        assert.equal(options.header["X-Token"], undefined);
        assert.equal(options.header["X-Dsid"], undefined);
        assert.equal(options.header["X-Apple-ActionSignature"], undefined);
        const outgoing = JSON.stringify(options.header) + options.body.string;
        for (const secret of [account.email, account.directoryServicesIdentifier, account.passwordToken, "apple-cookie-secret"]) {
          assert.equal(outgoing.includes(secret), false, `Apple credential reached SAP: ${secret}`);
        }
        options.handler({ response, data: { signature: signatures[sapBodies.length - 1], bytesSigned: decoded.length, guid: payload.guid } });
        return;
      }
      assert.ok(options.url.startsWith(purchases.BASE_URL), `unexpected request before purchased login: ${options.url}`);
      assert.equal(options.header.Authorization, undefined);
      assert.equal(options.header["X-Guid"], "00112233AABB");
      assert.equal(options.header["X-Dsid"], account.directoryServicesIdentifier);
      assert.equal(options.header["X-Token"], account.passwordToken);
      assert.match(options.header.Cookie, /apple-cookie-secret/);
      if (options.url.endsWith("/login")) {
        assert.equal(options.header["X-Apple-ActionSignature"], undefined);
        options.handler({ response, rawData: global.$data({ byteArray: purchases.dmapUint32("mlid", 7) }) });
      } else if (options.url.endsWith("/update")) {
        assert.deepEqual(options.body.byteArray, sapBodies[0]);
        assert.equal(options.header["X-Apple-ActionSignature"], signatures[0]);
        assert.equal(options.header["Content-Type"], "application/x-www-form-urlencoded");
        assert.match(options.body.string, /^session-id=7&revision-number=\(null\)&query=/);
        options.handler({ response, rawData: global.$data({ byteArray: purchases.dmapUint32("musr", 9) }) });
      } else {
        assert.equal(options.url, `${purchases.BASE_URL}/databases/9/items`);
        assert.deepEqual(options.body.byteArray, sapBodies[1]);
        assert.equal(options.header["X-Apple-ActionSignature"], signatures[1]);
        assert.equal(options.header["Content-Type"], "application/x-dmap-tagged");
        assert.deepEqual(options.body.byteArray.slice(0, 4), [0x61, 0x64, 0x73, 0x72]);
        assert.ok(options.body.byteArray.includes(0), "DMAP binary must preserve NUL bytes");
        options.handler({ response, rawData: global.$data({ byteArray: purchases.dmapTag("mlcl", []) }) });
      }
    },
  };
  try {
    const result = await purchases.listOwnedApps(account, useSavedConfig
      ? { enrich: false }
      : { rawSapMode: "api", enrich: false });
    assert.equal(result.totalCount, 0);
    assert.equal(sapBodies.length, 2);
    assert.equal(requests.length, 5);
    assert.equal(requests[0].url, `${purchases.BASE_URL}/login`);
    assert.deepEqual(requests.map((request) => request.url), [
      `${purchases.BASE_URL}/login`,
      "https://sap.example.com/proxy/sap/sign",
      `${purchases.BASE_URL}/update`,
      "https://sap.example.com/proxy/sap/sign",
      `${purchases.BASE_URL}/databases/9/items`,
    ]);
  } finally {
    if (previousHTTP === undefined) delete global.$http;
    else global.$http = previousHTTP;
    if (previousData === undefined) delete global.$data;
    else global.$data = previousData;
    settings.sapApiURL = previousURL;
    settings.sapApiToken = previousToken;
    if (previousPrefs === undefined) delete global.$prefs;
    else global.$prefs = previousPrefs;
    if (previousKeychain === undefined) delete global.$keychain;
    else global.$keychain = previousKeychain;
  }
});
}

test("missing, invalid or cleared SAP configuration stops purchased requests before network access", async () => {
  const http = require("../scripts/lib/http");
  const previousSend = http.send;
  const previousPrefs = global.$prefs;
  const previousKeychain = global.$keychain;
  const prefs = new Map();
  const keychain = new Map();
  const requests = [];
  global.$prefs = {
    get: (key) => prefs.get(key),
    set: (key, value) => { prefs.set(key, value); return true; },
  };
  global.$keychain = {
    get: (key, domain) => keychain.get(`${domain}:${key}`),
    set: (key, value, domain) => { keychain.set(`${domain}:${key}`, value); return true; },
    remove: (key, domain) => keychain.delete(`${domain}:${key}`),
  };
  http.send = async (request) => { requests.push(request); throw new Error("unexpected network request"); };
  const account = {
    deviceIdentifier: "001122334455", directoryServicesIdentifier: "123", passwordToken: "apple-token", cookies: [],
  };
  async function assertStopped() {
    await assert.rejects(purchases.listOwnedApps(account, { enrich: false }), (error) =>
      error.code === "RAW_SAP_SIGNER_UNAVAILABLE" && /已购签名/.test(error.message));
    assert.equal(requests.length, 0);
  }
  try {
    for (const [url, token] of [
      ["", "token"], ["https://sap.example.com", ""],
      ["https://sap.example.com", "bad token"], ["http://bad host", "token"],
    ]) {
      prefs.set("jasspp.rawSapMode", "api");
      prefs.set("jasspp.sapApiURL", url);
      keychain.set("com.jasspp.sap:sapApiToken", token);
      await assertStopped();
    }
    settings.setSapConfig({ url: "https://sap.example.com", token: "token" });
    settings.setSapConfig({ url: "", token: "" });
    await assertStopped();
  } finally {
    http.send = previousSend;
    if (previousPrefs === undefined) delete global.$prefs;
    else global.$prefs = previousPrefs;
    if (previousKeychain === undefined) delete global.$keychain;
    else global.$keychain = previousKeychain;
  }
});

test("purchased requests stop if JSBox cannot preserve the binary request bytes", async () => {
  const http = require("../scripts/lib/http");
  const previousSend = http.send;
  const previousData = global.$data;
  try {
    for (const factory of [
      () => { throw new Error("conversion failed"); },
      () => undefined,
      () => ({ byteArray: [0xff] }),
    ]) {
      global.$data = factory;
      const requests = [];
      http.send = async (options) => {
        requests.push(options.url);
        if (options.url.endsWith("/login")) {
          return { status: 200, headers: {}, rawData: purchases.dmapUint32("mlid", 7), finalUrl: options.url };
        }
        throw new Error("unexpected request after byte conversion failed");
      };
      await assert.rejects(purchases.listOwnedApps({
        deviceIdentifier: "001122334455", directoryServicesIdentifier: "123", passwordToken: "apple-token", cookies: [],
      }, {
        rawSapMode: "api", sapApiURL: "https://sap.example.com", sapApiToken: "api-token", enrich: false,
      }), /请求.*字节|请求体/);
      assert.deepEqual(requests, [`${purchases.BASE_URL}/login`]);
    }
  } finally {
    http.send = previousSend;
    if (previousData === undefined) delete global.$data;
    else global.$data = previousData;
  }
});
