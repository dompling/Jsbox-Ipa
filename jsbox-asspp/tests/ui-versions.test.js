const { test } = require("node:test");
const assert = require("node:assert/strict");
const { flatten } = require("./helpers/ui");
const { setup, version, snapshot, result, deferred, flush, clone } = require("./helpers/ui-versions");

const placeholder = id => version(id, "", { externalVersionId: "" });
const initial = () => [version("300", "3.0"), placeholder("100"), placeholder("200")];
const cancelled = () => Object.assign(new Error("synthetic enumeration cancellation"), { code: "version_list_cancelled", needsAppStore: false });

async function start(h) {
  await h.showDetail();
  const screen = h.selectVersions();
  h.runDelays();
  assert.equal(h.requests.length, 1);
  screen.request = h.requests[0];
  return screen;
}

function rowIds(screen) {
  return screen.rows().map(row => flatten(row).find(view =>
    String(view.props && view.props.id || "").startsWith(`versions-title-${screen.suffix}-`))
    .props.id.slice(`versions-title-${screen.suffix}-`.length));
}

function captureRows(h, screen) {
  return screen.rows().map(row => ({ row, native: h.mounted.get(row), action: h.button(row) }));
}

function assertSameRows(h, screen, before) {
  assert.equal(screen.rows().length, before.length);
  before.forEach((entry, index) => {
    assert.equal(screen.rows()[index], entry.row, "metadata must retain the existing row definition");
    assert.equal(h.mounted.get(entry.row), entry.native, "metadata must not rebuild a native cell");
    assert.equal(h.button(entry.row).sender, entry.action.sender, "metadata must retain the native action instance");
    assert.equal(h.button(entry.row).progress, entry.action.progress, "metadata must retain the progress instance");
  });
}

test("history pushes its local loading page before the zero-delay enumeration callback", async t => {
  const h = setup(t);
  await h.showDetail();
  const loadingBefore = h.loading.length;
  const pageCount = h.pages.length;
  const screen = h.selectVersions();
  assert.equal(h.pages.length, pageCount + 1, "the menu tap must push synchronously");
  assert.equal(screen.page.props.title, "历史版本");
  assert.match(screen.list.props.id, /^versions-list-\d+$/);
  assert.equal(screen.list.type, "list");
  assert.equal(screen.node("loading").definition.type, "spinner");
  assert.equal(screen.node("loading").loading, true);
  assert.equal(screen.node("empty").hidden, false);
  assert.equal(h.requests.length, 0, "enumeration must wait until the page is pushed");
  assert.deepEqual(h.delays.map(value => value.seconds), [0]);
  assert.deepEqual(h.loading.slice(loadingBefore), [], "history startup uses the page spinner");

  h.runDelays();
  const request = h.requests[0];
  assert.equal(request.owner.email, h.initialAccount.email);
  assert.equal(request.app.id, h.app.id);
  assert.equal(typeof request.options.onVersions, "function");
  assert.equal(typeof request.options.shouldContinue, "function");
  assert.equal(request.options.shouldContinue(), true);
  assert.deepEqual(clone(request.options.knownVersions), []);
  assert.ok(h.events.findIndex(value => value.type === "push" && value.title === "历史版本") <
    h.events.findIndex(value => value.type === "enumeration"));
});

test("runtimes without $delay enumerate immediately after pushing the loading page", async t => {
  const h = setup(t, { delay: false });
  await h.showDetail();
  const screen = h.selectVersions();
  assert.equal(h.requests.length, 1);
  assert.equal(screen.node("loading").loading, true);
  assert.ok(h.events.findIndex(value => value.type === "push" && value.title === "历史版本") <
    h.events.findIndex(value => value.type === "enumeration"));
});

