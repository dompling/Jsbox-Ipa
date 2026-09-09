// UI 公共层：App Store 风格设计系统 + 列表模板 + 弹窗/加载/异步封装。
// 所有页面共用同一套语义色（自动适配深色模式）、排版与行高，
// 避免页面之间“东一块西一块”。

const { errorMessage } = require("../lib/error");
const format = require("../lib/format");
const library = require("../store/library");
const queue = require("../services/queue");

// ---------- 设计常量（iOS 语义色，随深色模式自动切换） ----------
const colors = {
  // App Store 主蓝（#007AFF / #0A84FF）
  blue: $color({ light: "#007AFF", dark: "#0A84FF" }),
  green: $color({ light: "#34C759", dark: "#30D158" }),
  orange: $color({ light: "#FF9500", dark: "#FF9F0A" }),
  purple: $color({ light: "#AF52DE", dark: "#BF5AF2" }),
  red: $color({ light: "#FF3B30", dark: "#FF453A" }),
  teal: $color({ light: "#30B0C7", dark: "#40C8E0" }),
  gray: $color({ light: "#8E8E93", dark: "#98989D" }),

  // 页面 / 卡片 / 输入框底色
  page: $color("systemGroupedBackground"),
  card: $color("systemSecondaryGroupedBackground"),
  field: $color("systemSecondaryFill"),
  // 文字与分隔线
  label: $color("systemLabel"),
  sub: $color("systemSecondaryLabel"),
  sep: $color("systemSeparator"),
};

// Tab 页面继续铺到悬浮导航栏后面，形成真正的 overlay；滚动内容用
// contentInset 留出可滚动空间，保证最后一行仍能停在胶囊上方。
const FLOATING_TAB_BOTTOM_INSET = 112;

function edgeInsets(bottom) {
  if (typeof $insets === "function") return $insets(0, 0, bottom, 0);
  return { top: 0, left: 0, bottom, right: 0 };
}

// 统一的分组列表样式：灰色页面底 + 白色圆角分组由系统 grouped 样式承担。
function listBaseProps(extra) {
  return Object.assign(
    {
      bgcolor: colors.page,
      style: 1,
      separatorColor: colors.sep,
    },
    extra || {}
  );
}

function floatingTabListProps(extra) {
  const inset = edgeInsets(FLOATING_TAB_BOTTOM_INSET);
  return listBaseProps(
    Object.assign(
      {
        contentInset: inset,
        indicatorInsets: inset,
      },
      extra || {}
    )
  );
}

// 静态 cell 确需重建时保留阅读位置；同一数据集返回优先直接保留原 list。
function preserveListOffset(list, definition) {
  const offset = list && list.contentOffset;
  if (!offset || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return definition;
  const point = typeof $point === "function" ? $point(offset.x, offset.y) : { x: offset.x, y: offset.y };
  definition.props.contentOffset = point;
  const events = definition.events || (definition.events = {});
  const layoutSubviews = events.layoutSubviews;
  let restored = false;
  events.layoutSubviews = (sender) => {
    if (layoutSubviews) layoutSubviews(sender);
    if (restored) return;
    restored = true;
    sender.contentOffset = point;
  };
  return definition;
}

function toast(message) {
  $ui.toast(message);
}

function loading(show) {
  $ui.loading(!!show);
}

function alert(options) {
  if (typeof options === "string") {
    $ui.alert(options);
    return;
  }
  $ui.alert(options);
}

function isSessionExpiredError(err) {
  const code = err && err.code !== undefined ? String(err.code) : "";
  if (code === "2034" || code === "2042") return true;
  const message = errorMessage(err);
  return /(?:^|[^0-9])(2034|2042)(?:[^0-9]|$)/.test(message);
}

function alertError(err) {
  if (isSessionExpiredError(err)) {
    alert({
      title: "Apple ID 会话已过期",
      message: "Apple Store 会话已失效，请重新输入密码登录。当前账号的区域和其他安全会话信息会保留。",
      actions: [
        {
          title: "重新登录",
          handler: () => require("./accounts").render(),
        },
        { title: "取消" },
      ],
    });
    return;
  }
  alert({
    title: "出错了",
    message: errorMessage(err),
  });
}

function menu(options) {
  $ui.menu({
    items: options.items,
    handler: options.handler || function () {},
  });
}

// 异步执行 + 全屏 loading + 错误提示；成功后返回结果。
async function runWithLoading(message, task, options) {
  const opts = options || {};
  const showIndicator = opts.showIndicator !== false;
  const showToast = opts.toast !== false;
  if (showIndicator) loading(true);
  if (message && showToast) toast(message);
  try {
    const result = await task();
    return result;
  } catch (err) {
    alertError(err);
    return null;
  } finally {
    if (showIndicator) loading(false);
  }
}

function priceText(soft) {
  const amount = Number(soft && soft.price);
  if (!Number.isFinite(amount) || amount <= 0) return "免费";
  return format.formatPrice(amount, soft && soft.currency, soft && soft.formattedPrice);
}

function getButtonText(soft, version) {
  if (library.findDownloaded(soft, version)) return "打开";
  if (Number(soft.price || 0) > 0 && soft.owned !== true) {
    return priceText(soft);
  }
  return "获取";
}

function openDownloaded(soft, version) {
  const record = library.findDownloaded(soft, version);
  return !!record && require("./downloads").fileActions(record.fileName);
}

// ---------- 菜单行模板（带符号图标，仿系统设置 / App Store 列表） ----------
// 标题 + 副标题按内容自适应（列表须配合 autoRowHeight 使用）：两个 label
// 都不写死高度，行高由 subtitle 文本行数决定。这样单行副标题会紧贴标题
// 下方约 1px，不会像固定大容器那样被 UILabel 垂直居中到行底，形成
// 标题/副标题之间的明显断层；文本组与 32px 图标仍在行内垂直居中。
// 该常量仅用于滚动估算，详情页 menuTemplate 已有同样的 autoRowHeight 先例。
const ICON_MENU_ESTIMATED_ROW_HEIGHT = 78;

const iconMenuTemplate = {
  props: {
    bgcolor: colors.card,
    selectionStyle: 0,
  },
  views: [
    {
      type: "view",
      props: { id: "tile", cornerRadius: 8, smoothCorners: true },
      layout: (make, view) => {
        make.left.inset(16);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(32, 32));
      },
      views: [
        {
          type: "image",
          props: {
            id: "glyph",
            tintColor: $color("white"),
            contentMode: 1,
          },
          layout: (make, view) => {
            make.center.equalTo(view.super);
            make.size.equalTo($size(19, 19));
          },
        },
      ],
    },
    {
      type: "label",
      props: {
        id: "value",
        font: $font("bold", 14),
        textColor: colors.sub,
        align: $align.right,
        lines: 1,
      },
      layout: (make, view) => {
        make.right.inset(14);
        make.centerY.equalTo(view.super);
        make.width.lessThanOrEqualTo(72);
      },
    },
    {
      type: "label",
      props: { id: "title", font: $font("bold", 16), textColor: colors.label, lines: 1 },
      layout: (make, view) => {
        make.left.equalTo(62);
        make.top.equalTo(12);
        // template 行不依赖兄弟控件查找；右侧为 value 预留固定空间，
        // 窄屏下仍能稳定布局。
        make.right.inset(96);
      },
    },
    {
      type: "label",
      props: { id: "subtitle", font: $font(12), textColor: colors.sub, lines: 2 },
      layout: (make, view) => {
        make.left.equalTo(62);
        // 标题行高约 19pt，这里留 1pt 视觉间距让两段文字接近但不粘连。
        make.top.equalTo(32);
        make.right.inset(96);
        // 底部留白配合 autoRowHeight 推导行高：单行副标题约 57pt、
        // 两行副标题约 71pt，上下留白（12 / 11）基本对称。
        make.bottom.inset(11);
      },
    },
  ],
};

