// App Store 已购页面：显示 Apple 账号购买记录，而不是本地下载文件。

const common = require("./common");
const navigation = require("./navigation");
const settings = require("../store/settings");
const accountsStore = require("../store/accounts");
const purchasedCache = require("../store/purchased-cache");
const purchases = require("../apple/purchases");
const format = require("../lib/format");

const C = common.colors;
const PAGE_SIZE = 20;
const HEADER_HEIGHT = 64;
const APP_ROW_HEIGHT = 120;
let requestSeq = 0;
let querySeq = 0;
let searchTimer = null;
let currentListDefinition = null;
let pendingData = null;
let pendingResetScroll = false;
let pendingAppCount = 0;
let renderedList = null;
let rowSeq = 0;
let navigationBinding = null;

const state = {
  initialized: false,
  accountKey: "",
  rows: [],
  region: "",
  loading: false,
  enriching: false,
  appending: false,
  complete: false,
  cacheStale: false,
  totalCount: 0,
  enrichedIds: new Set(),
  updatedAt: 0,
  visibleLimit: PAGE_SIZE,
  term: "",
  error: "",
  metadataError: "",
  floating: true,
};

function currentAccount() {
  const region = settings.region();
  return {
    account: accountsStore.accountForRegion(region),
    region: String(region || "").trim().toUpperCase(),
  };
}

function accountKey(current) {
  return `${String(current.account && current.account.email || "").trim().toLowerCase()}|${current.region}`;
}

function navigationButton() {
  const current = currentAccount();
  return navigation.accountButton(current.account, current.region, chooseAccount, "切换已购账号");
}

function requestIsCurrent(token, key) {
  return token === requestSeq && state.accountKey === key && accountKey(currentAccount()) === key;
}

function statusRow(title, subtitle, action) {
  const views = [
    {
      type: "image",
      props: { symbol: "bag.fill", tintColor: C.blue, contentMode: 1 },
      layout: (make, view) => {
        make.centerX.equalTo(view.super);
        make.top.equalTo(22);
        make.size.equalTo($size(28, 28));
      },
    },
    {
      type: "label",
      props: {
        text: title,
        font: $font("bold", 17),
        textColor: C.label,
        align: $align.center,
        lines: 1,
      },
      layout: (make, view) => {
        make.left.right.inset(18);
        make.top.equalTo(62);
        make.height.equalTo(24);
      },
    },
    {
      type: "label",
      props: {
        text: subtitle,
        font: $font(12),
        textColor: action ? C.blue : C.sub,
        align: $align.center,
        lines: 4,
      },
      layout: (make, view) => {
        make.left.right.inset(24);
        make.top.equalTo(92);
        make.height.equalTo(66);
      },
    },
  ];
  if (action) {
    views.push({
      type: "button",
      props: { bgcolor: $color("clear"), accessibilityLabel: title },
      layout: $layout.fill,
      events: { tapped: action },
    });
  }
  return {
    type: "view",
    props: { bgcolor: C.page, selectionStyle: 0, selectable: false },
    layout: (make, view) => make.edges.equalTo(view.super),
    views,
  };
}

function appSubtitle(app) {
  const version = String(app.version || "").replace(/\s+/g, " ").trim();
  const bundleID = String(app.bundleID || "").replace(/\s+/g, " ").trim();
  const purchasedAt = app.purchaseDate ? new Date(app.purchaseDate) : null;
  const date = purchasedAt && Number.isFinite(purchasedAt.getTime())
    ? format.formatDate(purchasedAt).replace(/-/g, ".")
    : "日期未知";
  return [`版本：${version || "未知"}`, bundleID || "Bundle ID 未知", date].join("\n");
}

function endOnce(sender, method) {
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (sender && typeof sender[method] === "function") sender[method]();
  };
}

function summaryText() {
  const region = common.regionText(state.region);
  if (!state.complete) return `${region} · App Store 已购`;
  const count = state.term
    ? `找到 ${matchingApps().length} 个 · 共 ${state.totalCount} 个`
    : `${state.totalCount} 个已购 App`;
  return `${region} · ${count}`;
}

