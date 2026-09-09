// App 详情：App Store 产品页风格（图标/名称/评分 + “获取”胶囊按钮 + 分组信息）。

const config = require("../config");
const common = require("./common");
const storeApi = require("../apple/store");
const downloader = require("../services/downloader");
const accountsStore = require("../store/accounts");
const settings = require("../store/settings");
const installer = require("./install");
const format = require("../lib/format");
const { errorMessage } = require("../lib/error");
const { createCancellation, isCancelled } = require("../lib/cancellation");

const C = common.colors;
const PRODUCT_BG = $color("systemBackground");
let pageSequence = 0;
let preparationSequence = 0;

function show(soft, region) {
  common.loading(true);
  storeApi
    .lookupByIds([soft.id], region)
    .then((found) => {
      const resolved = (Array.isArray(found) && found.find(item => String(item.id) === String(soft.id) && (!soft.bundleID || item.bundleID === soft.bundleID))) || soft;
      // 已购列表先来自 Purchase DAAP，再用公开 lookup 补图标/价格；
      // lookup 不包含账号购买权限，必须把 owned 标记带回详情页。
      buildScreen(Object.assign({}, resolved, { owned: !!soft.owned }), region);
    })
    .catch(() => {
      buildScreen(soft, region);
    })
    .finally(() => {
      common.loading(false);
    });
}

// ---------- 产品头部 ----------
function headerView(app, region) {
  const iconSrc = (app.artworkUrl100 || app.artworkUrl || app.icon || "").replace(
    "100x100",
    "512x512"
  );
  const buttonText = common.getButtonText(app);
  const getButton = common.actionPill(
    () => common.getButtonText(app),
    (onProgress, onTask) => downloadLatestFlow(app, region, { onProgress, onTask }),
    80,
    { app, region, prominent: true }
  );
  getButton.props.accessibilityLabel = `${buttonText} ${app.name}`;
  getButton.props.accessibilityHint = buttonText === "打开"
    ? "打开下载文件操作"
    : "查询已有许可并下载 IPA";
  // 保留同一个控件实例；正文页面返回时只刷新任务状态。
  const actionButton = (getButton.views || []).find((view) => view.type === "button");
  if (actionButton) {
    actionButton.props.accessibilityLabel = getButton.props.accessibilityLabel;
    actionButton.props.accessibilityHint = getButton.props.accessibilityHint;
  }
  getButton.layout = (make) => {
    make.left.equalTo(140);
    make.top.equalTo(108);
    make.size.equalTo($size(80, 44));
  };

  return {
    type: "view",
    props: { height: 176, bgcolor: PRODUCT_BG },
    views: [
      {
        type: "image",
        props: {
          src: iconSrc,
          cornerRadius: 24,
          smoothCorners: true,
          clipsToBounds: true,
          borderWidth: 0.5,
          borderColor: C.sep,
          accessibilityLabel: `${app.name} 图标`,
        },
        layout: (make, view) => {
          make.left.inset(20);
          make.top.equalTo(20);
          make.size.equalTo($size(104, 104));
        },
      },
      {
        type: "label",
        props: {
          id: "detail-name",
          text: app.name,
          font: $font("bold", 22),
          textColor: C.label,
          lines: 2,
          accessibilityLabel: app.name,
        },
        layout: (make, view) => {
          make.left.equalTo(140);
          make.right.inset(20);
          make.top.equalTo(20);
          make.height.lessThanOrEqualTo(56);
        },
      },
      {
        type: "label",
        props: {
          text: app.artistName || app.sellerName || "",
          font: $font(13),
          textColor: C.sub,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.equalTo(140);
          make.right.inset(20);
          make.top.equalTo(view.prev.bottom).offset(4);
          make.height.equalTo(18);
        },
      },
      {
        type: "button",
        props: {
          bgcolor: $color("clear"),
          accessibilityLabel: "打开 App Store 页面",
        },
        layout: (make) => {
          make.right.inset(16);
          make.top.equalTo(108);
          make.size.equalTo($size(44, 44));
        },
        views: [{
          type: "image",
          props: { symbol: "arrow.up.right.square", tintColor: C.blue, userInteractionEnabled: false },
          layout: (make, view) => { make.center.equalTo(view.super); make.size.equalTo($size(22, 22)); },
        }],
        events: { tapped: () => handle("appstore", app, region) },
      },
      getButton,
    ],
  };
}

