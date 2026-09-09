const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("../scripts/lib/http");
const plist = require("../scripts/lib/plist");
const purchase = require("../scripts/apple/purchase");
const download = require("../scripts/apple/download");
const store = require("../scripts/apple/store");

const account = { email: "synthetic@example.invalid", deviceIdentifier: "001122334455", directoryServicesIdentifier: "123", passwordToken: "synthetic", store: "US", cookies: [] };
const app = { id: "42", price: 0 };
function info(id, extra) {
  return { songList: [{ URL: "https://cdn.example/demo.ipa", sinfs: [{ id: 1, sinf: "AQI=" }], metadata: { softwareVersionExternalIdentifier: id, ...extra } }] };
}
function reply(options, dict, status = 200, cookie = "") {
  return { status, finalUrl: options.url, headers: cookie ? { "set-cookie": `${cookie}=1; Domain=.itunes.apple.com; Path=/; Secure` } : {}, body: plist.buildPlist(dict) };
}

test("new licenses reject unknown and nonzero prices without sending HTTP", async (t) => {
  const send = t.mock.method(http, "sendWithRedirectRecovery", async options => reply(options, { jingleDocType: "purchaseSuccess", status: 0 }));
  for (const price of [undefined, null, "", " ", false, true, NaN, Infinity, -1, "bad", 1]) {
    await assert.rejects(purchase.purchaseApp(account, { ...app, price }));
  }
  assert.equal(send.mock.callCount(), 0);
  for (const price of [0, "0", "0.00"]) await purchase.purchaseApp(account, { ...app, price });
  assert.equal(send.mock.callCount(), 3);
});

test("RSS missing or malformed prices survive mapping as unknown", async (t) => {
  t.mock.method(http, "send", async () => ({ status: 200, data: { feed: { entry: [
    { id: { attributes: { "im:id": "42" } } },
    { id: { attributes: { "im:id": "43" } }, "im:price": { attributes: { amount: "invalid" } } },
    { id: { attributes: { "im:id": "44" } }, "im:price": { attributes: { amount: "0" } } },
  ] } } }));
  const chart = await store.fetchChart("topfreeapplications", "US");
  assert.notEqual(chart[0].price, 0);
  assert.notEqual(chart[1].price, 0);
  assert.equal(chart[2].price, 0);
});

test("non-success HTTP cannot be accepted through a success-shaped plist", async (t) => {
  const send = t.mock.method(http, "sendWithRedirectRecovery");
  for (const status of [401, 503]) {
    send.mock.mockImplementation(async options => reply(options, { jingleDocType: "purchaseSuccess", status: 0 }, status, "fresh"));
    await assert.rejects(purchase.purchaseApp(account, app), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "fresh"));
      return true;
    });
    send.mock.mockImplementation(async options => reply(options, info("111"), status, "fresh"));
    await assert.rejects(download.getDownloadInfo(account, app), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "fresh"));
      return true;
    });
  }
});

test("a requested external ID never replaces a conflicting or missing response ID", async (t) => {
  const send = t.mock.method(http, "sendWithRedirectRecovery", async options => reply(options, info("222")));
  await assert.rejects(download.getDownloadInfo(account, app, "111"), /版本.*不匹配/);
  await assert.rejects(download.getVersionMetadata(account, app, "111"), /版本.*不匹配/);
  send.mock.mockImplementation(async options => reply(options, info(undefined)));
  const result = await download.getDownloadInfo(account, app, "111");
  assert.equal(result.externalVersionId, "");
  assert.equal(result.requestedExternalVersionId, "111");
});

test("version enumeration rolls cookies forward and propagates auth, license and network errors", async (t) => {
  const calls = [];
  const send = t.mock.method(http, "sendWithRedirectRecovery", async options => {
    calls.push((options.cookies || []).map(cookie => cookie.name));
    const body = plist.parsePlist(options.body);
    const id = body.appExtVrsId || body.externalVersionId;
    return reply(options, info(id || "103", id ? {} : {
      bundleShortVersionString: "3.0", softwareVersionExternalIdentifiers: ["101", "102", "103"],
    }), 200, `fresh${calls.length}`);
  });
  const result = await download.listVersions(account, app);
  assert.deepEqual(calls, [[], ["fresh1"], ["fresh1", "fresh2"]]);
  assert.equal(result.versions.length, 3);
  for (const code of ["2034", "2042", "9610", "network"]) {
    let first = true;
    send.mock.mockImplementation(async options => {
      if (first) {
        first = false;
        return reply(options, info("103", { bundleShortVersionString: "3.0", softwareVersionExternalIdentifiers: ["101", "103"] }), 200, "fresh");
      }
      if (code === "network") return { failed: true, error: new Error("synthetic network error"), finalUrl: options.url };
      return reply(options, { failureType: code }, 200, "later");
    });
    await assert.rejects(download.listVersions(account, app), error => {
      if (code !== "network") assert.equal(error.code, code);
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "fresh"));
      return true;
    });
  }
});
