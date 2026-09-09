// 搜索 Tab：App Store 风格搜索页。
// - 名称搜索（iPhone / iPad 类型可选）
// - Bundle ID 与 App ID 查询
// - 区域切换后自动使用新区域重搜
// - 页面状态保留在模块内，切换 Tab 不丢失关键词和结果

const config = require("../config");
const common = require("./common");
const navigation = require("./navigation");
const settings = require("../store/settings");
const accountsStore = require("../store/accounts");
const storeApi = require("../apple/store");
const { errorMessage } = require("../lib/error");

const C = common.colors;
const HEADER_HEIGHT = 118;
const RESULT_ROW_HEIGHT = 88;
const EMPTY_ROW_HEIGHT = 152;

const state = {
  region: "",
  entity: "software", // software | iPadSoftware
  term: "",
  rows: [],
  searchRegion: "",
  searchEntity: "",
  loading: false,
  error: "",
};

let requestSeq = 0;
let currentListDefinition = null;
let resultsDirty = false;
let navigationBinding = null;

function normalizedRegion() {
  return String(settings.region() || "").toUpperCase();
}

function entityTitle(entity) {
  const found = config.SEARCH_ENTITIES.find((item) => item.key === entity);
  return found ? found.title : "iPhone";
}

function currentEntity() {
  return entityTitle(state.entity);
}

function activeAccount() {
  try {
    return accountsStore.accountForRegion(normalizedRegion());
  } catch (_e) {
    return null;
  }
}

function navigationButton() {
  return navigation.accountButton(activeAccount(), normalizedRegion(), chooseAccount, "切换下载账号");
}

function chooseAccount() {
  let accounts = [];
  try {
    // 账号切换本身会切换全局区域，所以这里展示所有已保存账号，
    // 而不是只展示当前区域；否则在 CN 页面永远无法直接切到 US 账号。
    accounts = accountsStore.listAccounts();
  } catch (_e) {}
  if (!accounts.length) {
    const region = normalizedRegion();
    common.alert({
      title: "还没有账号",
      message: `搜索不需要登录；下载 ${common.regionText(region)} 的 App 需要对应区域 Apple ID。`,
      actions: [
        { title: "管理账号", handler: () => require("./accounts").render() },
        { title: "取消" },
      ],
    });
    return;
  }
  const active = activeAccount();
  const items = accounts.map((account) => {
    const accountRegion = typeof accountsStore.accountRegion === "function"
      ? accountsStore.accountRegion(account)
      : String(account.store || "").toUpperCase();
    const marker = active && account.email === active.email ? " ✓" : "";
    return `${account.email} · ${common.regionText(accountRegion || account.store)}${marker}`;
  });
  items.push("管理账号");
  common.menu({
    items,
    handler: (_title, index) => {
      if (index === accounts.length) {
        require("./accounts").render();
        return;
      }
      try {
        accountsStore.activateAccount(accounts[index].email);
        const region = normalizedRegion();
        requestSeq += 1;
        state.loading = false;
        state.region = region;
        updateHeader();
        if (readTerm()) runSearch();
        else refreshResults();
        common.toast(`已切换到 ${common.regionText(region)}`);
      } catch (err) {
        common.alertError(err);
      }
    },
  });
}

// ---------- 搜索执行 ----------

async function runSearch() {
  const input = $("search-input");
  const term = input ? String(input.text || "").trim() : state.term;
  if (!term) {
    clearResults();
    return;
  }
  state.term = term;
  const region = normalizedRegion();
  state.region = region;
  await doSearch(term, region, state.entity);
}

async function doSearch(text, region, entity) {
  const term = String(text || "").trim();
  if (!term) return;

  const seq = ++requestSeq;
  state.loading = true;
  state.error = "";
  state.rows = [];
  state.searchRegion = region;
  state.searchEntity = entity;
  refreshResults();

  try {
    let found = [];
    if (/^\d+$/.test(term)) {
      found = (await storeApi.lookupByIds([term], region)) || [];
    } else {
      const tasks = [storeApi.searchApps(term, region, 32, entity)];
      if (looksLikeBundleId(term)) tasks.push(safeBundleLookup(term, region));
      const results = await Promise.all(tasks);
      found = results[0] || [];
      const byBundle = results[1];
      if (byBundle) {
        found = [byBundle].concat(
          found.filter((soft) => soft.id !== byBundle.id)
        );
      }
    }

    if (seq !== requestSeq) return;
    state.rows = found;
  } catch (err) {
    if (seq !== requestSeq) return;
    state.error = errorMessage(err);
  } finally {
    if (seq === requestSeq) {
      state.loading = false;
      refreshResults();
    }
  }
}

