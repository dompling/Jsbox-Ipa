const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, flatten, flush, deferred } = require("./helpers/ui");

// This evaluates declared constraints only; it is not a UIKit layout engine.
function box(definition, width, height = 100) {
  const values = {};
  function chain(properties) {
    return new Proxy({}, {
      get: (_target, method) => {
        if (["equalTo", "inset", "offset", "dividedBy", "lessThanOrEqualTo", "priority"].includes(method)) {
          return (value) => {
            for (const property of properties) {
              const entry = values[property] || (values[property] = {});
              if (method === "equalTo") entry.value = value;
              else if (method === "inset") entry.inset = value;
              else if (method === "offset") entry.value += value;
              else if (method === "dividedBy") entry.value /= value;
              else if (method === "lessThanOrEqualTo") entry.maximum = value;
            }
            return chain(properties);
          };
        }
        return chain(properties.concat(method));
      },
    });
  }
  definition.layout(chain([]), { super: { width, height, left: 0, right: width } });
  const dimension = (name, parent, start, end) => {
    const entry = values[name] || {};
    const measured = entry.value !== undefined ? entry.value
      : values.size ? values.size.value[name]
        : parent - (values[start] && values[start].inset || 0) - (values[end] && values[end].inset || 0);
    return Math.min(measured, entry.maximum === undefined ? Infinity : entry.maximum);
  };
  const w = dimension("width", width, "left", "right");
  const h = dimension("height", height, "top", "bottom");
  const left = values.left ? values.left.inset ?? values.left.value
    : values.right ? width - (values.right.inset || 0) - w : 0;
  return { width: w, height: h, left, right: left + w, values };
}

test("all shared App cards have an inset inner surface and separate detail/download actions", async () => {
  const h = setup();
  const common = h.load("ui/common.js");
  for (const build of [
    (app, actions) => common.appRowView(app, "Bundle ID", actions),
    (app, actions) => common.chartRowView(app, 0, actions),
    (app, actions) => common.editorialRowView(app, actions),
  ]) {
    let viewed = 0;
    let downloaded = 0;
    const row = build({ id: "42", name: "Demo", price: 0 }, { onView: () => viewed++, onGet: () => downloaded++ });
    assert.equal(row.props.cornerRadius, undefined, "the static cell itself is transparent");
    assert.equal(row.props.selectable, false);
    assert.equal(row.props.bgcolor, 'color:"clear"');
    const card = row.views[0];
    assert.equal(card.props.cornerRadius, 16);
    assert.equal(card.props.smoothCorners, true);
    const shape = box(card, 320);
    assert.equal(shape.left, 16);
    assert.equal(shape.width, 288);
    const buttons = flatten(row).filter((view) => view.type === "button");
    assert.equal(buttons.length, 2);
    const viewAction = buttons.find((view) => !view.props.title);
    const getAction = buttons.find((view) => view.props.title);
    viewAction.events.tapped();
    await getAction.events.tapped({});
    assert.equal(viewed, 1);
    assert.equal(downloaded, 1);
  }
});

test("paid and unknown-price shared App actions reach the existing-license flow", async () => {
  const h = setup();
  const common = h.load("ui/common.js");
  for (const price of [12, undefined, null]) {
    for (const build of [
      (app, actions) => common.appRowView(app, "", actions),
      (app, actions) => common.chartRowView(app, 0, actions),
      (app, actions) => common.editorialRowView(app, actions),
    ]) {
      let attempts = 0;
      const row = build({ id: "42", name: "Demo", price }, { onGet: () => attempts++ });
      const button = flatten(row).find((view) => view.type === "button" && view.props.title);
      assert.ok(button, `price=${price} must not remove the action before checking the license`);
      await button.events.tapped({});
      assert.equal(attempts, 1);
    }
  }
});

