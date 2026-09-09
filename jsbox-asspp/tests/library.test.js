const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const b64 = require("../scripts/lib/b64");
const plist = require("../scripts/lib/plist");

let files;
let directories;
let prefs;
let failingDeletePath;
let failingPrefKey;
let moves;

function asText(data) {
  if (typeof data === "string") return data;
  return data && typeof data.string === "string" ? data.string : data;
}

function loadLibrary() {
  delete require.cache[require.resolve("../scripts/store/library")];
  return require("../scripts/store/library");
}

test("download account survives sidecar reload and stays with the original and injected copies", () => {
  const library = loadLibrary();
  const original = library.save({ bytes: [1] }, {
    name: "First", title: "First", accountEmail: " Original@Example.Invalid ",
    password: "must-not-be-stored", passwordToken: "must-not-be-stored", account: { email: "wrong@example.invalid" },
  });
  assert.strictEqual(original.accountEmail, "original@example.invalid");
  const stored = JSON.parse(asText(files.get(`downloads/${original.fileName}.meta.json`)));
  assert.strictEqual(stored.accountEmail, "original@example.invalid");
  assert.ok(!("password" in stored) && !("passwordToken" in stored) && !("account" in stored));

  library.save({ bytes: [2] }, { name: "Second", accountEmail: "other@example.invalid" });
  const reloaded = loadLibrary().listFiles().find(record => record.fileName === original.fileName);
  assert.strictEqual(reloaded.accountEmail, "original@example.invalid");
  const copy = library.save({ bytes: [3] }, require("../scripts/services/ipa-injector").injectedMeta(reloaded));
  assert.strictEqual(copy.accountEmail, "original@example.invalid");
  assert.strictEqual(library.listFiles().find(record => record.fileName === copy.fileName).accountEmail, "original@example.invalid");
});

test("staged downloads persist their explicit account before moving to the library", () => {
  const library = loadLibrary();
  files.set("cache/account.ipa", { bytes: [1] });
  const record = library.saveDownloadedFile("cache/account.ipa", {
    name: "Account", accountEmail: "download@example.invalid",
    iTunesMetadataBase64: b64.base64EncodeString(plist.buildPlist({ "apple-id": "old@example.invalid" })),
  });
  assert.strictEqual(record.accountEmail, "download@example.invalid");
  assert.strictEqual(loadLibrary().listFiles()[0].accountEmail, "download@example.invalid");
});

test("legacy sidecars recover account email from saved iTunes metadata with apple-id precedence", () => {
  directories.add("downloads");
  for (const [name, metadata, email] of [
    ["Apple", { "apple-id": " Apple@Example.Invalid ", userName: "other@example.invalid" }, "apple@example.invalid"],
    ["User", { userName: "User@Example.Invalid" }, "user@example.invalid"],
  ]) {
    const fileName = `${name}.ipa`;
    files.set(`downloads/${fileName}`, { bytes: [1] });
    files.set(`downloads/${fileName}.meta.json`, { string: JSON.stringify({
      fileName, iTunesMetadataBase64: b64.base64EncodeString(plist.buildPlist(metadata)),
    }) });
    assert.strictEqual(loadLibrary().listFiles().find(record => record.fileName === fileName).accountEmail, email);
  }
});

test("unknown imports and invalid account metadata never borrow the current account", () => {
  const library = loadLibrary();
  for (const [index, value] of [
    {},
    { accountEmail: { email: "wrong@example.invalid" } },
    { iTunesMetadataBase64: "bm90LXBsaXN0" },
    { iTunesMetadataBase64: b64.base64EncodeString(plist.buildPlist({ "apple-id": 12345, userName: "App Name" })) },
    { accountEmail: "bad\n@example.invalid" },
  ].entries()) {
    const record = library.save({ bytes: [1] }, { name: `Unknown ${index}`, ...value });
    assert.strictEqual(record.accountEmail, "");
  }
  files.set("downloads/Recovered.ipa", { bytes: [1] });
  assert.strictEqual(library.listFiles().find(record => record.fileName === "Recovered.ipa").accountEmail, "");
});

test("legacy account decoding is cached across list reads and responds to metadata changes", t => {
  directories.add("downloads");
  files.set("downloads/Legacy.ipa", { bytes: [1] });
  const writeLegacy = email => files.set("downloads/Legacy.ipa.meta.json", { string: JSON.stringify({
    fileName: "Legacy.ipa", iTunesMetadataBase64: b64.base64EncodeString(plist.buildPlist({ "apple-id": email })),
  }) });
  writeLegacy("first@example.invalid");
  const library = loadLibrary();
  const decode = t.mock.method(b64, "base64DecodeString");
  assert.strictEqual(library.listFiles()[0].accountEmail, "first@example.invalid");
  assert.strictEqual(library.listFiles()[0].accountEmail, "first@example.invalid");
  assert.strictEqual(decode.mock.callCount(), 1);
  writeLegacy("second@example.invalid");
  assert.strictEqual(library.listFiles()[0].accountEmail, "second@example.invalid");
  assert.strictEqual(decode.mock.callCount(), 2);
});

