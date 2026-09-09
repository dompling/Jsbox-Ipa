const { test } = require("node:test");
const assert = require("node:assert");
const { pageViews } = require("./helpers/ui");

function installGlobals() {
  global.$color = (value) => `color:${JSON.stringify(value)}`;
  global.$font = (...args) => `font:${args.join(":")}`;
  global.$align = { left: 0, center: 1, right: 2 };
  global.$size = (width, height) => ({ width, height });
  global.$insets = (top, left, bottom, right) => ({ top, left, bottom, right });
  global.$layout = { fill: { __fill: true } };
  global.$device = {
    info: { screen: { width: 390, height: 844 }, scale: 3 },
  };
  // 近似模拟 UIKit 换行：行高 = 字号 * 1.2，按 CJK 全角 / 拉丁半角宽度折行。
  // 真实设备上 downloads.js 会使用 $text.sizeThatFits 的原生排版结果。
  global.$text = {
    sizeThatFits: ({ text, width, font }) => {
      const match = /:(\d+)$/.exec(String(font)) || /(\d+)/.exec(String(font));
      const fontSize = match ? Number(match[1]) : 14;
      const maxWidth = Math.max(1, Number(width) || 1);
      let lines = 1;
      let current = 0;
      for (const ch of String(text || "")) {
        const cw = ch.codePointAt(0) >= 0x2e80 ? fontSize : fontSize * 0.72;
        if (current + cw > maxWidth && current > 0) {
          lines += 1;
          current = cw;
        } else {
          current += cw;
        }
      }
      return {
        width: maxWidth,
        height: Math.max(fontSize * 1.2, lines * fontSize * 1.2),
      };
    },
  };
  global.$data = ({ string, bytes }) =>
    string !== undefined ? { string } : { bytes: bytes || [] };
  global.$prefs = { get: () => [], set: () => true };
}

function flatViews(root, result) {
  const acc = result || [];
  if (!root || typeof root !== "object") return acc;
  acc.push(root);
  for (const child of root.views || []) flatViews(child, acc);
  return acc;
}

function libraryMocks(files) {
  const dirs = new Set(["downloads"]);
  return {
    dirs,
    $file: {
      exists: (path) => dirs.has(path) || files.has(path),
      isDirectory: (path) => dirs.has(path),
      mkdir: () => true,
      read: (path) => files.get(path),
      list: (dir) => {
        if (!dirs.has(dir)) return null;
        const prefix = `${dir}/`;
        return [...files.keys()]
          .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          .map((path) => path.slice(prefix.length));
      },
    },
  };
}

test("downloads list leads with an import row and renders saved icons for IPA rows", () => {
  installGlobals();
  const files = new Map();
  const createdAt = new Date().toISOString();
  files.set("downloads/Demo.ipa", { bytes: [1] });
  files.set(
    "downloads/Demo.ipa.meta.json",
    {
      string: JSON.stringify({
        fileName: "Demo.ipa",
        title: "Demo App",
        bundleId: "com.example.demo",
        version: "1.0",
        sinfInjected: true,
        createdAt,
        size: 1024,
      }),
    }
  );
  const icon = { bytes: [0x89, 0x50, 0x4e, 0x47] };
  files.set("downloads/Demo.ipa.icon", icon);
  global.$file = libraryMocks(files).$file;

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const list = downloads.views()[0];
  const data = list.props.data;
  assert.ok(Array.isArray(data) && data.length >= 2);
  assert.strictEqual(list.props.rowHeight, 88);

  const importRow = flatViews(data[0].rows[0]).find(
    (view) => view.props && view.props.symbol === "square.and.arrow.down"
  );
  assert.ok(importRow, "import row should show a file-import symbol");
  const title = flatViews(data[0].rows[0]).find(
    (view) => view.props && view.props.text === "导入 IPA 文件"
  );
  assert.ok(title);

  const fileRow = data[1].rows[0];
  assert.ok(flatViews(fileRow).some((view) => view.props && view.props.data === icon));
  const fileName = flatViews(fileRow).find(
    (view) => view.props && view.props.text === "Demo App"
  );
  assert.ok(fileName);
  assert.strictEqual(fileRow.props.selectable, false);
  assert.ok(
    flatViews(fileRow).some(
      (view) => view.type === "button" && view.layout && view.layout.__fill
    ),
    "file row should route taps through a full-card button instead of cell selection"
  );
  assert.strictEqual(
    list.events.didSelect,
    undefined,
    "download rows must not rely on cell didSelect"
  );
});

