const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, flatten, pageViews, flush } = require("./helpers/ui");

function bar(h, page) {
  const definition = page.views.find(view => /^navigation-bar-/.test(view.props && view.props.id || ""));
  assert.ok(definition, "the page needs its own in-content navigation bar");
  return h.nodes.get(definition.props.id);
}

function control(view, label) {
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  return descendants(view).find(node => node.definition.type === "button" && node.accessibilityLabel === label) || null;
}

function tap(button) {
  assert.ok(button, "expected a reachable navigation button");
  return button.definition.events.tapped(button);
}

function title(view) { return view.get(`${view.id}-title`).text; }

function constraints(definition, parent = { safeArea: {} }) {
  const values = {};
  const chain = (properties = []) => new Proxy({}, {
    get: (_target, key) => ["equalTo", "inset", "offset"].includes(key)
      ? value => { for (const property of properties) (values[property] ||= {})[key] = value; return chain(properties); }
      : chain(properties.concat(key)),
  });
  definition.layout(chain(), { super: parent });
  return values;
}

test("custom pages hide host navigation and preserve their content and lifecycle without an Objective-C bridge", () => {
  const h = setup();
  h.context.$objc = () => { throw new Error("host bar APIs must not be needed"); };
  const common = h.load("ui/common.js");
  const content = { type: "view", props: { id: "original-content" } };
  const calls = [], context = {};
  const page = common.page({
    props: common.pageProps({ title: "历史版本", clipsToSafeArea: true }), views: [content],
    events: {
      appeared: function (value) { assert.equal(this, context); calls.push(value); return "shown"; },
      disappeared: value => calls.push(value), dealloc: () => calls.push("disposed"),
    },
  });
  h.context.$ui.push(page);
  assert.equal(page.props.navBarHidden, true);
  assert.notEqual(page.props.statusBarHidden, true);
  assert.equal(page.props.navButtons.length, 0);
  assert.equal(pageViews(page)[0], content, "business definitions must remain the same objects");
  assert.equal(page.events.appeared.call(context, "visible"), "shown");
  assert.equal(title(bar(h, page)), "历史版本");
  assert.ok(control(bar(h, page), "返回"));
  assert.ok(!flatten(page).some(view => /关闭|播放/.test(view.props && view.props.accessibilityLabel || "")));
  page.events.disappeared("covered");
  page.events.dealloc();
  assert.deepEqual(calls, ["visible", "covered", "disposed"]);
});

test("the custom bar and content follow the live safe area and reserve one navigation height", () => {
  const h = setup();
  const page = h.load("ui/common.js").page({ props: { title: "详情" }, views: [] });
  h.context.$ui.push(page);
  const header = bar(h, page).definition;
  assert.equal(header.props.bgcolor, 'color:"clear"');
  assert.ok(!header.views.some(view => view.type === "blur"));
  const content = page.views.find(view => /^navigation-content-/.test(view.props.id));
  const parent = { safeArea: { top: "dynamic status-bar edge", left: "safe left", right: "safe right" } };
  const head = constraints(header, parent), body = constraints(content, parent);
  assert.equal(head.top.equalTo, parent.safeArea);
  assert.equal(head.height.equalTo, 44);
  assert.equal(head.left.equalTo, parent.safeArea);
  assert.equal(head.right.equalTo, parent.safeArea);
  assert.equal(body.top.equalTo, parent.safeArea);
  assert.equal(body.top.offset, head.height.equalTo);
  assert.equal(body.left.equalTo, parent.safeArea);
  assert.equal(body.right.equalTo, parent.safeArea);
  assert.equal(body.bottom.equalTo, parent, "floating content must still reach the home-indicator area");
});

