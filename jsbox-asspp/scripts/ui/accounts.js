// 账号管理页 + Apple ID 登录（App Store 风格）。
// 登录遵循两步式流程：
//   1) 先输入「账号 + 密码」点登录（不带验证码，attempt=1）
//   2) 仅当 Apple 返回“需要双重认证”时，才进入单独的「两步验证」页输入验证码
// 页面栈用明确的页面生命周期与“是否推入验证页”状态管理，避免异步退错栈。

const common = require("./common");
const config = require("../config");
const auth = require("../apple/auth");
const accountsStore = require("../store/accounts");
const settings = require("../store/settings");
const deviceStore = require("../store/device");

const C = common.colors;
let loginProgressSequence = 0;

function progressIds(prefix) {
  return {
    overlay: `${prefix}-overlay`,
    status: `${prefix}-status`,
    progress: `${prefix}-progress`,
  };
}

function loginProgressOverlay(ids) {
  return {
    type: "view",
    props: {
      id: ids.overlay,
      bgcolor: $color("clear"),
      hidden: true,
      clipsToBounds: false,
      userInteractionEnabled: true,
    },
    layout: $layout.fill,
    views: [{
      type: "view",
      props: {
        bgcolor: $color("black"),
        alpha: 0.08,
        cornerRadius: 16,
        smoothCorners: true,
        userInteractionEnabled: false,
      },
      layout: (make, view) => {
        make.centerX.equalTo(view.super);
        make.centerY.equalTo(view.super).offset(-3);
        make.size.equalTo($size(292, 136));
      },
    }, {
      type: "view",
      props: {
        bgcolor: C.card,
        cornerRadius: 16,
        smoothCorners: true,
        clipsToBounds: true,
      },
      layout: (make, view) => {
        make.center.equalTo(view.super);
        make.size.equalTo($size(292, 136));
      },
      views: [{
        type: "spinner",
        props: {
          id: `${ids.overlay}-spinner`,
          loading: true,
          style: 1,
          color: C.blue,
        },
        layout: (make, view) => {
          make.centerX.equalTo(view.super);
          make.top.inset(18);
          make.size.equalTo($size(24, 24));
        },
      }, {
        type: "label",
        props: {
          id: ids.status,
          text: "正在准备登录 Apple ID…",
          font: $font(14),
          textColor: C.label,
          align: $align.center,
          lines: 1,
        },
        layout: (make, view) => {
          make.left.right.inset(14);
          make.top.inset(51);
          make.height.equalTo(20);
        },
      }, {
        type: "progress",
        props: {
          id: ids.progress,
          value: 0,
          progressColor: C.blue,
          hidden: true,
        },
        layout: (make, view) => {
          make.left.right.inset(22);
          make.bottom.inset(20);
          make.height.equalTo(5);
        },
      }],
    }],
  };
}

// 表单统一「内容列」宽度：水平居中、左右对称（至少 20pt 边距），
// 大屏（iPad）下限定最大宽度，避免内容被拉得过宽。
function formColumnWidth() {
  const screenW = ($device.info && $device.info.screen && $device.info.screen.width) || 375;
  return Math.min(Math.max(screenW - 40, 260), 430);
}

// ---------- 账号列表 ----------

