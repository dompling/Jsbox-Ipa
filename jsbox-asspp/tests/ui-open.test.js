const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deferred, flatten: flattenUI, pageViews } = require("./helpers/ui");
const { createCancellation, DownloadCancelledError } = require("../scripts/lib/cancellation");

function setup(t) {
  const files = new Map();
  const nodes = new Map();
  const prefs = new Map([["jasspp.region", "CN"]]);
  const screens = [];
  const menus = [];
  const alerts = [];
  global.$color = (value) => `color:${JSON.stringify(value)}`;
  global.$font = (...args) => `font:${args.join(":")}`;
  global.$align = { left: 0, center: 1, right: 2 };
  global.$size = (width, height) => ({ width, height });
  global.$insets = (top, left, bottom, right) => ({ top, left, bottom, right });
  global.$layout = { fill: { __fill: true } };
  global.$alertActionType = { destructive: 1 };
  global.$kbType = { search: 1 };
  global.$data = ({ string }) => ({ string });
  global.$ = (id) => nodes.get(id) || null;
  global.$prefs = { get: (key) => prefs.get(key), set: (key, value) => { prefs.set(key, value); return true; } };
  global.$file = {
    exists: (path) => path === "downloads" || files.has(path),
    isDirectory: (path) => path === "downloads",
    list: (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    read: (path) => files.get(path),
    write: ({ path, data }) => { files.set(path, data); return true; },
    move: ({ src, dst }) => { files.set(dst, files.get(src)); files.delete(src); return true; },
    delete: (path) => files.delete(path),
  };
  global.$ui = {
    get: global.$,
    push: (screen) => screens.push(screen),
    render: (screen) => screens.push(screen),
    menu: (menu) => menus.push(menu),
    alert: (alert) => alerts.push(alert),
    toast: () => {},
    loading: () => {},
  };
  for (const module of ["store/library", "ui/common", "ui/downloads", "ui/detail", "ui/home", "ui/search", "ui/chart", "ui/shell"]) {
    delete require.cache[require.resolve(`../scripts/${module}`)];
  }
  const library = require("../scripts/store/library");
  const common = require("../scripts/ui/common");
  const detail = require("../scripts/ui/detail");
  const downloads = require("../scripts/ui/downloads");
  const downloader = require("../scripts/services/downloader");
  const accounts = require("../scripts/store/accounts");
  const storeApi = require("../scripts/apple/store");
  const installer = require("../scripts/ui/install");
  const noAuth = t.mock.method(accounts, "requireAccountForRegion", () => { throw new Error("unexpected Apple authentication"); });
  const noDownload = t.mock.method(downloader, "downloadLatest", () => { throw new Error("unexpected download"); });
  const shared = t.mock.method(installer, "share", () => {});
  t.mock.method(installer, "downloadComplete", () => {});

  function save(extra) {
    return library.save({ bytes: [1] }, {
      name: "Demo", title: "Demo", appId: "42", bundleId: "com.example.demo", version: "1.0", ...extra,
    });
  }
  function mountPill(definition) {
    const all = flatten(definition);
    const button = all.find((view) => view.type === "button" && /^download-action-/.test(view.props.id || ""));
    assert.ok(button, "expected an action button");
    const progress = all.find((view) => view.type === "canvas");
    const spinner = all.find((view) => view.type === "spinner");
    const children = new Map(all.filter(view => view.props && view.props.id).map(view => [view.props.id, { ...view.props }]));
    const progressView = children.get(progress.props.id);
    const sender = {
      ...button.props,
      super: { get: (id) => children.get(id) || null },
    };
    if (button.props.id) nodes.set(button.props.id, sender);
    if (button.events.ready) button.events.ready(sender);
    return { button, sender, progress: progressView, spinner: children.get(spinner.props.id) };
  }
  function mountDetail(page = screens.at(-1), options = {}) {
    const definition = pageViews(page)[0];
    let header = definition.props.header;
    let pill = mountPill(header);
    const list = {};
    Object.defineProperty(list, "header", {
      get: () => header,
      set: value => {
        header = value;
        // Exercise both synchronous replacement and a native header that stays
        // visible until a later layout. Assigning a definition is not a tap.
        if (!options.deferHeader) {
          nodes.delete(pill.sender.id);
          pill = mountPill(value);
        }
      },
    });
    nodes.set(definition.props.id, list);
    return { page, list, get pill() { return pill; } };
  }
  return { files, nodes, screens, menus, alerts, library, common, detail, downloads, downloader, accounts, storeApi, shared, noAuth, noDownload, save, mountPill, mountDetail };
}

function flatten(definition) {
  return flattenUI(definition);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const app = { id: "42", bundleID: "com.example.demo", name: "Demo", version: "1.0", price: 0 };

// Records declared constraints only; this does not simulate UIKit text layout.
function constraints(definition, width = 320) {
  const values = {};
  function chain(properties) {
    return new Proxy({}, {
      get: (_target, method) => {
        if (["equalTo", "inset", "greaterThanOrEqualTo", "lessThanOrEqualTo"].includes(method)) {
          return (value) => {
            for (const property of properties) {
              const record = values[property] || (values[property] = {});
              record[method] = value;
            }
            return chain(properties);
          };
        }
        return chain(properties.concat(method));
      },
    });
  }
  if (typeof definition.layout === "function") definition.layout(chain([]), { super: { width, height: 200 } });
  return values;
}

test("product detail preserves responsive information and full description while retaining its Get header", async (t) => {
  const h = setup(t);
  const product = {
    ...app,
    sellerName: "An International Developer With A Very Long Company Name 有限公司",
    genres: ["Photo & Video", "Productivity and Creative Tools"],
    description: "A long introduction that must use the available card width.\n\n" + "内容完整换行，不能裁剪。".repeat(30),
    releaseDate: "2025-06-01T12:00:00", fileSizeBytes: 12345678,
    minimumOsVersion: "15.0", averageUserRating: 4.7, userRatingCount: 312,
  };
  t.mock.method(h.storeApi, "lookupByIds", async () => [product]);
  h.detail.show({ ...app }, "CN");
  await flush();
  const page = h.screens.at(-1);
  const list = pageViews(page)[0];
  assert.equal(list.type, "list");
  assert.ok(list.props.header, "Get must stay in the retained list header");
  assert.equal(list.props.template, undefined, "full static module cells must not use a data template");
  assert.equal(list.props.style, 0);
  assert.equal(list.props.separatorHidden, true);
  assert.notEqual(list.props.autoRowHeight, true);
  assert.equal(typeof list.events.rowHeight, "function");
  assert.equal(list.props.bgcolor, 'color:"systemBackground"');
  assert.equal(list.props.sectionTitleHeight, 0);
  assert.ok(list.props.data.every(section => !section.title), "custom headings have no duplicate system titles");
  const informationViews = flattenUI(list);
  assert.equal(informationViews.some(view => view.type === "stack"), false);
  for (const text of [product.sellerName, product.genres.join(" / ")]) {
    const label = informationViews.find((view) => view.type === "label" && view.props.text === text && view.props.lines === 0);
    assert.ok(label);
    assert.equal(label.props.lines, 0);
    assert.equal(label.props.textColor, h.common.colors.label);
    for (const width of [320, 375, 430]) {
      const frame = constraints(label, width - 40);
      assert.ok(frame.top && frame.bottom, "multiline values need complete vertical constraints");
      assert.equal(frame.height, undefined, "long values cannot use a fixed clipping height");
      assert.ok(width - frame.left.equalTo - frame.right.inset >= 168);
    }
  }
  const separators = list.props.data[0].rows.flatMap(row => row.views || []).filter(view => view.props && view.props.bgcolor === h.common.colors.sep);
  assert.equal(separators.length, 3);
  assert.ok(separators.every((view) => constraints(view).height.equalTo <= 0.5));
  const description = informationViews.find((view) => view.type === "label" && view.props.text === product.description);
  assert.ok(description);
  assert.equal(description.props.lines, 4);
  assert.equal(description.props.textColor, h.common.colors.label);
  const more = informationViews.find(view => view.type === "button" && view.props.accessibilityLabel === "查看完整简介");
  assert.ok(more);
  more.events.tapped({});
  assert.equal(pageViews(h.screens.at(-1))[0].props.text, product.description);
  assert.equal(pageViews(h.screens.at(-1))[0].props.editable, false);
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
});

test("detail App Store action remains reachable from its module without replacing the Get control", async (t) => {
  const h = setup(t);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  const opened = [];
  const originalApp = global.$app;
  global.$app = { openURL: (url) => opened.push(url) };
  t.after(() => { global.$app = originalApp; });
  h.detail.show({ ...app }, "CN");
  await flush();
  const mounted = h.mountDetail();
  const action = flattenUI(pageViews(mounted.page)[0]).find((view) =>
    view.type === "button" && view.props.accessibilityLabel === "打开 App Store 页面");
  assert.ok(action);
  const originalButton = mounted.pill.sender;
  await action.events.tapped({});
  mounted.page.events.appeared();
  assert.deepEqual(opened, ["https://apps.apple.com/app/id42"]);
  assert.equal(mounted.pill.sender, originalButton);
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
});

function taskControl(id) {
  const cancellation = createCancellation();
  let sealed = false;
  let subscriptions = 0;
  const control = {
    id, name: app.name,
    canCancel: () => !sealed && !cancellation.cancelled,
    cancel: () => control.canCancel() && cancellation.cancel(),
    subscribe: listener => {
      subscriptions++;
      const unsubscribe = cancellation.subscribe(listener);
      return () => { subscriptions--; unsubscribe(); };
    },
  };
  return {
    control, cancellation,
    seal: () => { sealed = true; },
    get subscriptions() { return subscriptions; },
  };
}

test("progress taps and queue cancellation share a confirmation and ignore late bytes after confirming", async t => {
  const h = setup(t);
  const pending = deferred();
  const task = taskControl("shared-task");
  t.after(() => pending.resolve(false));
  t.mock.method(h.downloader, "downloadControl", id => id === task.control.id ? task.control : null);
  let onProgress, onTask;
  const action = h.mountPill(h.common.actionPill(() => "获取", (progress, publish) => {
    onProgress = progress;
    onTask = publish;
    return pending.promise;
  }));
  const downloading = action.button.events.tapped(action.sender);
  assert.equal(typeof onTask, "function", "the action must receive its task publisher");
  onTask(task.control);
  onProgress(40, 100);
  await action.button.events.tapped(action.sender);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].title, "取消下载？");
  assert.equal(h.alerts[0].message, app.name);
  assert.equal(task.cancellation.cancelled, false, "opening confirmation cannot cancel the task");
  h.common.confirmCancelDownload(task.control.id);
  await action.button.events.tapped(action.sender);
  assert.equal(h.alerts.length, 1, "shared entry points cannot stack confirmations");
  h.alerts[0].actions.find(value => value.title === "继续下载").handler();
  onProgress(50, 100);
  assert.equal(action.sender.accessibilityValue, "50%");
  assert.equal(task.cancellation.cancelled, false);

  h.common.confirmCancelDownload(task.control.id);
  assert.equal(h.alerts.length, 2);
  h.alerts[1].actions.find(value => value.title === "取消下载").handler();
  assert.equal(task.cancellation.cancelled, true);
  assert.equal(action.sender.accessibilityValue, "正在取消");
  onProgress(99, 100);
  assert.equal(action.sender.accessibilityValue, "正在取消", "late progress must not revive a cancelled task");
  assert.equal(action.progress.info.value, 0.5);
  await action.button.events.tapped(action.sender);
  assert.equal(h.alerts.length, 2);
  pending.reject(new DownloadCancelledError());
  await downloading;
  assert.equal(action.sender.title, "获取");
  assert.equal(action.progress.hidden, true);
  assert.equal(task.subscriptions, 0);
  assert.equal(h.alerts.length, 2, "cancellation has no failure alert");
});