test("the import card uses one-line copy and a compact first-section gap without changing its action", async (t) => {
  installGlobals();
  global.$file = libraryMocks(new Map()).$file;
  const previousDrive = global.$drive;
  let opened = 0;
  global.$drive = { open: async () => { opened += 1; return null; } };
  t.after(() => { global.$drive = previousDrive; });
  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  let row;
  for (const width of [320, 375, 430]) {
    global.$device.info.screen.width = width;
    const list = downloads.views()[0];
    row = list.props.data[0].rows[0];
    assert.strictEqual(list.props.contentInset.top, 0, "keep system safe-area handling instead of a negative offset");
    assert.strictEqual(list.events.sectionTitleHeight(null, 0), 4);
    assert.strictEqual(list.events.sectionTitleHeight(null, 1), 28, "file and task headings keep their existing spacing");
    for (const text of ["导入 IPA 文件", "从“文件”导入 IPA"]) {
      const label = flatViews(row).find((view) => view.props && view.props.text === text);
      assert.ok(label);
      assert.strictEqual(label.props.lines, 1);
      const values = {};
      const chain = (properties = []) => new Proxy({}, {
        get: (_target, key) => ["equalTo", "inset", "offset"].includes(key)
          ? (value) => { for (const property of properties) values[property] = value; return chain(properties); }
          : chain(properties.concat(key)),
      });
      label.layout(chain(), { super: {} });
      const available = width - 32 - values.left - values.right;
      const measured = global.$text.sizeThatFits({ text, width: available, font: label.props.font });
      const single = global.$text.sizeThatFits({ text: "Ag", width: available, font: label.props.font });
      assert.strictEqual(measured.height, single.height, `${width}pt leaves enough width for the complete import text`);
    }
  }
  const action = flatViews(row).find((view) => view.type === "button");
  await action.events.tapped();
  assert.strictEqual(opened, 1);
});

test("downloads fall back to a default placeholder icon when no icon sidecar exists", () => {
  installGlobals();
  const files = new Map();
  files.set("downloads/Bare.ipa", { bytes: [1] });
  files.set(
    "downloads/Bare.ipa.meta.json",
    {
      string: JSON.stringify({
        fileName: "Bare.ipa",
        title: "Bare",
        sinfInjected: true,
        createdAt: new Date().toISOString(),
      }),
    }
  );
  global.$file = libraryMocks(files).$file;

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const data = downloads.views()[0].props.data;
  assert.strictEqual(data.length, 2);
  const row = data[1].rows[0];
  const symbolView = flatViews(row).find(
    (view) => view.props && view.props.symbol === "app"
  );
  assert.ok(symbolView, "missing icon sidecar should use the default app symbol");
  const iconDataViews = flatViews(row).filter(
    (view) => view.props && view.props.data !== undefined
  );
  assert.strictEqual(iconDataViews.length, 0);
});

