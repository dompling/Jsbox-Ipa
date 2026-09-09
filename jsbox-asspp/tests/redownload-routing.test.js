const { test } = require("node:test");
const assert = require("node:assert/strict");
const plist = require("../scripts/lib/plist");
const download = require("../scripts/apple/download");

const account = {
  email: "download@example.test", deviceIdentifier: "001122334455", pod: "p42",
  directoryServicesIdentifier: "123", passwordToken: "synthetic-token", store: "CN",
  storeFrontHeader: "143465-1,29",
  cookies: [{ name: "initial", value: "1", domain: "itunes.apple.com", path: "/", secure: true }],
};
const app = { id: "42", name: "Demo" };
const primaryURL = "https://downloaddispatch.itunes.apple.com/r/redownload?guid=001122334455";
const fallbackURL = "https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122334455";
const item = (extra = {}) => ({
  URL: "https://cdn.example.test/demo.ipa", sinfs: [{ id: 7, sinf: [1, 2, 3] }],
  metadata: { softwareVersionExternalIdentifier: "300", bundleShortVersionString: "3.0", bundleVersion: "30" },
  ...extra,
});
const success = extra => ({ dict: { songList: [item(extra)] } });

function setup(t, replies) {
  const previous = global.$http;
  const requests = [];
  global.$http = {
    request(options) {
      assert.equal(this, global.$http, "preserve the JSBox native method receiver");
      const request = { ...options, payload: plist.parsePlist(options.body) };
      requests.push(request);
      const reply = replies[requests.length - 1];
      assert.ok(reply, "unexpected repeated endpoint request");
      if (reply.beforeResponse) reply.beforeResponse();
      if (reply.throw) throw reply.throw;
      options.handler({
        data: reply.body === undefined ? plist.buildPlist(reply.dict || {}) : reply.body,
        error: reply.error,
        response: {
          statusCode: reply.status === undefined ? 200 : reply.status,
          url: reply.finalUrl || options.url,
          headers: reply.headers || {},
        },
      });
    },
    download() { throw new Error("download-info tests must never fetch a real IPA"); },
  };
  t.after(() => { global.$http = previous; });
  return requests;
}

test("successful redownload is the only endpoint and carries the logged-in session", async t => {
  const requests = setup(t, [success()]);
  const info = await download.getDownloadInfo(account, app);
  assert.deepEqual(requests.map(value => value.url), [primaryURL]);
  assert.equal(info.downloadURL, item().URL);
  assert.equal(info.externalVersionId, "300");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].header["X-Token"], account.passwordToken);
  assert.equal(requests[0].header["X-Dsid"], account.directoryServicesIdentifier);
  assert.equal(requests[0].header["iCloud-DSID"], account.directoryServicesIdentifier);
  assert.equal(requests[0].header["X-Apple-Store-Front"], account.storeFrontHeader);
  assert.equal(requests[0].header.Cookie, "initial=1");
  assert.equal(requests[0].payload.salableAdamId, "42");
  assert.equal(requests[0].payload.guid, account.deviceIdentifier);
  assert.equal(requests[0].payload.appExtVrsId, undefined);
  assert.equal(requests[0].payload.externalVersionId, undefined);
});

for (const [name, reply] of [
  ["transport rejection", { throw: new Error("synthetic offline error") }],
  ["native failed response", { error: new Error("synthetic native failure"), ...success() }],
  ["HTTP error", { status: 503, body: "not a plist" }],
  ["Apple temporary failure", { dict: { failureType: "5002" } }],
  ["Apple session failure", { dict: { failureType: "2034" } }],
  ["Apple missing-license response", { dict: { failureType: "9610" } }],
  ["empty body", { body: "" }],
  ["malformed plist", { body: "<plist><dict><key>unfinished" }],
  ["empty song list", { dict: { songList: [] } }],
  ["missing URL", success({ URL: "" })],
  ["missing SINF", success({ sinfs: [] })],
  ["invalid SINF", success({ sinfs: [{ id: 7, sinf: { invalid: true } }] })],
]) {
  test(`${name} from redownload falls back once to volumeStore`, async t => {
    const requests = setup(t, [reply, success()]);
    const info = await download.getDownloadInfo(account, app);
    assert.deepEqual(requests.map(value => value.url), [primaryURL, fallbackURL]);
    assert.equal(info.downloadURL, item().URL);
    assert.equal(info.externalVersionId, "300");
  });
}