const menuTemplate = {
  props: {
    bgcolor: colors.card,
    selectionStyle: 0,
  },
  views: [
    {
      type: "label",
      props: {
        id: "value",
        font: $font(14),
        textColor: colors.sub,
        align: $align.right,
        lines: 2,
      },
      layout: (make, view) => {
        make.right.inset(16);
        make.centerY.equalTo(view.super);
        make.width.lessThanOrEqualTo(140);
      },
    },
    {
      type: "label",
      props: { id: "title", font: $font(16), textColor: colors.label, lines: 2 },
      layout: (make, view) => {
        make.left.inset(16);
        make.top.inset(8);
        make.right.inset(164);
      },
    },
    {
      type: "label",
      props: { id: "subtitle", font: $font(12), textColor: colors.sub, lines: 0 },
      layout: (make, view) => {
        make.left.inset(16);
        make.top.equalTo(30);
        // 长简介使用 subtitle 承载；不能继续为不存在的 value 列预留宽度。
        make.right.inset(16);
        make.bottom.inset(8);
      },
    },
  ],
};

// ---------- App / 榜单完整行视图（列表不使用 template，每行是完整视图定义） ----------
// JSBox 官方样例（如 fund-data.js）与文档“静态 cells”均要求：不声明 template 的
// list 才能放完整视图行；行根视图用 edges 填充整个 cell。不要把这类行与
// template 数据行混在同一 list 里。

// 行内容视图的公共根：卡片底色 + 分组留白 + 可被 didSelect 选中。
// options.inset 默认 12；首页会传入 16 与顶部 hero card 的左右间距保持一致。
function rowRootView(extraViews, options) {
  const inset = options && Number(options.inset) > 0 ? Number(options.inset) : 12;
  const gap = options && Number(options.gap) >= 0 ? Number(options.gap) : 4;
  const radius = options && Number(options.radius) > 0 ? Number(options.radius) : 16;
  const card = {
    type: "view",
    props: {
      bgcolor: colors.card,
      selectionStyle: 0,
      cornerRadius: radius,
      smoothCorners: true,
      clipsToBounds: true,
      // 静态行默认不可选中；App/榜单行需要 didSelect 响应。
      selectable: true,
    },
    layout: (make, view) => {
      // 给每一行留出分组间距，形成 App Store 的独立卡片行。
      make.left.right.inset(inset);
      make.top.bottom.inset(gap);
    },
    views: extraViews,
  };
  if (!options || !options.staticCell) return card;
  // 静态 cell 的根属性会作用到整行；实际边距和圆角必须放在内层 view。
  card.props.selectable = false;
  if (options.onTap) {
    card.views = [{
      type: "button",
      props: { bgcolor: $color("clear"), accessibilityLabel: options.accessibilityLabel || "查看 App" },
      layout: $layout.fill,
      events: { tapped: options.onTap },
    }].concat(extraViews);
  }
  return {
    type: "view",
    props: { bgcolor: $color("clear"), selectionStyle: 0, selectable: false },
    layout: (make, view) => make.edges.equalTo(view.super),
    views: [card],
  };
}

