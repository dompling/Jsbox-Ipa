// 底部 Tab 导航壳：首页 / 已购 / 下载 / 搜索 / 设置。
//
// 旧实现把悬浮栏放在 root view 的 unsafe 区域，并用若干相对于数字中心
// 的约束定位子视图；在部分 JSBox/iOS 组合上这些约束会把胶囊裁成透明或
// 直接移出屏幕。这里把 root 限制在 safe area 内，使用明确的左右/宽度约束，
// 并给选中项保留轻量胶囊作为可靠的可见 fallback。整条 Tab 栏使用与页面
// 卡片同源的不透明胶囊底色（随深/浅色自动切换），内容不叠加半透明材质，
// 避免图标与文字被整体 alpha 冲淡。

const common = require("./common");
const navigation = require("./navigation");
const C = common.colors;

const TABS = [
  { key: "home", title: "首页", symbol: "house.fill" },
  { key: "purchased", title: "已购", symbol: "bag.fill" },
  { key: "downloads", title: "下载", symbol: "arrow.down.circle.fill" },
  { key: "search", title: "搜索", symbol: "magnifyingglass" },
  { key: "settings", title: "设置", symbol: "gearshape.fill" },
];

const BAR_SIDE = 20;
const BAR_BOTTOM = 18;
const BAR_HEIGHT = 60;
const PILL_HEIGHT = 44;
const ICON_SIZE = 20;

// JSBox 的 view props 表没有 shadow*，真机上不渲染投影。这里在胶囊下方
// 叠两层同宽同圆角的黑色低透明度垫层（越靠下越深），模拟出“胶囊浮起来”
// 的底部投影；浅色白底上能看到轻微层次，深色下自然融入背景。
const TAB_BAR_SHADOW_LAYERS = [
  { offset: 2, alpha: 0.04 },
  { offset: 5, alpha: 0.07 },
];

const PILL_COLOR = $color({ light: "#E6F0FF", dark: "#24476B" });

let currentIndex = 0;
let rendered = false;
let transitionSeq = 0;
let rootNavigation = null;

function moduleOf(key) {
  switch (key) {
    case "purchased": return require("./purchased");
    case "downloads": return require("./downloads");
    case "search": return require("./search");
    case "settings": return require("./settings");
    default: return require("./home");
  }
}

// 不从 $device.info.screen.width 推导布局：JSBox 的画布可能处于 sheet、分屏
// 或带外框的预览尺寸，物理屏幕宽度与实际父 view 宽度并不总是一致。交给
// 官方 stack view 按父 view 的实际宽度等分，避免最右侧 Tab 被裁剪。
function stackConstant(group, key, fallback) {
  try {
    return typeof group !== "undefined" && group && group[key] !== undefined
      ? group[key]
      : fallback;
  } catch (_e) {
    return fallback;
  }
}

const STACK_HORIZONTAL = stackConstant(
  typeof $stackViewAxis !== "undefined" ? $stackViewAxis : undefined,
  "horizontal",
  0
);
const STACK_FILL_EQUALLY = stackConstant(
  typeof $stackViewDistribution !== "undefined" ? $stackViewDistribution : undefined,
  "fillEqually",
  1
);
const STACK_FILL = stackConstant(
  typeof $stackViewAlignment !== "undefined" ? $stackViewAlignment : undefined,
  "fill",
  0
);

function tabItem(index) {
  const def = TABS[index];
  const active = index === currentIndex;
  return {
    type: "view",
    props: {
      id: `tabitem-${def.key}`,
      bgcolor: $color("clear"),
      userInteractionEnabled: true,
      isAccessibilityElement: true,
      accessibilityLabel: def.title,
      accessibilityValue: active ? "已选择" : "未选择",
      accessibilityHint: `切换到${def.title}页面`,
    },
    views: [
      {
        type: "view",
        props: {
          id: `tabpill-${def.key}`,
          bgcolor: active ? PILL_COLOR : $color("clear"),
          borderWidth: 0,
          cornerRadius: PILL_HEIGHT / 2,
          smoothCorners: true,
        },
        layout: (make, view) => {
          make.center.equalTo(view.super);
          // 胶囊宽度跟随 stack item，窄屏和 iPad 分屏都不会溢出。
          make.left.right.inset(2);
          make.height.equalTo(PILL_HEIGHT);
        },
      },
      {
        type: "image",
        props: {
          id: `tabicon-${def.key}`,
          symbol: def.symbol,
          tintColor: active ? C.blue : C.sub,
          contentMode: 1,
        },
        layout: (make, view) => {
          make.centerX.equalTo(view.super);
          make.centerY.equalTo(view.super).offset(-8);
          make.size.equalTo($size(ICON_SIZE, ICON_SIZE));
        },
      },
      {
        type: "label",
        props: {
          id: `tablabel-${def.key}`,
          text: def.title,
          font: $font("bold", 10),
          textColor: active ? C.blue : C.sub,
          align: $align.center,
          lines: 1,
        },
        layout: (make, view) => {
          make.centerX.equalTo(view.super);
          make.centerY.equalTo(view.super).offset(14);
          make.left.right.inset(4);
          make.height.equalTo(14);
        },
      },
    ],
    events: {
      tapped: () => {
        if (index === currentIndex) return;
        try { $device.taptic(0); } catch (_e) {}
        switchTab(index);
      },
    },
  };
}