test("downloaded lookup matches app identity and the exact external version", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Demo 1.0", appId: "42", bundleId: "com.example.demo",
    version: "1.0", externalVersionId: "8001",
  });
  const app = { id: 42, bundleID: "com.example.demo", version: "2.0" };
  assert.strictEqual(library.findDownloaded(app, { externalVersionId: 8001 }).fileName, record.fileName);
  assert.strictEqual(library.findDownloaded(app, { externalVersionId: "8002", version: "1.0" }), null);
  assert.strictEqual(library.findDownloaded({ id: "43", bundleID: app.bundleID }, { externalVersionId: "8001" }), null);
  assert.strictEqual(library.findDownloaded({ id: "42", bundleID: "com.example.other" }, { externalVersionId: "8001" }), null);
});

test("downloaded lookup uses a real display version only when no version id is requested", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Demo", appId: "42", bundleId: "com.example.demo", version: "1.2.3",
  });
  assert.strictEqual(library.findDownloaded({ id: "42", version: "1.2.3" }).fileName, record.fileName);
  assert.strictEqual(library.findDownloaded({ bundleID: "com.example.demo", version: "1.2.3" }).fileName, record.fileName);
  assert.strictEqual(library.findDownloaded({ id: "42", version: "2.0" }), null);
  assert.strictEqual(library.findDownloaded({ id: "43", version: "1.2.3" }), null);
  assert.strictEqual(library.findDownloaded({ version: "1.2.3" }), null);
  assert.strictEqual(library.findDownloaded({ id: "42" }), null);
  assert.strictEqual(library.findDownloaded({ id: "42", version: "1.2.3" }, {}), null, "an unknown historical version must not borrow the app's latest version");
  assert.strictEqual(library.findDownloaded({ id: "42" }, { externalVersionId: "8001", version: "1.2.3" }), null, "display versions cannot prove a requested build id");
});

test("downloaded lookup ignores missing IPA files, partial downloads and untrusted versions", () => {
  const library = loadLibrary();
  const meta = { name: "Demo", appId: "42", bundleId: "com.example.demo", version: "1.0" };
  const record = library.save({ bytes: [1] }, meta);
  assert.ok(library.findDownloaded({ id: "42", version: "1.0" }));
  files.delete(library.filePath(record.fileName));
  assert.strictEqual(library.findDownloaded({ id: "42", version: "1.0" }), null);
  files.set(`${library.filePath(record.fileName)}.partial-1`, { bytes: [1] });
  directories.add(library.filePath(record.fileName));
  assert.strictEqual(library.findDownloaded({ id: "42", version: "1.0" }), null);
  library.save({ bytes: [1] }, { ...meta, name: "Recovered", recovered: true });
  library.save({ bytes: [1] }, { ...meta, name: "Unknown", version: "最新版" });
  library.save({ bytes: [1] }, { ...meta, name: "Build", version: "构建 8001" });
  assert.strictEqual(library.findDownloaded({ id: "42", version: "1.0" }), null);
  assert.strictEqual(library.findDownloaded({ id: "42", version: "最新版" }), null);
  assert.strictEqual(library.findDownloaded({ id: "42", version: "构建 8001" }), null);
});

test("version provenance survives sidecars and cannot turn unknown history into exact Open", () => {
  const library = loadLibrary();
  const original = library.save({ bytes: [1] }, {
    name: "Unknown history", appId: "42", bundleId: "com.example.demo",
    requestedExternalVersionId: "111", externalVersionId: "", version: "9.0",
    shortVersion: "", bundleVersion: "", packageVerified: true,
    metadataVerified: false, versionSource: "unknown",
  });
  const reloaded = library.listFiles().find(record => record.fileName === original.fileName);
  assert.strictEqual(reloaded.requestedExternalVersionId, "111");
  assert.strictEqual(reloaded.externalVersionId, "");
  assert.strictEqual(reloaded.shortVersion, "");
  assert.strictEqual(reloaded.metadataVerified, false);
  assert.strictEqual(reloaded.versionSource, "unknown");
  assert.strictEqual(library.findDownloaded({ id: "42" }, { externalVersionId: "111" }), null);
  assert.strictEqual(library.findDownloaded({ id: "42", version: "9.0" }), null);
  const injector = require("../scripts/services/ipa-injector");
  const copy = library.save({ bytes: [2] }, injector.injectedMeta(reloaded));
  const injected = library.listFiles().find(record => record.fileName === copy.fileName);
  assert.strictEqual(injected.requestedExternalVersionId, "111");
  assert.strictEqual(injected.metadataVerified, false);
  assert.strictEqual(injected.versionSource, "unknown");
  assert.strictEqual(injected.shortVersion, "");
  assert.strictEqual(library.findDownloaded({ id: "42", version: "9.0" }), null);
});

