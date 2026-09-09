// 下载 Tab：任务控制与已注入 IPA 管理，未注入 IPA 在归档页保留。
// 每次进入该 Tab 时重新读取本地库，保证从详情页下载后能立刻看到。
// 行首显示随 IPA 一起保存的 App 图标；没有图标（例如从“文件”导入的
// IPA）时用默认占位。列表顶部提供“导入 IPA 文件”入口。
//
// 布局与交互约定：
// - 行高由正文按实际排版宽度实测（$text.sizeThatFits）得到，标题/副标题
//   各自决定 1~2 行；账号独占标签，超长内容交给 UILabel 尾部省略。
// - 行点击不依赖整行 didSelect（静态 cell 会保留系统选中高亮/按压动效），
//   而是“根视图不可选中 + 全卡片透明按钮”，与账号/状态行同一套模式。
// - 下载进度只原位刷新任务行（更新数据定义 + 已出现 cell 的文本/百分比/
//   进度条），避免每 300ms remove+add 整个列表造成的跳动与点击打断。

const common = require("./common");
const library = require("../store/library");
const installer = require("./install");
const queue = require("../services/queue");
const format = require("../lib/format");
const ipaInjector = require("../services/ipa-injector");

const C = common.colors;
const ICON_SIZE = 56;

// 文本区从图标右侧开始，右边为“大小 / 百分比”预留。
const TEXT_LEFT = 84;
const TEXT_RIGHT_INSET = 96;
const CARD_SIDE_INSET = 16;
const ROW_GAP = 4;

// 卡片最小高度：图标 56 + 上下各约 12pt；任务行再为底部进度条留出空间。
const FILE_MIN_CARD_HEIGHT = 80;
const TASK_MIN_CARD_HEIGHT = 88;

const TEXT_TOP_INSET = 12;
const TEXT_BOTTOM_INSET = 11;
const TEXT_GAP = 2;
const ACCOUNT_GAP = 4;
const PROGRESS_BOTTOM_SPACE = 13;

// $text.sizeThatFits 不可用时的退化字号估算（与旧版固定行高观感一致）。
const TITLE_FALLBACK_SINGLE = 20;
const SUBTITLE_FALLBACK_SINGLE = 16;

const ROW_MIN_HEIGHT = FILE_MIN_CARD_HEIGHT + ROW_GAP * 2; // 88
const ARCHIVE_ROW_HEIGHT = 56;
const EMPTY_ROW_HEIGHT = 72;

function screenWidth() {
  try {
    if (typeof $device !== "undefined" && $device.info && $device.info.screen) {
      const value = Number($device.info.screen.width);
      if (value > 0) return value;
    }
  } catch (_e) {}
  return 375;
}

// 单行文本区可用宽度（仅用于排版与退化估算；真正截断由 UILabel 承担）。
function textAreaWidth() {
  return Math.max(
    100,
    screenWidth() - CARD_SIDE_INSET * 2 - TEXT_LEFT - TEXT_RIGHT_INSET
  );
}

function charWidth(codePoint, fontSize) {
  const cp = Number(codePoint) || 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x11ff) || // 谚文
    (cp >= 0x2e80 && cp <= 0xd7af) || // CJK 部首/汉字/谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xff01 && cp <= 0xff60) || // 全角标点
    cp >= 0x20000; // CJK 扩展 B+
  return wide ? fontSize : fontSize * 0.72;
}

function textWidth(text, fontSize) {
  let width = 0;
  for (const ch of String(text || "")) {
    width += charWidth(ch.codePointAt(0), fontSize);
  }
  return width;
}

// 用 UIKit 原生排版实测一段文字在 maxWidth 下的高度；失败返回 null。
function nativeTextHeight(text, font, maxWidth) {
  try {
    if (
      typeof $text !== "undefined" &&
      $text &&
      typeof $text.sizeThatFits === "function"
    ) {
      const size = $text.sizeThatFits({
        text: String(text || " "),
        width: Math.max(1, Math.floor(maxWidth || 0)),
        font,
      });
      if (typeof size === "number") return size;
      if (size && typeof size === "object") {
        const height =
          Number(size.height) ||
          (size.size && Number(size.size.height)) ||
          0;
        if (height > 0) return height;
      }
    }
  } catch (_e) {}
  return null;
}