function buildRows() {
  const activeEmail = accountsStore.activeEmailForRegion(settings.region());
  const rows = accountsStore.listAccounts().map((acc) => {
    const region =
      typeof accountsStore.accountRegion === "function"
        ? accountsStore.accountRegion(acc)
        : String(acc.store || "").toUpperCase();
    const isActive = activeEmail === accountsStore.normalizeEmail(acc.email);
    const name = [acc.firstName, acc.lastName].filter(Boolean).join(" ");
    return common.iconMenuRow(
      acc.email,
      [region ? common.regionText(region) : "", name].filter(Boolean).join(" · "),
      isActive ? "当前" : "",
      acc.email,
      "person.crop.circle.fill",
      C.purple,
      isActive ? C.blue : undefined
    );
  });
  const issues = currentStorageIssues();
  if (issues.length) {
    rows.unshift(
      common.iconMenuRow(
        "登录信息需要修复",
        `检测到 ${issues.length} 个损坏的钥匙串会话，清理后请重新登录`,
        "处理",
        "__repair",
        "exclamationmark.triangle.fill",
        C.orange,
        C.orange
      )
    );
  }
  rows.push(
    common.iconMenuRow(
      "添加 Apple ID",
      "两步式登录：先账号密码，需要时再输入验证码",
      "",
      "__add",
      "plus.circle.fill",
      C.green
    )
  );
  rows.push(
    common.iconMenuRow(
      "清除全部账号",
      "删除本机保存的所有登录信息",
      "",
      "__clear",
      "trash.fill",
      C.red
    )
  );
  return rows;
}

function render() {
  const update = () => {
    const list = $("account-list");
    if (list) list.data = [common.menuSection("Apple ID", buildRows())];
  };

  const listView = {
    type: "list",
    props: common.listBaseProps({
      id: "account-list",
      data: [common.menuSection("Apple ID", buildRows())],
      template: common.iconMenuTemplate,
      autoRowHeight: true,
      estimatedRowHeight: common.ICON_MENU_ESTIMATED_ROW_HEIGHT,
    }),
    layout: $layout.fill,
    events: {
      didSelect: (sender, indexPath, row) => {
        const key = common.rowKey(row);
        if (key === "__add") {
          addAccountFlow(update);
        } else if (key === "__clear") {
          confirmClear(update);
        } else if (key === "__repair") {
          confirmRepair(update);
        } else if (key) {
          accountActions(key, update);
        }
      },
    },
  };

  $ui.push(common.page({
    props: common.pageProps({ title: "Apple ID 账号" }),
    views: [listView],
    events: {
      // 账号页关闭后，重新同步背后的设置页，确保区域和当前账号展示最新。
      disappeared: refreshSettingsView,
    },
  }));
}

function currentStorageIssues() {
  if (typeof accountsStore.storageIssues !== "function") return [];
  try {
    return accountsStore.storageIssues() || [];
  } catch (_e) {
    return [];
  }
}

function refreshSettingsView() {
  // 账号页通常是从设置页 push 出来的；设置页本身没有重新 mount，
  // 所以区域/当前账号变化后主动刷新其已存在的列表。
  try {
    const settingsView = require("./settings");
    if (settingsView && typeof settingsView.mount === "function") {
      settingsView.mount();
    }
  } catch (_e) {}
}

function confirmRepair(update) {
  const issues = currentStorageIssues();
  if (!issues.length) {
    common.toast("未发现需要修复的登录信息");
    update();
    return;
  }
  common.alert({
    title: "清理损坏的登录信息",
    message:
      "这些会话已无法读取，继续保留也不能用于下载。清理后需要重新登录对应 Apple ID。",
    actions: [
      {
        title: `清理 ${issues.length} 项`,
        style: $alertActionType.destructive,
        handler: () => {
          try {
            issues.forEach((issue) => accountsStore.removeAccount(issue.email));
            common.toast("已清理，请重新登录");
            refreshSettingsView();
            update();
          } catch (err) {
            common.alertError(err);
            update();
          }
        },
      },
      { title: "取消" },
    ],
  });
}

function accountActions(email, update) {
  const account = accountsStore.getAccount(email);
  const accountRegion =
    account && typeof accountsStore.accountRegion === "function"
      ? accountsStore.accountRegion(account)
      : account && String(account.store || "").toUpperCase();
  const canActivate = !!(accountRegion && config.COUNTRY_STORE_MAP[accountRegion]);
  const items = canActivate
    ? [`切换到 ${common.regionText(accountRegion)} 并使用此账号`, "删除该账号"]
    : ["删除该账号"];
  common.menu({
    items,
    handler: (title, idx) => {
      try {
        if (canActivate && idx === 0) {
          accountsStore.activateAccount(email);
          common.toast(`已切换到 ${common.regionText(accountRegion)}`);
          refreshSettingsView();
          update();
        } else {
          confirmRemoveAccount(email, update);
        }
      } catch (err) {
        common.alertError(err);
      }
    },
  });
}

