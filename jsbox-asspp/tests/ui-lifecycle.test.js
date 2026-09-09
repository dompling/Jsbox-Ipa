const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, flatten, flush, deferred, pageViews } = require("./helpers/ui");

const app = (id) => ({ id, name: id, owned: true, price: 0 });
const purchasedApps = (owner, count = 41) => Array.from({ length: count }, (_value, index) => app(`app-${owner}${index + 1}`));
const listRows = (h) => h.nodes.get("purchased-list").definition.props.data[0].rows;
const names = (h) => Array.from(listRows(h)).flatMap(flatten)
  .filter((view) => view.type === "label" && /^app-/.test(view.props.text || ""))
  .map((view) => view.props.text);
function more(h) {
  const list = h.nodes.get("purchased-list");
  return list.definition.events.didReachBottom(list);
}
async function complete(h, request, apps, totalCount = apps.length) {
  h.requests[request].resolve({ apps: apps.slice(0, 20), allApps: apps, totalCount });
  await flush();
}
function purchasedSetup() {
  const h = setup();
  h.enrichments = [];
  h.load("apple/purchases.js").enrichApps = (apps, region, options) => {
    const pending = deferred();
    h.enrichments.push({ apps, region, options, ...pending });
    return pending.promise;
  };
  return h;
}
async function enriched(h, index, apps) {
  h.enrichments[index].resolve(apps || h.enrichments[index].apps);
  await flush();
}

test("purchased return retains loaded pages, scroll position and live Open state", async () => {
  const h = purchasedSetup();
  const page = h.mountTab("purchased");
  page.mount();
  const apps = purchasedApps("a");
  await complete(h, 0, apps);
  await enriched(h, 0);
  h.nodes.get("purchased-list").contentOffset = { x: 0, y: 460 };
  const next = more(h);
  await enriched(h, 1);
  await next;
  const list = h.nodes.get("purchased-list");
  assert.equal(list.contentOffset.y, 460, "appending a page keeps the viewport");
  h.downloaded.add("app-a1");
  page.mount();
  assert.equal(h.requests.length, 1, "scrolling and returning must not reload the purchase snapshot");
  assert.ok(h.nodes.get("purchased-list") === list, "unchanged data keeps the native list");
  assert.deepEqual(names(h), apps.slice(0, 40).map((item) => item.name));
  assert.equal(h.refreshedIds().length, 40);
  const title = flatten(list.definition.props.data[0].rows[0]).find((view) => view.props.id && view.props.id.startsWith("download-action-"));
  assert.equal(h.nodes.get(title.props.id).title, "打开");
  h.downloaded.clear();
  page.mount();
  assert.equal(h.nodes.get(title.props.id).title, "获取");
});

for (const outcome of ["success", "error"]) {
  test(`old purchased metadata ${outcome} cannot change a new account or its pending batch`, async () => {
    const h = purchasedSetup();
    const page = h.mountTab("purchased");
    page.mount();
    await complete(h, 0, purchasedApps("a"));
    await enriched(h, 0);
    const oldNext = more(h);
    h.switchAccount("b@example.test", "US");
    page.mount();
    const apps = purchasedApps("b");
    await complete(h, 1, apps);
    await enriched(h, 2);
    const newNext = more(h);
    if (outcome === "error") h.enrichments[1].reject(new Error("old account failed"));
    else h.enrichments[1].resolve([app("app-a21")]);
    await flush();
    await oldNext;
    assert.deepEqual(names(h), apps.slice(0, 40).map((item) => item.name));
    assert.equal(h.toasts.length, 0, "old errors stay with the old generation");
    assert.equal(h.enrichments.length, 4, "old completion cannot release the new account's lookup lock");
    await enriched(h, 3);
    await newNext;
    more(h);
    assert.deepEqual(Array.from(h.enrichments.at(-1).apps, (item) => item.id), ["app-b41"]);
    assert.equal(h.enrichments.at(-1).region, "US");
    assert.equal(h.requests.at(-1).owner.email, "b@example.test");
    assert.equal(h.requests.length, 2);
  });
}

test("purchased callbacks stop when the account changes before remount", async () => {
  const h = purchasedSetup();
  const page = h.mountTab("purchased");
  page.mount();
  h.switchAccount("b@example.test");
  h.requests[0].options.onProgress({ title: "old account progress", message: "must stay hidden" });
  await complete(h, 0, [app("app-a2")]);
  assert.deepEqual(names(h), []);
  page.mount();
  assert.equal(h.requests.length, 2);
});

test("purchased metadata callbacks stop when the account changes before remount", async () => {
  const h = purchasedSetup();
  const page = h.mountTab("purchased");
  page.mount();
  await complete(h, 0, [app("app-a1")]);
  const list = h.nodes.get("purchased-list");
  h.switchAccount("b@example.test");
  h.enrichments[0].options.onApps([{ ...app("app-a1"), name: "app-old-name" }]);
  await enriched(h, 0, [{ ...app("app-a1"), name: "app-old-name" }]);
  assert.ok(h.nodes.get("purchased-list") === list);
  assert.deepEqual(names(h), ["app-a1"]);
  page.mount();
  assert.equal(h.requests.length, 2);
});