// 决定一个文本标签需要 1 行还是 2 行，以及对应行高。
// 优先按 nativeTextHeight 实测；旧运行时退化到字符宽度估算。
function linePlan(text, font, maxWidth, fontSize, fallbackSingle) {
  const sample = nativeTextHeight("Ag", font, 320);
  const sampleHeight = sample || fallbackSingle;
  const fullHeight = nativeTextHeight(text, font, maxWidth);
  if (fullHeight === null) {
    const single = textWidth(text, fontSize) <= maxWidth;
    const lines = single ? 1 : 2;
    return {
      lines,
      height: single ? fallbackSingle : fallbackSingle * 2 + 2,
    };
  }
  const lines = Math.max(1, Math.min(2, Math.round(fullHeight / sampleHeight)));
  const height = Math.min(fullHeight, sampleHeight * 2 + 2);
  return { lines, height };
}

// 整行排版计划：标题、副标题各自换行，行高 = 文本块 + 留白 + 卡片边距。
// withProgress 用于下载中任务行（底部给进度条额外留白）。
function rowPlan(titleText, subtitleText, withProgress, accountText) {
  const width = textAreaWidth();
  const title = linePlan(
    titleText,
    $font("bold", 16),
    width,
    16,
    TITLE_FALLBACK_SINGLE
  );
  const subtitle = linePlan(
    subtitleText,
    $font(12),
    width,
    12,
    SUBTITLE_FALLBACK_SINGLE
  );
  const account = linePlan(accountText, $font(12), width, 12, SUBTITLE_FALLBACK_SINGLE);
  const bottomSpace = withProgress ? PROGRESS_BOTTOM_SPACE : TEXT_BOTTOM_INSET;
  const contentHeight =
    TEXT_TOP_INSET + title.height + TEXT_GAP + subtitle.height + ACCOUNT_GAP + account.height + bottomSpace;
  const minCard = withProgress ? TASK_MIN_CARD_HEIGHT : FILE_MIN_CARD_HEIGHT;
  const cardHeight = Math.max(minCard, contentHeight);
  return {
    title,
    subtitle,
    account,
    height: Math.round(cardHeight + ROW_GAP * 2),
  };
}

// 当前渲染的任务快照与行定义；进度刷新时先更新定义（离屏 cell 复用），
// 再原位更新已出现的 cell。
let tasksSnapshot = [];
let taskRowDefs = [];
let taskRowPaths = [];
let subscribed = false;
let refreshTimer = null;
let archiveSequence = 0;
const archiveRefreshers = new Set();

function iconLayout(make, view) {
  make.left.inset(16);
  make.centerY.equalTo(view.super);
  make.size.equalTo($size(ICON_SIZE, ICON_SIZE));
}

// 无图标时的默认占位：圆角浅色底 + SF Symbol。
function placeholderIcon(symbol) {
  return {
    type: "view",
    props: {
      bgcolor: C.field,
      cornerRadius: 12,
      smoothCorners: true,
      clipsToBounds: true,
    },
    layout: iconLayout,
    views: [
      {
        type: "image",
        props: {
          symbol: symbol || "app",
          tintColor: C.sub,
          contentMode: 1,
        },
        layout: (make, view) => {
          make.center.equalTo(view.super);
          make.size.equalTo($size(24, 24));
        },
      },
    ],
  };
}

function iconView(item) {
  const data = item && item.iconPath ? library.iconData(item.fileName) : null;
  if (data) {
    return {
      type: "image",
      props: {
        data,
        cornerRadius: 12,
        smoothCorners: true,
      },
      layout: iconLayout,
    };
  }
  return placeholderIcon(
    item && item.recovered ? "exclamationmark.triangle.fill" : "app"
  );
}