function updateSummary() {
  const header = currentListDefinition && currentListDefinition.props.header;
  if (header) updateView(header.views[0], { text: summaryText() });
}

function listDefinition(data, floating, appCount) {
  const listProps = floating ? common.floatingTabListProps : common.listBaseProps;
  const count = appCount || 0;
  common.releaseDownloadButtons(currentListDefinition);
  const definition = {
    type: "list",
    props: listProps({
      id: "purchased-list",
      style: 0,
      separatorHidden: true,
      data,
      rowHeight: count ? APP_ROW_HEIGHT : 160,
      sectionTitleHeight: 4,
      header: {
        type: "view",
        props: { height: 24, bgcolor: C.page },
        views: [{
          type: "label",
          props: { id: "purchased-summary", text: summaryText(), font: $font(12), textColor: C.sub, lines: 1 },
          layout: (make) => { make.left.right.inset(16); make.top.bottom.equalTo(0); },
          events: { ready: (sender) => { sender.text = summaryText(); } },
        }],
      },
    }),
    layout: (make) => {
      make.left.right.bottom.equalTo(0);
      make.top.equalTo(HEADER_HEIGHT);
    },
    events: {
      rowHeight: (_sender, indexPath) => count
        ? (indexPath && indexPath.row >= count ? 44 : APP_ROW_HEIGHT)
        : 160,
      pulled: async (sender) => {
        const end = endOnce(sender, "endRefreshing");
        try {
          await load({ refresh: true });
        } finally {
          end();
        }
      },
      didReachBottom: async (sender) => {
        const end = endOnce(sender, "endFetchingMore");
        try {
          if (currentListDefinition !== definition) return;
          await loadMore(end);
        } finally {
          end();
        }
      },
    },
  };
  currentListDefinition = definition;
  return currentListDefinition;
}

function matchingApps() {
  const term = state.term.toLowerCase();
  return term ? state.rows.filter((app) => String(app.name || "").toLowerCase().includes(term)) : state.rows;
}

function unknownTitle(app) {
  return !String(app.name || "").trim() || app.name === "未命名 App";
}

function updateView(definition, props) {
  Object.assign(definition.props, props);
  const view = $(definition.props.id);
  if (view) Object.assign(view, props);
}

function updateFooter(render, status) {
  render.status = status;
  updateView(render.footer.spinner, { loading: !!status.loading, hidden: !status.loading });
  updateView(render.footer.label, { text: status.action ? status.text : "", hidden: !status.action });
  updateView(render.footer.button, { hidden: !status.action, accessibilityLabel: status.text });
}

function footerRow(render, status) {
  const prefix = `purchased-status-${++rowSeq}`;
  const spinner = {
    type: "spinner",
    props: { id: `${prefix}-spinner`, loading: !!status.loading, hidden: !status.loading, color: C.sub, style: 1 },
    layout: (make, view) => {
      make.center.equalTo(view.super);
      make.size.equalTo($size(20, 20));
    },
    events: { ready: (sender) => { sender.loading = !!render.status.loading; sender.hidden = !render.status.loading; } },
  };
  const label = {
    type: "label",
    props: {
      id: `${prefix}-label`, text: "", hidden: true,
      font: $font(12), textColor: C.blue, align: $align.center, lines: 2,
    },
    layout: (make, view) => {
      make.left.right.inset(16);
      make.centerY.equalTo(view.super);
      make.height.equalTo(32);
    },
    events: {
      ready: (sender) => {
        sender.text = render.status.action ? render.status.text : "";
        sender.hidden = !render.status.action;
      },
    },
  };
  const button = {
    type: "button",
    props: { id: `${prefix}-action`, bgcolor: $color("clear"), hidden: true, accessibilityLabel: "" },
    layout: $layout.fill,
    events: {
      tapped: () => { if (renderedList === render && render.status.action) render.status.action(); },
      ready: (sender) => {
        sender.hidden = !render.status.action;
        sender.accessibilityLabel = render.status.text;
      },
    },
  };
  render.footer = { spinner, button, label };
  updateFooter(render, status);
  return {
    type: "view",
    props: { bgcolor: $color("clear"), selectionStyle: 0, selectable: false },
    layout: (make, view) => make.edges.equalTo(view.super),
    views: [spinner, label, button],
  };
}

