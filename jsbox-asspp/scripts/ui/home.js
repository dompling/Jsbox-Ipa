// 首页 Tab：App Store「今日」信息层级 + Top Charts 数据。
// 榜单行：排名 + 图标 + 名称 + 价格；末尾「查看全部」整行可点，进入完整榜单。
// 数据来自公开 iTunes RSS，不需要登录；区域可随时切换。

const config = require("../config");
const common = require("./common");
const storeApi = require("../apple/store");
const settings = require("../store/settings");
const { errorMessage } = require("../lib/error");

const C = common.colors;

const TOP_N = 5;
const EDITORIAL_ROW_HEIGHT = 106;
const HERO_HEIGHT = 154;
const HOME_ROW_OPTIONS = { inset: 16, staticCell: true };
const MODULE_GAP = 8;
const HERO_COLORS = {
  topfreeapplications: { light: "#1760B4", dark: "#134681" },
  toppaidapplications: { light: "#6A0DAD", dark: "#4B087A" },
  topgrossingapplications: { light: "#A64619", dark: "#773512" },
};

// ---------- 模块状态（Tab 切换时保留，避免反复请求） ----------
const state = {
  region: "",
  ready: false,
  loading: false,
  charts: {}, // kind.key -> [app, ...]
  errors: {}, // kind.key -> error message
  pending: {}, // kind.key -> true while this section is loading
};

let requestSeq = 0; // 区域中途切换时使过期请求作废
let currentListDefinition = null;
let dataDirty = false;

function countryName(code) {
  return String(code || "").toUpperCase();
}

// ---------- 数据 ----------

async function loadCharts(onlyKinds) {
  if (state.loading) return;
  const seq = ++requestSeq;
  const region = countryName(settings.region());
  const kinds = onlyKinds || config.CHART_KINDS;
  const fullLoad = !onlyKinds;
  state.region = region;
  state.loading = true;
  if (fullLoad) {
    state.ready = false;
    state.charts = {};
    state.errors = {};
  } else {
    kinds.forEach((kind) => {
      delete state.errors[kind.key];
    });
  }
  kinds.forEach((kind) => {
    state.pending[kind.key] = true;
  });
  refreshData();
  try {
    // 单个榜单失败不应拖垮另外两个榜单；兼容旧版 JSContext，不依赖 Promise.allSettled。
    const results = await Promise.all(
      kinds.map(async (kind) => {
        try {
          const feed = await storeApi.fetchChart(kind.key, region, TOP_N + 3);
          const visible = (feed || []).slice(0, TOP_N);
          const ids = visible.map((app) => app.id).filter(Boolean);
          try {
            const details = await storeApi.lookupByIds(ids, region);
            const byId = {};
            for (const app of details) byId[app.id] = app;
            return { kind, feed: visible.map((app) => byId[app.id] || app) };
          } catch (_e) {
            return { kind, feed: visible };
          }
        } catch (error) {
          return { kind, error };
        }
      })
    );
    if (seq !== requestSeq || countryName(settings.region()) !== region) return;
    results.forEach((result) => {
      const key = result.kind.key;
      delete state.pending[key];
      if (result.error) {
        state.charts[key] = [];
        state.errors[key] = errorMessage(result.error);
      } else {
        state.charts[key] = (result.feed || []).slice(0, TOP_N);
        delete state.errors[key];
      }
    });
    state.ready = true;
  } finally {
    if (seq === requestSeq) {
      state.loading = false;
      refreshData();
    }
  }
}

function retryKind(kind) {
  loadCharts([kind]);
}

function resetForRegion(region) {
  // 立即废弃旧区域请求；旧 Promise 即使稍后返回也无法覆盖新区域数据。
  requestSeq += 1;
  state.region = countryName(region);
  state.ready = false;
  state.loading = false;
  state.charts = {};
  state.errors = {};
  state.pending = {};
  refreshData(true);
  loadCharts();
}

// ---------- 静态行（说明 / 查看全部），不走模板 ----------

