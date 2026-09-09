const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const config = require("../scripts/config");

test("storefront mapping", () => {
  assert.strictEqual(config.countryToStoreId("cn"), "143465");
  assert.strictEqual(config.countryToStoreId("US"), "143441");
  assert.strictEqual(config.storeIdToCountry("143462"), "JP");
});

test("endpoint builders", () => {
  assert.strictEqual(
    config.volumeStoreEndpoint("", "abc123").host,
    "p25-buy.itunes.apple.com"
  );
  assert.strictEqual(
    config.volumeStoreEndpoint("72", "abc123").host,
    "p72-buy.itunes.apple.com"
  );
  assert.ok(
    config.volumeStoreEndpoint("", "abc").path.indexOf("guid=abc") > 0
  );
  assert.strictEqual(
    config.redownloadEndpoint("abc").host,
    "downloaddispatch.itunes.apple.com"
  );
  assert.strictEqual(
    config.purchaseAPIHost("72"),
    "p72-buy.itunes.apple.com"
  );
  assert.strictEqual(config.purchaseAPIHost(""), "buy.itunes.apple.com");
  assert.strictEqual(config.purchaseAPIHost("p72"), "p72-buy.itunes.apple.com");
  assert.strictEqual(config.purchaseAPIHost("p72-buy"), "buy.itunes.apple.com");
});

test("storefront and pod values are normalized before entering request headers/hosts", () => {
  assert.strictEqual(config.normalizeStoreFrontHeader("143465-1,29"), "143465-1,29");
  assert.strictEqual(config.normalizeStoreFrontHeader("143465-1,29\n"), "143465-1,29");
  assert.strictEqual(config.normalizeStoreFrontHeader("evil.example"), "");
  assert.strictEqual(config.normalizeStoreFrontId("CN"), "143465");
  assert.strictEqual(config.normalizeStoreFrontId("143465-1,29"), "143465");
  assert.strictEqual(config.storeFrontHeaderFor({ storeFrontHeader: "143465-1,29" }, "-1"), "143465-1,29");
  assert.strictEqual(config.storeFrontHeaderFor({ storeFrontId: "143465" }, "-1,29"), "143465-1,29");
  assert.strictEqual(config.normalizePod("p42"), "42");
  assert.strictEqual(config.normalizePod("42"), "42");
  assert.strictEqual(config.normalizePod("p42-buy"), "");
});

test("public api url builders", () => {
  assert.match(config.searchURL("微信", "CN", 10), /itunes\.apple\.com\/search/);
  assert.ok(
    config.searchURL("微信", "CN", 10).indexOf("term=") > 0 &&
      config.searchURL("微信", "CN", 10).indexOf("country=CN") > 0
  );
  assert.ok(config.searchURL("微信", "CN", 10).indexOf("entity=software") > 0);
  assert.ok(
    config.searchURL("微信", "CN", 10, "iPadSoftware").indexOf("entity=iPadSoftware") > 0
  );
  assert.match(config.lookupURL([1, 2], "US"), /id=1%2C2/);
  assert.match(config.lookupByBundleURL("com.apple.mobilemail", "CN"), /bundleId=/);
  assert.strictEqual(
    config.chartFeedURL("CN", "topfreeapplications", 25),
    "https://itunes.apple.com/cn/rss/topfreeapplications/limit=25/json"
  );
  assert.strictEqual(
    config.chartFeedURL("US", "topgrossingapplications", 10, 6018),
    "https://itunes.apple.com/us/rss/topgrossingapplications/limit=10/genre=6018/json"
  );
});

test("user agent looks like Configurator", () => {
  assert.match(config.USER_AGENT, /^Configurator\/\d/);
});

test("package compatibility floor matches the UI APIs and app version", () => {
  const packageConfig = JSON.parse(
    fs.readFileSync(require.resolve("../config.json"), "utf8")
  );
  assert.strictEqual(packageConfig.info.version, config.APP.version);
  assert.ok(Number(packageConfig.settings.minSDKVer.split(".")[0]) >= 2);
  assert.ok(Number(packageConfig.settings.minOSVer.split(".")[0]) >= 13);
});