test("330 native ID rows appear before enumeration settles and stay mounted while 15 versions resolve", async t => {
  const h = setup(t, { deferHistoryReady: true });
  const screen = await start(h);
  const emptyList = screen.nativeList;
  const values = Array.from({ length: 330 }, (_, index) => placeholder(String(100000 + index)));
  screen.request.options.onVersions(snapshot(values, []));

  assert.equal(screen.nativeRows().length, 330, "receiving IDs must create native cells, not just update data");
  for (const value of values) {
    assert.match(screen.node("title", value.id).text, new RegExp(`ID ${value.id}`));
    assert.match(screen.node("subtitle", value.id).text, /待补全/);
  }
  const nativeList = screen.nativeList;
  assert.notEqual(nativeList, emptyList);
  assert.equal(nativeList.dataWrites, 1, "static rows arrive in the construction data");
  const before = captureRows(h, screen);
  const partlyResolved = values.map((value, index) => index < 15 ? version(value.id, `${index + 1}.0`) : value);
  screen.request.options.onVersions(snapshot(partlyResolved, partlyResolved.slice(0, 15).map(value => value.id)));

  assert.match(screen.node("status").text, /15\/330/);
  assert.equal(screen.node("progress").loading, true);
  assert.equal(screen.nativeRows().length, 330);
  assert.equal(screen.nativeList, nativeList, "metadata arriving before ready must not rebuild the list");
  assertSameRows(h, screen, before);
  assert.match(screen.node("title", values[14].id).text, /v15\.0/);
  assert.match(screen.node("title", values[15].id).text, /ID 100015/);
  nativeList.definition.events.ready(nativeList);
  assert.equal(nativeList.dataWrites, 1, "ready must not reassign static data");
  assertSameRows(h, screen, before);
  assert.equal(screen.request.options.shouldContinue(), true, "the service promise remains pending throughout ID rendering");
});

test("IDs first received while the empty page is covered mount when it appears", async t => {
  const h = setup(t, { deferHistoryReady: true });
  const screen = await start(h);
  const emptyList = screen.nativeList;
  emptyList.contentOffset = { x: 0, y: 24 };
  const restore = h.cover(screen.page);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  assert.equal(screen.nativeRows().length, 0, "the covered native list has not been rebuilt yet");
  emptyList.definition.events.ready(emptyList);
  restore();
  screen.page.events.appeared();

  assert.notEqual(screen.nativeList, emptyList);
  assert.equal(screen.nativeRows().length, 3);
  assert.match(screen.node("title", "100").text, /ID 100/);
  assert.equal(screen.node("title", "300").text, "v3.0 · 最新");
  assert.deepEqual(screen.nativeList.contentOffset, { x: 0, y: 24 });
  const nativeList = screen.nativeList;
  nativeList.definition.events.ready(nativeList);
  assert.equal(screen.nativeList, nativeList);
  assert.equal(nativeList.dataWrites, 1);
});

test("a retired empty list's late ready cannot disturb the populated list or its actions", async t => {
  const h = setup(t, { deferHistoryReady: true });
  const screen = await start(h);
  const emptyList = screen.nativeList;
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const nativeList = screen.nativeList;
  const before = captureRows(h, screen);
  nativeList.contentOffset = { x: 0, y: 88 };
  emptyList.definition.events.ready(emptyList);
  screen.page.events.appeared();
  assert.equal(screen.nativeRows().length, 3);
  assert.equal(screen.nativeList, nativeList);
  assertSameRows(h, screen, before);
  assert.equal(emptyList.dataWrites, 1, "an obsolete ready must not write to its retired list");
  assert.deepEqual(nativeList.contentOffset, { x: 0, y: 88 });
});

test("the empty state stays above rebuilt lists after a retry returns no IDs", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  screen.request.reject(new Error("synthetic metadata failure"));
  await flush();
  const retry = screen.node("retry");
  const pending = retry.definition.events.tapped(retry);
  h.requests[1].options.onVersions(snapshot([], [], { complete: true }));

  assert.equal(screen.nativeRows().length, 0);
  const empty = screen.node("empty");
  assert.equal(empty.hidden, false);
  assert.equal(empty.super.children.at(-1), empty, "the opaque replacement list must not cover the empty state");
  assert.match(screen.node("empty-text").text, /暂无历史版本/);
  h.requests[1].resolve(result());
  await pending;
});