test("a completed attempt's confirmation and callbacks cannot affect a later download", async t => {
  const h = setup(t);
  const first = taskControl("first-task"), second = taskControl("second-task");
  const attempts = [deferred(), deferred()];
  t.after(() => attempts.forEach(value => value.resolve(false)));
  const callbacks = [];
  const action = h.mountPill(h.common.actionPill(() => "获取", (onProgress, onTask) => {
    const index = callbacks.length;
    callbacks.push({ onProgress, onTask });
    return attempts[index].promise;
  }));
  const firstRun = action.button.events.tapped(action.sender);
  assert.equal(typeof callbacks[0].onTask, "function");
  callbacks[0].onTask(first.control);
  await action.button.events.tapped(action.sender);
  const stale = h.alerts[0].actions.find(value => value.title === "取消下载");
  first.seal();
  stale.handler();
  assert.equal(first.cancellation.cancelled, false, "commit seals cancellation even while its confirmation is visible");
  attempts[0].resolve(false);
  await firstRun;

  const secondRun = action.button.events.tapped(action.sender);
  callbacks[1].onTask(second.control);
  callbacks[1].onProgress(20, 100);
  callbacks[0].onTask(first.control);
  callbacks[0].onProgress(99, 100);
  stale.handler();
  assert.equal(action.sender.accessibilityValue, "20%");
  assert.equal(second.cancellation.cancelled, false);
  assert.equal(first.subscriptions, 0);
  assert.equal(second.subscriptions, 1);
  attempts[1].resolve(false);
  await secondRun;
  assert.equal(second.subscriptions, 0);
});