// 搜索 / 详情通用 App 行（图标 + 名称 + 副标题 + 获取/价格胶囊）。
// 许可由下载流程向服务器查询；公开列表缺少 owned 不能禁用已购付费 App。
// 没有传入下载动作的上下文仍使用纯展示标签。
function appRowView(app, subtitle, actions, options) {
  const nameText = app.name || "";
  const subText = subtitle || app.artistName || app.sellerName || "";
  const getPill = actionPill(
    () => getButtonText(app),
    actions && actions.onGet,
    64,
    { app, region: actions && actions.region }
  );
  return rowRootView([
    {
      type: "image",
      props: {
        src: app.artworkUrl || app.icon,
        cornerRadius: 12,
        smoothCorners: true,
      },
      layout: (make, view) => {
        make.left.inset(16);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(56, 56));
      },
    },
    getPill,
    {
      type: "label",
      props: {
        text: nameText,
        font: $font("bold", 16),
        textColor: colors.label,
        lines: 2,
      },
      layout: (make, view) => {
        make.left.equalTo(84);
        make.top.equalTo(11);
        make.right.inset(88);
        make.height.equalTo(40);
      },
    },
    {
      type: "label",
      props: {
        text: subText,
        font: $font(12),
        textColor: colors.sub,
        lines: 1,
      },
      layout: (make, view) => {
        make.left.equalTo(84);
        make.top.equalTo(53);
        make.right.inset(88);
        make.height.equalTo(17);
      },
    },
  ], Object.assign({
    inset: 16,
    staticCell: true,
    onTap: actions && actions.onView,
    accessibilityLabel: `查看 ${nameText || "App"}`,
  }, options));
}

// 榜单行（App Store Top Charts：排名 + 图标 + 名称 + 价格胶囊）。
// 排名前 3 用品牌蓝大号数字，其余灰色常规号；整行左右留白更接近
// apps.apple.com/cn/charts 的移动端列表观感。
let actionPillSequence = 0;
const downloadButtonRefreshers = new Map();
const downloadCancelConfirmations = new Set();
// 仅衔接公开版本查询/历史枚举与服务任务之间的等待；实际传输以 queue 为准。
// 请求独立于页面存活，返回列表或重建按钮不会重新发起同一请求。
const pendingDownloadActions = new Map();
let unsubscribeDownloadQueue = null;

function downloadIntent(context, accountsByRegion) {
  const app = context && context.app;
  const id = String(app && app.id || "");
  if (!id) return null;
  const region = String(context.region || require("../store/settings").region() || "").toUpperCase();
  let email = context.accountEmail;
  if (email === undefined) {
    if (!accountsByRegion.has(region)) {
      let account = null;
      try { account = require("../store/accounts").accountForRegion(region); } catch (_err) {}
      accountsByRegion.set(region, String(account && account.email || "").trim().toLowerCase());
    }
    email = accountsByRegion.get(region);
  }
  email = String(email || "").trim().toLowerCase();
  const version = String(context.version && context.version.externalVersionId || "");
  return { id, region, email, version, key: JSON.stringify([email, region, id, version]) };
}

function activeDownloadTask(intent, tasks) {
  if (!intent) return null;
  return tasks.find(task => task.status !== "error" &&
    task.app.id === intent.id && String(task.region).toUpperCase() === intent.region &&
    task.accountEmail === intent.email && task.externalVersionId === intent.version) || null;
}

function refreshButtonStates(tasks, forceIdle) {
  const current = tasks || queue.snapshot();
  const accountsByRegion = new Map();
  for (const [id, entry] of downloadButtonRefreshers) {
    // 自动进度沿用 ready/tapped 保留的实例；只有页面返回时才重新查找原生控件。
    const view = forceIdle && typeof $ui !== "undefined" && typeof $ui.get === "function" ? $ui.get(id) : null;
    entry.refresh(view, current, accountsByRegion, forceIdle);
  }
}

function observeDownloadQueue() {
  if (!unsubscribeDownloadQueue) {
    unsubscribeDownloadQueue = queue.subscribe(tasks => refreshButtonStates(tasks, false));
  }
}

function releaseQueueObservation() {
  if (downloadButtonRefreshers.size || !unsubscribeDownloadQueue) return;
  unsubscribeDownloadQueue();
  unsubscribeDownloadQueue = null;
}

function confirmCancelDownload(taskIdOrControl) {
  const control = taskIdOrControl && typeof taskIdOrControl === "object"
    ? taskIdOrControl
    : require("../services/downloader").downloadControl(taskIdOrControl);
  if (!control || typeof control.canCancel !== "function" || !control.canCancel()) return false;
  // 准备阶段的控制器会交接到同一下载任务；弹窗随其 ID 交接，列表不会重复弹出。
  for (const pending of downloadCancelConfirmations) {
    if (pending === control || (pending.id && pending.id === control.id)) return false;
  }
  downloadCancelConfirmations.add(control);
  const dismiss = () => downloadCancelConfirmations.delete(control);
  try {
    alert({
      title: "取消下载？",
      message: control.name || "App",
      actions: [
        { title: "继续下载", handler: dismiss },
        {
          title: "取消下载",
          style: $alertActionType.destructive,
          handler: () => {
            if (!dismiss() || !control.canCancel()) return;
            control.cancel();
            refreshButtonStates(null, false);
          },
        },
      ],
    });
    return true;
  } catch (err) {
    dismiss();
    throw err;
  }
}

