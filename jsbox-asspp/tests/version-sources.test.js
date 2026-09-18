const { test } = require("node:test");
const assert = require("node:assert/strict");

const http = require("../scripts/lib/http");
const sources = require("../scripts/apple/version-sources");

test("third-party version sources choose the more complete mapping", async t => {
  t.mock.method(http, "send", async options => {
    if (options.url.includes("timbrd.com")) {
      return {
        status: 200,
        data: [
          { external_identifier: "100", bundle_version: "1.0" },
          { external_identifier: "200", bundle_version: "2.0" },
        ],
      };
    }
    return {
      status: 200,
      data: {
        data: [
          { external_identifier: "100", bundle_version: "1.0" },
          { external_identifier: "200", bundle_version: "2.0" },
          { external_identifier: "300", bundle_version: "3.0" },
        ],
      },
    };
  });

  const result = await sources.fetchVersionMap("123");
  assert.deepEqual(result.map(v => [v.id, v.displayVersion]), [
    ["100", "1.0"],
    ["200", "2.0"],
    ["300", "3.0"],
  ]);
  assert.ok(result.every(v => v.externalVersionId === v.id));
});

test("third-party version source failures are silent", async t => {
  t.mock.method(http, "send", async () => {
    throw new Error("synthetic outage");
  });
  assert.deepEqual(await sources.fetchVersionMap("123"), []);
});

test("third-party version mappings drop malformed and duplicate rows", () => {
  assert.deepEqual(sources.normalize([
    { id: "100", displayVersion: "1.0" },
    { id: "100", displayVersion: "duplicate" },
    { id: "", displayVersion: "2.0" },
    { id: "200", displayVersion: "" },
    { id: "300", displayVersion: "3.0" },
  ]).map(v => [v.id, v.displayVersion]), [
    ["100", "1.0"],
    ["300", "3.0"],
  ]);
});
