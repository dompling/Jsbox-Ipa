const { test } = require("node:test");
const assert = require("node:assert");

const downloader = require("../scripts/services/downloader");

test("download response validation rejects errors, insecure redirects and text payloads", () => {
  const binary = zipFixture();
  assert.throws(
    () => downloader.validateDownloadResponse({ status: 500, rawData: binary }),
    /HTTP 500/
  );
  assert.throws(
    () => downloader.validateDownloadResponse({
      status: 200,
      finalUrl: "http://cdn.example/app.ipa",
      headers: {},
      rawData: binary,
    }),
    /HTTPS/
  );
  assert.throws(
    () => downloader.validateDownloadResponse({
      status: 200,
      finalUrl: "https://cdn.example/app.ipa",
      headers: { "content-type": "text/html" },
      rawData: binary,
    }),
    /内容类型/
  );
  assert.throws(
    () => downloader.validateDownloadResponse({
      status: 200,
      finalUrl: "https://cdn.example/app.ipa",
      headers: {},
      rawData: {},
      expectedContentLength: 0,
    }),
    /大小/
  );
});

test("download response validation accepts an HTTPS ZIP payload and reports byte length", () => {
  const binary = zipFixture();
  const result = downloader.validateDownloadResponse({
    status: 200,
    finalUrl: "https://cdn.example/app.ipa",
    headers: { "content-type": "application/octet-stream" },
    rawData: binary,
    expectedContentLength: binary.byteArray.length,
  });
  assert.strictEqual(result.size, binary.byteArray.length);
  assert.strictEqual(result.data, binary);
});

test("download response validation fails closed for opaque data without archiver", () => {
  const previousFile = global.$file;
  const previousArchiver = global.$archiver;
  delete global.$file;
  delete global.$archiver;
  try {
    assert.throws(
      () =>
        downloader.validateDownloadResponse({
          status: 200,
          finalUrl: "https://cdn.example/app.ipa",
          headers: { "content-type": "application/octet-stream" },
          rawData: { nativeData: true },
          expectedContentLength: 8192,
        }),
      /无法验证 IPA 数据/
    );
  } finally {
    if (previousFile === undefined) delete global.$file;
    else global.$file = previousFile;
    if (previousArchiver === undefined) delete global.$archiver;
    else global.$archiver = previousArchiver;
  }
});

test("secure download URL validation has a JSBox-compatible parser fallback", () => {
  const previousURL = global.URL;
  try {
    global.URL = undefined;
    assert.strictEqual(
      downloader.secureDownloadUrl("https://cdn.example/path/app%20one.ipa?x=1"),
      "https://cdn.example/path/app%20one.ipa?x=1"
    );
    assert.throws(
      () => downloader.secureDownloadUrl("http://cdn.example/app.ipa"),
      /HTTPS/
    );
  } finally {
    global.URL = previousURL;
  }
});

test("inline download progress disables the competing global download overlay", async () => {
  const http = require("../scripts/lib/http");
  const original = http.send;
  let captured;
  http.send = async (options) => {
    captured = options;
    return {
      status: 200,
      finalUrl: options.url,
      headers: { "content-type": "application/octet-stream" },
      rawData: zipFixture(),
      expectedContentLength: 8192,
    };
  };
  try {
    await downloader.fetchIpaData(
      { downloadURL: "https://cdn.example/app.ipa" },
      "Example 1.0",
      () => {},
    );
    assert.strictEqual(captured.showsProgress, false);

    await downloader.fetchIpaData(
      { downloadURL: "https://cdn.example/app.ipa" },
      "Example 1.0",
    );
    assert.strictEqual(captured.showsProgress, true);
  } finally {
    http.send = original;
  }
});

test("icon source prefers an upgradeable 100px artwork URL over raw icons", () => {
  assert.strictEqual(
    downloader.iconSourceOf({
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/100x100bb.png",
      artworkUrl: "https://example.com/full.png",
      icon: "https://example.com/icon.png",
    }),
    "https://is1-ssl.mzstatic.com/image/thumb/512x512bb.png"
  );
  assert.strictEqual(
    downloader.iconSourceOf({ artworkUrl: "https://example.com/full.png" }),
    "https://example.com/full.png"
  );
  assert.strictEqual(downloader.iconSourceOf({ icon: "http://insecure/icon.png" }), "");
  assert.strictEqual(downloader.iconSourceOf({ icon: "file:///tmp/icon.png" }), "");
  assert.strictEqual(downloader.iconSourceOf({}), "");
});

