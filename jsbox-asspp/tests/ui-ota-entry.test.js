const { test } = require("node:test");
const assert = require("node:assert/strict");

function record(extra = {}) {
  return {
    fileName: "Synthetic.ipa",
    title: "Synthetic",
    sinfInjected: true,
    packageVerified: true,
    metadataVerified: true,
    bundleId: "com.example.synthetic",
    bundleVersion: "100",
    ...extra,
  };
}

function setup(t, initialFiles) {
  const names = ["$", "$ui", "$color", "$font", "$align", "$size", "$insets", "$layout"];
  const previous = new Map(names.map(name => [name, global[name]]));
  t.after(() => previous.forEach((value, name) => { global[name] = value; }));
  const menus = [], alerts = [], shares = [], removals = [], installations = [];
  const files = initialFiles.slice();
  global.$color = value => value;
  global.$font = (...args) => args;
  global.$align = { left: 0, center: 1, right: 2 };
  global.$size = (width, height) => ({ width, height });
  global.$insets = (top, left, bottom, right) => ({ top, left, bottom, right });
  global.$layout = { fill: {} };
  global.$ = () => null;
  global.$ui = {
    menu: value => menus.push(value),
    alert: value => alerts.push(value),
    toast() {},
    loading() {},
  };

  const common = require("../scripts/ui/common");
  const library = require("../scripts/store/library");
  const ota = require("../scripts/services/ota");
  const installer = require("../scripts/ui/install");
  const downloads = require("../scripts/ui/downloads");
  t.mock.method(library, "listFiles", () => files.map(file => ({ ...file })));
  t.mock.method(library, "share", name => shares.push(name));
  t.mock.method(library, "remove", name => {
    removals.push(name);
    const index = files.findIndex(file => file.fileName === name);
    if (index >= 0) files.splice(index, 1);
  });
  t.mock.method(common, "refreshDownloadButtons", () => {});
  t.mock.method(ota, "installToDevice", async options => {
    installations.push(options);
    return { stop() {} };
  });
  return { downloads, installer, menus, alerts, shares, removals, installations };
}

function selectMenu(menu, title) {
  const index = menu.items.indexOf(title);
  assert.notEqual(index, -1, `expected menu action: ${title}`);
  return menu.handler(title, index);
}

function selectAlert(alert, title) {
  const action = alert.actions.find(item => item.title === title);
  assert.ok(action, `expected alert action: ${title}`);
  return action.handler && action.handler();
}

test("an injected IPA retains its OTA entry while unverified metadata blocks installation", async t => {
  const item = record({ metadataVerified: false });
  const h = setup(t, [item]);
  assert.equal(h.downloads.fileActions(item.fileName), true);
  selectMenu(h.menus.at(-1), "OTA 安装");
  assert.equal(h.alerts.at(-1).title, "暂不能尝试 OTA");
  assert.ok(h.alerts.at(-1).message.includes(h.installer.unavailableReason(item)));
  assert.equal(h.installations.length, 0);

  await h.installer.launch(item);
  assert.equal(h.alerts.at(-1).title, "暂不能尝试 OTA");
  assert.equal(h.installations.length, 0, "direct launch must preserve the metadata guard");
  selectAlert(h.alerts.at(-1), "分享 IPA");
  assert.deepEqual(h.shares, [item.fileName]);
});

test("a verified IPA starts OTA with real metadata only after confirmation", async t => {
  const item = record();
  const h = setup(t, [item]);
  h.downloads.fileActions(item.fileName);
  selectMenu(h.menus.at(-1), "OTA 安装");
  assert.equal(h.alerts.at(-1).title, "实验性 OTA 安装");
  assert.equal(h.installations.length, 0, "opening the entry must not start a server");
  await selectAlert(h.alerts.at(-1), "仍然尝试");
  assert.deepEqual(h.installations, [{
    fileName: item.fileName,
    bundleId: item.bundleId,
    bundleVersion: item.bundleVersion,
    title: item.title,
  }]);
  assert.equal(h.alerts.at(-1).title, "已打开安装清单");
});

test("file actions still share and require confirmation before deleting", t => {
  const item = record();
  const h = setup(t, [item]);
  h.downloads.fileActions(item.fileName);
  selectMenu(h.menus.at(-1), "分享 IPA");
  assert.deepEqual(h.shares, [item.fileName]);

  selectMenu(h.menus.at(-1), "删除");
  assert.equal(h.alerts.at(-1).title, "删除这个 IPA？");
  assert.deepEqual(h.removals, []);
  selectAlert(h.alerts.at(-1), "取消");
  assert.deepEqual(h.removals, []);
  selectMenu(h.menus.at(-1), "删除");
  selectAlert(h.alerts.at(-1), "删除");
  assert.deepEqual(h.removals, [item.fileName]);
  assert.equal(h.installations.length, 0);
  assert.equal(h.downloads.fileActions(item.fileName), false);
});

test("download completion exposes the same OTA action and validation", t => {
  const items = [record({ metadataVerified: false }), record({ fileName: "Verified.ipa" })];
  const h = setup(t, items);
  for (const item of items) {
    h.installer.downloadComplete(item);
    const complete = h.alerts.at(-1);
    assert.equal(complete.title, "下载完成");
    selectAlert(complete, "OTA 安装");
    assert.equal(h.alerts.at(-1).title, item.metadataVerified ? "实验性 OTA 安装" : "暂不能尝试 OTA");
    selectAlert(complete, "分享 IPA");
  }
  assert.deepEqual(h.shares, items.map(item => item.fileName));
  assert.equal(h.installations.length, 0);
});
