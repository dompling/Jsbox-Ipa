const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setup, flush, pageViews } = require("./helpers/ui");
const format = require("../scripts/lib/format");

function allViews(view) {
  const props = view.props || {};
  return [view, ...[
    ...(view.views || []), ...(props.stack && props.stack.views || []),
    ...(props.header ? [props.header] : []), ...(props.items || []),
    ...(props.data || []).flatMap(section => section.rows || []),
  ].flatMap(allViews)];
}

const product = () => ({
  id: "42", name: "Camera", bundleID: "com.example.camera", version: "2.8", price: 0,
  artworkUrl: "https://example.test/icon.png", artistName: "Example Studio",
  sellerName: "Example Studio International 有限公司", averageUserRating: 4.7, userRatingCount: 12630,
  primaryGenreName: "摄影与录像", genres: ["摄影与录像", "工具"], fileSizeBytes: 24 * 1024 * 1024,
  releaseDate: "2026-08-20T12:00:00", minimumOsVersion: "16.0",
  releaseNotes: "新增相机功能。\n" + "修复拍摄和导出的问题。".repeat(25),
  description: "记录生活中的每个瞬间。\n\n" + "完整保留中文、English、📷 和段落。".repeat(50),
  screenshotUrls: ["https://example.test/preview-one.png", "https://example.test/preview-two.png"],
  raw: { contentAdvisoryRating: "4+", languageCodesISO2A: ["EN", "ZH"] },
});

