const { test } = require("node:test");
const assert = require("node:assert/strict");
const cookies = require("../scripts/lib/cookies");
const plist = require("../scripts/lib/plist");
const download = require("../scripts/apple/download");
const downloader = require("../scripts/services/downloader");
const accounts = require("../scripts/store/accounts");

const app = { id: "42", name: "Demo", price: 0 };
const primaryURL = "https://downloaddispatch.itunes.apple.com/r/redownload?guid=001122334455";
const fallbackURL = "https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122334455";
const preserveExpired = { preserveExpired: true };
const deletion = "obsolete=; Domain=.itunes.apple.com; Path=/; Secure; Max-Age=0";
const renewal = "obsolete=renewed; Domain=.itunes.apple.com; Path=/; Secure";
const cookie = (name, value = "original", extra = {}) => ({
  name, value, domain: "itunes.apple.com", path: "/", secure: true, ...extra,
});
const find = (jar, name = "obsolete", path = "/", domain = "itunes.apple.com") =>
  (jar || []).find(value => value.name === name && value.path === path && value.domain === domain);
const active = jar => cookies.mergeCookies([], jar);
const success = (id = "", identifiers = ["100", "200", "300"]) => ({ dict: { songList: [{
  URL: "https://cdn.example.invalid/demo.ipa", sinfs: [{ id: 1, sinf: "AQID" }],
  metadata: {
    softwareVersionExternalIdentifier: id || "300", softwareVersionExternalIdentifiers: identifiers,
    bundleShortVersionString: id ? "1.0" : "3.0",
  },
}] } });
const failed = () => ({ dict: { failureType: "5002" } });

function assertDeletionUpdate(jar) {
  const removed = find(jar);
  assert.ok(removed, "outward updates must retain the deletion record");
  assert.ok(removed.expiresAt <= Date.now() / 1000);
  assert.equal(find(active(jar)), undefined);
}

function concurrentCookie(state) {
  const stored = state.stored.get(state.account.email);
  state.stored.set(stored.email, {
    ...stored, cookies: cookies.mergeCookies(stored.cookies, [cookie("concurrent", "new")]),
  });
}

function refreshedStoredCookie(state) {
  const stored = state.stored.get(state.account.email);
  state.stored.set(stored.email, {
    ...stored, cookies: cookies.mergeCookies(stored.cookies, [cookie("obsolete", "refreshed"), cookie("concurrent", "new")]),
  });
}

function assertPersistedDeletion(state) {
  const stored = state.stored.get(state.account.email);
  assert.equal(find(stored.cookies), undefined);
  assert.equal(find(stored.cookies, "concurrent").value, "new");
  assert.equal(stored.cookies.some(value => value.expiresAt !== undefined && value.expiresAt <= Date.now() / 1000), false);
}

function fixture(t, replies, initialCookies = [cookie("obsolete")]) {
  const account = {
    email: "deletion@example.invalid", store: "US", autoRelogin: false,
    deviceIdentifier: "001122334455", pod: "p42", directoryServicesIdentifier: "123",
    passwordToken: "synthetic-token", cookies: initialCookies,
  };
  const stored = new Map([[account.email, { ...account, cookies: account.cookies.slice() }]]);
  const state = { account, stored, requests: [] };
  t.mock.method(accounts, "getAccount", email => stored.get(email) || null);
  t.mock.method(accounts, "saveAccount", value => { stored.set(value.email, value); return value; });
  const previous = global.$http;
  global.$http = {
    request(options) {
      assert.equal(this, global.$http, "keep the JSBox native method receiver");
      const payload = plist.parsePlist(options.body);
      const id = String(payload.appExtVrsId || payload.externalVersionId || "");
      state.requests.push({ id, cookie: options.header.Cookie || "", url: options.url });
      const reply = replies[state.requests.length - 1];
      assert.ok(reply, "unexpected replay, fallback, or authentication request");
      if (reply.beforeResponse) reply.beforeResponse(state);
      options.handler({
        data: plist.buildPlist(reply.dict),
        response: { statusCode: 200, url: options.url, headers: reply.cookie ? { "Set-Cookie": reply.cookie } : {} },
      });
    },
    download() { throw new Error("Cookie tests must never download a real IPA"); },
  };
  t.after(() => { global.$http = previous; });
  return state;
}

