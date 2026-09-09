const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("../scripts/lib/http");
const cookies = require("../scripts/lib/cookies");
const plist = require("../scripts/lib/plist");
const download = require("../scripts/apple/download");

const primaryURL = "https://downloaddispatch.itunes.apple.com/r/redownload?guid=001122334455";
const replayURL = "https://p11-buy.itunes.apple.com/r/redownload?guid=001122334455";
const nextURL = "https://p12-buy.itunes.apple.com/r/redownload?guid=001122334455";
const fallbackURL = "https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122334455";
const initialCookies = [{ name: "initial", value: "1", domain: "itunes.apple.com", path: "/", secure: true }];
const account = {
  email: "download@example.test", deviceIdentifier: "001122334455", pod: "p42",
  directoryServicesIdentifier: "123", passwordToken: "synthetic-token", store: "CN",
  cookies: initialCookies,
};
const app = { id: "42", name: "Demo" };
const successfulBody = plist.buildPlist({ songList: [{
  URL: "https://cdn.example.test/demo.ipa", sinfs: [{ id: 7, sinf: [1, 2, 3] }],
  metadata: { softwareVersionExternalIdentifier: "300", bundleShortVersionString: "3.0" },
}] });
const firstCookies = [
  "shared=first; Domain=.itunes.apple.com; Path=/; Secure",
  "hop=first; Path=/r; Secure",
  "other_path=first; Path=/unrelated; Secure",
];
const redirected = (extra = {}) => ({
  body: "<html>redirected POST became GET</html>", finalUrl: replayURL,
  headers: { "Set-Cookie": firstCookies }, ...extra,
});
const success = (extra = {}) => ({ body: successfulBody, ...extra });
const valid = response => response.status === 200 && plist.looksLikePlist(response.body);
const request = (extra = {}) => ({
  method: "POST", url: primaryURL, body: "synthetic-request-body", cookies: initialCookies,
  collectRedirectCookies: true, ...extra,
});

function setup(t, replies) {
  const previous = global.$http;
  const requests = [];
  global.$http = {
    request(options) {
      assert.equal(this, global.$http, "keep the JSBox native method receiver");
      requests.push(options);
      const reply = replies[requests.length - 1];
      assert.ok(reply, "unexpected replay or fallback request");
      if (reply.beforeResponse) reply.beforeResponse();
      if (reply.throw) throw reply.throw;
      options.handler({
        data: reply.body || "", error: reply.error,
        response: {
          statusCode: reply.status === undefined ? 200 : reply.status,
          url: reply.finalUrl === undefined ? options.url : reply.finalUrl,
          headers: reply.headers || {},
        },
      });
    },
    download() { throw new Error("protocol tests must never download a real IPA"); },
  };
  t.after(() => { global.$http = previous; });
  return requests;
}

test("opt-in replay uses new cookies and returns updates bound to each actual response URL", async t => {
  const finalHeaders = { "Set-Cookie": [
    "shared=final; Domain=.itunes.apple.com; Path=/; Secure", "hop=final; Path=/r; Secure",
  ] };
  const requests = setup(t, [redirected(), success({ finalUrl: nextURL, headers: finalHeaders })]);
  const originalCookies = JSON.stringify(initialCookies);
  const result = await http.sendWithRedirectRecovery(request(), valid);
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
  assert.match(requests[1].header.Cookie, /shared=first/);
  assert.match(requests[1].header.Cookie, /hop=first/);
  assert.doesNotMatch(requests[1].header.Cookie, /other_path/);
  const merged = cookies.mergeCookies(initialCookies, result.updatedCookies);
  assert.equal(merged.find(cookie => cookie.name === "shared").value, "final");
  assert.deepEqual(merged.filter(cookie => cookie.name === "hop").map(cookie => [cookie.domain, cookie.path, cookie.hostOnly, cookie.value]), [
    ["p11-buy.itunes.apple.com", "/r", true, "first"],
    ["p12-buy.itunes.apple.com", "/r", true, "final"],
  ]);
  assert.deepEqual(http.setCookiesFromResponse(result), finalHeaders["Set-Cookie"]);
  assert.equal(JSON.stringify(initialCookies), originalCookies);
});

