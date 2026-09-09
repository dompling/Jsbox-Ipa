const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

function installUiGlobals() {
  global.$color = (value) => `color:${JSON.stringify(value)}`;
  global.$font = (...args) => `font:${args.join(":")}`;
  global.$align = { left: 0, center: 1, right: 2 };
  global.$size = (width, height) => ({ width, height });
  global.$insets = (top, left, bottom, right) => ({ top, left, bottom, right });
  global.$layout = { fill: { __fill: true } };
}

test("common UI module loads and exposes complete row helpers", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");

  for (const name of ["iconMenuRow", "menuRowData", "rowKey", "menuSection"]) {
    assert.strictEqual(typeof common[name], "function", `${name} should be a function`);
  }

  const row = common.iconMenuRow(
    "账号与登录",
    "管理 Apple ID",
    "管理",
    "accounts",
    "person.crop.circle.fill",
    common.colors.purple
  );
  assert.strictEqual(common.rowKey(row), "accounts");
  assert.strictEqual(row.title.text, "账号与登录");
  assert.strictEqual(row.glyph.symbol, "person.crop.circle.fill");
  assert.deepStrictEqual(common.menuSection("Apple ID", [row]), {
    title: "Apple ID",
    rows: [row],
  });
  assert.strictEqual(common.ICON_MENU_ESTIMATED_ROW_HEIGHT, 78);
  assert.strictEqual(common.FLOATING_TAB_BOTTOM_INSET, 112);
  const floating = common.floatingTabListProps({ id: "floating-list" });
  assert.strictEqual(floating.contentInset.bottom, 112);
  assert.strictEqual(floating.indicatorInsets.bottom, 112);
  const subtitle = common.iconMenuTemplate.views.find(
    (view) => view.props && view.props.id === "subtitle"
  );
  assert.strictEqual(subtitle.props.lines, 2);
});

test("iconMenuRow title/subtitle adapt to content and subtitle hugs the title", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");

  // 逐条执行模板里 label 的 layout 闭包，用 recorder 记录约束数值。
  // 模板行不再写死 label 高度：title 由字体行高决定，subtitle 从标题下方
  // 约 1px 开始并以 bottom inset 收尾，让 autoRowHeight 按文本行数推导行高，
  // 避免单行副标题被垂直居中到固定大容器里、与标题拉开明显断层。
  function recordLayout(layout) {
    const rec = {};
    function segment(prop) {
      const seg = {
        equalTo: (v) => {
          rec[prop] = Number(v);
          return seg;
        },
        inset: (v) => {
          rec[prop] = Number(v);
          return seg;
        },
      };
      return seg;
    }
    const make = new Proxy({}, { get: (_target, prop) => segment(String(prop)) });
    layout(make, { super: {} });
    return rec;
  }

  const byId = (id) =>
    common.iconMenuTemplate.views.find((view) => view.props && view.props.id === id);
  const title = recordLayout(byId("title").layout);
  const subtitle = recordLayout(byId("subtitle").layout);

  assert.strictEqual(title.top, 12, "标题距行顶留白");
  assert.strictEqual(title.height, undefined, "标题高度交给字体行高自适应");
  assert.strictEqual(subtitle.top, 32, "副标题紧贴标题行高(约19pt)下方1pt");
  assert.strictEqual(subtitle.height, undefined, "副标题高度按文本行数自适应");
  assert.strictEqual(subtitle.bottom, 11, "副标题底部留白供 autoRowHeight 推导行高");

  // 顶部留白 12 与底部留白 11 近似对称，配合 tile/value 的 centerY，
  // 文本组在行内保持居中。
  assert.ok(
    Math.abs(title.top - subtitle.bottom) <= 1,
    "标题顶部与副标题底部的留白应近似一致"
  );
});

function flatViews(def) {
  const out = [def];
  for (const child of def.views || []) out.push(...flatViews(child));
  for (const child of (def.stack && def.stack.views) || []) out.push(...flatViews(child));
  for (const child of (def.props && def.props.stack && def.props.stack.views) || []) {
    out.push(...flatViews(child));
  }
  return out;
}

