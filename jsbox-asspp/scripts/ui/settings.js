// 设置 Tab：账号入口 / 区域 / 榜单数量 / 认证端点 / 关于。
// 「Apple ID 账号」进入账号管理页（支持登录与两步验证）。

const config = require("../config");
const common = require("./common");
const settings = require("../store/settings");
const accountsStore = require("../store/accounts");
const urlUtil = require("../lib/url");

const C = common.colors;

function activeEmail() {
  const region = settings.region();
  const email = accountsStore.activeEmailForRegion(settings.region());
  const acc = email ? accountsStore.getAccount(email) : null;
  const accRegion =
    acc && typeof accountsStore.accountRegion === "function"
      ? accountsStore.accountRegion(acc)
      : acc && String(acc.store || "").toUpperCase();
  if (acc && accRegion === region) return acc.email;
  // 迁移自旧版本的账号可能还没有显式 active binding；存储层已经有
  // storefront 匹配逻辑，这里复用它避免设置页误报“还没有账号”。
  try {
    const matched = accountsStore.accountForRegion(region);
    return matched ? matched.email : "";
  } catch (_e) {
    return "";
  }
}

function modeLabel() {
  const mode = settings.authURLMode();
  return mode === "legacy" ? "旧版" : mode === "custom" ? "自定义" : "自动";
}

function modeDescription() {
  const mode = settings.authURLMode();
  if (mode === "legacy") return "使用旧版 MZFinance 认证（实验性）";
  if (mode === "custom") return `自定义：${settings.customAuthURL() || "未填写"}`;
  return "bag 自动发现（推荐）";
}

function rawSapLabel() {
  return settings.rawSapMode() === "api" ? "已开启" : "未开启";
}

function sections() {
  const email = activeEmail();
  return [
    common.menuSection("Apple ID", [
      common.iconMenuRow(
        "账号与登录",
        email
          ? `${email}\n${common.regionText(settings.region())} 默认账号`
          : "还没有账号，点此登录",
        email ? "管理" : "",
        "accounts",
        "person.crop.circle.fill",
        C.purple
      ),
    ]),
    common.menuSection("通用", [
      common.iconMenuRow(
        "当前区域",
        `${common.countryName(settings.region())} · 搜索与榜单使用该区域商店`,
        settings.region(),
        "region",
        "globe",
        C.blue
      ),
      common.iconMenuRow(
        "榜单加载数量",
        "影响榜单页展示条数",
        `${settings.chartLimit()}`,
        "chartLimit",
        "slider.horizontal.3",
        C.orange
      ),
      common.iconMenuRow(
        "已购签名",
        "SAP 服务配置",
        rawSapLabel(),
        "sapConfig",
        "signature",
        C.teal
      ),
    ]),
    common.menuSection("认证", [
      common.iconMenuRow(
        "认证端点",
        modeDescription(),
        modeLabel(),
        "authMode",
        "lock.fill",
        C.purple
      ),
    ]),
    common.menuSection("安装", [
      common.iconMenuRow(
        "Plist 安装服务",
        "按 IPA-Tool-3.0 方式生成 HTTPS 安装清单",
        settings.plistServer().includes("xiaobai.app") ? "代理模块" : "Scripting",
        "plistServer",
        "shippingbox.fill",
        C.blue
      ),
    ]),
    common.menuSection("关于", [
      common.iconMenuRow(
        "关于与风险提示",
        `${config.APP.name} ${config.APP.version} · 仅供学习研究`,
        "",
        "about",
        "info.circle.fill",
        C.teal
      ),
    ]),
  ];
}

function update() {
  const list = $("settings-list");
  if (list) list.data = sections();
}

function views() {
  return [
    {
      type: "list",
      props: common.floatingTabListProps({
        id: "settings-list",
        data: sections(),
        template: common.iconMenuTemplate,
        autoRowHeight: true,
        estimatedRowHeight: common.ICON_MENU_ESTIMATED_ROW_HEIGHT,
      }),
      layout: $layout.fill,
      events: {
        didSelect: (sender, indexPath, row) => {
          handle(row && row._key);
        },
      },
    },
  ];
}

function mount() {
  update();
}