test("fallback switches only the historical-ID field and carries scoped response cookies", async t => {
  const requests = setup(t, [{
    dict: { failureType: "5002" },
    headers: { "Set-Cookie": [
      "shared=fresh; Domain=.itunes.apple.com; Path=/; Secure",
      "dispatch_only=1; Path=/; Secure",
    ] },
  }, success()]);
  const info = await download.getDownloadInfo(account, app, "300");
  assert.deepEqual(requests.map(value => value.url), [primaryURL, fallbackURL]);
  assert.equal(requests[0].payload.appExtVrsId, "300");
  assert.equal(requests[0].payload.externalVersionId, undefined);
  assert.equal(requests[1].payload.externalVersionId, "300");
  assert.equal(requests[1].payload.appExtVrsId, undefined);
  assert.match(requests[1].header.Cookie, /shared=fresh/);
  assert.doesNotMatch(requests[1].header.Cookie, /dispatch_only/);
  assert.ok(info.updatedCookies.some(cookie => cookie.name === "dispatch_only"));
  assert.ok(info.updatedCookies.some(cookie => cookie.name === "shared"));
  assert.equal(info.requestedExternalVersionId, "300");
});

test("wrong historical metadata from redownload triggers fallback without substituting a version", async t => {
  const requests = setup(t, [success({ metadata: { softwareVersionExternalIdentifier: "999", bundleShortVersionString: "9.9" } }), success()]);
  const info = await download.getDownloadInfo(account, app, "300");
  assert.deepEqual(requests.map(value => value.url), [primaryURL, fallbackURL]);
  assert.equal(info.externalVersionId, "300");
  assert.equal(info.bundleShortVersionString, "3.0");
});

test("history metadata uses redownload but does not require IPA URL or SINF", async t => {
  const requests = setup(t, [{ dict: { songList: [{ metadata: item().metadata }] } }]);
  const version = await download.getVersionMetadata(account, app, "300");
  assert.deepEqual(requests.map(value => value.url), [primaryURL]);
  assert.equal(requests[0].payload.appExtVrsId, "300");
  assert.equal(version.displayVersion, "3.0");
  assert.equal(version.externalVersionId, "300");
});

test("history metadata with no song item uses the same fallback while unknown version fields remain valid", async t => {
  const requests = setup(t, [{ dict: { songList: [] } }, { dict: { songList: [{ metadata: {} }] } }]);
  const version = await download.getVersionMetadata(account, app, "300");
  assert.deepEqual(requests.map(value => value.url), [primaryURL, fallbackURL]);
  assert.equal(version.id, "300");
  assert.equal(version.externalVersionId, "");
  assert.equal(version.displayVersion, "");
});

for (const code of ["5002", "2034", "2042", "9610"]) {
  test(`two failed endpoints preserve cookies and final Apple code ${code} without a request loop`, async t => {
    const requests = setup(t, [
      { dict: { failureType: "5002" }, headers: { "Set-Cookie": "dispatch=1; Domain=.itunes.apple.com; Path=/; Secure" } },
      { dict: { failureType: code }, headers: { "Set-Cookie": "volume=1; Domain=.itunes.apple.com; Path=/; Secure" } },
    ]);
    await assert.rejects(download.getDownloadInfo(account, app), error => {
      assert.equal(error.code, code);
      assert.equal(error.needsAppStore, code === "9610");
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "dispatch"));
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "volume"));
      return true;
    });
    assert.deepEqual(requests.map(value => value.url), [primaryURL, fallbackURL]);
  });
}

test("cancellation before a request skips both endpoints", async t => {
  const requests = setup(t, []);
  await assert.rejects(download.getDownloadInfo(account, app, undefined, { shouldContinue: () => false }), error => error.code === "version_list_cancelled");
  assert.equal(requests.length, 0);
});

test("cancellation after a failed primary response keeps its cookies and suppresses fallback", async t => {
  let active = true;
  const requests = setup(t, [{
    dict: { failureType: "5002" },
    beforeResponse: () => { active = false; },
    headers: { "Set-Cookie": "settled=1; Domain=.itunes.apple.com; Path=/; Secure" },
  }]);
  await assert.rejects(download.getDownloadInfo(account, app, "300", { shouldContinue: () => active }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assert.ok(error.updatedCookies.some(cookie => cookie.name === "settled"));
    return true;
  });
  assert.deepEqual(requests.map(value => value.url), [primaryURL]);
});

test("an unsafe primary redirect is never replayed or allowed to supply fallback cookies", async t => {
  const requests = setup(t, [{
    finalUrl: "https://untrusted.example.test/r/redownload", ...success(),
    headers: { "Set-Cookie": "untrusted=1; Domain=.itunes.apple.com; Path=/; Secure" },
  }, success()]);
  await download.getDownloadInfo(account, app);
  assert.deepEqual(requests.map(value => value.url), [primaryURL, fallbackURL]);
  assert.doesNotMatch(requests[1].header.Cookie, /untrusted/);
});
