const { test } = require("node:test");
const assert = require("node:assert");

const http = require("../scripts/lib/http");
const auth = require("../scripts/apple/auth");
const bag = require("../scripts/apple/bag");
const plist = require("../scripts/lib/plist");

test("authentication rejects an unsafe initial endpoint before sending credentials", async () => {
  const original = http.sendWithRedirectRecovery;
  let requests = 0;
  http.sendWithRedirectRecovery = async () => {
    requests++;
    throw new Error("should not be reached");
  };
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        authURLOverride: "http://evil.example/collect",
      }),
      /认证端点/
    );
    assert.strictEqual(requests, 0);
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("bag authentication endpoint normalization rejects non-Apple and custom-port URLs", () => {
  assert.strictEqual(bag.normalizeAuthURL("https://evil.example/auth"), "");
  assert.strictEqual(
    bag.normalizeAuthURL("https://auth.itunes.apple.com:444/auth"),
    ""
  );
  assert.match(
    bag.normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native"),
    /\/fast\/$/
  );
});

test("successful authentication does not return the plaintext password", async () => {
  const original = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async () => ({
    status: 200,
    finalUrl: "https://auth.itunes.apple.com/auth/v1/native/fast/",
    headers: { "x-set-apple-store-front": "143441-1,29" },
    body: plist.buildPlist({
      accountInfo: {
        appleId: "user@example.com",
        address: { firstName: "Test", lastName: "User" },
      },
      passwordToken: "token",
      dsPersonId: "123",
    }),
  });
  try {
    const account = await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      deviceId: "001122334455",
      authURLOverride: "https://auth.itunes.apple.com/auth/v1/native/fast/",
    });
    assert.strictEqual(Object.hasOwn(account, "password"), false);
    assert.strictEqual(account.passwordToken, "token");
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("scripting-compatible authentication signs the exact attempt=1 form plist body", async () => {
  const original = http.sendWithRedirectRecovery;
  let captured;
  http.sendWithRedirectRecovery = async (options) => {
    captured = options;
    return {
      status: 200,
      finalUrl: options.url,
      headers: { "x-set-apple-store-front": "143465-1,29" },
      body: plist.buildPlist({
        accountInfo: {
          appleId: "user@example.com",
          address: { firstName: "Test", lastName: "User" },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    };
  };
  try {
    const account = await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      code: "123 456",
      deviceId: "001122334455",
      authURLOverride: "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      sapSignature: "signed-body",
    });
    assert.strictEqual(account.directoryServicesIdentifier, "123");
    assert.strictEqual(captured.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.strictEqual(captured.headers["x-apple-actionsignature"], "signed-body");
    assert.match(captured.body, /<key>attempt<\/key><string>1<\/string>/);
    assert.match(captured.body, /<key>password<\/key><string>secret123456<\/string>/);
    assert.doesNotMatch(captured.body, /<key>attempt<\/key><integer>/);
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("scripting endpoint mode starts at p37 without putting the GUID in its URL", async () => {
  const original = http.sendWithRedirectRecovery;
  let target = "";
  http.sendWithRedirectRecovery = async (options) => {
    target = options.url;
    return {
      status: 200,
      finalUrl: options.url,
      headers: { "x-set-apple-store-front": "143465-1,29" },
      body: plist.buildPlist({
        accountInfo: { appleId: "user@example.com", address: {} },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    };
  };
  try {
    await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      deviceId: "001122334455",
      preferScriptingEndpoint: true,
      sapSignature: "signed",
    });
    assert.strictEqual(
      target,
      "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate"
    );
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("authentication stores the validated complete storefront header and normalized pod", async () => {
  const original = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async (options) => ({
    status: 200,
    finalUrl: options.url,
    headers: {
      "x-set-apple-store-front": "143465-1,29",
      pod: "p42",
    },
    body: plist.buildPlist({
      accountInfo: { appleId: "user@example.com", address: {} },
      passwordToken: "token",
      dsPersonId: "123",
    }),
  });
  try {
    const account = await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      deviceId: "001122334455",
      authURLOverride: "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      sapSignature: "signed",
    });
    assert.strictEqual(account.storeFrontId, "143465");
    assert.strictEqual(account.storeFrontHeader, "143465-1,29");
    assert.strictEqual(account.pod, "42");
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("authentication rejects a successful-looking response without storefront", async () => {
  const original = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async (options) => ({
    status: 200,
    finalUrl: options.url,
    headers: {},
    body: plist.buildPlist({
      accountInfo: { appleId: "user@example.com", address: {} },
      passwordToken: "token",
      dsPersonId: "123",
    }),
  });
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        authURLOverride: "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
        retryDelays: [0],
        sapSignature: "signed",
      }),
      (err) =>
        err instanceof auth.AuthenticationError &&
        /缺少商店区域/.test(err.message)
    );
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("redirect location resolution preserves relative pod paths and rejects non-http schemes", () => {
  assert.strictEqual(
    auth.resolveRedirectLocation(
      "../authenticate?x=1",
      "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/start"
    ),
    "https://p37-buy.itunes.apple.com/WebObjects/MZFinance.woa/authenticate?x=1"
  );
  assert.strictEqual(
    auth.resolveRedirectLocation("javascript:alert(1)", "https://p37-buy.itunes.apple.com/a"),
    ""
  );
});

test("successful-looking plist without passwordToken or dsPersonId is rejected", async () => {
  const original = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async (options) => ({
    status: 200,
    finalUrl: options.url,
    headers: {},
    body: plist.buildPlist({
      accountInfo: {
        appleId: "user@example.com",
        address: { firstName: "Test", lastName: "User" },
      },
    }),
  });
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        authURLOverride: "https://auth.itunes.apple.com/auth/v1/native/fast/",
      }),
      /缺少会话令牌/
    );
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("bag discovery returning an invalid endpoint falls back to default native/fast URL", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  const originalFetchBag = bag.fetchBag;
  let firstTarget = "";
  http.sendWithRedirectRecovery = async (options) => {
    if (!firstTarget) firstTarget = options.url;
    return { status: 200, finalUrl: "", headers: {}, body: "<html>upstream</html>" };
  };
  bag.fetchBag = async () => ({ authURL: "https://evil.example/auth" });
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        retryDelays: [1, 1, 1, 1, 1],
      }),
      /Apple 认证服务暂不可用/
    );
    assert.match(
      firstTarget,
      /^https:\/\/auth\.itunes\.apple\.com\/auth\/v1\/native\/fast\/\?guid=001122334455$/
    );
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
    bag.fetchBag = originalFetchBag;
  }
});

test("bag discovery throwing still authenticates against the default endpoint", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  const originalFetchBag = bag.fetchBag;
  let firstTarget = "";
  http.sendWithRedirectRecovery = async (options) => {
    if (!firstTarget) firstTarget = options.url;
    return { status: 200, finalUrl: "", headers: {}, body: "<html>upstream</html>" };
  };
  bag.fetchBag = async () => {
    throw new Error("network down");
  };
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        retryDelays: [1, 1, 1, 1, 1],
      }),
      /Apple 认证服务暂不可用/
    );
    assert.match(firstTarget, /^https:\/\/auth\.itunes\.apple\.com\/auth\/v1\/native\/fast\//);
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
    bag.fetchBag = originalFetchBag;
  }
});