test("download-info consumes intermediate updates before the final response cookies", async t => {
  const requests = setup(t, [redirected(), success({
    finalUrl: nextURL,
    headers: { "Set-Cookie": "shared=final; Domain=.itunes.apple.com; Path=/; Secure" },
  })]);
  const info = await download.getDownloadInfo(account, app, "300");
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
  assert.equal(info.externalVersionId, "300");
  assert.equal(info.updatedCookies.find(cookie => cookie.name === "shared").value, "final");
  assert.equal(info.updatedCookies.find(cookie => cookie.name === "hop").domain, "p11-buy.itunes.apple.com");
  assert.equal(plist.parsePlist(requests[1].body).appExtVrsId, "300");
});

test("a replay response without a native URL binds final cookies to its actual request host", async t => {
  const requests = setup(t, [redirected(), success({
    finalUrl: "", headers: { "Set-Cookie": "final_only=1; Path=/r; Secure" },
  })]);
  const info = await download.getDownloadInfo(account, app);
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
  assert.deepEqual(info.updatedCookies.filter(cookie => cookie.name === "final_only").map(cookie => cookie.domain), ["p11-buy.itunes.apple.com"]);
});

test("a failed replay supplies its earlier trusted cookies to the volumeStore fallback", async t => {
  const requests = setup(t, [redirected(), { throw: new Error("synthetic offline error") }, success()]);
  const info = await download.getDownloadInfo(account, app, "300");
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL, fallbackURL]);
  assert.match(requests[2].header.Cookie, /shared=first/);
  assert.doesNotMatch(requests[2].header.Cookie, /hop=first|other_path/);
  assert.equal(plist.parsePlist(requests[2].body).externalVersionId, "300");
  assert.ok(info.updatedCookies.some(cookie => cookie.name === "hop" && cookie.domain === "p11-buy.itunes.apple.com"));
});

test("Cookie deletion during recovery remains deleted for replay and endpoint fallback", async t => {
  const requests = setup(t, [redirected({ headers: { "Set-Cookie": [
    ...firstCookies, "initial=deleted; Domain=.itunes.apple.com; Path=/; Secure; Max-Age=0",
  ] } }), { throw: new Error("synthetic offline error") }, success()]);
  const info = await download.getDownloadInfo(account, app);
  assert.doesNotMatch(requests[1].header.Cookie, /initial=/);
  assert.doesNotMatch(requests[2].header.Cookie, /initial=/);
  assert.ok(!cookies.mergeCookies([], info.updatedCookies).some(cookie => cookie.name === "initial"));
  assert.match(requests[2].header.Cookie, /shared=first/);
});

test("a later transport exception retains structured Cookie updates and its error code", async t => {
  const failure = Object.assign(new Error("synthetic network error"), { code: "test_offline" });
  const requests = setup(t, [redirected(), { throw: failure }]);
  await assert.rejects(http.sendWithRedirectRecovery(request(), valid), error => {
    assert.equal(error.code, "test_offline");
    assert.equal(error.message, failure.message);
    assert.equal(error.updatedCookies.find(cookie => cookie.name === "hop").domain, "p11-buy.itunes.apple.com");
    return true;
  });
  assert.equal(requests.length, 2);
});

for (const failure of [
  Object.freeze(Object.assign(new Error("synthetic read-only error"), { code: "test_readonly" })),
  Object.freeze({ localizedDescription: "synthetic native bridge error", code: -1009 }),
]) {
  test(`read-only transport error ${failure.code} retains trusted updates without mutating the error`, async t => {
    setup(t, [redirected(), { throw: failure }]);
    await assert.rejects(http.sendWithRedirectRecovery(request(), valid), error => {
      assert.equal(error.code, failure.code);
      assert.equal(error.message, failure.message || failure.localizedDescription);
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "shared"));
      assert.equal(Object.hasOwn(failure, "updatedCookies"), false);
      return true;
    });
  });
}

for (const finalUrl of [
  "https://untrusted.example.test/r/redownload",
  "http://p11-buy.itunes.apple.com/r/redownload",
  "https://p11-buy.itunes.apple.com:444/r/redownload",
  "not a URL",
]) {
  test(`unsafe final response ${finalUrl} preserves preceding trusted updates only`, async t => {
    const requests = setup(t, [redirected(), success({
      finalUrl, headers: { "Set-Cookie": "poison=1; Domain=.itunes.apple.com; Path=/; Secure" },
    })]);
    await assert.rejects(http.sendWithRedirectRecovery(request(), valid), error => {
      assert.match(error.message, /不安全的重定向|无法解析的重定向/);
      assert.ok(error.updatedCookies.some(cookie => cookie.name === "shared"));
      assert.ok(!error.updatedCookies.some(cookie => cookie.name === "poison"));
      return true;
    });
    assert.equal(requests.length, 2);
  });
}