function refreshDownloadButtons() {
  refreshButtonStates(null, true);
}

// 由页面替换视图或 dealloc 时调用；不可见不等于已销毁。
function releaseDownloadButtons(definition) {
  if (!definition || typeof definition !== "object") return;
  if (Array.isArray(definition)) {
    definition.forEach(releaseDownloadButtons);
    return;
  }
  const props = definition.props || {};
  const entry = downloadButtonRefreshers.get(props.id);
  if (entry) {
    entry.dispose();
    downloadButtonRefreshers.delete(props.id);
  }
  releaseDownloadButtons(definition.views);
  releaseDownloadButtons(definition.rows);
  releaseDownloadButtons(props.header);
  releaseDownloadButtons(props.data);
  releaseDownloadButtons(props.stack && props.stack.views);
  releaseQueueObservation();
}

function clearDownloadButtons() {
  for (const entry of downloadButtonRefreshers.values()) entry.dispose();
  downloadButtonRefreshers.clear();
  releaseQueueObservation();
}

function actionPill(title, action, width, options) {
  const context = options || {};
  const currentTitle = typeof title === "function" ? title : () => title;
  const initialTitle = currentTitle();
  const props = {
    title: initialTitle,
    text: initialTitle,
    font: $font("bold", 13),
    titleColor: context.prominent ? $color("white") : colors.blue,
    textColor: colors.blue,
    align: $align.center,
    bgcolor: action ? $color("clear") : colors.field,
    cornerRadius: 15,
    smoothCorners: true,
    accessibilityLabel: initialTitle,
  };
  if (!action) {
    return {
      type: "label",
      props,
      layout: (make, parent) => {
        make.right.inset(12);
        make.centerY.equalTo(parent.super);
        make.size.equalTo($size(width || 64, 30));
      },
    };
  }

  // 44pt 触摸区始终保留；胶囊、圆环和 spinner 只切换显示，不改行布局。
  const button = {
    type: "button",
    props,
    layout: (make, parent) => make.edges.equalTo(parent.super),
  };
  const sequence = ++actionPillSequence;
  props.id = `download-action-${sequence}`;
  props.isAccessibilityElement = true;
  const background = {
    type: "view",
    props: {
      id: `download-background-${sequence}`,
      bgcolor: context.prominent ? colors.blue : colors.field,
      cornerRadius: 15,
      smoothCorners: true,
      userInteractionEnabled: false,
    },
    layout: (make, view) => {
      make.left.right.inset(0);
      make.centerY.equalTo(view.super);
      make.height.equalTo(30);
    },
  };
  const progress = {
    type: "canvas",
    props: {
      id: `download-progress-${sequence}`,
      info: { value: 0 },
      bgcolor: $color("clear"),
      hidden: true,
      userInteractionEnabled: false,
      isAccessibilityElement: false,
    },
    layout: (make, view) => {
      make.center.equalTo(view.super);
      make.size.equalTo($size(30, 30));
    },
    events: {
      draw: (view, ctx) => {
        const value = Math.max(0, Math.min(1, Number(view.info && view.info.value) || 0));
        const x = view.frame.width / 2;
        const y = view.frame.height / 2;
        const radius = Math.min(x, y) - 1.5;
        ctx.strokeColor = colors.blue;
        ctx.setLineWidth(2.4);
        ctx.setLineCap(1);
        ctx.setAlpha(0.16);
        ctx.beginPath();
        ctx.addArc(x, y, radius, -Math.PI / 2, Math.PI * 1.5, false);
        ctx.strokePath();
        if (value > 0) {
          ctx.setAlpha(1);
          ctx.beginPath();
          ctx.addArc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * value, false);
          ctx.strokePath();
        }
      },
    },
  };
  const spinner = {
    type: "spinner",
    props: {
      id: `download-spinner-${sequence}`, color: colors.blue, style: 1,
      loading: false, hidden: true, userInteractionEnabled: false, isAccessibilityElement: false,
    },
    layout: (make, view) => {
      make.center.equalTo(view.super);
      make.size.equalTo($size(26, 26));
    },
  };
  const stop = {
    type: "view",
    props: {
      id: `download-stop-${sequence}`, bgcolor: colors.blue, cornerRadius: 1.5,
      hidden: true, userInteractionEnabled: false, isAccessibilityElement: false,
    },
    layout: (make, view) => {
      make.center.equalTo(view.super);
      make.size.equalTo($size(8, 8));
    },
  };
  let disposed = false;
  let localRequest = null;
  let nativeButton = null;
  let wasBusy = false;
  let previousKey = null;
  const patch = (definition, values) => {
    const parent = nativeButton && nativeButton.super;
    const native = definition === button ? nativeButton
      : parent && typeof parent.get === "function" ? parent.get(definition.props.id) : null;
    Object.assign(definition.props, values);
    if (native) Object.assign(native, values);
    return native;
  };
  const stateFor = (intent, tasks) => {
    const request = intent ? pendingDownloadActions.get(intent.key) : localRequest;
    const task = activeDownloadTask(intent, tasks);
    if (!task) return request && request.live ? request : null;
    return {
      status: task.status, progress: task.downloadProgress,
      control: require("../services/downloader").downloadControl(task.id),
    };
  };
  const refresh = (sender, tasks, accountsByRegion, forceIdle) => {
    if (disposed) return;
    if (sender) nativeButton = sender;
    const intent = downloadIntent(context, accountsByRegion || new Map());
    const key = intent && intent.key;
    const state = stateFor(intent, tasks || queue.snapshot());
    const busy = !!state && state.presentBusy !== false;
    if (!busy && !wasBusy && previousKey === key && !forceIdle) return;
    previousKey = key;
    wasBusy = busy;
    const determinate = busy && state.status === "downloading" &&
      typeof state.progress === "number" && Number.isFinite(state.progress);
    const cancellable = busy && state.control && state.control.canCancel();
    const name = context.app && context.app.name ? ` ${context.app.name}` : "";
    const statusText = busy ? ({
      preparing: "准备下载", downloading: "正在下载", cancelling: "正在取消",
      verifying: "正在校验", injecting: "正在处理", saving: "正在保存",
    }[state.status] || "正在处理") : "";
    const value = determinate ? Math.max(0, Math.min(1, state.progress)) : progress.props.info.value;
    const idleTitle = busy ? "" : currentTitle();
    props.text = idleTitle;
    patch(button, {
      title: idleTitle,
      accessibilityLabel: `${busy ? statusText : idleTitle}${name}`,
      accessibilityValue: determinate ? `${Math.round(value * 100)}%` : statusText,
      accessibilityHint: busy ? cancellable ? "点按取消下载" : statusText
        : idleTitle === "打开" ? "打开下载文件操作" : "下载 IPA",
    });
    patch(background, { hidden: busy });
    const ring = patch(progress, { hidden: !determinate, info: { value } });
    patch(spinner, { hidden: !busy || determinate, loading: busy && !determinate });
    patch(stop, { hidden: !cancellable });
    // canvas 的绘制上下文由 JSBox 提供，重绘通过文档支持的 ocValue 桥接调用
    // UIView 公共方法；不假设存在 Web Canvas 或 view.value 的重绘语义。
    if (ring && determinate && typeof ring.ocValue === "function") {
      ring.ocValue().invoke("setNeedsDisplay");
    }
  };
  const releaseControl = request => {
    if (request && request.unsubscribe) request.unsubscribe();
    if (request) request.unsubscribe = null;
  };
  downloadButtonRefreshers.set(props.id, {
    refresh,
    dispose: () => {
      disposed = true;
      nativeButton = null;
      // 无 App 上下文的纯局部动作不用跨页面接续。
      if (localRequest && !localRequest.key) releaseControl(localRequest);
    },
  });
  observeDownloadQueue();
  button.events = {
    ready: sender => refresh(sender, null, new Map(), true),
    tapped: async sender => {
      if (disposed) return;
      if (sender) nativeButton = sender;
      const intent = downloadIntent(context, new Map());
      const state = stateFor(intent, queue.snapshot());
      if (state) {
        refresh(sender, null, new Map(), true);
        if (state.control && state.control.canCancel()) confirmCancelDownload(state.control);
        return;
      }
      const request = {
        key: intent && intent.key, live: true, cancelled: false,
        status: "preparing", progress: null, control: null, unsubscribe: null,
        presentBusy: currentTitle() !== "打开",
      };
      localRequest = request;
      if (request.key) pendingDownloadActions.set(request.key, request);
      refreshButtonStates(null, false);
      const setProgress = (written, total) => {
        if (!request.live || request.cancelled) return;
        const amount = Number(written) || 0;
        const maximum = Number(total) || 0;
        request.status = "downloading";
        request.progress = maximum > 0 ? Math.max(0, Math.min(1, amount / maximum)) : null;
        refreshButtonStates(null, false);
      };
      const onTask = (control) => {
        if (!request.live || request.cancelled || (disposed && !request.key)) return;
        releaseControl(request);
        const task = control && queue.snapshot().find(value => value.id === control.id);
        if (request.key && task) {
          const key = JSON.stringify([task.accountEmail, String(task.region).toUpperCase(), task.app.id, task.externalVersionId]);
          if (key !== request.key) {
            if (pendingDownloadActions.get(request.key) === request) pendingDownloadActions.delete(request.key);
            request.key = key;
            if (!pendingDownloadActions.has(key)) pendingDownloadActions.set(key, request);
          }
        }
        request.control = control;
        if (control && typeof control.subscribe === "function") {
          request.unsubscribe = control.subscribe(() => {
            if (!request.live || request.control !== control) return;
            request.cancelled = true;
            request.status = "cancelling";
            refreshButtonStates(null, false);
          });
        }
        refreshButtonStates(null, false);
      };
      try {
        await action(setProgress, onTask);
      } catch (_err) {
        // 业务动作负责错误提示；失败后所有页面一致恢复获取。
      } finally {
        request.live = false;
        releaseControl(request);
        if (request.key && pendingDownloadActions.get(request.key) === request) pendingDownloadActions.delete(request.key);
        if (localRequest === request) localRequest = null;
        refreshButtonStates(null, false);
      }
    },
  };
  return {
    type: "view",
    props: { bgcolor: $color("clear") },
    layout: (make, parent) => {
      make.right.inset(12);
      make.centerY.equalTo(parent.super);
      make.size.equalTo($size(width || 64, 44));
    },
    views: [background, progress, spinner, stop, button],
  };
}

