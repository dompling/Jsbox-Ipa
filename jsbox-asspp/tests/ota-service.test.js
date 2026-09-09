const { test } = require("node:test");
const assert = require("node:assert");

const ota = require("../scripts/services/ota");

test("OTA accepts only explicit loopback peer addresses", () => {
  for (const address of ["127.0.0.1", "127.0.0.1:50123", "::1", "[::1]:50123", "::ffff:127.0.0.1"]) {
    assert.strictEqual(ota.isLoopback(address), true, address);
  }
  for (const address of ["", "127.evil", "127.0.0.999", "192.168.1.20", "10.0.0.3", "example.com"]) {
    assert.strictEqual(ota.isLoopback(address), false, address || "empty address");
  }
});

test("OTA options reject traversal and prefer the real bundle version", () => {
  assert.throws(
    () => ota.normalizeOptions({ fileName: "../Demo.ipa", bundleId: "com.example.demo" }),
    /文件名/
  );
  const normalized = ota.normalizeOptions({
    fileName: "Demo.ipa",
    bundleId: "com.example.demo",
    version: "display-2.0",
    bundleVersion: "204",
    title: "Demo",
  });
  assert.strictEqual(normalized.version, "204");
  assert.throws(
    () => ota.normalizeOptions({ fileName: "Demo.ipa", bundleId: "com.example.demo" }),
    /版本/
  );
});

test("an openURL failure stops the temporary OTA server immediately", () => {
  const previousApp = global.$app;
  let stopped = 0;
  global.$app = {
    openURL: () => {
      throw new Error("cannot open");
    },
  };
  try {
    assert.throws(
      () =>
        ota.openInstallHandle({
          itmsUrl: "itms-services://example",
          stop: () => {
            stopped++;
          },
        }),
      /cannot open/
    );
    assert.strictEqual(stopped, 1);
  } finally {
    global.$app = previousApp;
  }
});

test("OTA follows IPA-Tool-3.0 Plist service metadata and fixed port", () => {
  const previousPrefs = global.$prefs;
  global.$prefs = { get: () => undefined, set: () => true };
  try {
    const url = ota.buildExternalInstallURL({
      fileName: "Demo 1.ipa",
      bundleId: "com.example.demo",
      version: "2.0.1",
      title: "Demo",
    });
    assert.match(url, /^itms-services:\/\/\?action=download-manifest&url=/);
    assert.match(decodeURIComponent(url), /api\.scripting\.fun\/ipa-plist/);
    const endpoint = decodeURIComponent(url.split("&url=")[1]);
    assert.match(endpoint, /name%3DDemo/);
    assert.match(endpoint, /fileName%3DDemo%201\.ipa/);
    assert.strictEqual(ota.PORT, 8000);
  } finally {
    global.$prefs = previousPrefs;
  }
});

function captureGlobals() {
  const keys = ["$file", "$app", "$prefs", "$server", "$http", "$delay"];
  const snapshot = {};
  for (const key of keys) {
    snapshot[key] = key in global ? global[key] : undefined;
  }
  return snapshot;
}

function restoreGlobals(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete global[key];
    else global[key] = value;
  }
}

function mockServerFactory(log) {
  global.$server = {
    new() {
      const events = {};
      const server = {
        index: 0,
        addHandler() {},
        listen(listeners) {
          for (const key of Object.keys(listeners || {})) events[key] = listeners[key];
        },
        start(options) {
          log.push(["start", server.index, options && options.port]);
          setTimeout(() => {
            if (events.didStart) events.didStart(server);
          }, 0);
        },
        stop() {
          log.push(["stop", server.index]);
          setTimeout(() => {
            if (events.didStop) events.didStop(server);
          }, 0);
        },
      };
      server.index = global.$server._instances.length;
      global.$server._instances.push(server);
      return server;
    },
    _instances: [],
  };
  return global.$server._instances;
}