test("unsafe replay response cannot poison fallback while earlier trusted updates remain usable", async t => {
  const requests = setup(t, [redirected(), success({
    finalUrl: "https://untrusted.example.test/r/redownload",
    headers: { "Set-Cookie": "poison=1; Domain=.itunes.apple.com; Path=/; Secure" },
  }), success()]);
  const info = await download.getDownloadInfo(account, app);
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL, fallbackURL]);
  assert.match(requests[2].header.Cookie, /shared=first/);
  assert.doesNotMatch(requests[2].header.Cookie, /poison|hop=first/);
  assert.ok(!info.updatedCookies.some(cookie => cookie.name === "poison"));
});

test("cancellation keeps the first trusted in-flight response and prevents replay or fallback", async t => {
  let active = true;
  const requests = setup(t, [redirected({ beforeResponse: () => { active = false; } })]);
  await assert.rejects(download.getDownloadInfo(account, app, "300", { shouldContinue: () => active }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assert.ok(error.updatedCookies.some(cookie => cookie.name === "shared"));
    assert.equal(error.updatedCookies.find(cookie => cookie.name === "hop").domain, "p11-buy.itunes.apple.com");
    return true;
  });
  assert.deepEqual(requests.map(value => value.url), [primaryURL]);
});

test("cancellation during replay retains both trusted responses and starts no further request", async t => {
  let active = true;
  const requests = setup(t, [redirected(), redirected({
    finalUrl: nextURL, beforeResponse: () => { active = false; },
    headers: { "Set-Cookie": "settled=1; Path=/r; Secure" },
  })]);
  await assert.rejects(download.getDownloadInfo(account, app, "300", { shouldContinue: () => active }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assert.ok(error.updatedCookies.some(cookie => cookie.name === "shared"));
    assert.equal(error.updatedCookies.find(cookie => cookie.name === "settled").domain, "p12-buy.itunes.apple.com");
    return true;
  });
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
});

test("cancellation with a replay transport failure preserves prior updates and suppresses fallback", async t => {
  let active = true;
  const requests = setup(t, [redirected(), {
    throw: new Error("synthetic cancelled transport"), beforeResponse: () => { active = false; },
  }]);
  await assert.rejects(download.getDownloadInfo(account, app, "300", { shouldContinue: () => active }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assert.ok(error.updatedCookies.some(cookie => cookie.name === "shared"));
    return true;
  });
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
});

test("cancellation still rejects an unsafe response before collecting its cookies", async t => {
  let active = true;
  const requests = setup(t, [redirected(), success({
    finalUrl: "https://untrusted.example.test/r/redownload", beforeResponse: () => { active = false; },
    headers: { "Set-Cookie": "poison=1; Domain=.itunes.apple.com; Path=/; Secure" },
  })]);
  await assert.rejects(download.getDownloadInfo(account, app, "300", { shouldContinue: () => active }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assert.ok(error.updatedCookies.some(cookie => cookie.name === "shared"));
    assert.ok(!error.updatedCookies.some(cookie => cookie.name === "poison"));
    return true;
  });
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
});

test("opt-out preserves existing login/helper replay cookies and final-response shape", async t => {
  const requests = setup(t, [redirected(), success({
    headers: { "Set-Cookie": "final=1; Domain=.itunes.apple.com; Path=/; Secure" },
  })]);
  const options = request();
  delete options.collectRedirectCookies;
  const result = await http.sendWithRedirectRecovery(options, valid);
  assert.deepEqual(requests.map(value => value.url), [primaryURL, replayURL]);
  assert.equal(requests[1].header.Cookie, "initial=1");
  assert.equal(Object.hasOwn(result, "updatedCookies"), false);
  assert.deepEqual(http.setCookiesFromResponse(result), ["final=1; Domain=.itunes.apple.com; Path=/; Secure"]);
});

test("explicit opt-out preserves an unmodified transport error", async t => {
  const failure = new Error("synthetic login transport error");
  setup(t, [redirected(), { throw: failure }]);
  await assert.rejects(http.sendWithRedirectRecovery(request({ collectRedirectCookies: false }), valid), error => {
    assert.equal(error, failure);
    assert.equal(Object.hasOwn(error, "updatedCookies"), false);
    return true;
  });
});