function chartRowView(app, index, actions, options) {
  const top3 = index < 3;
  // 内层卡片进入详情，胶囊单独下载，避免静态 cell 的选中态遮住圆角。
  const textRightInset = 88;
  const rowViews = [
    {
      type: "label",
      props: {
        text: String(index + 1),
        font: $font("bold", top3 ? 20 : 16),
        textColor: top3 ? colors.blue : colors.sub,
        align: $align.center,
      },
      layout: (make, view) => {
        make.left.inset(16);
        make.centerY.equalTo(view.super);
        make.width.equalTo(26);
      },
    },
    {
      type: "image",
      props: {
        src: app.artworkUrl || app.icon,
        cornerRadius: 14,
        smoothCorners: true,
      },
      layout: (make, view) => {
        make.left.equalTo(54);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(54, 54));
      },
    },
    actionPill(
      () => getButtonText(app),
      actions && actions.onGet,
      64,
      { app, region: actions && actions.region }
    ),
    {
      type: "label",
      props: {
        text: app.name || "",
        font: $font("bold", 16),
        textColor: colors.label,
        lines: 2,
      },
      layout: (make, view) => {
        make.left.equalTo(116);
        make.top.equalTo(10);
        make.right.inset(textRightInset);
        make.height.equalTo(40);
      },
    },
    {
      type: "label",
      props: {
        text: app.artistName || app.sellerName || app.category || "",
        font: $font(12),
        textColor: colors.sub,
        lines: 1,
      },
      layout: (make, view) => {
        make.left.equalTo(116);
        make.top.equalTo(53);
        make.right.inset(textRightInset);
        make.height.equalTo(17);
      },
    },
  ].filter(Boolean);
  return rowRootView(rowViews, Object.assign({
    inset: 16,
    staticCell: true,
    onTap: actions && actions.onView,
    accessibilityLabel: `查看 ${app.name || "App"}`,
  }, options));
}

