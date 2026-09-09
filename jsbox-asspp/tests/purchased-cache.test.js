const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/ui");

const plain = (value) => JSON.parse(JSON.stringify(value));
const app = (id, name = `App ${id}`) => ({ id, name, owned: true, price: 0 });
const snapshot = (apps, options = {}) => ({
  apps, totalCount: apps.length, complete: true, enrichedIds: [], updatedAt: 1000, ...options,
});

function harness(runtime) {
  const h = setup();
  const values = new Map();
  h.context.$cache = runtime || {
    get: (key) => values.get(key),
    set: (key, value) => { values.set(key, plain(value)); return true; },
  };
  return { cache: h.load("store/purchased-cache.js"), values, context: h.context };
}

test("purchased cache persists complete snapshots by normalized account and region", () => {
  const { cache, values } = harness();
  assert.equal(cache.write(" A@Example.test ", " cn ", snapshot([app("1")], { enrichedIds: ["1"] })), true);
  assert.equal(cache.write("a@example.test", "US", snapshot([app("2")])), true);
  assert.equal(cache.write("b@example.test", "CN", snapshot([app("3")])), true);
  assert.equal(values.size, 3);
  assert.deepEqual(plain(cache.read("a@example.test", "CN", 1001).apps), [app("1")]);
  assert.deepEqual(plain(cache.read("A@example.test", "us", 1001).apps), [app("2")]);
  assert.deepEqual(plain(cache.read("b@example.test", "CN", 1001).apps), [app("3")]);
  assert.equal(cache.read("missing@example.test", "CN", 1001), null);
  assert.equal(cache.read("a@example.test", "JP", 1001), null);
});

test("cache freshness expires without deleting the last successful snapshot", () => {
  const { cache } = harness();
  cache.write("a@example.test", "CN", snapshot([app("1")]));
  assert.equal(cache.read("a@example.test", "CN", 1000 + cache.TTL_MS - 1).stale, false);
  const old = cache.read("a@example.test", "CN", 1000 + cache.TTL_MS);
  assert.equal(old.stale, true);
  assert.equal(old.apps[0].id, "1");
  assert.equal(cache.read("a@example.test", "CN", 999).stale, true, "a clock moving backward cannot make the cache fresh forever");
});

test("cache only stores whitelisted display metadata and keeps unknown titles empty", () => {
  const { cache, values } = harness();
  const record = {
    ...app("1", ""), bundleID: "com.example.one", version: "1.2", purchaseDate: "2026-08-01",
    artworkUrl: "https://example.test/one.png", artistName: "Maker", description: "Description",
    screenshotUrls: ["https://example.test/screen.png"], genres: ["Games"], averageUserRating: 4.5,
    raw: { passwordToken: "raw-secret" }, passwordToken: "token-secret", password: "password-secret",
    directoryServicesIdentifier: "dsid-secret", cookies: ["cookie-secret"], account: { email: "private" },
    diagnostics: "diagnostic-secret", callback() {},
  };
  cache.write("a@example.test", "CN", snapshot([record], {
    enrichedIds: ["1", "1", "not-in-snapshot"], account: { passwordToken: "account-secret" },
  }));
  const stored = plain([...values.values()][0]);
  assert.equal(stored.apps[0].name, "");
  assert.equal(stored.apps[0].owned, true);
  assert.equal(stored.apps[0].artworkUrl, record.artworkUrl);
  assert.equal(stored.apps[0].description, "Description");
  assert.deepEqual(stored.apps[0].screenshotUrls, record.screenshotUrls);
  assert.deepEqual(stored.enrichedIds, ["1"]);
  assert.doesNotMatch(JSON.stringify(stored), /secret|cookies|password|directoryServices|diagnostics|callback|account/);
  const read = cache.read("a@example.test", "CN", 1001);
  read.apps[0].name = "changed by caller";
  assert.equal(cache.read("a@example.test", "CN", 1001).apps[0].name, "");
  assert.equal(record.name, "");
});

