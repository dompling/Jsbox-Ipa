const { test } = require("node:test");
const assert = require("node:assert");

const http = require("../scripts/lib/http");
const plist = require("../scripts/lib/plist");
const purchase = require("../scripts/apple/purchase");

test("2059 STDQ fallback carries refreshed cookies into the GAME retry", async () => {
  const original = http.sendWithRedirectRecovery;
  const cookieSnapshots = [];
  let attempt = 0;
  http.sendWithRedirectRecovery = async (options) => {
    cookieSnapshots.push((options.cookies || []).map((cookie) => cookie.name));
    attempt++;
    if (attempt === 1) {
      return {
        status: 200,
        finalUrl: options.url,
        headers: {
          "set-cookie": "fresh=1; Domain=.itunes.apple.com; Path=/; Secure",
        },
        body: plist.buildPlist({
          failureType: "2059",
          customerMessage: "retry",
        }),
      };
    }
    return {
      status: 200,
      finalUrl: options.url,
      headers: {},
      body: plist.buildPlist({ jingleDocType: "purchaseSuccess", status: 0 }),
    };
  };
  try {
    const result = await purchase.purchaseApp(
      {
        deviceIdentifier: "001122334455",
        directoryServicesIdentifier: "123",
        passwordToken: "token",
        store: "US",
        storeFrontId: "143441",
        cookies: [{ name: "old", value: "1", domain: "itunes.apple.com", path: "/" }],
      },
      { id: "1", price: 0 }
    );
    assert.deepStrictEqual(cookieSnapshots, [["old"], ["old", "fresh"]]);
    assert.ok(result.updatedCookies.some((cookie) => cookie.name === "fresh"));
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("purchase preserves a complete storefront header and normalizes a p-prefixed pod", async () => {
  const original = http.sendWithRedirectRecovery;
  let captured;
  http.sendWithRedirectRecovery = async (options) => {
    captured = options;
    return {
      status: 200,
      finalUrl: options.url,
      headers: {},
      body: plist.buildPlist({ jingleDocType: "purchaseSuccess", status: 0 }),
    };
  };
  try {
    await purchase.purchaseApp(
      {
        deviceIdentifier: "001122334455",
        directoryServicesIdentifier: "123",
        passwordToken: "token",
        store: "CN",
        storeFrontHeader: "143465-1,29",
        pod: "p42",
        cookies: [],
      },
      { id: "1", price: 0 }
    );
    assert.strictEqual(captured.url, "https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct");
    assert.strictEqual(captured.headers["X-Apple-Store-Front"], "143465-1,29");
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("a failed GAME transport still returns the cookies refreshed by STDQ", async (t) => {
  let attempt = 0;
  t.mock.method(http, "sendWithRedirectRecovery", async options => {
    if (++attempt > 1) throw new Error("synthetic transport failure");
    return {
      status: 200, finalUrl: options.url,
      headers: { "set-cookie": "fresh=1; Domain=.itunes.apple.com; Path=/; Secure" },
      body: plist.buildPlist({ failureType: "2059" }),
    };
  });
  await assert.rejects(purchase.purchaseApp({
    deviceIdentifier: "001122334455", directoryServicesIdentifier: "123", passwordToken: "synthetic",
    store: "US", cookies: [],
  }, { id: "42", price: 0 }), error => {
    assert.match(error.message, /synthetic transport/);
    assert.ok(error.updatedCookies.some(cookie => cookie.name === "fresh"));
    return true;
  });
});
