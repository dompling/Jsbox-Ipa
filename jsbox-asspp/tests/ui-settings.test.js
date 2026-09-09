const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function editor(overrides = {}) {
  const nodes = new Map();
  const messages = [];
  const saved = [];
  let page;
  let pops = 0;
  let blurs = 0;
  let focuses = 0;
  let url = "https://sap.example.com";
  let token = "test-token";
  const settings = Object.assign({
    region: () => "CN",
    authURLMode: () => "auto",
    chartLimit: () => 25,
    rawSapMode: () => url && token ? "api" : "off",
    plistServer: () => "https://api.scripting.fun/ipa-plist",
    sapApiURL: () => url,
    sapApiToken: () => token,
    setSapConfig: (value) => {
      saved.push({ url: value.url, token: value.token });
      url = value.url;
      token = value.token;
    },
  }, overrides);
  const common = {
    colors: {},
    pageProps: (props) => props,
    page: (definition) => definition,
    fieldProps: (placeholder, props) => ({ placeholder, ...props }),
    primaryButtonProps: (title, props) => ({ title, ...props }),
    floatingTabListProps: (props) => props,
    iconMenuRow: (title, subtitle, value, key) => ({ title, subtitle, value, _key: key }),
    menuSection: (title, rows) => ({ title, rows }),
    countryName: () => "中国大陆",
    toast: (message) => messages.push(message),
  };
  function mount(view, parent) {
    const node = Object.assign({}, view.props, {
      super: parent,
      frame: { x: 0, y: 0, width: 320, height: 0 },
      get: (id) => nodes.get(id),
      blur: () => { blurs += 1; },
      focus: () => { focuses += 1; },
      definition: view,
    });
    if (node.id) nodes.set(node.id, node);
    for (const child of view.views || []) mount(child, node);
    for (const child of (view.props && view.props.stack && view.props.stack.views) || []) mount(child, node);
    return node;
  }
  const modules = {
    "../config": { APP: { name: "JAsspp", version: "test" } },
    "./common": common,
    "../store/settings": settings,
    "../store/accounts": { activeEmailForRegion: () => "", accountForRegion: () => null },
    "../lib/url": {},
  };
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(modules[name], `unexpected dependency: ${name}`);
      return modules[name];
    },
    $: (id) => nodes.get(id),
    $ui: { push: (value) => { page = value; value.views.forEach((view) => mount(view)); }, pop: () => { pops += 1; } },
    $font: (...args) => args,
    $color: (value) => value,
    $size: (width, height) => ({ width, height }),
    $rect: (x, y, width, height) => ({ x, y, width, height }),
    $insets: (top, left, bottom, right) => ({ top, left, bottom, right }),
    $layout: { fill: {} },
    $kbType: { url: 3, default: 0 },
    $text: { sizeThatFits: ({ text, width }) => ({ height: Math.ceil(text.length * 13 / width) * 18 }) },
  };
  const filename = require.resolve("../scripts/ui/settings");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const list = context.module.exports.views()[0];
  mount(list);
  list.events.didSelect(null, null, { _key: "sapConfig" });
  return {
    page, nodes, messages, saved, settings,
    urlInput: nodes.get("sap-url-input"),
    tokenInput: nodes.get("sap-token-input"),
    error: nodes.get("sap-config-error"),
    scroll: nodes.get("sap-config-scroll"),
    form: nodes.get("sap-config-form"),
    save: () => nodes.get("sap-config-save").definition.events.tapped(),
    clear: () => nodes.get("sap-config-clear").definition.events.tapped(),
    pops: () => pops,
    blurs: () => blurs,
    focuses: () => focuses,
  };
}

test("settings has one purchased-signature entry opening both fields with no mode selector", () => {
  const ui = editor();
  const rows = ui.nodes.get("settings-list").data.flatMap((section) => section.rows);
  const sapRows = rows.filter((row) => /sap|签名/i.test(row.title));
  assert.equal(sapRows.length, 1);
  assert.equal(sapRows[0]._key, "sapConfig");
  assert.equal(sapRows[0].title, "已购签名");
  assert.equal(sapRows[0].value, "已开启");
  assert.equal(ui.page.props.title, "已购签名");
  assert.equal(ui.urlInput.text, "https://sap.example.com");
  assert.equal(ui.tokenInput.text, "test-token");
  assert.equal(ui.form.definition.type, "view", "the combined form must not depend on intrinsic stack child heights");
});

test("the SAP form saves both fields together and refreshes the single settings row", () => {
  const ui = editor();
  assert.equal(ui.urlInput.placeholder, "https://sap.example.com");
  ui.urlInput.text = "  https://signer.example.com/proxy/sap  ";
  ui.tokenInput.text = "  updated-token  ";
  ui.save();
  assert.deepEqual(ui.saved, [{ url: "https://signer.example.com/proxy/sap", token: "updated-token" }]);
  assert.equal(ui.pops(), 1);
  assert.equal(ui.blurs(), 2);
  assert.deepEqual(ui.messages, ["已开启"]);
  const row = ui.nodes.get("settings-list").data.flatMap((section) => section.rows)
    .find((value) => value._key === "sapConfig");
  assert.equal(row.value, "已开启");
  assert.equal(JSON.stringify(row).includes("updated-token"), false);
});