test("Cookie merging preserves expiration updates only when explicitly enabled", () => {
  const original = [cookie("obsolete"), cookie("stable")];
  const removed = cookies.parseCookieHeaders([deletion], primaryURL);
  const defaultResult = cookies.mergeCookies(original, removed);
  assert.equal(find(defaultResult), undefined);
  assert.deepEqual(cookies.mergeCookies(original, removed, { preserveExpired: false }), defaultResult);
  assert.deepEqual(cookies.mergeCookies(original, removed, { preserveExpired: "true" }), defaultResult);

  const updated = cookies.mergeCookies(original, removed, preserveExpired);
  assertDeletionUpdate(updated);
  assert.equal(find(updated, "stable").value, "original");
  assertDeletionUpdate(cookies.mergeCookies(updated, [], preserveExpired));
  assert.equal(find(cookies.mergeCookies(updated, [])), undefined);
  assert.doesNotMatch(cookies.buildCookieHeader(updated, primaryURL), /obsolete=/);
  assert.equal(find(original).value, "original", "input records must not be changed");
});

test("preserved deletions stay scoped by name/domain/path and later values replace the deletion", () => {
  const samePathOtherHost = cookie("obsolete", "other-host", { domain: "p55-buy.itunes.apple.com", hostOnly: true });
  const otherPath = cookie("obsolete", "other-path", { path: "/other" });
  const original = [cookie("obsolete"), otherPath, samePathOtherHost];
  const removed = cookies.parseCookieHeaders([deletion], primaryURL);
  const updated = cookies.mergeCookies(original, removed, preserveExpired);
  assertDeletionUpdate(updated);
  assert.equal(find(updated, "obsolete", "/other").value, "other-path");
  assert.equal(find(updated, "obsolete", "/", "p55-buy.itunes.apple.com").value, "other-host");
  assert.equal(cookies.buildCookieHeader(updated, "https://p55-buy.itunes.apple.com/other/file"), "obsolete=other-path; obsolete=other-host");

  const restored = cookies.mergeCookies(updated, cookies.parseCookieHeaders([renewal], primaryURL), preserveExpired);
  assert.equal(find(restored).value, "renewed");
  assert.equal(find(restored).expiresAt, undefined);
  assert.equal(restored.filter(value => value.name === "obsolete" && value.domain === "itunes.apple.com" && value.path === "/").length, 1);
  assert.match(cookies.buildCookieHeader(restored, primaryURL), /obsolete=renewed/);
});

test("preserving deletions still rejects invalid records and normalizes Cookie scopes", () => {
  const updated = cookies.mergeCookies([], [
    cookie("obsolete", "", { domain: ".ITUNES.APPLE.COM", path: "invalid", expiresAt: 1 }),
    cookie("invalid name", "", { expiresAt: 1 }),
    cookie("bad_value", "injected;header", { expiresAt: 1 }),
  ], preserveExpired);
  assert.equal(updated.length, 1);
  assertDeletionUpdate(updated);
  assert.equal(updated[0].domain, "itunes.apple.com");
  assert.equal(updated[0].path, "/");
});

test("download success preserves deletion through persistence without losing concurrent or other scoped cookies", async t => {
  const state = fixture(t, [{ ...success(), cookie: deletion, beforeResponse: concurrentCookie }], [
    cookie("obsolete"), cookie("obsolete", "other-path", { path: "/other" }),
    cookie("obsolete", "other-host", { domain: "p55-buy.itunes.apple.com", hostOnly: true }),
  ]);
  const info = await download.getDownloadInfo(state.account, app);
  assertDeletionUpdate(info.updatedCookies);
  downloader.persistAccount(state.account, info.updatedCookies);
  assertPersistedDeletion(state);
  const stored = state.stored.get(state.account.email);
  assert.equal(find(stored.cookies, "obsolete", "/other").value, "other-path");
  assert.equal(find(stored.cookies, "obsolete", "/", "p55-buy.itunes.apple.com").value, "other-host");
  assert.deepEqual(state.requests.map(value => value.url), [primaryURL]);
});

test("failed download endpoints retain a deletion for persistence while fallback omits it", async t => {
  const state = fixture(t, [
    { ...failed(), cookie: deletion, beforeResponse: concurrentCookie }, failed(),
  ]);
  await assert.rejects(download.getDownloadInfo(state.account, app), error => {
    assert.equal(error.code, "5002");
    assertDeletionUpdate(error.updatedCookies);
    downloader.persistAccount(state.account, error.updatedCookies);
    return true;
  });
  assert.deepEqual(state.requests.map(value => value.url), [primaryURL, fallbackURL]);
  assert.doesNotMatch(state.requests[1].cookie, /obsolete=/);
  assertPersistedDeletion(state);
});