function valueLabel(text) {
  return {
    type: "label",
    props: {
      id: "dl-value",
      text: text || "",
      font: $font("bold", 14),
      textColor: C.sub,
      align: $align.right,
      lines: 1,
    },
    layout: (make, view) => {
      make.right.inset(14);
      make.centerY.equalTo(view.super);
      make.width.lessThanOrEqualTo(72);
    },
  };
}

function titleLabel(text, plan) {
  return {
    type: "label",
    props: {
      id: "dl-title",
      text: text || "",
      font: $font("bold", 16),
      textColor: C.label,
      lines: plan.lines,
    },
    layout: (make, view) => {
      make.left.equalTo(TEXT_LEFT);
      make.top.equalTo(TEXT_TOP_INSET);
      make.right.inset(TEXT_RIGHT_INSET);
      make.height.equalTo(plan.height);
    },
  };
}

function subtitleLabel(text, plan, titleHeight, textColor) {
  return {
    type: "label",
    props: {
      id: "dl-subtitle",
      text: text || "",
      font: $font(12),
      textColor: textColor || C.sub,
      lines: plan.lines,
    },
    layout: (make, view) => {
      make.left.equalTo(TEXT_LEFT);
      make.top.equalTo(TEXT_TOP_INSET + titleHeight + TEXT_GAP);
      make.right.inset(TEXT_RIGHT_INSET);
      make.height.equalTo(plan.height);
    },
  };
}

function accountSubtitle(item) {
  const email = typeof item.accountEmail === "string" ? item.accountEmail.trim() : "";
  return `账号：${email || "未知"}`;
}

function accountLabel(item, plan) {
  const label = subtitleLabel(accountSubtitle(item), plan.account, 0);
  label.props.id = "dl-account";
  label.props.accessibilityLabel = label.props.text;
  label.layout = make => {
    make.left.equalTo(TEXT_LEFT);
    make.right.inset(TEXT_RIGHT_INSET);
    make.top.equalTo(TEXT_TOP_INSET + plan.title.height + TEXT_GAP + plan.subtitle.height + ACCOUNT_GAP);
    make.height.equalTo(plan.account.height);
  };
  return label;
}

// 任务行底部进度条：占满图标右侧到卡片右边，高度/配色与详情页获取
// 胶囊里的进度条保持一致，失败行不显示进度条（整行改为红色失败文案）。
function progressBar(task) {
  return {
    type: "progress",
    props: {
      id: "dl-progress",
      value: Math.max(0, Math.min(1, Number(task.progress) || 0)),
      progressColor: C.blue,
      trackColor: C.field,
      userInteractionEnabled: false,
    },
    layout: (make, view) => {
      make.left.equalTo(TEXT_LEFT);
      make.right.inset(14);
      make.bottom.inset(6);
      make.height.equalTo(3);
    },
  };
}

// 行根视图：与普通卡片一致，但整行不可选中，点击交给全卡片透明按钮，
// 避免静态 cell 被系统选中后出现与圆角卡片不协调的高亮/按压动画。
function cardRow(views, onTap, accessibilityLabel, trailingAction) {
  const root = common.rowRootView(views, { gap: ROW_GAP, staticCell: true, inset: CARD_SIDE_INSET });
  if (onTap) {
    root.views[0].views.push({
      type: "button",
      props: {
        bgcolor: $color("clear"),
        accessibilityLabel: accessibilityLabel || "操作",
      },
      layout: trailingAction ? (make) => {
        make.left.top.bottom.inset(0);
        make.right.inset(58);
      } : $layout.fill,
      events: {
        tapped: () => {
          try {
            return onTap();
          } catch (err) {
            common.alertError(err);
          }
        },
      },
    });
  }
  if (trailingAction) root.views[0].views.push(trailingAction);
  return root;
}

function fileSubtitle(item) {
  const versionText = /^\d/.test(item.version || "") ? `v${item.version}` : item.version || "";
  const metadataText = item.recovered
    ? "元数据待恢复"
    : [item.bundleId, versionText].filter(Boolean).join(" · ") || "IPA";
  const dateText = format.formatDateTime(item.createdAt);
  return [metadataText, dateText].filter(Boolean).join(" · ");
}