test("account artwork has square bounds independent of button intrinsic sizing", () => {
  const h = setup();
  const navigation = h.load("ui/navigation.js");
  const binding = navigation.create({ root: true, title: () => "已购", buttons: () => [
    navigation.accountButton({ email: "alice@example.test" }, "CN", () => {}, "切换已购账号"),
  ] });
  const page = navigation.page({ props: {}, views: [] }, binding);
  h.context.$ui.render(page);
  page.events.appeared();
  const button = control(bar(h, page), "切换已购账号"), holder = button.super;
  assert.equal(holder.definition.type, "view", "a plain view owns the avatar geometry");
  assert.equal(holder.clipsToBounds, false);
  assert.equal(button.definition.layout, h.context.$layout.fill);
  const artwork = holder.definition.views.find(view => view.props && view.props.cornerRadius === 17);
  assert.ok(artwork);
  assert.equal(artwork.props.circular, true);
  assert.equal(artwork.props.smoothCorners, false, "account artwork uses circular corners, not a continuous rounded rectangle");
  for (const width of [320, 375, 430, 768]) {
    const outer = constraints(holder.definition, { width });
    const circle = constraints(artwork, { width: 44, height: 44 });
    assert.equal(outer.width.equalTo, 44);
    assert.equal(outer.height.equalTo, 44);
    assert.deepEqual({ ...circle.size.equalTo }, { width: 34, height: 34 });
    assert.equal(artwork.props.cornerRadius * 2, circle.size.equalTo.width);
    assert.ok(circle.center.equalTo);
  }
  assert.match(button.accessibilityValue, /alice@example.test.*CN/);
});

test("root has no close or back control and moves each account action with the active tab", async () => {
  const h = setup();
  const shell = h.load("ui/shell.js");
  shell.launch();
  const page = h.pages[0];
  page.events.appeared();
  const header = bar(h, page);
  assert.equal(page.props.navBarHidden, true);
  assert.equal(control(header, "返回"), null);
  assert.equal(title(header), "首页");
  shell.switchTab(1);
  const purchased = control(header, "切换已购账号");
  assert.ok(purchased);
  assert.equal(h.nodes.has("purchased-account-avatar"), false);
  shell.switchTab(3);
  assert.equal(control(header, "切换下载账号"), purchased, "account tab changes retain the same target");
  assert.equal(title(header), "搜索");
  assert.equal(h.nodes.has("search-account-avatar"), false);
  assert.equal(h.nodes.has("search-heading"), false);
  assert.equal(h.nodes.get("search-header").height, 118);
  shell.switchTab(2);
  assert.equal(control(header, "切换下载账号"), null);
  assert.equal(title(header), "下载");
  await flush();
});

test("the avatar keeps account switching, region searches and loaded state on return", async () => {
  const h = setup();
  const accounts = h.load("store/accounts.js");
  const saved = [{ email: "alice@example.test", store: "CN" }, { email: "bob@example.test", store: "US" }];
  accounts.listAccounts = () => saved;
  accounts.activateAccount = email => {
    const account = saved.find(value => value.email === email);
    h.switchAccount(email, account.store);
  };
  h.switchAccount(saved[0].email, saved[0].store);
  const searches = [];
  h.store.searchApps = async (term, region) => { searches.push([term, region]); return [{ id: "42", name: `${region} Camera`, price: 0 }]; };
  let menu;
  h.load("ui/common.js").menu = value => { menu = value; };
  const shell = h.load("ui/shell.js");
  shell.launch();
  const page = h.pages[0];
  page.events.appeared();
  shell.switchTab(3);
  const input = h.nodes.get("search-input");
  input.text = "Camera";
  input.definition.events.changed(input);
  input.definition.events.returned(input);
  await flush();
  const avatar = control(bar(h, page), "切换下载账号");
  tap(avatar);
  assert.ok(menu.items[0].endsWith("✓"));
  menu.handler(menu.items[1], 1);
  await flush();
  assert.deepEqual(searches, [["Camera", "CN"], ["Camera", "US"]]);
  assert.equal(control(bar(h, page), "切换下载账号"), avatar);
  assert.match(avatar.accessibilityValue, /bob@example.test.*US/);
  assert.equal(h.nodes.get("search-input"), input);
  page.events.disappeared();
  const detail = h.load("ui/common.js").page({ props: { title: "Camera" }, views: [] });
  h.context.$ui.push(detail);
  detail.events.appeared();
  const resultList = h.nodes.get("search-list");
  h.switchAccount("carol@example.test", "US");
  h.load("ui/search.js").mount();
  assert.equal(title(bar(h, detail)), "Camera");
  assert.match(avatar.accessibilityValue, /bob@example.test/, "covered page waits until it appears");
  page.events.appeared();
  assert.equal(control(bar(h, page), "切换下载账号"), avatar);
  assert.match(avatar.accessibilityValue, /carol@example.test/);
  assert.equal(input.text, "Camera");
  assert.equal(h.nodes.get("search-list"), resultList);
  assert.equal(searches.length, 2);
  page.events.dealloc();
  menu = null;
  tap(avatar);
  assert.equal(menu, null);
});

