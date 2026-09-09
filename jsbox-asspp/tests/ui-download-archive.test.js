const { test } = require("node:test");
const assert = require("node:assert/strict");
const { flatten } = require("./helpers/ui");

const flush = () => new Promise(resolve => setImmediate(resolve));
const findButton = (definition, label) => flatten(definition).find(view =>
  view.type === "button" && view.props.accessibilityLabel === label);
const labels = definition => flatten(definition).filter(view => view.type === "label").map(view => view.props.text);

test("downloaded and archived cards show their saved account independently of license metadata", t => {
  const files = [
    { fileName: "Ready.ipa", title: "Demo（已注入SINF）", sinfInjected: true, accountEmail: "first@example.invalid", version: "1.2", bundleId: "com.example.demo" },
    { fileName: "Original.ipa", title: "Demo", sinfInjected: false, accountEmail: "second@example.invalid", version: "1.2" },
    { fileName: "Imported.ipa", title: "Imported", sinfInjected: false },
  ];
  const h = setup(t, files);
  const ready = h.main().data.find(section => /^已下载/.test(section.title)).rows[0];
  const readyLabels = labels(ready);
  assert.ok(readyLabels.includes("Demo"));
  assert.ok(!readyLabels.some(text => /已注入/.test(text)), "the main list should show ordinary app information");
  assert.ok(readyLabels.includes("账号：first@example.invalid"));
  assert.ok(readyLabels.some(text => text.includes("com.example.demo") && text.includes("1.2")));
  h.openArchive();
  const archived = h.nativeTexts(h.archive());
  assert.ok(archived.includes("账号：second@example.invalid"));
  assert.ok(archived.includes("账号：未知"));
  assert.ok(!archived.includes("账号：first@example.invalid"));
});

test("download account labels keep their own space below long app information on narrow screens", t => {
  const task = { id: "account-task", app: { name: "Download" }, status: "downloading", message: "Downloading", progress: 0.5, accountEmail: "long-download-account@example.invalid" };
  const h = setup(t, [{ fileName: "Ready.ipa", title: "Long App", sinfInjected: true, version: "1.0", bundleId: "com.example.long.application", accountEmail: "saved@example.invalid" }], [task]);
  for (const width of [320, 390, 768]) {
    global.$device.info.screen.width = width;
    const list = h.downloads.views()[0];
    for (const [section, block] of list.props.data.entries()) {
      if (!/^(已下载|正在下载)/.test(block.title)) continue;
      for (const [row, definition] of block.rows.entries()) {
        const views = flatten(definition);
        const subtitle = views.find(view => view.props && view.props.id === "dl-subtitle");
        const owner = views.find(view => view.props && view.props.id === "dl-account");
        assert.ok(owner, "account is not appended to an already truncated subtitle");
        const metaFrame = layoutValues(subtitle), ownerFrame = layoutValues(owner);
        assert.ok(ownerFrame.top >= metaFrame.top + metaFrame.height);
        assert.ok(ownerFrame.right >= 58, "reserve the separate trailing cancel/delete hit area");
        assert.ok(list.events.rowHeight(null, { section, row }) >= ownerFrame.top + ownerFrame.height + 8);
        assert.ok(owner.props.lines >= 1 && owner.props.lines <= 2);
      }
    }
  }
});

test("task progress and failure updates retain the original account label", t => {
  const task = { id: "owner-progress", app: { name: "Demo" }, status: "downloading", message: "Downloading", progress: 0.1, accountEmail: "original@example.invalid" };
  const h = setup(t, [], [task]);
  const before = h.main();
  assert.ok(h.nativeTexts(before).includes("账号：original@example.invalid"));
  h.tasks[0].progress = 0.6;
  h.notify();
  assert.equal(h.main(), before, "progress remains an in-place update");
  assert.ok(h.nativeTexts(h.main()).includes("账号：original@example.invalid"));
  h.tasks[0].status = "error";
  h.tasks[0].error = "Synthetic error";
  h.notify();
  assert.ok(h.nativeTexts(h.main()).includes("账号：original@example.invalid"));
  assert.ok(h.main().data.some(section => /^下载失败/.test(section.title)));
});

function layoutValues(definition) {
  const values = {};
  const chain = (properties = []) => new Proxy({}, {
    get: (_target, key) => ["equalTo", "inset", "offset", "lessThanOrEqualTo"].includes(key)
      ? value => { for (const property of properties) values[property] = value; return chain(properties); }
      : chain(properties.concat(key)),
  });
  definition.layout(chain(), { super: {} });
  return values;
}

