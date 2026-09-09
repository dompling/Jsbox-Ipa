const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, flatten, flush, deferred } = require("./helpers/ui");
const realPurchases = require("../scripts/apple/purchases");
const realStore = require("../scripts/apple/store");
const realFormat = require("../scripts/lib/format");

const app = (id, name = `App ${id}`) => ({ id: String(id), name, owned: true, price: 0 });
const apps = (count) => Array.from({ length: count }, (_value, index) => app(index + 1));
const plain = (value) => JSON.parse(JSON.stringify(value));
const rows = (h) => h.nodes.get("purchased-list").definition.props.data.flatMap((section) => section.rows);
const names = (h) => Array.from(rows(h)).flatMap(flatten)
  .filter((view) => view.type === "label" && (view.props.font || []).join(",") === "bold,16")
  .map((view) => view.props.text);
const copy = (h) => h.nodes.get("purchased-list").definition.props.data
  .flatMap((section) => [section.title, ...section.rows.flatMap(flatten).map((view) => view.props.text || view.props.title || "")]).join("\n");

function harness() {
  const h = setup();
  h.load("lib/format.js").formatDate = realFormat.formatDate;
  let now = 1000;
  let timerId = 0;
  const timers = new Map();
  h.values = new Map();
  h.enrichments = [];
  h.context.Date = class extends Date { static now() { return now; } };
  h.context.$cache = {
    get: (key) => h.values.get(key),
    set: (key, value) => { h.values.set(key, plain(value)); return true; },
  };
  h.context.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
  h.context.clearTimeout = (id) => timers.delete(id);
  h.load("apple/purchases.js").enrichApps = (records, region, options) => {
    const pending = deferred();
    h.enrichments.push({ apps: records, region, options, ...pending });
    return pending.promise;
  };
  h.cache = h.load("store/purchased-cache.js");
  h.setNow = (value) => { now = value; };
  h.runTimers = async () => {
    const pending = Array.from(timers.values());
    timers.clear();
    for (const callback of pending) callback();
    await flush();
  };
  h.seed = (email, region, records, options = {}) => h.cache.write(email, region, {
    apps: records, totalCount: records.length, complete: true, enrichedIds: records.map((record) => record.id), updatedAt: now, ...options,
  });
  return h;
}

async function finishSnapshot(h, index, records, totalCount = records.length) {
  h.requests[index].resolve({ apps: records.slice(0, 20), allApps: records, totalCount });
  await flush();
}

async function finishEnrichment(h, index, result) {
  const pending = h.enrichments[index];
  pending.resolve(result || pending.apps.map((record) => ({ ...record, artworkUrl: `https://example.test/${record.id}.png` })));
  await flush();
}

function search(h, text) {
  const input = h.nodes.get("purchased-search-input");
  input.text = text;
  input.definition.events.changed(input);
}

function bottom(h, sender = {}) {
  const list = h.nodes.get("purchased-list");
  return list.definition.events.didReachBottom(sender);
}

function subtitleLines(row) {
  return flatten(row).filter((view) => view.type === "label" && /-subtitle-\d+$/.test(view.props.id || ""));
}

test("purchased rows keep version, bundle ID and purchase date on separate single lines", () => {
  const h = harness();
  const record = {
    ...app("1", "Camera"), version: "1.2.1", bundleID: "com.example.a.very.long.application.identifier",
    purchaseDate: "2022-12-30T12:00:00", releaseDate: "2025-06-01T12:00:00",
  };
  h.seed("a@example.test", "CN", [record]);
  h.mountTab("purchased").mount();
  const labels = subtitleLines(rows(h)[0]);
  assert.deepEqual(labels.map((view) => view.props.text), [
    "版本：1.2.1", record.bundleID, "2022.12.30",
  ]);
  assert.ok(labels.every((view) => view.props.lines === 1), "a long bundle must not wrap over the purchase date");
  assert.doesNotMatch(copy(h), /2025|购买于|App Store 已购项目/);
  const list = h.nodes.get("purchased-list").definition;
  assert.equal(list.props.rowHeight, list.events.rowHeight(null, { row: 0 }));
  assert.ok(list.props.rowHeight >= 120, "the row must fit its two-line title and three subtitle lines");
  assert.equal(list.events.rowHeight(null, { row: 1 }), 44, "the footer remains compact");
});