function confirmRemoveAccount(email, update) {
  common.alert({
    title: "删除这个账号？",
    message: `${email}\n\n将删除本机保存的会话与区域绑定，需要重新登录才能再次下载。`,
    actions: [
      {
        title: "删除",
        style: $alertActionType.destructive,
        handler: () => {
          try {
            accountsStore.removeAccount(email);
            common.toast("已删除");
            refreshSettingsView();
            update();
          } catch (err) {
            common.alertError(err);
          }
        },
      },
      { title: "取消" },
    ],
  });
}

function confirmClear(update) {
  common.alert({
    title: "清除全部账号",
    message: "将删除所有已保存的 Apple ID 会话、Cookie 与区域绑定。登录密码本身不会被持久化。",
    actions: [
      {
        title: "确认清除",
        style: $alertActionType.destructive,
        handler: () => {
          try {
            if (typeof accountsStore.clearAccounts === "function") {
              accountsStore.clearAccounts();
            } else {
              for (const acc of accountsStore.listAccounts()) {
                accountsStore.removeAccount(acc.email);
              }
            }
            common.toast("已清除");
            refreshSettingsView();
            update();
          } catch (err) {
            common.alertError(err);
          }
        },
      },
      { title: "取消" },
    ],
  });
}

// ---------- 登录：第一步 账号 + 密码 ----------

