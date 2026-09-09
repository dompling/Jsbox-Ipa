const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deferred, flush } = require("./helpers/ui");

const downloader = require("../scripts/services/downloader");
const queue = require("../scripts/services/queue");
const download = require("../scripts/apple/download");
const purchase = require("../scripts/apple/purchase");
const store = require("../scripts/apple/store");
const accounts = require("../scripts/store/accounts");
const session = require("../scripts/apple/session");
const stream = require("../scripts/services/stream-download");
const validator = require("../scripts/services/ipa-validator");
const injector = require("../scripts/services/ipa-injector");
const library = require("../scripts/store/library");
const http = require("../scripts/lib/http");

function fixture(t, options) {
  const account = { email: "original@example.invalid", store: "US", cookies: [] };
  const app = { id: "42", bundleID: "com.example.demo", name: "Demo", version: "9.0", price: 0 };
  const info = {
    downloadURL: "https://cdn.example/demo.ipa", externalVersionId: "111",
    bundleShortVersionString: "9.0", bundleVersion: "900", sinfs: [], updatedCookies: [],
  };
  const stored = new Map([[account.email, account]]);
  t.mock.method(accounts, "getAccount", (email) => stored.get(email) || null);
  t.mock.method(accounts, "saveAccount", (value) => { stored.set(value.email, value); return value; });
  if (!options || !options.realSession) {
    t.mock.method(session, "withFreshSession", async (acc, run) => run(acc));
  }
  const infoCall = t.mock.method(download, "getDownloadInfo", async () => info);
  const buy = t.mock.method(purchase, "purchaseApp", async () => ({ updatedCookies: [] }));
  const lookup = t.mock.method(store, "lookupByIds", async () => []);
  const chunks = t.mock.method(stream, "tryChunkedDownload", async (_info, progress) => {
    progress(100, 100);
    return { ok: true, path: "cache/synthetic.ipa", size: 100 };
  });
  const validate = t.mock.method(validator, "validateDownloadedFile", async () => ({
    verified: true, metadataReadable: true, metadataVerified: true,
    appPath: "Payload/Demo.app", bundleId: app.bundleID, shortVersion: "1.0", bundleVersion: "100",
  }));
  t.mock.method(injector, "canRezip", () => false);
  const save = t.mock.method(library, "saveDownloadedFile", (_path, meta) => ({ ...meta, fileName: "Demo.ipa" }));
  const network = t.mock.method(http, "send", async () => { throw new Error("unexpected whole-file HTTP"); });
  t.after(() => { for (const task of queue.snapshot()) queue.remove(task.id); });
  return { account, app, info, stored, infoCall, buy, lookup, chunks, validate, save, network };
}

function refreshFixture(t, region) {
  const h = fixture(t, { realSession: true });
  h.account.autoRelogin = true;
  h.account.deviceIdentifier = "001122334455";
  t.mock.method(accounts, "getAutoLoginPassword", () => "synthetic-password");
  const settings = require("../scripts/store/settings");
  t.mock.method(settings, "effectiveAuthURLOverride", () => "");
  const auth = require("../scripts/apple/auth");
  const authenticate = t.mock.method(auth, "authenticate", async input => ({
    ...h.account, email: input.email, store: region, passwordToken: "synthetic-refreshed-token",
  }));
  return { ...h, authenticate };
}

const cancelledDownload = error => error && error.code === "download_cancelled";

function trackStaging(t) {
  const previous = global.$file;
  const deleted = [];
  global.$file = { exists: () => true, delete: path => { deleted.push(path); return true; } };
  t.after(() => { global.$file = previous; });
  return deleted;
}