function appRow(app, region, render) {
  // 按钮闭包持有可更新的展示对象；补全版本/标题时保留下载锁和进度条实例。
  const model = Object.assign({}, app, { name: app.name || "未命名 App" });
  const row = common.appRowView(model, appSubtitle(model), {
    region,
    onView: () => require("./detail").show(model, region),
    onGet: (onProgress, onTask) => require("./detail").downloadApp(model, region, { onProgress, onTask }),
  });
  const contents = row.views[0].views;
  const labels = contents.filter((view) => view.type === "label");
  const record = {
    id: app.id, model, row,
    icon: contents.find((view) => view.type === "image"),
    title: labels[0],
    detail: contents.find((view) => view.type === "button"),
  };
  const prefix = `purchased-app-${++rowSeq}`;
  for (const field of ["icon", "title", "detail"]) record[field].props.id = `${prefix}-${field}`;
  // 每项独占一行，长 Bundle ID 只在本行截断，不挤掉购买日期。
  record.subtitles = appSubtitle(model).split("\n").map((text, index) => ({
    type: "label",
    props: Object.assign({}, labels[1].props, { id: `${prefix}-subtitle-${index}`, text, lines: 1 }),
    layout: (make) => {
      make.left.equalTo(84);
      make.right.inset(88);
      make.top.equalTo(53 + index * 17);
      make.height.equalTo(17);
    },
    events: { ready: (sender) => { sender.text = appSubtitle(model).split("\n")[index]; } },
  }));
  contents.splice(contents.indexOf(labels[1]), 1, ...record.subtitles);
  record.icon.events = { ready: (sender) => { sender.src = model.artworkUrl || model.icon || ""; } };
  record.title.events = { ready: (sender) => { sender.text = model.name; } };
  record.detail.events.ready = (sender) => { sender.accessibilityLabel = `查看 ${model.name}`; };
  render.rows.push(record);
  return row;
}

function updateAppRow(record, app) {
  Object.assign(record.model, app, { name: app.name || "未命名 App" });
  updateView(record.icon, { src: record.model.artworkUrl || record.model.icon || "" });
  updateView(record.title, { text: record.model.name });
  const subtitles = appSubtitle(record.model).split("\n");
  record.subtitles.forEach((label, index) => updateView(label, { text: subtitles[index] }));
  updateView(record.detail, { accessibilityLabel: `查看 ${record.model.name}` });
}

function replaceList(data, resetScroll, appCount) {
  const list = $("purchased-list");
  const page = list && list.super || $("purchased-content") || $("purchased-page") || $("screen-purchased");
  if (!list) {
    if (pendingData !== data) common.releaseDownloadButtons(pendingData);
    pendingData = data;
    pendingResetScroll = pendingResetScroll || !!resetScroll;
    pendingAppCount = appCount || 0;
    return;
  }
  if (pendingData !== data) common.releaseDownloadButtons(pendingData);
  pendingData = null;
  const reset = resetScroll || pendingResetScroll;
  pendingResetScroll = false;
  const definition = listDefinition(data, state.floating, appCount);
  if (!reset) common.preserveListOffset(list, definition);
  if (page && list && typeof list.remove === "function" && typeof page.add === "function") {
    list.remove();
    page.add(definition);
    return;
  }
  list.data = data;
  if (reset) list.contentOffset = typeof $point === "function" ? $point(0, 0) : { x: 0, y: 0 };
  if (typeof list.reload === "function") list.reload();
}

function showStatus(title, subtitle, action, resetScroll) {
  renderedList = null;
  updateSummary();
  replaceList([{ title: "", rows: [statusRow(title, subtitle, action)] }], resetScroll);
}