test("all IDs become usable rows before metadata resolves, and later metadata never reorders or replaces them", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  assert.deepEqual(rowIds(screen), ["300", "100", "200"]);
  assert.match(screen.node("title", "100").text, /ID 100/);
  assert.match(screen.node("subtitle", "100").text, /待补全/);
  assert.equal(screen.node("empty").hidden, true);
  assert.equal(screen.node("loading").loading, false);
  assert.equal(screen.node("progress").loading, true);
  assert.match(screen.node("status").text, /1\/3/);
  const before = captureRows(h, screen);
  before.forEach(({ action }) => {
    assert.equal(action.sender.title, "获取");
    assert.equal(typeof action.definition.events.tapped, "function");
    assert.notEqual(action.sender.enabled, false);
  });
  const writes = screen.nativeList.dataWrites;
  screen.nativeList.contentOffset = { x: 0, y: 177 };
  const partlyResolved = [version("300", "3.0"), version("100", "9.0", { buildVersion: "90" }), placeholder("200")];
  screen.request.options.onVersions(snapshot(partlyResolved, ["300", "100"]));
  assert.equal(screen.node("title", "100").text, "v9.0");
  assert.match(screen.node("subtitle", "100").text, /构建 90.*ID 100/);
  assertSameRows(h, screen, before);
  assert.equal(screen.nativeList.dataWrites, writes);
  assert.deepEqual(screen.nativeList.contentOffset, { x: 0, y: 177 });

  // The service preserves its existing final sort; the already visible UI order is independent.
  screen.request.resolve(result([partlyResolved[0], version("200", "12.0"), partlyResolved[1]], "300"));
  await flush();
  assert.deepEqual(rowIds(screen), ["300", "100", "200"]);
  assert.equal(screen.node("title", "200").text, "v12.0");
  assert.equal(screen.node("progress").loading, false);
  assert.equal(screen.node("retry").hidden, true);
  assertSameRows(h, screen, before);
  assert.equal(screen.nativeList.dataWrites, writes);
  assert.deepEqual(screen.nativeList.contentOffset, { x: 0, y: 177 });
  screen.page.events.appeared();
  assert.equal(h.libraryReads.filter(value => value.version && value.version.externalVersionId === "100").at(-1).version.displayVersion, "9.0",
    "the existing action must consult the updated version model");
});

test("covered history pages reapply native labels and button state without replacing same-ID cells", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const before = captureRows(h, screen);
  const title = screen.node("title", "100");
  const status = screen.node("status");
  const spinner = screen.node("progress");
  const writes = screen.nativeList.dataWrites;
  screen.nativeList.contentOffset = { x: 0, y: 88 };
  const restore = h.cover(screen.page);
  assert.equal(h.nodes.has(screen.list.props.id), false);
  assert.equal(h.nodes.has(before[1].action.sender.id), false, "covering must hide descendants as well as the list");
  screen.request.options.onVersions(snapshot([version("300", "3.0"), version("100", "1.0", { buildVersion: "10" }), version("200", "2.0")], ["300", "100", "200"]));
  screen.request.resolve(result([version("300", "3.0"), version("200", "2.0"), version("100", "1.0", { buildVersion: "10" })], "300"));
  h.saveVersion("100", "1.0");
  await flush();
  assert.match(title.text, /ID 100/, "native labels really remain stale while the page is covered");
  restore();
  screen.page.events.appeared();
  assert.equal(title.text, "v1.0");
  assert.match(screen.node("subtitle", "100").text, /构建 10.*ID 100/);
  assert.match(status.text, /3 个版本/);
  assert.equal(spinner.loading, false);
  assert.equal(before[1].action.sender.title, "打开");
  assertSameRows(h, screen, before);
  assert.equal(screen.nativeList.dataWrites, writes);
  assert.deepEqual(screen.nativeList.contentOffset, { x: 0, y: 88 });
});