function fileTitle(item) {
  const title = (
    (item.title || "").trim() || String(item.fileName).replace(/\.ipa$/i, "")
  );
  return item.sinfInjected === true ? title.replace(/（已注入SINFO?）$/, "").trim() || title : title;
}

function fileRow(item, plan) {
  const title = fileTitle(item);
  const subtitle = fileSubtitle(item);
  return cardRow(
    [
      iconView(item),
      valueLabel(item.size ? format.formatBytes(item.size) : ""),
      titleLabel(title, plan.title),
      subtitleLabel(subtitle, plan.subtitle, plan.title.height),
      accountLabel(item, plan),
    ],
    () => fileActions(item.fileName),
    `${title}，${accountSubtitle(item)}，点按操作`
  );
}

function taskSubtitle(task) {
  if (task.status === "cancelling") return "正在取消…";
  if (task.status === "error") {
    return `下载失败：${task.error || "未知错误"} · 点按重试`;
  }
  return task.message || "正在下载…";
}

function taskTitle(task) {
  return (task.app && task.app.name) || "正在下载";
}

function percentText(task) {
  if (task.status === "error" || task.status === "cancelling" || task.progress <= 0) return "";
  return `${Math.round(task.progress * 100)}%`;
}

function removeFailedTask(id) {
  const task = queue.snapshot().find(item => item.id === id);
  if (!task || task.status !== "error") return false;
  queue.remove(id);
  update();
  return true;
}

function taskControl(task) {
  if (task.status === "cancelling") {
    return {
      type: "spinner",
      props: { loading: true, color: C.sub, style: 1 },
      layout: (make, view) => {
        make.right.inset(22);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(20, 20));
      },
    };
  }
  const failed = task.status === "error";
  if (!failed && task.cancellable === false) return null;
  return {
    type: "button",
    props: {
      bgcolor: $color("clear"),
      accessibilityLabel: failed ? "删除失败任务" : "取消下载",
    },
    layout: (make, view) => {
      make.right.inset(10);
      make.centerY.equalTo(view.super).offset(failed ? 0 : -8);
      make.size.equalTo($size(44, 44));
    },
    views: [{
      type: "image",
      props: {
        symbol: failed ? "trash" : "xmark.circle",
        tintColor: failed ? C.red : C.blue,
        contentMode: 1,
        userInteractionEnabled: false,
      },
      layout: (make, view) => {
        make.center.equalTo(view.super);
        make.size.equalTo($size(22, 22));
      },
    }],
    events: {
      tapped: async () => {
        try {
          return failed ? removeFailedTask(task.id) : await common.confirmCancelDownload(task.id);
        } catch (err) {
          common.alertError(err);
        }
      },
    },
  };
}

// 下载中/失败的任务行：图标先用 App Store 缩略图，进度百分比显示在右侧。
function taskRow(task, plan, failed) {
  const iconURL = String((task.app && task.app.artworkUrl) || "");
  const icon = iconURL
    ? {
        type: "image",
        props: {
          src: iconURL,
          cornerRadius: 12,
          smoothCorners: true,
        },
        layout: iconLayout,
      }
    : placeholderIcon("arrow.down.circle");
  const title = taskTitle(task);
  const subtitle = taskSubtitle(task);
  const control = taskControl(task);
  const value = valueLabel(percentText(task));
  if (!failed && control && control.type === "button") {
    value.props.font = $font("bold", 12);
    value.props.align = $align.center;
    value.layout = (make, view) => {
      make.right.inset(10);
      make.centerY.equalTo(view.super).offset(24);
      make.width.equalTo(44);
    };
  }
  const views = [
    icon,
    value,
    titleLabel(title, plan.title),
    subtitleLabel(
      subtitle,
      plan.subtitle,
      plan.title.height,
      failed ? C.red : C.sub
    ),
    accountLabel(task, plan),
  ];
  if (!failed) views.push(progressBar(task));
  return cardRow(
    views,
    failed ? () => retryTask(task) : null,
    failed ? "下载失败，点按重试" : "",
    control
  );
}

