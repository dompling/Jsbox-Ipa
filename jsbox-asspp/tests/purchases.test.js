const { test } = require("node:test");
const assert = require("node:assert");

const http = require("../scripts/lib/http");
const purchases = require("../scripts/apple/purchases");
const store = require("../scripts/apple/store");
const sap = require("../scripts/apple/sap");
const diag = require("../scripts/lib/diag");

const account = {
  email: "test@example.com",
  deviceIdentifier: "001122334455",
  directoryServicesIdentifier: "123456",
  passwordToken: "token",
  store: "US",
  storeFrontHeader: "143441-1,29",
  cookies: [],
};

function sapBagPlist(setupURL, certificateURL) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<Document><Protocol>" +
    '<plist version="1.0"><dict><key>urlBag</key><dict>' +
    `<key>sign-sap-setup</key><string>${setupURL}</string>` +
    `<key>sign-sap-setup-cert</key><string>${certificateURL}</string>` +
    "<key>sign-sap-version</key><string>200</string>" +
    "</dict></dict></plist>" +
    "</Protocol></Document>"
  );
}

function daapFlowMock(bagBody, items) {
  return async (options) => {
    const url = options.url || "";
    if (url.indexOf("/bag.xml") >= 0) {
      return { status: 200, headers: {}, body: bagBody || "", finalUrl: url };
    }
    if (url.indexOf("/purchase/login") >= 0) {
      return { status: 200, headers: {}, rawData: purchases.dmapUint32("mlid", 7), finalUrl: url };
    }
    if (url.indexOf("/purchase/update") >= 0) {
      return { status: 200, headers: {}, rawData: purchases.dmapUint32("musr", 9), finalUrl: url };
    }
    return {
      status: 200,
      headers: {},
      rawData: purchases.dmapTag("mlcl", items || []),
      finalUrl: url,
    };
  };
}

test("owned-app SAP signer receives bag-provided setup and certificate endpoints", async () => {
  const originalSend = http.send;
  const originalSign = sap.signBytes;
  const seen = [];
  http.send = daapFlowMock(
    sapBagPlist(
      "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
      "https://s.mzstatic.com/sap/setupCert.plist"
    )
  );
  sap.signBytes = async (_bytes, options) => {
    seen.push({
      setupURL: options && options.setupURL,
      certificateURL: options && options.certificateURL,
    });
    return "signature";
  };
  diag.clear();
  try {
    await purchases.listOwnedApps(account, {
      enrich: false,
      signSapBytes: async () => "signature",
    });
    assert.ok(seen.length >= 2, "update/items 都该走签名器");
    for (const entry of seen) {
      assert.strictEqual(
        entry.setupURL,
        "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy"
      );
      assert.strictEqual(
        entry.certificateURL,
        "https://s.mzstatic.com/sap/setupCert.plist"
      );
    }
    const tail = diag.tail(20);
    assert.ok(tail.some((e) => e.step === "bag"), "应记录 bag 阶段");
    assert.ok(tail.some((e) => e.step === "items-parse"), "应记录列表解析");
  } finally {
    http.send = originalSend;
    sap.signBytes = originalSign;
  }
});

test("owned apps attach GUID and third-party service config in API mode", async () => {
  const settings = require("../scripts/store/settings");
  const originalSend = http.send;
  const originalSign = sap.signBytes;
  const originalURL = settings.sapApiURL;
  const originalToken = settings.sapApiToken;
  const seen = [];
  http.send = daapFlowMock("");
  settings.sapApiURL = () => "http://192.168.1.10:18080";
  settings.sapApiToken = () => "remote-token";
  sap.signBytes = async (_bytes, options) => {
    seen.push(options);
    return "signature";
  };
  try {
    await purchases.listOwnedApps(account, {
      enrich: false,
      rawSapMode: "api",
    });
    assert.ok(seen.length >= 2, "update/items 都该带上 API 签名配置");
    for (const options of seen) {
      assert.strictEqual(options.rawSapMode, "api");
      assert.strictEqual(options.guid, "001122334455");
      assert.strictEqual(options.sapApiURL, "http://192.168.1.10:18080");
      assert.strictEqual(options.sapApiToken, "remote-token");
    }
  } finally {
    http.send = originalSend;
    sap.signBytes = originalSign;
    settings.sapApiURL = originalURL;
    settings.sapApiToken = originalToken;
  }
});