function setup(t, initialFiles = [], initialTasks = []) {
  const globalNames = ["$", "$ui", "$color", "$font", "$align", "$size", "$point", "$insets", "$indexPath", "$layout", "$device", "$text"];
  const previous = new Map(globalNames.map(name => [name, global[name]]));
  t.after(() => previous.forEach((value, name) => { global[name] = value; }));
  global.$color = value => `color:${JSON.stringify(value)}`;
  global.$font = (...args) => args;
  global.$align = { left: 0, center: 1, right: 2 };
  global.$size = (width, height) => ({ width, height });
  global.$point = (x, y) => ({ x, y });
  global.$insets = (top, left, bottom, right) => ({ top, left, bottom, right });
  global.$indexPath = (section, row) => ({ section, row });
  global.$layout = { fill: { fill: true } };
  global.$device = { info: { screen: { width: 390 } } };
  global.$text = undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const files = initialFiles.slice(), tasks = initialTasks.slice();
  const menus = [], alerts = [], shares = [], removedFiles = [], removedTasks = [], cancellations = [], pages = [], loading = [];
  const roots = [], subscribers = [];
  const common = require("../scripts/ui/common");
  const library = require("../scripts/store/library");
  const queue = require("../scripts/services/queue");
  const installer = require("../scripts/ui/install");
  const injector = require("../scripts/services/ipa-injector");
  t.mock.method(library, "listFiles", () => files.map(file => ({ ...file })));
  t.mock.method(library, "iconData", () => null);
  t.mock.method(library, "remove", name => {
    removedFiles.push(name);
    const index = files.findIndex(file => file.fileName === name);
    if (index >= 0) files.splice(index, 1);
  });
  t.mock.method(queue, "snapshot", () => tasks.map(task => ({ ...task, app: { ...task.app } })));
  t.mock.method(queue, "subscribe", listener => { subscribers.push(listener); return () => {}; });
  t.mock.method(queue, "remove", id => {
    removedTasks.push(id);
    const index = tasks.findIndex(task => task.id === id);
    if (index >= 0) tasks.splice(index, 1);
  });
  t.mock.method(common, "refreshDownloadButtons", () => {});
  const previousConfirm = common.confirmCancelDownload;
  common.confirmCancelDownload = async id => { cancellations.push(id); return false; };
  t.after(() => {
    if (previousConfirm) common.confirmCancelDownload = previousConfirm;
    else delete common.confirmCancelDownload;
  });
  t.mock.method(installer, "unavailableReason", () => "unavailable in offline UI test");
  t.mock.method(installer, "share", item => shares.push(item.fileName));
  t.mock.method(injector, "canRezip", () => true);
  t.mock.method(injector, "injectAndSave", async item => {
    const record = { ...item, fileName: "Injected.ipa", title: "Injected", sinfInjected: true };
    files.unshift(record);
    return { record };
  });

  function descendants(node) {
    return [node, ...node.children.flatMap(descendants)];
  }
  function remove(node) {
    if (node.super) node.super.children = node.super.children.filter(child => child !== node);
  }
  function mount(definition, parent) {
    const node = {
      ...definition.props, definition, super: parent, children: [], cells: [],
      contentOffset: { x: 0, y: 0, ...(definition.props && definition.props.contentOffset) },
      add: next => mount(next, node), remove: () => remove(node), reload() {},
      get: id => descendants(node).find(child => child.id === id) || null,
      cell: index => node.cells[index.section] && node.cells[index.section][index.row],
    };
    if (parent) parent.children.push(node);
    for (const child of definition.views || []) mount(child, node);
    // Static rows materialize on creation only; assigning .data cannot stand in for a native mount.
    for (const section of definition.props && definition.props.data || []) {
      node.cells.push((section.rows || []).map(row => mount(row, node)));
    }
    if (definition.events && definition.events.ready) definition.events.ready(node);
    if (definition.events && definition.events.layoutSubviews) definition.events.layoutSubviews(node);
    return node;
  }
  global.$ = id => roots.length ? descendants(roots.at(-1)).find(node => node.id === id) || null : null;
  global.$ui = {
    push: page => {
      pages.push(page);
      roots.push(mount({ props: page.props, views: page.views }));
      if (page.events && page.events.appeared) page.events.appeared();
    },
    menu: options => menus.push(options), alert: options => alerts.push(options), loading: value => loading.push(value), toast() {},
  };
  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const mainRoot = mount({ props: {}, views: downloads.views() });
  roots.push(mainRoot);
  downloads.mount();
  const main = () => descendants(mainRoot).find(node => node.id === "download-list");
  return {
    files, tasks, menus, alerts, shares, removedFiles, removedTasks, cancellations, pages, loading, common, downloads, main,
    nativeTexts: node => descendants(node).filter(child => child.definition.type === "label").map(child => child.text),
    notify: () => { subscribers.forEach(listener => listener()); t.mock.timers.tick(300); },
    archive: () => descendants(roots.at(-1)).find(node => node.definition.type === "list"),
    cover: () => roots.push(mount({ props: {}, views: [] })),
    uncover: () => { roots.pop(); pages.at(-1).events.appeared(); },
    openArchive: () => {
      const button = flatten(main().definition).find(view => view.type === "button" && /^归档/.test(view.props.accessibilityLabel));
      assert.ok(button, "download page must expose an archive entry");
      button.events.tapped();
    },
    pop: () => {
      const page = pages.at(-1);
      if (page.events && page.events.dealloc) page.events.dealloc();
      roots.pop();
      downloads.mount();
    },
  };
}