test("standalone purchased keeps its account action in its own content navigation", () => {
  const h = setup();
  h.load("ui/purchased.js").render();
  const page = h.pages.at(-1);
  page.events.appeared();
  assert.equal(page.props.navBarHidden, true);
  assert.equal(title(bar(h, page)), "App Store 已购");
  assert.ok(control(bar(h, page), "切换已购账号"));
  assert.ok(control(bar(h, page), "返回"));
  page.events.dealloc();
});

test("a missing account keeps an actionable avatar without native runtime helpers", () => {
  const h = setup();
  h.switchAccount(null);
  let alert;
  h.load("ui/common.js").alert = value => { alert = value; };
  const shell = h.load("ui/shell.js");
  shell.launch();
  const page = h.pages[0];
  page.events.appeared();
  shell.switchTab(1);
  tap(control(bar(h, page), "切换已购账号"));
  assert.match(alert.message, /查看对应账号的已购/);
  shell.switchTab(3);
  const button = control(bar(h, page), "切换下载账号");
  assert.equal(button.accessibilityValue, "未选择账号");
  tap(button);
  assert.match(alert.message, /搜索不需要登录/);
  assert.equal(typeof alert.actions.find(action => action.title === "管理账号").handler, "function");
});

test("back pops one native page and ignores covered, repeated and disposed taps", () => {
  const h = setup();
  let pops = 0;
  h.context.$ui.pop = () => pops++;
  const page = h.load("ui/common.js").page({ props: { title: "详情" }, views: [] });
  h.context.$ui.push(page);
  const back = control(bar(h, page), "返回");
  tap(back);
  assert.equal(pops, 0);
  page.events.appeared();
  tap(back);
  tap(back);
  assert.equal(pops, 1);
  page.events.disappeared();
  tap(back);
  assert.equal(pops, 1);
  page.events.appeared();
  tap(back);
  assert.equal(pops, 2);
  page.events.dealloc();
  tap(back);
  assert.equal(pops, 2);
});

test("explicit business actions move into the custom bar and keep their original handler", () => {
  const h = setup();
  let called;
  const page = h.load("ui/common.js").page({
    props: { title: "地区", navButtons: [{ title: "取消", handler: sender => { called = sender; } }] }, views: [],
  });
  h.context.$ui.push(page);
  page.events.appeared();
  assert.equal(page.props.navButtons.length, 0);
  const cancel = control(bar(h, page), "取消");
  tap(cancel);
  assert.equal(called, cancel);

  let pops = 0, selections = 0;
  h.context.$ui.pop = () => pops++;
  h.load("ui/common.js").pickRegion(() => selections++);
  const regionPage = h.pages.at(-1);
  regionPage.events.appeared();
  const regionBar = bar(h, regionPage);
  assert.ok(!control(regionBar, "切换账号"), "the region cancel action must not be read as an account switch");
  tap(control(regionBar, "取消"));
  assert.equal(pops, 1);
  assert.equal(selections, 0, "cancelling must not change the region");
});