test("owned API options override only missing settings and always use the account GUID", async () => {
  const settings = require("../scripts/store/settings");
  const originalSend = http.send;
  const originalSign = sap.signBytes;
  const originalURL = settings.sapApiURL;
  const originalToken = settings.sapApiToken;
  let urlReads = 0;
  let tokenReads = 0;
  const seen = [];
  http.send = daapFlowMock("");
  settings.sapApiURL = () => { urlReads++; return "https://saved.example.com"; };
  settings.sapApiToken = () => { tokenReads++; return "saved-token"; };
  sap.signBytes = async (_bytes, options) => { seen.push(options); return "signature"; };
  try {
    await purchases.listOwnedApps({ ...account, deviceIdentifier: "00112233aabb" }, {
      enrich: false, rawSapMode: "api", guid: "FFFFFFFFFFFF",
      sapApiURL: "https://explicit.example.com/proxy", sapApiToken: "explicit-token",
    });
    assert.strictEqual(urlReads, 0);
    assert.strictEqual(tokenReads, 0);
    for (const options of seen) {
      assert.strictEqual(options.guid, "00112233AABB");
      assert.strictEqual(options.sapApiURL, "https://explicit.example.com/proxy");
      assert.strictEqual(options.sapApiToken, "explicit-token");
    }
    for (const missing of ["sapApiURL", "sapApiToken"]) {
      const options = { enrich: false, rawSapMode: "api", sapApiURL: "https://explicit.example.com", sapApiToken: "explicit-token" };
      delete options[missing];
      await purchases.listOwnedApps(account, options);
    }
    assert.strictEqual(urlReads, 1);
    assert.strictEqual(tokenReads, 1);
    let networkCalls = 0;
    http.send = async () => { networkCalls++; throw new Error("unexpected network"); };
    for (const empty of ["sapApiURL", "sapApiToken"]) {
      await assert.rejects(purchases.listOwnedApps(account, {
        enrich: false, rawSapMode: "api", sapApiURL: "https://explicit.example.com", sapApiToken: "explicit-token", [empty]: "",
      }), /服务地址与 API Token/);
    }
    assert.strictEqual(networkCalls, 0);
  } finally {
    http.send = originalSend;
    sap.signBytes = originalSign;
    settings.sapApiURL = originalURL;
    settings.sapApiToken = originalToken;
  }
});

test("owned-app GUID validation rejects incomplete byte pairs before network access", async () => {
  const originalSend = http.send;
  let calls = 0;
  http.send = async () => { calls++; throw new Error("unexpected network"); };
  try {
    for (const deviceIdentifier of ["0011223344556", "A".repeat(39), "A".repeat(42)]) {
      await assert.rejects(purchases.listOwnedApps({ ...account, deviceIdentifier }, {
        enrich: false, signSapBytes: () => "signature",
      }), /设备标识/);
    }
    assert.strictEqual(calls, 0);
    http.send = daapFlowMock("");
    await purchases.listOwnedApps({ ...account, deviceIdentifier: "AB".repeat(20) }, {
      enrich: false, signSapBytes: () => "signature",
    });
  } finally {
    http.send = originalSend;
  }
});

test("owned apps fall back to engine defaults when bag has no SAP endpoints", async () => {
  const originalSend = http.send;
  const originalSign = sap.signBytes;
  const seen = [];
  http.send = daapFlowMock("");
  sap.signBytes = async (_bytes, options) => {
    seen.push({
      setupURL: options && options.setupURL,
      certificateURL: options && options.certificateURL,
    });
    return "signature";
  };
  try {
    await purchases.listOwnedApps(account, {
      enrich: false,
      signSapBytes: async () => "signature",
    });
    assert.ok(seen.length >= 2);
    for (const entry of seen) {
      assert.strictEqual(entry.setupURL, undefined);
      assert.strictEqual(entry.certificateURL, undefined);
    }
  } finally {
    http.send = originalSend;
    sap.signBytes = originalSign;
  }
});