test("actual response IDs and readable IPA metadata survive original and injected sidecars", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Verified history", appId: "42", bundleId: "com.example.demo",
    requestedExternalVersionId: "111", externalVersionId: "111", version: "1.0",
    shortVersion: "1.0", bundleVersion: "100", packageVerified: true,
    metadataVerified: true, versionSource: "ipa",
  });
  const injector = require("../scripts/services/ipa-injector");
  library.save({ bytes: [2] }, injector.injectedMeta(library.listFiles()[0]));
  for (const item of library.listFiles()) {
    assert.strictEqual(item.requestedExternalVersionId, "111");
    assert.strictEqual(item.externalVersionId, "111");
    assert.strictEqual(item.metadataVerified, true);
    assert.strictEqual(item.versionSource, "ipa");
    assert.strictEqual(item.bundleVersion, "100");
  }
  assert.ok(library.findDownloaded({ id: "42" }, { externalVersionId: "111" }));
  assert.ok(library.findDownloaded({ id: "42", version: "1.0" }));
  assert.ok(record.fileName);
});

test("legacy records remain openable but never gain metadata verification", () => {
  const library = loadLibrary();
  library.save({ bytes: [1] }, { name: "Legacy", appId: "42", version: "1.0", packageVerified: true });
  const found = library.findDownloaded({ id: "42", version: "1.0" });
  assert.ok(found);
  assert.strictEqual(found.metadataVerified, false);
});

