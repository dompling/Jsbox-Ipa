const { test } = require("node:test");
const assert = require("node:assert");
const b64 = require("../scripts/lib/b64");

test("base64 roundtrip", () => {
  const text = "Hello, JSBox 世界 🌏";
  assert.strictEqual(b64.base64DecodeString(b64.base64EncodeString(text)), text);
});

test("base64 decode known vector", () => {
  const bytes = b64.base64Decode("aGVsbG8=");
  assert.deepStrictEqual(bytes, [104, 101, 108, 108, 111]);
});