function tabBarView() {
  return {
    type: "view",
    props: {
      id: "tabbar",
      // 胶囊底色与列表卡片同源（secondarySystemGroupedBackground）：
      // 浅色下是白色胶囊、深色下是深灰胶囊，悬浮在 grouped 页面底色上，
      // 与各页内容背景形成对应关系。
      bgcolor: C.card,
      cornerRadius: BAR_HEIGHT / 2,
      smoothCorners: true,
      // 白色胶囊与白色内容卡片叠在一起时没有层次，加一条极细的系统分隔线，
      // 让胶囊轮廓在浅色模式下也能被分辨出来。
      borderWidth: 0.5,
      borderColor: C.sep,
      isAccessibilityElement: false,
    },
    layout: (make, view) => {
      make.left.right.inset(BAR_SIDE);
      // 关键点：相对于 safeArea.bottom，而不是 root view 的物理底部。
      make.bottom.equalTo(view.super.safeArea).offset(-BAR_BOTTOM);
      make.height.equalTo(BAR_HEIGHT);
    },
    views: [
      {
        type: "stack",
        props: {
          id: "tab-stack",
          axis: STACK_HORIZONTAL,
          distribution: STACK_FILL_EQUALLY,
          alignment: STACK_FILL,
          spacing: 0,
          // 图标和文字不放进半透明 surface，避免整体 alpha 让内容发灰。
          stack: {
            views: TABS.map((_tab, index) => tabItem(index)),
          },
        },
        layout: (make, view) => {
          make.left.right.inset(7);
          make.top.bottom.inset(4);
        },
      },
    ],
  };
}

// 胶囊下方投影垫层，必须是 tabbar 之前的兄弟视图才能垫在它下面。
function tabBarShadowLayers() {
  return TAB_BAR_SHADOW_LAYERS.map((layer, index) => ({
    type: "view",
    props: {
      id: `tabbar-shadow-${index}`,
      bgcolor: $color("black"),
      alpha: layer.alpha,
      cornerRadius: BAR_HEIGHT / 2,
      smoothCorners: true,
      userInteractionEnabled: false,
    },
    layout: (make, view) => {
      make.left.right.inset(BAR_SIDE);
      make.bottom.equalTo(view.super.safeArea).offset(-(BAR_BOTTOM - layer.offset));
      make.height.equalTo(BAR_HEIGHT);
    },
  }));
}

function errorScreen(def, err) {
  const message = err && (err.message || String(err)) ? err.message : String(err || "未知错误");
  return [
    {
      type: "label",
      props: { text: `${def.title}页面初始化失败`, font: $font("bold", 17), textColor: C.label, lines: 1 },
      layout: (make, view) => {
        make.left.right.inset(20);
        make.top.equalTo(view.super.safeArea).offset(20);
        make.height.equalTo(24);
      },
    },
    {
      type: "label",
      props: { text: message, font: $font(13), textColor: C.sub, lines: 0 },
      layout: (make, view) => {
        make.left.right.inset(20);
        make.top.equalTo(view.super.safeArea).offset(52);
      },
    },
  ];
}

function screenView(def) {
  const mod = moduleOf(def.key);
  let content = [];
  try {
    if (typeof mod.views === "function") content = mod.views();
  } catch (err) {
    content = errorScreen(def, err);
  }
  const index = TABS.findIndex((tab) => tab.key === def.key);
  return {
    type: "view",
    props: {
      id: `screen-${def.key}`,
      bgcolor: C.page,
      hidden: index !== 0,
      clipsToBounds: true,
    },
    layout: (make, view) => {
      // screen 与画布等大，让页面背景和滚动内容都能延伸到浮层后面。
      make.edges.equalTo(view.super);
    },
    views: content,
  };
}

function contentHostView() {
  return {
    type: "view",
    props: {
      id: "content-host",
      bgcolor: $color("clear"),
      clipsToBounds: false,
    },
    // 内容背景延伸到整个画布，导航栏才会真正悬浮在页面之上；各 Tab
    // 自己的可滚动列表通过 contentInset 留出最后一行的可见空间。
    layout: $layout.fill,
    views: TABS.map((tab) => screenView(tab)),
  };
}