function addAccountFlow(onSaved) {
  const progressPrefix = `login-progress-${++loginProgressSequence}`;
  const flow = {
    email: "",
    password: "",
    code: "",
    remember: true,
    done: onSaved,
    busy: false,
    finished: false,
    loginPageAlive: true,
    verifyPageAlive: false,
    verifyPushed: false,
    verifyVisible: false,
    loginProgressIds: progressIds(`${progressPrefix}-login`),
    verifyProgressIds: progressIds(`${progressPrefix}-verify`),
  };

  async function submit(sender) {
    if (flow.busy || flow.finished) return;
    const text = (id) => {
      const v = $(id);
      return v ? String(v.text || "") : "";
    };
    flow.email = text("email-input").trim();
    flow.password = text("password-input");
    const rememberView = $("remember-password");
    flow.remember = !!(rememberView && rememberView.on);
    if (!flow.email || !flow.password) {
      common.alert("请输入邮箱与密码");
      return;
    }
    setLoginBusy(flow, true);
    showLoginProgress(flow, {
      stage: "login",
      message: "正在准备登录 Apple ID…",
    });
    try {
      const account = await authenticateWithCode(flow);
      finishLogin(account, flow);
    } catch (err) {
      if (err instanceof auth.AuthenticationError && err.codeRequired) {
        setLoginBusy(flow, false);
        showVerifyStep(flow); // Apple 要求双重认证 -> 第二步
      } else {
        common.alertError(err);
      }
    } finally {
      if (!flow.finished && !flow.verifyPageAlive) setLoginBusy(flow, false);
      hideLoginProgress(flow);
    }
  }

  // ---------- 登录表单（统一居中列：标题 / 说明 / 输入卡片 / 按钮同宽同边距） ----------
  const W = formColumnWidth();
  function colW(top, height) {
    return (make, view) => {
      make.centerX.equalTo(view.super);
      make.top.equalTo(top);
      make.width.equalTo(W);
      if (height) make.height.equalTo(height);
    };
  }

  const appleMark = {
    type: "image",
    props: { symbol: "applelogo", tintColor: C.label },
    layout: (make, view) => {
      make.centerX.equalTo(view.super);
      make.top.equalTo(48);
      make.size.equalTo($size(44, 44));
    },
  };

  const titleLabel = {
    type: "label",
    props: {
      text: "登录 Apple ID",
      font: $font("bold", 26),
      textColor: C.label,
      align: $align.center,
      lines: 1,
    },
    layout: colW(108, 34),
  };

  const subtitleLabel = {
    type: "label",
    props: {
      text: `登录后自动使用该 Apple ID 所属区域的 App Store。\n建议使用次要 Apple ID。`,
      font: $font(14),
      textColor: C.sub,
      align: $align.center,
      lines: 0,
    },
    layout: colW(150, 44),
  };

  const card = {
    type: "view",
    props: {
      id: "login-card",
      bgcolor: C.card,
      cornerRadius: 16,
      smoothCorners: true,
    },
    layout: colW(210, 150),
    views: [
      {
        type: "input",
        props: common.fieldProps("Apple ID 邮箱", {
          id: "email-input",
          type: $kbType.email,
          bgcolor: $color("clear"),
          cornerRadius: 0,
          smoothCorners: false,
          clearButtonMode: 1,
          autocorrectionType: 0,
          autocapitalizationType: 0,
          textColor: C.label,
          accessibilityLabel: "Apple ID 邮箱",
        }),
        layout: (make) => {
          make.left.right.inset(14);
          make.top.equalTo(0);
          make.height.equalTo(49);
        },
        events: {
          returned: (sender) => {
            const pwd = $("password-input");
            if (pwd) pwd.focus();
          },
        },
      },
      {
        type: "view",
        props: { bgcolor: C.sep },
        layout: (make) => {
          make.left.inset(14);
          make.right.inset(14);
          make.top.equalTo(49);
          make.height.equalTo(0.5);
        },
      },
      {
        type: "input",
        props: common.fieldProps("密码", {
          id: "password-input",
          secure: true,
          bgcolor: $color("clear"),
          cornerRadius: 0,
          smoothCorners: false,
          autocorrectionType: 0,
          autocapitalizationType: 0,
          textColor: C.label,
          accessibilityLabel: "Apple ID 密码",
        }),
        layout: (make) => {
          make.left.right.inset(14);
          make.top.equalTo(49.5);
          make.height.equalTo(50);
        },
        events: {
          returned: (sender) => {
            sender.blur();
            submit(sender);
          },
        },
      },
      {
        type: "view",
        props: { bgcolor: C.sep },
        layout: (make) => {
          make.left.inset(14);
          make.right.inset(14);
          make.top.equalTo(99.5);
          make.height.equalTo(0.5);
        },
      },
      {
        type: "view",
        props: { bgcolor: $color("clear") },
        layout: (make) => {
          make.left.right.equalTo(0);
          make.top.equalTo(100);
          make.height.equalTo(50);
        },
        views: [
          {
            type: "label",
            props: {
              text: "记住密码，失效时自动重新登录",
              font: $font(12),
              textColor: C.label,
              lines: 1,
              accessibilityLabel: "记住密码，失效时自动重新登录",
            },
            layout: (make, view) => {
              make.left.inset(16);
              make.centerY.equalTo(view.super);
              make.right.inset(96);
            },
          },
          {
            type: "switch",
            props: {
              id: "remember-password",
              on: true,
              accessibilityLabel: "记住密码，失效时自动重新登录",
            },
            layout: (make, view) => {
              make.right.inset(14);
              make.centerY.equalTo(view.super);
            },
          },
        ],
      },
    ],
  };

  const loginButton = {
    type: "button",
    props: common.primaryButtonProps("登录", { id: "login-button" }),
    layout: (make, view) => {
      make.centerX.equalTo(view.super);
      make.top.equalTo($("login-card").bottom).offset(22);
      make.width.equalTo(W);
      make.height.equalTo(50);
    },
    events: {
      tapped: submit,
    },
  };

  const footnote = {
    type: "label",
    props: {
      text:
        "开启双重认证的账号，点击登录后若 Apple 要求，\n" +
        "将进入「两步验证」页输入验证码。\n" +
        "登录信息仅保存在本机钥匙串。",
      font: $font(12),
      textColor: C.sub,
      lines: 0,
      align: $align.center,
    },
    layout: (make, view) => {
      make.centerX.equalTo(view.super);
      make.top.equalTo($("login-button").bottom).offset(18);
      make.width.equalTo(W);
      make.height.equalTo(64);
    },
  };

  $ui.push(common.page({
    props: common.pageProps({ title: "登录" }),
    events: {
      dealloc: () => {
        flow.loginPageAlive = false;
        clearSecrets(flow);
      },
    },
    views: [
      {
        type: "scroll",
        props: { bgcolor: C.page, keyboardDismissMode: 1 },
        layout: $layout.fill,
        views: [
          appleMark,
          titleLabel,
          subtitleLabel,
          card,
          loginButton,
          footnote,
        ],
      },
      loginProgressOverlay(flow.loginProgressIds),
    ],
  }));
}