function formatCount(n) {
  if (n >= 10000) {
    const v = n / 10000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}万`;
  }
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------- 正文 ----------

function buildScreen(app, region) {
  const listId = `detail-list-${++pageSequence}`;
  const header = headerView(app, region);
  const metadata = productMetadata(app);
  const screenshots = screenshotURLs(app);
  const overview = overviewRow(metadata);
  const rows = [];
  if (overview) rows.push({ row: overview, height: 94 });
  if (screenshots.length) {
    rows.push(sectionHeading("预览"), screenshotStrip(screenshots));
  }
  const version = [metadata.version ? `版本 ${metadata.version}` : "", metadata.releaseDate].filter(Boolean).join(" · ");
  rows.push(sectionHeading(version || app.releaseNotes ? "新内容" : "", {
    title: "版本历史", accessibilityLabel: "历史版本", tapped: () => handle("versions", app, region),
  }));
  if (version) {
    const label = bodyLabel(version, 1, C.sub, 13);
    label.layout = make => { make.left.right.inset(20); make.top.inset(0); make.bottom.inset(8); };
    rows.push(detailRow([label], 28));
  }
  if (app.releaseNotes) rows.push(textPreview(String(app.releaseNotes), 3, "新内容", "查看完整更新内容"));
  if (app.description) {
    rows.push(sectionHeading("简介"), textPreview(String(app.description), 4, "简介", "查看完整简介"));
  }
  const infoRows = [
    infoRow("提供者", app.sellerName || app.artistName || ""),
    infoRow("大小", metadata.size),
    infoRow("分类", metadata.genres.join(" / ")),
    infoRow("兼容性", app.minimumOsVersion ? `iOS ${app.minimumOsVersion}+` : ""),
    infoRow("语言", metadata.languages.join("、")),
    infoRow("年龄分级", metadata.age),
    infoRow("版权", metadata.copyright),
  ].filter(Boolean);
  if (infoRows.length) {
    infoRows.slice(0, -1).forEach(item => item.row.views.push(separator()));
    rows.push(sectionHeading("信息"), ...infoRows);
  }
  let layoutWidth = 0;

  $ui.push(common.page({
    props: productPageProps(app.name),
    events: {
      // 原生头部可能仍保留原按钮；出现时只刷新状态，保留点击锁和下载进度。
      appeared: common.refreshDownloadButtons,
      dealloc: () => common.releaseDownloadButtons(header),
    },
    views: [
      {
        type: "list",
        props: common.listBaseProps({
          id: listId,
          style: 0,
          bgcolor: PRODUCT_BG,
          separatorHidden: true,
          header,
          // 单一无标题 section；自绘标题不再与系统标题重复。
          data: [{ title: "", rows: rows.map(item => item.row) }],
          rowHeight: 44,
          sectionTitleHeight: 0,
          footer: { type: "view", props: { height: 24, bgcolor: PRODUCT_BG } },
        }),
        layout: $layout.fill,
        events: {
          sectionTitleHeight: () => 0,
          rowHeight: (sender, indexPath) => {
            const item = rows[indexPath.row];
            if (!item) return 44;
            return typeof item.height === "function" ? item.height(detailWidth(sender)) : item.height;
          },
          layoutSubviews: sender => {
            const width = Number(sender.frame && sender.frame.width);
            if (!(width > 0) || width === layoutWidth) return;
            layoutWidth = width;
            // iPad 分屏/旋转按列表实际宽度重新测量文字，保留 header 与获取控件。
            if (typeof sender.reload === "function") sender.reload();
          },
        },
      },
    ],
  }));
}

function productPageProps(title) {
  return common.pageProps({ title, bgcolor: PRODUCT_BG, barColor: PRODUCT_BG });
}

// 静态 cell 的高度由 list.rowHeight 明确给出。普通子视图始终约束在 cell
// 内，避免 stack 自动高度不足时出现“内容可见，但父容器收不到点击”。
function detailRow(views, height) {
  return {
    row: {
      type: "view",
      props: { bgcolor: PRODUCT_BG, selectable: false, clipsToBounds: true },
      layout: $layout.fill,
      views,
    },
    height,
  };
}

function detailWidth(sender) {
  const width = Number(sender && sender.frame && sender.frame.width);
  if (width > 0) return width;
  if (typeof $device !== "undefined" && $device.info && $device.info.screen) {
    const screen = Number($device.info.screen.width);
    if (screen > 0) return screen;
  }
  return 375;
}

function textHeight(text, fontSize, width, maxLines) {
  const availableWidth = Math.max(1, width);
  const lineHeight = Math.ceil(fontSize * 1.4);
  let height;
  try {
    if (typeof $text !== "undefined" && typeof $text.sizeThatFits === "function") {
      const size = $text.sizeThatFits({ text, width: availableWidth, font: $font(fontSize) });
      height = Number(size && size.height);
    }
  } catch (_err) {}
  if (!(height > 0)) {
    height = String(text).split("\n").reduce((total, line) =>
      total + Math.max(1, Math.ceil(Array.from(line).length * fontSize / availableWidth)), 0) * lineHeight;
  }
  return Math.ceil(maxLines ? Math.min(height, lineHeight * maxLines) : height) + 2;
}

function separator() {
  return {
    type: "view", props: { bgcolor: C.sep, userInteractionEnabled: false },
    layout: make => { make.left.right.inset(20); make.bottom.inset(0); make.height.equalTo(0.5); },
  };
}

function sectionHeading(title, action) {
  const views = title ? [{
    type: "label", props: { text: title, font: $font("bold", 22), textColor: C.label, lines: 1 },
    layout: make => {
      make.left.inset(20);
      make.right.inset(action ? 124 : 20);
      make.top.inset(12);
      make.height.equalTo(44);
    },
  }] : [];
  if (action) views.push({
    type: "button",
    props: { title: action.title, font: $font(14), titleColor: C.blue, bgcolor: $color("clear"), accessibilityLabel: action.accessibilityLabel },
    layout: make => { make.right.inset(20); make.top.inset(12); make.size.equalTo($size(96, 44)); },
    events: { tapped: action.tapped },
  });
  return detailRow(views, 64);
}

function infoRow(title, value) {
  if (!value) return null;
  return detailRow([
    {
      type: "label",
      props: { text: title, font: $font(14), textColor: C.sub, lines: 1 },
      layout: make => {
        make.left.inset(20);
        make.top.inset(14);
        make.width.equalTo(88);
        make.height.equalTo(20);
      },
    },
    {
      type: "label",
      props: { text: value, font: $font(14), textColor: C.label, align: $align.right, lines: 0 },
      layout: make => {
        make.left.equalTo(124);
        make.right.inset(20);
        make.top.bottom.inset(14);
      },
    },
  ], width => Math.max(48, textHeight(value, 14, width - 144) + 28));
}

function productMetadata(app) {
  const raw = app.raw || {};
  const rating = Number(app.averageUserRating);
  const count = Number(app.userRatingCount);
  const bytes = Number(app.fileSizeBytes);
  const age = String(app.contentAdvisoryRating || app.trackContentRating || raw.contentAdvisoryRating || raw.trackContentRating || "").trim();
  const genres = Array.isArray(app.genres) ? app.genres.filter(value => typeof value === "string" && value.trim()) : [];
  if (!genres.length && app.primaryGenreName) genres.push(String(app.primaryGenreName));
  const languages = app.languageCodesISO2A || raw.languageCodesISO2A;
  const date = app.releaseDate ? new Date(app.releaseDate) : null;
  return {
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? rating : 0,
    count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    size: Number.isFinite(bytes) && bytes > 0 ? format.formatBytes(bytes) : "",
    age: /^\d{1,2}\+$/.test(age) ? age : "",
    genres,
    category: String(app.primaryGenreName || genres[0] || ""),
    languages: Array.isArray(languages) ? Array.from(new Set(languages.filter(value => typeof value === "string" && /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(value)))) : [],
    version: String(app.version || "").trim(),
    releaseDate: date && Number.isFinite(date.getTime()) ? format.formatDate(date) : "",
    copyright: String(app.copyright || raw.copyright || "").trim(),
  };
}

function overviewRow(metadata) {
  const fields = [];
  if (metadata.rating) fields.push({ label: "评分", value: metadata.rating.toFixed(1), caption: metadata.count ? `${formatCount(metadata.count)} 个评分` : "" });
  if (metadata.age) fields.push({ label: "年龄", value: metadata.age, caption: "岁以上" });
  if (metadata.category) fields.push({ label: "类别", value: metadata.category, caption: "", compact: true });
  if (metadata.languages.length) fields.push({ label: "语言", value: metadata.languages[0], caption: metadata.languages.length > 1 ? `及其他 ${metadata.languages.length - 1} 种` : "" });
  if (metadata.size) {
    const [value, caption] = metadata.size.split(" ");
    fields.push({ label: "大小", value, caption });
  }
  if (!fields.length) return null;
  const width = 100;
  return {
    type: "view",
    props: { id: "detail-overview", bgcolor: PRODUCT_BG, selectable: false },
    layout: $layout.fill,
    views: [{
      type: "scroll",
      props: {
        bgcolor: PRODUCT_BG, contentSize: $size(40 + fields.length * width, 90),
        showsHorizontalIndicator: false, showsVerticalIndicator: false, alwaysBounceVertical: false,
      },
      layout: $layout.fill,
      views: fields.map((field, index) => ({
        type: "view",
        props: { bgcolor: $color("clear"), isAccessibilityElement: true, accessibilityLabel: [field.label, field.value, field.caption].filter(Boolean).join("，") },
        layout: make => { make.left.equalTo(20 + index * width); make.top.equalTo(0); make.size.equalTo($size(width, 90)); },
        views: [
          {
            type: "label", props: { text: field.label, font: $font(11), textColor: C.sub, align: $align.center, lines: 1 },
            layout: make => { make.left.right.inset(6); make.top.equalTo(8); make.height.equalTo(16); },
          },
          {
            type: "label", props: { text: field.value, font: $font("bold", field.compact || field.value.length > 5 ? 14 : 24), textColor: C.sub, align: $align.center, lines: field.compact ? 2 : 1 },
            layout: make => { make.left.right.inset(6); make.top.equalTo(26); make.height.equalTo(36); },
          },
          {
            type: "label", props: { text: field.caption || "", font: $font(10), textColor: C.sub, align: $align.center, lines: 1 },
            layout: make => { make.left.right.inset(4); make.top.equalTo(65); make.height.equalTo(15); },
          },
          ...(index === fields.length - 1 ? [] : [{
            type: "view", props: { bgcolor: C.sep },
            layout: make => { make.right.inset(0); make.top.equalTo(24); make.width.equalTo(0.5); make.height.equalTo(38); },
          }]),
        ],
      })),
    }],
  };
}

function screenshotURLs(app) {
  for (const candidates of [app.screenshotUrls, app.ipadScreenshotUrls, app.raw && app.raw.ipadScreenshotUrls]) {
    if (!Array.isArray(candidates)) continue;
    const urls = Array.from(new Set(candidates.filter(value => typeof value === "string" && /^https:\/\/[^\s]+$/i.test(value))));
    if (urls.length) return urls.slice(0, 10);
  }
  return [];
}

function screenshotStrip(urls) {
  const width = 176, height = 334, spacing = 12;
  return detailRow([{
    type: "scroll",
    props: {
      id: "detail-screenshots",
      bgcolor: PRODUCT_BG,
      contentSize: $size(40 + urls.length * (width + spacing) - spacing, height),
      alwaysBounceVertical: false, alwaysBounceHorizontal: urls.length > 1,
      showsHorizontalIndicator: false, showsVerticalIndicator: false,
    },
    layout: make => { make.left.right.inset(0); make.top.inset(0); make.height.equalTo(height); },
    views: urls.map((url, index) => ({
      type: "button",
      props: {
        bgcolor: C.field, cornerRadius: 18, smoothCorners: true, clipsToBounds: true,
        accessibilityLabel: `App 预览 ${index + 1}`,
      },
      layout: make => {
        make.left.equalTo(20 + index * (width + spacing));
        make.top.equalTo(0);
        make.size.equalTo($size(width, height));
      },
      views: [{ type: "image", props: { src: url, contentMode: 1, userInteractionEnabled: false }, layout: $layout.fill }],
      events: { tapped: () => showScreenshots(urls, index) },
    })),
  }], height + 12);
}

function showScreenshots(urls, index) {
  $ui.push(common.page({
    props: productPageProps("预览"),
    views: [{
      type: "gallery",
      props: {
        page: Math.max(0, Math.min(urls.length - 1, index)), interval: 0,
        items: urls.map(url => ({
          type: "scroll", props: { bgcolor: PRODUCT_BG, zoomEnabled: true, maxZoomScale: 3 },
          views: [{ type: "image", props: { src: url, contentMode: 1 }, layout: $layout.fill }],
        })),
      },
      layout: $layout.fill,
    }],
  }));
}

function bodyLabel(text, lines, color, size) {
  return { type: "label", props: { text, lines, textColor: color || C.label, font: $font(size || 15) } };
}

function textPreview(text, lines, title, accessibilityLabel) {
  const label = bodyLabel(text, lines);
  label.layout = make => { make.left.right.inset(20); make.top.inset(0); make.bottom.inset(56); };
  return detailRow([
    label,
    {
      type: "button", props: { title: "更多", font: $font(15), titleColor: C.blue, bgcolor: $color("clear"), accessibilityLabel },
      layout: make => { make.right.inset(20); make.bottom.inset(12); make.width.equalTo(56); make.height.equalTo(44); },
      events: {
        tapped: () => $ui.push(common.page({
          props: productPageProps(title),
          views: [{
            type: "text",
            props: { text, font: $font(16), textColor: C.label, bgcolor: PRODUCT_BG, editable: false, selectable: true, insets: $insets(20, 20, 32, 20) },
            layout: $layout.fill,
          }],
        })),
      },
    },
  ], width => textHeight(text, 15, width - 40, lines) + 56);
}

async function handle(key, app, region, indexPath, sender) {
  switch (key) {
    case "versions":
      await versionsFlow(app, region);
      break;
    case "appstore":
      if (appStoreURL(app)) $app.openURL(appStoreURL(app));
      break;
    case "desc":
      break;
    default:
      break;
  }
}

// 获取该浏览区域可用的账号；不符合同区时给出引导。
function accountFor(app, region) {
  let account;
  try {
    account = accountsStore.requireAccountForRegion(region);
  } catch (err) {
    common.alert({
      title: "需要 Apple ID",
      message: `下载需要登录一个 ${common.regionText(region)} 账号。`,
      actions: [
        {
          title: "去添加账号",
          handler: () => require("./accounts").render(),
        },
        { title: "取消", style: $alertActionType.destructive },
      ],
    });
    return null;
  }
  const accountRegion =
    typeof accountsStore.accountRegion === "function"
      ? accountsStore.accountRegion(account)
      : String(account.store || "").toUpperCase();
  if (accountRegion !== String(region).toUpperCase()) {
    common.alert({
      title: "区域不匹配",
      message: `当前默认账号属于 ${common.regionText(accountRegion || account.store)}。请为该区域添加或切换账号后下载。`,
      actions: [
        {
          title: "去管理账号",
          handler: () => require("./accounts").render(),
        },
        { title: "取消", style: $alertActionType.destructive },
      ],
    });
    return null;
  }
  return account;
}

function appStoreURL(app) {
  const id = String(app && app.id || "");
  if (/^\d+$/.test(id)) return `https://apps.apple.com/app/id${id}`;
  const value = String(app && app.trackViewUrl || "");
  return /^https:\/\/apps\.apple\.com\//i.test(value) ? value : "";
}