test("icon responses are accepted by image type or magic bytes only", () => {
  assert.strictEqual(
    downloader.looksLikeIconBytes({ byteArray: [1, 2, 3] }, "image/jpeg; charset=utf-8"),
    true
  );
  assert.strictEqual(
    downloader.looksLikeIconBytes({ byteArray: [1, 2, 3] }, "text/html"),
    false
  );
  assert.strictEqual(
    downloader.looksLikeIconBytes(
      { byteArray: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0] },
      "application/octet-stream"
    ),
    true
  );
  assert.strictEqual(downloader.looksLikeIconBytes({ nativeData: true }, ""), false);
});

test("saveAppIcon writes image payloads beside the IPA and skips text payloads", async () => {
  const http = require("../scripts/lib/http");
  const originalSend = http.send;
  const previousFile = global.$file;
  const written = new Map();
  global.$file = {
    exists: (path) => written.has(path),
    write: ({ path, data }) => {
      written.set(path, data);
      return true;
    },
    move: ({ src, dst }) => {
      if (!written.has(src) || written.has(dst)) return false;
      written.set(dst, written.get(src));
      written.delete(src);
      return true;
    },
  };
  try {
    http.send = async () => ({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      rawData: {
        byteArray: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0],
      },
    });
    await downloader.saveAppIcon("Demo 1.0.ipa", {
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/100x100bb.png",
    });
    assert.ok(written.has("downloads/Demo 1.0.ipa.icon"));

    written.clear();
    http.send = async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      rawData: { string: "<html>not an icon</html>" },
    });
    await downloader.saveAppIcon("Demo 1.0.ipa", {
      artworkUrl: "https://example.com/icon.png",
    });
    assert.strictEqual(written.size, 0);

    http.send = async () => ({ status: 403, headers: {}, rawData: null });
    await downloader.saveAppIcon("Demo 1.0.ipa", {
      icon: "https://example.com/icon.png",
    });
    assert.strictEqual(written.size, 0);
  } finally {
    http.send = originalSend;
    if (previousFile === undefined) delete global.$file;
    else global.$file = previousFile;
  }
});

function zipFixture() {
  const bytes = new Array(8192).fill(0);
  bytes.splice(0, 4, 0x50, 0x4b, 0x03, 0x04);
  bytes.splice(bytes.length - 22, 4, 0x50, 0x4b, 0x05, 0x06);
  return { byteArray: bytes };
}


function downloaderFlowStubs(savedSink) {
  const library = require("../scripts/store/library");
  const accounts = require("../scripts/store/accounts");
  const validator = require("../scripts/services/ipa-validator");
  const injector = require("../scripts/services/ipa-injector");
  const download = require("../scripts/apple/download");
  const stream = require("../scripts/services/stream-download");
  const originals = {
    librarySave: library.saveDownloadedFile,
    accountsGet: accounts.getAccount,
    downloadInfo: download.getDownloadInfo,
    chunked: stream.tryChunkedDownload,
    validatorFile: validator.validateDownloadedFile,
    normalizeArtifacts: validator.normalizeArtifacts,
    canRezip: injector.canRezip,
    injectAndSave: injector.injectAndSave,
  };
  const saved = savedSink || [];
  library.saveDownloadedFile = (src, meta) => {
    const record = Object.assign({}, meta, {
      fileName: "Demo 1.0.ipa",
      path: src,
    });
    saved.push({ src, record });
    return record;
  };
  // 默认成功路径：模拟 injectAndSave 内部先解压重打包，再调用
  // library.saveDownloadedFile 把注入副本入库。
  injector.injectAndSave = async (record) => {
    const injected = Object.assign({}, record, {
      fileName: "Demo 1.0 已注入SINF.ipa",
      title: "Demo（已注入SINF）",
      sinfInjected: true,
    });
    saved.push({ src: "cache/injected-Demo.ipa", record: injected });
    return {
      record: injected,
      sinfWrites: 1,
      metadataInjected: true,
      source: "SC_Info/*.supp",
    };
  };
  accounts.getAccount = () => null;
  download.getDownloadInfo = async () => ({
    downloadURL: "https://cdn.example/demo.ipa",
    sinfs: [{ id: "1", sinf: "aGk=" }],
    iTunesMetadataBase64: "PHBsaXN0Lz4=",
    bundleShortVersionString: "1.0",
    bundleVersion: "100",
    updatedCookies: [],
  });
  stream.tryChunkedDownload = async () => ({
    ok: true,
    path: "cache/staged-Demo.ipa",
    size: 12345,
  });
  validator.validateDownloadedFile = async () => ({
    verified: true,
    appPath: "Payload/Demo.app",
  });
  validator.normalizeArtifacts = () => ({
    sinfs: [{ id: "1", sinf: "aGk=" }],
    iTunesMetadataBase64: "PHBsaXN0Lz4=",
  });
  injector.canRezip = () => true;
  return { originals, modules: { library, accounts, validator, injector, download, stream } };
}

