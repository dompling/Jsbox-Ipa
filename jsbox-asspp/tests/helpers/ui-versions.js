const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { children, flatten, deferred, flush, pageViews } = require("./ui");

const app = { id: "42", bundleID: "com.example.history", name: "History Demo", price: 0, version: "3.0" };
const clone = value => JSON.parse(JSON.stringify(value));

function version(id, displayVersion = "", extra = {}) {
  return {
    id: String(id), requestedExternalVersionId: String(id), externalVersionId: String(id),
    displayVersion, buildVersion: "", ...extra,
  };
}

function snapshot(versions, resolvedIds, options = {}) {
  return Object.freeze({
    versions: Object.freeze(versions.map(value => Object.freeze({ ...value }))),
    resolvedIds: Object.freeze(resolvedIds.slice()),
    resolvedCount: resolvedIds.length,
    totalCount: versions.length,
    latest: options.latest === undefined ? String(versions[0] && versions[0].id || "") : options.latest,
    complete: options.complete === undefined ? resolvedIds.length === versions.length : options.complete,
  });
}

function result(versions = [], latest = "") {
  return { versions, latest, identifiers: versions.map(value => value.id), updatedCookies: [] };
}

function setup(t, options = {}) {
  const nodes = new Map();
  const mounted = new WeakMap();
  const roots = new Map();
  const pages = [], requests = [], downloads = [], opens = [], completions = [];
  const alerts = [], toasts = [], loading = [], delays = [], events = [], accountReads = [], libraryReads = [];
  const records = new Map();
  const initialAccount = {
    email: "history@example.test", store: "CN", passwordToken: "synthetic-initial",
    cookies: [{ name: "session", value: "initial", domain: "itunes.apple.com", path: "/" }],
  };
  let region = "CN";
  let activeEmail = initialAccount.email;
  const stored = new Map([[activeEmail, clone(initialAccount)]]);
  const normalizeEmail = email => String(email || "").trim().toLowerCase();
  function readAccount(method, email) {
    const value = stored.get(normalizeEmail(email));
    accountReads.push({ method, email: normalizeEmail(email), account: value ? clone(value) : null });
    return value ? clone(value) : null;
  }
  const accounts = {
    normalizeEmail,
    accountRegion: value => String(value && value.store || "").toUpperCase(),
    getAccount: email => readAccount("getAccount", email),
    accountForRegion: code => {
      const value = readAccount("accountForRegion", activeEmail);
      return value && value.store === String(code).toUpperCase() ? value : null;
    },
    requireAccountForRegion: code => {
      const value = readAccount("requireAccountForRegion", activeEmail);
      if (!value || value.store !== String(code).toUpperCase()) throw new Error("synthetic missing account");
      return value;
    },
  };
  const downloader = {
    listVersions: (owner, soft, settings) => {
      const pending = deferred();
      requests.push({ owner, app: soft, options: settings, ...pending });
      events.push({ type: "enumeration", owner });
      return pending.promise;
    },
    downloadVersion: (owner, soft, id, settings) => {
      const pending = deferred();
      downloads.push({ owner, app: soft, id, options: settings, ...pending });
      events.push({ type: "download", owner, id });
      return pending.promise;
    },
    downloadApp: () => { throw new Error("unexpected latest-version download"); },
  };
  const base = path.resolve(__dirname, "../../scripts");
  const mocks = new Map(Object.entries({
    "store/accounts.js": accounts,
    "store/settings.js": { region: () => region },
    "services/downloader.js": downloader,
    "apple/store.js": { lookupByIds: async () => [{ ...app }] },
    "store/library.js": {
      findDownloaded: (soft, wanted) => {
        libraryReads.push({ app: soft, version: wanted && { ...wanted } });
        const candidates = Array.from(records.values()).filter(record => record.appId === String(soft.id));
        return candidates.find(record => !wanted || record.externalVersionId === String(wanted.externalVersionId)) || null;
      },
    },
    "ui/downloads.js": { fileActions: fileName => { opens.push(fileName); return true; } },
    "ui/install.js": { downloadComplete: (...args) => completions.push(args) },
  }).map(([file, value]) => [path.join(base, file), value]));

  function descendants(node) {
    return node.children.flatMap(child => [child, ...descendants(child)]);
  }
  function remove(node) {
    for (const child of node.children.slice()) remove(child);
    if (node.id && nodes.get(node.id) === node) nodes.delete(node.id);
    if (node.super) node.super.children = node.super.children.filter(child => child !== node);
  }
  function mount(definition, parent) {
    const props = definition.props || {};
    const node = {
      ...props, definition, super: parent, children: [], dataWrites: 0,
      contentOffset: { x: 0, y: 0, ...props.contentOffset },
      add: value => mount(value, node),
      remove: () => remove(node),
      moveToFront: () => {
        if (!node.super) return;
        node.super.children = node.super.children.filter(child => child !== node);
        node.super.children.push(node);
      },
      get: id => descendants(node).find(child => child.id === id) || null,
      reload() {},
    };
    if (parent) parent.children.push(node);
    if (node.id) nodes.set(node.id, node);
    mounted.set(definition, node);
    if (definition.type === "list") {
      let data = [], rowNodes = [], headerNode = null, initialized = false;
      Object.defineProperty(node, "data", {
        get: () => data,
        set: value => {
          node.dataWrites++;
          data = value;
          // Older JSBox runtimes materialize static view rows on construction,
          // but a later data assignment/reload can leave the old native cells.
          if (!initialized || options.staticCellsOnCreateOnly === false) {
            rowNodes.forEach(remove);
            rowNodes = (value || []).flatMap(section => section.rows || [])
              .filter(row => row.type).map(row => mount(row, node));
          }
          node.contentOffset = { x: 0, y: 0 };
        },
      });
      Object.defineProperty(node, "header", {
        get: () => headerNode && headerNode.definition,
        set: value => {
          if (headerNode) remove(headerNode);
          headerNode = value ? mount(value, node) : null;
        },
      });
      node.header = props.header;
      node.data = props.data || [];
      initialized = true;
    } else {
      for (const child of children(definition)) mount(child, node);
    }
    const deferReady = options.deferHistoryReady && /^versions-list-/.test(node.id || "");
    if (!deferReady && definition.events && definition.events.ready) definition.events.ready(node);
    if (definition.events && definition.events.layoutSubviews) definition.events.layoutSubviews(node);
    return node;
  }
  function push(page) {
    events.push({ type: "push", title: page.props.title });
    pages.push(page);
    roots.set(page, mount({ type: "view", props: page.props, views: page.views }));
  }
  const globals = {
    $color: value => `color:${JSON.stringify(value)}`,
    $font: (...args) => args,
    $align: { left: 0, center: 1, right: 2 },
    $size: (width, height) => ({ width, height }),
    $point: (x, y) => ({ x, y }),
    $insets: (top, left, bottom, right) => ({ top, left, bottom, right }),
    $layout: { fill() {} },
    $alertActionType: { destructive: 1 },
    $: id => nodes.get(id) || null,
    $ui: {
      get: id => nodes.get(id) || null,
      push,
      loading: value => loading.push(value),
      alert: value => alerts.push(value),
      toast: value => toasts.push(value),
    },
    setTimeout: () => 1,
  };
  if (options.delay !== false) globals.$delay = (seconds, callback) => delays.push({ seconds, callback });
  const context = vm.createContext(globals);
  const cache = new Map();
  function load(file) {
    const absolute = path.isAbsolute(file) ? file : path.join(base, file);
    if (mocks.has(absolute)) return mocks.get(absolute);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const run = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(absolute, "utf8")}\n})`, context, { filename: absolute });
    run(name => load(path.resolve(path.dirname(absolute), `${name}.js`)), module, module.exports);
    return module.exports;
  }
  function history(page = pages.at(-1)) {
    const listId = pageViews(page)[0].props.id;
    const suffix = listId.replace(/^versions-list-/, "");
    const nativeList = () => roots.get(page).get(listId);
    const list = () => nativeList().definition;
    return {
      page, suffix,
      get list() { return list(); },
      get nativeList() { return nativeList(); },
      rows: () => Array.from(list().props.data.flatMap(section => section.rows || [])),
      nativeRows: () => nativeList().children.filter(node => node.definition !== nativeList().header),
      node: (part, id) => nodes.get(`versions-${part}-${suffix}${id === undefined ? "" : `-${id}`}`),
      row: id => list().props.data.flatMap(section => section.rows || []).find(row =>
        flatten(row).some(view => view.props && view.props.id === `versions-title-${suffix}-${id}`)),
    };
  }
  function button(row) {
    const definition = flatten(row).find(view => view.type === "button" && /^download-action-/.test(view.props.id || ""));
    const progress = flatten(row).find(view => view.type === "canvas");
    const spinner = flatten(row).find(view => view.type === "spinner");
    const sender = mounted.get(definition);
    return { definition, sender, progress: mounted.get(progress), spinner: mounted.get(spinner), tap: () => definition.events.tapped(sender) };
  }
  t.after(() => {
    pages.forEach(page => { if (page.events && page.events.dealloc) page.events.dealloc(); });
    requests.forEach(request => request.resolve(result()));
    downloads.forEach(download => download.resolve(null));
  });
  return {
    app, nodes, mounted, pages, requests, downloads, opens, completions, alerts, toasts,
    loading, delays, events, accountReads, libraryReads, accounts, downloader, initialAccount,
    load, history, button,
    async showDetail() { load("ui/detail.js").show({ ...app }, "CN"); await flush(); return pages.at(-1); },
    selectVersions(page = pages.at(-1)) {
      const list = pageViews(page)[0];
      const action = flatten(list).find(view => view.type === "button" && view.props.accessibilityLabel === "历史版本");
      if (!action) throw new Error("missing detail history action");
      action.events.tapped(mounted.get(action));
      return history();
    },
    runDelays() { delays.splice(0).forEach(({ callback }) => callback()); },
    switchAccount(email, nextRegion = region) {
      activeEmail = normalizeEmail(email);
      region = nextRegion;
      if (email && !stored.has(activeEmail)) stored.set(activeEmail, { ...clone(initialAccount), email: activeEmail, store: nextRegion });
    },
    saveAccount(value) { stored.set(normalizeEmail(value.email), clone(value)); },
    saveVersion(id, displayVersion = "") {
      const record = { appId: app.id, externalVersionId: String(id), version: displayVersion, fileName: `42-${id}.ipa` };
      records.set(String(id), record);
      return record;
    },
    cover(page) {
      const root = roots.get(page);
      const hidden = [root, ...descendants(root)].filter(node => node.id && nodes.get(node.id) === node);
      hidden.forEach(node => nodes.delete(node.id));
      return () => hidden.forEach(node => nodes.set(node.id, node));
    },
  };
}

module.exports = { setup, version, snapshot, result, deferred, flush, clone };