function reportDownloadError(error, app) {
  if (isCancelled(error)) return;
  if (!error || !error.needsAppStore) {
    common.alertError(error);
    return;
  }
  const url = appStoreURL(app);
  common.alert({
    title: "需要先在 App Store 完成",
    message: error.message,
    actions: [
      ...(url ? [{ title: "打开 App Store", handler: () => $app.openURL(url) }] : []),
      { title: "取消" },
    ],
  });
}

async function downloadResult(pending, app) {
  try {
    return await pending;
  } catch (err) {
    reportDownloadError(err, app);
    return null;
  }
}

// 等待公开版本查询或历史枚举收尾时也能取消。已弹出的确认跟随同一次
// 下载交接到服务任务，完成后失效，避免误取消下一次点击产生的新任务。
function prepareDownload(app, onTask) {
  const cancellation = createCancellation();
  const id = `download-preparation-${++preparationSequence}`;
  let target = null;
  let finished = false;
  const publish = control => {
    if (typeof onTask === "function") onTask(control);
  };
  const control = {
    get id() { return target ? target.id : id; },
    name: app.name,
    canCancel: () => !finished && (target ? target.canCancel() : !cancellation.cancelled),
    cancel: () => control.canCancel() && (target ? target.cancel() : cancellation.cancel()),
    subscribe: listener => cancellation.subscribe(listener),
  };
  publish(control);
  return {
    get cancelled() { return cancellation.cancelled; },
    onTask: next => { target = next; publish(next); },
    finish: () => { finished = true; },
  };
}

