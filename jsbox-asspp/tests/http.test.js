const { test } = require("node:test");
const assert = require("node:assert");

const http = require("../scripts/lib/http");

test("normalizeResponse preserves JSON objects returned by JSBox", () => {
  const response = http.normalizeResponse({
    data: { resultCount: 1, results: [{ trackId: 1 }] },
    response: {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      url: "https://itunes.apple.com/search",
    },
  });

  assert.deepStrictEqual(response.data, {
    resultCount: 1,
    results: [{ trackId: 1 }],
  });
  assert.deepStrictEqual(http.parseJSON(response.body), response.data);
});

test("ordinary requests disable the global progress indicator by default", async () => {
  const previousHttp = global.$http;
  const captured = [];
  global.$http = {
    request: (options) => {
      captured.push(options);
      options.handler({
        data: "ok",
        response: { statusCode: 200, headers: {}, url: options.url },
      });
    },
    download: (options) => {
      captured.push(options);
      options.handler({
        data: { byteArray: [80, 75] },
        response: { statusCode: 200, headers: {}, url: options.url },
      });
    },
  };
  try {
    await http.send({ method: "GET", url: "https://itunes.apple.com/search" });
    await http.send({
      method: "GET",
      url: "https://example.com/app.ipa",
      download: true,
      showsProgress: true,
    });
    assert.strictEqual(captured[0].showsProgress, false);
    assert.strictEqual(captured[1].showsProgress, true);
  } finally {
    global.$http = previousHttp;
  }
});

test("requestBody preserves exact UTF-8 bytes when JSBox data is available", () => {
  const previous = global.$data;
  global.$data = ({ string }) => ({ kind: "data", string });
  try {
    assert.deepStrictEqual(http.requestBody("<plist>密码</plist>"), {
      kind: "data",
      string: "<plist>密码</plist>",
    });
  } finally {
    if (previous === undefined) delete global.$data;
    else global.$data = previous;
  }
});

test("normalizeResponse uses download data as the binary payload", () => {
  const binary = { string: "binary-data" };
  const response = http.normalizeResponse(
    {
      data: binary,
      response: { statusCode: 200, headers: {}, url: "https://example.com/app.ipa" },
    },
    true
  );

  assert.strictEqual(response.rawData, binary);
});

test("parseJSON accepts an already parsed object", () => {
  const value = { ok: true };
  assert.strictEqual(http.parseJSON(value), value);
});

test("redirect recovery only replays credential-bearing requests within Apple HTTPS", () => {
  assert.strictEqual(
    http.isAllowedRecoveryTarget(
      new URL("https://auth.itunes.apple.com/auth"),
      new URL("https://buy.itunes.apple.com/auth")
    ),
    true
  );
  assert.strictEqual(
    http.isAllowedRecoveryTarget(
      new URL("https://auth.itunes.apple.com/auth"),
      new URL("http://auth.itunes.apple.com/auth")
    ),
    false
  );
  assert.strictEqual(
    http.isAllowedRecoveryTarget(
      new URL("https://auth.itunes.apple.com/auth"),
      new URL("https://evil.example/auth")
    ),
    false
  );
  assert.strictEqual(
    http.isAllowedRecoveryTarget(
      new URL("https://auth.itunes.apple.com/auth"),
      new URL("https://auth.itunes.apple.com:444/auth")
    ),
    false
  );
});

test("a valid-looking response from an unsafe automatic redirect is rejected", async () => {
  const previousHttp = global.$http;
  global.$http = {
    request: (options) => {
      options.handler({
        data: '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
        response: {
          statusCode: 200,
          headers: { "content-type": "application/xml" },
          url: "https://evil.example/collect",
        },
      });
    },
  };
  try {
    await assert.rejects(
      http.sendWithRedirectRecovery(
        {
          method: "POST",
          url: "https://auth.itunes.apple.com/auth",
          body: "password=secret",
        },
        (res) => res.status === 200 && /<plist/.test(res.body)
      ),
      /不安全的重定向/
    );
  } finally {
    global.$http = previousHttp;
  }
});

test("a same-host HTTPS downgrade is not treated as the same response origin", async () => {
  const previousHttp = global.$http;
  global.$http = {
    request: (options) => {
      options.handler({
        data: '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
        response: {
          statusCode: 200,
          headers: { "content-type": "application/xml" },
          url: "http://auth.itunes.apple.com/auth",
        },
      });
    },
  };
  try {
    await assert.rejects(
      http.sendWithRedirectRecovery(
        {
          method: "POST",
          url: "https://auth.itunes.apple.com/auth",
          body: "password=secret",
        },
        (res) => res.status === 200 && /<plist/.test(res.body)
      ),
      /不安全的重定向/
    );
  } finally {
    global.$http = previousHttp;
  }
});

