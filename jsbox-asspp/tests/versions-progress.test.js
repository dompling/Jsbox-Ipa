const { test } = require("node:test");
const assert = require("node:assert/strict");

const download = require("../scripts/apple/download");
const downloader = require("../scripts/services/downloader");
const http = require("../scripts/lib/http");
const plist = require("../scripts/lib/plist");
const { isSessionExpiredError } = require("../scripts/lib/error");
const accounts = require("../scripts/store/accounts");
const auth = require("../scripts/apple/auth");
const settings = require("../scripts/store/settings");
const purchase = require("../scripts/apple/purchase");
const store = require("../scripts/apple/store");

const app = { id: "42", bundleID: "com.example.demo", name: "Demo", price: 0 };
function cookie(value, name = "session") {
  return { name, value, domain: "itunes.apple.com", path: "/" };
}
function account() {
  return {
    email: "synthetic@example.invalid", store: "US", autoRelogin: true,
    deviceIdentifier: "001122334455", directoryServicesIdentifier: "123",
    passwordToken: "synthetic-token", cookies: [cookie("original")],
  };
}
function info(identifiers = ["100", "200", "300"], latest = "300") {
  return {
    versionIdentifiers: identifiers, latestVersionIdentifier: latest,
    externalVersionId: latest, bundleShortVersionString: "3.0", bundleVersion: "30",
    updatedCookies: [cookie("initial")],
  };
}
function version(id, displayVersion = "", extra) {
  return {
    id, requestedExternalVersionId: id, externalVersionId: id,
    displayVersion, buildVersion: "", ...extra,
  };
}
function reply(options, dict, value = "") {
  return {
    status: 200, finalUrl: options.url,
    headers: value ? { "set-cookie": `session=${value}; Domain=.itunes.apple.com; Path=/; Secure` } : {},
    body: plist.buildPlist(dict),
  };
}
function metadataReply(options, id, displayVersion = "", value = "") {
  return reply(options, { songList: [{ metadata: {
    softwareVersionExternalIdentifier: id, bundleShortVersionString: displayVersion,
  } }] }, value);
}
function requestedId(options) {
  const payload = plist.parsePlist(options.body);
  return String(payload.appExtVrsId || payload.externalVersionId || "");
}
function sessionCookie(cookies) {
  return (cookies || []).find(value => value.name === "session").value;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serviceFixture(t) {
  const acc = account();
  const stored = new Map([[acc.email, { ...acc, cookies: acc.cookies.slice() }]]);
  t.mock.method(accounts, "getAccount", email => stored.get(accounts.normalizeEmail(email)) || null);
  t.mock.method(accounts, "saveAccount", value => { stored.set(value.email, value); return value; });
  t.mock.method(accounts, "getAutoLoginPassword", () => "synthetic-password");
  t.mock.method(settings, "effectiveAuthURLOverride", () => "");
  const authenticate = t.mock.method(auth, "authenticate", async () => ({
    ...acc, cookies: [cookie("authenticated")], passwordToken: "synthetic-refreshed",
  }));
  const buy = t.mock.method(purchase, "purchaseApp", async () => ({ updatedCookies: [cookie("licensed")] }));
  const lookup = t.mock.method(store, "lookupByIds", async () => [app]);
  t.mock.method(http, "send", async () => { throw new Error("unexpected real HTTP"); });
  return { acc, stored, authenticate, buy, lookup };
}
function assertCancelled(err) {
  assert.equal(err.code, "version_list_cancelled");
  assert.equal(isSessionExpiredError(err), false);
  assert.equal(err.needsAppStore, false);
  return true;
}

test("progress publishes every deduplicated ID before metadata, stays stable, and rolls cookies serially", async t => {
  const snapshots = [], events = [], requests = [];
  let active = 0, maximum = 0;
  t.mock.method(http, "sendWithRedirectRecovery", async options => {
    const id = requestedId(options);
    events.push(`request:${id}`);
    requests.push([id, sessionCookie(options.cookies)]);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (!id) return reply(options, { songList: [{
      URL: "https://cdn.example/demo.ipa", sinfs: [{ id: 1, sinf: "AQI=" }],
      metadata: {
        softwareVersionExternalIdentifier: "300",
        softwareVersionExternalIdentifiers: ["100", "200", "100"],
        bundleShortVersionString: "3.0",
      },
    }] }, "initial");
    return metadataReply(options, id, id === "100" ? "1.0" : "9.0", `after-${id}`);
  });
  const result = await download.listVersions(account(), app, undefined, {
    onVersions: snapshot => { snapshots.push(snapshot); events.push(`snapshot:${snapshot.resolvedCount}`); },
  });
  assert.deepEqual(events.slice(0, 3), ["request:", "snapshot:1", "request:100"]);
  assert.equal(maximum, 1);
  assert.deepEqual(requests, [["", "original"], ["100", "initial"], ["200", "after-100"]]);
  assert.deepEqual(snapshots.map(value => value.versions.map(item => item.id)), [
    ["300", "100", "200"], ["300", "100", "200"], ["300", "100", "200"],
  ]);
  assert.deepEqual(snapshots.map(value => value.resolvedIds), [["300"], ["300", "100"], ["300", "100", "200"]]);
  assert.deepEqual(snapshots.map(value => [value.resolvedCount, value.totalCount, value.complete]), [
    [1, 3, false], [2, 3, false], [3, 3, true],
  ]);
  assert.deepEqual(snapshots[0].versions[1], version("100", "", { externalVersionId: "" }));
  assert.equal(snapshots[0].versions[1].displayVersion, "");
  assert.deepEqual(result.identifiers, ["100", "200", "100"]);
  assert.deepEqual(result.versions.map(item => item.id), ["300", "200", "100"]);
  assert.equal(sessionCookie(result.updatedCookies), "after-200");
});

test("snapshots are immutable display-only copies and observer exceptions cannot fail enumeration", async t => {
  const snapshots = [];
  t.mock.method(http, "sendWithRedirectRecovery", async options => metadataReply(options, requestedId(options), "2.0", "private-cookie"));
  const result = await download.listVersions(account(), app, info(["200", "300"]), {
    onVersions: snapshot => {
      snapshots.push(snapshot);
      if (snapshots.length === 1) snapshot.versions.push({ id: "injected" });
      return Promise.reject(new Error("synthetic asynchronous observer failure"));
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.versions), true);
    assert.equal(Object.isFrozen(snapshot.resolvedIds), true);
    assert.equal(Object.isFrozen(snapshot.versions[0]), true);
    assert.doesNotMatch(JSON.stringify(snapshot), /cookie|synthetic-token|passwordToken/i);
    for (const item of snapshot.versions) {
      assert.deepEqual(Object.keys(item).sort(), ["buildVersion", "displayVersion", "externalVersionId", "id", "requestedExternalVersionId"]);
    }
  }
  assert.notEqual(snapshots[0].versions[0], snapshots[1].versions[0]);
  assert.notEqual(snapshots[1].versions[1], result.versions[1]);
  result.versions[1].displayVersion = "changed by final caller";
  assert.equal(snapshots[1].versions[1].displayVersion, "2.0");
  assert.equal(snapshots[0].versions[1].displayVersion, "");
});

test("empty lists complete immediately and metadata without a version label is still resolved", async t => {
  const send = t.mock.method(http, "sendWithRedirectRecovery", async options => metadataReply(options, "", ""));
  const empty = [];
  await download.listVersions(account(), app, info([], ""), { onVersions: value => empty.push(value) });
  assert.equal(empty.length, 1);
  assert.deepEqual(empty[0], { versions: [], latest: "", resolvedIds: [], resolvedCount: 0, totalCount: 0, complete: true });
  assert.equal(send.mock.callCount(), 0);
  const snapshots = [];
  const result = await download.listVersions(account(), app, {
    ...info(["100"], "100"), bundleShortVersionString: "", bundleVersion: "",
  }, { onVersions: value => snapshots.push(value) });
  assert.deepEqual(snapshots.map(value => value.resolvedCount), [0, 1]);
  assert.equal(snapshots[1].complete, true);
  assert.equal(result.versions[0].externalVersionId, "");
  assert.equal(result.versions[0].displayVersion, "");
});

test("known resolved versions reuse only current matching identities and never restore cookie fields", async t => {
  const requested = [], snapshots = [];
  t.mock.method(http, "sendWithRedirectRecovery", async options => {
    requested.push(requestedId(options));
    assert.equal(sessionCookie(options.cookies), "initial");
    return metadataReply(options, requestedId(options), "4.0");
  });
  const result = await download.listVersions(account(), app, info(["100", "200", "300", "400", "500"], "500"), {
    knownVersions: [
      version("100", "1.0", { updatedCookies: [cookie("stale")], passwordToken: "private" }),
      version("200", "", { externalVersionId: "" }),
      version("300", "wrong", { requestedExternalVersionId: "999" }),
      version("400", "wrong", { externalVersionId: "999" }),
      version("500", "stale latest"), version("999", "no longer listed"), null,
    ],
    onVersions: value => snapshots.push(value),
  });
  assert.deepEqual(requested, ["400", "300"]);
  assert.deepEqual(snapshots[0].resolvedIds, ["500", "200", "100"]);
  assert.equal(snapshots[0].versions[0].displayVersion, "3.0");
  assert.equal(snapshots[0].versions.find(value => value.id === "100").displayVersion, "1.0");
  assert.equal(result.versions.find(value => value.id === "200").externalVersionId, "");
  assert.equal(result.versions.some(value => value.id === "999"), false);
  assert.equal(sessionCookie(result.updatedCookies), "initial");
  assert.doesNotMatch(JSON.stringify(snapshots), /cookie|passwordToken|private|stale/);
});

for (const failure of ["2034", "2042", "9610", "network"]) {
  test(`metadata ${failure} preserves the last full-ID snapshot and newest cookies`, async t => {
    const snapshots = [];
    t.mock.method(http, "sendWithRedirectRecovery", async options => {
      if (requestedId(options) === "200") return metadataReply(options, "200", "2.0", "resolved");
      if (failure === "network") return { ...reply(options, {}, "failed"), failed: true, error: new Error("synthetic network failure") };
      return reply(options, { failureType: failure }, "failed");
    });
    await assert.rejects(download.listVersions(account(), app, info(), {
      onVersions: value => snapshots.push(value),
    }), err => {
      if (failure !== "network") assert.equal(err.code, failure);
      assert.equal(sessionCookie(err.updatedCookies), "failed");
      return true;
    });
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots[1].versions.map(value => value.id), ["300", "200", "100"]);
    assert.deepEqual(snapshots[1].resolvedIds, ["300", "200"]);
    assert.equal(snapshots[1].complete, false);
  });
}