test("cancelled download information retains the settled deletion and starts no fallback", async t => {
  let activeRequest = true;
  const state = fixture(t, [{ ...success(), cookie: deletion, beforeResponse: value => {
    concurrentCookie(value); activeRequest = false;
  } }]);
  await assert.rejects(download.getDownloadInfo(state.account, app, undefined, { shouldContinue: () => activeRequest }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assertDeletionUpdate(error.updatedCookies);
    downloader.persistAccount(state.account, error.updatedCookies);
    return true;
  });
  assert.equal(state.requests.length, 1);
  assertPersistedDeletion(state);
});

test("history initial deletion is absent from every metadata request and the stored session", async t => {
  const state = fixture(t, [
    { ...success(), cookie: deletion, beforeResponse: concurrentCookie }, success("200"), success("100"),
  ]);
  const result = await downloader.listVersions(state.account, app);
  assert.deepEqual(state.requests.map(value => value.id), ["", "200", "100"]);
  for (const request of state.requests.slice(1)) assert.doesNotMatch(request.cookie, /obsolete=/);
  assertDeletionUpdate(result.updatedCookies);
  assertPersistedDeletion(state);
});

test("history metadata deletion is carried into the next version and final persistence", async t => {
  const state = fixture(t, [
    success(), { ...success("200"), cookie: deletion, beforeResponse: concurrentCookie }, success("100"),
  ]);
  const result = await downloader.listVersions(state.account, app);
  assert.deepEqual(state.requests.map(value => value.id), ["", "200", "100"]);
  assert.match(state.requests[1].cookie, /obsolete=original/);
  assert.doesNotMatch(state.requests[2].cookie, /obsolete=/);
  assertDeletionUpdate(result.updatedCookies);
  assertPersistedDeletion(state);
});

test("history metadata failure preserves deletion on the outward error and in storage", async t => {
  const state = fixture(t, [
    success(), { ...failed(), cookie: deletion, beforeResponse: concurrentCookie }, failed(),
  ]);
  await assert.rejects(downloader.listVersions(state.account, app), error => {
    assert.equal(error.code, "5002");
    assertDeletionUpdate(error.updatedCookies);
    return true;
  });
  assert.deepEqual(state.requests.map(value => value.id), ["", "200", "200"]);
  assert.equal(state.requests[2].url, fallbackURL);
  assert.doesNotMatch(state.requests[2].cookie, /obsolete=/);
  assertPersistedDeletion(state);
});

test("history initial failure preserves deletion when merging the error with the original account", async t => {
  const state = fixture(t, [
    { ...failed(), cookie: deletion, beforeResponse: concurrentCookie }, failed(),
  ]);
  await assert.rejects(download.listVersions(state.account, app), error => {
    assert.equal(error.code, "5002");
    assertDeletionUpdate(error.updatedCookies);
    downloader.persistAccount(state.account, error.updatedCookies);
    return true;
  });
  assert.equal(state.requests.length, 2);
  assertPersistedDeletion(state);
});

test("history protocol cancellation after metadata retains deletion for persistence and stops further versions", async t => {
  let activeRequest = true;
  const state = fixture(t, [success(), {
    ...success("200"), cookie: deletion, beforeResponse: value => {
      concurrentCookie(value); activeRequest = false;
    },
  }]);
  await assert.rejects(download.listVersions(state.account, app, undefined, { shouldContinue: () => activeRequest }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assertDeletionUpdate(error.updatedCookies);
    downloader.persistAccount(state.account, error.updatedCookies);
    return true;
  });
  assert.deepEqual(state.requests.map(value => value.id), ["", "200"]);
  assertPersistedDeletion(state);
});

test("history service cancellation persists deletion before returning the filtered account snapshot", async t => {
  let activeRequest = true;
  const state = fixture(t, [success(), {
    ...success("200"), cookie: deletion, beforeResponse: value => {
      concurrentCookie(value); activeRequest = false;
    },
  }]);
  await assert.rejects(downloader.listVersions(state.account, app, { shouldContinue: () => activeRequest }), error => {
    assert.equal(error.code, "version_list_cancelled");
    assert.equal(find(active(error.updatedCookies)), undefined);
    return true;
  });
  assert.deepEqual(state.requests.map(value => value.id), ["", "200"]);
  assertPersistedDeletion(state);
});