test("a failed enumeration retains IDs and retry reuses only explicitly resolved sanitized entries", async t => {
  const h = setup(t);
  const screen = await start(h);
  const partial = [version("300", "3.0"), placeholder("100"), placeholder("200")];
  screen.request.options.onVersions(snapshot(partial, ["300", "200"]));
  const before = captureRows(h, screen);
  screen.request.reject(new Error("synthetic metadata network failure"));
  await flush();
  assert.deepEqual(rowIds(screen), ["300", "100", "200"]);
  assert.equal(screen.node("progress").loading, false);
  assert.equal(screen.node("retry").hidden, false);
  assert.equal(screen.node("retry").title, "重试");
  const retry = screen.node("retry");
  const pending = retry.definition.events.tapped(retry);
  assert.equal(h.requests.length, 2);
  const request = h.requests[1];
  assert.deepEqual(clone(request.options.knownVersions), [partial[0], partial[2]],
    "a resolved entry without readable metadata is reusable; unresolved placeholders are not");
  for (const value of request.options.knownVersions) {
    assert.deepEqual(Object.keys(value).sort(), ["buildVersion", "displayVersion", "externalVersionId", "id", "requestedExternalVersionId"]);
  }
  retry.definition.events.tapped(retry);
  assert.equal(h.requests.length, 2, "repeated retry taps share the in-flight enumeration");
  screen.request.options.onVersions(snapshot([version("999", "stale")], ["999"]));
  assert.deepEqual(rowIds(screen), ["300", "100", "200"], "an old observer cannot overwrite a newer attempt");
  request.resolve(result([partial[0], version("100", "1.0"), partial[2]], "300"));
  await pending;
  assertSameRows(h, screen, before);
  assert.equal(screen.node("retry").hidden, true);
});

test("an empty snapshot stops both spinners and displays an empty state before final settlement", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot([], [], { latest: "", complete: true }));
  assert.deepEqual(screen.rows(), []);
  assert.equal(screen.node("loading").loading, false);
  assert.equal(screen.node("progress").loading, false);
  assert.equal(screen.node("empty").hidden, false);
  assert.match(screen.node("empty-text").text, /暂无历史版本/);
  assert.equal(screen.node("retry").hidden, true);
  screen.request.resolve(result());
  await flush();
  assert.equal(h.alerts.length, 0);
  assert.equal(screen.node("loading").loading, false);
});

for (const outcome of ["result", "error"]) {
  test(`dealloc cancels enumeration and ignores its late snapshots and ${outcome}`, async t => {
    const h = setup(t);
    const screen = await start(h);
    screen.request.options.onVersions(snapshot(initial(), ["300"]));
    const before = captureRows(h, screen);
    screen.page.events.dealloc();
    assert.equal(screen.request.options.shouldContinue(), false);
    const saved = JSON.stringify(screen.page);
    const writes = screen.nativeList.dataWrites;
    screen.request.options.onVersions(snapshot([version("999", "late")], ["999"]));
    if (outcome === "error") screen.request.reject(Object.assign(new Error("late session error"), { code: "2034" }));
    else screen.request.resolve(result([version("999", "late")], "999"));
    await flush();
    assert.equal(JSON.stringify(screen.page), saved);
    assert.equal(screen.nativeList.dataWrites, writes);
    assertSameRows(h, screen, before);
    assert.equal(h.alerts.length, 0);
    await before[1].action.tap();
    assert.equal(h.downloads.length, 0, "a disposed action cannot start a download");
  });
}

test("dealloc before the scheduled startup prevents enumeration entirely", async t => {
  const h = setup(t);
  await h.showDetail();
  const screen = h.selectVersions();
  screen.page.events.dealloc();
  h.runDelays();
  assert.equal(h.requests.length, 0);
});

for (const change of ["account", "region", "signout"]) {
  test(`${change} changes cancel enumeration without accepting old metadata or showing old errors`, async t => {
    const h = setup(t);
    const screen = await start(h);
    screen.request.options.onVersions(snapshot(initial(), ["300"]));
    const before = captureRows(h, screen);
    h.switchAccount(change === "signout" ? null : "other@example.test", change === "region" ? "US" : "CN");
    screen.page.events.appeared();
    assert.equal(screen.request.options.shouldContinue(), false);
    assert.equal(screen.node("progress").loading, false);
    assert.equal(screen.node("retry").hidden, true);
    assert.match(screen.node("status").text, /账号已切换/);
    screen.request.options.onVersions(snapshot([version("999", "late")], ["999"]));
    screen.request.reject(Object.assign(new Error("old account error"), { code: "2042" }));
    await flush();
    assert.deepEqual(rowIds(screen), ["300", "100", "200"]);
    assertSameRows(h, screen, before);
    assert.equal(h.alerts.length, 0);
    await before[1].action.tap();
    assert.equal(h.downloads.length, 0);
    assert.equal(h.requests.length, 1);
  });
}