function overlayButton(action) {
  return {
    type: "button",
    props: { bgcolor: $color("clear") },
    layout: $layout.fill,
    events: { tapped: action },
  };
}

function infoCell(main, sub, onTap) {
  const views = [
    {
      type: "label",
      props: {
        text: main,
        font: $font("bold", 15),
        textColor: C.label,
        align: $align.center,
        lines: 1,
      },
      layout: (make, view) => {
        make.left.right.inset(16);
        make.centerY.equalTo(view.super).offset(sub ? -11 : 0);
        make.height.equalTo(20);
      },
    },
  ];
  if (sub) {
    views.push({
      type: "label",
      props: {
        text: sub,
        font: $font(12),
        textColor: C.sub,
        align: $align.center,
        lines: 1,
      },
      layout: (make, view) => {
        make.left.right.inset(16);
        make.centerY.equalTo(view.super).offset(12);
        make.height.equalTo(16);
      },
    });
  }
  if (onTap) views.push(overlayButton(onTap));
  return common.rowRootView(views, HOME_ROW_OPTIONS);
}

function seeAllCell(kind, region) {
  return common.rowRootView([
      {
        type: "label",
        props: {
          text: `查看全部${kind.title}`,
          font: $font("bold", 16),
          textColor: C.blue,
          align: $align.left,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(18);
          make.centerY.equalTo(view.super);
          make.right.inset(44);
          make.height.equalTo(22);
        },
      },
      {
        type: "image",
        props: { symbol: "chevron.right", tintColor: C.blue, contentMode: 1 },
        layout: (make, view) => {
          make.right.inset(16);
          make.centerY.equalTo(view.super);
          make.size.equalTo($size(14, 18));
        },
      },
      overlayButton(() => {
        require("./chart").render(region, kind);
      }),
    ], HOME_ROW_OPTIONS);
}

function editorialHeaderCell() {
  return common.rowRootView([
      {
        type: "label",
        props: {
          text: "编辑最爱",
          font: $font(14),
          textColor: C.sub,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(18);
          make.top.equalTo(16);
          make.right.inset(18);
          make.height.equalTo(20);
        },
      },
      {
        type: "label",
        props: {
          text: "精选 App",
          font: $font("bold", 27),
          textColor: C.label,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(18);
          make.top.equalTo(40);
          make.right.inset(18);
          make.height.equalTo(34);
        },
      },
    ], HOME_ROW_OPTIONS);
}

function chartSectionHeaderCell(kind, region) {
  return common.rowRootView([
      {
        type: "label",
        props: {
          text: kind.title,
          font: $font("bold", 21),
          textColor: C.label,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(18);
          make.top.equalTo(12);
          make.right.inset(18);
          make.height.equalTo(27);
        },
      },
      {
        type: "label",
        props: {
          text: `${common.regionText(region)} · 实时榜单`,
          font: $font(12),
          textColor: C.sub,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(18);
          make.top.equalTo(43);
          make.right.inset(18);
          make.height.equalTo(17);
        },
      },
    ], HOME_ROW_OPTIONS);
}

// ---------- 分组数据 ----------

// 一个模块只有一个静态 cell 和圆角底。复用现有行的内容与按钮，去掉
// 单行卡片外壳；内部按高度连续排列，不给每个 App 再画独立圆角和间隙。
function moduleCard(rows, hero) {
  let height = 0;
  const contents = rows.map(({ row, rowHeight }) => {
    const content = row.views[0];
    const top = height;
    height += rowHeight;
    content.props.bgcolor = $color("clear");
    content.props.cornerRadius = 0;
    content.layout = (make) => {
      make.left.right.inset(0);
      make.top.equalTo(top);
      make.height.equalTo(rowHeight);
    };
    return content;
  });
  const row = common.rowRootView(contents, Object.assign({}, HOME_ROW_OPTIONS, { gap: MODULE_GAP }));
  if (hero) {
    row.views[0].layout = (make) => {
      make.left.right.inset(HOME_ROW_OPTIONS.inset);
      make.top.inset(HERO_HEIGHT + MODULE_GAP * 3);
      make.bottom.inset(MODULE_GAP);
    };
    row.views.push(hero);
    height += HERO_HEIGHT + MODULE_GAP * 2;
  }
  return { row, height: height + MODULE_GAP * 2 };
}