test("saved IPA records keep the request account when the selected account changes mid-download", async t => {
  const h = fixture(t);
  let selectedAccount = h.account;
  t.mock.method(accounts, "accountForRegion", () => selectedAccount);
  const transfer = deferred();
  t.after(() => transfer.resolve({ ok: true, path: "cache/synthetic.ipa", size: 100 }));
  h.chunks.mock.mockImplementation(() => transfer.promise);
  const pending = downloader.downloadLatest(h.account, h.app);
  await flush();
  assert.equal(h.infoCall.mock.callCount(), 1);
  selectedAccount = { email: "selected-later@example.invalid", store: "US", cookies: [] };
  transfer.resolve({ ok: true, path: "cache/synthetic.ipa", size: 100 });
  const result = await pending;
  assert.equal(result.record.accountEmail, "original@example.invalid");
  assert.equal(h.save.mock.calls[0].arguments[1].accountEmail, "original@example.invalid");
  assert.equal(queue.snapshot().length, 0);
});

test("different accounts persist separate ownership for the same App and historical version", async t => {
  const h = fixture(t);
  const other = { email: "second@example.invalid", store: "US", cookies: [] };
  h.stored.set(other.email, other);
  const first = await downloader.downloadVersion(h.account, h.app, "111");
  const second = await downloader.downloadVersion(other, h.app, "111");
  assert.equal(first.record.accountEmail, h.account.email);
  assert.equal(second.record.accountEmail, other.email);
  assert.equal(h.save.mock.callCount(), 2);
});

test("cancelling a published task before its microtask starts performs no Apple request", async t => {
  const h = fixture(t);
  let control;
  const pending = downloader.downloadLatest(h.account, h.app, {
    onTask: value => { control = value; assert.equal(value.cancel(), true); },
  });
  await assert.rejects(pending, cancelledDownload);
  assert.ok(control.id);
  assert.equal(control.canCancel(), false);
  assert.equal(h.infoCall.mock.callCount(), 0);
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
  assert.deepEqual(queue.snapshot(), []);
});

test("shared callers cancel the same task and a replacement waits until its cookie handoff settles", async t => {
  const h = fixture(t);
  const response = deferred();
  t.after(() => response.resolve(h.info));
  h.infoCall.mock.mockImplementation(() => response.promise);
  const controls = [];
  const progress = [];
  const first = downloader.downloadLatest(h.account, h.app, { onTask: value => controls.push(value), onProgress: value => progress.push(value) });
  const second = downloader.downloadLatest(h.account, h.app, { onTask: value => controls.push(value) });
  assert.equal(first, second);
  assert.equal(controls.length, 2);
  assert.equal(controls[0].id, controls[1].id);
  await flush();
  assert.equal(controls[1].cancel(), true);
  assert.equal(controls[0].cancel(), false);
  assert.equal(queue.snapshot()[0].status, "cancelling");
  assert.equal(downloader.downloadLatest(h.account, h.app), first, "cancelling must not start overlapping requests");
  const settled = assert.rejects(first, cancelledDownload);
  response.resolve({ ...h.info, updatedCookies: [{ name: "session", value: "settled", domain: "itunes.apple.com", path: "/" }] });
  await settled;
  assert.equal(h.stored.get(h.account.email).cookies[0].value, "settled");
  assert.equal(h.chunks.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
  assert.deepEqual(progress, []);
  assert.deepEqual(queue.snapshot(), []);
  assert.equal(downloader.downloadControl(controls[0].id), null);
});

for (const code of ["2034", "2042", "9610"]) {
  test(`cancelled download-info ${code} persists cookies without refreshing or acquiring a license`, async t => {
    const h = refreshFixture(t, "US");
    const response = deferred();
    t.after(() => response.resolve(h.info));
    h.infoCall.mock.mockImplementation(() => response.promise);
    let control;
    const pending = downloader.downloadLatest(h.account, h.app, { onTask: value => { control = value; } });
    await flush();
    assert.equal(control.cancel(), true);
    const settled = assert.rejects(pending, cancelledDownload);
    response.reject(new download.DownloadError("synthetic old session response", code, [
      { name: "session", value: "response-cookie", domain: "itunes.apple.com", path: "/" },
    ]));
    await settled;
    assert.equal(h.stored.get(h.account.email).cookies[0].value, "response-cookie");
    assert.equal(h.authenticate.mock.callCount(), 0);
    assert.equal(h.buy.mock.callCount(), 0);
    assert.equal(h.infoCall.mock.callCount(), 1);
    assert.equal(h.save.mock.callCount(), 0);
    assert.deepEqual(queue.snapshot(), []);
  });
}

test("cancelling during a price lookup prevents license acquisition", async t => {
  const h = fixture(t);
  const lookup = deferred();
  t.after(() => lookup.resolve([{ ...h.app, price: 0 }]));
  h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("no license", "9610"); });
  h.lookup.mock.mockImplementation(() => lookup.promise);
  let control;
  const pending = downloader.downloadLatest(h.account, { ...h.app, price: null }, { onTask: value => { control = value; } });
  await flush();
  assert.equal(h.lookup.mock.callCount(), 1);
  assert.equal(control.cancel(), true);
  const settled = assert.rejects(pending, cancelledDownload);
  lookup.resolve([{ ...h.app, price: 0 }]);
  await settled;
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
});