function statusInfo() {
  if (state.error) return { text: "刷新失败，点按重试", action: () => load({ refresh: true }) };
  if (state.loading) return { text: "正在刷新已购记录…", loading: true };
  if (state.metadataError) return { text: "信息补全失败，点按重试", action: retryMetadata };
  const unknown = state.term ? state.rows.filter(unknownTitle).length : 0;
  if (unknown) {
    const pending = state.rows.some((app) => unknownTitle(app) && !state.enrichedIds.has(app.id));
    return pending || state.enriching
      ? { text: `还有 ${unknown} 个 App 名称待补全…`, loading: state.enriching }
      : { text: `${unknown} 个 App 名称未能补全，点按重试`, action: retryMetadata };
  }
  if (state.enriching) return { text: "正在补全 App 信息…", loading: true };
  return { text: "" };
}

function showRows(resetScroll) {
  updateSummary();
  if (!currentAccount().account) {
    showStatus("还没有可用账号", `请先添加 ${common.regionText(state.region)} Apple ID。`, () => require("./accounts").render(), resetScroll);
    return;
  }
  if (!state.complete) {
    showStatus(
      state.error ? "读取已购记录失败" : "正在读取已购 App…",
      state.error ? `${state.error}\n点按此处重试` : "正在同步 Apple 购买记录",
      state.error ? () => load({ refresh: true }) : null,
      resetScroll
    );
    return;
  }
  const region = state.region;
  const matches = matchingApps();
  const visible = matches.slice(0, state.visibleLimit);
  const status = statusInfo();
  const rendered = renderedList;
  const stillMounted = rendered && (pendingData === rendered.data ||
    (!pendingData && currentListDefinition && currentListDefinition.props.data === rendered.data));
  if (!resetScroll && visible.length && stillMounted && rendered.key === state.accountKey &&
      rendered.rows.length === visible.length && rendered.rows.every((row, index) => row.id === visible[index].id)) {
    visible.forEach((app, index) => updateAppRow(rendered.rows[index], app));
    updateFooter(rendered, status);
    common.refreshDownloadButtons();
    return;
  }
  const render = { key: state.accountKey, rows: [], status };
  const rows = visible.map((app) => appRow(app, region, render));
  if (!visible.length) {
    const uncertain = state.loading || state.error || state.metadataError || state.rows.some(unknownTitle);
    rows.push(statusRow(
      !state.rows.length ? "没有已购 App" : uncertain ? "暂未找到匹配的 App" : "没有找到匹配的 App",
      status.text || (state.term ? "试试其他名称" : "Apple 账号的购买记录为空。"),
      status.action
    ));
  } else {
    // 状态容器原位切换，普通补全结束时不必重建正在下载的 App 行。
    rows.push(footerRow(render, status));
  }
  render.data = [{ title: "", rows }];
  renderedList = visible.length ? render : null;
  replaceList(render.data, resetScroll, visible.length);
}

function cancelScheduledEnrichment() {
  querySeq += 1;
  if (searchTimer !== null && typeof clearTimeout === "function") clearTimeout(searchTimer);
  searchTimer = null;
}

function enrichmentBatch() {
  const visible = matchingApps().slice(0, state.visibleLimit);
  const candidates = state.term ? visible.concat(state.rows.filter(unknownTitle)) : visible;
  const seen = new Set(state.enrichedIds);
  return candidates.filter((app) => {
    if (seen.has(app.id)) return false;
    seen.add(app.id);
    return true;
  }).slice(0, PAGE_SIZE);
}

function scheduleEnrichment() {
  if (!state.initialized || state.loading || state.enriching || state.error || state.metadataError || !enrichmentBatch().length) return;
  cancelScheduledEnrichment();
  const sequence = querySeq;
  const token = requestSeq;
  const key = state.accountKey;
  searchTimer = setTimeout(() => {
    if (sequence !== querySeq || !requestIsCurrent(token, key)) return;
    searchTimer = null;
    enrichVisible();
  }, 250);
}