// ---------- 操作 ----------

function handle(key) {
  switch (key) {
    case "accounts":
      require("./accounts").render();
      break;
    case "purchased":
      require("./purchased").render();
      break;
    case "region":
      common.pickRegion((code) => {
        try {
          settings.setRegion(code);
          common.toast(`已切换到 ${common.regionText(code)}`);
          update();
        } catch (err) {
          common.alertError(err);
        }
      });
      break;
    case "chartLimit": {
      const options = [10, 25, 50, 100];
      common.menu({
        items: options.map((n) => `${n} 条`),
        handler: (title, idx) => {
          try {
            settings.setChartLimit(options[idx]);
            update();
          } catch (err) {
            common.alertError(err);
          }
        },
      });
      break;
    }
    case "sapConfig":
      promptSapConfig();
      break;
    case "authMode":
      common.menu({
        items: ["auto（推荐）", "legacy（实验）", "custom（自定义 URL）"],
        handler: (title, idx) => {
          const mode = ["auto", "legacy", "custom"][idx];
          if (mode === "custom") {
            promptCustomURL();
          } else {
            try {
              settings.setAuthURLMode(mode);
              update();
            } catch (err) {
              common.alertError(err);
            }
          }
        },
      });
      break;
    case "plistServer":
      common.menu({
        items: ["Scripting（推荐）", "代理模块"],
        handler: (_title, idx) => {
          const urls = [
            "https://api.scripting.fun/ipa-plist",
            "https://xiaobai.app/install",
          ];
          try {
            settings.setPlistServer(urls[idx]);
            update();
            common.toast("已更新 Plist 安装服务");
          } catch (err) {
            common.alertError(err);
          }
        },
      });
      break;
    case "about":
      common.alert({
        title: `${config.APP.name} ${config.APP.version}`,
        message:
          "参考项目：ipatool-sapfix、Lakr233/Asspp（ApplePackage）。\n\n" +
          "账号风险：调用 Apple 非公开接口存在封号或失效风险，请使用次要 Apple ID，" +
          "并妥善保管设备 GUID。\n\n" +
          "OTA 风险：安装清单按 IPA-Tool-3.0 通过 HTTPS Plist 服务生成，但 IPA 文件仍由本机 localhost:8000 提供，" +
          "较新的 iOS 可能拒绝本地 HTTP 安装；" +
          "App Store 原始 IPA 仍可能需要正确的 SINF 或签名准备才能安装。\n\n" +
          "存储提示：大型 IPA 的下载、落盘与 OTA 暂存会占用较多内存和磁盘空间，" +
          "请预留足够容量并及时清理不再需要的文件。本地库属于 JSBox 扩展自己的缓存，" +
          "扩展被重命名、删除或数据被系统清理时可能丢失。仅供学习研究。",
      });
      break;
  }
}

function promptCustomURL() {
  $ui.push(common.page({
    props: common.pageProps({ title: "自定义认证端点" }),
    views: [
      {
        type: "scroll",
        props: { bgcolor: C.page },
        layout: $layout.fill,
        views: [
          {
            type: "label",
            props: {
              text: "仅当自动与旧版端点失效时使用。认证请求包含敏感凭据，只允许 HTTPS Apple 端点。",
              font: $font(13),
              textColor: C.sub,
              lines: 0,
            },
            layout: (make) => {
              make.left.right.inset(20);
              make.top.inset(20);
              make.height.equalTo(44);
            },
          },
          {
            type: "input",
            props: common.fieldProps("https://…", {
              id: "auth-url",
              text: settings.customAuthURL(),
              type: $kbType.url,
            }),
            layout: (make) => {
              make.left.right.inset(16);
              make.top.equalTo(76);
              make.height.equalTo(48);
            },
          },
          {
            type: "label",
            props: {
              id: "auth-url-error",
              text: "",
              font: $font(12),
              textColor: C.red,
              lines: 0,
            },
            layout: (make) => {
              make.left.right.inset(20);
              make.top.equalTo($("auth-url").bottom).offset(8);
              make.height.equalTo(38);
            },
          },
          {
            type: "button",
            props: common.primaryButtonProps("保存", { id: "save-url" }),
            layout: (make) => {
              make.left.right.inset(16);
              make.top.equalTo($("auth-url-error").bottom).offset(8);
              make.height.equalTo(50);
            },
            events: {
              tapped: () => {
                const input = $("auth-url");
                const value = String(input ? input.text || "" : "").trim();
                const errorLabel = $("auth-url-error");
                try {
                  if (!value) throw new Error("请输入 HTTPS 认证端点");
                  const normalized = validateCustomURL(value);
                  settings.setCustomAuthURL(normalized);
                  settings.setAuthURLMode("custom");
                  if (errorLabel) errorLabel.text = "";
                  common.toast("已保存并启用自定义端点");
                  $ui.pop();
                  update();
                } catch (err) {
                  if (errorLabel) errorLabel.text = err.message || "认证端点无效";
                }
              },
            },
          },
        ],
      },
    ],
  }));
}