function baseMocks(log) {
  global.$file = {
    exists: () => true,
    isDirectory: () => false,
    absolutePath: (path) => path,
  };
  global.$app = {
    openURL: () => {
      log.push(["open"]);
      return true;
    },
  };
  global.$prefs = { get: () => undefined, set: () => true };
  global.$delay = (seconds, callback) => {
    const record = { seconds, callback, invalidated: false };
    log.push(["delay", seconds]);
    return {
      invalidate() {
        record.invalidated = true;
      },
    };
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("OTA reuses the running fixed-port server for the same install request", async () => {
  const log = [];
  const snapshot = captureGlobals();
  try {
    baseMocks(log);
    mockServerFactory(log);
    const first = await ota.installToDevice({
      fileName: "Demo 1.ipa",
      bundleId: "com.example.demo",
      bundleVersion: "204",
      title: "Demo",
    });
    await flush();
    const second = await ota.installToDevice({
      fileName: "Demo 1.ipa",
      bundleId: "com.example.demo",
      bundleVersion: "204",
      title: "Demo",
    });
    await flush();
    assert.strictEqual(second, first);
    assert.strictEqual(log.filter((item) => item[0] === "start").length, 1);
    assert.strictEqual(log.filter((item) => item[0] === "open").length, 2);
  } finally {
    ota.stopActive();
    restoreGlobals(snapshot);
  }
});

test("OTA stops the previous server before binding the fixed port again", async () => {
  const log = [];
  const snapshot = captureGlobals();
  try {
    baseMocks(log);
    const instances = mockServerFactory(log);
    const first = await ota.installToDevice({
      fileName: "Demo 1.ipa",
      bundleId: "com.example.demo",
      bundleVersion: "204",
      title: "Demo",
    });
    await flush();
    const second = await ota.installToDevice({
      fileName: "Demo 2.ipa",
      bundleId: "com.example.two",
      bundleVersion: "205",
      title: "Demo Two",
    });
    await flush();
    assert.notStrictEqual(second, first);
    const stopIndex = log.findIndex(
      (item) => item[0] === "stop" && item[1] === instances.indexOf(first.server)
    );
    const startIndex = log.findIndex(
      (item) => item[0] === "start" && item[1] === instances.indexOf(second.server)
    );
    assert.ok(stopIndex >= 0, "previous server must be stopped");
    assert.ok(startIndex >= 0, "new server must be started");
    assert.ok(stopIndex < startIndex, "stop must happen before the new bind");
  } finally {
    ota.stopActive();
    restoreGlobals(snapshot);
  }
});

test("OTA reports an actionable error when port 8000 is held by another service", async () => {
  const snapshot = captureGlobals();
  try {
    global.$file = {
      exists: () => true,
      isDirectory: () => false,
      absolutePath: (path) => path,
    };
    global.$http = {
      request: (options) => {
        options.handler({ response: { statusCode: 404 } });
      },
    };
    await assert.rejects(
      () =>
        ota.installToDevice({
          fileName: "Demo 1.ipa",
          bundleId: "com.example.demo",
          bundleVersion: "204",
          title: "Demo",
        }),
      /已被其他服务占用/
    );
  } finally {
    ota.stopActive();
    restoreGlobals(snapshot);
  }
});

test("OTA treats a reachable manifest as started when didStart never fires", async () => {
  const log = [];
  const snapshot = captureGlobals();
  try {
    global.$file = {
      exists: () => true,
      isDirectory: () => false,
      absolutePath: (path) => path,
    };
    global.$app = {
      openURL: () => {
        log.push(["open"]);
        return true;
      },
    };
    global.$prefs = { get: () => undefined, set: () => true };
    global.$delay = (seconds, callback) => {
      const id = setTimeout(callback, seconds * 1000);
      return { invalidate: () => clearTimeout(id) };
    };
    global.$server = {
      new() {
        return {
          addHandler() {},
          listen() {},
          start() {
            log.push(["start"]);
          },
          stop() {
            log.push(["stop"]);
          },
        };
      },
    };
    global.$http = {
      request: (options) => {
        const url = String(options.url || "");
        if (url.indexOf("/__jasspp_ota_probe__") >= 0) {
          options.handler({ response: { statusCode: 0 }, error: new Error("refused") });
          return;
        }
        options.handler({
          response: { statusCode: url.indexOf("/manifest.plist") >= 0 ? 200 : 404 },
        });
      },
    };
    const handle = await ota.installToDevice({
      fileName: "Demo 1.ipa",
      bundleId: "com.example.demo",
      bundleVersion: "204",
      title: "Demo",
    });
    assert.ok(handle && handle.manifestUrl, "server must be considered started");
    assert.strictEqual(log.filter((item) => item[0] === "open").length, 1);
  } finally {
    ota.stopActive();
    restoreGlobals(snapshot);
  }
});