// 顶部“从文件导入”卡片：整行点击进入系统文件选择器。
function importRow() {
  const title = titleLabel("导入 IPA 文件", { lines: 1, height: 20 });
  const subtitle = subtitleLabel("从“文件”导入 IPA", { lines: 1, height: 16 }, 20);
  // 导入卡片右侧没有文件大小，完整宽度留给单行说明。
  for (const [label, offset, height] of [[title, -11, 20], [subtitle, 12, 16]]) {
    label.layout = (make, view) => {
      make.left.equalTo(TEXT_LEFT);
      make.right.inset(16);
      make.centerY.equalTo(view.super).offset(offset);
      make.height.equalTo(height);
    };
  }
  return cardRow(
    [
      placeholderIcon("square.and.arrow.down"),
      title,
      subtitle,
    ],
    importFromFiles,
    "导入 IPA 文件"
  );
}

function archiveRow(count) {
  return cardRow([
    {
      type: "image",
      props: { symbol: "archivebox", tintColor: C.sub, contentMode: 1 },
      layout: (make, view) => {
        make.left.inset(20);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(24, 24));
      },
    },
    {
      type: "label",
      props: { text: "归档", font: $font("bold", 15), textColor: C.label, lines: 1 },
      layout: (make, view) => {
        make.left.equalTo(56);
        make.right.inset(112);
        make.centerY.equalTo(view.super);
      },
    },
    {
      type: "label",
      props: { text: `${count} 个 IPA`, font: $font(13), textColor: C.sub, align: $align.right, lines: 1 },
      layout: (make, view) => {
        make.right.inset(34);
        make.centerY.equalTo(view.super);
        make.width.lessThanOrEqualTo(90);
      },
    },
    {
      type: "image",
      props: { symbol: "chevron.right", tintColor: C.sub, contentMode: 1 },
      layout: (make, view) => {
        make.right.inset(14);
        make.centerY.equalTo(view.super);
        make.size.equalTo($size(12, 12));
      },
    },
  ], showArchive, `归档，${count} 个 IPA`);
}

function emptyRow(text) {
  return cardRow([{
    type: "label",
    props: { text, font: $font(14), textColor: C.sub, align: $align.center, lines: 1 },
    layout: (make, view) => {
      make.left.right.inset(16);
      make.centerY.equalTo(view.super);
    },
  }]);
}

// 与当前渲染快照对齐的行高表；rowHeight 用 indexPath 映射回每行的排版。
let sectionHeights = [];

// 任务行当前是否需要重建（任务增删、状态或换行数变化时才需要）。
function taskStructureKey(task) {
  const plan = rowPlan(taskTitle(task), taskSubtitle(task), task.status !== "error", accountSubtitle(task));
  return `${task.id}|${task.status}|${task.cancellable !== false}|${plan.title.lines}|${plan.subtitle.lines}|${plan.account.lines}`;
}

function sections() {
  tasksSnapshot = queue.snapshot();
  taskRowDefs = [];
  taskRowPaths = [];
  sectionHeights = [[ROW_MIN_HEIGHT, ARCHIVE_ROW_HEIGHT]];
  const allFiles = library.listFiles();
  const files = allFiles.filter(item => item.sinfInjected === true);
  const result = [{ title: "", rows: [importRow(), archiveRow(allFiles.length - files.length)] }];
  const taskPlans = tasksSnapshot.map(task => {
    const failed = task.status === "error";
    const plan = rowPlan(taskTitle(task), taskSubtitle(task), !failed, accountSubtitle(task));
    taskRowDefs.push(taskRow(task, plan, failed));
    return plan;
  });
  for (const failed of [false, true]) {
    const indices = tasksSnapshot.map((_task, index) => index)
      .filter(index => (tasksSnapshot[index].status === "error") === failed);
    if (!indices.length) continue;
    indices.forEach((index, row) => { taskRowPaths[index] = { section: result.length, row }; });
    result.push({
      title: `${failed ? "下载失败" : "正在下载"} ${indices.length} 个 App`,
      rows: indices.map(index => taskRowDefs[index]),
    });
    sectionHeights.push(indices.map(index => taskPlans[index].height));
  }
  if (files.length) {
    const plans = files.map((item) =>
      rowPlan(fileTitle(item), fileSubtitle(item), false, accountSubtitle(item))
    );
    sectionHeights.push(plans.map((plan) => plan.height));
    result.push({
      title: `已下载 ${files.length} 个 IPA`,
      rows: plans.map((plan, index) => fileRow(files[index], plan)),
    });
  } else {
    sectionHeights.push([EMPTY_ROW_HEIGHT]);
    result.push({ title: "已下载", rows: [emptyRow("暂无下载")] });
  }
  return result;
}

