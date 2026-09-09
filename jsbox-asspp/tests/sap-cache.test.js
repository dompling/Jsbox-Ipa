const { test } = require("node:test");
const assert = require("node:assert/strict");

const CACHE_PATH = "cache/sap.wasm";
const TEMP_PATH = "cache/sap.wasm.part";

function loadSap() {
  delete require.cache[require.resolve("../scripts/apple/sap")];
  return require("../scripts/apple/sap");
}

test("remote SAP WASM is downloaded with progress and committed atomically", async (t) => {
  const previousFile = global.$file;
  const previousHTTP = global.$http;
  const files = new Map();
  const wasmData = { byteArray: new Array(1024 * 1024).fill(0) };
  wasmData.byteArray.splice(0, 4, 0x00, 0x61, 0x73, 0x6d);
  const progress = [];
  let requests = 0;

  global.$file = {
    exists: (path) => files.has(path),
    isDirectory: () => false,
    mkdir: () => true,
    delete: (path) => files.delete(path),
    write: ({ data, path }) => {
      files.set(path, data);
      return true;
    },
    move: ({ src, dst }) => {
      files.set(dst, files.get(src));
      files.delete(src);
      return true;
    },
  };
  global.$http = {
    download: (options) => {
      requests += 1;
      options.progress(0, wasmData.byteArray.length);
      options.progress(wasmData.byteArray.length, wasmData.byteArray.length);
      options.handler({
        response: {
          statusCode: 200,
          headers: { "Content-Type": "application/wasm" },
          expectedContentLength: wasmData.byteArray.length,
          url: options.url,
        },
        data: wasmData,
        rawData: wasmData,
      });
    },
  };
  t.after(() => {
    global.$file = previousFile;
    global.$http = previousHTTP;
  });

  const sap = loadSap();
  await sap.ensureWasmCache((state) => progress.push(state));

  assert.equal(requests, 1);
  assert.equal(files.has(TEMP_PATH), false);
  assert.equal(files.get(CACHE_PATH), wasmData);
  assert.equal(progress.at(-1).progress, 1);
  assert.match(progress.at(-1).message, /下载完成/);

  delete require.cache[require.resolve("../scripts/apple/sap")];
  const cachedSap = require("../scripts/apple/sap");
  const cachedProgress = [];
  global.$http.request = () => {
    throw new Error("cache hit must not download");
  };
  await cachedSap.ensureWasmCache((state) => cachedProgress.push(state));
  assert.equal(requests, 1);
  assert.equal(cachedProgress[0].cached, true);
  assert.equal(cachedProgress[0].progress, 1);
});

test("SAP WASM progress text handles known and unknown response sizes", () => {
  const sap = loadSap();
  assert.equal(sap.wasmProgressMessage(50, 100), "正在下载 SAP 签名引擎… 50%");
  assert.equal(sap.wasmProgressMessage(2 * 1024 * 1024, 0), "正在下载 SAP 签名引擎… 已接收 2 MB");
});