function validateCustomURL(value) {
  if (typeof settings.validateCustomAuthURL === "function") {
    const normalized = settings.validateCustomAuthURL(value);
    if (!normalized) throw new Error("请输入 HTTPS 认证端点");
    return normalized;
  }
  const parsed = urlUtil.parse(value);
  if (!parsed) throw new Error("认证端点不是有效 URL");
  if (parsed.protocol !== "https:") {
    throw new Error("认证端点必须使用 HTTPS");
  }
  if (!parsed.hostname || !/(^|\.)itunes\.apple\.com$/i.test(parsed.hostname)) {
    throw new Error("认证端点必须属于 itunes.apple.com");
  }
  if (parsed.username || parsed.password) {
    throw new Error("认证端点不能包含用户名或密码");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("认证端点只能使用标准 HTTPS 端口 443");
  }
  return parsed.toString();
}

function promptSapConfig() {
  const formID = "sap-config-form";
  const scrollID = "sap-config-scroll";
  const errorID = "sap-config-error";
  const urlID = "sap-url-input";
  const tokenID = "sap-token-input";

  // 按 JSBox scroll 文档设置内容容器，再让普通子视图使用明确的高度约束。
  function layoutForm(scroll) {
    const form = $(formID);
    if (!scroll || !form || !scroll.frame || scroll.frame.width <= 0) return;
    const width = Math.max(1, Math.min(560, scroll.frame.width - 32));
    const error = $(errorID);
    const text = error && !error.hidden ? String(error.text || "") : "";
    let errorHeight = 0;
    if (text) {
      errorHeight = Math.ceil(text.length * 13 / Math.max(1, width - 8)) * 18;
      try {
        const size = $text.sizeThatFits({ text, width: width - 8, font: $font(13) });
        if (size && Number.isFinite(size.height)) errorHeight = Math.ceil(size.height);
      } catch (_e) {}
      errorHeight = Math.max(20, errorHeight);
    }
    const saveTop = 238 + (text ? errorHeight + 12 : 0);
    const height = saveTop + 50 + 8 + 44;
    form.frame = $rect((scroll.frame.width - width) / 2, 16, width, height);
    if (error) error.frame = $rect(4, 238, width - 8, errorHeight);
    const saveButton = $("sap-config-save");
    const clearButton = $("sap-config-clear");
    if (saveButton) saveButton.frame = $rect(0, saveTop, width, 50);
    if (clearButton) clearButton.frame = $rect(0, saveTop + 58, width, 44);
    const size = scroll.contentSize || {};
    if (size.width !== scroll.frame.width || size.height !== height + 32) {
      scroll.contentSize = $size(scroll.frame.width, height + 32);
    }
  }

  function clearError() {
    const error = $(errorID);
    if (error) {
      error.text = "";
      error.hidden = true;
    }
    layoutForm($(scrollID));
  }

  function save() {
    const urlInput = $(urlID);
    const tokenInput = $(tokenID);
    if (!urlInput || !tokenInput) return;
    const url = String(urlInput.text || "").trim();
    const token = String(tokenInput.text || "").trim();
    try {
      settings.setSapConfig({ url, token });
      urlInput.blur();
      tokenInput.blur();
      $ui.pop();
      update();
      common.toast(url ? "已开启" : "已关闭");
    } catch (err) {
      const error = $(errorID);
      if (error) {
        error.text = err.message || "保存失败，请重试";
        error.hidden = false;
      }
      layoutForm($(scrollID));
      update();
    }
  }

  function field(id, placeholder, value, top, secure) {
    return {
      type: "input",
      props: common.fieldProps(placeholder, {
        id,
        text: value,
        type: secure ? $kbType.default : $kbType.url,
        secure,
        clearButtonMode: 1,
        accessibilityLabel: secure ? "API Token" : "服务地址",
        accessoryView: {
          type: "view",
          props: { height: 44, bgcolor: C.page },
          views: [{
            type: "button",
            props: { title: "完成", titleColor: C.blue, bgcolor: $color("clear"), font: $font("bold", 16) },
            layout: (make) => {
              make.right.inset(12);
              make.top.bottom.inset(0);
              make.width.equalTo(56);
            },
            events: { tapped: () => { const input = $(id); if (input) input.blur(); } },
          }],
        },
      }),
      layout: (make) => {
        make.left.right.inset(12);
        make.top.equalTo(top);
        make.height.equalTo(48);
      },
      events: {
        changed: clearError,
        returned: () => {
          if (secure) save();
          else { const next = $(tokenID); if (next) next.focus(); }
        },
      },
    };
  }

  $ui.push(common.page({
    props: common.pageProps({ title: "已购签名" }),
    events: {
      keyboardHeightChanged: (height) => {
        const scroll = $(scrollID);
        if (!scroll) return;
        const insets = $insets(0, 0, Math.max(0, Number(height) || 0), 0);
        scroll.contentInset = insets;
        scroll.indicatorInsets = insets;
        layoutForm(scroll);
      },
    },
    views: [
      {
        type: "scroll",
        props: {
          id: scrollID,
          bgcolor: C.page,
          keyboardDismissMode: 1,
          alwaysBounceVertical: true,
          showsHorizontalIndicator: false,
        },
        layout: (make, view) => make.edges.equalTo(view.super.safeArea),
        events: { layoutSubviews: layoutForm },
        views: [
          {
            type: "view",
            props: { id: formID },
            views: [
              {
                type: "view",
                props: { bgcolor: C.card, cornerRadius: 16, smoothCorners: true },
                layout: (make) => {
                  make.left.top.right.inset(0);
                  make.height.equalTo(196);
                },
                views: [
                  {
                    type: "label",
                    props: { text: "服务地址", font: $font(13), textColor: C.sub },
                    layout: (make) => {
                      make.left.right.inset(16);
                      make.top.equalTo(14);
                      make.height.equalTo(18);
                    },
                  },
                  field(urlID, "https://sap.example.com", settings.sapApiURL(), 40, false),
                  {
                    type: "label",
                    props: { text: "API Token", font: $font(13), textColor: C.sub },
                    layout: (make) => {
                      make.left.right.inset(16);
                      make.top.equalTo(106);
                      make.height.equalTo(18);
                    },
                  },
                  field(tokenID, "粘贴 API Token", settings.sapApiToken(), 132, true),
                ],
              },
              {
                type: "label",
                props: { text: "填写后启用，清空后关闭。", font: $font(13), textColor: C.sub, lines: 1 },
                layout: (make) => {
                  make.left.right.inset(4);
                  make.top.equalTo(208);
                  make.height.equalTo(18);
                },
              },
              {
                type: "label",
                props: { id: errorID, text: "", font: $font(13), textColor: C.red, lines: 0, hidden: true },
              },
              {
                type: "button",
                props: common.primaryButtonProps("保存", { id: "sap-config-save", cornerRadius: 14 }),
                events: { tapped: save },
              },
              {
                type: "button",
                props: { id: "sap-config-clear", title: "清空配置", titleColor: C.red, bgcolor: $color("clear"), font: $font(15) },
                events: {
                  tapped: () => {
                    const urlInput = $(urlID);
                    const tokenInput = $(tokenID);
                    if (!urlInput || !tokenInput) return;
                    urlInput.text = "";
                    tokenInput.text = "";
                    save();
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  }));
}

module.exports = {
  views,
  mount,
};