// 在 taskRowDefs 与已出现的 cell 中查找某个 id 的视图。
function findViewByDefinitionId(root, id) {
  if (!root || typeof root !== "object") return null;
  if (root.props && root.props.id === id) return root;
  const children = root.views || [];
  for (const child of children) {
    const hit = findViewByDefinitionId(child, id);
    if (hit) return hit;
  }
  return null;
}

// 把任务行的进度文本、状态消息与进度条原位更新：
// 先更新行定义（离屏 cell 出现时用新内容），再更新已可见的 cell。
function refreshTaskRowsInPlace(nextTasks) {
  const list = $("download-list");
  const canUseCells =
    list && typeof list.cell === "function" && typeof $indexPath === "function";
  nextTasks.forEach((task, index) => {
    const failed = task.status === "error";
    const definition = taskRowDefs[index];
    if (definition) {
      const titleDef = findViewByDefinitionId(definition, "dl-title");
      const subtitleDef = findViewByDefinitionId(definition, "dl-subtitle");
      const accountDef = findViewByDefinitionId(definition, "dl-account");
      const valueDef = findViewByDefinitionId(definition, "dl-value");
      const progressDef = findViewByDefinitionId(definition, "dl-progress");
      if (titleDef) titleDef.props.text = taskTitle(task);
      if (subtitleDef) subtitleDef.props.text = taskSubtitle(task);
      if (accountDef) {
        accountDef.props.text = accountSubtitle(task);
        accountDef.props.accessibilityLabel = accountDef.props.text;
      }
      if (valueDef) valueDef.props.text = percentText(task);
      if (progressDef) {
        progressDef.props.value = Math.max(
          0,
          Math.min(1, Number(task.progress) || 0)
        );
        progressDef.props.hidden = failed;
      }
    }
    if (!canUseCells) return;
    const path = taskRowPaths[index];
    const cell = path && list.cell($indexPath(path.section, path.row));
    if (!cell || typeof cell.get !== "function") return;
    const setText = (id, text) => {
      const view = cell.get(id);
      if (view) view.text = text;
    };
    setText("dl-title", taskTitle(task));
    setText("dl-subtitle", taskSubtitle(task));
    setText("dl-account", accountSubtitle(task));
    const accountView = cell.get("dl-account");
    if (accountView) accountView.accessibilityLabel = accountSubtitle(task);
    setText("dl-value", percentText(task));
    if (!failed) {
      const progress = cell.get("dl-progress");
      if (progress) {
        progress.value = Math.max(0, Math.min(1, Number(task.progress) || 0));
        progress.hidden = false;
      }
    }
  });
}

function replaceList(list, definition, resetOffset) {
  const container = list ? list.super : null;
  common.preserveListOffset(resetOffset ? { contentOffset: { x: 0, y: 0 } } : list, definition);
  if (
    container &&
    typeof list.remove === "function" &&
    typeof container.add === "function"
  ) {
    list.remove();
    container.add(definition);
    return;
  }
  if (list) {
    list.data = definition.props.data;
    if (typeof list.reload === "function") list.reload();
    if (resetOffset) list.contentOffset = definition.props.contentOffset;
  }
}

