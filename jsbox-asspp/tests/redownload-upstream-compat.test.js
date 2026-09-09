const { test } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../scripts/config");
const download = require("../scripts/apple/download");
const plist = require("../scripts/lib/plist");

// Wire contract reviewed against Lakr233/AssppWeb on 2026-09-08:
// https://github.com/Lakr233/AssppWeb/blob/main/frontend/src/apple/download.ts
// https://github.com/Lakr233/AssppWeb/blob/main/frontend/src/apple/config.ts
// Endpoint priority deliberately follows this project's redownload-first policy.
const userAgent = "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6";
const account = {
  email: "owner@example.invalid", deviceIdentifier: "001122aabbcc", pod: "42",
  directoryServicesIdentifier: "123456789", passwordToken: "synthetic-session-token",
  storeFrontHeader: "143465-1,29", cookies: [],
};
const app = { id: "1312014438", name: "Synthetic App" };
const primaryURL = "https://downloaddispatch.itunes.apple.com/r/redownload?guid=001122aabbcc";
const fallbackURL = "https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122aabbcc";

function success(versionId = "830001234", metadata = {}) {
  return plist.buildPlist({ songList: [{
    URL: "https://iosapps.itunes.apple.com/synthetic.ipa",
    sinfs: [{ id: 0, sinf: "AAECAw==" }],
    metadata: {
      softwareVersionExternalIdentifier: versionId,
      bundleShortVersionString: "1.2.3", bundleVersion: "123", ...metadata,
    },
  }] });
}

function nativeRequests(t, replies) {
  const oldHttp = global.$http, oldData = global.$data;
  const requests = [];
  global.$data = ({ string }) => ({ string });
  global.$http = {
    request(options) {
      assert.equal(this, global.$http);
      assert.equal(typeof options.body, "object", "the native request must receive explicit UTF-8 data");
      const xml = options.body.string;
      const reply = replies[requests.length];
      requests.push({ ...options, xml, payload: plist.parsePlist(xml) });
      assert.notEqual(reply, undefined, "unexpected endpoint request or replay");
      options.handler({ data: reply, response: { statusCode: 200, url: options.url, headers: {} } });
    },
    download() { throw new Error("compatibility tests must never fetch an IPA"); },
  };
  t.after(() => { global.$http = oldHttp; global.$data = oldData; });
  return requests;
}

function assertHeaders(request) {
  assert.equal(request.method, "POST");
  assert.equal(request.header["Content-Type"], "application/x-apple-plist");
  assert.equal(request.header["iCloud-DSID"], account.directoryServicesIdentifier);
  assert.equal(request.header["X-Dsid"], account.directoryServicesIdentifier);
  assert.equal(request.header["User-Agent"], userAgent);
  // Existing account-session additions are intentional compatibility fields.
  assert.equal(request.header["X-Token"], account.passwordToken);
  assert.equal(request.header["X-Apple-Store-Front"], account.storeFrontHeader);
}

for (const [label, externalId] of [["omitted", undefined], ["null", null], ["empty", ""]]) {
  test(`latest download with ${label} build ID omits both version keys through fallback`, async t => {
    const requests = nativeRequests(t, [plist.buildPlist({ failureType: "5002" }), success()]);
    const info = await download.getDownloadInfo(account, app, externalId);
    assert.deepEqual(requests.map(request => request.url), [primaryURL, fallbackURL]);
    for (const request of requests) {
      assertHeaders(request);
      assert.deepEqual(request.payload, {
        creditDisplay: "", guid: account.deviceIdentifier, salableAdamId: app.id,
      });
      assert.match(request.xml, /<key>creditDisplay<\/key><string><\/string>/);
      assert.match(request.xml, /<key>salableAdamId<\/key><string>1312014438<\/string>/);
      assert.doesNotMatch(request.xml, /appExtVrsId|externalVersionId|passwordToken|buyProduct/);
    }
    assert.equal(info.requestedExternalVersionId, "");
    assert.equal(info.externalVersionId, "830001234");
  });
}