test("an account change ignores the old enumeration's successful final result", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const before = captureRows(h, screen);
  h.switchAccount("other@example.test");
  screen.page.events.appeared();
  screen.request.resolve(result([version("999", "old result")], "999"));
  await flush();
  assert.deepEqual(rowIds(screen), ["300", "100", "200"]);
  assert.match(screen.node("status").text, /账号已切换/);
  assert.equal(screen.node("progress").loading, false);
  assertSameRows(h, screen, before);
});

for (const observer of ["appeared", "continuation guard"]) {
  test(`an account switch observed by ${observer} permanently cancels that attempt even if the original account returns`, async t => {
    const h = setup(t);
    const screen = await start(h);
    screen.request.options.onVersions(snapshot(initial(), ["300"]));
    h.switchAccount("other@example.test");
    if (observer === "appeared") screen.page.events.appeared();
    assert.equal(screen.request.options.shouldContinue(), false);
    h.switchAccount(h.initialAccount.email);
    screen.page.events.appeared();
    assert.equal(screen.request.options.shouldContinue(), false, "a cancelled metadata attempt must not revive after switching back");
    screen.request.options.onVersions(snapshot([version("999", "stale")], ["999"]));
    screen.request.resolve(result([version("999", "stale")], "999"));
    await flush();
    assert.deepEqual(rowIds(screen), ["300", "100", "200"]);
    assert.equal(h.requests.length, 1);
  });
}

test("a failure before IDs arrive stops the empty-page spinner and exposes retry", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.reject(new Error("synthetic initial request failure"));
  await flush();
  assert.deepEqual(screen.rows(), []);
  assert.equal(screen.node("loading").loading, false);
  assert.equal(screen.node("progress").loading, false);
  assert.equal(screen.node("empty").hidden, false);
  assert.match(screen.node("empty-text").text, /synthetic initial request failure/);
  assert.equal(screen.node("retry").hidden, false);
  const pending = screen.node("retry").definition.events.tapped(screen.node("retry"));
  assert.equal(h.requests.length, 2);
  assert.deepEqual(clone(h.requests[1].options.knownVersions), []);
  h.requests[1].resolve(result());
  await pending;
  assert.equal(screen.node("retry").hidden, true);
});

test("an error after a complete snapshot keeps retry available for service settlement failures", async t => {
  const h = setup(t);
  const screen = await start(h);
  const values = [version("300", "3.0"), version("100", "1.0")];
  screen.request.options.onVersions(snapshot(values, ["300", "100"]));
  const before = captureRows(h, screen);
  screen.request.reject(new Error("synthetic cookie persistence failure"));
  await flush();
  assert.equal(screen.node("progress").loading, false);
  assert.equal(screen.node("retry").hidden, false, "a complete display snapshot does not make a failed service attempt successful");
  const pending = screen.node("retry").definition.events.tapped(screen.node("retry"));
  assert.equal(h.requests.length, 2);
  assert.deepEqual(clone(h.requests[1].options.knownVersions), values);
  h.requests[1].resolve(result(values, "300"));
  await pending;
  assertSameRows(h, screen, before);
  assert.equal(screen.node("retry").hidden, true);
});

test("an exact downloaded external ID opens immediately while enumeration remains pending", async t => {
  const h = setup(t);
  const saved = h.saveVersion("100", "1.0");
  h.saveVersion("999", "2.0");
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const action = h.button(screen.row("100"));
  assert.equal(action.sender.title, "打开");
  assert.equal(h.button(screen.row("200")).sender.title, "获取", "a different external ID must not match a downloaded file");
  const authorizations = h.accountReads.filter(value => value.method === "requireAccountForRegion").length;
  const loadingBefore = h.loading.length;
  let opened = false;
  const pending = action.tap().then(() => { opened = true; });
  await flush();
  assert.equal(opened, true, "Open must not wait for the enumeration service to settle");
  await pending;
  assert.deepEqual(h.opens, [saved.fileName]);
  assert.equal(screen.request.options.shouldContinue(), true, "opening a local file need not cancel metadata enumeration");
  assert.equal(h.requests.length, 1);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.accountReads.filter(value => value.method === "requireAccountForRegion").length, authorizations);
  assert.deepEqual(h.loading.slice(loadingBefore), []);
});