test("missing or invalid purchased metadata keeps all three positions without leaking raw dates", () => {
  const h = harness();
  h.seed("a@example.test", "CN", [
    { ...app("1"), purchaseDate: "invalid-date-from-response" },
    app("2"),
  ]);
  h.mountTab("purchased").mount();
  for (const row of rows(h).slice(0, 2)) {
    const labels = subtitleLines(row);
    assert.deepEqual(labels.map((view) => view.props.text), ["版本：未知", "Bundle ID 未知", "日期未知"]);
  }
  assert.doesNotMatch(copy(h), /invalid-date/);
});

test("purchased fetches one complete snapshot and scrolls locally in serial metadata batches", async () => {
  const h = harness();
  h.mountTab("purchased").mount();
  assert.equal(h.requests[0].options.includeAllApps, true);
  assert.equal(h.requests[0].options.enrich, false);
  await finishSnapshot(h, 0, apps(41));
  assert.equal(names(h).length, 20);
  assert.equal(h.enrichments.length, 1);
  assert.equal(h.enrichments[0].apps.length, 20);
  let ended = 0;
  const list = h.nodes.get("purchased-list");
  list.contentOffset = { x: 0, y: 940 };
  const next = bottom(h, { endFetchingMore: () => ended++ });
  const duplicate = bottom(h, { endFetchingMore: () => ended++ });
  await duplicate;
  assert.equal(ended, 2, "all bottom events release the native loading state before replacement");
  assert.equal(names(h).length, 40);
  assert.equal(h.nodes.get("purchased-list").contentOffset.y, 940);
  assert.equal(h.enrichments.length, 1, "scrolling reveals raw records without waiting for icons or starting concurrent lookup");
  await next;
  await finishEnrichment(h, 0);
  await h.runTimers();
  assert.equal(h.enrichments.length, 2);
  assert.equal(h.enrichments[1].apps[0].id, "21");
  await finishEnrichment(h, 1);
  const last = bottom(h);
  assert.equal(names(h).length, 41);
  await finishEnrichment(h, 2);
  await last;
  await bottom(h, { endFetchingMore: () => ended++ });
  assert.equal(ended, 3);
  assert.equal(h.requests.length, 1, "scrolling must not repeat DAAP/SAP history requests");
  assert.equal(h.enrichments.length, 3);
  assert.equal(rows(h).flatMap(flatten).some((view) => view.props.accessibilityLabel === "加载更多已购 App"), false);
});

test("twenty-item cached paging has a transparent idle footer with no button, copy or artificial loading", async () => {
  const h = harness();
  h.seed("a@example.test", "CN", apps(41));
  h.mountTab("purchased").mount();
  assert.equal(names(h).length, 20);
  const checkFooter = () => {
    const footer = rows(h).at(-1);
    const views = flatten(footer);
    assert.equal(footer.props.bgcolor, 'color:"clear"');
    assert.equal(views.some((view) => view.props.bgcolor === h.load("ui/common.js").colors.card), false);
    assert.equal(views.some((view) => Number(view.props.cornerRadius) > 0), false);
    assert.equal(views.some((view) => view.type === "button" && !view.props.hidden), false);
    assert.equal(views.some((view) => view.type === "label" && view.props.text), false);
    const spinner = views.find((view) => view.type === "spinner");
    assert.ok(spinner);
    assert.equal(h.nodes.get(spinner.props.id).loading, false);
    assert.ok(h.nodes.get("purchased-list").definition.events.rowHeight(null, { row: names(h).length }) <= 44);
  };
  checkFooter();
  await bottom(h);
  assert.equal(names(h).length, 40);
  checkFooter();
  assert.equal(h.requests.length, 0);
  assert.equal(h.enrichments.length, 0);
  assert.doesNotMatch(copy(h), /上滑加载|已显示|加载更多/);
});

test("the lightweight footer spinner follows actual metadata work and failures use a compact retry", async () => {
  const h = harness();
  h.mountTab("purchased").mount();
  await finishSnapshot(h, 0, apps(21));
  const footer = rows(h).at(-1);
  const spinner = flatten(footer).find((view) => view.type === "spinner");
  assert.ok(spinner);
  assert.equal(h.nodes.get(spinner.props.id).loading, true);
  assert.equal(flatten(footer).some((view) => view.type === "label" && view.props.text), false);
  h.enrichments[0].reject(new Error("lookup offline"));
  await flush();
  assert.equal(h.nodes.get(spinner.props.id).loading, false);
  assert.equal(flatten(footer).some((view) => view.props.bgcolor === h.load("ui/common.js").colors.card), false);
  const retry = flatten(footer).find((view) => view.type === "button");
  assert.equal(h.nodes.get(retry.props.id).hidden, false);
  assert.match(h.nodes.get(retry.props.id).accessibilityLabel, /重试/);
});