test("downloads list shows in-flight tasks with progress and keeps failed tasks for retry", () => {
  installGlobals();
  const files = new Map();
  global.$file = libraryMocks(files).$file;

  const queue = require("../scripts/services/queue");
  const task = queue.begin({
    app: {
      name: "微信",
      artworkUrl100: "https://example.com/wechat.png",
    },
    region: "CN",
  });
  queue.update(task.id, {
    status: "downloading",
    progress: 0.42,
    message: "正在下载 · 12.3 MB / 42 MB",
  });

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const data = downloads.views()[0].props.data;
  assert.ok(data.length >= 2);
  assert.strictEqual(data[1].title, "正在下载 1 个 App");
  const row = data[1].rows[0];
  const views = flatViews(row);
  assert.ok(views.some((view) => view.props && view.props.src === "https://example.com/wechat.png"));
  assert.ok(views.some((view) => view.props && view.props.text === "微信"));
  assert.ok(views.some((view) => view.props && view.props.text === "42%"));
  assert.ok(views.some((view) => view.props && /正在下载/.test(view.props.text || "")));
  const progress = views.find((view) => view.type === "progress");
  assert.ok(progress, "active task row should render a progress bar");
  assert.strictEqual(progress.props.value, 0.42);
  const common = require("../scripts/ui/common");
  assert.strictEqual(progress.props.progressColor, common.colors.blue);
  assert.strictEqual(progress.props.trackColor, common.colors.field);

  queue.fail(task.id, new Error("连接被重置"));
  const failedData = downloads.views()[0].props.data;
  const failedRow = failedData[1].rows[0];
  assert.ok(flatViews(failedRow).some((view) => view.props && /下载失败/.test(view.props.text || "")));
  assert.ok(!flatViews(failedRow).some((view) => view.props && view.props.text === "42%"));
  assert.ok(
    !flatViews(failedRow).some((view) => view.type === "progress"),
    "failed task row should hide the progress bar"
  );
  queue.remove(task.id);
});

test("long file titles/subtitles wrap to two lines and the row height follows content", () => {
  installGlobals();
  const files = new Map();
  const createdAt = "2026-09-07T08:00:00.000Z";
  const longTitle = "这是一个非常非常长的应用名称用于验证下载列表的超长标题不会被裁切隐藏掉";
  const longBundle =
    "com.example.superlongbundleidentifier.repeated.for.wrapping.check." +
    "com.example.superlongbundleidentifier.repeated.for.wrapping.check." +
    "com.example.superlongbundleidentifier.repeated.for.wrapping.check";
  files.set("downloads/Long.ipa", { bytes: [1] });
  files.set(
    "downloads/Long.ipa.meta.json",
    {
      string: JSON.stringify({
        fileName: "Long.ipa",
        title: longTitle,
        bundleId: longBundle,
        version: "9.9.9",
        sinfInjected: true,
        createdAt,
        size: 2048,
      }),
    }
  );
  global.$file = libraryMocks(files).$file;

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const list = downloads.views()[0];
  const data = list.props.data;
  assert.strictEqual(data.length, 2); // 导入入口 + 已下载
  const row = data[1].rows[0];
  const views = flatViews(row);
  const titleLabel = views.find(
    (view) => view.type === "label" && view.props && view.props.text === longTitle
  );
  assert.ok(titleLabel, "oversized title keeps its full text for native wrapping");
  assert.strictEqual(titleLabel.props.lines, 2);
  const subtitle = views.find(
    (view) => view.type === "label" && view.props && view.props.text.includes("2026-09-07")
  );
  assert.ok(subtitle, "metadata (bundle id/version/save date) stays visible");
  assert.strictEqual(subtitle.props.lines, 2);
  assert.ok(
    list.events.rowHeight(null, { section: 1, row: 0 }) > 88,
    "two two-line texts grow the row beyond the compact height"
  );
  assert.strictEqual(
    list.events.rowHeight(null, { section: 0, row: 0 }),
    88
  );
  assert.ok(
    !flatViews(row).some(
      (view) =>
        view.type === "label" && view.props && /…/.test(view.props.text)
    ),
    "no JS-side middle truncation should be applied"
  );
});

test("download task rows keep a compact height when only the title wraps", () => {
  installGlobals();
  const files = new Map();
  global.$file = libraryMocks(files).$file;

  const queue = require("../scripts/services/queue");
  const longName =
    "超长应用名称验证任务标题换行后进度条";
  const task = queue.begin({
    app: { name: longName, artworkUrl100: "https://example.com/long.png" },
    region: "CN",
  });
  queue.update(task.id, {
    status: "downloading",
    progress: 0.66,
    message: "88.0 MB / 120 MB",
  });

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const list = downloads.views()[0];
  const data = list.props.data;
  assert.strictEqual(data[1].title, "正在下载 1 个 App");
  const row = data[1].rows[0];
  const views = flatViews(row);
  const progress = views.find((view) => view.type === "progress");
  assert.ok(progress, "expanded task row still renders the progress bar");
  assert.strictEqual(progress.props.value, 0.66);
  assert.strictEqual(
    list.events.rowHeight(null, { section: 1, row: 0 }),
    106,
    "the account line adds its own space while the task row remains compact"
  );
  const title = views.find(
    (view) => view.props && view.props.text === longName
  );
  assert.ok(title, "two-line title keeps the whole app name");
  assert.strictEqual(title.props.lines, 2);
  queue.remove(task.id);
});