test("Get cancels enumeration, waits through cookie persistence, and downloads with the same account's fresh session", async t => {
  const h = setup(t);
  const persistence = deferred();
  t.after(() => persistence.resolve());
  const enumerate = h.downloader.listVersions;
  const freshAccount = {
    ...clone(h.initialAccount), passwordToken: "synthetic-refreshed",
    cookies: [{ name: "session", value: "persisted-enumeration", domain: "itunes.apple.com", path: "/" }],
  };
  h.downloader.listVersions = (...args) => {
    const pending = enumerate(...args);
    if (h.requests.length !== 1) return pending;
    return pending.then(async () => {
      h.events.push({ type: "metadata-settled" });
      await persistence.promise;
      h.saveAccount(freshAccount);
      h.events.push({ type: "cookies-persisted" });
      throw cancelled();
    });
  };
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const before = captureRows(h, screen);
  const action = h.button(screen.row("100"));
  const writes = screen.nativeList.dataWrites;
  screen.nativeList.contentOffset = { x: 0, y: 144 };
  const pending = action.tap();
  assert.equal(screen.request.options.shouldContinue(), false, "the metadata loop must be cancelled by the tap itself");
  assert.equal(h.downloads.length, 0);
  assert.equal(action.spinner.loading, true);
  assert.equal(action.progress.hidden, true, "history cleanup has no byte progress yet");
  await action.tap();
  assert.equal(h.downloads.length, 0, "duplicate taps stay locked while the old service settles");
  screen.request.options.onVersions(snapshot([version("999", "stale")], ["999"]));
  assert.deepEqual(rowIds(screen), ["300", "100", "200"]);

  // The metadata response has arrived, but the returned service promise still owns cookie persistence.
  screen.request.resolve(result(initial(), "300"));
  await flush();
  assert.ok(h.events.some(value => value.type === "metadata-settled"));
  assert.equal(h.downloads.length, 0, "receiving metadata alone must not unblock download");
  assert.equal(screen.request.owner.cookies[0].value, "initial");
  persistence.resolve();
  await flush();
  assert.equal(h.downloads.length, 1);
  const download = h.downloads[0];
  assert.equal(download.id, "100", "an unresolved placeholder is a usable download target");
  assert.equal(download.owner.email, h.initialAccount.email);
  assert.equal(download.owner.passwordToken, "synthetic-refreshed");
  assert.equal(download.owner.cookies[0].value, "persisted-enumeration");
  assert.notEqual(download.owner, screen.request.owner);
  assert.equal(screen.request.owner.cookies[0].value, "initial", "the old captured account was not mutated to fake freshness");
  assert.ok(h.events.findIndex(value => value.type === "cookies-persisted") < h.events.findIndex(value => value.type === "download"));

  download.options.onProgress(34, 100);
  assert.equal(action.sender.accessibilityValue, "34%");
  assert.equal(action.progress.info.value, 0.34);
  const restore = h.cover(screen.page);
  screen.request.options.onVersions(snapshot([version("999", "late")], ["999"]));
  restore();
  screen.page.events.appeared();
  assert.equal(action.sender.accessibilityValue, "34%", "returning to the page must retain an active button's progress");
  assert.equal(action.progress.info.value, 0.34);
  await action.tap();
  assert.equal(h.downloads.length, 1, "the original duplicate-click guard survives page refreshes");
  assertSameRows(h, screen, before);
  assert.equal(screen.nativeList.dataWrites, writes);
  assert.deepEqual(screen.nativeList.contentOffset, { x: 0, y: 144 });

  const saved = h.saveVersion("100", "1.0");
  const afterDownload = clone(freshAccount);
  afterDownload.cookies[0].value = "persisted-download";
  h.saveAccount(afterDownload);
  download.resolve({ record: saved });
  await pending;
  assert.equal(action.sender.title, "打开");
  assert.equal(action.progress.hidden, true);
  assert.equal(h.completions.length, 1);
  assert.equal(h.requests.length, 2, "metadata can resume after the download finishes");
  const resumed = h.requests[1];
  assert.equal(resumed.owner.email, h.initialAccount.email);
  assert.equal(resumed.owner.cookies[0].value, "persisted-download");
  assert.deepEqual(clone(resumed.options.knownVersions), [version("300", "3.0")]);
  assert.equal(resumed.options.shouldContinue(), true);
  resumed.options.onVersions(snapshot([version("300", "3.0"), version("100", "1.0"), version("200", "2.0")], ["300", "100", "200"]));
  resumed.resolve(result([version("300", "3.0"), version("200", "2.0"), version("100", "1.0")], "300"));
  await flush();
  assertSameRows(h, screen, before);
  assert.equal(screen.nativeList.dataWrites, writes);
  assert.equal(action.sender.title, "打开");
  assert.equal(screen.node("title", "100").text, "v1.0");
  await action.tap();
  assert.deepEqual(h.opens, [saved.fileName]);
  assert.equal(h.downloads.length, 1);
});