test("title search immediately finds later snapshot entries without changing the mounted input", async () => {
  const h = harness();
  h.mountTab("purchased").mount();
  const records = [...apps(23), app("late", "My Camera")];
  await finishSnapshot(h, 0, records);
  const input = h.nodes.get("purchased-search-input");
  search(h, "  cAmErA  ");
  assert.deepEqual(names(h), ["My Camera"]);
  assert.ok(h.nodes.get("purchased-search-input") === input);
  assert.equal(h.requests.length, 1);
  await h.runTimers();
  assert.equal(h.enrichments.length, 1, "queries share the pending metadata request");
  await finishEnrichment(h, 0);
  await h.runTimers();
  assert.equal(h.enrichments.length, 2);
  assert.deepEqual(Array.from(h.enrichments[1].apps, (record) => record.id), ["late"]);
  search(h, "");
  await finishEnrichment(h, 1);
  await h.runTimers();
  assert.equal(names(h).length, 20);
  assert.equal(h.enrichments.length, 2, "clearing the query cannot resume its old enrichment chain");
  assert.ok(h.nodes.get("purchased-search-input") === input);
});

test("a fresh persistent snapshot supports local title search without another Apple request", async () => {
  const h = harness();
  h.seed("a@example.test", "CN", [...apps(22), app("late", "Cached Camera")]);
  h.mountTab("purchased").mount();
  assert.equal(h.requests.length, 0);
  assert.equal(names(h).length, 20);
  search(h, "camera");
  assert.deepEqual(names(h), ["Cached Camera"]);
  await h.runTimers();
  assert.equal(h.enrichments.length, 0);
});

test("stale cache is shown while refreshing and a failure preserves its data and timestamp", async () => {
  const h = harness();
  h.seed("a@example.test", "CN", [app("old", "Cached App")]);
  const before = plain([...h.values.values()]);
  h.setNow(1000 + h.cache.TTL_MS);
  h.mountTab("purchased").mount();
  assert.deepEqual(names(h), ["Cached App"]);
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error("offline [诊断] never-cache-this"));
  await flush();
  assert.deepEqual(names(h), ["Cached App"]);
  assert.match(copy(h), /刷新失败|保留.*缓存/);
  assert.deepEqual(plain([...h.values.values()]), before);
  search(h, "absent");
  assert.match(copy(h), /暂未找到|缓存/);
  assert.doesNotMatch(copy(h), /已搜索全部|全部搜索完成/);
});

test("returning after cache expiry refreshes in place and does not repeatedly retry a failed refresh", async () => {
  const h = harness();
  const records = apps(41);
  h.seed("a@example.test", "CN", records);
  const page = h.mountTab("purchased");
  page.mount();
  await bottom(h);
  h.nodes.get("purchased-list").contentOffset = { x: 0, y: 940 };
  h.setNow(1000 + h.cache.TTL_MS);
  page.mount();
  assert.equal(h.requests.length, 1);
  assert.equal(names(h).length, 40);
  assert.equal(h.nodes.get("purchased-list").contentOffset.y, 940);
  await finishSnapshot(h, 0, records);
  assert.equal(names(h).length, 40, "a background refresh keeps the local paging window");
  assert.equal(h.nodes.get("purchased-list").contentOffset.y, 940);
  h.setNow(1000 + h.cache.TTL_MS * 2);
  page.mount();
  assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error("offline"));
  await flush();
  page.mount();
  page.mount();
  assert.equal(h.requests.length, 2, "an acknowledged failure waits for an explicit retry");
  assert.equal(names(h).length, 40);
});