function pillLabel(def) {
  return flatViews(def).find(
    (v) => v.type === "label" && v.props && v.props.cornerRadius
  );
}

test("full-view App rows keep a readable price pill and fill their cell", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");

  const row = common.appRowView({ name: "Example", price: 0 });
  const chartRow = common.chartRowView({ name: "Example", price: 0 }, 0);
  const editorialRow = common.editorialRowView({ name: "Example", price: 0 });

  assert.strictEqual(row.type, "view");
  assert.strictEqual(typeof row.layout, "function", "row root should fill the cell");
  assert.strictEqual(row.props.cornerRadius, undefined);
  assert.strictEqual(row.views[0].props.cornerRadius, 16);
  assert.strictEqual(row.views[0].props.smoothCorners, true);
  assert.strictEqual(typeof chartRow.layout, "function");

  const pill = pillLabel(row);
  const chartPill = pillLabel(chartRow);
  assert.ok(pill && pill.props.text === "获取");
  assert.ok(chartPill && chartPill.props.text === "获取");
  assert.notStrictEqual(pill.props.textColor, pill.props.bgcolor);
  assert.notStrictEqual(chartPill.props.textColor, chartPill.props.bgcolor);
  assert.ok(
    flatViews(editorialRow).some(
      (view) => view.props && (view.props.text === "获取" || view.props.title === "获取")
    )
  );
});

test("search App rows expose a real download button when an action is provided", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");
  let downloaded = 0;
  const row = common.appRowView(
    { name: "Example", price: 0 },
    "com.example.app",
    { onGet: () => downloaded++ }
  );
  const button = flatViews(row).find(
    (view) => view.type === "button" && view.props && view.props.title === "获取"
  );
  assert.ok(button, "free App action should be a button");
  button.events.tapped();
  assert.strictEqual(downloaded, 1);
});

test("download pills isolate progress controls and forward byte progress", async () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");
  let progressCallback;
  const row = common.appRowView(
    { name: "Example", price: 0 },
    "com.example.app",
    {
      onGet: async (onProgress) => {
        progressCallback = onProgress;
        onProgress(50, 100);
        return true;
      },
    }
  );
  const secondRow = common.appRowView(
    { name: "Another", price: 0 },
    "com.example.another",
    { onGet: async () => true }
  );
  const button = flatViews(row).find((view) => view.type === "button");
  const progress = flatViews(row).find((view) => view.type === "canvas");
  const secondProgress = flatViews(secondRow).find((view) => view.type === "canvas");
  assert.ok(button && progress && secondProgress);
  assert.notStrictEqual(progress.props.id, secondProgress.props.id);

  const sender = {
    title: "获取",
    super: {
      get: (id) => (id === progress.props.id ? progress : null),
    },
  };
  await button.events.tapped(sender);
  assert.strictEqual(typeof progressCallback, "function");
  assert.strictEqual(progress.info.value, 0.5, "keep the actual byte ratio instead of inventing completed progress");
  assert.strictEqual(progress.hidden, true);
  assert.strictEqual(sender.title, "获取");
});

test("price and region labels use App Store-friendly display values", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");
  assert.strictEqual(common.priceText({ price: 12, currency: "CNY" }), "¥12.00");
  assert.strictEqual(common.priceText({ price: 4.99, currency: "USD" }), "$4.99");
  assert.strictEqual(common.priceText({ price: 3, currency: "XYZ" }), "3.00 XYZ");
  assert.strictEqual(common.regionText("CN"), "中国大陆  CN");
  assert.strictEqual(common.regionText("US", "    "), "美国    US");
});

test("Apple session expiry codes are recognized without matching unrelated numbers", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");
  assert.strictEqual(common.isSessionExpiredError({ code: "2034" }), true);
  assert.strictEqual(common.isSessionExpiredError({ code: 2042 }), true);
  assert.strictEqual(common.isSessionExpiredError(new Error("HTTP 2042")), true);
  assert.strictEqual(common.isSessionExpiredError(new Error("HTTP 42042")), false);
});