test("validation and Keychain failures keep the SAP editor open and allow retry", () => {
  for (const message of ["服务地址无效", "钥匙串写入失败"]) {
    const ui = editor({ setSapConfig: () => { throw new Error(message); } });
    ui.save();
    assert.equal(ui.pops(), 0);
    assert.equal(ui.blurs(), 0);
    assert.equal(ui.error.text, message);
    assert.equal(ui.error.hidden, false);
    assert.deepEqual(ui.messages, []);
    assert.equal(ui.urlInput.text, "https://sap.example.com");
    assert.equal(ui.tokenInput.text, "test-token");
    ui.urlInput.definition.events.changed(ui.urlInput);
    assert.equal(ui.error.text, "");
    assert.equal(ui.error.hidden, true);
    ui.settings.setSapConfig = () => {};
    ui.save();
    assert.equal(ui.pops(), 1);
    assert.deepEqual(ui.messages, ["已开启"]);
  }
});

test("SAP Token stays masked and keyboard actions do not prematurely save the address", () => {
  const ui = editor();
  assert.equal(ui.tokenInput.secure, true);
  assert.equal(ui.urlInput.secure, false);
  ui.urlInput.definition.events.returned(ui.urlInput);
  assert.equal(ui.focuses(), 1);
  assert.deepEqual(ui.saved, []);
  ui.tokenInput.accessoryView.views[0].events.tapped();
  assert.equal(ui.blurs(), 1);
  assert.equal(ui.pops(), 0);
  assert.deepEqual(ui.saved, []);
  ui.tokenInput.definition.events.returned(ui.tokenInput);
  assert.equal(ui.saved.length, 1);
});

test("clearing SAP configuration removes both fields and switches the entry off", () => {
  const ui = editor();
  ui.clear();
  assert.deepEqual(ui.saved, [{ url: "", token: "" }]);
  assert.deepEqual(ui.messages, ["已关闭"]);
  assert.equal(ui.pops(), 1);
  const row = ui.nodes.get("settings-list").data.flatMap((section) => section.rows)
    .find((value) => value._key === "sapConfig");
  assert.equal(row.value, "未开启");
});

test("saving two blank fields disables SAP without a separate toggle", () => {
  const ui = editor();
  ui.urlInput.text = "   ";
  ui.tokenInput.text = "   ";
  ui.save();
  assert.deepEqual(ui.saved, [{ url: "", token: "" }]);
  assert.deepEqual(ui.messages, ["已关闭"]);
});

test("SAP editor restores scroll insets when the keyboard closes", () => {
  const ui = editor();
  ui.page.events.keyboardHeightChanged(336);
  assert.equal(ui.scroll.contentInset.bottom, 336);
  assert.equal(ui.scroll.indicatorInsets.bottom, 336);
  for (const height of [0, -10, undefined]) {
    ui.page.events.keyboardHeightChanged(height);
    assert.equal(ui.scroll.contentInset.bottom, 0);
    assert.equal(ui.scroll.indicatorInsets.bottom, 0);
  }
  ui.nodes.delete("sap-config-scroll");
  assert.doesNotThrow(() => ui.page.events.keyboardHeightChanged(336));
});

test("SAP form remains scrollable after viewport and multiline content changes", () => {
  const ui = editor();
  for (const [width, message] of [[320, ""], [375, ""], [430, ""], [1024, ""], [320, "保存失败，请检查服务地址和钥匙串权限。".repeat(12)]]) {
    ui.scroll.frame.width = width;
    ui.error.text = message;
    ui.error.hidden = !message;
    ui.scroll.definition.events.layoutSubviews(ui.scroll);
    assert.equal(ui.scroll.contentSize.width, width);
    assert.equal(ui.form.frame.width, Math.min(width - 32, 560));
    assert.equal(ui.form.frame.x, (width - ui.form.frame.width) / 2);
    assert.ok(ui.scroll.contentSize.height > ui.form.frame.y + ui.form.frame.height,
      "the complete form and its bottom margin must remain reachable");
    const save = ui.nodes.get("sap-config-save").frame;
    assert.equal(save.height, 50);
    assert.ok(save.y >= ui.error.frame.y + ui.error.frame.height,
      "multiline errors must not overlap Save");
    if (message) assert.ok(ui.error.frame.height > 100);
  }
});

test("SAP inputs have explicit 48pt height constraints outside a stack", () => {
  const ui = editor();
  for (const input of [ui.urlInput, ui.tokenInput]) {
    const heights = [];
    input.definition.layout({
      left: { right: { inset() {} } },
      top: { equalTo() {} },
      height: { equalTo: (height) => heights.push(height) },
    }, input);
    assert.deepEqual(heights, [48]);
    assert.equal(input.super.definition.type, "view");
  }
});