function looksLikeBundleId(term) {
  return /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(term);
}

async function safeBundleLookup(term, region) {
  try {
    return await storeApi.lookupByBundleId(term, region);
  } catch (_e) {
    return null;
  }
}

function clearResults() {
  requestSeq += 1;
  state.term = "";
  state.rows = [];
  state.searchRegion = "";
  state.searchEntity = "";
  state.loading = false;
  state.error = "";
  updateHeader();
  refreshResults();
}

// ---------- 结果数据 ----------

function resultSubtitle(soft) {
  return [soft.bundleID, soft.version ? `v${soft.version}` : ""]
    .filter(Boolean)
    .join(" · ");
}

// 空状态采用独立视觉卡片，避免页面只剩一行灰色提示。
function statusCell(symbol, title, subtitle, retry) {
  const cardViews = [
    {
      type: "view",
      props: {
        bgcolor: C.field,
        cornerRadius: 26,
        smoothCorners: true,
      },
      layout: (make, view) => {
        make.centerX.equalTo(view.super);
        make.top.equalTo(18);
        make.size.equalTo($size(52, 52));
      },
      views: [
        {
          type: "image",
          props: { symbol, tintColor: C.blue, contentMode: 1 },
          layout: (make, view) => {
            make.center.equalTo(view.super);
            make.size.equalTo($size(25, 25));
          },
        },
      ],
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
        make.top.equalTo(82);
        make.height.equalTo(24);
      },
    },
    {
      type: "label",
      props: {
        text: subtitle,
        font: $font(13),
        textColor: retry ? C.blue : C.sub,
        align: $align.center,
        lines: 2,
      },
      layout: (make, view) => {
        make.left.right.inset(24);
        make.top.equalTo(111);
        make.height.equalTo(38);
      },
    },
  ];

  if (retry) {
    cardViews.push({
      type: "button",
      props: {
        bgcolor: $color("clear"),
        isAccessibilityElement: true,
        accessibilityLabel: "重新搜索",
        accessibilityHint: "再次提交当前搜索条件",
      },
      layout: $layout.fill,
      events: { tapped: runSearch },
    });
  }

  return {
    type: "view",
    // 空状态直接融入 grouped background，避免初始搜索页出现一整块白色面板。
    props: { bgcolor: C.page, selectionStyle: 0, selectable: false },
    layout: (make, view) => make.edges.equalTo(view.super),
    views: cardViews,
  };
}

function resultSections() {
  if (state.loading) {
    return [
      {
        title: "",
        rows: [
          statusCell(
            "arrow.triangle.2.circlepath",
            "正在搜索…",
            `${common.regionText(state.region)} · ${currentEntity()} App Store`,
            false
          ),
        ],
      },
    ];
  }

  if (state.error) {
    return [
      {
        title: "",
        rows: [
          statusCell(
            "exclamationmark.circle",
            "搜索失败",
            `${state.error}\n点按卡片重试`,
            true
          ),
        ],
      },
    ];
  }

  if (state.rows.length) {
    return [
      {
        title: `结果 · ${state.rows.length} 个 · ${currentEntity()}`,
        rows: state.rows.map((soft) =>
          common.appRowView(soft, resultSubtitle(soft), {
            region: state.searchRegion || state.region || normalizedRegion(),
            onView: () => require("./detail").show(
              soft,
              state.searchRegion || state.region || normalizedRegion()
            ),
            onGet: (onProgress, onTask) => require("./detail").downloadApp(
              soft,
              state.searchRegion || state.region || normalizedRegion(),
              { onProgress, onTask }
            ),
          })
        ),
      },
    ];
  }

  if (state.searchRegion) {
    return [
      {
        title: "",
        rows: [
          statusCell(
            "magnifyingglass",
            "没有找到结果",
            "换个关键词或商店区域试试",
            false
          ),
        ],
      },
    ];
  }

  if (state.term) {
    return [
      {
        title: "",
        rows: [
          statusCell("magnifyingglass", "准备搜索", "按键盘上的搜索键开始", false),
        ],
      },
    ];
  }

  // 初始搜索页保持干净：还没输入关键词时列表为空，
  // 只保留搜索框和区域/类型控件，不渲染占位卡片。
  return [];
}