test("owned apps fail before network access when no raw-body signer exists", async () => {
  const original = http.send;
  let requests = 0;
  http.send = async () => {
    requests += 1;
    throw new Error("must not send");
  };
  try {
    await assert.rejects(
      purchases.listOwnedApps(account, {}),
      (error) =>
        error &&
        error.code === "RAW_SAP_SIGNER_UNAVAILABLE" &&
        /设置的「已购签名」/.test(error.message)
    );
    assert.strictEqual(requests, 0);
  } finally {
    http.send = original;
  }
});

test("owned-app requests use a bounded network timeout", () => {
  assert.strictEqual(purchases.OWNED_REQUEST_TIMEOUT_SECONDS, 20);
});

test("owned apps translate XML-only signer failures into actionable guidance", async () => {
  const originalSend = http.send;
  http.send = daapFlowMock("");
  try {
    await assert.rejects(
      purchases.listOwnedApps(account, {
        enrich: false,
        signSapBytes: async () => {
          throw new Error(
            "[准备签名] decode XML body: plist: error parsing text property list"
          );
        },
      }),
      (error) => {
        assert.match(error.message, /\[update-sign\]/);
        assert.match(error.message, /内置签名引擎只支持登录 XML plist/);
        assert.match(error.message, /原始字节 ActionSignature/);
        assert.match(error.message, /error parsing text property list/);
        return true;
      }
    );
  } finally {
    http.send = originalSend;
  }
});

test("owned apps sign the exact form body bytes when a raw signer is injected", async () => {
  const original = http.send;
  const signedBodies = [];
  http.send = async (options) => {
    const url = options.url || "";
    if (url.indexOf("/bag.xml") >= 0) {
      return { status: 200, headers: {}, body: "", finalUrl: url };
    }
    if (url.indexOf("/purchase/login") >= 0) {
      return {
        status: 200,
        headers: {},
        rawData: purchases.dmapUint32("mlid", 7),
        finalUrl: url,
      };
    }
    if (url.indexOf("/purchase/update") >= 0) {
      return {
        status: 200,
        headers: {},
        rawData: purchases.dmapUint32("musr", 9),
        finalUrl: url,
      };
    }
    return {
      status: 200,
      headers: {},
      rawData: purchases.dmapTag("mlcl", []),
      finalUrl: url,
    };
  };
  try {
    await purchases.listOwnedApps(account, {
      enrich: false,
      signSapBytes: async (bytes) => {
        signedBodies.push(bytes.slice());
        return "signature";
      },
    });
    assert.strictEqual(signedBodies.length, 2);
    const updateText = Buffer.from(signedBodies[0]).toString("utf8");
    assert.match(updateText, /^session-id=7&revision-number=\(null\)&query=/);
    assert.deepStrictEqual(signedBodies[1].slice(0, 4), [0x61, 0x64, 0x73, 0x72]);
  } finally {
    http.send = original;
  }
});

test("owned apps reject DAAP application errors even when HTTP succeeds", () => {
  assert.throws(
    () => purchases.checkDMAPStatus("读取已购 App", purchases.dmapUint32("mstt", 401)),
    (error) =>
      error &&
      error.code === "401" &&
      /登录已过期/.test(error.message)
  );
  assert.throws(
    () => purchases.checkDMAPStatus("更新购买记录", purchases.dmapUint32("mstt", 500)),
    (error) =>
      error &&
      error.code === "500" &&
      /DAAP 状态 500/.test(error.message)
  );
});