test("cancellation waits for an already running session refresh but never restarts the download", async t => {
  const h = refreshFixture(t, "US");
  const refresh = deferred();
  t.after(() => refresh.resolve({ ...h.account }));
  h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("expired", "2034"); });
  h.authenticate.mock.mockImplementation(() => refresh.promise);
  let control;
  const pending = downloader.downloadLatest(h.account, h.app, { onTask: value => { control = value; } });
  await flush();
  assert.equal(h.authenticate.mock.callCount(), 1);
  assert.equal(control.cancel(), true);
  const settled = assert.rejects(pending, cancelledDownload);
  refresh.resolve({ ...h.account, passwordToken: "synthetic-refreshed" });
  await settled;
  assert.equal(h.infoCall.mock.callCount(), 1);
  assert.equal(h.chunks.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
});

test("cancelled transfers discard late progress and clean a staged path before any validation", async t => {
  const h = fixture(t);
  const deleted = trackStaging(t);
  const transfer = deferred();
  t.after(() => transfer.resolve({ ok: true, path: "cache/cancelled.ipa", size: 100 }));
  let callback;
  h.chunks.mock.mockImplementation((_info, progress) => { callback = progress; return transfer.promise; });
  let control;
  const progress = [];
  const pending = downloader.downloadLatest(h.account, h.app, { onTask: value => { control = value; }, onProgress: value => progress.push(value) });
  await flush();
  callback(20, 100);
  assert.equal(control.cancel(), true);
  callback(90, 100);
  assert.deepEqual(progress, [20]);
  assert.equal(queue.snapshot()[0].status, "cancelling");
  const settled = assert.rejects(pending, cancelledDownload);
  transfer.resolve({ ok: true, path: "cache/cancelled.ipa", size: 100 });
  await settled;
  assert.ok(deleted.includes("cache/cancelled.ipa"));
  assert.equal(h.validate.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
  assert.equal(h.network.mock.callCount(), 0);
});

test("the shared task reports real byte progress separately from preparation and package processing", async t => {
  const h = fixture(t);
  const transfer = deferred();
  const validation = deferred();
  t.after(() => {
    transfer.resolve({ ok: true, path: "cache/synthetic.ipa", size: 100 });
    validation.resolve({ verified: true });
  });
  let progress;
  h.chunks.mock.mockImplementation((_info, callback) => { progress = callback; return transfer.promise; });
  h.validate.mock.mockImplementation(() => validation.promise);
  const pending = downloader.downloadLatest(h.account, h.app);
  assert.equal(queue.snapshot()[0].downloadProgress, null);
  await flush();
  progress(25, 100);
  assert.equal(queue.snapshot()[0].downloadProgress, 0.25);
  assert.notEqual(queue.snapshot()[0].progress, 0.25, "overall processing is not the byte fraction shown by App buttons");
  progress(50, 0);
  assert.equal(queue.snapshot()[0].downloadProgress, null, "unknown length must show an indeterminate spinner");
  progress(100, 100);
  transfer.resolve({ ok: true, path: "cache/synthetic.ipa", size: 100 });
  await flush();
  assert.equal(queue.snapshot()[0].status, "verifying");
  assert.equal(queue.snapshot()[0].downloadProgress, 1);
  validation.resolve({ verified: true });
  await pending;
  assert.equal(queue.snapshot().length, 0);
});

test("cancelling during validation waits for its cleanup and never commits the staged file", async t => {
  const h = fixture(t);
  const deleted = trackStaging(t);
  const validation = deferred();
  t.after(() => validation.resolve({ verified: true }));
  h.validate.mock.mockImplementation(() => validation.promise);
  let control;
  const pending = downloader.downloadLatest(h.account, h.app, { onTask: value => { control = value; } });
  await flush();
  assert.equal(control.cancel(), true);
  assert.deepEqual(deleted, [], "do not remove a file while the validator is still reading it");
  const settled = assert.rejects(pending, cancelledDownload);
  validation.resolve({ verified: true });
  await settled;
  assert.ok(deleted.includes("cache/synthetic.ipa"));
  assert.equal(h.save.mock.callCount(), 0);
  assert.deepEqual(queue.snapshot(), []);
});

test("a late whole-file response after cancellation never reaches staging", async t => {
  const h = fixture(t);
  const transfer = deferred();
  t.after(() => transfer.resolve({}));
  h.chunks.mock.mockImplementation(async () => ({ ok: false, reason: "too-small" }));
  h.network.mock.mockImplementation(() => transfer.promise);
  const stage = t.mock.method(validator, "stageDownloadedData", () => { throw new Error("must not stage cancelled data"); });
  let control;
  const pending = downloader.downloadLatest(h.account, h.app, { onTask: value => { control = value; } });
  await flush();
  assert.ok(h.network.mock.calls[0].arguments[0].cancellation);
  control.cancel();
  const settled = assert.rejects(pending, cancelledDownload);
  transfer.resolve({ status: 200, rawData: [1], finalUrl: h.info.downloadURL });
  await settled;
  assert.equal(stage.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
});

test("the first library commit closes cancellation and an old control never cancels a new attempt", async t => {
  const h = fixture(t);
  let firstControl;
  h.save.mock.mockImplementation((_path, meta) => {
    assert.equal(firstControl.canCancel(), false);
    assert.equal(firstControl.cancel(), false);
    assert.equal(queue.snapshot()[0].cancellable, false);
    return { ...meta, fileName: "Demo.ipa" };
  });
  await downloader.downloadLatest(h.account, h.app, { onTask: value => { firstControl = value; } });
  const response = deferred();
  t.after(() => response.resolve(h.info));
  h.infoCall.mock.mockImplementation(() => response.promise);
  let nextControl;
  const next = downloader.downloadLatest(h.account, h.app, { onTask: value => { nextControl = value; } });
  assert.notEqual(nextControl.id, firstControl.id);
  assert.equal(firstControl.cancel(), false);
  assert.equal(nextControl.canCancel(), true);
  nextControl.cancel();
  await assert.rejects(next, cancelledDownload);
});

test("an expired control cannot cancel a retry that reuses its failed task ID", async t => {
  const h = fixture(t);
  h.infoCall.mock.mockImplementation(async () => { throw new Error("synthetic first failure"); });
  let oldControl;
  await assert.rejects(downloader.downloadLatest(h.account, h.app, {
    onTask: value => { oldControl = value; },
  }), /synthetic first failure/);
  const failedTask = queue.snapshot()[0];
  assert.equal(failedTask.status, "error");
  const retry = downloader.retryDownload(failedTask);
  retry.catch(() => {});
  const current = downloader.downloadControl(failedTask.id);
  assert.equal(current.id, oldControl.id, "retry retains the visible task row ID");
  assert.notEqual(current, oldControl);
  assert.equal(oldControl.canCancel(), false);
  assert.equal(oldControl.cancel(), false, "expired controls must check their own attempt, not just the shared task ID");
  assert.equal(current.canCancel(), true);
  assert.equal(current.cancel(), true);
  await assert.rejects(retry, cancelledDownload);
});

test("real session refresh cannot retry a failed historical task in a different region", async (t) => {
  const h = refreshFixture(t, "JP");
  const task = queue.begin({ app: h.app, accountEmail: h.account.email, region: "US", externalVersionId: "111" });
  queue.fail(task.id, new Error("synthetic original failure"));
  const requests = [];
  h.infoCall.mock.mockImplementation(async (account, _app, version) => {
    requests.push({ email: account.email, region: account.store, version });
    if (requests.length === 1) throw new download.DownloadError("登录已过期，请重新登录", "2034");
    return h.info;
  });
  await assert.rejects(downloader.retryDownload(task), /账号.*区域.*变化/);
  assert.equal(h.authenticate.mock.callCount(), 1);
  assert.deepEqual(requests, [{ email: h.account.email, region: "US", version: "111" }]);
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
  const failed = queue.snapshot().find(value => value.id === task.id);
  assert.ok(failed);
  assert.equal(failed.status, "error");
  assert.equal(failed.region, "US");
  assert.equal(failed.externalVersionId, "111");
});

test("real session refresh cannot continue historical enumeration in a different region", async (t) => {
  const h = refreshFixture(t, "JP");
  let calls = 0;
  const listed = t.mock.method(download, "listVersions", async () => {
    if (++calls === 1) throw new download.DownloadError("登录已过期，请重新登录", "2042");
    return { versions: [], updatedCookies: [] };
  });
  await assert.rejects(downloader.listVersions(h.account, h.app), /账号.*区域.*变化/);
  assert.equal(h.authenticate.mock.callCount(), 1);
  assert.equal(h.infoCall.mock.callCount(), 1);
  assert.equal(listed.mock.callCount(), 1);
  assert.equal(h.buy.mock.callCount(), 0);
});

test("real session refresh cannot replace the original email after an account object changes", async (t) => {
  const h = refreshFixture(t, "US");
  const originalEmail = h.account.email;
  const requests = [];
  h.infoCall.mock.mockImplementation(async (account) => {
    requests.push(account.email);
    if (requests.length === 1) {
      // Model an account switch while the first request is in flight. The real
      // session refresher reads the changed object after that request rejects.
      account.email = "other@example.invalid";
      h.stored.set(account.email, account);
      throw new download.DownloadError("登录已过期，请重新登录", "2034");
    }
    return h.info;
  });
  await assert.rejects(downloader.downloadVersion(h.account, h.app, "111"), /账号.*变化/);
  assert.equal(h.authenticate.mock.callCount(), 1);
  assert.equal(h.authenticate.mock.calls[0].arguments[0].email, "other@example.invalid");
  assert.deepEqual(requests, [originalEmail]);
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
  const failed = queue.snapshot()[0];
  assert.equal(failed.accountEmail, originalEmail);
  assert.equal(failed.externalVersionId, "111");
  assert.equal(failed.status, "error");
});

test("real session refresh with the same normalized identity still downloads the original version", async (t) => {
  const h = refreshFixture(t, "US");
  h.account.email = " Original@Example.invalid ";
  const requests = [];
  h.infoCall.mock.mockImplementation(async (account, _app, version) => {
    requests.push({ email: accounts.normalizeEmail(account.email), region: account.store, version });
    if (requests.length === 1) throw new download.DownloadError("登录已过期，请重新登录", "2034");
    return h.info;
  });
  const result = await downloader.downloadVersion(h.account, h.app, "111");
  assert.equal(h.authenticate.mock.callCount(), 1);
  assert.deepEqual(requests, [
    { email: "original@example.invalid", region: "US", version: "111" },
    { email: "original@example.invalid", region: "US", version: "111" },
  ]);
  assert.equal(result.record.requestedExternalVersionId, "111");
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(queue.snapshot().length, 0);
});

test("an existing license downloads free, paid and unknown-price apps without purchase", async (t) => {
  const h = fixture(t);
  for (const price of [0, 12, undefined]) {
    await downloader.downloadLatest(h.account, { ...h.app, price });
  }
  assert.equal(h.buy.mock.callCount(), 0);
  assert.equal(h.lookup.mock.callCount(), 0);
  assert.equal(h.infoCall.mock.callCount(), 3);
});

test("only 9610 acquires one free license and retries the same historical ID with refreshed cookies", async (t) => {
  const h = fixture(t);
  const cookie = { name: "fresh", value: "1", domain: "itunes.apple.com", path: "/" };
  let calls = 0;
  h.infoCall.mock.mockImplementation(async (_account, _app, id) => {
    assert.equal(id, "111");
    if (++calls === 1) throw new download.DownloadError("license required", "9610", [cookie]);
    return h.info;
  });
  h.buy.mock.mockImplementation(async (account) => {
    assert.ok(account.cookies.some(item => item.name === "fresh"));
    return { updatedCookies: [cookie] };
  });
  h.lookup.mock.mockImplementation(async () => [{ ...h.app, price: 0 }]);
  const result = await downloader.downloadVersion(h.account, { ...h.app, owned: true }, "111");
  assert.equal(h.buy.mock.callCount(), 1);
  assert.equal(h.lookup.mock.callCount(), 1);
  assert.equal(calls, 2);
  assert.equal(result.record.requestedExternalVersionId, "111");
  assert.equal(result.record.externalVersionId, "111");
});

test("network, auth and repeated license errors do not produce repeated purchases", async (t) => {
  const h = fixture(t);
  for (const code of ["2034", "2042", "network"]) {
    h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("stop", code); });
    await assert.rejects(downloader.downloadLatest(h.account, h.app), /stop/);
  }
  assert.equal(h.buy.mock.callCount(), 0);
  h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("license required", "9610"); });
  await assert.rejects(downloader.downloadLatest(h.account, h.app), /license/);
  assert.equal(h.buy.mock.callCount(), 1);
});