const activeTask = (extra = {}) => ({
  id: "task-1", app: { name: "Demo", id: "42" }, status: "downloading", message: "12 MB / 24 MB", progress: 0.5, cancellable: true, ...extra,
});
const file = (name, extra = {}) => ({ fileName: `${name}.ipa`, title: name, bundleId: "com.example.demo", version: "1.0", ...extra });

test("download tasks expose a compact cancel target that delegates to the shared confirmation", async t => {
  const h = setup(t, [], [activeTask()]);
  for (const width of [320, 390, 768]) {
    global.$device.info.screen.width = width;
    const definition = h.downloads.views()[0];
    const cancel = findButton(definition, "取消下载");
    assert.ok(cancel, "active task needs a visible cancel control");
    assert.ok(flatten(cancel).some(view => view.props && view.props.symbol === "xmark.circle"));
    assert.deepEqual(layoutValues(cancel).size, { width: 44, height: 44 });
    assert.ok(!findButton(definition, "下载失败，点按重试"));
  }
  const cancel = findButton(h.main().definition, "取消下载");
  await cancel.events.tapped();
  assert.deepEqual(h.cancellations, ["task-1"]);
  assert.deepEqual(h.removedTasks, [], "requesting confirmation must not discard the task");
  assert.deepEqual(h.removedFiles, []);
});

test("cancelling and final save stages stop offering cancellation", t => {
  const task = activeTask();
  const h = setup(t, [], [task]);
  task.cancellable = false;
  task.message = "正在保存";
  h.notify();
  assert.ok(!findButton(h.main().definition, "取消下载"), "cancellable alone is a structural change");
  task.status = "cancelling";
  task.message = "old progress message";
  h.notify();
  assert.ok(h.nativeTexts(h.main()).some(text => /正在取消/.test(text)));
  assert.ok(!findButton(h.main().definition, "取消下载"));
  assert.ok(!findButton(h.main().definition, "删除失败任务"));
});

test("failed-task deletion has a separate hit area, preserves IPA files, and ignores stale actions", async t => {
  const task = activeTask({ status: "error", error: "连接中断", progress: 0 });
  const h = setup(t, [file("Existing", { sinfInjected: true })], [task]);
  const retried = t.mock.method(h.common, "openDownloaded", () => { throw new Error("delete must not retry"); });
  const definition = h.main().definition;
  const remove = findButton(definition, "删除失败任务");
  const retry = findButton(definition, "下载失败，点按重试");
  assert.ok(remove && retry);
  const deleteLayout = layoutValues(remove);
  assert.deepEqual(deleteLayout.size, { width: 44, height: 44 });
  assert.ok(layoutValues(retry).right >= deleteLayout.right + 44, "retry target must stop before the delete target");
  task.status = "downloading";
  await remove.events.tapped();
  assert.equal(h.tasks.length, 1, "a stale delete button cannot remove a running task");
  task.status = "error";
  await remove.events.tapped();
  assert.equal(h.tasks.length, 0);
  assert.equal(retried.mock.callCount(), 0);
  assert.deepEqual(h.removedFiles, []);
  assert.equal(h.files[0].fileName, "Existing.ipa");
});