test("editorial rows expose a single download action while the row remains navigable", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");
  let viewed = 0;
  let downloaded = 0;
  const row = common.editorialRowView(
    { name: "Example", price: 0 },
    { onView: () => viewed++, onGet: () => downloaded++ }
  );
  const buttons = flatViews(row).filter((view) => view.type === "button");
  assert.strictEqual(buttons.length, 2);
  buttons.find((button) => !button.props.title).events.tapped();
  buttons.find((button) => button.props.title).events.tapped();
  assert.strictEqual(viewed, 1, "details are opened by the inner card hit area");
  assert.strictEqual(downloaded, 1);
});

test("region controls and picker rows keep the country on the left and code on the right", () => {
  installUiGlobals();
  delete require.cache[require.resolve("../scripts/ui/common")];
  const common = require("../scripts/ui/common");
  const control = common.regionControl("region", "CN", () => {});
  const children = flatViews(control);
  const name = children.find((view) => view.props && view.props.id === "region-name");
  const code = children.find((view) => view.props && view.props.id === "region-code");
  assert.strictEqual(name.props.text, "中国大陆");
  assert.strictEqual(code.props.text, "CN");
  assert.match(String(code.layout), /right/);
  const row = common.regionPickerRow("US", false, () => {});
  const rowLabels = flatViews(row).filter((view) => view.type === "label");
  assert.ok(rowLabels.some((view) => view.props.text === "美国"));
  assert.ok(rowLabels.some((view) => view.props.text === "US"));
});

test("full-view row builders must not depend on global $() or template ids", () => {
  const source = fs.readFileSync(
    require.resolve("../scripts/ui/common"),
    "utf8"
  );
  // 页面行现在是完整视图定义，不应再依赖模板容器/全局 id 查找。
  assert.doesNotMatch(source, /\$\("(?:tile|value|price|title|rank)"\)/);
  assert.doesNotMatch(source, /\$\("name"\)\.bottom/);
});

test("bottom tab bar is a theme-matched capsule with a visible selected capsule", () => {
  installUiGlobals();
  global.$layout = { fill: { __fill: true } };
  delete require.cache[require.resolve("../scripts/ui/shell")];
  const shell = require("../scripts/ui/shell");
  const bar = shell.tabBarView();
  assert.strictEqual(bar.props.id, "tabbar");
  // 整条 Tab 栏是不透明胶囊底（与卡片同源的动态色），不再使用 blur 等
  // 半透明材质层，避免内容发灰；圆角为栏高的一半形成胶囊外形。
  assert.notStrictEqual(bar.props.bgcolor, "color:\"clear\"");
  assert.strictEqual(bar.props.cornerRadius, 30);
  assert.strictEqual(bar.props.smoothCorners, true);
  // JSBox 没有 view 级 shadow props；用细边框 + 垫层模拟投影层次。
  assert.strictEqual(bar.props.borderWidth, 0.5);
  assert.ok(bar.props.borderColor);
  const shadowLayers = shell.tabBarShadowLayers();
  assert.strictEqual(shadowLayers.length, 2);
  for (const layer of shadowLayers) {
    assert.match(layer.props.id, /^tabbar-shadow-\d+$/);
    assert.strictEqual(layer.props.bgcolor, "color:\"black\"");
    assert.ok(layer.props.alpha > 0 && layer.props.alpha < 0.2);
    assert.strictEqual(layer.props.cornerRadius, 30);
    assert.match(String(layer.layout), /safeArea/);
  }
  assert.ok(!flatViews(bar).some((view) => view.type === "blur"));
  const selected = flatViews(bar).find(
    (view) => view.props && view.props.id === "tabpill-home"
  );
  assert.ok(selected);
  assert.notStrictEqual(selected.props.bgcolor, "color:\"clear\"");
  assert.match(String(bar.layout), /safeArea/);
  const stack = flatViews(bar).find((view) => view.type === "stack");
  assert.ok(stack, "tabs should use an adaptive stack view");
  assert.ok(stack.props.stack, "stack children must be nested under props.stack");
  assert.strictEqual(stack.props.stack.views.length, 5);
  assert.strictEqual(stack.stack, undefined, "top-level stack property is not a JSBox stack prop");
  assert.strictEqual(stack.props.distribution, 1, "fillEqually must remain the fallback constant");

  const host = shell.contentHostView();
  assert.strictEqual(host.props.id, "content-host");
  assert.strictEqual(host.views.length, 5);
  assert.strictEqual(host.layout, global.$layout.fill);
  const screen = shell.screenView(shell.TABS[0]);
  assert.match(String(screen.layout), /edges/);
  const source = fs.readFileSync(require.resolve("../scripts/ui/shell"), "utf8");
  assert.match(source, /views:\s*\[contentHostView\(\)\]\.concat\(tabBarShadowLayers\(\), \[tabBarView\(\)\]\)/);
  assert.match(source, /clipsToSafeArea:\s*false/);
});

