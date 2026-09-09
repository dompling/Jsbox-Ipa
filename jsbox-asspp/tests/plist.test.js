const { test } = require("node:test");
const assert = require("node:assert");
const plist = require("../scripts/lib/plist");

test("buildPlist produces valid XML with proper root attribute", () => {
  const xml = plist.buildPlist({ a: "1", b: 2, ok: true });
  assert.match(xml, /^<\?xml version="1.0"/);
  assert.match(xml, /<plist version="1.0">/);
  assert.match(xml, /<key>a<\/key><string>1<\/string>/);
  assert.match(xml, /<key>b<\/key><integer>2<\/integer>/);
  assert.match(xml, /<key>ok<\/key><true\/>/);
});

test("roundtrip nested structures", () => {
  const data = {
    appleId: "user@example.com",
    attempt: "4",
    guid: "a1b2c3d4e5f6",
    password: "secret",
    rmp: "0",
    why: "signIn",
    flags: [1, 2.5, false, "x"],
    nested: { empty: "", n: null },
  };
  const xml = plist.buildPlist(data);
  const parsed = plist.parsePlist(xml);
  assert.strictEqual(parsed.appleId, "user@example.com");
  assert.strictEqual(parsed.attempt, "4");
  assert.strictEqual(parsed.guid, "a1b2c3d4e5f6");
  assert.strictEqual(parsed.rmp, "0");
  assert.strictEqual(parsed.why, "signIn");
  assert.deepStrictEqual(parsed.flags, [1, 2.5, false, "x"]);
  assert.strictEqual(parsed.nested.empty, "");
});

test("parse realistic login plist", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>passwordToken</key>
  <string>abc123==</string>
  <key>dsPersonId</key>
  <integer>123456789</integer>
  <key>accountInfo</key>
  <dict>
    <key>appleId</key>
    <string>me@example.com</string>
    <key>address</key>
    <dict>
      <key>firstName</key>
      <string>Tom</string>
      <key>lastName</key>
      <string>Lee</string>
    </dict>
  </dict>
</dict>
</plist>`;
  const parsed = plist.parsePlist(xml);
  assert.strictEqual(parsed.passwordToken, "abc123==");
  assert.strictEqual(parsed.dsPersonId, 123456789);
  assert.strictEqual(parsed.accountInfo.appleId, "me@example.com");
  assert.strictEqual(parsed.accountInfo.address.firstName, "Tom");
});

test("parse data element into bytes", () => {
  const xml = plist.buildPlist({ sinf: "aGVsbG8=" });
  // buildPlist 把 string 写为 <string>，这里手工构造 <data>
  const xml2 =
    '<plist version="1.0"><dict><key>sinf</key><data>aGVsbG8=</data></dict></plist>';
  const parsed = plist.parsePlist(xml2);
  assert.deepStrictEqual(parsed.sinf, [104, 101, 108, 108, 111]);
  assert.ok(xml.indexOf("<data>") < 0);
});

test("parse array of dicts (songList shape)", () => {
  const xml = `<plist version="1.0"><dict>
    <key>songList</key>
    <array>
      <dict>
        <key>URL</key>
        <string>https://iosapps.itunes.apple.com/itunes-assets/1.ipa</string>
        <key>sinfs</key>
        <array>
          <dict>
            <key>id</key><integer>1</integer>
            <key>sinf</key><data>aGk=</data>
          </dict>
        </array>
        <key>metadata</key>
        <dict>
          <key>bundleShortVersionString</key><string>1.2.3</string>
          <key>softwareVersionExternalIdentifiers</key>
          <array><integer>830000001</integer><integer>830000000</integer></array>
        </dict>
      </dict>
    </array>
  </dict></plist>`;
  const parsed = plist.parsePlist(xml);
  const item = parsed.songList[0];
  assert.strictEqual(item.URL, "https://iosapps.itunes.apple.com/itunes-assets/1.ipa");
  assert.strictEqual(item.sinfs[0].id, 1);
  assert.deepStrictEqual(item.sinfs[0].sinf, [104, 105]);
  assert.deepStrictEqual(
    item.metadata.softwareVersionExternalIdentifiers,
    [830000001, 830000000]
  );
  assert.strictEqual(item.metadata.bundleShortVersionString, "1.2.3");
});

test("looksLikePlist detects real plist vs html", () => {
  assert.strictEqual(
    plist.looksLikePlist('<plist version="1.0"><dict/></plist>'),
    true
  );
  assert.strictEqual(plist.looksLikePlist("<!DOCTYPE html><html>403</html>"), false);
  assert.strictEqual(plist.looksLikePlist(""), false);
});

test("parse self-closing containers and preserve string whitespace", () => {
  const parsed = plist.parsePlist(
    '<plist version="1.0"><dict><key>dict</key><dict/><key>array</key><array/><key>text</key><string>  keep me  </string><key>empty</key><string/></dict></plist>'
  );
  assert.deepStrictEqual(parsed.dict, {});
  assert.deepStrictEqual(parsed.array, []);
  assert.strictEqual(parsed.text, "  keep me  ");
  assert.strictEqual(parsed.empty, "");
});