test("302 redirect location is re-validated and replayed with the same guid", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  const seen = [];
  http.sendWithRedirectRecovery = async (options) => {
    seen.push(options.url);
    if (seen.length === 1) {
      return {
        status: 302,
        finalUrl: options.url,
        headers: { location: "https://p49-buy.itunes.apple.com/auth/v1/native/fast?x=1" },
        body: "",
      };
    }
    return {
      status: 200,
      finalUrl: options.url,
      headers: { "x-set-apple-store-front": "143441-1,29" },
      body: plist.buildPlist({
        accountInfo: {
          appleId: "user@example.com",
          address: { firstName: "Test", lastName: "User" },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    };
  };
  try {
    const account = await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      deviceId: "001122334455",
      authURLOverride: "https://auth.itunes.apple.com/auth/v1/native/fast/",
    });
    assert.strictEqual(account.email, "user@example.com");
    assert.strictEqual(seen.length, 2);
    assert.match(seen[0], /guid=001122334455$/);
    assert.strictEqual(
      seen[1],
      "https://p49-buy.itunes.apple.com/auth/v1/native/fast?x=1&guid=001122334455"
    );
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
  }
});

test("redirect Location to a non-Apple host aborts with an auth error", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async (options) => ({
    status: 302,
    finalUrl: options.url,
    headers: { location: "https://evil.example/collect" },
    body: "",
  });
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        authURLOverride: "https://auth.itunes.apple.com/auth/v1/native/fast/",
        retryDelays: [1, 1, 1, 1, 1],
      }),
      (err) => err instanceof auth.AuthenticationError
    );
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
  }
});