test("a retry resumes only resolved metadata while retaining default final sorting and return fields", async t => {
  const requested = [], snapshots = [];
  let fail = true;
  t.mock.method(http, "sendWithRedirectRecovery", async options => {
    const id = requestedId(options);
    requested.push(id);
    if (fail && id === "100") throw new Error("synthetic retryable failure");
    return metadataReply(options, id, id === "100" ? "9.0" : "2.0");
  });
  await assert.rejects(download.listVersions(account(), app, info(), { onVersions: value => snapshots.push(value) }));
  fail = false;
  const partial = snapshots[snapshots.length - 1];
  const resumed = await download.listVersions(account(), app, info(), {
    knownVersions: partial.versions.filter(value => partial.resolvedIds.includes(value.id)),
  });
  assert.deepEqual(requested, ["200", "100", "100", "100"], "a failed ID tries both endpoints before a later manual resume");
  assert.deepEqual(resumed.versions.map(value => value.id), ["300", "100", "200"]);
  const normal = await download.listVersions(account(), app, info());
  assert.deepEqual(Object.keys(resumed).sort(), ["identifiers", "latest", "updatedCookies", "versions"]);
  assert.deepEqual(resumed.versions.map(({ updatedCookies, ...value }) => value), normal.versions.map(({ updatedCookies, ...value }) => value));
  assert.deepEqual(resumed.updatedCookies, normal.updatedCookies);
});