function setActiveScreen(index) {
  const transition = ++transitionSeq;
  const safeIndex = Math.max(0, Math.min(TABS.length - 1, Number(index) || 0));
  const previousIndex = currentIndex;
  try {
    const input = $ui.get("search-input");
    if (input && input.blur) input.blur();
  } catch (_e) {}
  currentIndex = safeIndex;
  const activeKey = TABS[safeIndex].key;
  if (rootNavigation) rootNavigation.refresh();

  const previousKey = TABS[previousIndex] && TABS[previousIndex].key;
  const previousScreen = previousKey ? $ui.get(`screen-${previousKey}`) : null;
  const nextScreen = $ui.get(`screen-${activeKey}`);
  const changedScreen = previousIndex !== safeIndex && previousScreen && nextScreen;
  // 先结束更早切换留下的可见态；过期 completion 不再隐藏当前页面。
  for (const tab of TABS) {
    const screen = $ui.get(`screen-${tab.key}`);
    if (!screen) continue;
    screen.hidden = tab.key !== activeKey && (!changedScreen || tab.key !== previousKey);
    screen.alpha = 1;
  }

  const updateTabs = () => {
    for (const tab of TABS) {
      const active = tab.key === activeKey;
      const pill = $ui.get(`tabpill-${tab.key}`);
      const icon = $ui.get(`tabicon-${tab.key}`);
      const label = $ui.get(`tablabel-${tab.key}`);
      const item = $ui.get(`tabitem-${tab.key}`);
      if (pill) {
        pill.bgcolor = active ? PILL_COLOR : $color("clear");
        pill.borderWidth = 0;
        pill.alpha = active ? 1 : 0.72;
      }
      if (icon) icon.tintColor = active ? C.blue : C.sub;
      if (label) label.textColor = active ? C.blue : C.sub;
      if (item) item.accessibilityValue = active ? "已选择" : "未选择";
    }
  };

  if (changedScreen && typeof $ui.animate === "function") {
    nextScreen.hidden = false;
    nextScreen.alpha = 0;
    $ui.animate({
      duration: 0.16,
      animation: () => {
        if (transition !== transitionSeq) return;
        previousScreen.alpha = 0;
      },
      completion: () => {
        if (transition !== transitionSeq) return;
        previousScreen.hidden = true;
        previousScreen.alpha = 1;
        $ui.animate({
          duration: 0.22,
          damping: 0.86,
          velocity: 0.2,
          animation: () => {
            if (transition !== transitionSeq) return;
            nextScreen.alpha = 1;
            updateTabs();
          },
        });
      },
    });
  } else {
    for (const tab of TABS) {
      const screen = $ui.get(`screen-${tab.key}`);
      if (screen) screen.hidden = tab.key !== activeKey;
    }
    updateTabs();
  }

  const mod = moduleOf(activeKey);
  if (typeof mod.mount === "function") mod.mount(rootNavigation);
}

function launch() {
  if (rendered) return;
  try {
    currentIndex = 0;
    const props = common.pageProps({
      title: TABS[0].title,
      fullScreen: true,
      // 允许页面背景延伸到 Home Indicator 区域；列表内容本身通过
      // contentInset 避开导航胶囊，避免底部再出现一块独立背景层。
      clipsToSafeArea: false,
      homeIndicatorHidden: false,
    });
    rootNavigation = navigation.create({
      props, root: true,
      title: () => TABS[currentIndex].title,
      buttons: () => {
        const mod = moduleOf(TABS[currentIndex].key);
        return typeof mod.navigationButton === "function" ? [mod.navigationButton()] : [];
      },
    });
    $ui.render(common.page({
      props,
      events: {
        dealloc: () => {
          transitionSeq += 1;
          require("./purchased").dispose();
          common.clearDownloadButtons();
          rendered = false;
          rootNavigation = null;
        },
        appeared: () => {
          if (rendered) {
            const mod = moduleOf(TABS[currentIndex].key);
            if (typeof mod.mount === "function") mod.mount(rootNavigation);
          }
          common.refreshDownloadButtons();
        },
      },
      // 内容先渲染、导航栏最后渲染，保证它处于最上层；底色只覆盖胶囊本身，
      // 其余区域仍露出页面内容。
      // 阴影垫层在内容之上、胶囊之下，形成向下的轻微投影。
      views: [contentHostView()].concat(tabBarShadowLayers(), [tabBarView()]),
    }, rootNavigation));
    rendered = true;
    setActiveScreen(0);
  } catch (err) {
    if (rootNavigation) rootNavigation.dispose();
    rootNavigation = null;
    $ui.alert({
      title: "界面初始化失败",
      message: (err && (err.message || String(err))) || "未知错误",
    });
  }
}

function switchTab(index) {
  const next = Number(index);
  if (!Number.isInteger(next) || next < 0 || next >= TABS.length || next === currentIndex) return;
  setActiveScreen(next);
}

function currentTabIndex() {
  return currentIndex;
}

module.exports = {
  TABS,
  launch,
  switchTab,
  currentTabIndex,
  // 导出定义生成器，便于在无 JSBox 真机的环境中做结构回归检查。
  tabBarView,
  tabBarShadowLayers,
  screenView,
  contentHostView,
};