function update() {
  common.refreshDownloadButtons();
  // 静态 cell 的结构变化需要重新挂载；纯进度变化仍原位刷新。
  const list = $("download-list");
  if (list) replaceList(list, listDefinition(sections()));
  for (const refresh of archiveRefreshers) refresh();
}

function rowHeight(sender, indexPath) {
  const section = Number(indexPath && indexPath.section) || 0;
  const rowIndex = Number(indexPath && indexPath.row) || 0;
  return (sectionHeights[section] && sectionHeights[section][rowIndex]) || ROW_MIN_HEIGHT;
}

function listDefinition(data) {
  return {
    type: "list",
    props: common.floatingTabListProps({
      id: "download-list",
      style: 0,
      separatorHidden: true,
      data,
      rowHeight: ROW_MIN_HEIGHT,
      sectionTitleHeight: 28,
    }),
    layout: $layout.fill,
    events: {
      rowHeight,
      sectionTitleHeight: (_sender, section) => section === 0 ? 4 : 28,
    },
  };
}

function showArchive() {
  const id = `download-archive-${++archiveSequence}`;
  let alive = true;
  let heights = [];

  function definition() {
    const files = library.listFiles().filter(item => item.sinfInjected !== true);
    const plans = files.map(item => rowPlan(fileTitle(item), fileSubtitle(item), false, accountSubtitle(item)));
    heights = plans.map(plan => plan.height);
    return {
      type: "list",
      props: common.listBaseProps({
        id, style: 0, separatorHidden: true, rowHeight: ROW_MIN_HEIGHT,
        contentInset: $insets(0, 0, 24, 0),
        data: [{
          title: files.length ? `${files.length} 个 IPA` : "",
          rows: files.length ? plans.map((plan, index) => fileRow(files[index], plan)) : [emptyRow("暂无归档 IPA")],
        }],
      }),
      layout: $layout.fill,
      events: {
        rowHeight: (_sender, path) => heights[path.row] || EMPTY_ROW_HEIGHT,
        sectionTitleHeight: () => heights.length ? 28 : 4,
      },
    };
  }

  const page = {
    props: common.pageProps({ title: "归档" }),
    views: [definition()],
    events: {
      appeared: refresh,
      dealloc: () => { alive = false; archiveRefreshers.delete(refresh); },
    },
  };
  function refresh() {
    if (!alive) return;
    const next = definition();
    const list = $(id);
    if (list) {
      replaceList(list, next, !heights.length);
      page.views[0] = next;
    } else {
      // 原生视图尚未创建或页面被覆盖时，保留待显示的数据定义。
      page.views[0].props.data = next.props.data;
    }
  }
  archiveRefreshers.add(refresh);
  $ui.push(common.page(page));
}

function views() {
  return [listDefinition(sections())];
}

function mount() {
  if (!subscribed) {
    queue.subscribe(scheduleRefresh);
    subscribed = true;
  }
  update();
}

// 下载进度高频回调：结构未变时原位刷新任务行，只有增删/状态/换行变化
// 才重建列表，避免下载期间整表跳动。
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const nextTasks = queue.snapshot();
    const sameStructure =
      nextTasks.length === tasksSnapshot.length &&
      nextTasks.every(
        (task, index) =>
          taskStructureKey(task) === taskStructureKey(tasksSnapshot[index])
      );
    if (!sameStructure) {
      tasksSnapshot = nextTasks;
      update();
      return;
    }
    refreshTaskRowsInPlace(nextTasks);
    tasksSnapshot = nextTasks;
  }, 300);
}

async function retryTask(task) {
  if (!task || !task.app) return;
  task = queue.snapshot().find(current => current.id === task.id);
  if (!task || task.status !== "error") return false;
  const requested = task.externalVersionId ? { externalVersionId: task.externalVersionId } : undefined;
  if (common.openDownloaded(task.app, requested)) {
    queue.remove(task.id);
    return true;
  }
  const done = await common.runWithLoading("", async () => {
    try {
      return await require("../services/downloader").retryDownload(task);
    } catch (err) {
      require("./detail").reportDownloadError(err, task.app);
      return null;
    }
  }, { showIndicator: false, toast: false });
  if (!done) return false;
  common.refreshDownloadButtons();
  installer.downloadComplete(done.record, done);
  return true;
}