test("root rendering never captures or rewrites the outgoing host controller", () => {
  const h = setup();
  let reads = 0, writes = 0;
  Object.defineProperty(h.context.$ui, "controller", { get() { reads++; throw new Error("old host"); } });
  Object.defineProperty(h.context.$ui, "title", { set() { writes++; } });
  h.load("ui/shell.js").launch();
  h.pages[0].events.appeared();
  h.load("ui/shell.js").switchTab(3);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(title(bar(h, h.pages[0])), "搜索");
});

test("a failing old dealloc callback still releases navigation actions", () => {
  const h = setup();
  let calls = 0;
  const page = h.load("ui/common.js").page({
    props: { title: "地区", navButtons: [{ title: "取消", handler: () => calls++ }] },
    events: { dealloc() { throw new Error("legacy callback failure"); } }, views: [],
  });
  h.context.$ui.push(page);
  page.events.appeared();
  const cancel = control(bar(h, page), "取消");
  assert.throws(() => page.events.dealloc(), /legacy callback failure/);
  tap(cancel);
  assert.equal(calls, 0);
});

test("switching tabs updates real action-container constraints and retires removed targets", () => {
  const h = setup();
  const shell = h.load("ui/shell.js");
  shell.launch();
  const page = h.pages[0];
  page.events.appeared();
  const header = bar(h, page), actions = header.get(`${header.id}-actions`);
  const widths = [];
  actions.updateLayout = update => widths.push(constraints({ layout: update }).width.equalTo);
  shell.switchTab(1);
  const avatar = control(header, "切换已购账号");
  assert.equal(widths.at(-1), 44, "a bar created without actions must grow a real hit-test parent");
  shell.switchTab(0);
  assert.equal(widths.at(-1), 0);
  assert.equal(actions.children.length, 0);
  let called = 0;
  h.load("ui/common.js").menu = () => called++;
  tap(avatar);
  assert.equal(called, 0);
  shell.switchTab(1);
  assert.equal(widths.at(-1), 44);
  assert.ok(control(header, "切换已购账号"));
});

test("swipe enablement is limited to the stable top script subpage and never changes its delegate", () => {
  for (const state of [
    { root: false, count: 2, top: true, transitioning: false, expected: 1 },
    { root: true, count: 2, top: true, transitioning: false, expected: 0 },
    { root: false, count: 1, top: true, transitioning: false, expected: 0 },
    { root: false, count: 2, top: false, transitioning: false, expected: 0 },
    { root: false, count: 2, top: true, transitioning: true, expected: 0 },
  ]) {
    const h = setup(), changes = [];
    const gesture = { invoke(selector, value) {
      assert.equal(selector, "setEnabled:");
      assert.equal(value, true);
      changes.push(value);
    } };
    const nav = { invoke(selector) {
      if (selector === "topViewController") return state.top ? controller : { invoke: () => false };
      if (selector === "viewControllers") return { invoke: method => { assert.equal(method, "count"); return state.count; } };
      if (selector === "interactivePopGestureRecognizer") return gesture;
      throw new Error(`unexpected mutation: ${selector}`);
    } };
    const controller = {
      ocValue() { return this; },
      invoke(selector, other) {
        if (selector === "navigationController") return nav;
        if (selector === "isEqual:") return this === other;
        if (selector === "transitionCoordinator") return state.transitioning ? {} : null;
        throw new Error(`unexpected mutation: ${selector}`);
      },
    };
    h.context.$ui.controller = controller;
    const navigation = h.load("ui/navigation.js");
    const binding = navigation.create({ root: state.root, title: () => "详情" });
    const page = navigation.page({ props: {}, views: [] }, binding);
    h.context.$ui.push(page);
    page.events.appeared();
    assert.equal(changes.length, state.expected);
    page.events.disappeared();
    page.events.dealloc();
    binding.attach();
    assert.equal(changes.length, state.expected, "disappearance must not interrupt an interactive transition");
  }
});