test("two version actions keep independent progress and resume enumeration only after both downloads finish", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const before = captureRows(h, screen);
  const first = h.button(screen.row("100"));
  const second = h.button(screen.row("200"));
  const firstPending = first.tap();
  const secondPending = second.tap();
  assert.equal(screen.request.options.shouldContinue(), false);
  assert.equal(h.downloads.length, 0);
  screen.request.reject(cancelled());
  await flush();
  assert.deepEqual(h.downloads.map(value => value.id), ["100", "200"]);
  const firstDownload = h.downloads[0], secondDownload = h.downloads[1];
  firstDownload.options.onProgress(30, 100);
  secondDownload.options.onProgress(60, 100);
  assert.equal(first.sender.accessibilityValue, "30%");
  assert.equal(second.sender.accessibilityValue, "60%");
  await first.tap();
  await second.tap();
  assert.equal(h.downloads.length, 2);

  firstDownload.resolve({ record: h.saveVersion("100", "1.0") });
  await firstPending;
  assert.equal(h.requests.length, 1, "finishing one download must not resume metadata over another active download");
  assert.equal(first.sender.title, "打开");
  assert.equal(second.sender.accessibilityValue, "60%");
  assert.equal(second.progress.info.value, 0.6);
  assert.equal(screen.node("retry").hidden, true);
  screen.node("retry").definition.events.tapped(screen.node("retry"));
  assert.equal(h.requests.length, 1);
  secondDownload.resolve({ record: h.saveVersion("200", "2.0") });
  await secondPending;
  assert.equal(h.requests.length, 2, "the last active download resumes exactly one enumeration");
  assert.deepEqual(clone(h.requests[1].options.knownVersions), [version("300", "3.0")]);
  assert.equal(second.sender.title, "打开");
  assertSameRows(h, screen, before);
});

test("a failed download releases its action and offers manual metadata continuation without an automatic loop", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const action = h.button(screen.row("100"));
  const pending = action.tap();
  screen.request.reject(cancelled());
  await flush();
  assert.equal(h.downloads.length, 1);
  h.downloads[0].reject(new Error("synthetic download failure"));
  await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(action.sender.title, "获取");
  assert.equal(action.progress.hidden, true);
  assert.equal(screen.node("retry").hidden, false);
  assert.equal(screen.node("retry").title, "继续");
  const retryPending = screen.node("retry").definition.events.tapped(screen.node("retry"));
  assert.equal(h.requests.length, 2);
  assert.deepEqual(clone(h.requests[1].options.knownVersions), [version("300", "3.0")]);
  h.requests[1].resolve(result([version("300", "3.0"), version("100", "1.0"), version("200", "2.0")], "300"));
  await retryPending;
  assert.equal(h.button(screen.row("100")).sender, action.sender);
});

test("account switch while a tap waits for enumeration prevents the queued download", async t => {
    const h = setup(t);
    const screen = await start(h);
    screen.request.options.onVersions(snapshot(initial(), ["300"]));
    const action = h.button(screen.row("100"));
    const pending = action.tap();
    assert.equal(h.downloads.length, 0);
    h.switchAccount("other@example.test");
    screen.page.events.appeared();
    screen.request.reject(cancelled());
    await pending;
    assert.equal(h.downloads.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.alerts.length, 0);
    assert.equal(screen.request.options.shouldContinue(), false);
});