// 从系统“文件”选择器导入 IPA：整包 $data 直接落库。
async function importFromFiles() {
  if (typeof $drive === "undefined" || !$drive || typeof $drive.open !== "function") {
    common.alert({
      title: "无法打开文件选择器",
      message: "需要 JSBox 的 $drive.open 能力；请在支持“文件”选择的 JSBox 版本中重试。",
      actions: [{ title: "好" }],
    });
    return;
  }
  let picked = null;
  try {
    picked = await $drive.open({ multi: false });
  } catch (_e) {
    // 用户取消选择器时部分 JSBox 版本会抛错；静默返回，不弹“出错”。
    return;
  }
  const originalName = String((picked && picked.fileName) || "");
  if (!originalName) return;
  if (!/\.ipa$/i.test(originalName)) {
    common.alert({
      title: "不是 IPA 文件",
      message: `请选择以 .ipa 结尾的 App 安装包。当前选择：${originalName}`,
      actions: [{ title: "好" }],
    });
    return;
  }
  try {
    const stem = originalName.replace(/\.ipa$/i, "");
    library.save(picked, { name: stem });
    common.toast("已导入归档");
    update();
  } catch (err) {
    common.alertError(err);
  }
}

// ---------- 文件操作 ----------

// 旧版下载没有做“下载时注入”，但 sidecar 里保留了 SINF/iTunesMetadata，
// 可以补一次注入生成修复后的 IPA。导入/恢复/未校验的记录不能修复。
function canRepairLicense(item) {
  return (
    !!item &&
    !item.recovered &&
    !item.sinfInjected &&
    !!item.packageVerified &&
    Array.isArray(item.sinfs) &&
    item.sinfs.length > 0 &&
    ipaInjector.canRezip()
  );
}

// 生成一份「已注入SINF」的新 IPA 并刷新列表；原文件保留，方便对照。
function repairLicense(item) {
  common.runWithLoading("正在把授权写回 IPA 并重新打包…", async () => {
    const result = await ipaInjector.injectAndSave(item);
    if (result && result.record) {
      // 修复生成的是新文件，把原记录旁边的图标 sidecar 一并复制过去，
      // 列表里不会变成默认占位图标。
      try {
        if (item.iconPath) {
          const icon = library.iconData(item.fileName);
          if (icon) library.saveIcon(result.record.fileName, icon);
        }
      } catch (_e) {}
      common.toast("已生成修复后的 IPA");
      update();
    }
    return result;
  });
}

function fileActions(fileName) {
  const item = library.listFiles().find((f) => f.fileName === fileName);
  if (!item) return false;
  const actions = ["OTA 安装"];
  if (canRepairLicense(item)) actions.push("修复授权（重新注入 SINF）");
  actions.push("分享 IPA", "删除");
  common.menu({
    items: actions,
    handler: (title, idx) => {
      const chosen = actions[idx];
      if (chosen === "OTA 安装") installer.prompt(item);
      else if (chosen === "修复授权（重新注入 SINF）") repairLicense(item);
      else if (chosen === "分享 IPA") installer.share(item);
      else if (chosen === "删除") confirmRemove(fileName);
    },
  });
  return true;
}

function confirmRemove(fileName) {
  common.alert({
    title: "删除这个 IPA？",
    message: `${fileName}\n\n此操作会同时删除本地元数据与图标，且无法撤销。`,
    actions: [
      {
        title: "删除",
        style:
          typeof $alertActionType !== "undefined"
            ? $alertActionType.destructive
            : undefined,
        handler: () => removeFile(fileName),
      },
      { title: "取消" },
    ],
  });
}

function removeFile(fileName) {
  try {
    library.remove(fileName);
    common.toast("已删除");
    update();
  } catch (err) {
    common.alertError(err);
  }
}

module.exports = {
  views,
  mount,
  fileActions,
};