async function downloadLatestFlow(app, region, options) {
  if (common.openDownloaded(app)) return true;
  // 公开 lookup 可能等待较久，只记录发起账号，不提前弹出登录引导。
  // 待确认需要下载时再校验，避免等待期间切换账号后替新账号发起下载。
  let requestedEmail = "";
  try {
    const selected = accountsStore.accountForRegion(region);
    requestedEmail = String(selected && selected.email || "").trim().toLowerCase();
  } catch (_err) {}
  const preparation = prepareDownload(app, options && options.onTask);
  try {
    if (preparation.cancelled) return false;
    // RSS 条目没有版本号；用公开 lookup 补齐后再决定是否需要下载。
    if (!app.version && !app.externalVersionId && app.id) {
      let found = [];
      try { found = await storeApi.lookupByIds([app.id], region); } catch (_e) {}
      if (preparation.cancelled) return false;
      const resolved = (found || []).find((item) => String(item.id) === String(app.id) && (!app.bundleID || item.bundleID === app.bundleID));
      if (resolved) Object.assign(app, resolved, { owned: app.owned === true });
      common.refreshDownloadButtons();
      if (common.openDownloaded(app)) return true;
    }
    const account = accountFor(app, region);
    if (!account) return;
    if (requestedEmail && requestedEmail !== String(account.email || "").trim().toLowerCase()) {
      common.toast("账号已切换，请重新获取");
      return false;
    }

    const hasInlineProgress = !!(options && typeof options.onProgress === "function");
    const pending = downloader.downloadLatest(account, app, {
      onProgress: options && options.onProgress,
      onTask: preparation.onTask,
      region,
    });
    common.toast("已添加到下载列表");
    const done = await common.runWithLoading(
      "准备下载…",
      () => downloadResult(pending, app),
      hasInlineProgress ? { showIndicator: false, toast: false } : undefined
    );
    if (!done) return false;

    common.refreshDownloadButtons();
    installer.downloadComplete(done.record, done);
    return true;
  } finally {
    preparation.finish();
  }
}