test("cancelling in the initial observer stops before the next metadata request", async t => {
  let active = true;
  const send = t.mock.method(http, "sendWithRedirectRecovery", async () => { throw new Error("unexpected metadata request"); });
  await assert.rejects(download.listVersions(account(), app, info(), {
    shouldContinue: () => active,
    onVersions: () => { active = false; },
  }), assertCancelled);
  assert.equal(send.mock.callCount(), 0);
});

test("an already cancelled low-level call retains cookies from supplied initial info", async t => {
  const send = t.mock.method(http, "sendWithRedirectRecovery", async () => { throw new Error("unexpected metadata request"); });
  await assert.rejects(download.listVersions(account(), app, info(), { shouldContinue: () => false }), err => {
    assertCancelled(err);
    assert.equal(sessionCookie(err.updatedCookies), "initial");
    return true;
  });
  assert.equal(send.mock.callCount(), 0);
});

test("service forwards options and refuses an already cancelled operation before HTTP", async t => {
  const h = serviceFixture(t);
  const infoCall = t.mock.method(download, "getDownloadInfo", async () => info());
  const listed = t.mock.method(download, "listVersions", async (_acc, _app, initial, options) => {
    assert.equal(initial.latestVersionIdentifier, "300");
    assert.equal(options, opts);
    return { identifiers: [], latest: "", versions: [], updatedCookies: [cookie("listed")] };
  });
  const opts = { onVersions() {}, shouldContinue: () => true, knownVersions: [] };
  await downloader.listVersions(h.acc, app, opts);
  assert.equal(listed.mock.callCount(), 1);
  assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "listed");
  await assert.rejects(downloader.listVersions(h.acc, app, { shouldContinue: () => false }), assertCancelled);
  assert.equal(infoCall.mock.callCount(), 1);
  assert.equal(h.authenticate.mock.callCount(), 0);
  assert.equal(h.buy.mock.callCount(), 0);
});