test("pull refresh always ends and only a successful snapshot replaces existing rows", async () => {
  const h = harness();
  h.seed("a@example.test", "CN", [app("old")]);
  h.mountTab("purchased").mount();
  let ended = 0;
  const pull = () => h.nodes.get("purchased-list").definition.events.pulled({ endRefreshing: () => ended++ });
  const failed = pull();
  assert.deepEqual(names(h), ["App old"]);
  h.requests[0].reject(new Error("offline"));
  await failed;
  assert.equal(ended, 1);
  assert.deepEqual(names(h), ["App old"]);
  const success = pull();
  await finishSnapshot(h, 1, []);
  await success;
  assert.equal(ended, 2);
  assert.deepEqual(names(h), []);
  assert.match(copy(h), /没有已购 App/);
  assert.equal(h.cache.read("a@example.test", "CN", 1001).totalCount, 0);
  h.switchAccount(null);
  const noAccount = pull();
  await noAccount;
  assert.equal(ended, 3);
  assert.match(copy(h), /还没有可用账号/);
});

test("metadata caching preserves the snapshot age and excludes raw lookup responses", async () => {
  const h = harness();
  h.mountTab("purchased").mount();
  await finishSnapshot(h, 0, [app("1")]);
  h.setNow(4000);
  await finishEnrichment(h, 0, [{ ...app("1"), artworkUrl: "https://example.test/new.png", raw: { token: "secret" } }]);
  const cached = h.cache.read("a@example.test", "CN", 4001);
  assert.equal(cached.updatedAt, 1000);
  assert.equal(cached.apps[0].artworkUrl, "https://example.test/new.png");
  assert.equal(cached.apps[0].raw, undefined);
  assert.deepEqual(Array.from(cached.enrichedIds), ["1"]);
});

test("metadata enrichment receives only owned fields and can replace cached artwork", async () => {
  const h = harness();
  h.seed("a@example.test", "CN", [{ ...app("1", ""), artworkUrl: "https://example.test/old.png", raw: { secret: "no" } }], { enrichedIds: [] });
  h.mountTab("purchased").mount();
  assert.equal(h.enrichments.length, 1);
  assert.equal(h.enrichments[0].apps[0].name, "", "display placeholders cannot become owned titles");
  assert.equal(h.enrichments[0].apps[0].artworkUrl, undefined);
  assert.equal(h.enrichments[0].apps[0].raw, undefined);
  await finishEnrichment(h, 0, [{ ...app("1", "Resolved Camera"), artworkUrl: "https://example.test/new.png" }]);
  assert.deepEqual(names(h), ["Resolved Camera"]);
  assert.equal(h.cache.read("a@example.test", "CN", 1001).apps[0].artworkUrl, "https://example.test/new.png");
});

test("metadata updates preserve a busy download action, progress and its latest App model", async () => {
  const h = harness();
  const download = deferred();
  let progress;
  const requested = [];
  h.load("ui/detail.js").downloadApp = (record, _region, options) => {
    requested.push({ ...record });
    progress = options.onProgress;
    return download.promise;
  };
  h.mountTab("purchased").mount();
  const purchased = { ...app("1", ""), purchaseDate: "2022-12-30T12:00:00" };
  await finishSnapshot(h, 0, [purchased]);
  const list = h.nodes.get("purchased-list");
  const subtitles = subtitleLines(rows(h)[0]);
  const action = rows(h).flatMap(flatten).find((view) => (view.props.id || "").startsWith("download-action-"));
  const button = h.nodes.get(action.props.id);
  const running = action.events.tapped(button);
  progress(40, 100);
  h.enrichments[0].options.onApps([{ ...purchased, name: "Resolved App", version: "2.0", bundleID: "com.example.resolved", artworkUrl: "https://example.test/resolved.png" }]);
  assert.ok(h.nodes.get("purchased-list") === list, "metadata does not replace native App rows");
  assert.ok(h.nodes.get(action.props.id) === button);
  assert.deepEqual(subtitleLines(rows(h)[0]), subtitles, "metadata updates retain the same subtitle definitions");
  assert.deepEqual(subtitles.map((view) => h.nodes.get(view.props.id).text), ["版本：2.0", "com.example.resolved", "2022.12.30"]);
  assert.equal(button.accessibilityValue, "40%");
  progress(80, 100);
  assert.equal(button.accessibilityValue, "80%");
  await action.events.tapped(button);
  assert.equal(requested.length, 1, "metadata updates cannot reset the download lock");
  await finishEnrichment(h, 0, [{ ...purchased, name: "Resolved App", version: "3.0", bundleID: "com.example.resolved", artworkUrl: "https://example.test/final.png" }]);
  assert.ok(h.nodes.get("purchased-list") === list, "finishing metadata also keeps the active action");
  assert.equal(button.accessibilityValue, "80%");
  assert.deepEqual(subtitles.map((view) => h.nodes.get(view.props.id).text), ["版本：3.0", "com.example.resolved", "2022.12.30"]);
  assert.deepEqual(names(h), ["Resolved App"]);
  assert.equal(h.refreshedIds().length, 1);
  download.resolve(false);
  await running;
  await action.events.tapped(button);
  assert.equal(requested.length, 2);
  assert.equal(requested[1].version, "3.0", "the retained button reads the updated App model");
  assert.equal(requested[1].name, "Resolved App");
});