function refreshResults() {
  resultsDirty = true;
  const list = $("search-list");
  if (!list) return;
  const definition = searchListDefinition();

  // 搜索结果行是静态完整 view 定义，不是 template 数据行。旧版 JSBox
  // 对这类 cell 仅调用 reload() 时可能复用旧的骨架/空 cell，导致结果数量
  // 已更新但图标、名称和按钮没有重新挂载。和首页/榜单保持同一重建策略。
  const container = $("search-content") || $("screen-search");
  if (
    container &&
    typeof list.remove === "function" &&
    typeof container.add === "function"
  ) {
    list.remove();
    container.add(definition);
    return;
  }

  list.data = definition.props.data;
  if (typeof list.reload === "function") list.reload();
}

// ---------- 视图 ----------

function segmentButton(id, title, key) {
  return {
    type: "button",
    props: {
      id,
      title,
      titleColor: key === state.entity ? C.blue : C.sub,
      bgcolor: key === state.entity
        ? $color({ light: "#DCEBFF", dark: "#21466D" })
        : $color("clear"),
      cornerRadius: 22,
      smoothCorners: true,
      font: $font("bold", 14),
      isAccessibilityElement: true,
      accessibilityLabel: `${title} 应用`,
      accessibilityValue: key === state.entity ? "已选择" : "未选择",
    },
    layout: (make, view) => {
      make.top.bottom.inset(0);
      if (key === "software") make.left.inset(2);
      else make.right.inset(2);
      make.width.equalTo(view.super.width).dividedBy(2).offset(-2);
    },
    events: {
      tapped: () => selectEntity(key),
    },
  };
}

function searchHeaderView() {
  const region = normalizedRegion();
  return {
    type: "view",
    props: {
      id: "search-header",
      height: HEADER_HEIGHT,
      bgcolor: C.page,
    },
    views: [
      {
        type: "view",
        props: {
          bgcolor: C.field,
          cornerRadius: 16,
          smoothCorners: true,
        },
        layout: (make, view) => {
          make.left.right.inset(16);
          make.top.equalTo(8);
          make.height.equalTo(46);
        },
        views: [
          {
            type: "image",
            props: { symbol: "magnifyingglass", tintColor: C.sub, contentMode: 1 },
            layout: (make, view) => {
              make.left.inset(15);
              make.centerY.equalTo(view.super);
              make.size.equalTo($size(21, 21));
            },
          },
          {
            type: "input",
            props: common.fieldProps("名称 / Bundle ID / App ID", {
              id: "search-input",
              clearButtonMode: 1,
              type: $kbType.search,
              text: state.term,
              bgcolor: $color("clear"),
              cornerRadius: 0,
              smoothCorners: false,
              isAccessibilityElement: true,
              accessibilityLabel: "搜索应用",
              accessibilityHint: "输入名称、Bundle ID 或 App ID",
            }),
            layout: (make, view) => {
              make.left.equalTo(45);
              make.right.inset(10);
              make.top.bottom.equalTo(0);
            },
            events: {
              changed: (sender) => {
                const term = String(sender.text || "").trim();
                if (term === state.term) return;
                requestSeq += 1;
                state.term = term;
                state.rows = [];
                state.searchRegion = "";
                state.searchEntity = "";
                state.loading = false;
                state.error = "";
                refreshResults();
              },
              returned: (sender) => {
                sender.blur();
                runSearch();
              },
            },
          },
        ],
      },
      {
        type: "view",
        props: {
          id: "type-segment",
          bgcolor: C.field,
          cornerRadius: 22,
          smoothCorners: true,
        },
        layout: (make, view) => {
          make.left.inset(16);
          make.top.equalTo(62);
          make.width.equalTo(view.super.width).offset(-166).priority(750);
          make.width.lessThanOrEqualTo(176);
          make.height.equalTo(44);
        },
        views: [
          segmentButton("type-iphone", "iPhone", "software"),
          segmentButton("type-ipad", "iPad", "iPadSoftware"),
        ],
      },
      common.regionControl(
        "region-btn",
        region,
        chooseRegion,
        (make, view) => {
          make.right.inset(16);
          make.top.equalTo(62);
          make.width.equalTo(126);
          make.height.equalTo(44);
        }
      ),
    ],
  };
}