test("cancellation after initial success persists cookies and skips metadata", async t => {
  const h = serviceFixture(t);
  let active = true;
  t.mock.method(download, "getDownloadInfo", async () => { active = false; return info(); });
  const listed = t.mock.method(download, "listVersions", async () => { throw new Error("unexpected metadata enumeration"); });
  await assert.rejects(downloader.listVersions(h.acc, app, { shouldContinue: () => active }), assertCancelled);
  assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "initial");
  assert.equal(listed.mock.callCount(), 0);
  assert.equal(h.authenticate.mock.callCount(), 0);
  assert.equal(h.buy.mock.callCount(), 0);
});

for (const outcome of ["success", "2034", "2042"]) {
  test(`service checks cancellation after metadata ${outcome} before exposing it to session refresh`, async t => {
    const h = serviceFixture(t);
    let active = true;
    t.mock.method(download, "getDownloadInfo", async () => info());
    t.mock.method(download, "listVersions", async () => {
      active = false;
      if (outcome !== "success") throw new download.DownloadError("登录已过期", outcome, [cookie("service-metadata")]);
      return { versions: [], updatedCookies: [cookie("service-metadata")] };
    });
    await assert.rejects(downloader.listVersions(h.acc, app, { shouldContinue: () => active }), assertCancelled);
    assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "service-metadata");
    assert.equal(h.authenticate.mock.callCount(), 0);
    assert.equal(h.buy.mock.callCount(), 0);
  });
}

for (const failure of ["2034", "2042", "9610"]) {
  test(`cancelled initial ${failure} is persisted before session refresh or licensing can run`, async t => {
    const h = serviceFixture(t);
    let active = true;
    t.mock.method(download, "getDownloadInfo", async () => {
      active = false;
      throw new download.DownloadError("登录已过期 2034; synthetic cancelled response", failure, [cookie("cancelled-initial")]);
    });
    await assert.rejects(downloader.listVersions(h.acc, app, { shouldContinue: () => active }), assertCancelled);
    assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "cancelled-initial");
    assert.equal(h.authenticate.mock.callCount(), 0);
    assert.equal(h.lookup.mock.callCount(), 0);
    assert.equal(h.buy.mock.callCount(), 0);
  });
}

for (const failure of ["success", "2034", "2042", "9610", "5002", "network"]) {
  test(`in-flight metadata ${failure} settles and persists cookies before cancellation rejects`, async t => {
    const h = serviceFixture(t);
    let active = true, settled = false;
    const started = deferred(), response = deferred(), snapshots = [];
    t.mock.method(download, "getDownloadInfo", async () => info());
    const send = t.mock.method(http, "sendWithRedirectRecovery", async options => {
      started.resolve(options);
      return response.promise;
    });
    const pending = downloader.listVersions(h.acc, app, {
      shouldContinue: () => active,
      onVersions: value => snapshots.push(value),
    });
    pending.then(() => { settled = true; }, () => { settled = true; });
    const options = await started.promise;
    active = false;
    await Promise.resolve();
    assert.equal(settled, false);
    if (failure === "success") response.resolve(metadataReply(options, requestedId(options), "2.0", "cancelled-metadata"));
    else if (failure === "network") {
      response.reject(new download.DownloadError("synthetic network failure", "network", [cookie("cancelled-metadata")]));
    } else response.resolve(reply(options, { failureType: failure }, "cancelled-metadata"));
    await assert.rejects(pending, assertCancelled);
    assert.equal(send.mock.callCount(), 1);
    assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "cancelled-metadata");
    assert.equal(h.authenticate.mock.callCount(), 0);
    assert.equal(h.buy.mock.callCount(), 0);
    assert.equal(snapshots.length, 1);
  });
}

test("cancellation during free-price lookup blocks license acquisition", async t => {
  const h = serviceFixture(t);
  let active = true;
  t.mock.method(download, "getDownloadInfo", async () => { throw new download.DownloadError("license required", "9610", [cookie("license-error")]); });
  h.lookup.mock.mockImplementation(async () => { active = false; return [app]; });
  await assert.rejects(downloader.listVersions(h.acc, { ...app, price: undefined }, { shouldContinue: () => active }), assertCancelled);
  assert.equal(h.lookup.mock.callCount(), 1);
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "license-error");
});

test("cancellation during license acquisition saves its cookies without retrying download info", async t => {
  const h = serviceFixture(t);
  let active = true;
  const infoCall = t.mock.method(download, "getDownloadInfo", async () => { throw new download.DownloadError("license required", "9610"); });
  h.buy.mock.mockImplementation(async () => { active = false; return { updatedCookies: [cookie("cancelled-license")] }; });
  await assert.rejects(downloader.listVersions(h.acc, app, { shouldContinue: () => active }), assertCancelled);
  assert.equal(infoCall.mock.callCount(), 1);
  assert.equal(h.buy.mock.callCount(), 1);
  assert.equal(h.authenticate.mock.callCount(), 0);
  assert.equal(sessionCookie(h.stored.get(h.acc.email).cookies), "cancelled-license");
});