test("active and failed counts follow live status while progress updates preserve the native list", t => {
  const first = activeTask(), second = activeTask({ id: "failed", status: "error", error: "无可用项目", progress: 0 });
  const h = setup(t, [], [first, second]);
  const nativeList = h.main();
  nativeList.contentOffset = { x: 0, y: 120 };
  assert.ok(nativeList.definition.props.data.some(section => section.title === "正在下载 1 个 App"));
  assert.ok(nativeList.definition.props.data.some(section => section.title === "下载失败 1 个 App"));
  first.progress = 0.6;
  h.notify();
  assert.equal(h.main(), nativeList);
  assert.ok(h.nativeTexts(h.main()).includes("60%"));
  first.status = "error";
  first.error = "请求失败";
  h.notify();
  assert.notEqual(h.main(), nativeList);
  assert.deepEqual(h.main().contentOffset, { x: 0, y: 120 });
  assert.ok(!h.main().definition.props.data.some(section => /正在下载/.test(section.title)));
  assert.ok(h.main().definition.props.data.some(section => section.title === "下载失败 2 个 App"));
  assert.equal(flatten(h.main().definition).filter(view => view.type === "button" && view.props.accessibilityLabel === "删除失败任务").length, 2);
});

test("retry leaves task controls available throughout the new download", async t => {
  const task = activeTask({ status: "error", error: "请求失败" });
  const h = setup(t, [], [task]);
  t.mock.method(h.common, "openDownloaded", () => false);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(() => finish(null));
  t.mock.method(require("../scripts/services/downloader"), "retryDownload", () => {
    task.status = "downloading";
    return pending;
  });
  const retry = findButton(h.main().definition, "下载失败，点按重试");
  const attempt = retry.events.tapped();
  assert.ok(!h.loading.includes(true), "retry must not block cancellation behind a global loading overlay");
  h.notify();
  const cancel = findButton(h.main().definition, "取消下载");
  assert.ok(cancel);
  await cancel.events.tapped();
  assert.deepEqual(h.cancellations, [task.id]);
  finish(null);
  await attempt;
});

test("cancelling a retry stays silent and never opens download completion", async t => {
  const h = setup(t, [], [activeTask({ status: "error", error: "请求失败" })]);
  t.mock.method(h.common, "openDownloaded", () => false);
  const complete = t.mock.method(require("../scripts/ui/install"), "downloadComplete", () => {});
  t.mock.method(require("../scripts/services/downloader"), "retryDownload", async () => {
    throw Object.assign(new Error("下载已取消"), { code: "download_cancelled" });
  });
  const retry = findButton(h.main().definition, "下载失败，点按重试");
  await retry.events.tapped();
  assert.deepEqual(h.alerts, []);
  assert.equal(complete.mock.callCount(), 0);
});

test("a stale failed-row retry cannot reenter an active task or duplicate its completion dialog", async t => {
  const task = activeTask({ status: "error", error: "请求失败" });
  const h = setup(t, [], [task]);
  t.mock.method(h.common, "openDownloaded", () => false);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(() => finish(null));
  const retryDownload = t.mock.method(require("../scripts/services/downloader"), "retryDownload", () => {
    task.status = "preparing";
    return pending;
  });
  const completed = t.mock.method(require("../scripts/ui/install"), "downloadComplete", () => {});
  const retry = findButton(h.main().definition, "下载失败，点按重试");
  const attempt = retry.events.tapped();
  const duplicate = retry.events.tapped();
  assert.equal(retryDownload.mock.callCount(), 1, "a still-visible old row cannot start a second result observer");
  await duplicate;
  task.status = "cancelling";
  await retry.events.tapped();
  assert.equal(retryDownload.mock.callCount(), 1);
  h.tasks.splice(0);
  await retry.events.tapped();
  assert.equal(retryDownload.mock.callCount(), 1, "removed tasks cannot restart from an obsolete row");
  finish({ record: file("Finished", { sinfInjected: true }) });
  await attempt;
  assert.equal(completed.mock.callCount(), 1);
  assert.deepEqual(h.removedTasks, []);
});