function saveSnapshot(token, key) {
  if (!requestIsCurrent(token, key) || !state.complete) return;
  const current = currentAccount();
  purchasedCache.write(current.account.email, current.region, {
    complete: true,
    apps: state.rows,
    totalCount: state.totalCount,
    enrichedIds: Array.from(state.enrichedIds),
    updatedAt: state.updatedAt,
  });
}

function ownedFields(app) {
  // 旧图标等公开字段不能作为 owned 覆盖新的 lookup；占位名也不写回原记录。
  return {
    id: app.id, name: unknownTitle(app) ? "" : app.name,
    bundleID: app.bundleID || "", version: app.version || "", purchaseDate: app.purchaseDate || "",
    price: 0, owned: true,
  };
}

function mergeMetadata(apps, ids) {
  const updates = new Map();
  for (const app of apps || []) {
    if (app && ids.has(String(app.id))) updates.set(String(app.id), app);
  }
  state.rows = state.rows.map((app) => {
    const update = updates.get(app.id);
    if (!update) return app;
    return Object.assign({}, app, update, {
      id: app.id, owned: true, price: 0,
      name: unknownTitle(update) ? app.name || "" : update.name,
    });
  });
}

async function enrichVisible() {
  if (!state.initialized || !state.complete || state.loading || state.enriching) return "busy";
  if (state.error || state.metadataError) return "error";
  const token = requestSeq;
  const key = state.accountKey;
  if (!requestIsCurrent(token, key)) return "stale";
  const batch = enrichmentBatch();
  if (!batch.length) return "end";
  const ids = new Set(batch.map((app) => app.id));
  state.enriching = true;
  showRows();
  try {
    const result = await purchases.enrichApps(batch.map(ownedFields), state.region, {
      enrichBatchSize: 20,
      failOnLookupError: true,
      onApps: (apps) => {
        if (!requestIsCurrent(token, key)) return;
        mergeMetadata(apps, ids);
        showRows();
      },
    });
    if (!requestIsCurrent(token, key)) return "stale";
    mergeMetadata(result, ids);
    for (const id of ids) state.enrichedIds.add(id);
    state.enriching = false;
    saveSnapshot(token, key);
    showRows();
    scheduleEnrichment();
    return "loaded";
  } catch (error) {
    if (!requestIsCurrent(token, key)) return "stale";
    state.enriching = false;
    state.metadataError = String(error && error.message || error);
    showRows();
    return "error";
  }
}

function retryMetadata() {
  state.metadataError = "";
  for (const app of state.rows) {
    if (unknownTitle(app)) state.enrichedIds.delete(app.id);
  }
  enrichVisible();
}

function snapshotIsFresh() {
  const age = Date.now() - state.updatedAt;
  return state.complete && !state.cacheStale && age >= 0 && age < purchasedCache.TTL_MS;
}