// 首页“编辑最爱”行：参考 App Store Today 的大图标 + 副标题 + 查看胶囊。
function editorialRowView(app, actions, options) {
  const getButton = actionPill(
    () => getButtonText(app),
    actions && actions.onGet,
    62,
    { app, region: actions && actions.region }
  );
  getButton.layout = (make, view) => {
    make.right.inset(14);
    make.centerY.equalTo(view.super);
    make.size.equalTo($size(62, actions && actions.onGet ? 44 : 30));
  };
  return rowRootView([
    {
      type: "image",
      props: {
        src: app.artworkUrl || app.icon,
        cornerRadius: 16,
        smoothCorners: true,
        accessibilityLabel: `${app.name || "App"} 图标`,
      },
      layout: (make, view) => {
        make.left.inset(16);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(64, 64));
      },
    },
    getButton,
    {
      type: "label",
      props: {
        text: app.name || "",
        font: $font("bold", 17),
        textColor: colors.label,
        lines: 2,
      },
      layout: (make) => {
        make.left.equalTo(96);
        make.top.equalTo(10);
        make.right.inset(90);
        make.height.equalTo(40);
      },
    },
    {
      type: "label",
      props: {
        text: app.artistName || app.sellerName || app.category || "",
        font: $font(13),
        textColor: colors.sub,
        lines: 2,
      },
      layout: (make) => {
        make.left.equalTo(96);
        make.top.equalTo(53);
        make.right.inset(90);
        make.height.equalTo(34);
      },
    },
  ], Object.assign({
    inset: 16,
    staticCell: true,
    onTap: actions && actions.onView,
    accessibilityLabel: `查看 ${app.name || "App"}`,
  }, options));
}

// ---------- 表单控件（登录 / 设置等页面复用） ----------
// 返回一个胶囊主按钮的 props
function primaryButtonProps(title, extra) {
  return Object.assign(
    {
      title,
      titleColor: $color("white"),
      bgcolor: colors.blue,
      font: $font("bold", 17),
      cornerRadius: 22,
      smoothCorners: true,
    },
    extra || {}
  );
}

// 返回一个圆角输入框的 props
function fieldProps(placeholder, extra) {
  return Object.assign(
    {
      placeholder,
      bgcolor: colors.field,
      textColor: colors.label,
      cornerRadius: 10,
      smoothCorners: true,
      font: $font(16),
      autocorrectionType: 0,
      autocapitalizationType: 0,
    },
    extra || {}
  );
}

// ---------- 区域选择（多 Tab 复用，避免每个页面各写一份） ----------

const REGION_ORDER = ["CN", "US", "JP", "HK", "TW"];

