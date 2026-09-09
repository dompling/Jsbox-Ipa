const { test } = require("node:test");
const assert = require("node:assert");

test("errorMessage renders JSBox NSError fields instead of [object NSError]", () => {
  delete require.cache[require.resolve("../scripts/lib/error")];
  const { errorMessage } = require("../scripts/lib/error");

  assert.strictEqual(
    errorMessage({ localizedDescription: "WASM 加载失败" }),
    "WASM 加载失败"
  );
  assert.strictEqual(
    errorMessage({ domain: "NSURLErrorDomain", code: -1004 }),
    "原生错误（NSURLErrorDomain） [-1004]"
  );
  assert.notStrictEqual(errorMessage({}), "[object NSError]");
});