async function load(options) {
  const opts = options || {};
  const token = ++requestSeq;
  cancelScheduledEnrichment();
  const current = currentAccount();
  const key = accountKey(current);
  const sameAccount = state.accountKey === key;
  state.initialized = true;
  state.accountKey = key;
  state.region = current.region;
  state.loading = false;
  state.enriching = false;
  state.appending = false;
  state.error = "";
  state.metadataError = "";
  if (!sameAccount || !current.account) {
    state.rows = [];
    state.totalCount = 0;
    state.complete = false;
    state.cacheStale = false;
    state.enrichedIds = new Set();
    state.updatedAt = 0;
    state.visibleLimit = PAGE_SIZE;
  }
  if (current.account && !state.complete) {
    const cached = purchasedCache.read(current.account.email, current.region);
    if (cached) {
      state.rows = cached.apps;
      state.totalCount = cached.totalCount;
      state.complete = true;
      state.cacheStale = cached.stale;
      state.updatedAt = cached.updatedAt;
      state.enrichedIds = new Set(cached.enrichedIds);
    }
  }
  updateHeader();
  if (!current.account) {
    showRows(true);
    return "empty";
  }
  if (!opts.refresh && snapshotIsFresh()) {
    showRows(!sameAccount);
    enrichVisible();
    return "cached";
  }
  state.loading = true;
  showRows(!sameAccount);
  try {
    const result = await purchases.listOwnedApps(current.account, {
      page: 1, limit: PAGE_SIZE, region: current.region, includeAllApps: true, enrich: false,
      onProgress: (progress) => {
        if (!requestIsCurrent(token, key) || state.complete) return;
        showStatus(progress.title || "正在读取已购 App…", progress.message || "请稍候");
      },
    });
    if (!requestIsCurrent(token, key)) return "stale";
    if (!result || !Array.isArray(result.allApps)) throw new Error("返回的已购记录不完整，请重试");
    const unique = new Map();
    for (const app of result.allApps) {
      if (!app || !["string", "number"].includes(typeof app.id) || !String(app.id).trim()) continue;
      const id = String(app.id).trim();
      if (!unique.has(id)) unique.set(id, Object.assign({}, app, { id, owned: true }));
    }
    if (!Number.isInteger(result.totalCount) || result.totalCount !== unique.size) throw new Error("返回的已购记录不完整，请重试");
    state.rows = Array.from(unique.values());
    state.totalCount = result.totalCount;
    state.complete = true;
    state.cacheStale = false;
    state.updatedAt = Date.now();
    state.enrichedIds = new Set();
    if (!opts.preserveViewport) state.visibleLimit = PAGE_SIZE;
    state.loading = false;
    saveSnapshot(token, key);
    showRows(!opts.preserveViewport);
    enrichVisible();
    return "loaded";
  } catch (error) {
    if (!requestIsCurrent(token, key)) return "stale";
    state.loading = false;
    state.error = String(error && error.message || error);
    showRows();
    return "error";
  }
}

async function loadMore(end) {
  if (!requestIsCurrent(requestSeq, state.accountKey)) return "stale";
  if (state.loading || state.appending) return "busy";
  if (matchingApps().length <= state.visibleLimit) return "end";
  const token = requestSeq;
  const key = state.accountKey;
  state.appending = true;
  state.visibleLimit += PAGE_SIZE;
  // JSBox 要求先结束原 list 的加载状态，再更新或替换其数据。
  if (end) end();
  showRows();
  Promise.resolve().then(() => {
    if (requestIsCurrent(token, key)) state.appending = false;
  });
  return enrichVisible();
}

function changeTerm(sender) {
  const term = String(sender.text || "").trim();
  if (term === state.term) return;
  cancelScheduledEnrichment();
  state.term = term;
  state.visibleLimit = PAGE_SIZE;
  showRows(true);
  scheduleEnrichment();
}

function chooseAccount() {
  let accounts = [];
  try { accounts = accountsStore.listAccounts(); } catch (_e) {}
  if (!accounts.length) {
    common.alert({
      title: "还没有账号",
      message: "添加 Apple ID 后即可查看对应账号的已购 App。",
      actions: [{ title: "管理账号", handler: () => require("./accounts").render() }, { title: "取消" }],
    });
    return;
  }
  const active = currentAccount().account;
  const items = accounts.map((account) => {
    const region = accountsStore.accountRegion(account);
    const selected = active && String(active.email).toLowerCase() === String(account.email).toLowerCase();
    return `${account.email} · ${common.regionText(region)}${selected ? " ✓" : ""}`;
  });
  items.push("管理账号");
  common.menu({
    items,
    handler: (_title, index) => {
      if (index === accounts.length) {
        require("./accounts").render();
        return;
      }
      if (!accounts[index]) return;
      try {
        accountsStore.activateAccount(accounts[index].email);
        load();
      } catch (error) {
        common.alertError(error);
      }
    },
  });
}