test("a search count change beyond the visible window keeps busy App rows", async () => {
  const h = harness();
  const download = deferred();
  let progress;
  h.load("ui/detail.js").downloadApp = (_record, _region, options) => {
    progress = options.onProgress;
    return download.promise;
  };
  const records = [...apps(20).map((record) => ({ ...record, name: `Camera ${record.id}` })), app("late", "")];
  h.seed("a@example.test", "CN", records, { enrichedIds: records.slice(0, 20).map((record) => record.id) });
  h.mountTab("purchased").mount();
  search(h, "camera");
  await h.runTimers();
  const list = h.nodes.get("purchased-list");
  const action = rows(h).flatMap(flatten).find((view) => (view.props.id || "").startsWith("download-action-"));
  const button = h.nodes.get(action.props.id);
  const running = action.events.tapped(button);
  progress(40, 100);
  h.enrichments[0].options.onApps([app("late", "Late Camera")]);
  assert.ok(h.nodes.get("purchased-list") === list, "a new match outside the local window is not a row change");
  assert.ok(h.nodes.get(action.props.id) === button);
  assert.match(h.nodes.get("purchased-summary").text, /找到 21 个/);
  assert.equal(names(h).length, 20);
  progress(80, 100);
  assert.equal(button.accessibilityValue, "80%");
  await finishEnrichment(h, 0, [app("late", "Late Camera")]);
  assert.ok(h.nodes.get("purchased-list") === list);
  download.resolve(false);
  await running;
});

test("metadata received while covered reapplies to the same busy native rows on return", async () => {
  const h = harness();
  const download = deferred();
  let progress;
  h.load("ui/detail.js").downloadApp = (_record, _region, options) => {
    progress = options.onProgress;
    return download.promise;
  };
  h.seed("a@example.test", "CN", [app("42", "Camera")], { enrichedIds: [] });
  const page = h.mountTab("purchased");
  page.mount();
  const list = h.nodes.get("purchased-list");
  const action = rows(h).flatMap(flatten).find((view) => (view.props.id || "").startsWith("download-action-"));
  const image = rows(h).flatMap(flatten).find((view) => (view.props.id || "").endsWith("-icon"));
  const button = h.nodes.get(action.props.id);
  const running = action.events.tapped(button);
  progress(40, 100);
  const hidden = [...h.nodes.entries()].filter(([_id, node]) => {
    for (let current = node; current; current = current.super) if (current === list) return true;
    return false;
  });
  for (const [id] of hidden) h.nodes.delete(id);
  const updated = { ...app("42", "Updated Camera"), artworkUrl: "https://example.test/updated.png" };
  h.enrichments[0].options.onApps([updated]);
  await finishEnrichment(h, 0, [updated]);
  for (const [id, node] of hidden) h.nodes.set(id, node);
  page.mount();
  assert.ok(h.nodes.get("purchased-list") === list);
  assert.ok(h.nodes.get(action.props.id) === button);
  assert.deepEqual(names(h), ["Updated Camera"]);
  assert.equal(h.nodes.get(image.props.id).src, updated.artworkUrl, "native properties missed while covered are reapplied");
  progress(80, 100);
  assert.equal(button.accessibilityValue, "80%");
  download.resolve(false);
  await running;
});

test("a real public lookup failure pauses enrichment and leaves failed IDs available for retry", async () => {
  const h = harness();
  const original = realStore.lookupByIds;
  let attempts = 0;
  let page;
  realStore.lookupByIds = async () => { attempts++; throw new Error("synthetic lookup outage"); };
  h.load("apple/purchases.js").enrichApps = realPurchases.enrichApps;
  try {
    h.seed("a@example.test", "CN", [app("42")], { enrichedIds: [] });
    page = h.mountTab("purchased");
    page.mount();
    await flush();
    assert.equal(attempts, 1);
    assert.deepEqual(Array.from(h.cache.read("a@example.test", "CN", 1001).enrichedIds), []);
    assert.match(copy(h), /补全失败/);
    realStore.lookupByIds = async (ids) => {
      attempts++;
      return ids.map((id) => ({ id, name: `App ${id}`, artworkUrl: "https://example.test/retried.png" }));
    };
    const retry = rows(h).flatMap(flatten).find((view) => view.type === "button" && /补全失败/.test(view.props.accessibilityLabel || ""));
    retry.events.tapped();
    await flush();
    assert.equal(attempts, 2);
    assert.deepEqual(Array.from(h.cache.read("a@example.test", "CN", 1001).enrichedIds), ["42"]);
  } finally {
    if (page) page.dispose();
    realStore.lookupByIds = original;
  }
});