test("download actions declare a 44pt hit area and two-line subtitles have enough height", async () => {
  const h = setup();
  const common = h.load("ui/common.js");
  for (const row of [
    common.appRowView({ name: "Demo" }, "", { onGet() {} }),
    common.chartRowView({ name: "Demo" }, 0, { onGet() {} }),
    common.editorialRowView({ name: "Demo", artistName: "A long developer name" }, { onGet() {} }),
  ]) {
    const wrapper = flatten(row).find((view) => (view.views || []).some((child) => child.type === "canvas"));
    const dimensions = box(wrapper, 288);
    assert.ok(dimensions.height >= 44);
    const button = wrapper.views.find((view) => view.type === "button");
    assert.ok(box(button, dimensions.width, dimensions.height).height >= 44);
  }
  const row = common.editorialRowView({ name: "Demo", artistName: "A long developer name" });
  const subtitle = flatten(row).find((view) => view.props.text === "A long developer name");
  assert.equal(subtitle.props.lines, 2);
  assert.ok(box(subtitle, 288).height >= 32);
  const home = h.mountTab("home");
  home.mount();
  await flush();
  const list = h.nodes.get("home-list").definition;
  const card = list.props.data[0].rows[0].views[0];
  const height = box(card.views[1], 288).height;
  assert.ok(height >= 104, "the embedded editorial row must contain both subtitle lines");
});

test("home modules keep one responsive rounded surface around contiguous header, apps and footer", async () => {
  const h = setup();
  h.store.fetchChart = async () => ["42", "43", "44"].map((id) => ({ id, name: `App ${id}`, price: 0 }));
  const home = h.mountTab("home");
  home.mount();
  await flush();
  const list = h.nodes.get("home-list").definition;
  const module = list.props.data[0];
  assert.equal(module.rows.length, 1);
  const root = module.rows[0];
  const card = root.views[0];
  const surfaces = flatten(root).filter((view) => view.type === "view" && view.props.bgcolor === h.load("ui/common.js").colors.card);
  assert.equal(surfaces.length, 1, "individual App rows must not draw separate card backgrounds");
  assert.equal(card.props.cornerRadius, 16);
  assert.equal(card.props.clipsToBounds, true);
  assert.equal(card.views.length, 5, "heading, three Apps and footer belong to the same card");
  const rowHeight = list.events.rowHeight(null, { section: 0, row: 0 });
  for (const width of [320, 375, 430]) {
    const surface = box(card, width, rowHeight);
    assert.equal(surface.left, 16);
    assert.equal(surface.right, width - 16);
    assert.equal(surface.values.top.inset, 178);
    assert.equal(surface.values.bottom.inset, 8);
    let bottom = 0;
    for (const content of card.views) {
      const frame = box(content, surface.width, surface.height);
      assert.equal(content.props.bgcolor, 'color:"clear"');
      assert.equal(content.props.cornerRadius, 0);
      assert.equal(frame.left, 0);
      assert.equal(frame.width, surface.width);
      assert.equal(frame.values.top.value, bottom, "module rows meet without inter-row card gaps");
      bottom += frame.height;
    }
    assert.equal(bottom, surface.height, "the static cell height contains the complete module");
  }
});

test("home removes status copy and gives each chart its own first-place hero", async () => {
  const h = setup();
  h.config.CHART_KINDS = require("../scripts/config").CHART_KINDS;
  const apps = Object.fromEntries(h.config.CHART_KINDS.map((kind, index) => [kind.key, {
    id: String(index + 101), name: `${kind.title} App`, artistName: `Maker ${index}`,
    artworkUrl: `https://example.test/${kind.key}.png`, price: index,
  }]));
  h.store.fetchChart = async (kind) => [apps[kind], { id: "999", name: "Second" }];
  h.store.lookupByIds = async (ids) => ids.map((id) => Object.values(apps).find((app) => app.id === id) || { id, name: "Second" });
  const home = h.mountTab("home");
  home.mount();
  await flush();
  const list = h.nodes.get("home-list").definition;
  assert.equal(list.props.header.props.height, 64, "removing the status copy must also remove its space");
  assert.equal(list.props.header.views.length, 2, "only the title and region selector remain in the header");
  assert.equal(flatten(list).some((view) => view.props.id === "home-subtitle"), false);
  assert.equal(flatten(list).some((view) => /已加载.*榜单|免费 App 可下载 IPA|OTA 为实验功能/.test(view.props.text || "")), false);
  const heroIDs = new Set();
  const heroColors = new Set();
  for (const [index, kind] of h.config.CHART_KINDS.entries()) {
    const section = list.props.data[index];
    const root = section.rows[0];
    const hero = root.views.find((view) => view.props.id === `home-hero-${kind.key}`);
    assert.ok(hero, `${kind.title} must have its own first-place card`);
    assert.equal(section.rows.length, 1, "the banner and grouped App list stay in the same module");
    heroIDs.add(hero.props.id);
    heroColors.add(hero.props.bgcolor);
    assert.equal(flatten(hero).find((view) => view.props.id.endsWith("-name")).props.text, apps[kind.key].name);
    assert.equal(flatten(hero).find((view) => view.props.id.endsWith("-icon")).props.src, apps[kind.key].artworkUrl);
    assert.equal(flatten(hero).find((view) => view.props.id.endsWith("-subtitle")).props.text, apps[kind.key].artistName);
    const button = hero.views.find((view) => view.type === "button");
    button.events.tapped();
    assert.equal(h.details.at(-1)[0].id, apps[kind.key].id);
    assert.equal(h.details.at(-1)[1], "CN");
    const body = root.views[0];
    for (const width of [320, 375, 430]) {
      const height = list.events.rowHeight(null, { section: index, row: 0 });
      const bannerFrame = box(hero, width, height);
      const bodyFrame = box(body, width, height);
      assert.equal(bannerFrame.left, 16);
      assert.equal(bannerFrame.right, width - 16);
      assert.equal(bannerFrame.height, 154);
      assert.equal(bodyFrame.values.top.inset - bannerFrame.values.top.inset - bannerFrame.height, 16,
        "leave one consistent gap between the hero and its grouped list");
    }
  }
  assert.equal(heroIDs.size, 3);
  assert.equal(heroColors.size, 3, "the actual free, paid and grossing charts use distinct colors");
});