test("unknown prices require an identity-matched lookup in the original account region", async (t) => {
  const h = fixture(t);
  h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("license required", "9610"); });
  for (const result of [[], [{ ...h.app, id: "43" }], [{ ...h.app, bundleID: "com.example.other" }]]) {
    h.lookup.mock.mockImplementation(async (_ids, region) => { assert.equal(region, "US"); return result; });
    await assert.rejects(downloader.downloadLatest(h.account, { ...h.app, price: undefined }));
  }
  assert.equal(h.buy.mock.callCount(), 0);
  let attempt = 0;
  h.infoCall.mock.mockImplementation(async () => {
    if (++attempt === 1) throw new download.DownloadError("license required", "9610");
    return h.info;
  });
  h.lookup.mock.mockImplementation(async () => [{ ...h.app, price: "0" }]);
  await downloader.downloadLatest(h.account, { ...h.app, price: undefined });
  assert.equal(h.buy.mock.callCount(), 1);
});

test("paid apps without a license offer the App Store without purchasing", async (t) => {
  const h = fixture(t);
  h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("license required", "9610"); });
  await assert.rejects(downloader.downloadLatest(h.account, { ...h.app, price: 12 }), error => {
    assert.equal(error.needsAppStore, true);
    return true;
  });
  assert.equal(h.buy.mock.callCount(), 0);
});

