const { test } = require("node:test");
const assert = require("node:assert");
const cookies = require("../scripts/lib/cookies");

test("parse set-cookie headers", () => {
  const parsed = cookies.parseCookieHeaders([
    "itctx=abc; Domain=.itunes.apple.com; Path=/; HttpOnly; Secure",
    "mz_synced=1; Max-Age=3600",
  ]);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].name, "itctx");
  assert.strictEqual(parsed[0].value, "abc");
  assert.strictEqual(parsed[0].domain, "itunes.apple.com");
  assert.strictEqual(parsed[0].httpOnly, true);
  assert.strictEqual(parsed[0].secure, true);
  assert.ok(parsed[1].expiresAt > Date.now() / 1000);
});

test("merge overrides by cookie identity and keeps same-name cookies for other scopes", () => {
  const merged = cookies.mergeCookies(
    [
      { name: "a", value: "1", path: "/", domain: "x.com" },
      { name: "a", value: "other", path: "/", domain: "y.com" },
    ],
    [{ name: "a", value: "2", path: "/", domain: "x.com" }]
  );
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(
    merged.find((cookie) => cookie.domain === "x.com").value,
    "2"
  );
  assert.strictEqual(
    merged.find((cookie) => cookie.domain === "y.com").value,
    "other"
  );
});

test("host-only cookies are scoped to the response host", () => {
  const parsed = cookies.parseCookieHeaders(
    ["session=abc; Path=/; Secure"],
    "https://buy.itunes.apple.com/login"
  );
  assert.strictEqual(parsed[0].domain, "buy.itunes.apple.com");
  assert.strictEqual(parsed[0].hostOnly, true);
  assert.strictEqual(
    cookies.buildCookieHeader(parsed, "https://buy.itunes.apple.com/account"),
    "session=abc"
  );
  assert.strictEqual(
    cookies.buildCookieHeader(parsed, "https://evil.example/account"),
    ""
  );
});

test("response cannot set a cookie for an unrelated domain", () => {
  const parsed = cookies.parseCookieHeaders(
    ["session=abc; Domain=.itunes.apple.com; Path=/"],
    "https://evil.example/login"
  );
  assert.deepStrictEqual(parsed, []);
});

test("buildCookieHeader filters by host/path/expiry", () => {
  const list = [
    { name: "ok", value: "1", path: "/", domain: "buy.itunes.apple.com" },
    { name: "other-host", value: "x", path: "/", domain: "evil.com" },
    {
      name: "expired",
      value: "x",
      path: "/",
      domain: "buy.itunes.apple.com",
      expiresAt: 1,
    },
  ];
  const header = cookies.buildCookieHeader(
    list,
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct"
  );
  assert.strictEqual(header, "ok=1");
});

test("collectSetCookieHeaders handles string and array values", () => {
  const found = cookies.collectSetCookieHeaders({
    "content-type": "application/xml",
    "Set-Cookie": ["a=1", "b=2"],
  });
  assert.deepStrictEqual(found, ["a=1", "b=2"]);
});

test("combined Set-Cookie values split safely around Expires commas", () => {
  const found = cookies.collectSetCookieHeaders({
    "set-cookie":
      "a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/, b=2; Path=/account",
  });
  assert.deepStrictEqual(found, [
    "a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
    "b=2; Path=/account",
  ]);
});

test("Max-Age takes precedence over Expires regardless of attribute order", () => {
  const parsed = cookies.parseCookieHeaders(
    ["session=gone; Max-Age=0; Expires=Wed, 21 Oct 2030 07:28:00 GMT"],
    "https://buy.itunes.apple.com/"
  );
  assert.ok(parsed[0].expiresAt <= Date.now() / 1000 + 1);
});

test("legacy domainless cookies are confined to Apple and longer paths go first", () => {
  const list = [
    { name: "root", value: "1", path: "/" },
    { name: "deep", value: "2", path: "/WebObjects" },
  ];
  assert.strictEqual(
    cookies.buildCookieHeader(
      list,
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa"
    ),
    "deep=2; root=1"
  );
  assert.strictEqual(
    cookies.buildCookieHeader(list, "https://evil.example/WebObjects"),
    ""
  );
});

test("cookie routing still works when WHATWG URL is unavailable", () => {
  const previousURL = global.URL;
  try {
    global.URL = undefined;
    const parsed = cookies.parseCookieHeaders(
      ["session=abc; Domain=.itunes.apple.com; Path=/; Secure"],
      "https://buy.itunes.apple.com/login"
    );
    assert.strictEqual(
      cookies.buildCookieHeader(parsed, "https://p25-buy.itunes.apple.com/account"),
      "session=abc"
    );
  } finally {
    global.URL = previousURL;
  }
});
