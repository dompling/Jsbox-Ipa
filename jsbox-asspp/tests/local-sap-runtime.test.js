const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("remote-cache SAP runtime source supports arbitrary body signing", () => {
  const wasmPath = path.join(root, "../sap-signer/sap.wasm");
  const signerPath = path.join(root, "assets/sap/sap-signer.js");
  const pagePath = path.join(root, "assets/sap/index.html");

  const wasm = fs.readFileSync(wasmPath);
  assert.ok(wasm.length > 1024 * 1024);
  assert.deepEqual(Array.from(wasm.subarray(0, 4)), [0x00, 0x61, 0x73, 0x6d]);

  const signer = fs.readFileSync(signerPath, "utf8");
  assert.match(signer, /sapWasmSign\(bodyBase64\)/);
  assert.match(signer, /function sapInitialize\(/);

  const page = fs.readFileSync(pagePath, "utf8");
  assert.match(page, /await sapInitialize\(guid, options\)/);
  assert.match(page, /await sapSign\(String\(request\.bodyBase64\)\)/);
});

test("JSBox webview mode is recognized as a raw-body signer when UI and server exist", () => {
  const oldUi = global.$ui;
  const oldServer = global.$server;
  global.$ui = {};
  global.$server = {};
  try {
    const modulePath = require.resolve("../scripts/apple/sap");
    delete require.cache[modulePath];
    const sap = require(modulePath);
    assert.equal(sap.supportsRawBodySigning({ rawSapMode: "webview" }), true);
  } finally {
    global.$ui = oldUi;
    global.$server = oldServer;
  }
});
