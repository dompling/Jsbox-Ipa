const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const b64 = require("../scripts/lib/b64");
const injector = require("../scripts/services/ipa-injector");

function asText(data) {
  if (typeof data === "string") return data;
  if (data && typeof data.string === "string") return data.string;
  if (data && data.byteArray) return b64.base64DecodeString(b64.base64Encode(data.byteArray));
  if (data && data.bytes) return b64.base64DecodeString(b64.base64Encode(data.bytes));
  return "";
}

let files;
let dirs;
let prefs;
let moves;
let zipCalls;

function loadInjector() {
  delete require.cache[require.resolve("../scripts/services/ipa-injector")];
  delete require.cache[require.resolve("../scripts/store/library")];
  return require("../scripts/services/ipa-injector");
}

function installFs(initialEntries) {
  files = new Map();
  dirs = new Set();
  moves = [];
  zipCalls = [];
  for (const [rel, data] of Object.entries(initialEntries || {})) {
    const path = `downloads/${rel}`;
    files.set(path, data);
    dirs.add("downloads");
    dirs.add("cache");
  }
  global.$data = ({ string, bytes, byteArray }) =>
    string !== undefined
      ? { string }
      : byteArray !== undefined
        ? { byteArray }
        : { bytes: bytes || [] };
  global.$prefs = {
    get: () => prefs,
    set: (key, value) => {
      prefs = value;
      return true;
    },
  };
  global.$file = {
    exists: (path) => dirs.has(path) || files.has(path),
    isDirectory: (path) => dirs.has(path),
    mkdir: (path) => {
      dirs.add(path);
      return true;
    },
    write: ({ path, data }) => {
      files.set(path, data);
      return true;
    },
    read: (path) => files.get(path),
    list: (dir) => {
      if (!dirs.has(dir)) return null;
      const prefix = `${dir}/`;
      const names = new Set();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (rest && !rest.includes("/")) names.add(rest);
        }
      }
      for (const path of dirs.keys()) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (rest && !rest.includes("/")) names.add(rest);
        }
      }
      return [...names];
    },
    move: ({ src, dst }) => {
      if (!files.has(src) || files.has(dst)) return false;
      files.set(dst, files.get(src));
      files.delete(src);
      moves.push({ src, dst });
      return true;
    },
    delete: (path) => {
      if (files.has(path)) return files.delete(path);
      return dirs.delete(path);
    },
    absolutePath: (path) => `/sandbox/${path}`,
  };
  global.$archiver = {
    unzip: ({ path, dest, handler }) => {
      const entry = files.get(path);
      const entries = (entry && entry.zipEntries) || {};
      for (const [rel, data] of Object.entries(entries)) {
        let current = dest;
        const parts = rel.split("/");
        for (let i = 0; i < parts.length - 1; i++) {
          current = `${current}/${parts[i]}`;
          dirs.add(current);
        }
        files.set(`${dest}/${rel}`, data);
      }
      if (typeof handler === "function") handler(true);
    },
    zip: ({ directory, dest, handler }) => {
      const entries = [];
      const contents = {};
      const prefix = `${directory}/`;
      for (const [path, data] of files.keys ? files.entries() : []) {
        if (path.startsWith(prefix) && !files.get(path).__zipRoot) {
          const rel = path.slice(prefix.length);
          if (rel) {
            entries.push(rel);
            contents[rel] = files.get(path);
          }
        }
      }
      // 目录本身没有文件键，用显式快照记录一次调用现场。
      const snapshot = { directory, dest, entries, contents };
      zipCalls.push(snapshot);
      files.set(dest, { bytes: [0x50, 0x4b, 0x03, 0x04], zipEntries: snapshot });
      if (typeof handler === "function") handler(true);
    },
  };
}

beforeEach(() => {
  installFs();
  prefs = [];
});

test("supp file names become SC_Info sinf targets without version suffix", () => {
  assert.strictEqual(injector.sinfTargetFromSupp("Demo.v3.supp"), "SC_Info/Demo.sinf");
  assert.strictEqual(injector.sinfTargetFromSupp("Demo.supp"), "SC_Info/Demo.sinf");
  assert.strictEqual(injector.sinfTargetFromSupp("Demo.Extra.supp"), "SC_Info/Demo.Extra.sinf");
  assert.strictEqual(injector.sinfTargetFromSupp("not-a-supp"), "");
  assert.strictEqual(injector.sinfTargetFromExecutable("Demo App"), "SC_Info/Demo_App.sinf");
});

test("sinf relative paths are normalized and path traversal is rejected", () => {
  assert.strictEqual(injector.normalizeSinfRelPath("SC_Info/Demo.sinf"), "SC_Info/Demo.sinf");
  assert.strictEqual(injector.normalizeSinfRelPath("Demo.sinf"), "SC_Info/Demo.sinf");
  assert.strictEqual(injector.normalizeSinfRelPath("../Demo.sinf"), "");
  assert.strictEqual(injector.normalizeSinfRelPath("/SC_Info/Demo.sinf"), "");
  assert.strictEqual(injector.normalizeSinfRelPath("a/b/Demo.sinf"), "");
  assert.strictEqual(injector.normalizeSinfRelPath("SC_Info/Demo.plist"), "");
  assert.strictEqual(injector.normalizeSinfRelPath(""), "");
});