test("owned apps publish decoded records before enriching them in small batches", async () => {
  const originalSend = http.send;
  const originalLookup = store.lookupByIds;
  const itemOne = purchases.dmapTag("mlit", [
    ...purchases.dmapUint32("aeSI", 101),
    ...purchases.dmapString("aeLN", "First App"),
    ...purchases.dmapString("aeBI", "com.example.first"),
  ]);
  const itemTwo = purchases.dmapTag("mlit", [
    ...purchases.dmapUint32("aeSI", 202),
    ...purchases.dmapString("aeLN", "Second App"),
    ...purchases.dmapString("aeBI", "com.example.second"),
  ]);
  http.send = async (options) => {
    const url = options.url || "";
    if (url.indexOf("/bag.xml") >= 0) {
      return { status: 200, headers: {}, body: "", finalUrl: url };
    }
    if (url.indexOf("/purchase/login") >= 0) {
      return { status: 200, headers: {}, rawData: purchases.dmapUint32("mlid", 7), finalUrl: url };
    }
    if (url.indexOf("/purchase/update") >= 0) {
      return { status: 200, headers: {}, rawData: purchases.dmapUint32("musr", 9), finalUrl: url };
    }
    return {
      status: 200,
      headers: {},
      rawData: purchases.dmapTag("mlcl", [...itemOne, ...itemTwo]),
      finalUrl: url,
    };
  };
  const lookupBatches = [];
  store.lookupByIds = async (ids) => {
    lookupBatches.push(ids.slice());
    return ids.map((id) => ({
      id: String(id),
      artworkUrl: `https://example.com/${id}.png`,
      artistName: `Publisher ${id}`,
    }));
  };
  const updates = [];
  const stages = [];
  try {
    const result = await purchases.listOwnedApps(account, {
      page: 1,
      limit: 2,
      region: "US",
      enrichBatchSize: 1,
      signSapBytes: async () => "signature",
      onProgress: (progress) => stages.push(progress.stage),
      onApps: (apps, meta) => updates.push({ apps, meta }),
    });
    assert.deepStrictEqual(stages, [
      "login",
      "update",
      "update-sign",
      "update-request",
      "items",
      "items-sign",
      "items-request",
      "items-parse",
    ]);
    assert.strictEqual(updates.length, 3);
    assert.strictEqual(updates[0].meta.stage, "records");
    assert.strictEqual(updates[0].apps[0].name, "First App");
    assert.strictEqual(updates[0].apps[0].artworkUrl, undefined);
    assert.deepStrictEqual(lookupBatches, [["101"], ["202"]]);
    assert.strictEqual(updates[1].meta.enrichedCount, 1);
    assert.strictEqual(updates[1].apps[0].artworkUrl, "https://example.com/101.png");
    assert.strictEqual(updates[2].meta.complete, true);
    assert.strictEqual(result.apps[1].artworkUrl, "https://example.com/202.png");
  } finally {
    http.send = originalSend;
    store.lookupByIds = originalLookup;
  }
});

test("owned history optionally returns one complete sorted snapshot beyond the page limit", async (t) => {
  const items = [];
  for (let id = 1; id <= 205; id++) {
    items.push(...purchases.dmapTag("mlit", [
      ...purchases.dmapUint32("aeSI", id),
      ...purchases.dmapString("aeLN", `App ${id}`),
      ...purchases.dmapString("aeBI", `com.example.app${id}`),
      ...purchases.dmapUint32("asdp", 1700000000 + id),
    ]));
  }
  items.push(...purchases.dmapTag("mlit", [
    ...purchases.dmapUint32("aeSI", 2),
    ...purchases.dmapString("aeLN", "Duplicate"),
  ]));
  const requests = [];
  const signed = [];
  const reply = daapFlowMock("", items);
  t.mock.method(http, "send", async (options) => {
    requests.push(options);
    return reply(options);
  });
  const lookup = t.mock.method(store, "lookupByIds", async () => {
    throw new Error("snapshot loading must not wait for public lookups");
  });
  const result = await purchases.listOwnedApps(account, {
    page: 2, limit: 999, region: "US", includeAllApps: true, enrich: false,
    signSapBytes: async (bytes) => { signed.push(bytes.slice()); return "signature"; },
  });
  assert.strictEqual(result.totalCount, 205);
  assert.strictEqual(result.page, 2);
  assert.strictEqual(result.limit, 200);
  assert.strictEqual(result.count, 5);
  assert.deepStrictEqual(result.apps.map(app => app.id), ["5", "4", "3", "2", "1"]);
  assert.deepStrictEqual(result.allApps.map(app => app.id),
    Array.from({ length: 205 }, (_, index) => String(205 - index)));
  assert.strictEqual(result.allApps.find(app => app.id === "2").name, "App 2");
  assert.ok(result.allApps.every(app => app.owned === true && app.price === 0));
  assert.strictEqual(lookup.mock.callCount(), 0);
  const appleRequests = requests.filter(request => request.url.startsWith(purchases.BASE_URL));
  assert.deepStrictEqual(appleRequests.map(request => request.url), [
    `${purchases.BASE_URL}/login`, `${purchases.BASE_URL}/update`, `${purchases.BASE_URL}/databases/9/items`,
  ]);
  assert.strictEqual(signed.length, 2);
  assert.deepStrictEqual(purchases.bytesOf(appleRequests[1].body), signed[0]);
  assert.deepStrictEqual(purchases.bytesOf(appleRequests[2].body), signed[1]);
  result.apps[0].name = "Changed visible row";
  assert.strictEqual(result.allApps.find(app => app.id === "5").name, "App 5");
  const allowed = ["bundleID", "id", "name", "owned", "price", "purchaseDate", "version"];
  for (const app of result.allApps) assert.deepStrictEqual(Object.keys(app).sort(), allowed);
});