test("injected packages stay in downloads while original, imported, and recovered packages appear in archive", t => {
  const h = setup(t, [
    file("Injected", { sinfInjected: true }), file("Original", { sinfInjected: false }), file("Imported"), file("Recovered", { recovered: true }),
  ]);
  const mainTexts = h.nativeTexts(h.main());
  assert.ok(mainTexts.includes("Injected"));
  for (const name of ["Original", "Imported", "Recovered"]) assert.ok(!mainTexts.includes(name));
  assert.ok(mainTexts.includes("3 个 IPA"));
  h.openArchive();
  assert.equal(h.pages.at(-1).props.title, "归档");
  const archiveTexts = h.nativeTexts(h.archive());
  for (const name of ["Original", "Imported", "Recovered"]) assert.ok(archiveTexts.includes(name));
  assert.ok(!archiveTexts.includes("Injected"));
  assert.deepEqual(h.removedFiles, [], "classification must not move or delete any existing IPA");
  for (const width of [320, 390, 768]) {
    global.$device.info.screen.width = width;
    const list = h.downloads.views()[0];
    const entry = list.props.data[0].rows[1];
    assert.equal(list.events.rowHeight(null, { section: 0, row: 1 }), 56);
    assert.ok(findButton(entry, "归档，3 个 IPA"));
    for (const label of flatten(entry).filter(view => view.type === "label")) assert.equal(label.props.lines, 1);
  }
});

test("archive retains share and repair actions, refreshes native rows after deletion, and updates downloads on return", async t => {
  const original = file("Original", { packageVerified: true, sinfs: [{ id: 1 }], sinfInjected: false });
  const h = setup(t, [original]);
  h.openArchive();
  h.archive().contentOffset = { x: 0, y: 48 };
  const open = findButton(h.archive().definition, "Original，账号：未知，点按操作");
  assert.ok(open);
  await open.events.tapped();
  const menu = h.menus.at(-1);
  assert.ok(menu.items.includes("修复授权（重新注入 SINF）"));
  menu.handler("分享 IPA", menu.items.indexOf("分享 IPA"));
  assert.deepEqual(h.shares, ["Original.ipa"]);
  menu.handler("修复授权（重新注入 SINF）", menu.items.indexOf("修复授权（重新注入 SINF）"));
  await flush();
  assert.equal(h.files.length, 2);
  assert.ok(h.nativeTexts(h.archive()).includes("Original"));
  assert.ok(!h.nativeTexts(h.archive()).includes("Injected"));
  assert.deepEqual(h.archive().contentOffset, { x: 0, y: 48 });
  menu.handler("删除", menu.items.indexOf("删除"));
  const confirmation = h.alerts.at(-1);
  assert.equal(confirmation.title, "删除这个 IPA？");
  assert.deepEqual(h.removedFiles, []);
  confirmation.actions.find(action => action.title === "删除").handler();
  assert.deepEqual(h.removedFiles, ["Original.ipa"]);
  assert.ok(h.nativeTexts(h.archive()).includes("暂无归档 IPA"));
  assert.deepEqual(h.archive().contentOffset, { x: 0, y: 0 }, "the empty state must not remain above the old scroll offset");
  h.pop();
  const mainTexts = h.nativeTexts(h.main());
  assert.ok(mainTexts.includes("Injected"));
  assert.ok(mainTexts.includes("0 个 IPA"));
  assert.ok(!mainTexts.includes("Original"));
});

test("empty downloads and archive have clear empty states and no file actions", t => {
  const h = setup(t);
  assert.ok(h.nativeTexts(h.main()).includes("暂无下载"));
  h.openArchive();
  assert.ok(h.nativeTexts(h.archive()).includes("暂无归档 IPA"));
  assert.ok(!flatten(h.archive().definition).some(view => view.type === "button"));
});

test("archive changes made while its page is covered materialize on return", t => {
  const h = setup(t, [file("Original")]);
  h.openArchive();
  const oldList = h.archive();
  oldList.contentOffset = { x: 0, y: 80 };
  findButton(oldList.definition, "Original，账号：未知，点按操作").events.tapped();
  const menu = h.menus.at(-1);
  menu.handler("删除", menu.items.indexOf("删除"));
  h.cover();
  h.alerts.at(-1).actions.find(action => action.title === "删除").handler();
  assert.ok(h.nativeTexts(oldList).includes("Original"), "a changed data definition alone does not recreate hidden native static cells");
  h.uncover();
  assert.notEqual(h.archive(), oldList);
  assert.ok(h.nativeTexts(h.archive()).includes("暂无归档 IPA"));
  assert.ok(!h.nativeTexts(h.archive()).includes("Original"));
  assert.deepEqual(h.archive().contentOffset, { x: 0, y: 0 });
});