test("iTunesMetadata text is decoded and validated as plist XML", () => {
  const good = b64.base64EncodeString(
    '<?xml version="1.0"?><plist version="1.0"><dict><key>a</key><string>b</string></dict></plist>'
  );
  assert.ok(injector.decodeMetadataText(good).indexOf("<plist") >= 0);
  assert.strictEqual(injector.decodeMetadataText("bm90LXhzbA=="), "");
  assert.strictEqual(injector.decodeMetadataText(""), "");
});

test("injected record keeps identity and carries an SINF marker", () => {
  const meta = injector.injectedMeta({
    fileName: "Demo_1.0.ipa",
    appId: "123",
    bundleId: "com.example.demo",
    title: "Demo",
    version: "1.0",
    shortVersion: "1.0",
    bundleVersion: "100",
    accountEmail: "original@example.invalid",
    packageVerified: true,
    packageAppPath: "Payload/Demo.app",
  });
  assert.strictEqual(meta.title, "Demo（已注入SINF）");
  assert.strictEqual(meta.bundleId, "com.example.demo");
  assert.strictEqual(meta.bundleVersion, "100");
  assert.strictEqual(meta.accountEmail, "original@example.invalid");
  assert.strictEqual(meta.packageVerified, true);
  assert.strictEqual(meta.sinfInjected, true);
  assert.ok(meta.name.indexOf("已注入SINF") > 0);
});

test("full injection flow writes SINF and iTunesMetadata then saves a new IPA", async () => {
  const manifestXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>SinfPaths</key><array><string>SC_Info/Demo.sinf</string></array>",
    "</dict></plist>",
  ].join("");
  const sinfBase64 = b64.base64Encode([0x10, 0x20, 0x30, 0x40]);
  const metadataBase64 = b64.base64EncodeString(
    '<?xml version="1.0"?><plist version="1.0"><dict><key>itemName</key><string>Demo</string></dict></plist>'
  );

  installFs();
  // 先在库里放一个“已下载”记录：IPA + sidecar（含 sinfs / iTunesMetadata）。
  const original = {
    fileName: "Demo_1.0.ipa",
    appId: "123",
    bundleId: "com.example.demo",
    title: "Demo",
    version: "1.0",
    shortVersion: "1.0",
    bundleVersion: "100",
    size: 1024,
    createdAt: new Date().toISOString(),
    packageVerified: true,
    packageAppPath: "Payload/Demo.app",
    sinfs: [{ id: "1", sinf: sinfBase64 }],
    iTunesMetadataBase64: metadataBase64,
    accountEmail: "original@example.invalid",
  };
  files.set(
    "downloads/Demo_1.0.ipa",
    {
      bytes: [0x50, 0x4b, 0x03, 0x04],
      zipEntries: {
        "Payload/Demo.app/Info.plist": {
          string:
            '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.demo</string></dict></plist>',
        },
        "Payload/Demo.app/SC_Info/Manifest.plist": { string: manifestXml },
        "Payload/Demo.app/Demo": { bytes: [0xca, 0xfe, 0xba, 0xbe] },
      },
    }
  );
  files.set(
    "downloads/Demo_1.0.ipa.meta.json",
    { string: JSON.stringify(original) }
  );

  const injectorLib = loadInjector();
  const result = await injectorLib.injectAndSave(original);

  assert.strictEqual(result.sinfWrites, 1);
  assert.strictEqual(result.metadataInjected, true);
  assert.strictEqual(result.record.fileName, "Demo_1.0_已注入SINF.ipa");

  // 原文件保留，新文件入库。
  assert.ok(files.has("downloads/Demo_1.0.ipa"));
  assert.ok(files.has(`downloads/${result.record.fileName}`));
  const sidecar = JSON.parse(asText(files.get(`downloads/${result.record.fileName}.meta.json`)));
  assert.strictEqual(sidecar.title, "Demo（已注入SINF）");
  assert.strictEqual(sidecar.packageVerified, true);
  assert.strictEqual(sidecar.accountEmail, "original@example.invalid");

  // 重新打包时：SC_Info/Demo.sinf 与 iTunesMetadata.plist 都在包根的正确位置。
  assert.strictEqual(zipCalls.length, 1);
  const packed = zipCalls[0];
  const packedMap = new Map(packed.entries.map((rel) => [rel, packed.contents[rel]]));
  assert.ok(packedMap.has("Payload/Demo.app/SC_Info/Demo.sinf"));
  const sinfBytes = b64.base64Decode(
    b64.base64Encode(
      (packedMap.get("Payload/Demo.app/SC_Info/Demo.sinf").byteArray ||
        packedMap.get("Payload/Demo.app/SC_Info/Demo.sinf").bytes)
    )
  );
  assert.deepStrictEqual(sinfBytes, [0x10, 0x20, 0x30, 0x40]);
  assert.ok(packedMap.has("iTunesMetadata.plist"));
  assert.ok(asText(packedMap.get("iTunesMetadata.plist")).indexOf("<plist") >= 0);
});
