const { test } = require("node:test");
const assert = require("node:assert");

const validator = require("../scripts/services/ipa-validator");

function zipFixture() {
  const bytes = new Array(8192).fill(0);
  bytes.splice(0, 4, 0x50, 0x4b, 0x03, 0x04);
  bytes.splice(bytes.length - 22, 4, 0x50, 0x4b, 0x05, 0x06);
  return { byteArray: bytes };
}

test("IPA validator rejects opaque/corrupt data before it can enter the library", async () => {
  await assert.rejects(
    validator.validateDownloadedIpa({ byteArray: new Array(8192).fill(0) }),
    /ZIP\/IPA/
  );
  const result = await validator.validateDownloadedIpa(zipFixture());
  assert.strictEqual(result.verified, false);
});

test("IPA license artifacts are bounded and normalized before sidecar storage", () => {
  const result = validator.normalizeArtifacts(
    [
      { id: 1, sinf: "aGk=\n" },
      { id: null, sinf: "aGk=" },
      { id: 2, sinf: "not base64!" },
    ],
    "PGh0bWw+PC9odG1sPg==\n"
  );
  assert.deepStrictEqual(result.sinfs, [{ id: "1", sinf: "aGk=" }]);
  assert.strictEqual(result.iTunesMetadataBase64, "PGh0bWw+PC9odG1sPg==");
});

test("stageDownloadedData writes a unique temporary IPA file and returns its path", () => {
  const previousFile = global.$file;
  const previousArchiver = global.$archiver;
  const written = [];
  const dirs = new Set(["cache"]);
  global.$file = {
    exists: (path) => dirs.has(path) || written.some((w) => w.path === path),
    isDirectory: (path) => dirs.has(path),
    mkdir: (path) => {
      dirs.add(path);
      return true;
    },
    write: ({ path, data }) => {
      written.push({ path, data });
      return true;
    },
  };
  delete global.$archiver;
  try {
    const path = validator.stageDownloadedData({ bytes: [1, 2, 3] });
    assert.ok(/^cache\/jasspp-ipa-[0-9]+-[0-9]+\.ipa$/.test(path));
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].path, path);
  } finally {
    if (previousFile === undefined) delete global.$file;
    else global.$file = previousFile;
    if (previousArchiver === undefined) delete global.$archiver;
    else global.$archiver = previousArchiver;
  }
});

test("validateDownloadedFile fails closed when archiver or source file is missing", async () => {
  const previousFile = global.$file;
  const previousArchiver = global.$archiver;
  delete global.$archiver;
  global.$file = {
    exists: (path) => path === "cache/missing.ipa",
    isDirectory: () => false,
  };
  try {
    await assert.rejects(
      validator.validateDownloadedFile("cache/missing.ipa", {}),
      /从磁盘校验 IPA/
    );
  } finally {
    if (previousFile === undefined) delete global.$file;
    else global.$file = previousFile;
    if (previousArchiver === undefined) delete global.$archiver;
    else global.$archiver = previousArchiver;
  }
});

test("IPA structure and readable metadata are distinct, with actual versions independent of stale API fields", async (t) => {
  const plist = require("../scripts/lib/plist");
  const previousFile = global.$file, previousArchiver = global.$archiver;
  const dirs = new Set(["cache"]);
  const files = new Map([["cache/demo.ipa", {}]]);
  let contents = { string: plist.buildPlist({ CFBundleIdentifier: "com.example.demo", CFBundleShortVersionString: "1.0", CFBundleVersion: "100" }) };
  global.$file = {
    exists: path => dirs.has(path) || files.has(path), isDirectory: path => dirs.has(path),
    mkdir: path => { dirs.add(path); return true; }, read: path => files.get(path),
    delete: path => files.delete(path) || dirs.delete(path),
    list: path => [...dirs, ...files.keys()].filter(name => name.startsWith(path + "/") && !name.slice(path.length + 1).includes("/")).map(name => name.slice(path.length + 1)),
  };
  global.$archiver = { unzip: ({ dest }) => {
    dirs.add(dest + "/Payload"); dirs.add(dest + "/Payload/Demo.app");
    files.set(dest + "/Payload/Demo.app/Info.plist", contents);
    return true;
  } };
  t.after(() => { global.$file = previousFile; global.$archiver = previousArchiver; });
  const result = await validator.validateDownloadedFile("cache/demo.ipa", { bundleId: "com.example.demo", shortVersion: "9.0", bundleVersion: "900" });
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.metadataReadable, true);
  assert.strictEqual(result.metadataVerified, true);
  assert.strictEqual(result.shortVersion, "1.0");
  assert.strictEqual(result.bundleVersion, "100");
  await assert.rejects(validator.validateDownloadedFile("cache/demo.ipa", { bundleId: "com.example.other" }), /Bundle ID/);
  for (const bundleId of [undefined, true, 42, ["com.example.demo"], { unexpected: "com.example.demo" }]) {
    const metadata = { CFBundleShortVersionString: "1.0", CFBundleVersion: "100" };
    if (bundleId !== undefined) metadata.CFBundleIdentifier = bundleId;
    contents = { string: plist.buildPlist(metadata) };
    await assert.rejects(validator.validateDownloadedFile("cache/demo.ipa", { bundleId: "com.example.demo" }), /Bundle ID/);
  }
  contents = { string: "bplist00", byteArray: [98, 112, 108, 105, 115, 116, 48, 48] };
  const binary = await validator.validateDownloadedFile("cache/demo.ipa", { bundleId: "com.example.demo" });
  assert.strictEqual(binary.verified, true);
  assert.strictEqual(binary.metadataReadable, false);
  assert.strictEqual(binary.metadataVerified, false);
  assert.strictEqual(binary.shortVersion, "");
  assert.strictEqual(binary.bundleVersion, "");
});
