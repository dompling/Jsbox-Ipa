const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, flush } = require("./helpers/ui");

// 登录遮罩（“正在准备登录 Apple ID…”）横跨登录页与两步验证页。历史上
// 收尾只隐藏“当前活跃页面”的那一个遮罩，2FA 分支里登录页的遮罩因此会
// 一直留在屏幕上；部分机型表现为停在“登录中”无法继续。这里锁定两页
// 遮罩都必须被收尾，并保证返回登录页时输入控件恢复可用。

function authMock(state) {
  class AuthenticationError extends Error {
    constructor(message, codeRequired) {
      super(message);
      this.name = "AuthenticationError";
      this.codeRequired = !!codeRequired;
    }
  }
  return {
    AuthenticationError,
    async authenticate(options) {
      state.authCalls += 1;
      state.lastOptions = options;
      if (state.handler) return state.handler(options, AuthenticationError);
      if (!options.code) throw new AuthenticationError("需要两步验证码", true);
      return accountFor(options);
    },
  };
}

function accountFor(options) {
  return {
    email: String(options.email || "").trim().toLowerCase(),
    store: "CN",
    storeFrontId: "143465",
    passwordToken: "token",
    directoryServicesIdentifier: "123",
    cookies: [],
    deviceIdentifier: options.deviceId,
  };
}

function harness(options = {}) {
  const state = { authCalls: 0, saved: [], activated: [], toasts: [], alerts: [], pops: 0, lastOptions: null, handler: options.handler };
  const auth = authMock(state);
  const accounts = {
    listAccounts: () => [],
    activeEmailForRegion: () => "",
    accountRegion: (value) => String((value && value.store) || "").toUpperCase(),
    normalizeEmail: (value) => String(value || "").trim().toLowerCase(),
    getAccount: () => null,
    saveAccount: (value) => { state.saved.push(value); return value; },
    activateAccount: (value) => { state.activated.push(value); },
    saveAutoLoginPassword: () => {},
    removeAutoLoginPassword: () => {},
    removeAccount: () => {},
    clearAccounts: () => {},
    storageIssues: () => [],
  };
  const common = {
    colors: {
      blue: "blue", green: "green", orange: "orange", purple: "purple", red: "red",
      gray: "gray", teal: "teal", page: "page", card: "card", field: "field",
      label: "label", sub: "sub", sep: "sep",
    },
    ICON_MENU_ESTIMATED_ROW_HEIGHT: 78,
    iconMenuTemplate: { views: [] },
    fieldProps: (placeholder, extra) => Object.assign({ placeholder }, extra || {}),
    primaryButtonProps: (title, extra) => Object.assign({ title }, extra || {}),
    listBaseProps: (extra) => Object.assign({ style: 1 }, extra || {}),
    menuSection: (title, rows) => ({ title, rows }),
    iconMenuRow: (title, subtitle, value, key) => ({ title, subtitle, value, _key: key }),
    rowKey: (row) => (row && row._key) || "",
    regionText: (code) => String(code || ""),
    page: (definition) => definition,
    pageProps: (extra) => Object.assign({}, extra || {}),
    toast: (message) => state.toasts.push(message),
    alert: (message) => state.alerts.push(message),
    alertError: (error) => state.alerts.push(error),
    menu: () => {},
  };
  const h = setup({
    "ui/common.js": common,
    "apple/auth.js": auth,
    "store/accounts.js": accounts,
    "store/settings.js": { region: () => "CN", effectiveAuthURLOverride: () => "" },
    "store/device.js": { getDeviceIdentifier: () => "001122334455" },
    "config.js": Object.assign({}, { COUNTRY_STORE_MAP: { CN: "143465" }, storeIdToCountry: () => "CN" }),
  });
  h.context.$device = { info: { screen: { width: 390, height: 844 } } };
  h.context.$ui.pop = () => { state.pops += 1; };
  h.state = state;
  return h;
}

function overlays(h, suffix) {
  return Array.from(h.nodes.values()).filter((node) => new RegExp(`-${suffix}-overlay$`).test(node.id || ""));
}

function loginOverlay(h) {
  const all = overlays(h, "login");
  assert.ok(all.length, "login page must render its progress overlay");
  return all.at(-1);
}

function verifyOverlay(h) {
  const all = overlays(h, "verify");
  assert.ok(all.length, "verify page must render its progress overlay");
  return all.at(-1);
}

function openLoginPage(h) {
  const page = h.load("ui/accounts.js");
  page.render();
  const list = h.nodes.get("account-list");
  list.definition.events.didSelect(null, null, { _key: "__add" });
}

async function submitLogin(h, email = "user@example.com", password = "secret") {
  h.nodes.get("email-input").text = email;
  h.nodes.get("password-input").text = password;
  const button = h.nodes.get("login-button");
  const result = button.definition.events.tapped(button);
  await flush();
  await flush();
  return result;
}

test("a two-factor login hides the login overlay before the verify page is dismissed", async () => {
  const h = harness();
  openLoginPage(h);
  assert.equal(loginOverlay(h).hidden, true, "the overlay starts hidden");

  await submitLogin(h);

  assert.equal(loginOverlay(h).hidden, true, "the login page overlay must be cleared during the 2FA hand-off");
  assert.equal(verifyOverlay(h).hidden, true, "the verify overlay must not be left showing");

  const loginButton = h.nodes.get("login-button");
  // 用户在验证页按返回：登录页必须恢复可交互，且不再有任何遮罩。
  const verifyPage = h.pages.at(-1);
  verifyPage.events.dealloc();
  assert.equal(loginOverlay(h).hidden, true, "backing out must not resurrect the login overlay");
  assert.equal(loginButton.enabled, true, "backing out must re-enable the login form");
  assert.equal(h.nodes.get("email-input").enabled, true);
  assert.equal(h.nodes.get("password-input").enabled, true);
});

test("a failed login hides the overlay and re-enables the form", async () => {
  const h = harness({
    handler: (_options, AuthenticationError) => {
      throw new AuthenticationError("Apple 认证服务暂不可用（HTTP 403）");
    },
  });
  openLoginPage(h);
  await submitLogin(h);

  assert.equal(loginOverlay(h).hidden, true, "a failed attempt must clear the overlay");
  assert.equal(h.nodes.get("login-button").enabled, true);
  assert.ok(h.state.alerts.length >= 1, "the failure must surface an error alert");
});

test("a successful login hides both overlays when leaving the verify page", async () => {
  const h = harness();
  openLoginPage(h);
  await submitLogin(h);

  // 第二步：输入验证码 -> 成功 -> 先退验证页再退登录页。
  const codeInput = h.nodes.get("code-input");
  assert.ok(codeInput, "the verify page must own the code input");
  codeInput.text = "123456";
  const verifyButton = h.nodes.get("verify-button");
  verifyButton.definition.events.tapped(verifyButton);
  await flush();
  await flush();

  assert.equal(verifyOverlay(h).hidden, true, "success must clear the verify overlay");
  assert.equal(loginOverlay(h).hidden, true, "success must clear the login overlay too");
  assert.equal(h.state.saved.length, 1, "the signed-in account must be persisted once");
  assert.deepEqual(h.state.activated, ["user@example.com"]);
});