test("disposing a fixed-title progress button removes its subscription and ignores late task publications", async t => {
  const h = setup(t);
  const pending = deferred();
  t.after(() => pending.resolve(false));
  const task = taskControl("disposed-task");
  let onTask;
  const definition = h.common.actionPill("获取", (_progress, publish) => {
    onTask = publish;
    return pending.promise;
  });
  const action = h.mountPill(definition);
  const downloading = action.button.events.tapped(action.sender);
  assert.equal(typeof onTask, "function");
  onTask(task.control);
  assert.equal(task.subscriptions, 1);
  h.common.releaseDownloadButtons(definition);
  assert.equal(task.subscriptions, 0);
  const previousTitle = action.sender.title;
  onTask(task.control);
  task.control.cancel();
  await action.button.events.tapped(action.sender);
  assert.equal(task.subscriptions, 0);
  assert.equal(action.sender.title, previousTitle);
  assert.equal(h.alerts.length, 0);
  pending.resolve(false);
  await downloading;
});

test("detail Get publishes its service task and resets quietly after confirmed cancellation", async t => {
  const h = setup(t);
  const pending = deferred();
  const task = taskControl("detail-task");
  t.after(() => pending.resolve(false));
  h.noAuth.mock.mockImplementation(() => ({ email: "detail@example.test", store: "CN" }));
  h.noDownload.mock.mockImplementation(() => pending.promise);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  h.detail.show({ ...app }, "CN");
  await flush();
  const screen = h.mountDetail();
  const action = screen.pill;
  const downloading = action.button.events.tapped(action.sender);
  const options = h.noDownload.mock.calls[0].arguments[2];
  assert.equal(typeof options.onTask, "function");
  options.onTask(task.control);
  options.onProgress(70, 100);
  await action.button.events.tapped(action.sender);
  h.alerts[0].actions.find(value => value.title === "取消下载").handler();
  assert.equal(task.cancellation.cancelled, true);
  pending.reject(new DownloadCancelledError());
  await downloading;
  assert.equal(action.sender.title, "获取");
  assert.equal(action.progress.hidden, true);
  assert.equal(h.alerts.length, 1, "a confirmed cancellation must not produce an error or login prompt");
});

test("Get can be cancelled while a public version lookup is still pending", async t => {
  const h = setup(t);
  const lookup = deferred();
  t.after(() => lookup.resolve([]));
  t.mock.method(h.storeApi, "lookupByIds", () => lookup.promise);
  const soft = { ...app, version: "" };
  const action = h.mountPill(h.common.actionPill(() => "获取", (onProgress, onTask) =>
    h.detail.downloadApp(soft, "CN", { onProgress, onTask })));
  const downloading = action.button.events.tapped(action.sender);
  await action.button.events.tapped(action.sender);
  assert.equal(h.alerts.length, 1);
  h.alerts[0].actions.find(value => value.title === "取消下载").handler();
  assert.equal(action.sender.accessibilityValue, "正在取消");
  lookup.resolve([{ ...app }]);
  await downloading;
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
  assert.equal(action.sender.title, "获取");
  assert.equal(action.progress.hidden, true);
  assert.equal(h.alerts.length, 1);
});