test("leaving history during download preparation keeps the request alive through enumeration cleanup", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const pending = h.button(screen.row("100")).tap();
  screen.page.events.dealloc();
  assert.equal(screen.request.options.shouldContinue(), false);
  const fresh = { ...clone(h.initialAccount), passwordToken: "fresh-after-enumeration" };
  h.saveAccount(fresh);
  screen.request.reject(cancelled());
  await flush();
  assert.equal(h.downloads.length, 1, "leaving a page must not implicitly cancel an explicit Get");
  assert.equal(h.downloads[0].owner.email, fresh.email);
  assert.equal(h.downloads[0].owner.passwordToken, fresh.passwordToken);
  h.downloads[0].resolve({ record: h.saveVersion("100", "1.0") });
  await pending;
  assert.equal(h.requests.length, 1, "a closed page must not resume metadata enumeration");
  assert.equal(h.alerts.length, 0);
});

test("a confirmed Get cancellation waits for enumeration cleanup and never starts that version download", async t => {
  const h = setup(t);
  const screen = await start(h);
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const action = h.button(screen.row("100"));
  const pending = action.tap();
  await action.tap();
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].title, "取消下载？");
  h.alerts[0].actions.find(value => value.title === "取消下载").handler();
  assert.equal(action.sender.accessibilityValue, "正在取消");
  assert.equal(h.downloads.length, 0);
  assert.equal(screen.node("retry").hidden, true, "enumeration still owns the Cookie cleanup");
  screen.request.reject(cancelled());
  await pending;
  assert.equal(h.downloads.length, 0);
  assert.equal(h.requests.length, 1, "cancelled downloads cannot automatically resume metadata work");
  assert.equal(h.completions.length, 0);
  assert.equal(h.alerts.length, 1);
  assert.equal(action.sender.title, "获取");
  assert.equal(action.progress.hidden, true);
  assert.equal(screen.node("retry").hidden, false);
});

test("a confirmation opened during history cleanup follows only the same download through task handoff", async t => {
  const h = setup(t);
  const screen = await start(h);
  const loadingBefore = h.loading.length;
  screen.request.options.onVersions(snapshot(initial(), ["300"]));
  const action = h.button(screen.row("100"));
  const pending = action.tap();
  await action.tap();
  assert.equal(h.alerts.length, 1);
  const confirmation = h.alerts[0];
  screen.request.reject(cancelled());
  await flush();
  assert.equal(h.downloads.length, 1);
  const download = h.downloads[0];
  assert.deepEqual(h.loading.slice(loadingBefore), [], "inline downloads must leave their cancel button reachable without a global loading overlay");
  assert.equal(typeof download.options.onTask, "function", "historical downloads must publish the service task");
  const { createCancellation, DownloadCancelledError } = require("../scripts/lib/cancellation");
  const cancellation = createCancellation();
  const control = {
    id: "history-transfer", name: h.app.name,
    canCancel: () => !cancellation.cancelled,
    cancel: () => cancellation.cancel(),
    subscribe: listener => cancellation.subscribe(listener),
  };
  download.options.onTask(control);
  h.downloader.downloadControl = id => id === control.id ? control : null;
  h.load("ui/common.js").confirmCancelDownload(control.id);
  assert.equal(h.alerts.length, 1, "handoff must not create a second confirmation for the same download");
  download.options.onProgress(30, 100);
  confirmation.actions.find(value => value.title === "取消下载").handler();
  assert.equal(cancellation.cancelled, true, "the still-open confirmation must cancel that same attempt after handoff");
  assert.equal(action.sender.accessibilityValue, "正在取消");
  download.options.onProgress(90, 100);
  assert.equal(action.sender.accessibilityValue, "正在取消");
  download.reject(new DownloadCancelledError());
  await pending;
  assert.equal(action.sender.title, "获取");
  assert.equal(action.progress.hidden, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.completions.length, 0);
});
