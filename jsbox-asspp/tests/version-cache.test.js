const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

let values;
let previousCache;

function loadCache() {
  const path = require.resolve("../scripts/store/version-cache");
  delete require.cache[path];
  return require(path);
}

beforeEach(() => {
  values = new Map();
  previousCache = global.$cache;
  global.$cache = {
    get: key => values.get(key),
    set: (key, value) => { values.set(key, value); return true; },
  };
});

afterEach(() => {
  global.$cache = previousCache;
});

test("version cache stores the ID list and persists resolved metadata incrementally", () => {
  const cache = loadCache();
  assert.equal(cache.writeList("User@Example.com", "cn", "42", {
    identifiers: ["300", "200", "100"],
    latest: "300",
  }), true);

  assert.equal(cache.setVersion("user@example.com", "CN", "42", {
    id: "200",
    requestedExternalVersionId: "200",
    externalVersionId: "200",
    displayVersion: "2.0",
    buildVersion: "20",
  }), true);

  const snapshot = cache.read("USER@example.com", "cn", "42");
  assert.deepEqual(snapshot.identifiers, ["300", "200", "100"]);
  assert.equal(snapshot.latest, "300");
  assert.equal(snapshot.versions["200"].displayVersion, "2.0");
  assert.deepEqual(cache.knownVersions("user@example.com", "CN", "42").map(v => v.id), ["200"]);
});

test("refreshing the version ID list preserves matching metadata and drops removed IDs", () => {
  const cache = loadCache();
  cache.writeList("a@example.com", "US", "99", {
    identifiers: ["3", "2", "1"],
    latest: "3",
  });
  cache.setVersion("a@example.com", "US", "99", {
    id: "2", externalVersionId: "2", displayVersion: "2.0", buildVersion: "20",
  });
  cache.setVersion("a@example.com", "US", "99", {
    id: "1", externalVersionId: "1", displayVersion: "1.0", buildVersion: "10",
  });

  cache.writeList("a@example.com", "US", "99", {
    identifiers: ["4", "3", "2"],
    latest: "4",
  });
  const snapshot = cache.read("a@example.com", "US", "99");
  assert.deepEqual(snapshot.identifiers, ["4", "3", "2"]);
  assert.equal(snapshot.versions["2"].displayVersion, "2.0");
  assert.equal(snapshot.versions["1"], undefined);
});

test("invalid cached latest falls back to the first cached identifier", () => {
  const cache = loadCache();
  cache.writeList("a@example.com", "US", "1", {
    identifiers: ["300", "200", "100"],
    latest: "999",
  });
  assert.equal(cache.read("a@example.com", "US", "1").latest, "300");
});

test("version caches are isolated by account, region and app", () => {
  const cache = loadCache();
  cache.writeList("a@example.com", "US", "1", { identifiers: ["10"], latest: "10" });
  assert.ok(cache.read("a@example.com", "US", "1"));
  assert.equal(cache.read("b@example.com", "US", "1"), null);
  assert.equal(cache.read("a@example.com", "CN", "1"), null);
  assert.equal(cache.read("a@example.com", "US", "2"), null);
});
