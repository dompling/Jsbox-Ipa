const { test } = require("node:test");
const assert = require("node:assert");

test("every UI module loads without unresolved helpers", () => {
  global.$color = (value) => `color:${JSON.stringify(value)}`;
  global.$font = (...args) => `font:${args.join(":")}`;
  global.$align = { left: 0, center: 1, right: 2 };
  global.$size = (width, height) => ({ width, height });
  global.$insets = (top, left, bottom, right) => ({ top, left, bottom, right });

  const modules = [
    "common",
    "shell",
    "home",
    "purchased",
    "search",
    "chart",
    "detail",
    "accounts",
    "downloads",
    "settings",
    "install",
  ];
  for (const name of modules) {
    const path = require.resolve(`../scripts/ui/${name}`);
    delete require.cache[path];
    const loaded = require(path);
    assert.ok(loaded && typeof loaded === "object", `${name} should load`);
  }
});
