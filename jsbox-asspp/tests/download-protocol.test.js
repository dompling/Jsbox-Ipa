const { test } = require("node:test");
const assert = require("node:assert");

const http = require("../scripts/lib/http");
const plist = require("../scripts/lib/plist");
const download = require("../scripts/apple/download");

test("download info sends storefront and keeps scoped cookies", async () => {
  const original = http.sendWithRedirectRecovery;
  let captured;
  http.sendWithRedirectRecovery = async (options) => {
    captured = options;
    return {
      status: 200,
      finalUrl: options.url,
      headers: {
        "set-cookie": "fresh=1; Domain=.itunes.apple.com; Path=/; Secure",
      },
      body: plist.buildPlist({
        songList: [
          {
            URL: "https://cdn.example/app.ipa",
            sinfs: [{ id: 7, sinf: [1, 2, 3] }],
            metadata: {
              bundleShortVersionString: "1.2.3",
              bundleVersion: "123",
            },
          },
        ],
      }),
    };
  };
  try {
    const result = await download.getDownloadInfo(
      {
        deviceIdentifier: "001122334455",
        directoryServicesIdentifier: "123",
        passwordToken: "session-token",
        store: "CN",
        storeFrontId: "143465",
        cookies: [
          {
            name: "old",
            value: "1",
            domain: "itunes.apple.com",
            path: "/",
          },
        ],
      },
      { id: "42" }
    );
    assert.strictEqual(captured.headers["X-Apple-Store-Front"], "143465-1,29");
    assert.strictEqual(captured.headers["X-Token"], "session-token");
    assert.deepStrictEqual(
      captured.cookies.map((item) => item.name),
      ["old"]
    );
    assert.ok(result.updatedCookies.some((item) => item.name === "fresh"));
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("download fallback keeps the complete storefront header and avoids a duplicated pod prefix", async () => {
  const original = http.sendWithRedirectRecovery;
  let captured;
  let calls = 0;
  http.sendWithRedirectRecovery = async (options) => {
    captured = options;
    if (++calls === 1) {
      return { status: 200, finalUrl: options.url, headers: {}, body: plist.buildPlist({ failureType: "5002" }) };
    }
    return {
      status: 200,
      finalUrl: options.url,
      headers: {},
      body: plist.buildPlist({
        songList: [
          {
            URL: "https://cdn.example/app.ipa",
            sinfs: [{ id: 7, sinf: [1, 2, 3] }],
            metadata: { bundleVersion: "1" },
          },
        ],
      }),
    };
  };
  try {
    await download.getDownloadInfo(
      {
        deviceIdentifier: "001122334455",
        directoryServicesIdentifier: "123",
        passwordToken: "session-token",
        store: "CN",
        storeFrontHeader: "143465-1,29",
        pod: "p42",
        cookies: [],
      },
      { id: "42" }
    );
    assert.strictEqual(captured.url, "https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=001122334455");
    assert.strictEqual(calls, 2);
    assert.strictEqual(captured.headers["X-Apple-Store-Front"], "143465-1,29");
    assert.strictEqual(captured.headers["X-Token"], "session-token");
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});

test("version metadata keeps the external id separate from readable version fields", () => {
  const version = download.metadataFromDict(
    {
      songList: [
        {
          metadata: {
            softwareVersionExternalIdentifier: "813788990",
            bundleShortVersionString: "18.4.1",
            bundleVersion: "123456",
          },
        },
      ],
    },
    "813788990"
  );
  assert.deepStrictEqual(version, {
    id: "813788990",
    requestedExternalVersionId: "813788990",
    externalVersionId: "813788990",
    displayVersion: "18.4.1",
    buildVersion: "123456",
  });
  const unknown = download.metadataFromDict({ songList: [{ metadata: {} }] }, "813873796");
  assert.strictEqual(unknown.id, "813873796");
  assert.strictEqual(unknown.requestedExternalVersionId, "813873796");
  assert.strictEqual(unknown.externalVersionId, "");
  assert.strictEqual(unknown.displayVersion, "");
  assert.strictEqual(unknown.buildVersion, "");
});

test("version sorting pins latest, uses semantic order, and keeps unknown entries stable", () => {
  const sorted = download.sortVersions(
    [
      { id: "unknown-newer", displayVersion: "" },
      { id: "two-ten-a", displayVersion: "2.10" },
      { id: "ten", displayVersion: "10.0" },
      { id: "unknown-older", displayVersion: "version unavailable" },
      { id: "two-ten-b", displayVersion: "2.10.0" },
      { id: "prerelease", displayVersion: "10.0-beta.2" },
      { id: "latest", displayVersion: "1.0" },
    ],
    "latest"
  );

  assert.deepStrictEqual(
    sorted.map((item) => item.id),
    [
      "latest",
      "ten",
      "prerelease",
      "two-ten-a",
      "two-ten-b",
      "unknown-newer",
      "unknown-older",
    ]
  );
});

test("version listing returns every identifier and requests metadata sequentially", async () => {
  const original = http.sendWithRedirectRecovery;
  const identifiers = Array.from({ length: 35 }, (_value, index) =>
    String(800000000 + index)
  );
  const latestId = identifiers[identifiers.length - 1];
  const requestedVersionIds = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;

  http.sendWithRedirectRecovery = async (options) => {
    const payload = plist.parsePlist(options.body);
    const externalVersionId = String(payload.appExtVrsId || payload.externalVersionId || "");

    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await Promise.resolve();
    activeRequests -= 1;

    if (!externalVersionId) {
      return {
        status: 200,
        finalUrl: options.url,
        headers: {},
        body: plist.buildPlist({
          songList: [
            {
              URL: "https://cdn.example/app.ipa",
              sinfs: [{ id: 7, sinf: [1, 2, 3] }],
              metadata: {
                bundleShortVersionString: "35.0",
                bundleVersion: "350",
                softwareVersionExternalIdentifier: latestId,
                softwareVersionExternalIdentifiers: identifiers,
              },
            },
          ],
        }),
      };
    }

    requestedVersionIds.push(externalVersionId);
    const sourceIndex = identifiers.indexOf(externalVersionId);
    return {
      status: 200,
      finalUrl: options.url,
      headers: {},
      body: plist.buildPlist({
        songList: [
          {
            metadata: {
              bundleShortVersionString: `${sourceIndex + 1}.0`,
              bundleVersion: String((sourceIndex + 1) * 10),
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await download.listVersions(
      {
        deviceIdentifier: "001122334455",
        directoryServicesIdentifier: "123",
        passwordToken: "session-token",
        storeFrontId: "143465",
        cookies: [],
      },
      { id: "42" }
    );

    assert.deepStrictEqual(result.identifiers, identifiers);
    assert.strictEqual(result.versions.length, 35);
    assert.deepStrictEqual(
      result.versions.map((item) => item.id),
      identifiers.slice().reverse()
    );
    assert.deepStrictEqual(
      requestedVersionIds,
      identifiers.slice(0, -1).reverse()
    );
    assert.strictEqual(maxActiveRequests, 1);
  } finally {
    http.sendWithRedirectRecovery = original;
  }
});