test("switching accounts during the public lookup cannot start the requested download on the new account", async t => {
  const h = setup(t);
  const lookup = deferred();
  t.after(() => lookup.resolve([]));
  let current = { email: "original@example.test", store: "CN" };
  t.mock.method(h.accounts, "accountForRegion", () => current);
  h.noAuth.mock.mockImplementation(() => current);
  h.noDownload.mock.mockImplementation(async () => null);
  t.mock.method(h.storeApi, "lookupByIds", () => lookup.promise);
  const pending = h.detail.downloadApp({ ...app, version: "" }, "CN");
  current = { email: "other@example.test", store: "CN" };
  lookup.resolve([{ ...app }]);
  await pending;
  assert.equal(h.noDownload.mock.callCount(), 0);
});

test("detail Get responds after appeared even when native header replacement is deferred", async (t) => {
  const h = setup(t);
  const pending = deferred();
  t.after(() => pending.resolve(null));
  h.noAuth.mock.mockImplementation(() => ({ email: "detail@example.test", store: "CN" }));
  h.noDownload.mock.mockImplementation(() => pending.promise);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  const toast = t.mock.method(global.$ui, "toast", () => {});
  h.detail.show({ ...app }, "CN");
  await flush();
  const screen = h.mountDetail(h.screens.at(-1), { deferHeader: true });
  const action = screen.pill;
  screen.page.events.appeared();
  const tapped = action.button.events.tapped(action.sender);
  assert.equal(h.noDownload.mock.callCount(), 1, "the visible button must still enter the download flow");
  assert.equal(action.sender.title, "", "the native spinner replaces Get immediately");
  assert.equal(action.spinner.loading, true, "the tap must give immediate feedback before the download settles");
  assert.equal(action.progress.hidden, true, "preparation cannot invent a byte percentage");
  assert.equal(h.noDownload.mock.calls[0].arguments[0].email, "detail@example.test");
  assert.equal(h.noDownload.mock.calls[0].arguments[2].region, "CN");
  assert.ok(toast.mock.calls.some(call => call.arguments[0] === "已添加到下载列表"));
  pending.resolve({ record: h.save() });
  await tapped;
  assert.equal(action.sender.title, "打开");
  assert.equal(action.progress.hidden, true);
  screen.page.events.appeared();
  await action.button.events.tapped(action.sender);
  assert.equal(h.menus.length, 1, "the same visible button opens the downloaded file menu");
  assert.equal(h.noDownload.mock.callCount(), 1);
  assert.equal(h.noAuth.mock.callCount(), 1, "Open does not require another account lookup");
});

test("detail appearances during a download retain progress and reject duplicate taps", async (t) => {
  const h = setup(t);
  const pending = deferred();
  t.after(() => pending.resolve(null));
  h.noAuth.mock.mockImplementation(() => ({ email: "detail@example.test", store: "CN" }));
  h.noDownload.mock.mockImplementation(() => pending.promise);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  h.detail.show({ ...app }, "CN");
  await flush();
  const screen = h.mountDetail();
  screen.page.events.appeared();
  const action = screen.pill;
  const tapped = action.button.events.tapped(action.sender);
  const progress = h.noDownload.mock.calls[0].arguments[2].onProgress;
  progress(30, 100);
  assert.equal(action.sender.accessibilityValue, "30%");
  for (let count = 0; count < 3; count++) screen.page.events.appeared();
  progress(70, 100);
  assert.equal(screen.pill.sender.accessibilityValue, "70%", "returning must not replace the active action with an idle Get button");
  assert.equal(screen.pill.progress.info.value, 0.7);
  assert.equal(screen.pill.sender, action.sender);
  await screen.pill.button.events.tapped(screen.pill.sender);
  assert.equal(h.noDownload.mock.callCount(), 1, "the original busy guard survives page appearances");
  pending.resolve({ record: h.save() });
  await tapped;
  assert.equal(screen.pill.sender.title, "打开");
  assert.equal(screen.pill.progress.hidden, true);
});

test("detail Get still shows account guidance after the page appears", async (t) => {
  const h = setup(t);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  h.detail.show({ ...app }, "CN");
  await flush();
  const screen = h.mountDetail(h.screens.at(-1), { deferHeader: true });
  screen.page.events.appeared();
  await screen.pill.button.events.tapped(screen.pill.sender);
  assert.equal(h.noAuth.mock.callCount(), 1);
  assert.equal(h.noDownload.mock.callCount(), 0);
  assert.equal(h.alerts.at(-1).title, "需要 Apple ID");
  assert.equal(screen.pill.sender.title, "获取");
  assert.equal(screen.pill.progress.hidden, true);
});

test("late detail lifecycle callbacks cannot revive an action after dealloc", async (t) => {
  const h = setup(t);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  h.detail.show({ ...app }, "CN");
  await flush();
  const screen = h.mountDetail();
  screen.page.events.dealloc();
  screen.page.events.appeared();
  screen.pill.button.events.ready(screen.pill.sender);
  await screen.pill.button.events.tapped(screen.pill.sender);
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
  assert.equal(h.alerts.length, 0);
});

test("paid detail actions query the license and offer an official App Store link on a missing license", async (t) => {
  const h = setup(t);
  h.noAuth.mock.mockImplementation(() => ({ store: "CN" }));
  const paid = { ...app, price: 12 };
  h.noDownload.mock.mockImplementation(async () => ({ record: { fileName: "Paid.ipa" } }));
  await h.detail.downloadApp(paid, "CN");
  assert.equal(h.noDownload.mock.callCount(), 1);
  t.mock.method(h.storeApi, "lookupByIds", async () => [paid]);
  h.detail.show(paid, "CN");
  await flush();
  const pill = h.mountPill(pageViews(h.screens.at(-1))[0].props.header);
  assert.equal(typeof pill.button.events.tapped, "function");
  const PurchaseError = require("../scripts/apple/purchase").PurchaseError;
  h.noDownload.mock.mockImplementation(async () => { throw new PurchaseError("请先在 App Store 购买", "paid_app"); });
  await pill.button.events.tapped(pill.sender);
  const alert = h.alerts.at(-1);
  const open = alert.actions.find(action => action.title === "打开 App Store");
  assert.ok(open);
  const previousApp = global.$app;
  const opened = [];
  global.$app = { openURL: url => opened.push(url) };
  t.after(() => { global.$app = previousApp; });
  open.handler();
  assert.deepEqual(opened, ["https://apps.apple.com/app/id42"]);
});