// ---------- 登录：第二步 两步验证 ----------

function showVerifyStep(flow) {
  if (flow.finished || flow.verifyPageAlive || !flow.loginPageAlive) return;
  flow.verifyPushed = true;
  flow.verifyPageAlive = true;
  const W = formColumnWidth();
  function colW(top, height) {
    return (make, view) => {
      make.centerX.equalTo(view.super);
      make.top.equalTo(top);
      make.width.equalTo(W);
      if (height) make.height.equalTo(height);
    };
  }

  const codeCard = {
    type: "view",
    props: {
      id: "code-card",
      bgcolor: C.card,
      cornerRadius: 16,
      smoothCorners: true,
    },
    layout: colW(232, 62),
    views: [
      {
        type: "input",
        props: common.fieldProps("6 位验证码", {
          id: "code-input",
          type: $kbType.number,
          align: $align.center,
          font: $font("bold", 22),
          textColor: C.label,
          bgcolor: $color("clear"),
          cornerRadius: 0,
          smoothCorners: false,
          accessibilityLabel: "六位验证码",
        }),
        layout: (make) => {
          make.left.right.top.bottom.equalTo(0);
        },
        events: {
          returned: (sender) => {
            sender.blur();
            verify(sender);
          },
        },
      },
    ],
  };

  $ui.push(common.page({
    props: common.pageProps({ title: "两步验证" }),
    events: {
      appeared: () => {
        flow.verifyVisible = true;
        $delay(0.35, () => {
          const input = $ui.get("code-input");
          if (input && flow.verifyVisible) input.focus();
        });
      },
      disappeared: () => {
        flow.verifyVisible = false;
      },
      dealloc: () => {
        flow.verifyVisible = false;
        flow.verifyPageAlive = false;
        flow.verifyPushed = false;
        flow.code = "";
        // 用户从验证页返回时登录尚未完成：必须在登录页上恢复可交互并清掉
        // 残留遮罩，否则第一步的“正在准备登录 Apple ID…”弹窗会一直盖住
        // 表单，按钮也保持禁用，表现为卡在“登录中”。
        if (!flow.finished) {
          setLoginBusy(flow, false);
          hideLoginProgress(flow);
        }
      },
    },
    views: [
      {
        type: "scroll",
        props: { bgcolor: C.page, keyboardDismissMode: 1 },
        layout: $layout.fill,
        views: [
          {
            type: "view",
            props: {
              bgcolor: C.blue,
              cornerRadius: 20,
              smoothCorners: true,
            },
            layout: (make, view) => {
              make.centerX.equalTo(view.super);
              make.top.equalTo(48);
              make.size.equalTo($size(64, 64));
            },
            views: [
              {
                type: "image",
                props: {
                  symbol: "lock.shield.fill",
                  tintColor: $color("white"),
                },
                layout: (make, view) => {
                  make.center.equalTo(view.super);
                  make.size.equalTo($size(34, 34));
                },
              },
            ],
          },
          {
            type: "label",
            props: {
              text: "验证你的 Apple ID",
              font: $font("bold", 24),
              textColor: C.label,
              align: $align.center,
              lines: 1,
            },
            layout: colW(134, 32),
          },
          {
            type: "label",
            props: {
              text: "输入发送到你受信任设备的 6 位验证码",
              font: $font(14),
              textColor: C.sub,
              align: $align.center,
              lines: 0,
            },
            layout: colW(178, 40),
          },
          codeCard,
          {
            type: "button",
            props: common.primaryButtonProps("验证并登录", { id: "verify-button" }),
            layout: (make, view) => {
              make.centerX.equalTo(view.super);
              make.top.equalTo($("code-card").bottom).offset(22);
              make.width.equalTo(W);
              make.height.equalTo(50);
            },
            events: {
              tapped: verify,
            },
          },
          {
            type: "label",
            props: {
              text:
                "验证码错误可在本页重新输入。若收不到验证码，请确认受信任设备上的双重认证提醒。",
              font: $font(12),
              textColor: C.sub,
              align: $align.center,
              lines: 0,
            },
            layout: (make, view) => {
              make.centerX.equalTo(view.super);
              make.top.equalTo($("verify-button").bottom).offset(16);
              make.width.equalTo(W);
              make.height.equalTo(48);
            },
          },
        ],
      },
      loginProgressOverlay(flow.verifyProgressIds),
    ],
  }));

  async function verify(sender) {
    if (flow.busy || flow.finished) return;
    const input = $ui.get("code-input");
    const code = String(input ? input.text : "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      common.alert("请输入 6 位验证码");
      return;
    }
    setVerifyBusy(flow, true);
    showLoginProgress(flow, {
      stage: "login",
      message: "正在登录 Apple ID…",
    });
    try {
      flow.code = code;
      const account = await authenticateWithCode(flow);
      finishLogin(account, flow);
    } catch (err) {
      if (err instanceof auth.AuthenticationError && err.codeRequired) {
        flow.code = "";
        if (input) {
          input.text = "";
          input.focus();
        }
        common.alert("验证码不正确，请重新输入");
      } else {
        common.alertError(err);
      }
    } finally {
      if (!flow.finished) setVerifyBusy(flow, false);
      hideLoginProgress(flow);
    }
  }
}