function updateHeader() {
  const region = normalizedRegion();
  common.updateRegionControl("region-btn", region);
  if (navigationBinding) navigationBinding.refresh();
  const iphone = $("type-iphone");
  const ipad = $("type-ipad");
  [
    [iphone, "software"],
    [ipad, "iPadSoftware"],
  ].forEach(([button, key]) => {
    if (!button) return;
    const active = key === state.entity;
    button.bgcolor = active
      ? $color({ light: "#DCEBFF", dark: "#21466D" })
      : $color("clear");
    button.titleColor = active ? C.blue : C.sub;
    button.accessibilityValue = active ? "已选择" : "未选择";
  });
  const input = $("search-input");
  if (input && input.text !== state.term) input.text = state.term;
}

function selectEntity(entity) {
  if (!config.SEARCH_ENTITIES.some((item) => item.key === entity)) return;
  if (state.entity === entity) return;
  requestSeq += 1;
  state.entity = entity;
  state.loading = false;
  state.error = "";
  state.rows = [];
  state.searchRegion = "";
  state.searchEntity = "";
  updateHeader();
  if (readTerm()) runSearch();
  else refreshResults();
}

function chooseRegion() {
  common.pickRegion((code) => {
    const next = String(code || "").toUpperCase();
    if (!next || next === normalizedRegion()) return;
    try {
      settings.setRegion(next);
      requestSeq += 1;
      state.loading = false;
      state.region = next;
      updateHeader();
      if (readTerm()) runSearch();
      else refreshResults();
    } catch (err) {
      common.alertError(err);
    }
  });
}

function searchListDefinition() {
  common.releaseDownloadButtons(currentListDefinition);
  resultsDirty = false;
  currentListDefinition = {
    type: "list",
    props: common.floatingTabListProps({
      id: "search-list",
      style: 0,
      separatorHidden: true,
      data: resultSections(),
      rowHeight: RESULT_ROW_HEIGHT,
      sectionTitleHeight: 18,
    }),
    layout: (make, view) => {
      make.left.right.bottom.equalTo(view.super);
      make.top.equalTo(HEADER_HEIGHT);
    },
    events: {
      rowHeight: () => (state.rows.length ? RESULT_ROW_HEIGHT : EMPTY_ROW_HEIGHT),
    },
  };
  return currentListDefinition;
}

function searchContentDefinition() {
  return {
    type: "view",
    props: {
      id: "search-content",
      bgcolor: C.page,
      clipsToBounds: true,
    },
    layout: $layout.fill,
    views: [
      {
        ...searchHeaderView(),
        layout: (make, view) => {
          make.left.right.top.equalTo(view.super);
          make.height.equalTo(HEADER_HEIGHT);
        },
      },
      searchListDefinition(),
    ],
  };
}

function views() {
  return [searchContentDefinition()];
}

function readTerm() {
  const input = $("search-input");
  return input ? String(input.text || "").trim() : state.term;
}

function mount(binding) {
  if (binding) navigationBinding = binding;
  const region = normalizedRegion();
  const regionChanged = !!state.region && state.region !== region;
  if (regionChanged) {
    requestSeq += 1;
    state.loading = false;
  }
  state.region = region;
  updateHeader();
  if (resultsDirty) refreshResults();
  common.refreshDownloadButtons();

  if (
    state.term &&
    (regionChanged || (state.searchRegion && state.searchRegion !== region))
  ) {
    runSearch();
  }
}

module.exports = {
  views,
  mount,
  navigationButton,
};