test("download-page retry keeps the failed task when its original account is unavailable", async (t) => {
  const h = setup(t);
  const queue = require("../scripts/services/queue");
  t.mock.method(h.accounts, "getAccount", () => null);
  const task = queue.begin({ app, region: "CN", accountEmail: "removed@example.invalid", externalVersionId: "111" });
  queue.fail(task.id, new Error("synthetic failure"));
  t.after(() => queue.remove(task.id));
  const retry = h.downloads.views()[0].props.data.flatMap(section => section.rows).flatMap(flatten)
    .find(view => view.type === "button" && view.props.accessibilityLabel === "下载失败，点按重试");
  assert.ok(retry);
  await retry.events.tapped();
  await flush();
  const failed = queue.snapshot().find(value => value.id === task.id);
  assert.ok(failed);
  assert.equal(failed.status, "error");
  assert.match(failed.error, /原下载账号/);
  assert.equal(h.noDownload.mock.callCount(), 0);
});

test("OTA requires verified IPA metadata while old and unknown records retain file actions", async (t) => {
  const h = setup(t);
  const installer = require("../scripts/ui/install");
  const ota = require("../scripts/services/ota");
  const install = t.mock.method(ota, "installToDevice", async () => { throw new Error("must not install unverified metadata"); });
  const legacy = h.save({ name: "Legacy", packageVerified: true, bundleVersion: "100" });
  assert.match(installer.unavailableReason(legacy), /尚未验证/);
  h.downloads.fileActions(legacy.fileName);
  assert.ok(h.menus.at(-1).items.includes("分享 IPA"));
  assert.ok(h.menus.at(-1).items.includes("OTA 安装"));
  h.menus.at(-1).handler("OTA 安装", h.menus.at(-1).items.indexOf("OTA 安装"));
  assert.match(h.alerts.at(-1).message, /尚未验证/);
  assert.equal(install.mock.callCount(), 0);
  await installer.launch(legacy);
  assert.equal(install.mock.callCount(), 0);
  const verified = h.save({ name: "Verified", packageVerified: true, metadataVerified: true, versionSource: "ipa", shortVersion: "1.0", bundleVersion: "100" });
  assert.equal(installer.unavailableReason(verified), "");
  h.downloads.fileActions(verified.fileName);
  assert.ok(h.menus.at(-1).items.some(item => item.includes("OTA")));
  assert.ok(installer.unavailableReason({ ...verified, bundleVersion: "版本号未知" }));
  assert.ok(installer.unavailableReason({ ...verified, bundleId: "bad/id" }));
});

test("latest Open reuses the exact download-record menu without an account or download", async (t) => {
  const h = setup(t);
  const wanted = h.save({ name: "Wanted", sinfInjected: true });
  h.save({ name: "Older", version: "0.9" });
  h.save({ name: "Other", appId: "43", bundleId: "com.example.other" });
  await h.detail.downloadApp({ ...app }, "CN");
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
  const opened = h.menus.at(-1);
  assert.ok(opened);
  const fileRow = h.downloads.views()[0].props.data.flatMap((section) => section.rows)
    .flatMap(flatten).find((view) => view.type === "button" && view.props.accessibilityLabel === `${wanted.title}，账号：未知，点按操作`);
  assert.ok(fileRow);
  fileRow.events.tapped();
  assert.deepEqual(opened.items, h.menus.at(-1).items);
  opened.handler("分享 IPA", opened.items.indexOf("分享 IPA"));
  assert.equal(h.shared.mock.calls[0].arguments[0].fileName, wanted.fileName);
});

test("other versions, other apps, missing files and active tasks never open as this app", async (t) => {
  const h = setup(t);
  h.save({ name: "Older", version: "0.9" });
  h.save({ name: "Other", appId: "43", bundleId: "com.example.other" });
  const missing = h.save({ name: "Missing" });
  h.files.delete(h.library.filePath(missing.fileName));
  const queue = require("../scripts/services/queue");
  const task = queue.begin({ app, region: "CN" });
  t.after(() => queue.remove(task.id));
  assert.equal(h.common.getButtonText(app), "获取");
  await h.detail.downloadApp({ ...app }, "CN");
  assert.equal(h.noAuth.mock.callCount(), 1, "normal Get still requires an account");
  assert.equal(h.noDownload.mock.callCount(), 0);
  assert.equal(h.menus.length, 0);
});

test("shared home/search/chart actions open locally, including downloaded paid apps", async (t) => {
  const h = setup(t);
  const wanted = h.save();
  for (const build of [
    (soft, actions) => h.common.appRowView(soft, "", actions),
    (soft, actions) => h.common.chartRowView(soft, 0, actions),
    (soft, actions) => h.common.editorialRowView(soft, actions),
  ]) {
    const soft = { ...app, price: 12 };
    const { button, sender, progress } = h.mountPill(build(soft, {
      onGet: (onProgress) => h.detail.downloadApp(soft, "CN", { onProgress }),
    }));
    assert.equal(sender.title, "打开");
    assert.equal(sender.accessibilityHint, "打开下载文件操作");
    await button.events.tapped(sender);
    assert.equal(sender.title, "打开");
    assert.equal(progress.hidden, true);
    const menu = h.menus.at(-1);
    menu.handler("分享 IPA", menu.items.indexOf("分享 IPA"));
    assert.equal(h.shared.mock.calls.at(-1).arguments[0].fileName, wanted.fileName);
  }
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
});