const COUNTRY_NAMES = {
  CN: "中国大陆", US: "美国", JP: "日本", HK: "中国香港", TW: "中国台湾",
  KR: "韩国", SG: "新加坡", AU: "澳大利亚", CA: "加拿大", GB: "英国",
  DE: "德国", FR: "法国", IT: "意大利", ES: "西班牙", NL: "荷兰",
  CH: "瑞士", SE: "瑞典", NO: "挪威", DK: "丹麦", FI: "芬兰",
  IN: "印度", ID: "印度尼西亚", MY: "马来西亚", TH: "泰国", VN: "越南",
  PH: "菲律宾", NZ: "新西兰", BR: "巴西", MX: "墨西哥", RU: "俄罗斯",
  TR: "土耳其", AE: "阿联酋", SA: "沙特阿拉伯", IL: "以色列", ZA: "南非",
  IE: "爱尔兰", AT: "奥地利", BE: "比利时", PL: "波兰", PT: "葡萄牙",
  GR: "希腊", CZ: "捷克", HU: "匈牙利", RO: "罗马尼亚", UA: "乌克兰",
  AG: "安提瓜和巴布达", AI: "安圭拉", AL: "阿尔巴尼亚", AM: "亚美尼亚", AO: "安哥拉",
  AR: "阿根廷", AZ: "阿塞拜疆", BB: "巴巴多斯", BD: "孟加拉国", BG: "保加利亚",
  BH: "巴林", BM: "百慕大", BN: "文莱", BO: "玻利维亚", BS: "巴哈马",
  BW: "博茨瓦纳", BY: "白俄罗斯", BZ: "伯利兹", CI: "科特迪瓦", CL: "智利",
  CO: "哥伦比亚", CR: "哥斯达黎加", CY: "塞浦路斯", DM: "多米尼克", DO: "多米尼加",
  DZ: "阿尔及利亚", EC: "厄瓜多尔", EE: "爱沙尼亚", EG: "埃及", GD: "格林纳达",
  GE: "格鲁吉亚", GH: "加纳", GT: "危地马拉", GY: "圭亚那", HN: "洪都拉斯",
  HR: "克罗地亚", IQ: "伊拉克", IS: "冰岛", JM: "牙买加", JO: "约旦", KE: "肯尼亚",
  KN: "圣基茨和尼维斯", KW: "科威特", KY: "开曼群岛", KZ: "哈萨克斯坦", LB: "黎巴嫩",
  LC: "圣卢西亚", LI: "列支敦士登", LK: "斯里兰卡", LT: "立陶宛", LU: "卢森堡",
  LV: "拉脱维亚", MD: "摩尔多瓦", MG: "马达加斯加", MK: "北马其顿", ML: "马里",
  MN: "蒙古", MO: "中国澳门", MS: "蒙特塞拉特", MT: "马耳他", MU: "毛里求斯",
  MV: "马尔代夫", MY: "马来西亚", NE: "尼日尔", NG: "尼日利亚", NI: "尼加拉瓜",
  NP: "尼泊尔", OM: "阿曼", PA: "巴拿马", PE: "秘鲁", PH: "菲律宾",
  PK: "巴基斯坦", PY: "巴拉圭", QA: "卡塔尔", RS: "塞尔维亚", SK: "斯洛伐克",
  SI: "斯洛文尼亚", SN: "塞内加尔", SR: "苏里南", SV: "萨尔瓦多", TC: "特克斯和凯科斯群岛",
  TH: "泰国", TN: "突尼斯", TT: "特立尼达和多巴哥", TZ: "坦桑尼亚", UG: "乌干达",
  UY: "乌拉圭", UZ: "乌兹别克斯坦", VC: "圣文森特和格林纳丁斯", VE: "委内瑞拉",
  VG: "英属维尔京群岛", VN: "越南", YE: "也门",
};

function countryName(code) {
  const normalized = String(code || "").toUpperCase();
  return COUNTRY_NAMES[normalized] || `国家/地区 ${normalized}`;
}

function regionText(code, separator) {
  const normalized = String(code || "").toUpperCase();
  return `${countryName(normalized)}${separator || "  "}${normalized}`;
}

// 两列区域控件：国家名称固定在左侧，ISO 缩写固定贴右侧，避免把两者
// 拼成一段居中文字后在窄屏上漂移或被截断。
function regionControl(id, code, onTap, layout) {
  const normalized = String(code || "").toUpperCase();
  return {
    type: "view",
    props: {
      id,
      bgcolor: colors.field,
      cornerRadius: 20,
      smoothCorners: true,
      selectionStyle: 0,
      isAccessibilityElement: true,
      accessibilityLabel: "商店区域",
      accessibilityValue: regionText(normalized),
      accessibilityHint: "选择 App Store 区域",
    },
    layout: layout || $layout.fill,
    views: [
      {
        type: "label",
        props: {
          id: `${id}-name`,
          text: countryName(normalized),
          font: $font("bold", 13),
          textColor: colors.blue,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(14);
          make.right.inset(48);
          make.centerY.equalTo(view.super);
          make.height.equalTo(19);
        },
      },
      {
        type: "label",
        props: {
          id: `${id}-code`,
          text: normalized,
          font: $font("bold", 13),
          textColor: colors.blue,
          align: $align.right,
          lines: 1,
        },
        layout: (make, view) => {
          make.right.inset(14);
          make.centerY.equalTo(view.super);
          make.width.equalTo(34);
          make.height.equalTo(19);
        },
      },
      {
        type: "button",
        props: {
          id: `${id}-tap`,
          bgcolor: $color("clear"),
          accessibilityLabel: "选择商店区域",
        },
        layout: $layout.fill,
        events: { tapped: onTap || function () {} },
      },
    ],
  };
}

function updateRegionControl(id, code) {
  const normalized = String(code || "").toUpperCase();
  const root = $(`${id}`);
  const name = $(`${id}-name`);
  const value = $(`${id}-code`);
  if (name) name.text = countryName(normalized);
  if (value) value.text = normalized;
  if (root) root.accessibilityValue = regionText(normalized);
}