test("an explicit purchased refresh invalidates an older request for the same account", async () => {
  const h = purchasedSetup();
  const page = h.mountTab("purchased");
  page.mount();
  let ended = 0;
  const refresh = h.nodes.get("purchased-list").definition.events.pulled({ endRefreshing: () => ended++ });
  await complete(h, 0, [app("app-old")]);
  assert.deepEqual(names(h), []);
  await complete(h, 1, [app("app-current")]);
  await refresh;
  assert.deepEqual(names(h), ["app-current"]);
  assert.equal(ended, 1);
  assert.equal(h.refreshedIds().length, 1);
});

test("purchased results received while covered survive return without another request", async () => {
  const h = purchasedSetup();
  const page = h.mountTab("purchased");
  page.mount();
  const list = h.nodes.get("purchased-list");
  h.nodes.delete("purchased-list");
  await complete(h, 0, [app("app-late")]);
  h.nodes.set("purchased-list", list);
  page.mount();
  assert.deepEqual(names(h), ["app-late"]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.refreshedIds().length, 1);
});

test("a pushed purchased page reloads when account management changes the active account", async () => {
  const h = purchasedSetup();
  h.load("ui/purchased.js").render();
  await complete(h, 0, [app("app-a1")]);
  h.switchAccount("b@example.test", "US");
  h.pages.at(-1).events.appeared();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].owner.email, "b@example.test");
});

test("purchased metadata retains actions while filtering and dealloc release retired actions", async () => {
  const h = purchasedSetup();
  const page = h.load("ui/purchased.js");
  page.render();
  const pushed = h.pages.at(-1);
  await complete(h, 0, [app("app-a1"), app("app-a2")]);
  const originalList = h.nodes.get("purchased-list");
  let retired;
  for (let index = 0; index < 8; index++) {
    h.enrichments[0].options.onApps([app("app-a1"), app("app-a2")], { complete: false });
    const current = listRows(h).flatMap(flatten).filter((view) => view.props.id && view.props.id.startsWith("download-action-"));
    assert.equal(h.refreshedIds().length, 2, "only the current batch owns refresh callbacks");
    assert.ok(h.nodes.get("purchased-list") === originalList, "metadata preserves the live native rows");
    if (!retired) retired = current[0];
  }
  const input = h.nodes.get("purchased-search-input");
  input.text = "app-a2";
  input.definition.events.changed(input);
  await retired.events.tapped({});
  assert.equal(h.downloads.length, 0, "a removed action cannot start another download");
  pushed.events.dealloc();
  await enriched(h, 0, [app("app-a3")]);
  assert.deepEqual(h.refreshedIds(), []);
});

test("home, search and chart return without replacing unchanged lists", async () => {
  const h = setup();
  const home = h.mountTab("home");
  home.mount();
  await flush();
  const homeList = h.nodes.get("home-list");
  homeList.contentOffset.y = 280;
  home.mount();
  assert.ok(h.nodes.get("home-list") === homeList, "home keeps its list on return");
  assert.equal(homeList.contentOffset.y, 280);

  const search = h.mountTab("search");
  const input = h.nodes.get("search-input");
  input.text = "Demo";
  input.definition.events.returned(input);
  await flush();
  const searchList = h.nodes.get("search-list");
  searchList.contentOffset.y = 360;
  search.mount();
  assert.ok(h.nodes.get("search-list") === searchList, "search keeps its list on return");
  assert.equal(searchList.contentOffset.y, 360);

  h.load("ui/chart.js").render("CN", h.config.CHART_KINDS[0]);
  await flush();
  const chart = h.pages.at(-1);
  const chartList = h.nodes.get(pageViews(chart)[0].props.id);
  chartList.contentOffset.y = 540;
  chart.events.appeared();
  assert.ok(h.nodes.get(chartList.id) === chartList, "chart keeps its list on return");
  assert.equal(chartList.contentOffset.y, 540);
});

test("chart results received while covered are applied when the page returns", async () => {
  const h = setup();
  const pending = deferred();
  h.store.fetchChart = () => pending.promise;
  h.load("ui/chart.js").render("CN", h.config.CHART_KINDS[0]);
  const page = h.pages.at(-1);
  const id = pageViews(page)[0].props.id;
  const list = h.nodes.get(id);
  h.nodes.delete(id);
  pending.resolve([app("app-late")]);
  await flush();
  h.nodes.set(id, list);
  page.events.appeared();
  const texts = h.nodes.get(id).definition.props.data.flatMap((section) => section.rows).flatMap(flatten).map((view) => view.props.text);
  assert.ok(texts.includes("App app-late"));
  assert.equal(h.refreshedIds().length, 1);
});

test("rapid tab changes leave only the most recent screen visible", () => {
  const h = setup();
  const shell = h.load("ui/shell.js");
  shell.launch();
  shell.switchTab(1);
  shell.switchTab(0);
  for (let index = 0; index < h.animations.length; index++) {
    const completion = h.animations[index].completion;
    if (completion) completion();
  }
  assert.equal(shell.currentTabIndex(), 0);
  const visible = shell.TABS.filter((tab) => !h.nodes.get(`screen-${tab.key}`).hidden).map((tab) => tab.key);
  assert.deepEqual(Array.from(visible), ["home"]);
  assert.equal(h.nodes.get("screen-home").alpha, 1);
});
