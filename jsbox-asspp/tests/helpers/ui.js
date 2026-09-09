const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function children(definition) {
  const props = definition.props || {};
  return [
    ...(definition.views || []),
    ...(props.stack && props.stack.views || []),
    ...(props.header ? [props.header] : []),
    ...(props.data || []).flatMap((section) => section.rows || []),
  ];
}

function flatten(definition) {
  return [definition, ...children(definition).flatMap(flatten)];
}

function pageViews(page) {
  const views = page && page.views || [];
  const content = views.find(view => /^navigation-content-/.test(view.props && view.props.id || ""));
  return content ? content.views : views;
}

function setup(extraMocks = {}) {
  const nodes = new Map();
  const lookups = [];
  const pages = [];
  const requests = [];
  const downloads = [];
  const details = [];
  const toasts = [];
  const animations = [];
  const removals = [];
  const downloaded = new Set();
  let region = "CN";
  let account = { email: "a@example.test", store: "CN" };
  const config = {
    CHART_KINDS: [{ key: "topfree", title: "免费榜" }],
    SEARCH_ENTITIES: [{ key: "software", title: "iPhone" }, { key: "iPadSoftware", title: "iPad" }],
    COUNTRY_STORE_MAP: { CN: "143465", US: "143441" },
  };
  const store = {
    fetchChart: async () => [{ id: "42", name: "Demo", price: 0 }],
    lookupByIds: async (ids) => ids.map((id) => ({ id, name: `App ${id}`, price: 0 })),
    searchApps: async () => [{ id: "42", name: "Demo", price: 0 }],
  };
  const settings = { region: () => region, setRegion: (value) => { region = value; }, chartLimit: () => 50 };
  const accountStore = {
    accountForRegion: () => account,
    accountRegion: (value) => value.store,
    listAccounts: () => account ? [account] : [],
  };
  const base = path.resolve(__dirname, "../../scripts");
  const mocks = new Map(Object.entries({
    "config.js": config,
    "store/settings.js": settings,
    "store/accounts.js": accountStore,
    "store/library.js": { findDownloaded: (app) => downloaded.has(app.id) ? { fileName: `${app.id}.ipa` } : null },
    "lib/error.js": { errorMessage: (error) => error.message || String(error) },
    "lib/format.js": { formatDate: String, formatPrice: (value) => `$${value}` },
    "apple/store.js": store,
    "apple/purchases.js": { listOwnedApps: (owner, options) => {
      const pending = deferred();
      requests.push({ owner, options, ...pending });
      return pending.promise;
    } },
    "ui/detail.js": {
      show: (...args) => details.push(args),
      downloadApp: (...args) => { downloads.push(args); return true; },
    },
    "ui/downloads.js": { views: () => [], mount() {}, fileActions() {} },
    "ui/settings.js": { views: () => [], mount() {} },
    ...extraMocks,
  }).map(([file, value]) => [path.join(base, file), value]));

  function remove(node) {
    for (const child of node.children.slice()) remove(child);
    if (node.id && nodes.get(node.id) === node) nodes.delete(node.id);
    if (node.super) node.super.children = node.super.children.filter((child) => child !== node);
  }
  function mount(definition, parent) {
    const node = {
      ...definition.props,
      definition,
      super: parent,
      children: [],
      contentOffset: { x: 0, y: 0, ...(definition.props && definition.props.contentOffset) },
      add: (value) => mount(value, node),
      remove: () => { removals.push(node.id); remove(node); },
      reload() {},
      blur() {},
      get: (id) => descendants(node).find((child) => child.id === id) || null,
    };
    if (parent) parent.children.push(node);
    if (node.id) nodes.set(node.id, node);
    for (const child of children(definition)) mount(child, node);
    if (definition.events && definition.events.ready) definition.events.ready(node);
    if (definition.events && definition.events.layoutSubviews) definition.events.layoutSubviews(node);
    return node;
  }
  function descendants(node) {
    return node.children.flatMap((child) => [child, ...descendants(child)]);
  }
  function showPage(definition) {
    pages.push(definition);
    return mount({ type: "view", props: definition.props, views: definition.views || [] });
  }
  const context = vm.createContext({
    $color: (value) => `color:${JSON.stringify(value)}`,
    $font: (...args) => args,
    $align: { left: 0, center: 1, right: 2 },
    $size: (width, height) => ({ width, height }),
    $point: (x, y) => ({ x, y }),
    $insets: (top, left, bottom, right) => ({ top, left, bottom, right }),
    $layout: { fill: () => {} },
    $kbType: { search: 1 },
    $: (id) => nodes.get(id) || null,
    $ui: {
      get: (id) => { lookups.push(id); return nodes.get(id) || null; },
      push: showPage,
      render: showPage,
      toast: (value) => toasts.push(value),
      animate: (value) => { animations.push(value); value.animation(); },
      loading() {},
      alert() {},
    },
    setTimeout: () => 1,
  });
  const cache = new Map();
  function load(file) {
    const absolute = path.isAbsolute(file) ? file : path.join(base, file);
    if (mocks.has(absolute)) return mocks.get(absolute);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const run = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(absolute, "utf8")}\n})`, context, { filename: absolute });
    run((name) => load(path.resolve(path.dirname(absolute), `${name}.js`)), module, module.exports);
    return module.exports;
  }
  function mountTab(name) {
    const page = load(`ui/${name}.js`);
    mount({ type: "view", props: { id: `screen-${name}` }, views: page.views() });
    return page;
  }
  function refreshedIds() {
    lookups.length = 0;
    load("ui/common.js").refreshDownloadButtons();
    return lookups.filter((id) => id.startsWith("download-action-"));
  }
  return {
    nodes, pages, requests, downloads, details, toasts, animations, removals, downloaded,
    config, store, load, mount, mountTab, refreshedIds, context,
    switchAccount(email, nextRegion = region) { account = email ? { email, store: nextRegion } : null; region = nextRegion; },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { setup, children, flatten, pageViews, deferred, flush };