function versionsFlow(app, region) {
  const account = accountFor(app, region);
  if (!account) return;
  showVersionsPage(app, account, region);
}

function formatVersionLabel(item, latest) {
  const id = String(item && item.id || "");
  const displayVersion = String(item && item.displayVersion || "").trim();
  const buildVersion = String(item && item.buildVersion || "").trim();
  const readable = displayVersion ? `v${displayVersion}` : "版本号未知";
  const build = buildVersion ? ` · 构建 ${buildVersion}` : "";
  const marker = latest ? " · 最新" : "";
  return `${readable}${build}${marker} · ID ${id}`;
}

// 每个 ID 保留同一行和按钮；补全只改标签，避免打断滚动和下载进度。
function versionRowView(item, app, onDownload, pageId, region, accountEmail) {
  const titleText = () => {
    const readable = item.displayVersion ? `v${item.displayVersion}`
      : item.resolved ? "版本号未知" : `ID ${item.id}`;
    return `${readable}${item.latest ? " · 最新" : ""}`;
  };
  const subtitleText = () => [
    item.buildVersion ? `构建 ${item.buildVersion}` : "",
    item.resolved || item.displayVersion ? `ID ${item.id}` : "版本号待补全",
  ].filter(Boolean).join(" · ");
  const title = {
    type: "label",
    props: {
      id: `versions-title-${pageId}-${item.id}`,
      text: titleText(),
      font: $font("bold", 16),
      textColor: C.label,
      lines: 1,
    },
    layout: (make) => {
      make.left.inset(16);
      make.top.equalTo(13);
      make.right.inset(88);
      make.height.equalTo(26);
    },
    events: { ready: (sender) => { sender.text = titleText(); } },
  };
  const subtitle = {
    type: "label",
    props: {
      id: `versions-subtitle-${pageId}-${item.id}`,
      text: subtitleText(),
      font: $font(12),
      textColor: C.sub,
      lines: 1,
    },
    layout: (make) => {
      make.left.inset(16);
      make.top.equalTo(43);
      make.right.inset(88);
      make.height.equalTo(17);
    },
    events: { ready: (sender) => { sender.text = subtitleText(); } },
  };
  return {
    item,
    view: common.rowRootView([
      title,
      subtitle,
      common.actionPill(
        () => common.getButtonText(app, { externalVersionId: item.id, displayVersion: item.displayVersion }),
        (onProgress, onTask) => onDownload(item, onProgress, onTask),
        64,
        { app, region, accountEmail, version: { externalVersionId: item.id } }
      ),
    ], { staticCell: true, inset: 16 }),
    refresh: (replay) => {
      for (const [label, text] of [[title, titleText()], [subtitle, subtitleText()]]) {
        if (!replay && label.props.text === text) continue;
        label.props.text = text;
        const view = $ui.get(label.props.id);
        if (view) view.text = text;
      }
    },
  };
}