test("a real lookup outage stops unknown-title search after its first public request", async () => {
  const h = harness();
  const original = realStore.lookupByIds;
  let attempts = 0;
  let page;
  realStore.lookupByIds = async () => { attempts++; throw new Error("synthetic lookup outage"); };
  h.load("apple/purchases.js").enrichApps = realPurchases.enrichApps;
  try {
    h.seed("a@example.test", "CN", apps(41).map((record) => ({ ...record, name: "" })), { enrichedIds: [] });
    page = h.mountTab("purchased");
    page.mount();
    await flush();
    search(h, "camera");
    await h.runTimers();
    await h.runTimers();
    assert.equal(attempts, 1, "offline search cannot issue every remaining public batch");
    assert.deepEqual(Array.from(h.cache.read("a@example.test", "CN", 1001).enrichedIds), []);
    assert.match(copy(h), /暂未找到/);
    assert.match(copy(h), /补全失败/);
  } finally {
    if (page) page.dispose();
    realStore.lookupByIds = original;
  }
});

test("a successful public lookup with no matching App is not retried automatically", async () => {
  const h = harness();
  const original = realStore.lookupByIds;
  let attempts = 0;
  let page;
  realStore.lookupByIds = async () => { attempts++; return []; };
  h.load("apple/purchases.js").enrichApps = realPurchases.enrichApps;
  try {
    h.seed("a@example.test", "CN", [app("42", "")], { enrichedIds: [] });
    page = h.mountTab("purchased");
    page.mount();
    await flush();
    search(h, "camera");
    await h.runTimers();
    assert.equal(attempts, 1);
    const cached = h.cache.read("a@example.test", "CN", 1001);
    assert.deepEqual(Array.from(cached.enrichedIds), ["42"]);
    assert.equal(cached.apps[0].name, "");
    assert.match(copy(h), /未能补全/);
  } finally {
    if (page) page.dispose();
    realStore.lookupByIds = original;
  }
});

test("unknown titles are searched in sequential public batches and failure does not claim a complete miss", async () => {
  const h = harness();
  const records = [app("known", "Camera"), ...Array.from({ length: 21 }, (_value, index) => app(`unknown-${index}`, ""))];
  h.seed("a@example.test", "CN", records, { enrichedIds: ["known"] });
  h.mountTab("purchased").mount();
  search(h, "no match yet");
  assert.deepEqual(names(h), []);
  assert.match(copy(h), /暂未找到/);
  assert.match(copy(h), /名称待补全/);
  search(h, "camera");
  assert.deepEqual(names(h), ["Camera"]);
  const spinner = flatten(rows(h).at(-1)).find((view) => view.type === "spinner");
  assert.equal(h.nodes.get(spinner.props.id).loading, true, "nonempty results use only lightweight loading while titles are pending");
  await h.runTimers();
  assert.equal(h.enrichments.length, 1);
  await finishEnrichment(h, 0, h.enrichments[0].apps.map((record) => app(record.id, record.id === "unknown-0" ? "Hidden Camera" : "Other")));
  await h.runTimers();
  assert.equal(h.enrichments.length, 2);
  assert.ok(names(h).includes("Hidden Camera"));
  h.enrichments[1].reject(new Error("lookup offline"));
  await flush();
  await h.runTimers();
  await bottom(h);
  assert.equal(h.enrichments.length, 2, "failed public batches stop automatic retries");
  assert.match(copy(h), /补全失败|未能补全/);
  search(h, "nothing");
  assert.match(copy(h), /暂未找到/);
  assert.doesNotMatch(copy(h), /全部搜索完成|已搜索全部/);
  assert.equal(h.requests.length, 0);
});