function restoreDownloaderStubs({ originals, modules }) {
  modules.library.saveDownloadedFile = originals.librarySave;
  modules.accounts.getAccount = originals.accountsGet;
  modules.download.getDownloadInfo = originals.downloadInfo;
  modules.stream.tryChunkedDownload = originals.chunked;
  modules.validator.validateDownloadedFile = originals.validatorFile;
  modules.validator.normalizeArtifacts = originals.normalizeArtifacts;
  modules.injector.canRezip = originals.canRezip;
  modules.injector.injectAndSave = originals.injectAndSave;
}

test("downloadToLibrary saves the original first, then auto-creates an injected copy", async () => {
  const saved = [];
  const stubs = downloaderFlowStubs(saved);
  const injector = stubs.modules.injector;
  let injectedRecord = null;
  injector.injectAndSave = async (record) => {
    injectedRecord = record;
    const injected = Object.assign({}, record, {
      fileName: "Demo 1.0 已注入SINF.ipa",
      title: "Demo（已注入SINF）",
      sinfInjected: true,
    });
    saved.push({ src: "cache/injected-Demo.ipa", record: injected });
    return {
      record: injected,
      sinfWrites: 1,
      metadataInjected: true,
      source: "SC_Info/*.supp",
    };
  };
  try {
    const result = await downloader.downloadToLibrary(
      { email: "demo@example.com", cookies: [] },
      { id: 123, bundleID: "com.example.demo", name: "Demo" },
      undefined,
      {}
    );
    assert.strictEqual(saved.length, 2);
    // 第一步：未注入的原始包先入库，SINF 仍留在 sidecar 里。
    assert.strictEqual(saved[0].src, "cache/staged-Demo.ipa");
    assert.strictEqual(saved[0].record.sinfInjected, false);
    assert.strictEqual(saved[0].record.packageVerified, true);
    assert.strictEqual(saved[0].record.bundleId, "com.example.demo");
    // 第二步：基于刚入库的原始包生成注入副本。
    assert.strictEqual(saved[1].src, "cache/injected-Demo.ipa");
    assert.strictEqual(saved[1].record.sinfInjected, true);
    assert.ok(injectedRecord, "injection should use the saved original record");
    assert.strictEqual(injectedRecord.fileName, "Demo 1.0.ipa");
    assert.strictEqual(injectedRecord.packageAppPath, "Payload/Demo.app");
    assert.strictEqual(result.record.fileName, "Demo 1.0 已注入SINF.ipa");
    assert.strictEqual(result.original.fileName, "Demo 1.0.ipa");
    assert.strictEqual(result.injected, true);
  } finally {
    restoreDownloaderStubs(stubs);
  }
});

test("downloadToLibrary keeps the original staged IPA when injection fails", async () => {
  const saved = [];
  const stubs = downloaderFlowStubs(saved);
  let attempts = 0;
  stubs.modules.injector.injectAndSave = async () => {
    attempts += 1;
    throw new Error("repack failed");
  };
  try {
    const result = await downloader.downloadToLibrary(
      { email: "demo@example.com", cookies: [] },
      { id: 123, bundleID: "com.example.demo", name: "Demo" },
      undefined,
      {}
    );
    assert.strictEqual(attempts, 1);
    // 原包仍然只有一份且被保留，不会因为注入失败丢文件。
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].src, "cache/staged-Demo.ipa");
    assert.strictEqual(saved[0].record.sinfInjected, false);
    assert.strictEqual(saved[0].record.packageVerified, true);
    assert.strictEqual(result.record.fileName, "Demo 1.0.ipa");
    assert.strictEqual(result.injected, false);
    assert.ok(result.injectFailed.indexOf("repack failed") >= 0);
  } finally {
    restoreDownloaderStubs(stubs);
  }
});

test("downloadToLibrary skips injection when SINF is absent", async () => {
  const saved = [];
  const stubs = downloaderFlowStubs(saved);
  let attempts = 0;
  stubs.modules.validator.normalizeArtifacts = () => ({
    sinfs: [],
    iTunesMetadataBase64: "",
  });
  stubs.modules.injector.injectAndSave = async () => {
    attempts += 1;
    throw new Error("should not run");
  };
  try {
    const result = await downloader.downloadToLibrary(
      { email: "demo@example.com", cookies: [] },
      { id: 123, bundleID: "com.example.demo", name: "Demo" },
      undefined,
      {}
    );
    assert.strictEqual(attempts, 0);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].src, "cache/staged-Demo.ipa");
    assert.strictEqual(saved[0].record.sinfInjected, false);
    assert.strictEqual(result.injected, false);
  } finally {
    restoreDownloaderStubs(stubs);
  }
});