test("a successful download refreshes visible buttons and deletion restores Get", async (t) => {
  const h = setup(t);
  h.noAuth.mock.mockImplementation(() => ({ store: "CN" }));
  h.noDownload.mock.mockImplementation(async (_account, _app, options) => {
    options.onProgress(50, 100);
    return { record: h.save() };
  });
  const build = () => h.common.appRowView(app, "", {
    onGet: (onProgress) => h.detail.downloadApp(app, "CN", { onProgress }),
  });
  const first = h.mountPill(build());
  const second = h.mountPill(build());
  assert.equal(first.sender.title, "获取");
  await first.button.events.tapped(first.sender);
  assert.equal(first.sender.title, "打开");
  assert.equal(second.sender.title, "打开");
  assert.equal(first.sender.accessibilityHint, "打开下载文件操作");
  assert.equal(first.progress.hidden, true);
  assert.equal(h.noDownload.mock.callCount(), 1);

  await first.button.events.tapped(first.sender);
  const menu = h.menus.at(-1);
  menu.handler("删除", menu.items.indexOf("删除"));
  h.alerts.at(-1).actions.find((action) => action.title === "删除").handler();
  assert.equal(first.sender.title, "获取");
  assert.equal(second.sender.title, "获取");
  assert.equal(first.sender.accessibilityHint, "下载 IPA");
  assert.equal(h.noDownload.mock.callCount(), 1);
});

test("a temporarily hidden action refreshes after the same native view returns", (t) => {
  const h = setup(t);
  const pill = h.mountPill(h.common.appRowView(app, "", {
    onGet: () => h.detail.downloadApp(app, "CN"),
  }));
  h.nodes.delete(pill.sender.id);
  h.common.refreshDownloadButtons();
  const saved = h.save();
  h.nodes.set(pill.sender.id, pill.sender);
  h.common.refreshDownloadButtons();
  assert.equal(pill.sender.title, "打开");
  h.nodes.delete(pill.sender.id);
  h.library.remove(saved.fileName);
  h.common.refreshDownloadButtons();
  h.nodes.set(pill.sender.id, pill.sender);
  h.common.refreshDownloadButtons();
  assert.equal(pill.sender.title, "获取");
});

test("unknown latest versions resolve publicly before checking local downloads", async (t) => {
  const h = setup(t);
  h.save();
  const lookup = t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  const rssApp = { id: "42", name: "Demo", price: 0 };
  await h.detail.downloadApp(rssApp, "CN");
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(rssApp.version, "1.0");
  assert.equal(h.noAuth.mock.callCount(), 0);
  assert.equal(h.noDownload.mock.callCount(), 0);
  assert.equal(h.menus.length, 1);
});

test("detail header and chart refresh downloaded state when returning from a child page", async (t) => {
  const h = setup(t);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  h.detail.show({ ...app }, "CN");
  await flush();
  const detailScreen = h.screens.at(-1);
  const mounted = h.mountDetail(detailScreen);
  const action = mounted.pill;
  assert.equal(action.sender.title, "获取");
  const saved = h.save();
  detailScreen.events.appeared();
  assert.equal(action.sender.title, "打开", "update the original visible button without remounting it in the test");
  assert.equal(mounted.pill.sender, action.sender);
  h.library.remove(saved.fileName);
  detailScreen.events.appeared();
  assert.equal(action.sender.title, "获取");
  assert.equal(mounted.pill.sender, action.sender);

  t.mock.method(h.storeApi, "fetchChart", async () => [{ ...app }]);
  const chart = require("../scripts/ui/chart");
  const config = require("../scripts/config");
  chart.render("CN", config.CHART_KINDS[0]);
  const chartPage = h.screens.at(-1);
  const chartList = { data: [], reload: () => {} };
  h.nodes.set(pageViews(chartPage)[0].props.id, chartList);
  await flush();
  assert.equal(h.mountPill(chartList.data[0].rows[0]).sender.title, "获取");
  h.save();
  chartPage.events.appeared();
  assert.equal(h.mountPill(chartList.data[0].rows[0]).sender.title, "打开");
});