test("download task rows grow when the message also wraps", () => {
  installGlobals();
  const files = new Map();
  global.$file = libraryMocks(files).$file;

  const queue = require("../scripts/services/queue");
  const longName = "一个用于验证任务行标题与消息同时换行的超长应用名称";
  const task = queue.begin({
    app: { name: longName, artworkUrl100: "https://example.com/wrap.png" },
    region: "CN",
  });
  const longMessage =
    "正在下载 · 这是一个非常长的下载说明，用于让任务行的副标题同样换行显示进度信息";
  queue.update(task.id, {
    status: "downloading",
    progress: 0.5,
    message: longMessage,
  });

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const list = downloads.views()[0];
  const row = list.props.data[1].rows[0];
  const views = flatViews(row);
  const title = views.find(
    (view) => view.props && view.props.text === longName
  );
  const subtitle = views.find(
    (view) => view.props && view.props.text === longMessage
  );
  assert.strictEqual(title.props.lines, 2);
  assert.strictEqual(subtitle.props.lines, 2);
  assert.ok(
    list.events.rowHeight(null, { section: 1, row: 0 }) > 96,
    "both wrapped lines increase the task row height above its minimum"
  );
  queue.remove(task.id);
});

test("downloaded file rows show ordinary app information and plain records retain their archive actions", (t) => {
  installGlobals();
  const files = new Map();
  const createdAt = new Date().toISOString();
  const metaFor = (fileName, title, extra) =>
    JSON.stringify(
      Object.assign(
        {
          fileName,
          title,
          bundleId: "com.example.demo",
          version: "1.0",
          createdAt,
          size: 1024,
        },
        extra || {}
      )
    );
  files.set("downloads/Demo.ipa", { bytes: [1] });
  files.set("downloads/Demo.ipa.meta.json", {
    string: metaFor("Demo.ipa", "Demo App", { sinfInjected: true }),
  });
  files.set("downloads/Bare.ipa", { bytes: [1] });
  files.set("downloads/Bare.ipa.meta.json", {
    string: metaFor("Bare.ipa", "Bare App"),
  });
  global.$file = libraryMocks(files).$file;

  delete require.cache[require.resolve("../scripts/ui/downloads")];
  const downloads = require("../scripts/ui/downloads");
  const data = downloads.views()[0].props.data;
  const fileRows = data.filter(
    (section) => section.title && section.title.indexOf("已下载") >= 0
  )[0].rows;
  const subtitles = fileRows.map((row) => {
    const labels = flatViews(row).filter(
      (view) => view.type === "label" && view.props && view.props.id === "dl-subtitle"
    );
    return labels.map((label) => label.props.text).join("");
  });
  assert.strictEqual(subtitles.length, 1);
  assert.ok(
    subtitles.some((text) => text.includes("com.example.demo") && text.includes("v1.0")),
    "the downloaded file keeps its app metadata"
  );
  assert.ok(subtitles.every(text => !/已注入/.test(text)), "license state is represented by the downloaded/archive grouping");
  let archive;
  const previousUI = global.$ui;
  global.$ui = { push: (page) => { archive = page; } };
  t.after(() => { global.$ui = previousUI; if (archive) archive.events.dealloc(); });
  const entry = flatViews(data[0].rows[1]).find(view => view.type === "button");
  entry.events.tapped();
  const archiveRows = pageViews(archive)[0].props.data[0].rows;
  assert.strictEqual(archiveRows.length, 1);
  const archivedViews = flatViews(archiveRows[0]);
  assert.ok(archivedViews.some(view => view.props && view.props.text === "Bare App"));
  assert.ok(archivedViews.some(view => view.type === "button" && view.props.accessibilityLabel === "Bare App，账号：未知，点按操作"));
  assert.ok(!archivedViews.some(view => view.props && /已注入授权/.test(view.props.text || "")), "plain archive records must not show an injected marker");
});