test("validateCredentialTarget works without relying on global URL for auth endpoints", () => {
  const ok = http.validateCredentialTarget(
    "https://auth.itunes.apple.com/auth/v1/native/fast/?guid=abc#frag"
  );
  assert.strictEqual(
    ok.toString(),
    "https://auth.itunes.apple.com/auth/v1/native/fast/?guid=abc"
  );
  assert.strictEqual(ok.hostname, "auth.itunes.apple.com");
  assert.strictEqual(ok.port, "");
  // 默认端点必须可通过同一套校验
  assert.doesNotThrow(() =>
    http.validateCredentialTarget(
      "https://auth.itunes.apple.com/auth/v1/native/fast/?guid=001122"
    )
  );
  assert.doesNotThrow(() =>
    http.validateCredentialTarget(
      "https://auth.itunes.apple.com:443/auth/v1/native/fast/?guid=001122"
    )
  );
});

test("validateCredentialTarget rejects unsafe or malformed endpoints", () => {
  const label = "Bag 认证端点";
  assert.throws(() => http.validateCredentialTarget("", label), /不是有效 URL/);
  assert.throws(() => http.validateCredentialTarget("http://auth.itunes.apple.com/auth", label), /必须使用 HTTPS/);
  assert.throws(() => http.validateCredentialTarget("https://evil.example/auth", label), /必须属于 itunes\.apple\.com/);
  assert.throws(() => http.validateCredentialTarget("https://user:pass@auth.itunes.apple.com/auth", label), /用户名或密码/);
  assert.throws(() => http.validateCredentialTarget("https://auth.itunes.apple.com:444/auth", label), /端口 443/);
  assert.throws(() => http.validateCredentialTarget("not a url", label), /不是有效 URL/);
  assert.throws(() => http.validateCredentialTarget("https://auth.itunes.apple.com:bad/auth", label), /不是有效 URL/);
});

test("appendQuery sets or replaces a query parameter idempotently", () => {
  const guid = "001122334455AABB";
  assert.strictEqual(
    http.appendQuery("https://auth.itunes.apple.com/auth/v1/native/fast/", "guid", guid),
    `https://auth.itunes.apple.com/auth/v1/native/fast/?guid=${guid}`
  );
  assert.strictEqual(
    http.appendQuery(
      "https://auth.itunes.apple.com/auth/v1/native/fast/?guid=OLD&x=1",
      "guid",
      guid
    ),
    `https://auth.itunes.apple.com/auth/v1/native/fast/?guid=${guid}&x=1`
  );
  assert.strictEqual(
    http.appendQuery("https://a.itunes.apple.com/p?x=1", "guid", guid),
    `https://a.itunes.apple.com/p?x=1&guid=${guid}`
  );
});

test("parseUrl yields comparable origin/pathname/search without URL class", () => {
  const parsed = http.parseUrl(
    "https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct?guid=ABC#x"
  );
  assert.strictEqual(parsed.origin, "https://p25-buy.itunes.apple.com");
  assert.strictEqual(
    parsed.pathname,
    "/WebObjects/MZFinance.woa/wa/buyProduct"
  );
  assert.strictEqual(parsed.search, "?guid=ABC");
  assert.strictEqual(http.parseUrl(""), null);
  assert.strictEqual(http.parseUrl("not a url"), null);
});

test("automatic Apple-to-Apple redirect replays the original credential request", async () => {
  const previousHttp = global.$http;
  const calls = [];
  global.$http = {
    request: (options) => {
      calls.push({ url: options.url, method: options.method, body: options.body });
      if (calls.length === 1) {
        options.handler({
          data: "<html>redirected POST became GET</html>",
          response: {
            statusCode: 200,
            headers: {},
            url: "https://p37-buy.itunes.apple.com/auth",
          },
        });
        return;
      }
      options.handler({
        data: '<plist version="1.0"><dict/></plist>',
        response: {
          statusCode: 200,
          headers: {},
          url: options.url,
        },
      });
    },
  };
  try {
    const result = await http.sendWithRedirectRecovery(
      {
        method: "POST",
        url: "https://auth.itunes.apple.com/auth",
        body: "password=secret",
      },
      (res) => res.status === 200 && /<plist/.test(res.body)
    );
    assert.strictEqual(result.status, 200);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].method, "POST");
    assert.strictEqual(calls[1].method, "POST");
    assert.strictEqual(calls[1].url, "https://p37-buy.itunes.apple.com/auth");
    assert.strictEqual(calls[1].body, "password=secret");
  } finally {
    global.$http = previousHttp;
  }
});