test("template layouts do not call the undocumented view.super.get helper", () => {
  const source = fs.readFileSync(require.resolve("../scripts/ui/common"), "utf8");
  assert.doesNotMatch(source, /view\.super\.get\s*\(/);
});

test("home starts with one compact loading card per module", () => {
  installUiGlobals();
  global.$layout = { fill: { __fill: true } };
  global.$prefs = { get: () => undefined, set: () => true };
  delete require.cache[require.resolve("../scripts/ui/home")];
  const home = require("../scripts/ui/home");
  const list = home.views()[0];
  assert.strictEqual(list.props.header.props.height, 64);
  assert.strictEqual(list.props.data.length, 3);
  assert.strictEqual(list.props.data[0].title, "");
  for (const section of list.props.data) {
    assert.strictEqual(section.rows.length, 1);
    const card = section.rows[0].views[0];
    assert.strictEqual(card.views.length, 2, "module heading and loading message share one surface");
    assert.ok(list.events.rowHeight(null, { section: list.props.data.indexOf(section), row: 0 }) < 200);
  }
});

test("search refresh rebuilds static result cells instead of reusing blank rows", () => {
  installUiGlobals();
  global.$kbType = { search: 1 };
  global.$prefs = {
    get: (key) => (key === "jasspp.region" ? "CN" : undefined),
    set: () => true,
  };

  let removed = 0;
  let added;
  const list = {
    remove: () => {
      removed += 1;
    },
  };
  const screen = {
    add: (definition) => {
      added = definition;
    },
  };
  const nodes = {
    "search-list": list,
    "screen-search": screen,
  };
  global.$ = (id) => nodes[id] || null;
  global.$ui = { get: (id) => nodes[id] || null };

  delete require.cache[require.resolve("../scripts/ui/search")];
  const search = require("../scripts/ui/search");
  const root = search.views()[0];
  search.mount();
  const input = flatViews(root).find((view) => view.props && view.props.id === "search-input");
  input.events.changed({ text: "Demo" });

  assert.strictEqual(removed, 1);
  assert.ok(added && added.type === "list");
  assert.strictEqual(added.props.id, "search-list");
  assert.ok(Array.isArray(added.props.data));
});

test("search header lives outside the result list so input refreshes keep focus", () => {
  installUiGlobals();
  global.$kbType = { search: 1 };
  global.$prefs = { get: () => "CN", set: () => true };
  delete require.cache[require.resolve("../scripts/ui/search")];
  const search = require("../scripts/ui/search");
  const root = search.views()[0];
  assert.strictEqual(root.props.id, "search-content");
  assert.strictEqual(root.views[0].props.id, "search-header");
  assert.strictEqual(root.views[1].props.id, "search-list");
  assert.strictEqual(root.views[1].props.header, undefined);
  assert.match(String(root.views[1].layout), /HEADER_HEIGHT/);
});

test("version menu labels show readable versions without losing the external id", () => {
  installUiGlobals();
  global.$ui = { alert: () => {}, loading: () => {}, toast: () => {} };
  delete require.cache[require.resolve("../scripts/ui/detail")];
  const detail = require("../scripts/ui/detail");
  assert.strictEqual(
    detail.formatVersionLabel(
      { id: "813788990", displayVersion: "18.4.1", buildVersion: "123456" },
      true
    ),
    "v18.4.1 · 构建 123456 · 最新 · ID 813788990"
  );
  assert.strictEqual(
    detail.formatVersionLabel({ id: "813873796" }, false),
    "版本号未知 · ID 813873796"
  );
});