function buildSections() {
  const region = state.region || countryName(settings.region());
  const sections = [];
  for (const [kindIndex, kind] of config.CHART_KINDS.entries()) {
    const apps = state.charts[kind.key] || [];
    const rows = [{
      row: kindIndex === 0 ? editorialHeaderCell() : chartSectionHeaderCell(kind, region),
      rowHeight: 84,
    }];
    if (apps.length) {
      apps.forEach((app, idx) => {
        const options = Object.assign({}, HOME_ROW_OPTIONS, {
          onTap: () => require("./detail").show(app, region),
          accessibilityLabel: `查看 ${app.name || "App"}`,
        });
        rows.push({
          row: kindIndex === 0
            ? common.editorialRowView(app, {
                region,
                onGet: (onProgress, onTask) => require("./detail").downloadApp(app, region, { onProgress, onTask }),
              }, options)
            : common.chartRowView(app, idx, {
                region,
                onGet: (onProgress, onTask) => require("./detail").downloadApp(app, region, { onProgress, onTask }),
              }, options),
          rowHeight: kindIndex === 0 ? EDITORIAL_ROW_HEIGHT : 84,
        });
      });
      rows.push({ row: seeAllCell(kind, region), rowHeight: 56 });
    } else if (state.pending[kind.key]) {
      rows.push({ row: infoCell(`${kind.title}加载中…`, "正在获取榜单数据…"), rowHeight: 84 });
    } else if (state.errors[kind.key]) {
      rows.push({
        row: infoCell(
          `${kind.title}加载失败`,
          `${state.errors[kind.key] || "网络似乎不可用"} · 点按重试`,
          () => retryKind(kind)
        ),
        rowHeight: 84,
      });
    } else if (state.ready) {
      rows.push({ row: infoCell(`${kind.title}暂无数据`, "可以尝试切换到其他区域"), rowHeight: 84 });
    } else rows.push({ row: infoCell(`${kind.title}加载中…`, "正在获取榜单数据…"), rowHeight: 84 });
    const hero = apps.length ? chartHeroView(kind, apps[0], region) : null;
    const card = moduleCard(rows, hero);
    sections.push({
      // 标题、App 和页脚共用一张卡片，不再由系统 section header 额外留白。
      title: "",
      _kindKey: kind.key,
      _height: card.height,
      rows: [card.row],
    });
  }
  return sections;
}

// 每个榜单的第一名都使用同一种大卡片，点击进入该 App 的详情。
function chartHeroView(kind, featured, region) {
  const id = `home-hero-${kind.key}`;
  return {
    type: "view",
    props: {
      id,
      bgcolor: $color(HERO_COLORS[kind.key] || HERO_COLORS.topfreeapplications),
      cornerRadius: 22,
      smoothCorners: true,
      clipsToBounds: true,
    },
    layout: (make) => {
      make.left.right.inset(HOME_ROW_OPTIONS.inset);
      make.top.inset(MODULE_GAP);
      make.height.equalTo(HERO_HEIGHT);
    },
    views: [
      {
        type: "image",
        props: {
          id: `${id}-icon`,
          src: featured.artworkUrl || featured.icon,
          cornerRadius: 18,
          smoothCorners: true,
          accessibilityLabel: `${featured.name || "App"} 图标`,
        },
        layout: (make) => {
          make.left.top.inset(18);
          make.size.equalTo($size(76, 76));
        },
      },
      {
        type: "label",
        props: {
          id: `${id}-eyebrow`,
          text: `${kind.title}第一名`,
          font: $font("bold", 16),
          textColor: $color("white"),
          lines: 1,
        },
        layout: (make) => {
          make.left.equalTo(110);
          make.top.equalTo(18);
          make.right.inset(14);
          make.height.equalTo(22);
        },
      },
      {
        type: "label",
        props: {
          id: `${id}-name`,
          text: featured.name || "App",
          font: $font("bold", 21),
          textColor: $color("white"),
          lines: 2,
        },
        layout: (make) => {
          make.left.equalTo(110);
          make.top.equalTo(45);
          make.right.inset(14);
          make.height.equalTo(50);
        },
      },
      {
        type: "label",
        props: {
          id: `${id}-subtitle`,
          text: featured.artistName || featured.category || kind.title,
          font: $font(13),
          textColor: $color({ light: "#EDE5F5", dark: "#EFE5F8" }),
          lines: 1,
        },
        layout: (make) => {
          make.left.right.inset(18);
          make.bottom.inset(18);
          make.height.equalTo(18);
        },
      },
      {
        type: "button",
        props: { bgcolor: $color("clear"), accessibilityLabel: `查看${kind.title}第一名：${featured.name || "App"}` },
        layout: $layout.fill,
        events: { tapped: () => require("./detail").show(featured, region) },
      },
    ],
  };
}