test("historical actions match external ids and open without renewed authorization", async (t) => {
  const h = setup(t);
  const historical = h.save({ name: "Historical", version: "0.9", externalVersionId: "8001" });
  h.save({ name: "Current", externalVersionId: "8002" });
  const owner = { email: "history@example.test", store: "CN" };
  h.noAuth.mock.mockImplementation(() => ({ ...owner }));
  t.mock.method(h.accounts, "accountForRegion", () => ({ ...owner }));
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  const list = t.mock.method(h.downloader, "listVersions", async () => ({ latest: "8002", versions: [
    { id: "8001", displayVersion: "0.9" },
    { id: "8002", displayVersion: "1.0" },
    { id: "8003", displayVersion: "0.8" },
  ] }));
  t.mock.method(h.downloader, "persistAccount", () => {});
  const versionDownload = t.mock.method(h.downloader, "downloadVersion", async () => { throw new Error("unexpected version download"); });
  h.detail.show({ ...app }, "CN");
  await flush();
  const history = flattenUI(pageViews(h.screens.at(-1))[0]).find((view) =>
    view.type === "button" && view.props.accessibilityLabel === "历史版本");
  assert.ok(history, "the module must expose a native history action");
  history.events.tapped({});
  await flush();
  const versionPage = h.screens.at(-1);
  const rows = pageViews(versionPage)[0].props.data[0].rows;
  const old = h.mountPill(rows[0]);
  const missing = h.mountPill(rows[2]);
  assert.equal(old.sender.title, "打开");
  assert.equal(missing.sender.title, "获取");
  const authCount = h.noAuth.mock.callCount();
  const listCount = list.mock.callCount();
  await old.button.events.tapped(old.sender);
  assert.equal(h.noAuth.mock.callCount(), authCount);
  assert.equal(list.mock.callCount(), listCount);
  assert.equal(versionDownload.mock.callCount(), 0);
  const menu = h.menus.at(-1);
  menu.handler("分享 IPA", menu.items.indexOf("分享 IPA"));
  assert.equal(h.shared.mock.calls.at(-1).arguments[0].fileName, historical.fileName);
  versionDownload.mock.mockImplementation(async (_account, _app, id, options) => {
    options.onProgress(1, 1);
    return { record: h.save({ name: "New history", version: "0.8", externalVersionId: id }) };
  });
  await missing.button.events.tapped(missing.sender);
  assert.equal(missing.sender.title, "打开");
  assert.equal(versionDownload.mock.calls[0].arguments[2], "8003");
  await missing.button.events.tapped(missing.sender);
  assert.equal(versionDownload.mock.callCount(), 1);
});

test("detail refreshes retain one control and destroying pushed pages releases their refreshers", async (t) => {
  const h = setup(t);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  const lookup = t.mock.method(global.$ui, "get", (id) => h.nodes.get(id) || null);
  const refreshedIds = () => {
    lookup.mock.resetCalls();
    h.common.refreshDownloadButtons();
    return lookup.mock.calls.map((call) => call.arguments[0]);
  };
  h.detail.show({ ...app }, "CN");
  await flush();
  const page = h.screens.at(-1);
  const mounted = h.mountDetail(page);
  let current = mounted.pill;
  for (let count = 0; count < 20; count += 1) {
    page.events.appeared();
  }
  assert.equal(mounted.pill.sender, current.sender, "appearing must preserve the live header's control");
  assert.deepEqual(refreshedIds(), [current.sender.id], "only the page's original live control remains registered");
  page.events.dealloc();
  current.button.events.ready(current.sender);
  assert.deepEqual(refreshedIds(), [], "a late ready event cannot revive a disposed page");

  t.mock.method(h.storeApi, "fetchChart", async () => [{ ...app }]);
  require("../scripts/ui/chart").render("CN", require("../scripts/config").CHART_KINDS[0]);
  const chart = h.screens.at(-1);
  const chartList = { data: [], reload: () => {} };
  h.nodes.set(pageViews(chart)[0].props.id, chartList);
  await flush();
  for (let count = 0; count < 20; count += 1) {
    chart.events.appeared();
    current = h.mountPill(chartList.data[0].rows[0]);
  }
  assert.deepEqual(refreshedIds(), [current.sender.id]);
  chart.events.dealloc();
  current.button.events.ready(current.sender);
  assert.deepEqual(refreshedIds(), []);
});

test("home and search list replacements retain only their current download controls", async (t) => {
  const h = setup(t);
  t.mock.method(h.storeApi, "fetchChart", async () => [{ ...app }]);
  t.mock.method(h.storeApi, "lookupByIds", async () => [{ ...app }]);
  t.mock.method(h.storeApi, "searchApps", async () => [{ ...app }]);
  const home = require("../scripts/ui/home");
  const homeList = { data: home.views()[0].props.data, reload: () => {} };
  h.nodes.set("home-list", homeList);
  home.mount();
  await flush();
  const search = require("../scripts/ui/search");
  const searchRoot = search.views()[0];
  const searchList = { data: [], reload: () => {} };
  h.nodes.set("search-list", searchList);
  h.nodes.set("search-input", { text: "Demo" });
  const input = flatten(searchRoot).find((view) => view.props.id === "search-input");
  input.events.returned({ blur: () => {} });
  await flush();
  let currentIds;
  for (let count = 0; count < 20; count += 1) {
    home.mount();
    search.mount();
    currentIds = homeList.data.map((section) => h.mountPill(section.rows[0]).sender.id);
    currentIds.push(h.mountPill(searchList.data[0].rows[0]).sender.id);
  }
  const lookup = t.mock.method(global.$ui, "get", (id) => h.nodes.get(id) || null);
  h.common.refreshDownloadButtons();
  assert.deepEqual(lookup.mock.calls.map((call) => call.arguments[0]).sort(), currentIds.sort());
});

function layoutOperations(layout) {
  const operations = [];
  const parent = {};
  const segment = (properties) => new Proxy({}, {
    get: (_target, key) => ["inset", "equalTo", "offset"].includes(key)
      ? (value) => { operations.push({ properties, method: key, value }); return segment(properties); }
      : segment([...properties, key]),
  });
  layout(segment([]), { super: parent });
  return { operations, parent };
}