beforeEach(() => {
  files = new Map();
  directories = new Set();
  prefs = new Map();
  failingDeletePath = "";
  failingPrefKey = "";
  moves = [];
  global.$data = ({ string, bytes }) =>
    string !== undefined ? { string } : { bytes: bytes || [] };
  global.$prefs = {
    get: (key) => prefs.get(key),
    set: (key, value) => {
      if (key === failingPrefKey) return false;
      prefs.set(key, value);
      return true;
    },
  };
  global.$file = {
    exists: (path) => directories.has(path) || files.has(path),
    isDirectory: (path) => directories.has(path),
    mkdir: (path) => {
      directories.add(path);
      return true;
    },
    write: ({ path, data }) => {
      files.set(path, data);
      return true;
    },
    read: (path) => files.get(path),
    list: (dir) => {
      if (!directories.has(dir)) return null;
      const prefix = `${dir}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => path.slice(prefix.length));
    },
    move: ({ src, dst }) => {
      if (!files.has(src) || files.has(dst)) return false;
      files.set(dst, files.get(src));
      files.delete(src);
      moves.push({ src, dst });
      return true;
    },
    delete: (path) => (path === failingDeletePath ? false : files.delete(path)),
    absolutePath: (path) => `/sandbox/${path}`,
  };
  global.$share = { sheet: () => {} };
});

test("library saves atomically and never overwrites a same-name IPA", () => {
  const library = loadLibrary();
  const first = library.save({ bytes: [1] }, {
    name: "Demo 1.0",
    bundleId: "com.example.demo",
    version: "1.0",
    bundleVersion: "100",
  });
  const second = library.save({ bytes: [2] }, {
    name: "Demo 1.0",
    bundleId: "com.example.demo",
    version: "1.0",
    bundleVersion: "100",
  });

  assert.notStrictEqual(first.fileName, second.fileName);
  assert.ok(files.has(`downloads/${first.fileName}`));
  assert.ok(files.has(`downloads/${first.fileName}.meta.json`));
  assert.strictEqual(
    JSON.parse(asText(files.get(`downloads/${first.fileName}.meta.json`))).bundleVersion,
    "100"
  );
  assert.strictEqual(moves[0].dst, `downloads/${first.fileName}`);
  assert.strictEqual(moves[1].dst, `downloads/${first.fileName}.meta.json`);
  assert.strictEqual(library.listFiles().length, 2);
});

test("saveDownloadedFile moves a staged IPA into the library without rewriting it", () => {
  const library = loadLibrary();
  const staged = "cache/jasspp-ipa-staged.ipa";
  files.set(staged, { bytes: [1, 2, 3] });

  const record = library.saveDownloadedFile(staged, {
    name: "Demo 1.0",
    bundleId: "com.example.demo",
    version: "1.0",
    bundleVersion: "100",
    packageVerified: true,
  });

  // 源临时文件被 move（不再由调用方二次写盘），且没有留下孤儿源文件。
  assert.ok(!files.has(staged));
  assert.ok(files.has(`downloads/${record.fileName}`));
  assert.ok(files.has(`downloads/${record.fileName}.meta.json`));
  assert.strictEqual(moves[0].dst, `downloads/${record.fileName}`);
  assert.strictEqual(record.path, `downloads/${record.fileName}`);
  assert.strictEqual(
    JSON.parse(asText(files.get(`downloads/${record.fileName}.meta.json`))).packageVerified,
    true
  );
});

test("library sidecars retain validated SINF and iTunes metadata without plaintext passwords", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Artifacts",
    bundleId: "com.example.artifacts",
    bundleVersion: "42",
    packageVerified: true,
    packageAppPath: "Payload/Artifacts.app",
    sinfs: [{ id: 7, sinf: "aGk=" }],
    iTunesMetadataBase64: "PHBsaXN0Lz4=",
    password: "must-not-survive",
  });

  const stored = JSON.parse(
    asText(files.get(`downloads/${record.fileName}.meta.json`))
  );
  assert.deepStrictEqual(stored.sinfs, [{ id: "7", sinf: "aGk=" }]);
  assert.strictEqual(stored.iTunesMetadataBase64, "PHBsaXN0Lz4=");
  assert.strictEqual(stored.packageAppPath, "Payload/Artifacts.app");
  assert.strictEqual(Object.hasOwn(stored, "password"), false);
});

test("icons saved beside an IPA are exposed via records but not scanned as IPA", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "With Icon",
    bundleId: "com.example.withicon",
    version: "1.0",
  });

  assert.strictEqual(library.iconData(record.fileName), null);
  const iconPath = library.saveIcon(record.fileName, { bytes: [0x89, 0x50] });
  assert.strictEqual(iconPath, `downloads/${record.fileName}.icon`);
  assert.ok(files.has(`downloads/${record.fileName}.icon`));

  const records = library.listFiles();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].fileName, record.fileName);
  assert.strictEqual(records[0].iconPath, `downloads/${record.fileName}.icon`);
  assert.strictEqual(
    library.iconData(record.fileName),
    files.get(`downloads/${record.fileName}.icon`)
  );
});

test("removing an IPA also removes its icon sidecar", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Remove Iconed",
    bundleId: "com.example.removeiconed",
  });
  library.saveIcon(record.fileName, { bytes: [9, 8] });
  assert.ok(files.has(`downloads/${record.fileName}.icon`));

  library.remove(record.fileName);
  assert.ok(!files.has(`downloads/${record.fileName}`));
  assert.ok(!files.has(`downloads/${record.fileName}.meta.json`));
  assert.ok(!files.has(`downloads/${record.fileName}.icon`));
});

test("icon delete failure rolls back and keeps the IPA and metadata", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Icon Rollback",
    bundleId: "com.example.iconrollback",
  });
  library.saveIcon(record.fileName, { bytes: [7, 6] });
  failingDeletePath = `downloads/${record.fileName}.icon`;

  assert.throws(() => library.remove(record.fileName), /图标/);
  assert.ok(files.has(`downloads/${record.fileName}`));
  assert.ok(files.has(`downloads/${record.fileName}.meta.json`));
  assert.ok(files.has(`downloads/${record.fileName}.icon`));
});

test("share sends the IPA bytes with an App + version file name", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1, 2, 3] }, {
    name: "Demo 1.0",
    title: "Demo",
    version: "1.0",
    bundleId: "com.example.demo",
    bundleVersion: "1",
  });
  let shared = null;
  global.$share = { sheet: (options) => { shared = options; } };

  let result = "pending";
  library.share(record.fileName, (ok) => { result = ok; });

  assert.ok(shared);
  assert.strictEqual(shared.items.length, 1);
  assert.strictEqual(shared.items[0].name, "Demo 1.0.ipa");
  assert.strictEqual(shared.items[0].data, files.get(`downloads/${record.fileName}`));
  assert.strictEqual(result, "pending");
  shared.handler(true);
  assert.strictEqual(result, true);
});

test("share falls back to the on-disk name for recovered IPA", () => {
  directories.add("downloads");
  files.set("downloads/Loose.ipa", { bytes: [9] });
  const library = loadLibrary();
  let shared = null;
  global.$share = { sheet: (options) => { shared = options; } };

  library.share("Loose.ipa");

  assert.ok(shared);
  assert.strictEqual(shared.items[0].name, "Loose.ipa");
  assert.strictEqual(shared.items[0].data, files.get("downloads/Loose.ipa"));
});

test("library surfaces orphaned IPA files for recovery", () => {
  directories.add("downloads");
  files.set("downloads/Recovered.ipa", { bytes: [1, 2, 3] });
  const library = loadLibrary();

  const records = library.listFiles();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].fileName, "Recovered.ipa");
  assert.strictEqual(records[0].recovered, true);
});

test("library ignores directories masquerading as IPA files", () => {
  directories.add("downloads");
  directories.add("downloads/Fake.ipa");
  const library = loadLibrary();

  assert.deepStrictEqual(library.listFiles(), []);
  assert.throws(() => library.read("Fake.ipa"), /普通文件/);
  assert.throws(() => library.remove("Fake.ipa"), /普通文件/);
});

test("library rejects unsafe file names", () => {
  const library = loadLibrary();
  assert.throws(() => library.read("../secret.ipa"), /无效/);
  assert.throws(() => library.remove("folder/app.ipa"), /无效/);
});

test("failed IPA deletion leaves a visible recoverable file", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Keep Me",
    bundleId: "com.example.keep",
    bundleVersion: "1",
  });
  failingDeletePath = `downloads/${record.fileName}`;

  assert.throws(() => library.remove(record.fileName), /删除 IPA/);
  const remaining = library.listFiles();
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].fileName, record.fileName);
  assert.strictEqual(remaining[0].recovered, false);
  assert.ok(files.has(`downloads/${record.fileName}.meta.json`));
});

test("sidecar metadata cannot redirect actions to another physical IPA", () => {
  directories.add("downloads");
  files.set("downloads/Foo.ipa", { bytes: [1] });
  files.set("downloads/Bar.ipa", { bytes: [2] });
  files.set(
    "downloads/Foo.ipa.meta.json",
    { string: JSON.stringify({ fileName: "Bar.ipa", bundleId: "com.bad.alias" }) }
  );
  const library = loadLibrary();

  const records = library.listFiles();
  assert.deepStrictEqual(
    records.map((item) => item.fileName).sort(),
    ["Bar.ipa", "Foo.ipa"]
  );
  assert.strictEqual(
    records.find((item) => item.fileName === "Foo.ipa").recovered,
    true
  );
});

test("sidecar delete failure leaves the IPA and metadata untouched", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Keep Metadata",
    bundleId: "com.example.keepmeta",
    bundleVersion: "1",
  });
  failingDeletePath = `downloads/${record.fileName}.meta.json`;

  assert.throws(() => library.remove(record.fileName), /元数据/);
  assert.ok(files.has(`downloads/${record.fileName}`));
  assert.ok(files.has(`downloads/${record.fileName}.meta.json`));
});

test("legacy index write failure never deletes the IPA or sidecar", () => {
  const library = loadLibrary();
  const record = library.save({ bytes: [1] }, {
    name: "Keep Index",
    bundleId: "com.example.keepindex",
    bundleVersion: "1",
  });
  failingPrefKey = "jasspp.library.v1";

  assert.throws(() => library.remove(record.fileName), /索引/);
  assert.ok(files.has(`downloads/${record.fileName}`));
  assert.ok(files.has(`downloads/${record.fileName}.meta.json`));
});

test("library sidecars keep the injected flag for download-time SINF injection", () => {
  const library = loadLibrary();
  const record = library.saveDownloadedFile(
    (() => {
      const staged = "cache/jasspp-injected-test.ipa";
      files.set(staged, { bytes: [1, 2, 3] });
      return staged;
    })(),
    {
      name: "Demo 1.0",
      bundleId: "com.example.demo",
      bundleVersion: "100",
      packageVerified: true,
      sinfInjected: true,
    }
  );

  const stored = JSON.parse(
    asText(files.get(`downloads/${record.fileName}.meta.json`))
  );
  assert.strictEqual(stored.sinfInjected, true);
  const reloaded = library.listFiles().find((item) => item.fileName === record.fileName);
  assert.strictEqual(reloaded.sinfInjected, true);

  // 旧记录没有该字段时按 false 处理，不出现 undefined 写进 UI 判断。
  const legacy = library.save({ bytes: [1] }, { name: "Legacy" });
  assert.strictEqual(legacy.sinfInjected, false);
});