// ---------- 头部（大标题 + 区域） ----------

function headerView() {
  const region = state.region || countryName(settings.region());
  return {
    type: "view",
    props: { id: "home-header", height: 64, bgcolor: C.page },
    views: [
      {
        type: "label",
        props: {
          id: "home-title",
          text: "今日",
          font: $font("bold", 32),
          textColor: C.label,
          lines: 1,
        },
        layout: (make) => {
          make.left.inset(20);
          make.top.inset(10);
          make.height.equalTo(42);
          make.right.inset(150);
        },
      },
      common.regionControl(
        "home-region-btn",
        region,
        () => {
          common.pickRegion((code) => {
            if (code === settings.region()) return;
            try {
              settings.setRegion(code);
              resetForRegion(code);
            } catch (err) {
              common.alertError(err);
            }
          });
        },
        (make) => {
          make.right.inset(16);
          make.top.inset(12);
          make.height.equalTo(44);
          make.width.equalTo(132);
        }
      ),
    ],
  };
}

function listDefinition() {
  common.releaseDownloadButtons(currentListDefinition);
  dataDirty = false;
  const sections = buildSections();
  currentListDefinition = {
    type: "list",
    props: common.floatingTabListProps({
      id: "home-list",
      style: 0,
      separatorHidden: true,
      data: sections,
      header: headerView(),
      rowHeight: 84,
      sectionTitleHeight: 0,
    }),
    layout: $layout.fill,
    events: {
      sectionTitleHeight: () => 0,
      rowHeight: (sender, indexPath) => {
        // 旧版只更新 data、不重建 list 时，也按当前模块内容重新计算高度。
        const data = sender && sender.data || sections;
        return (data[indexPath.section] || {})._height || 84;
      },
    },
  };
  return currentListDefinition;
}

function views() {
  return [listDefinition()];
}

function updateHeader() {
  common.updateRegionControl(
    "home-region-btn",
    state.region || countryName(settings.region())
  );
}

function refreshData(resetScroll) {
  dataDirty = true;
  updateHeader();
  const list = $("home-list");
  if (!list) return;
  const definition = listDefinition();
  if (!resetScroll) common.preserveListOffset(list, definition);
  const screen = $("screen-home");
  // 老版本 JSBox 对“静态 cell + header”只改 data 不一定重绘可见区域。
  // 移除并重新加入同一份 list 定义，保证 header、section 和 cell 一起更新。
  if (screen && typeof list.remove === "function" && typeof screen.add === "function") {
    list.remove();
    screen.add(definition);
    return;
  }
  list.data = definition.props.data;
  if (typeof list.reload === "function") list.reload();
}

function mount() {
  const region = countryName(settings.region());
  if (state.region !== region) {
    resetForRegion(region);
    return;
  }
  if (dataDirty) refreshData();
  else updateHeader();
  common.refreshDownloadButtons();
  if (!state.ready) loadCharts();
}

module.exports = {
  views,
  mount,
};