function assertHomeCard(row, common) {
  assert.equal(row.props.bgcolor, global.$color("clear"));
  assert.equal(row.props.selectable, false);
  assert.equal(row.props.cornerRadius, undefined, "rounding belongs to the inner native surface");
  const { operations, parent } = layoutOperations(row.layout);
  assert.ok(operations.some((op) => op.properties.includes("edges") && op.value === parent));
  const hero = row.views.find((view) => String(view.props.id || "").startsWith("home-hero-"));
  assert.equal(row.views.length, hero ? 2 : 1);
  const surface = row.views[0];
  assert.equal(surface.props.bgcolor, common.colors.card);
  assert.equal(surface.props.cornerRadius, 16);
  assert.equal(surface.props.clipsToBounds, true);
  const inner = layoutOperations(surface.layout).operations;
  assert.ok(inner.some((op) => op.properties.includes("left") && op.properties.includes("right") && op.method === "inset" && op.value === 16));
  assert.ok(inner.some((op) => op.properties.includes("top") && op.method === "inset" && op.value === (hero ? 178 : 8)));
  assert.ok(inner.some((op) => op.properties.includes("bottom") && op.method === "inset" && op.value === 8));
  for (const content of surface.views) {
    assert.equal(content.props.bgcolor, global.$color("clear"));
    assert.equal(content.props.cornerRadius, 0);
  }
}

test("home modules group loading, Apps, retry and see-all while keeping every action separate", async (t) => {
  const h = setup(t);
  h.save();
  const config = require("../scripts/config");
  const other = { ...app, id: "43", bundleID: "com.example.other", name: "Other" };
  let offline = true;
  t.mock.method(h.storeApi, "fetchChart", async (kind) => {
    if (kind === config.CHART_KINDS[1].key && offline) throw new Error("offline");
    return [app, other];
  });
  t.mock.method(h.storeApi, "lookupByIds", async () => [app, other]);
  const viewed = t.mock.method(h.detail, "show", () => {});
  const chart = t.mock.method(require("../scripts/ui/chart"), "render", () => {});
  h.noAuth.mock.mockImplementation(() => ({ store: "CN" }));
  h.noDownload.mock.mockImplementation(async () => ({ record: { fileName: "Other.ipa" } }));
  const home = require("../scripts/ui/home");
  const list = home.views()[0];
  assert.equal(list.props.style, 0);
  assert.equal(list.props.separatorHidden, true);
  for (const section of list.props.data) {
    assert.equal(section.rows.length, 1);
    assertHomeCard(section.rows[0], h.common);
    assert.ok(flatten(section.rows[0]).some((view) => /加载中/.test(view.props.text || "")));
  }
  const liveList = { data: list.props.data, reload: () => {} };
  const loadingHeight = list.events.rowHeight(liveList, { section: 0, row: 0 });
  h.nodes.set("home-list", liveList);
  home.mount();
  await flush();
  assert.ok(list.events.rowHeight(liveList, { section: 0, row: 0 }) > loadingHeight,
    "data-only refreshes must resize the existing cell to fit all loaded Apps");
  for (const section of liveList.data) for (const row of section.rows) assertHomeCard(row, h.common);
  for (const index of [0, 2]) {
    const module = liveList.data[index].rows[0].views[0];
    assert.equal(module.views.length, 4, "header, both Apps and footer share a single card");
    for (const [appIndex, content] of module.views.slice(1, -1).entries()) {
      const expected = appIndex === 0 ? app : other;
      const hitArea = content.views.find((view) => view.type === "button" && !view.props.title);
      assert.ok(hitArea && hitArea.layout === global.$layout.fill);
      hitArea.events.tapped();
      assert.equal(viewed.mock.calls.at(-1).arguments[0].id, expected.id);
      const pill = h.mountPill(content);
      assert.equal(pill.sender.title, appIndex === 0 ? "打开" : "获取");
      await pill.button.events.tapped(pill.sender);
    }
    const footer = flatten(module.views.at(-1)).find((view) => view.type === "button");
    footer.events.tapped();
    assert.equal(chart.mock.calls.at(-1).arguments[1].key, config.CHART_KINDS[index].key);
  }
  assert.equal(viewed.mock.callCount(), 4);
  assert.equal(h.menus.length, 2, "only each exact local App opens a file menu");
  assert.equal(h.noDownload.mock.callCount(), 2);
  assert.ok(h.noDownload.mock.calls.every((call) => call.arguments[1].id === other.id));
  assert.equal(chart.mock.callCount(), 2);
  assert.ok(liveList.data[1].rows.some((row) => flatten(row).some((view) => /加载失败/.test(view.props.text || ""))));
  const retry = flatten(liveList.data[1].rows[0]).find((view) => view.type === "button");
  offline = false;
  retry.events.tapped();
  await flush();
  assert.equal(liveList.data[1].rows.length, 1);
  assert.equal(liveList.data[1].rows[0].views[0].views.length, 4);
});

test("shell launches fullscreen while preserving safe-area and system indicators", (t) => {
  const h = setup(t);
  const mounts = [];
  for (const name of ["home", "purchased", "downloads", "search", "settings"]) {
    const page = require(`../scripts/ui/${name}`);
    t.mock.method(page, "views", () => []);
    t.mock.method(page, "mount", () => mounts.push(name));
  }
  const shell = require("../scripts/ui/shell");
  shell.launch();
  const root = h.screens.at(-1);
  assert.equal(root.props.fullScreen, true);
  assert.equal(root.props.clipsToSafeArea, false);
  assert.equal(root.props.homeIndicatorHidden, false);
  assert.notEqual(root.props.statusBarHidden, true);
  root.events.appeared();
  assert.deepEqual(mounts, ["home", "home"], "returning to the shell refreshes the active tab");
  const retired = h.mountPill(h.common.appRowView(app, "", { onGet: () => true }));
  root.events.dealloc();
  retired.button.events.ready(retired.sender);
  const lookup = t.mock.method(global.$ui, "get", (id) => h.nodes.get(id) || null);
  h.common.refreshDownloadButtons();
  assert.equal(lookup.mock.callCount(), 0, "root disposal clears all remaining refresh callbacks");
  const bar = shell.tabBarView();
  assert.match(String(bar.layout), /safeArea/);
});