for (const [label, externalId] of [["string", "830001234"], ["large string", "9007199254740993"], ["numeric", 830001234]]) {
  test(`historical ${label} build ID stays an exact plist string when the endpoint changes`, async t => {
    const expectedId = String(externalId);
    const requests = nativeRequests(t, [plist.buildPlist({ failureType: "5002" }), success(expectedId)]);
    const info = await download.getDownloadInfo(account, app, externalId);
    assert.deepEqual(requests.map(request => request.url), [primaryURL, fallbackURL]);
    for (const [index, request] of requests.entries()) {
      const versionKey = index === 0 ? "appExtVrsId" : "externalVersionId";
      assertHeaders(request);
      assert.deepEqual(request.payload, {
        creditDisplay: "", guid: account.deviceIdentifier, salableAdamId: app.id,
        [versionKey]: expectedId,
      });
      assert.ok(request.xml.includes(`<key>${versionKey}</key><string>${expectedId}</string>`));
      assert.equal(new URL(request.url).searchParams.size, 1, "the build ID belongs in the plist body, not the query");
    }
    assert.equal(info.requestedExternalVersionId, expectedId);
    assert.equal(info.externalVersionId, expectedId);
  });
}

test("endpoint configuration and User-Agent retain the upstream contract", () => {
  assert.equal(config.USER_AGENT, userAgent);
  assert.deepEqual(config.redownloadEndpoint(account.deviceIdentifier), {
    host: "downloaddispatch.itunes.apple.com", path: "/r/redownload?guid=001122aabbcc", externalVersionIdKey: "appExtVrsId",
  });
  assert.deepEqual(config.volumeStoreEndpoint(undefined, account.deviceIdentifier), {
    host: "p25-buy.itunes.apple.com",
    path: "/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122aabbcc", externalVersionIdKey: "externalVersionId",
  });
  assert.deepEqual(config.volumeStoreEndpoint("p42", account.deviceIdentifier), config.volumeStoreEndpoint("42", account.deviceIdentifier));
});

test("real plist data SINF and Unicode metadata preserve bytes while removing the response token", async t => {
  const response = `<?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict><key>songList</key><array><dict>
      <key>URL</key><string>https://iosapps.itunes.apple.com/synthetic.ipa</string>
      <key>sinfs</key><array><dict><key>id</key><integer>0</integer><key>sinf</key><data>AAECAw==</data></dict></array>
      <key>metadata</key><dict>
        <key>softwareVersionExternalIdentifier</key><integer>830001234</integer>
        <key>bundleShortVersionString</key><string>1.2.3</string>
        <key>bundleVersion</key><string>123</string>
        <key>itemName</key><string>测试相机 &amp; Editor</string>
        <key>apple-id</key><string>old@example.invalid</string>
        <key>userName</key><string>old@example.invalid</string>
        <key>passwordToken</key><string>synthetic-response-token</string>
      </dict>
    </dict></array></dict></plist>`;
  const requests = nativeRequests(t, [response]);
  const info = await download.getDownloadInfo(account, app, "830001234");
  assert.deepEqual(requests.map(request => request.url), [primaryURL]);
  assert.deepEqual(info.sinfs, [{ id: 0, sinf: "AAECAw==" }]);
  assert.equal(info.bundleShortVersionString, "1.2.3");
  assert.equal(info.bundleVersion, "123");
  const metadataXML = Buffer.from(info.iTunesMetadataBase64, "base64").toString("utf8");
  const metadata = plist.parsePlist(metadataXML);
  assert.equal(metadata.itemName, "测试相机 & Editor");
  assert.equal(metadata["apple-id"], account.email);
  assert.equal(metadata.userName, account.email);
  assert.equal(metadata.passwordToken, undefined);
  assert.doesNotMatch(metadataXML, /synthetic-response-token/);
  assert.deepEqual(metadata, info.metadata);
});
