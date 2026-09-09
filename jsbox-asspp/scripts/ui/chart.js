// 榜单页：RSS 榜单 -> 补充详情 -> 列表 -> 详情。

const common = require("./common");
const storeApi = require("../apple/store");
const settings = require("../store/settings");
const { errorMessage } = require("../lib/error");

let pageSeq = 0;

function statusRow(message, retry) {
  const views = [
    {
      type: "label",
      props: {
        text: message,
        font: $font(14),
        textColor: retry ? common.colors.blue : common.colors.sub,
        align: $align.center,
        lines: 2,
      },
      layout: (make) => {
        make.left.right.inset(20);
        make.top.bottom.inset(14);
      },
    },
  ];
  if (retry) {
    views.push({
      type: "button",
      props: {
        bgcolor: $color("clear"),
        accessibilityLabel: "重新加载榜单",
      },
      layout: $layout.fill,
      events: { tapped: retry },
    });
  }
  return {
    type: "view",
    props: { bgcolor: common.colors.card, selectionStyle: 0, selectable: false },
    layout: (make, view) => {
      make.edges.equalTo(view.super);
    },
    views,
  };
}

function render(region, kind) {
  const title = kind.title;
  const instance = ++pageSeq;
  const listId = `chart-list-${instance}`;
  let rows = [];
  let alive = true;
  let loadSeq = 0;
  let currentDefinition = null;
  let pendingData = null;

  $ui.push(common.page({
    props: common.pageProps({
      title: `${title} · ${common.regionText(region)}`,
    }),
    events: {
      appeared: () => {
        if (pendingData) setListData(pendingData);
        common.refreshDownloadButtons();
      },
      dealloc: () => {
        alive = false;
        loadSeq += 1;
        common.releaseDownloadButtons(currentDefinition);
        common.releaseDownloadButtons(pendingData);
      },
    },
    views: [listDefinition([{ title: common.regionText(region), rows: [statusRow("正在加载榜单…")] }])],
  }));

  loadChart(region, kind.key);

  async function loadChart(regionCode, kindKey) {
    const token = ++loadSeq;
    setListData([{ title: common.regionText(regionCode), rows: [statusRow("正在加载榜单…")] }]);
    try {
      const feed = await storeApi.fetchChart(
        kindKey,
        regionCode,
        settings.chartLimit()
      );
      if (!alive || token !== loadSeq) return;
      rows = feed.slice();
      const ids = feed
        .map((item) => item.id)
        .filter((id) => id && id !== "0");
      if (ids.length) {
        try {
          const enriched = await storeApi.lookupByIds(ids, regionCode);
          if (!alive || token !== loadSeq) return;
          const byId = {};
          for (const soft of enriched) byId[soft.id] = soft;
          // lookup 失败或缺项时保留 RSS 行，榜单仍然可见且顺序不变。
          rows = feed.map((item) => byId[item.id] || item);
        } catch (_lookupError) {
          if (!alive || token !== loadSeq) return;
          common.toast("详情补充失败，已显示基础榜单");
        }
      }
      if (token !== loadSeq) return;
      if (!rows.length) {
        setListData([
          {
            title: common.regionText(regionCode),
            rows: [statusRow("榜单为空，请稍后再试")],
          },
        ]);
        return;
      }
      showRows();
    } catch (err) {
      if (!alive || token !== loadSeq) return;
      setListData([
        {
          title: common.regionText(regionCode),
          rows: [
            statusRow(`${errorMessage(err)}\n点按重试`, () =>
              loadChart(regionCode, kindKey)
            ),
          ],
        },
      ]);
    }
  }

  function showRows() {
    setListData([
      {
        title: `${common.regionText(region)} · ${rows.length} 个应用`,
        rows: rows.map((soft, idx) =>
          common.chartRowView(soft, idx, {
            region,
            onView: () => require("./detail").show(soft, region),
            onGet: (onProgress, onTask) => require("./detail").downloadApp(soft, region, { onProgress, onTask }),
          })
        ),
      },
    ]);
  }

  function setListData(data) {
    const target = currentList();
    if (!target) {
      common.releaseDownloadButtons(pendingData);
      pendingData = data;
      return;
    }
    if (pendingData !== data) common.releaseDownloadButtons(pendingData);
    pendingData = null;
    const definition = listDefinition(data);
    common.preserveListOffset(target, definition);
    // 榜单行是静态完整视图。旧版 JSBox 可能复用旧 cell，即使 reload 也
    // 留下加载骨架，因此优先重建 list；没有 remove/add 时再回退到 reload。
    const parent = target.super;
    if (parent && typeof target.remove === "function" && typeof parent.add === "function") {
      target.remove();
      parent.add(definition);
      return;
    }
    target.data = definition.props.data;
    if (typeof target.reload === "function") target.reload();
  }

  function listDefinition(data) {
    common.releaseDownloadButtons(currentDefinition);
    currentDefinition = {
      type: "list",
      props: common.listBaseProps({
        id: listId,
        style: 0,
        separatorHidden: true,
        data,
        rowHeight: 84,
      }),
      layout: $layout.fill,
    };
    return currentDefinition;
  }

  function currentList() {
    if (!alive) return null;
    try {
      return $ui.get(listId);
    } catch (_e) {
      return null;
    }
  }
}

module.exports = {
  render,
};