function regionPickerRow(code, selected, onPick) {
  const normalized = String(code || "").toUpperCase();
  return {
    type: "view",
    props: {
      bgcolor: colors.card,
      selectionStyle: 0,
      selectable: false,
    },
    layout: (make, view) => make.edges.equalTo(view.super),
    views: [
      {
        type: "label",
        props: {
          text: countryName(normalized),
          font: selected ? $font("bold", 16) : $font(16),
          textColor: colors.label,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.inset(20);
          make.right.inset(112);
          make.centerY.equalTo(view.super);
          make.height.equalTo(22);
        },
      },
      {
        type: "label",
        props: {
          text: normalized,
          font: $font("bold", 15),
          textColor: selected ? colors.blue : colors.sub,
          align: $align.right,
          lines: 1,
        },
        layout: (make, view) => {
          make.right.inset(20);
          make.centerY.equalTo(view.super);
          make.width.equalTo(64);
          make.height.equalTo(21);
        },
      },
      {
        type: "button",
        props: { bgcolor: $color("clear"), accessibilityLabel: regionText(normalized) },
        layout: $layout.fill,
        events: {
          tapped: () => {
            try {
              onPick(normalized);
              if (typeof $ui !== "undefined" && typeof $ui.pop === "function") {
                $ui.pop();
              }
            } catch (err) {
              alertError(err);
            }
          },
        },
      },
    ],
  };
}

function orderedRegionCodes() {
  return Object.keys(require("../config").COUNTRY_STORE_MAP).sort((a, b) => {
    const ia = REGION_ORDER.indexOf(a);
    const ib = REGION_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

// 弹出区域菜单，onPick(code) 在选中后回调。
function pickRegion(onPick) {
  const codes = orderedRegionCodes();
  const current = String(require("../store/settings").region() || "").toUpperCase();
  // 自定义列表让国家名和缩写分别布局；旧版运行时若没有 push，则保留
  // 系统菜单回退，功能仍可用。
  if (typeof $ui !== "undefined" && typeof $ui.push === "function") {
    $ui.push(page({
      props: pageProps({
        title: "选择国家/地区",
        bottomSheet: true,
        navButtons: [
          {
            title: "取消",
            symbol: "xmark",
            handler: () => {
              if (typeof $ui.pop === "function") $ui.pop();
            },
          },
        ],
      }),
      views: [
        {
          type: "list",
          props: listBaseProps({
            id: "region-picker-list",
            data: [
              {
                title: "App Store 区域",
                rows: codes.map((code) =>
                  regionPickerRow(code, code === current, onPick)
                ),
              },
            ],
            rowHeight: 56,
            sectionTitleHeight: 34,
          }),
          layout: $layout.fill,
        },
      ],
    }));
    return;
  }
  menu({
    items: codes.map((code) => regionText(code, "    ")),
    handler: (_title, idx) => onPick(codes[idx]),
  });
}

// 页面统一外壳：灰色底、可选的标题与图标说明。
function pageProps(extra) {
  return Object.assign(
    {
      bgcolor: colors.page,
      barColor: colors.page,
      titleColor: colors.label,
      iconColor: colors.blue,
      theme: "auto",
      navButtons: [],
      debugging: false,
    },
    extra || {}
  );
}

function page(definition, binding) {
  return require("./navigation").page(definition, binding);
}

// ---------- 列表数据辅助函数 ----------

function iconMenuRow(title, subtitle, value, key, symbol, tileColor, valueColor) {
  return {
    _key: key || "",
    tile: {
      bgcolor: tileColor || colors.gray,
      cornerRadius: 8,
      smoothCorners: true,
    },
    glyph: {
      symbol: symbol || "circle.fill",
      tintColor: $color("white"),
    },
    title: { text: title || "" },
    subtitle: { text: subtitle || "" },
    value: {
      text: value || "",
      textColor: valueColor || colors.sub,
    },
  };
}

function menuRowData(title, subtitle, value, key) {
  return {
    _key: key || "",
    title: { text: title || "" },
    subtitle: { text: subtitle || "" },
    value: { text: value || "" },
  };
}

function rowKey(row) {
  return row && row._key ? row._key : "";
}

function menuSection(title, rows) {
  return {
    title: title || "",
    rows: rows || [],
  };
}

module.exports = {
  colors,
  listBaseProps,
  floatingTabListProps,
  preserveListOffset,
  FLOATING_TAB_BOTTOM_INSET,
  pageProps,
  page,
  orderedRegionCodes,
  countryName,
  regionText,
  regionControl,
  updateRegionControl,
  regionPickerRow,
  pickRegion,
  primaryButtonProps,
  fieldProps,
  toast,
  loading,
  alert,
  isSessionExpiredError,
  alertError,
  menu,
  runWithLoading,
  priceText,
  getButtonText,
  openDownloaded,
  refreshDownloadButtons,
  releaseDownloadButtons,
  clearDownloadButtons,
  confirmCancelDownload,
  ICON_MENU_ESTIMATED_ROW_HEIGHT,
  iconMenuTemplate,
  iconMenuRow,
  rowRootView,
  appRowView,
  menuTemplate,
  chartRowView,
  editorialRowView,
  actionPill,
  menuRowData,
  rowKey,
  menuSection,
  format,
};