test("a successful empty snapshot replaces old purchases", () => {
  const { cache } = harness();
  cache.write("a@example.test", "CN", snapshot([app("1")]));
  assert.equal(cache.write("a@example.test", "CN", snapshot([], { updatedAt: 2000 })), true);
  const read = cache.read("a@example.test", "CN", 2001);
  assert.equal(read.totalCount, 0);
  assert.equal(read.complete, true);
  assert.deepEqual(plain(read.apps), []);
});

test("partial, malformed or oversized writes cannot replace a valid snapshot", () => {
  const { cache } = harness();
  cache.write("a@example.test", "CN", snapshot([app("kept")]));
  const tooMany = Array.from({ length: cache.MAX_APPS + 1 }, (_value, index) => app(String(index)));
  for (const value of [
    snapshot([app("1")], { complete: false }),
    snapshot([app("1")], { totalCount: 2 }),
    snapshot([app("1")], { updatedAt: NaN }),
    snapshot([app("1"), app("1")]),
    snapshot([{ name: "missing id" }]),
    snapshot(tooMany),
  ]) {
    assert.equal(cache.write("a@example.test", "CN", value), false);
    assert.equal(cache.read("a@example.test", "CN", 1001).apps[0].id, "kept");
  }
  assert.equal(cache.write("", "CN", snapshot([])), false);
  assert.equal(cache.write("a@example.test", "", snapshot([])), false);
});

test("malformed persistent values are cache misses", () => {
  const { cache, values } = harness();
  cache.write("a@example.test", "CN", snapshot([app("1")]));
  const [key, saved] = [...values.entries()][0];
  for (const value of [
    null, "invalid", [], { ...saved, schema: 99 }, { ...saved, complete: false },
    { ...saved, totalCount: 2 }, { ...saved, apps: "invalid" },
    { ...saved, apps: [{ id: {} }] }, { ...saved, updatedAt: -1 },
  ]) {
    values.set(key, value);
    assert.equal(cache.read("a@example.test", "CN", 1001), null);
  }
});

test("a newer oversized snapshot leaves older data available but no longer fresh", () => {
  const { cache } = harness();
  cache.write("a@example.test", "CN", snapshot([app("old")]));
  const records = Array.from({ length: cache.MAX_APPS + 1 }, (_value, index) => app(String(index)));
  assert.equal(cache.write("a@example.test", "CN", snapshot(records, { updatedAt: 2000 })), false);
  const kept = cache.read("a@example.test", "CN", 2001);
  assert.equal(kept.apps[0].id, "old");
  assert.equal(kept.updatedAt, 1000);
  assert.equal(kept.stale, true);
});

test("persistent metadata is sanitized again when read", () => {
  const { cache, values } = harness();
  cache.write("a@example.test", "CN", snapshot([app("1")]));
  const [key, value] = [...values.entries()][0];
  value.apps[0].raw = { password: "injected" };
  value.apps[0].artworkUrl = { passwordToken: "not a URL" };
  value.cookies = ["injected"];
  values.set(key, value);
  const read = cache.read("a@example.test", "CN", 1001);
  assert.equal(read.apps[0].raw, undefined);
  assert.equal(read.apps[0].artworkUrl, undefined);
  assert.equal(read.cookies, undefined);
});

test("unavailable or failing JSBox cache does not break the purchased page", () => {
  const { cache, context } = harness({ get() { throw new Error("cache unavailable"); }, set() { throw new Error("cache full"); } });
  assert.equal(cache.read("a@example.test", "CN"), null);
  assert.equal(cache.write("a@example.test", "CN", snapshot([])), false);
  delete context.$cache;
  assert.equal(cache.read("a@example.test", "CN"), null);
  assert.equal(cache.write("a@example.test", "CN", snapshot([])), false);
});
