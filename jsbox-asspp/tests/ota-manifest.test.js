const { test } = require("node:test");
const assert = require("node:assert");
const ota = require("../scripts/lib/ota-manifest");
const plist = require("../scripts/lib/plist");

test("buildOtaManifest produces parseable plist", () => {
  const xml = ota.buildOtaManifest({
    ipaUrl: "http://127.0.0.1:23333/app.ipa",
    title: "微信",
    bundleId: "com.tencent.xin",
    version: "8.0.1",
    iconSmallUrl: "http://127.0.0.1:23333/icon57.png",
    iconLargeUrl: "http://127.0.0.1:23333/icon512.png",
  });
  assert.match(xml, /<plist version="1.0">/);
  const parsed = plist.parsePlist(xml);
  const item = parsed.items[0];
  const assets = item.assets;
  assert.strictEqual(assets[0].kind, "software-package");
  assert.strictEqual(assets[0].url, "http://127.0.0.1:23333/app.ipa");
  assert.strictEqual(item.metadata["bundle-identifier"], "com.tencent.xin");
  assert.strictEqual(item.metadata["bundle-version"], "8.0.1");
  assert.strictEqual(item.metadata.title, "微信");
});

test("buildItmsUrl encodes manifest url", () => {
  const url = ota.buildItmsUrl("http://127.0.0.1:23333/manifest.plist");
  assert.strictEqual(
    url,
    "itms-services://?action=download-manifest&url=http%3A%2F%2F127.0.0.1%3A23333%2Fmanifest.plist"
  );
});

test("OTA manifest rejects unsafe or incomplete metadata", () => {
  assert.throws(
    () => ota.buildOtaManifest({ ipaUrl: "file:///tmp/app.ipa", bundleId: "com.demo" }),
    /http/
  );
  assert.throws(
    () => ota.buildOtaManifest({ ipaUrl: "https://example.com/app.ipa", bundleId: "../bad" }),
    /bundleId/
  );
  assert.throws(
    () => ota.buildOtaManifest({ ipaUrl: "https://example.com/app.ipa", bundleId: "com.demo" }),
    /版本/
  );
});

test("OTA manifest URL validation works without the WHATWG URL global", () => {
  const previousURL = global.URL;
  try {
    global.URL = undefined;
    const xml = ota.buildOtaManifest({
      ipaUrl: "http://127.0.0.1:23333/app.ipa",
      bundleId: "com.demo.app",
      version: "1.0.0",
    });
    assert.match(xml, /127\.0\.0\.1:23333\/app\.ipa/);
    assert.throws(
      () => ota.buildOtaManifest({
        ipaUrl: "http://user:pass@127.0.0.1:23333/app.ipa",
        bundleId: "com.demo.app",
        version: "1.0.0",
      }),
      /凭据/
    );
  } finally {
    global.URL = previousURL;
  }
});