// ---------- 认证与收尾 ----------

function authOptions(email, password, code, flow) {
  const existing = accountsStore.getAccount(email);
  // 旧版账号记录可能没有设备标识；缺失时复用全局稳定 GUID，避免登录
  // 因迁移记录不完整而直接失败，也不要为同一设备随机生成新标识。
  const deviceId =
    (existing && existing.deviceIdentifier) || deviceStore.getDeviceIdentifier();
  return {
    email,
    password,
    code: code || undefined,
    deviceId,
    existingCookies: existing ? existing.cookies : [],
    authURLOverride: settings.effectiveAuthURLOverride(),
    // 与 IPA-Tool-3.0 scripting 版一致：优先使用带 SAP 签名的固定 pod
    // 入口，失败后再回退 bag/native 与 legacy。
    preferScriptingEndpoint: true,
    onProgress: flow ? (state) => updateSapProgress(flow, state) : undefined,
  };
}

async function authenticateWithCode(flow) {
  return await auth.authenticate(
    authOptions(flow.email, flow.password, flow.code, flow)
  );
}

function finishLogin(account, flow) {
  if (flow.finished) return;
  // 「记住密码」：密码只写进独立 Keychain 键，用于会话失效时无感自动重登。
  // 保存失败不应阻断登录——退化为不开启自动重登，避免出现“标记开启却无
  // 密码可用”的无效状态。
  if (flow.remember) {
    try {
      accountsStore.saveAutoLoginPassword(account.email, flow.password);
      account.autoRelogin = true;
    } catch (_e) {
      account.autoRelogin = false;
    }
  } else {
    accountsStore.removeAutoLoginPassword(account.email);
    account.autoRelogin = false;
  }
  accountsStore.saveAccount(account);
  // Apple 返回的 storefront 才是账号真实所属区域。不要使用登录页打开时
  // 的 flow.region 覆盖它，否则在 CN 页面登录 US Apple ID 会被错误拒绝。
  accountsStore.activateAccount(account.email);
  refreshSettingsView();
  flow.finished = true;
  setLoginBusy(flow, true);
  setVerifyBusy(flow, true);
  clearSecrets(flow);
  common.toast("登录成功");
  if (flow.done) flow.done();

  // 验证页成功时先退验证页，动画完成后再退登录页；不再用 appeared 状态猜栈深。
  if (flow.verifyPushed && flow.verifyPageAlive) {
    $ui.pop();
    $delay(0.35, () => {
      if (flow.loginPageAlive) $ui.pop();
    });
  } else if (flow.loginPageAlive) {
    $ui.pop();
  }
}