function showVersionsPage(app, account, region) {
  const pageId = ++pageSequence;
  const email = accountsStore.normalizeEmail(account.email);
  const code = String(region).toUpperCase();
  let alive = true;
  let entries = [];
  let rows = [];
  let renderedRows = rows;
  let enumeration = null;
  let loading = true;
  let complete = false;
  let failure = null;
  let activeDownloads = 0;
  let resumeAfterDownload = false;

  function currentAccount(allowDetached) {
    if (!alive && !allowDetached) return null;
    try {
      if (String(settings.region()).toUpperCase() !== code) return null;
      const current = accountsStore.accountForRegion(code);
      return current && accountsStore.normalizeEmail(current.email) === email &&
        accountsStore.accountRegion(current) === code ? current : null;
    } catch (_err) {
      return null;
    }
  }

  const status = {
    type: "label",
    props: { id: `versions-status-${pageId}`, text: app.name, font: $font(12), textColor: C.sub, lines: 1 },
    layout: (make, view) => {
      make.left.inset(20);
      make.right.inset(88);
      make.centerY.equalTo(view.super);
    },
    events: { ready: (sender) => { sender.text = status.props.text; } },
  };
  const progress = {
    type: "spinner",
    props: { id: `versions-progress-${pageId}`, loading: false, color: C.sub, style: 1 },
    layout: (make, view) => {
      make.right.inset(24);
      make.centerY.equalTo(view.super);
      make.size.equalTo($size(20, 20));
    },
    events: { ready: (sender) => { sender.loading = progress.props.loading; } },
  };
  const retry = {
    type: "button",
    props: { id: `versions-retry-${pageId}`, title: "重试", hidden: true, bgcolor: $color("clear"), titleColor: C.blue, font: $font(13) },
    layout: (make, view) => {
      make.right.inset(12);
      make.centerY.equalTo(view.super);
      make.size.equalTo($size(64, 44));
    },
    events: {
      tapped: () => load(),
      ready: (sender) => { sender.hidden = retry.props.hidden; sender.title = retry.props.title; },
    },
  };
  const spinner = {
    type: "spinner",
    props: { id: `versions-loading-${pageId}`, loading: true, color: C.blue, style: 0 },
    layout: (make, view) => {
      make.centerX.equalTo(view.super);
      make.centerY.equalTo(view.super).offset(-32);
      make.size.equalTo($size(36, 36));
    },
    events: { ready: (sender) => { sender.loading = spinner.props.loading; } },
  };
  const emptyText = {
    type: "label",
    props: { id: `versions-empty-text-${pageId}`, text: "正在获取构建 ID…", align: $align.center, font: $font(14), textColor: C.sub, lines: 3 },
    layout: (make, view) => {
      make.left.right.inset(28);
      make.centerY.equalTo(view.super).offset(18);
      make.height.equalTo(64);
    },
    events: { ready: (sender) => { sender.text = emptyText.props.text; } },
  };
  const empty = {
    type: "view",
    props: { id: `versions-empty-${pageId}`, hidden: false, userInteractionEnabled: false, bgcolor: $color("clear") },
    layout: $layout.fill,
    views: [spinner, emptyText],
    events: { ready: (sender) => { sender.hidden = empty.props.hidden; } },
  };
  function listDefinition() {
    const builtRows = rows;
    const definition = {
      type: "list",
      props: common.listBaseProps({
        id: `versions-list-${pageId}`,
        style: 0,
        separatorHidden: true,
        header: { type: "view", props: { height: 52 }, views: [status, progress, retry] },
        data: [{ title: "", rows: builtRows }],
        rowHeight: 88,
        sectionTitleHeight: 0,
      }),
      layout: $layout.fill,
      events: {
        ready: () => {
          if (!alive || list !== definition) return;
          renderedRows = builtRows;
          refresh();
        },
      },
    };
    return definition;
  }
  let list = listDefinition();

  function setViewState(definition, values) {
    Object.assign(definition.props, values);
    const view = $ui.get(definition.props.id);
    if (view) for (const key of Object.keys(values)) view[key] = values[key];
  }

  function refresh(replay) {
    if (!alive) return;
    const current = currentAccount();
    if (!current && enumeration) {
      enumeration.stopped = true;
      loading = false;
    }
    const resolved = entries.filter((entry) => entry.item.resolved).length;
    const text = !current ? "账号已切换" : failure ? "版本号加载失败"
      : loading && !complete && rows.length ? `补全版本号 ${resolved}/${rows.length}`
      : rows.length || complete ? `${rows.length} 个版本` : app.name;
    setViewState(status, { text });
    setViewState(progress, { loading: !!current && loading && !complete && rows.length > 0 });
    setViewState(retry, {
      hidden: !current || !!enumeration || (complete && !failure) || activeDownloads > 0,
      title: failure ? "重试" : "继续",
    });
    setViewState(spinner, { loading: !!current && loading && !complete && rows.length === 0 });
    setViewState(empty, { hidden: rows.length > 0 });
    setViewState(emptyText, { text: !current ? "账号已切换，请返回后重试"
      : failure ? errorMessage(failure) : complete ? "暂无历史版本"
      : loading ? "正在获取构建 ID…" : "加载已暂停" });
    const nativeList = $ui.get(list.props.id);
    if (nativeList && renderedRows !== rows) {
      const offset = nativeList.contentOffset;
      list = common.preserveListOffset(nativeList, listDefinition());
      // 静态完整视图需要随 list 创建；只赋 data/reload 在旧版 JSBox 可能留下空 cell。
      // 先确认本次行集，ready 延迟期间的版本号快照仍只更新标签。
      renderedRows = rows;
      const parent = nativeList.super;
      if (parent && typeof nativeList.remove === "function" && typeof parent.add === "function") {
        nativeList.remove();
        parent.add(list);
        const overlay = $ui.get(empty.props.id);
        if (overlay && typeof overlay.moveToFront === "function") overlay.moveToFront();
      } else {
        nativeList.data = list.props.data;
        if (typeof nativeList.reload === "function") nativeList.reload();
        if (offset) nativeList.contentOffset = offset;
      }
    }
    entries.forEach((entry) => entry.refresh(replay));
    // 补版本号不改变 exact-ID 的本地文件匹配，避免每帧重复扫描整个 IPA 库。
    if (replay) common.refreshDownloadButtons();
  }

  function applySnapshot(snapshot) {
    const incoming = new Map((snapshot.versions || []).map((item) => [String(item.id), item]));
    const resolved = new Set((snapshot.resolvedIds || []).map(String));
    const existing = new Map(entries.map((entry) => [entry.item.id, entry]));
    // 服务的最终结果仍按版本号排序；已上屏的行保持原 ID 顺序。
    const ids = entries.map((entry) => entry.item.id).filter((id) => incoming.has(id));
    for (const id of incoming.keys()) if (!existing.has(id)) ids.push(id);
    for (const entry of entries) if (!incoming.has(entry.item.id)) common.releaseDownloadButtons(entry.view);
    const next = ids.map((id) => {
      const value = incoming.get(id);
      const entry = existing.get(id) || versionRowView({ id }, app, getVersion, pageId, code, email);
      Object.assign(entry.item, {
        requestedExternalVersionId: String(value.requestedExternalVersionId || id),
        externalVersionId: String(value.externalVersionId || ""),
        displayVersion: String(value.displayVersion || "").trim(),
        buildVersion: String(value.buildVersion || "").trim(),
        resolved: resolved.has(id),
        latest: id === String(snapshot.latest || ""),
      });
      return entry;
    });
    const changed = next.length !== entries.length || next.some((entry, index) => entry !== entries[index]);
    entries = next;
    if (changed) {
      rows = entries.map((entry) => entry.view);
      list.props.data = [{ title: "", rows }];
    }
    complete = snapshot.complete === true;
    refresh();
  }

  function load() {
    if (!alive || enumeration || activeDownloads > 0) return;
    const current = currentAccount();
    if (!current) { refresh(); return; }
    const task = { stopped: false, promise: null };
    enumeration = task;
    loading = true;
    complete = false;
    failure = null;
    refresh();
    const shouldContinue = () => {
      if (!currentAccount()) task.stopped = true;
      return alive && enumeration === task && !task.stopped;
    };
    task.promise = (async () => {
      try {
        const result = await downloader.listVersions(current, app, {
          shouldContinue,
          knownVersions: entries.filter((entry) => entry.item.resolved).map(({ item }) => ({
            id: item.id,
            requestedExternalVersionId: item.requestedExternalVersionId,
            externalVersionId: item.externalVersionId,
            displayVersion: item.displayVersion,
            buildVersion: item.buildVersion,
          })),
          onVersions: (snapshot) => { if (shouldContinue()) applySnapshot(snapshot); },
        });
        if (!shouldContinue()) return;
        const versions = result.versions || (result.identifiers || []).map((id) => ({ id }));
        applySnapshot({ versions, latest: result.latest, resolvedIds: versions.map((item) => item.id), complete: true });
      } catch (err) {
        if (shouldContinue() && String(err.code) !== "version_list_cancelled") {
          failure = err;
          reportDownloadError(err, app);
        }
      } finally {
        if (enumeration === task) {
          enumeration = null;
          loading = false;
          refresh();
        }
      }
    })();
    return task.promise;
  }

  async function getVersion(item, onProgress, onTask) {
    if (!alive) return false;
    if (common.openDownloaded(app, { externalVersionId: item.id, displayVersion: item.displayVersion })) return true;
    const preparation = prepareDownload(app, onTask);
    const task = enumeration;
    if (task) {
      if (!task.stopped && !complete) resumeAfterDownload = true;
      task.stopped = true;
    }
    activeDownloads++;
    loading = false;
    refresh();
    try {
      // 枚举响应携带旧 Cookie 集，先让在途请求及其持久化收尾。
      if (task) await task.promise;
      if (preparation.cancelled) {
        resumeAfterDownload = false;
        return false;
      }
      // 用户已点击获取；关闭页面只停止枚举与 UI，下载仍用同一账号的新会话继续。
      const current = currentAccount(true);
      if (!current) return false;
      const done = await downloadVersionFlow(current, app, item.id, region, {
        onProgress,
        onTask: preparation.onTask,
        displayVersion: item.displayVersion,
      });
      if (!done) resumeAfterDownload = false;
      return done;
    } finally {
      preparation.finish();
      activeDownloads--;
      refresh();
      if (activeDownloads === 0 && resumeAfterDownload) {
        resumeAfterDownload = false;
        if (alive && !complete && currentAccount()) load();
      }
    }
  }

  $ui.push(common.page({
    props: common.pageProps({
      title: "历史版本",
      id: `versions-page-${pageId}`,
    }),
    events: {
      appeared: () => refresh(true),
      dealloc: () => {
        alive = false;
        if (enumeration) enumeration.stopped = true;
        common.releaseDownloadButtons(rows);
      },
    },
    views: [list, empty],
  }));
  // 先提交页面和中心 spinner，再开始可能需要授权的网络操作。
  if (typeof $delay === "function") $delay(0, load);
  else load();
}