function harness(app) {
  const h = setup();
  const common = h.load("ui/common.js");
  const pills = [], refreshes = [], releases = [], opened = [], historyRequests = [];
  const account = { email: "a@example.test", store: "CN" };
  const accounts = h.load("store/accounts.js");
  accounts.requireAccountForRegion = () => account;
  accounts.normalizeEmail = value => String(value).trim().toLowerCase();
  common.actionPill = (title, tapped, width, options) => {
    const definition = {
      type: "view", props: { id: `product-get-${pills.length}` },
      views: [{ type: "button", props: { title: title() }, layout: h.context.$layout.fill, events: { tapped } }],
    };
    pills.push({ definition, width, options, tapped });
    return definition;
  };
  common.refreshDownloadButtons = () => refreshes.push(true);
  common.releaseDownloadButtons = value => releases.push(value);
  h.context.$rect = (x, y, width, height) => ({ x, y, width, height });
  h.context.$scrollDirection = { vertical: 0, horizontal: 1 };
  h.context.$app = { openURL: value => opened.push(value) };
  h.context.$device = { info: { screen: { width: 320, height: 700 } } };
  const modules = {
    "../config": h.config,
    "./common": common,
    "../apple/store": { lookupByIds: async () => [app] },
    "../services/downloader": {
      listVersions: (...args) => { historyRequests.push(args); return new Promise(() => {}); },
    },
    "../store/accounts": accounts,
    "../store/settings": h.load("store/settings.js"),
    "./install": {},
    "../lib/format": format,
    "../lib/error": { errorMessage: value => String(value && value.message || value) },
    "../lib/cancellation": require("../scripts/lib/cancellation"),
  };
  const filename = path.resolve(__dirname, "../scripts/ui/detail.js");
  const module = { exports: {} };
  const run = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(filename, "utf8")}\n})`, h.context, { filename });
  run(name => {
    if (!(name in modules)) throw new Error(`unexpected detail dependency: ${name}`);
    return modules[name];
  }, module, module.exports);
  return {
    ...h, pills, refreshes, releases, opened, historyRequests,
    async show() { module.exports.show({ ...app, owned: true }, "CN"); await flush(); return h.pages.at(-1); },
  };
}

function constraints(view, width = 320, previousBottom = 76, height = 180) {
  const values = {};
  const chain = (properties = []) => new Proxy({}, {
    get: (_target, key) => ["equalTo", "inset", "offset", "lessThanOrEqualTo", "greaterThanOrEqualTo"].includes(key)
      ? value => { for (const property of properties) (values[property] ||= {})[key] = value; return chain(properties); }
      : chain(properties.concat(key)),
  });
  if (typeof view.layout === "function") view.layout(chain(), { super: { width, height, frame: { width, height } }, prev: { bottom: previousBottom } });
  return values;
}

// Resolve the explicit constraints on a control's ancestor path. This checks
// cell/parent bounds as UIKit hit testing does, not font rendering or UIKit itself.
function targetPath(view, predicate) {
  if (predicate(view)) return [view];
  for (const child of view.views || []) {
    const path = targetPath(child, predicate);
    if (path) return [view, ...path];
  }
  return null;
}

function targetBounds(h, list, label, width) {
  assert.equal(typeof list.events.rowHeight, "function", "native static cells need explicit row heights");
  for (const [sectionIndex, section] of list.props.data.entries()) {
    for (const [rowIndex, row] of section.rows.entries()) {
      const path = targetPath(row, view => view.type === "button" && view.props.accessibilityLabel === label);
      if (!path) continue;
      let parent = { x: 0, y: 0, width, height: list.events.rowHeight({ frame: { width } }, { section: sectionIndex, row: rowIndex }) };
      assert.ok(Number.isFinite(parent.height) && parent.height > 0);
      for (const view of path) {
        assert.notEqual(view.props.userInteractionEnabled, false);
        const c = constraints(view, parent.width, 0, parent.height);
        const value = key => c[key] && (c[key].inset ?? c[key].equalTo);
        const fills = view.layout === h.context.$layout.fill || c.edges;
        const size = c.size && c.size.equalTo || {};
        const w = fills ? parent.width : size.width ?? value("width") ?? parent.width - (value("left") || 0) - (value("right") || 0);
        const ht = fills ? parent.height : size.height ?? value("height") ?? parent.height - (value("top") || 0) - (value("bottom") || 0);
        const x = fills ? 0 : value("left") ?? parent.width - (value("right") || 0) - w;
        const y = fills ? 0 : value("top") ?? parent.height - (value("bottom") || 0) - ht;
        assert.ok(w > 0 && ht > 0, `${label}: every ancestor needs nonzero bounds`);
        assert.ok(x >= 0 && y >= 0 && x + w <= parent.width && y + ht <= parent.height,
          `${label}: visible control must fit its native cell/parent hit area at ${width}pt`);
        parent = { x: parent.x + x, y: parent.y + y, width: w, height: ht };
      }
      assert.ok(parent.width >= 44 && parent.height >= 44, `${label}: minimum tap size`);
      return { bounds: parent, button: path.at(-1) };
    }
  }
  assert.fail(`No reachable cell button: ${label}`);
}

test("native detail cells reserve actual hit areas and show each heading once", async () => {
  const h = harness(product());
  const page = await h.show();
  const list = pageViews(page)[0];
  assert.ok(list.props.data.every(section => !section.title), "system titles must be absent, not hidden by a zero-height hint");
  assert.ok(!allViews(list).some(view => view.type === "stack"), "body controls must not depend on ambiguous arranged-view heights");
  for (const heading of ["预览", "新内容", "简介", "信息"]) {
    assert.equal(allViews(list).filter(view => view.type === "label" && view.props.text === heading).length, 1);
  }
  for (const width of [320, 375, 430, 768]) {
    for (const label of ["历史版本", "查看完整简介", "查看完整更新内容"]) targetBounds(h, list, label, width);
  }
  const history = targetBounds(h, list, "历史版本", 320);
  await history.button.events.tapped({});
  assert.equal(h.pages.at(-1).props.title, "历史版本");
  assert.ok(allViews(h.pages.at(-1)).some(view => view.type === "spinner" && view.props.loading));
  assert.equal(h.historyRequests.length, 1);
});

test("native preview has a full-height horizontal viewport inside a sized cell", async () => {
  const h = harness(product());
  const page = await h.show();
  const list = pageViews(page)[0];
  const rowIndex = list.props.data[0].rows.findIndex(row => allViews(row).some(view => view.props && view.props.id === "detail-screenshots"));
  assert.ok(rowIndex >= 0);
  const row = list.props.data[0].rows[rowIndex];
  const strip = allViews(row).find(view => view.props && view.props.id === "detail-screenshots");
  assert.equal(strip.type, "scroll", "explicit scroll content avoids collection item/viewport inset conflicts");
  const viewport = constraints(strip);
  const rowHeight = list.events.rowHeight({ frame: { width: 320 } }, { section: 0, row: rowIndex });
  assert.ok(viewport.height.equalTo >= 300 && rowHeight >= viewport.height.equalTo);
  assert.equal(strip.props.contentSize.height, viewport.height.equalTo);
  assert.ok(strip.props.contentSize.width > 320);
  for (const preview of strip.views) {
    const frame = constraints(preview);
    assert.ok(frame.top.equalTo >= 0);
    assert.ok(frame.top.equalTo + frame.size.equalTo.height <= viewport.height.equalTo);
    assert.ok(frame.left.equalTo + frame.size.equalTo.width <= strip.props.contentSize.width);
    assert.ok(allViews(preview).some(view => view.type === "image" && /^https:/.test(view.props.src)));
  }
});

test("product detail has a prominent retained Get control, real overview, previews and content hierarchy", async () => {
  const app = product();
  const h = harness(app);
  const page = await h.show();
  const list = pageViews(page)[0];
  const views = allViews(list);
  assert.equal(list.type, "list");
  assert.equal(list.props.template, undefined);
  assert.notEqual(list.props.autoRowHeight, true);
  assert.equal(typeof list.events.rowHeight, "function");
  assert.ok(list.props.header);
  assert.equal(h.pills.length, 1);
  assert.equal(h.pills[0].options.app.id, app.id);
  assert.equal(h.pills[0].options.region, "CN");
  assert.equal(h.pills[0].options.prominent, true);
  assert.ok(h.pills[0].width >= 76 && h.pills[0].width <= 82);
  const headings = views.filter(view => view.type === "label").map(view => view.props.text);
  for (const heading of ["预览", "新内容", "简介", "信息"]) assert.ok(headings.includes(heading));
  assert.ok(headings.indexOf("预览") < headings.indexOf("新内容"));
  assert.ok(headings.indexOf("新内容") < headings.indexOf("简介"));
  assert.ok(!headings.includes("操作"));
  const overview = views.find(view => view.props && view.props.id === "detail-overview");
  assert.ok(overview, "actual product metadata should form a horizontal overview");
  const summary = allViews(overview).filter(view => view.type === "label").map(view => view.props.text);
  for (const value of ["4.7", "4+", "摄影与录像"]) assert.ok(summary.includes(value));
  assert.ok(summary.some(value => /1\.3万/.test(value)));
  assert.doesNotMatch(summary.join("\n"), /第.*名|排行榜|编辑推荐/);
  assert.equal(list.props.sectionTitleHeight, 0, "product headings are part of the content, not grouped-table chrome");
  const history = views.find(view => view.type === "button" && view.props.accessibilityLabel === "历史版本");
  assert.ok(history && history.events.tapped);
  assert.ok(h.pills[0].definition === allViews(list.props.header).find(view => view.props && view.props.id === "product-get-0"));
});

test("narrow product headers reserve distinct 44pt Get and App Store targets for long titles", async () => {
  for (const name of ["相机", "一款名称特别长的专业相机与照片编辑应用", "A Professional Camera With A Very Long Product Name"]) {
    const h = harness({ ...product(), name, artistName: "A developer whose name is also extremely long" });
    const page = await h.show();
    const header = pageViews(page)[0].props.header;
    const title = allViews(header).find(view => view.props && view.props.id === "detail-name");
    assert.equal(title.props.text, name);
    assert.ok(title.props.lines >= 2);
    const open = allViews(header).find(view => view.type === "button" && view.props.accessibilityLabel === "打开 App Store 页面");
    assert.ok(open);
    assert.equal(open.views[0].props.symbol, "arrow.up.right.square", "the external-link symbol must support the package's iOS 13 baseline");
    for (const width of [320, 375, 430]) {
      const get = constraints(h.pills[0].definition, width), store = constraints(open, width), heading = constraints(title, width);
      assert.ok(get.size.equalTo.height >= 44);
      assert.ok(store.size.equalTo.width >= 44 && store.size.equalTo.height >= 44);
      assert.ok(get.left.equalTo + get.size.equalTo.width <= width - store.right.inset - store.size.equalTo.width);
      assert.ok(heading.left.equalTo < width - heading.right.inset);
      assert.ok(header.props.height >= get.top.equalTo + get.size.equalTo.height + 16);
    }
    await open.events.tapped({});
    assert.deepEqual(h.opened, ["https://apps.apple.com/app/id42"]);
    page.events.appeared();
    page.events.appeared();
    assert.equal(h.pills.length, 1, "appearances must not replace the current Get/progress control");
    assert.equal(h.refreshes.length, 2);
    page.events.dealloc();
    assert.equal(h.releases[0], header);
  }
});

test("product surfaces and long metadata retain readable widths and wrapping", async () => {
  for (const category of ["摄影与录像", "Productivity and Creative Tools"]) {
    const app = { ...product(), primaryGenreName: category, genres: [category] };
    const h = harness(app);
    const page = await h.show();
    const list = pageViews(page)[0];
    const background = h.context.$color("systemBackground");
    assert.equal(page.props.bgcolor, background);
    assert.equal(page.props.barColor, background);
    assert.equal(list.props.bgcolor, background);
    assert.equal(list.props.header.props.bgcolor, background);
    const overview = allViews(list).find(view => view.props && view.props.id === "detail-overview");
    const categoryLabel = allViews(overview).find(view => view.type === "label" && view.props.text === category);
    assert.ok(categoryLabel);
    assert.ok(categoryLabel.props.font.at(-1) <= 16, "category text must not inherit large numeric typography");
    assert.equal(categoryLabel.props.lines, 2);
    assert.ok(constraints(categoryLabel).height.equalTo >= 34, "two text lines need more height than a single numeric value");
    for (const value of [app.sellerName, category]) {
      const rowIndex = list.props.data[0].rows.findIndex(row => allViews(row).some(view => view.type === "label" && view.props.text === value && view.props.lines === 0));
      const surface = list.props.data[0].rows[rowIndex];
      assert.equal(surface.props.bgcolor, background);
      const label = allViews(surface).find(view => view.type === "label" && view.props.text === value);
      assert.ok(label);
      assert.equal(label.props.lines, 0);
      for (const width of [320, 375, 430]) {
        const inner = constraints(label, width);
        assert.ok(width - inner.left.equalTo - inner.right.inset >= 168);
        assert.ok(inner.top && inner.bottom);
        assert.equal(inner.height, undefined, "long metadata values must not have a fixed clipping height");
        assert.ok(list.events.rowHeight({ frame: { width } }, { section: 0, row: rowIndex }) >= 48);
      }
    }
  }
});

test("screenshot carousel uses actual deduplicated URLs and opens the selected preview without autoplay", async () => {
  const app = product();
  app.screenshotUrls = [app.screenshotUrls[0], "javascript:invalid", app.screenshotUrls[0], app.screenshotUrls[1]];
  const h = harness(app);
  const page = await h.show();
  const strip = allViews(pageViews(page)[0]).find(view => view.props && view.props.id === "detail-screenshots");
  assert.ok(strip);
  assert.equal(strip.props.alwaysBounceVertical, false);
  assert.equal(strip.props.showsHorizontalIndicator, false);
  assert.equal(strip.views.length, 2);
  assert.ok(strip.views.every(view => view.props.cornerRadius >= 14 && view.props.clipsToBounds));
  strip.views[1].events.tapped({});
  const preview = h.pages.at(-1);
  assert.notEqual(preview, page);
  const gallery = allViews(preview).find(view => view.type === "gallery");
  assert.ok(gallery);
  assert.equal(gallery.props.page, 1);
  assert.equal(gallery.props.interval, 0);
  assert.deepEqual(allViews(gallery).filter(view => view.type === "image").map(view => view.props.src), [app.screenshotUrls[0], app.screenshotUrls[3]]);
  assert.ok(allViews(gallery).some(view => view.type === "scroll" && view.props.zoomEnabled));
});

test("description and release-note previews preserve the complete original text in readable pages", async () => {
  const app = product();
  const h = harness(app);
  const page = await h.show();
  for (const [label, text] of [["查看完整简介", app.description], ["查看完整更新内容", app.releaseNotes]]) {
    const views = allViews(pageViews(page)[0]);
    const preview = views.find(view => view.type === "label" && view.props.text === text);
    assert.ok(preview && preview.props.lines > 0 && preview.props.lines <= 4);
    const more = targetBounds(h, pageViews(page)[0], label, 320).button;
    assert.ok(constraints(more).height.equalTo >= 44);
    more.events.tapped({});
    const reader = allViews(h.pages.at(-1)).find(view => view.type === "text");
    assert.ok(reader);
    assert.equal(reader.props.text, text);
    assert.equal(reader.props.editable, false);
    assert.equal(reader.props.selectable, true);
  }
  page.events.appeared();
  assert.equal(h.pills.length, 1);
});

test("sparse products omit unknown metadata and empty previews while keeping real actions", async () => {
  const h = harness({ id: "42", name: "Sparse App", price: null });
  const page = await h.show();
  const views = allViews(pageViews(page)[0]);
  assert.equal(views.some(view => view.props && view.props.id === "detail-screenshots"), false);
  assert.equal(views.some(view => view.props && view.props.id === "detail-overview"), false);
  const text = views.filter(view => view.type === "label").map(view => view.props.text).join("\n");
  assert.doesNotMatch(text, /暂无评分|0 B|预览|简介|新内容|4\+|年龄|第.*名|条评分/);
  assert.ok(views.some(view => view.type === "button" && view.props.accessibilityLabel === "历史版本"));
  assert.ok(views.some(view => view.type === "button" && view.props.accessibilityLabel === "打开 App Store 页面"));
});

test("iPad screenshot fallback and real age/language fields are read without inventing absent data", async () => {
  const h = harness({
    id: "42", name: "iPad App", screenshotUrls: [],
    raw: { ipadScreenshotUrls: ["https://example.test/ipad.png"], trackContentRating: "12+", languageCodesISO2A: ["EN"] },
  });
  const page = await h.show();
  const views = allViews(pageViews(page)[0]);
  const strip = views.find(view => view.props && view.props.id === "detail-screenshots");
  assert.ok(strip && strip.views.length === 1);
  const text = views.filter(view => view.type === "label").map(view => view.props.text).join("\n");
  assert.match(text, /12\+/);
  assert.match(text, /EN|英语/);
  assert.doesNotMatch(text, /0 B|暂无评分|4\.7/);
});

test("detail measures long text at the current list width and resizes without replacing Get", async () => {
  const app = { ...product(), sellerName: product().sellerName.repeat(10) };
  const h = harness(app);
  const measurements = [];
  h.context.$text = {
    sizeThatFits(options) {
      measurements.push(options);
      return { width: options.width, height: Math.ceil(options.text.length * 8 / options.width) * 20 };
    },
  };
  const page = await h.show();
  const list = pageViews(page)[0];
  const originalHeader = list.props.header;
  const row = list.props.data[0].rows.findIndex(value => allViews(value).some(view => view.props && view.props.text === app.sellerName));
  const height = width => list.events.rowHeight({ frame: { width } }, { section: 0, row });
  assert.ok(height(320) > height(768), "split-screen width must determine metadata wrapping");
  assert.deepEqual(measurements.filter(value => value.text === app.sellerName).map(value => value.width), [176, 624]);
  let reloads = 0;
  const sender = { frame: { width: 320 }, reload() { reloads++; list.events.layoutSubviews(sender); } };
  list.events.layoutSubviews(sender);
  list.events.layoutSubviews(sender);
  assert.equal(reloads, 1, "unchanged width must not trigger a reload loop");
  sender.frame.width = 768;
  list.events.layoutSubviews(sender);
  assert.equal(reloads, 2);
  assert.equal(h.pills.length, 1);
  assert.equal(list.props.header, originalHeader);
  assert.doesNotThrow(() => list.events.layoutSubviews({ frame: { width: 430 } }), "older runtime wrappers without reload must still open the page");
  for (const label of ["查看完整简介", "查看完整更新内容"]) {
    const { bounds } = targetBounds(h, list, label, 320);
    assert.ok(bounds.y > 0, "full text must leave a separate 44pt action below the preview");
  }
});