test("chart heroes follow retries and region changes without borrowing another chart's App", async () => {
  const h = setup();
  h.config.CHART_KINDS = [
    { key: "free", title: "免费榜" },
    { key: "paid", title: "付费榜" },
    { key: "grossing", title: "畅销榜" },
  ];
  let offline = true;
  const nextRegion = deferred();
  h.store.fetchChart = async (kind, region) => {
    if (region === "US") {
      await nextRegion.promise;
      if (kind === "paid") return [];
    } else if (kind === "paid" && offline) throw new Error("offline");
    return [{ id: `${kind}-${region}`, name: `${kind} ${region}` }];
  };
  h.store.lookupByIds = async (ids) => ids.map((id) => ({ id, name: id.replace("-", " ") }));
  const home = h.mountTab("home");
  home.mount();
  await flush();
  const list = () => h.nodes.get("home-list").definition;
  const hero = (kind) => flatten(list()).find((view) => view.props.id === `home-hero-${kind}`);
  assert.ok(hero("free"));
  assert.ok(hero("grossing"));
  assert.equal(hero("paid"), undefined);
  const retry = flatten(list().props.data[1].rows[0]).find((view) => view.type === "button");
  offline = false;
  retry.events.tapped();
  await flush();
  assert.equal(flatten(hero("paid")).find((view) => view.props.id.endsWith("-name")).props.text, "paid CN");
  h.switchAccount("example@example.test", "US");
  home.mount();
  for (const kind of h.config.CHART_KINDS) assert.equal(hero(kind.key), undefined,
    "old-region first-place cards disappear while the new chart loads");
  nextRegion.resolve();
  await flush();
  assert.equal(hero("paid"), undefined, "an empty chart must not display another chart's first App");
  for (const kind of ["free", "grossing"]) {
    const card = hero(kind);
    assert.equal(flatten(card).find((view) => view.props.id.endsWith("-name")).props.text, `${kind} US`);
    card.views.find((view) => view.type === "button").events.tapped();
    assert.equal(h.details.at(-1)[0].id, `${kind}-US`);
    assert.equal(h.details.at(-1)[1], "US");
  }
});

test("search filters fit 320, 375 and 430pt canvases with 44pt actions", () => {
  const h = setup();
  const root = h.load("ui/search.js").views()[0];
  const all = flatten(root);
  const segment = all.find((view) => view.props.id === "type-segment");
  const region = all.find((view) => view.props.id === "region-btn");
  for (const width of [320, 375, 430]) {
    const left = box(segment, width);
    const right = box(region, width);
    assert.ok(right.left - left.right >= 8, `${width}pt must have a gap between filters`);
    assert.ok(right.right <= width - 16);
    assert.ok(right.height >= 44);
    for (const button of segment.views) assert.ok(box(button, left.width, left.height).height >= 44);
  }
});