test("native 403 falls back to the legacy MZFinance endpoint once", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  const seen = [];
  http.sendWithRedirectRecovery = async (options) => {
    seen.push(options.url);
    if (seen.length === 1) {
      // native 端点返回非 plist 的 403（ipatol 触发 legacy 回退的场景）
      return {
        status: 403,
        finalUrl: options.url,
        headers: {},
        body: "<html><body>Your request could not be completed.</body></html>",
      };
    }
    return {
      status: 200,
      finalUrl: options.url,
      headers: { "x-set-apple-store-front": "143465-1,29" },
      body: plist.buildPlist({
        accountInfo: {
          appleId: "user@example.com",
          address: { firstName: "Test", lastName: "User" },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    };
  };
  try {
    const account = await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      deviceId: "001122334455",
      retryDelays: [1, 1, 1, 1, 1],
    });
    assert.strictEqual(account.email, "user@example.com");
    assert.strictEqual(account.store, "CN");
    assert.strictEqual(seen.length, 2);
    assert.match(seen[0], /\/auth\/v1\/native\/fast\//);
    assert.match(
      seen[1],
      /^https:\/\/buy\.itunes\.apple\.com\/WebObjects\/MZFinance\.woa\/wa\/authenticate\?guid=001122334455$/
    );
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
  }
});

test("both native and legacy failing keeps the HTTP status in the error", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async (options) => ({
    status: 403,
    finalUrl: options.url,
    headers: {},
    body: "<html><body>forbidden</body></html>",
  });
  try {
    await assert.rejects(
      auth.authenticate({
        email: "user@example.com",
        password: "secret",
        deviceId: "001122334455",
        retryDelays: [1, 1, 1, 1, 1],
      }),
      (err) =>
        err instanceof auth.AuthenticationError &&
        /HTTP 403/.test(err.message) &&
        /forbidden/.test(err.message)
    );
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
  }
});

test("legacy bare <dict> responses are parsed as a login result", async () => {
  const originalRecovery = http.sendWithRedirectRecovery;
  http.sendWithRedirectRecovery = async (options) => ({
    status: 200,
    finalUrl: options.url,
    headers: { "x-set-apple-store-front": "143465-1,29" },
    body:
      "<dict>" +
      "<key>accountInfo</key><dict>" +
      "<key>appleId</key><string>user@example.com</string>" +
      "<key>address</key><dict>" +
      "<key>firstName</key><string>Test</string>" +
      "<key>lastName</key><string>User</string>" +
      "</dict></dict>" +
      "<key>passwordToken</key><string>token</string>" +
      "<key>dsPersonId</key><string>123</string>" +
      "</dict>",
  });
  try {
    const account = await auth.authenticate({
      email: "user@example.com",
      password: "secret",
      deviceId: "001122334455",
      authURLOverride: "https://auth.itunes.apple.com/auth/v1/native/fast/",
    });
    assert.strictEqual(account.store, "CN");
    assert.strictEqual(account.passwordToken, "token");
  } finally {
    http.sendWithRedirectRecovery = originalRecovery;
  }
});