function setEnabled(ids, enabled) {
  ids.forEach((id) => {
    try {
      const view = $ui.get(id);
      if (view) view.enabled = enabled;
    } catch (_e) {}
  });
}

function setLoginBusy(flow, busy) {
  flow.busy = !!busy;
  setEnabled(["email-input", "password-input", "login-button"], !busy);
}

function setVerifyBusy(flow, busy) {
  flow.busy = !!busy;
  setEnabled(["code-input", "verify-button"], !busy);
}

function activeProgressIds(flow) {
  return flow && flow.verifyPageAlive ? flow.verifyProgressIds : flow && flow.loginProgressIds;
}

// 登录/验证流程可能先后横跨两张页面，每张页面各有一个进度遮罩。
// 收尾时必须按页面各自隐藏，不能只隐藏“当前活跃页面”的那一个，否则
// 2FA 分支里尚未退栈的登录页会一直留着“正在准备登录 Apple ID…”的弹窗。
function allProgressIds(flow) {
  if (!flow) return [];
  return [flow.loginProgressIds, flow.verifyProgressIds].filter(Boolean);
}

function showLoginProgress(flow, state) {
  if (!flow || flow.finished || !state) return;
  try {
    const ids = activeProgressIds(flow);
    const overlay = ids && $ui.get(ids.overlay);
    const status = ids && $ui.get(ids.status);
    const progress = ids && $ui.get(ids.progress);
    if (!overlay || !status || !progress) return;
    overlay.hidden = false;
    status.text = String(state.message || "正在处理 Apple ID 登录…");
    const downloading = state.stage === "download";
    progress.hidden = !downloading;
    progress.value = typeof state.progress === "number" && Number.isFinite(state.progress)
      ? Math.max(0, Math.min(1, state.progress))
      : 0;
  } catch (_e) {}
}

function updateSapProgress(flow, state) {
  showLoginProgress(flow, state);
}

// 无论本次登录发起自哪一步、最终成功还是失败，都同时隐藏登录页与验证页
// 的遮罩。页面已 dealloc 时 $ui.get 返回 null，忽略即可。
function hideLoginProgress(flow) {
  if (!flow) return;
  for (const ids of allProgressIds(flow)) {
    try {
      const overlay = $ui.get(ids.overlay);
      if (overlay) overlay.hidden = true;
    } catch (_e) {}
  }
}

function clearSecrets(flow) {
  flow.email = "";
  flow.password = "";
  flow.code = "";
  ["email-input", "password-input", "code-input"].forEach((id) => {
    try {
      const input = $ui.get(id);
      if (input) input.text = "";
    } catch (_e) {}
  });
}

module.exports = {
  render,
};