test("navigation account activation switches account and region together and rejects old metadata writes", async () => {
  const h = harness();
  const accounts = h.load("store/accounts.js");
  const saved = [{ email: "a@example.test", store: "CN" }, { email: "b@example.test", store: "US" }];
  accounts.listAccounts = () => saved;
  const activated = [];
  accounts.activateAccount = (email) => {
    activated.push(email);
    const selected = saved.find((account) => account.email === email);
    h.switchAccount(email, selected.store);
    return selected;
  };
  let menu;
  h.load("ui/common.js").menu = (value) => { menu = value; };
  h.seed("b@example.test", "US", [app("b", "B Camera")]);
  const page = h.mountTab("purchased");
  page.mount();
  await finishSnapshot(h, 0, [app("a", "A Camera")]);
  const oldCache = plain([...h.values.values()]);
  search(h, "camera");
  page.navigationButton().handler();
  assert.equal(menu.items.length, 3);
  menu.handler(menu.items[1], 1);
  assert.deepEqual(activated, ["b@example.test"]);
  assert.deepEqual(names(h), ["B Camera"]);
  assert.equal(page.navigationButton().email, "b@example.test");
  assert.equal(page.navigationButton().region, "US");
  assert.equal(h.nodes.get("purchased-search-input").text, "camera");
  h.enrichments[0].options.onApps([app("a", "Old A")], { complete: false });
  await finishEnrichment(h, 0, [app("a", "Old A")]);
  await h.runTimers();
  assert.deepEqual(names(h), ["B Camera"]);
  assert.deepEqual(plain([...h.values.values()]), oldCache);
  assert.equal(h.requests.length, 1);
});

test("incomplete responses never become an apparently complete title cache", async () => {
  const h = harness();
  h.mountTab("purchased").mount();
  await finishSnapshot(h, 0, [app("1")], 2);
  assert.match(copy(h), /不完整|读取已购记录失败/);
  assert.equal(h.values.size, 0);
  search(h, "missing");
  assert.doesNotMatch(copy(h), /没有找到匹配的 App|全部搜索完成/);
});

test("a snapshot too large for persistence remains searchable and expires an older disk snapshot", async () => {
  const h = harness();
  h.seed("a@example.test", "CN", [app("old")]);
  h.mountTab("purchased").mount();
  const pull = h.nodes.get("purchased-list").definition.events.pulled({ endRefreshing() {} });
  const records = [...apps(h.cache.MAX_APPS), app("last", "Last Camera")];
  await finishSnapshot(h, 0, records);
  await pull;
  search(h, "last camera");
  assert.deepEqual(names(h), ["Last Camera"]);
  const stored = h.cache.read("a@example.test", "CN", 1001);
  assert.equal(stored.updatedAt, 1000);
  assert.equal(stored.stale, true);
  const reopened = harness();
  reopened.values = h.values;
  reopened.mountTab("purchased").mount();
  assert.equal(reopened.requests.length, 1, "the rejected large snapshot must not revive the older cache as fresh");
});

test("the purchased search field stays outside the replaceable list and uses the width released by the navigation avatar", () => {
  for (const pushed of [false, true]) {
    const h = harness();
    if (pushed) h.load("ui/purchased.js").render();
    else h.mountTab("purchased");
    const list = h.nodes.get("purchased-list");
    const header = h.nodes.get("purchased-header");
    const avatar = h.nodes.get("purchased-account-avatar");
    const field = h.nodes.get("purchased-search-field");
    assert.ok(header && field);
    assert.equal(avatar, undefined);
    assert.ok(header.super === list.super);
    assert.equal(typeof h.load("ui/purchased.js").navigationButton().handler, "function");
    if (pushed) {
      assert.equal(h.pages.at(-1).props.navBarHidden, true);
      assert.ok(flatten(h.pages.at(-1)).some(view => view.type === "button" && view.props.accessibilityLabel === "切换已购账号"));
    }
    const values = new Map();
    const chain = (path = []) => new Proxy({}, { get: (_target, key) => {
      if (["equalTo", "inset"].includes(key)) return (value) => { for (const name of path) values.set(name, value); return chain(path); };
      return chain([...path, key]);
    } });
    field.definition.layout(chain(), { super: {} });
    for (const width of [320, 375, 430]) {
      const left = values.get("left");
      const right = width - values.get("right");
      assert.equal(left, 16);
      assert.equal(right, width - 16);
      assert.equal(right - left, width - 32);
    }
  }
});