test("a later history response can recreate a deleted Cookie for subsequent requests and storage", async t => {
  const state = fixture(t, [
    success("", ["100", "200", "250", "300"]),
    { ...success("250"), cookie: deletion, beforeResponse: concurrentCookie },
    { ...success("200"), cookie: renewal }, success("100"),
  ]);
  const result = await downloader.listVersions(state.account, app);
  assert.deepEqual(state.requests.map(value => value.id), ["", "250", "200", "100"]);
  assert.doesNotMatch(state.requests[2].cookie, /obsolete=/);
  assert.match(state.requests[3].cookie, /obsolete=renewed/);
  assert.equal(find(result.updatedCookies).value, "renewed");
  assert.equal(find(result.updatedCookies).expiresAt, undefined);
  const stored = state.stored.get(state.account.email);
  assert.equal(find(stored.cookies).value, "renewed");
  assert.equal(find(stored.cookies, "concurrent").value, "new");
});

for (const outcome of ["download success", "history success", "initial failure", "pre-request cancellation"]) {
  test(`an expired account snapshot never deletes a concurrently refreshed Cookie on ${outcome}`, async t => {
    const replies = outcome === "history success"
      ? [success(), success("200"), success("100")]
      : outcome === "initial failure"
      ? [failed(), failed()]
      : outcome === "pre-request cancellation" ? [] : [success()];
    const state = fixture(t, replies, [cookie("obsolete", "old-snapshot", { expiresAt: 1 })]);
    refreshedStoredCookie(state);
    let updatedCookies;
    if (outcome === "initial failure" || outcome === "pre-request cancellation") {
      const options = outcome === "pre-request cancellation" ? { shouldContinue: () => false } : undefined;
      await assert.rejects(download.listVersions(state.account, app, undefined, options), error => {
        assert.equal(error.code, outcome === "initial failure" ? "5002" : "version_list_cancelled");
        updatedCookies = error.updatedCookies;
        return true;
      });
    } else {
      const result = outcome === "history success"
        ? await download.listVersions(state.account, app)
        : await download.getDownloadInfo(state.account, app);
      updatedCookies = result.updatedCookies;
    }
    assert.equal(find(updatedCookies), undefined, "an expired baseline is not a response deletion update");
    for (const request of state.requests) assert.doesNotMatch(request.cookie, /obsolete=/);
    downloader.persistAccount(state.account, updatedCookies);
    const stored = state.stored.get(state.account.email);
    assert.equal(find(stored.cookies).value, "refreshed");
    assert.equal(find(stored.cookies, "concurrent").value, "new");
  });
}

test("an actual response deletion still applies when the input account snapshot was already expired", async t => {
  const state = fixture(t, [{ ...success(), cookie: deletion }], [cookie("obsolete", "old-snapshot", { expiresAt: 1 })]);
  refreshedStoredCookie(state);
  const result = await download.getDownloadInfo(state.account, app);
  assertDeletionUpdate(result.updatedCookies);
  downloader.persistAccount(state.account, result.updatedCookies);
  assertPersistedDeletion(state);
});

for (const phase of ["download", "initial history", "later history"]) {
  test(`a baseline Cookie expiring during ${phase} cannot delete a newer stored value`, async t => {
    let now = 2000000000000;
    t.mock.method(Date, "now", () => now);
    const expireBaseline = state => {
      now += 2000;
      refreshedStoredCookie(state);
    };
    const replies = phase === "download" ? [{ ...success(), beforeResponse: expireBaseline }]
      : phase === "initial history" ? [{ ...success(), beforeResponse: expireBaseline }, success("200"), success("100")]
      : [success(), { ...success("200"), beforeResponse: expireBaseline }, success("100")];
    const state = fixture(t, replies, [cookie("obsolete", "old-snapshot", { expiresAt: now / 1000 + 1 })]);
    const result = phase === "download"
      ? await download.getDownloadInfo(state.account, app)
      : await download.listVersions(state.account, app);
    assert.equal(find(result.updatedCookies), undefined, "natural expiry is not a response deletion update");
    downloader.persistAccount(state.account, result.updatedCookies);
    assert.equal(find(state.stored.get(state.account.email).cookies).value, "refreshed");
  });
}
