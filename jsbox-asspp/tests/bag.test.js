const { test } = require("node:test");
const assert = require("node:assert");

const http = require("../scripts/lib/http");
const bag = require("../scripts/apple/bag");
const auth = require("../scripts/apple/auth");
const config = require("../scripts/config");
const plist = require("../scripts/lib/plist");

const GUID = "001122334455AABBCCDDEEFF";

function wrappedBag(innerPlist) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<Document xmlns="http://www.apple.com/itms/">\n' +
    "<Protocol>\n" +
    innerPlist +
    "</Protocol>\n" +
    "</Document>\n"
  );
}

function stubSend(body) {
  const original = http.send;
  http.send = async () => ({
    failed: false,
    status: 200,
    body,
    headers: {},
  });
  return () => {
    http.send = original;
  };
}

test("extractPlist 能剥离真实 bag 的 Document/Protocol 包裹层", () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>accountSummary</key><string>https://buy.itunes.apple.com/x</string></dict></plist>'
  );
  const extracted = bag.extractPlist(sample);
  assert.ok(extracted.startsWith('<plist version="1.0">'));
  assert.ok(extracted.endsWith("</plist>"));
  // 裸 plist 原样返回
  const bare = '<plist version="1.0"><dict/></plist>';
  assert.strictEqual(bag.extractPlist(bare), bare);
});

test("真实 bag（无 authenticateAccount）回退到默认 native/fast 端点", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>urlBag</key><dict><key>accountSummary</key><string>https://buy.itunes.apple.com/x</string></dict></dict></plist>'
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(
      out.authURL,
      config.ENDPOINTS.defaultAuthURL(GUID)
    );
    assert.match(out.authURL, /\/auth\/v1\/native\/fast\//);
  } finally {
    restore();
  }
});

test("bag 内层 urlBag.authenticateAccount 可被解析并归一化", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>urlBag</key><dict><key>authenticateAccount</key><string>https://auth.itunes.apple.com/auth/v1/native</string></dict></dict></plist>'
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(
      out.authURL,
      "https://auth.itunes.apple.com/auth/v1/native/fast/"
    );
  } finally {
    restore();
  }
});

test("bag 根级 authenticateAccount（新格式）可被解析", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>authenticateAccount</key><string>https://auth.itunes.apple.com/auth/v1/native</string></dict></plist>'
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(
      out.authURL,
      "https://auth.itunes.apple.com/auth/v1/native/fast/"
    );
  } finally {
    restore();
  }
});

test("bag 返回 HTML 错误页时回退默认端点而不是抛出“不是有效 URL”", async () => {
  const restore = stubSend("<!DOCTYPE html><html><body>upstream down</body></html>");
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(out.authURL, config.ENDPOINTS.defaultAuthURL(GUID));
  } finally {
    restore();
  }
});

test("bag 网络异常时回退默认端点", async () => {
  const original = http.send;
  http.send = async () => {
    throw new Error("network down");
  };
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(out.authURL, config.ENDPOINTS.defaultAuthURL(GUID));
  } finally {
    http.send = original;
  }
});

test("failureType 5005 被识别为验证码错误（codeRequired）", async () => {
  const original = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async () => ({
    status: 200,
    finalUrl: "https://auth.itunes.apple.com/auth/v1/native/fast/",
    headers: { "x-set-apple-store-front": "143465-1,29" },
    body: plist.buildPlist({ failureType: "5005" }),
  });
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        code: "123456",
        deviceId: GUID,
        authURLOverride: "https://auth.itunes.apple.com/auth/v1/native/fast/",
      }),
      (err) => err instanceof auth.AuthenticationError && err.codeRequired === true
    );
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("bag 内层 urlBag 提供 SAP setup/cert/version 时被解析出来", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>urlBag</key><dict>' +
      '<key>sign-sap-setup</key><string>https://fpinit.itunes.apple.com/v1/signSapSetup/legacy</string>' +
      '<key>sign-sap-setup-cert</key><string>https://s.mzstatic.com/sap/setupCert.plist</string>' +
      "<key>sign-sap-version</key><string>200</string>" +
      "</dict></dict></plist>"
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(
      out.sapSetupURL,
      "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy"
    );
    assert.strictEqual(out.sapCertURL, "https://s.mzstatic.com/sap/setupCert.plist");
  } finally {
    restore();
  }
});

test("没有 authenticateAccount 时 SAP 端点仍会被带出（已购只依赖 SAP 字段）", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>urlBag</key><dict>' +
      '<key>sign-sap-setup</key><string>https://fpinit.itunes.apple.com/v1/signSapSetup/legacy</string>' +
      '<key>sign-sap-setup-cert</key><string>https://s.mzstatic.com/sap/setupCert.plist</string>' +
      "</dict></dict></plist>"
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchSAPConfig(GUID);
    assert.strictEqual(out.sapSetupURL, "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy");
    assert.strictEqual(out.sapCertURL, "https://s.mzstatic.com/sap/setupCert.plist");
  } finally {
    restore();
  }
});

test("非 legacy 版本或非法端点的 SAP 配置会被拒绝（回退内置默认）", () => {
  const parsed = {
    urlBag: {
      "sign-sap-setup": "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
      "sign-sap-setup-cert": "https://s.mzstatic.com/sap/setupCert.plist",
      "sign-sap-version": "300",
    },
  };
  assert.deepStrictEqual(bag.sapConfigResult(bag.parseSAPConfig(parsed)), {
    sapSetupURL: "",
    sapCertURL: "",
  });
  assert.deepStrictEqual(
    bag.sapConfigResult(
      bag.parseSAPConfig({
        urlBag: {
          "sign-sap-setup": "https://evil.example/sap",
          "sign-sap-setup-cert": "https://s.mzstatic.com/sap/setupCert.plist",
          "sign-sap-version": "200",
        },
      })
    ),
    { sapSetupURL: "", sapCertURL: "" }
  );
});

test("normalizeAuthURL keeps query string after appending /fast", () => {
  assert.strictEqual(
    bag.normalizeAuthURL(
      "https://auth.itunes.apple.com/auth/v1/native?x=1#frag"
    ),
    "https://auth.itunes.apple.com/auth/v1/native/fast/?x=1"
  );
  // 非 auth 主机原样返回（legacy 等）
  assert.strictEqual(
    bag.normalizeAuthURL("https://buy.itunes.apple.com/wa/authenticate?x=1"),
    "https://buy.itunes.apple.com/wa/authenticate?x=1"
  );
});

test("fetchBag 发现到不可校验端点时回退默认端点而不是抛出", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>authenticateAccount</key><string>https://evil.example/auth</string></dict></plist>'
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(out.authURL, config.ENDPOINTS.defaultAuthURL(GUID));
  } finally {
    restore();
  }
});

test("fetchBag 发现到非字符串端点（畸形 plist）时同样回退", async () => {
  const sample = wrappedBag(
    '<plist version="1.0"><dict><key>authenticateAccount</key><dict><key>nested</key><string>x</string></dict></dict></plist>'
  );
  const restore = stubSend(sample);
  try {
    const out = await bag.fetchBag(GUID);
    assert.strictEqual(out.authURL, config.ENDPOINTS.defaultAuthURL(GUID));
  } finally {
    restore();
  }
});