function headerDefinition() {
  return {
    type: "view",
    props: { id: "purchased-header", bgcolor: C.page },
    layout: (make) => {
      make.top.left.right.equalTo(0);
      make.height.equalTo(HEADER_HEIGHT);
    },
    views: [
      {
        type: "view",
        props: { id: "purchased-search-field", bgcolor: C.field, cornerRadius: 16, smoothCorners: true },
        layout: (make) => {
          make.left.right.inset(16);
          make.top.inset(8);
          make.height.equalTo(46);
        },
        views: [
          {
            type: "image",
            props: { symbol: "magnifyingglass", tintColor: C.sub, contentMode: 1 },
            layout: (make, view) => {
              make.left.inset(14);
              make.centerY.equalTo(view.super);
              make.size.equalTo($size(20, 20));
            },
          },
          {
            type: "input",
            props: common.fieldProps("搜索已购 App 名称", {
              id: "purchased-search-input", text: state.term, clearButtonMode: 1, type: $kbType.search,
              bgcolor: $color("clear"), cornerRadius: 0, smoothCorners: false,
              accessibilityLabel: "搜索已购 App 名称",
            }),
            layout: (make) => {
              make.left.equalTo(42);
              make.right.inset(10);
              make.top.bottom.equalTo(0);
            },
            events: {
              changed: changeTerm,
              returned: (sender) => {
                changeTerm(sender);
                sender.blur();
                cancelScheduledEnrichment();
                enrichVisible();
              },
            },
          },
        ],
      },
    ],
  };
}

function updateHeader() {
  if (navigationBinding) navigationBinding.refresh();
  const input = $("purchased-search-input");
  if (input && input.text !== state.term) input.text = state.term;
}

function dispose() {
  requestSeq += 1;
  cancelScheduledEnrichment();
  state.initialized = false;
  state.loading = false;
  state.enriching = false;
  state.appending = false;
  common.releaseDownloadButtons(currentListDefinition);
  common.releaseDownloadButtons(pendingData);
  currentListDefinition = null;
  pendingData = null;
  pendingResetScroll = false;
  pendingAppCount = 0;
  renderedList = null;
  navigationBinding = null;
}

function refreshVisible() {
  if (state.initialized && state.accountKey !== accountKey(currentAccount())) {
    load();
    return;
  }
  if (pendingData) replaceList(pendingData, pendingResetScroll, pendingAppCount);
  if (state.complete && !state.loading && !state.error && !snapshotIsFresh()) {
    load({ refresh: true, preserveViewport: true });
    return;
  }
  updateHeader();
  if (renderedList && state.complete) showRows();
  else common.refreshDownloadButtons();
}

function render() {
  const current = currentAccount();
  state.initialized = false;
  state.region = current.region;
  state.floating = false;
  const props = common.pageProps({
    title: "App Store 已购", id: "purchased-page",
  });
  const binding = navigation.create({ props, buttons: () => [navigationButton()] });
  navigationBinding = binding;
  $ui.push(common.page({
    props,
    events: {
      appeared: () => { navigationBinding = binding; refreshVisible(); },
      dealloc: dispose,
    },
    views: [
      headerDefinition(),
      listDefinition([
        {
          title: "",
          rows: [statusRow("正在准备…", `${common.regionText(current.region)} · App Store`, null)],
        },
      ], false),
    ],
  }, binding));
  load();
}

function views() {
  const current = currentAccount();
  state.region = current.region;
  state.floating = true;
  return [
    {
      type: "view",
      props: {
        id: "purchased-content",
        bgcolor: C.page,
        clipsToBounds: true,
      },
      layout: $layout.fill,
      views: [
        headerDefinition(),
        listDefinition([
          {
            title: "",
            rows: [statusRow("正在准备…", `${common.regionText(current.region)} · App Store`, null)],
          },
        ], true),
      ],
    },
  ];
}

function mount(binding) {
  if (binding) navigationBinding = binding;
  state.floating = true;
  if (!state.initialized || state.accountKey !== accountKey(currentAccount())) load();
  else refreshVisible();
}

module.exports = {
  render,
  views,
  mount,
  navigationButton,
  dispose,
  listDefinition,
  parseDateText: appSubtitle,
};