async function downloadVersionFlow(account, app, externalVersionId, region, options) {
  if (common.openDownloaded(app, { externalVersionId, displayVersion: options && options.displayVersion })) return true;
  const hasInlineProgress = !!(options && typeof options.onProgress === "function");
  if (!hasInlineProgress) {
    const pending = downloader.downloadVersion(account, app, externalVersionId, {
      region,
      onTask: options && options.onTask,
    });
    common.toast("已添加到下载列表");
    const done = await common.runWithLoading("正在下载所选版本…", () => downloadResult(pending, app));
    if (!done) return;
    common.refreshDownloadButtons();
    installer.downloadComplete(done.record, done);
    return true;
  }

  // 行内进度已经提供加载反馈，保留页面点击以便取消。
  let done = null;
  try {
    const pending = downloader.downloadVersion(account, app, externalVersionId, {
      region,
      onTask: options.onTask,
      onProgress: options.onProgress,
    });
    common.toast("已添加到下载列表");
    done = await pending;
  } catch (err) {
    reportDownloadError(err, app);
    return;
  }
  if (!done) return;
  common.refreshDownloadButtons();
  installer.downloadComplete(done.record, done);
  return true;
}

module.exports = {
  show,
  // 首页/榜单行使用同一条下载入口，避免把下载逻辑复制到各个列表页面。
  downloadApp: downloadLatestFlow,
  reportDownloadError,
  formatVersionLabel,
};