test("complete owned snapshots preserve unknown titles for deferred public enrichment", async (t) => {
  const item = purchases.dmapTag("mlit", [
    ...purchases.dmapUint32("aeSI", 123),
    ...purchases.dmapString("aeBI", "com.example.untitled"),
  ]);
  t.mock.method(http, "send", daapFlowMock("", item));
  t.mock.method(store, "lookupByIds", async () => [{ id: "123", name: "Later title", artworkUrl: "https://example.com/icon.png" }]);
  const result = await purchases.listOwnedApps(account, {
    includeAllApps: true, enrich: false, signSapBytes: async () => "signature",
  });
  assert.strictEqual(result.apps[0].name, "未命名 App");
  assert.strictEqual(result.allApps[0].name, "");
  const enriched = await purchases.enrichApps(result.allApps, "US");
  assert.strictEqual(enriched[0].name, "Later title");
  assert.strictEqual(result.allApps[0].name, "");
});

test("complete owned snapshots are opt-in and empty history is an explicit empty snapshot", async (t) => {
  t.mock.method(http, "send", daapFlowMock(""));
  const options = { enrich: false, signSapBytes: async () => "signature" };
  const normal = await purchases.listOwnedApps(account, options);
  assert.deepStrictEqual(Object.keys(normal).sort(), ["apps", "count", "limit", "page", "totalCount"]);
  const complete = await purchases.listOwnedApps(account, { ...options, includeAllApps: true });
  assert.deepStrictEqual(complete.allApps, []);
  assert.strictEqual(complete.totalCount, 0);
});

test("strict owned enrichment stops at the failed lookup while default callers retain raw records", async (t) => {
  const apps = [{ id: "1", name: "Known" }, { id: "2", name: "" }, { id: "3", name: "" }];
  const failure = new Error("public lookup offline");
  let calls = 0;
  t.mock.method(store, "lookupByIds", async (ids) => {
    calls++;
    if (calls === 1) return ids.map(id => ({ id, artworkUrl: "https://example.test/icon.png" }));
    throw failure;
  });
  const updates = [];
  await assert.rejects(purchases.enrichApps(apps, "US", {
    enrichBatchSize: 1, failOnLookupError: true,
    onApps: (visible, meta) => updates.push({ visible, meta }),
  }), error => error === failure);
  assert.strictEqual(calls, 2, "the failed batch must stop automatic lookup continuation");
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].visible[0].artworkUrl, "https://example.test/icon.png");
  assert.strictEqual(updates[0].meta.complete, false);
  calls = 0;
  const fallback = await purchases.enrichApps(apps, "US", { enrichBatchSize: 1 });
  assert.strictEqual(calls, 3, "default callers keep their existing best-effort behavior");
  assert.deepStrictEqual(fallback.map(app => app.id), ["1", "2", "3"]);
});

test("strict owned enrichment accepts missing public listings without retrying them", async (t) => {
  const lookup = t.mock.method(store, "lookupByIds", async () => []);
  const result = await purchases.enrichApps([{ id: "1", name: "Delisted App" }], "US", { failOnLookupError: true });
  assert.strictEqual(lookup.mock.callCount(), 1);
  assert.strictEqual(result[0].name, "Delisted App");
  assert.strictEqual(result[0].owned, true);
});