test("an old owned hint with synthetic zero price cannot acquire a paid license for another account", async (t) => {
  const h = fixture(t);
  h.infoCall.mock.mockImplementation(async () => { throw new download.DownloadError("license required", "9610"); });
  h.lookup.mock.mockImplementation(async () => [{ ...h.app, price: 12 }]);
  await assert.rejects(downloader.downloadLatest(h.account, { ...h.app, owned: true, price: 0 }), error => error.needsAppStore === true);
  assert.equal(h.lookup.mock.callCount(), 1);
  assert.equal(h.buy.mock.callCount(), 0);
});

test("duplicate downloads share a task and promise while both callers receive progress", async (t) => {
  const h = fixture(t);
  let release;
  const held = new Promise(resolve => { release = () => resolve(h.info); });
  h.infoCall.mock.mockImplementation(() => held);
  const progressA = [], progressB = [];
  const first = downloader.downloadVersion(h.account, h.app, "111", { onProgress: (...value) => progressA.push(value) });
  const second = downloader.downloadVersion(h.account, h.app, "111", { onProgress: (...value) => progressB.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(first, second);
  assert.equal(h.infoCall.mock.callCount(), 1);
  assert.equal(h.save.mock.callCount(), 1);
  assert.deepEqual(progressA, [[100, 100]]);
  assert.deepEqual(progressB, progressA);
});

test("retry keeps the original account and historical ID and retains a missing-account failure", async (t) => {
  const h = fixture(t);
  h.infoCall.mock.mockImplementation(async () => { throw new Error("synthetic first failure"); });
  await assert.rejects(downloader.downloadVersion(h.account, h.app, "111", { region: "US" }));
  const task = queue.snapshot()[0];
  assert.equal(task.accountEmail, h.account.email);
  assert.equal(task.app.price, 0);
  assert.equal(task.app.version, "9.0");
  h.stored.delete(h.account.email);
  await assert.rejects(downloader.retryDownload(task), /账号/);
  assert.ok(queue.snapshot().some(value => value.id === task.id));
  h.stored.set(h.account.email, { ...h.account, store: "JP" });
  await assert.rejects(downloader.retryDownload(task), /区域/);
  assert.ok(queue.snapshot().some(value => value.id === task.id));
  h.stored.set(h.account.email, h.account);
  h.infoCall.mock.mockImplementation(async (account, _app, version) => {
    assert.equal(account.email, h.account.email);
    assert.equal(version, "111");
    return h.info;
  });
  await downloader.retryDownload(task);
  assert.equal(queue.snapshot().length, 0);
});

test("different versions keep separate tasks and failed operations release the dedup key", async (t) => {
  const h = fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  h.infoCall.mock.mockImplementation(async (_account, _app, version) => {
    await held;
    return { ...h.info, externalVersionId: version };
  });
  const one = downloader.downloadVersion(h.account, h.app, "111");
  const two = downloader.downloadVersion(h.account, h.app, "222");
  assert.notEqual(one, two);
  assert.equal(queue.snapshot().length, 2);
  release();
  await Promise.all([one, two]);
  assert.equal(h.infoCall.mock.callCount(), 2);
  h.infoCall.mock.mockImplementation(async () => { throw new Error("synthetic failure"); });
  await assert.rejects(downloader.downloadVersion(h.account, h.app, "111"));
  h.infoCall.mock.mockImplementation(async () => h.info);
  await downloader.downloadVersion(h.account, h.app, "111");
  assert.equal(h.infoCall.mock.callCount(), 4);
});

test("historical records use the IPA version and keep unreadable metadata unknown", async (t) => {
  const h = fixture(t);
  const actual = await downloader.downloadVersion(h.account, h.app, "111");
  assert.equal(actual.record.shortVersion, "1.0");
  assert.equal(actual.record.bundleVersion, "100");
  assert.equal(actual.record.versionSource, "ipa");
  assert.equal(actual.record.metadataVerified, true);
  h.validate.mock.mockImplementation(async () => ({ verified: true, metadataReadable: false, metadataVerified: false, appPath: "Payload/Demo.app" }));
  const unknown = await downloader.downloadVersion(h.account, h.app, "111");
  assert.equal(unknown.record.packageVerified, true);
  assert.equal(unknown.record.metadataVerified, false);
  assert.equal(unknown.record.versionSource, "unknown");
  assert.equal(unknown.record.shortVersion, "");
  assert.equal(unknown.record.bundleVersion, "");
  assert.equal(unknown.record.version, "版本号未知");
  const latest = await downloader.downloadLatest(h.account, h.app);
  assert.equal(latest.record.versionSource, "api");
  assert.equal(latest.record.shortVersion, "9.0");
  assert.equal(latest.record.metadataVerified, false);
});

test("fatal chunked failures never fall back to a whole-file download", async (t) => {
  const h = fixture(t);
  h.chunks.mock.mockImplementation(async () => ({ ok: false, fatal: true, reason: "Content-Range mismatch" }));
  await assert.rejects(downloader.downloadLatest(h.account, h.app), /Content-Range/);
  assert.equal(h.network.mock.callCount(), 0);
  assert.equal(h.save.mock.callCount(), 0);
});
