const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("../scripts/lib/http");
const stream = require("../scripts/services/stream-download");
const purchase = require("../scripts/apple/purchase");
const plist = require("../scripts/lib/plist");
const { createCancellation, DownloadCancelledError } = require("../scripts/lib/cancellation");

const original = { http: global.$http, file: global.$file, delay: global.$delay };
const source = "https://cdn.example/app.ipa";
let files, directories, merges;

function response(options, data, headers, status = 200) {
  return {
    data,
    response: { statusCode: status, headers: headers || {}, url: options.url },
  };
}

function rangeResponse(options, total) {
  const range = /^bytes=(\d+)-(\d+)$/.exec(options.header.Range);
  assert.ok(range);
  const start = Number(range[1]), end = Number(range[2]);
  return response(options, { byteArray: new Uint8Array(end - start + 1) }, {
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Content-Length": String(end - start + 1),
  }, 206);
}

function observe(promise) {
  let result;
  const done = promise.then(
    value => (result = { value }),
    error => (result = { error })
  );
  return { done, get result() { return result; } };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function trackedCancellation() {
  const token = createCancellation();
  const subscribe = token.subscribe;
  let subscriptions = 0;
  token.subscribe = listener => {
    subscriptions++;
    const remove = subscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscriptions--;
      remove();
    };
  };
  return { token, get subscriptions() { return subscriptions; } };
}

function assertCancelled(result) {
  assert.equal(result && result.error && result.error.code, "download_cancelled");
}

beforeEach(() => {
  files = new Map();
  directories = new Set(["downloads"]);
  merges = [];
  global.$delay = (_seconds, callback) => callback();
  global.$file = {
    exists: path => directories.has(path) || files.has(path),
    isDirectory: path => directories.has(path),
    mkdir(path) { directories.add(path); return true; },
    write({ path, data }) { files.set(path, data); return true; },
    delete: path => files.delete(path),
    merge({ files: parts, dest }) {
      assert.ok(parts.every(path => files.has(path)));
      merges.push(dest);
      files.set(dest, { partCount: parts.length });
      return true;
    },
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    const name = "$" + key;
    if (value === undefined) delete global[name];
    else global[name] = value;
  }
});

test("an already cancelled HTTP operation never invokes a native request", async () => {
  const tracked = trackedCancellation();
  tracked.token.cancel();
  let requests = 0;
  global.$http = { request(options) { requests++; options.handler(response(options, "ok")); } };
  await assert.rejects(http.send({ url: source, cancellation: tracked.token }), { code: "download_cancelled" });
  assert.equal(requests, 0);
  assert.equal(tracked.subscriptions, 0);
});

for (const method of ["request", "download"]) {
  test(`${method} preserves the native receiver and cleans up after a synchronous response`, async () => {
    const tracked = trackedCancellation();
    let cancelCalls = 0, captured;
    const progress = [];
    global.$http = {
      [method](options) {
        assert.equal(this, global.$http);
        captured = options;
        options.progress(5, 10);
        options.handler(response(options, "ok"));
        return { cancel() { cancelCalls++; } };
      },
    };
    const result = await http.send({
      url: source, download: method === "download", cancellation: tracked.token,
      progress: (...values) => progress.push(values),
    });
    assert.equal(result.status, 200);
    assert.equal(tracked.subscriptions, 0);
    tracked.token.cancel();
    captured.progress(10, 10);
    captured.handler({ get data() { throw new Error("late response must be ignored"); } });
    assert.equal(cancelCalls, 0, "completed native operations are never cancelled");
    assert.deepEqual(progress, [[5, 10]]);
  });
}

for (const capability of ["absent", "throws", "false"]) {
  test(`cancel with a ${capability} native handle waits for the handler and ignores late data`, async () => {
    const tracked = trackedCancellation();
    let captured, cancelCalls = 0, dataReads = 0;
    const progress = [];
    const handle = {
      cancel() {
        assert.equal(this, handle);
        cancelCalls++;
        if (capability === "throws") throw new Error("unsupported native cancellation");
        return false;
      },
    };
    global.$http = {
      download(options) { captured = options; return capability === "absent" ? undefined : handle; },
    };
    const observed = observe(http.send({
      url: source, download: true, cancellation: tracked.token,
      progress: (...values) => progress.push(values),
    }));
    captured.progress(1, 10);
    tracked.token.cancel();
    captured.progress(9, 10);
    await flush();
    assert.equal(observed.result, undefined, "the in-flight operation has not drained yet");
    captured.handler({
      get data() { dataReads++; return "late IPA"; },
      response: { statusCode: 200, url: source, headers: {} },
    });
    assertCancelled(await observed.done);
    assert.equal(dataReads, 0);
    assert.equal(tracked.subscriptions, 0);
    assert.equal(cancelCalls, capability === "absent" ? 0 : 1);
    assert.deepEqual(progress, [[1, 10]]);
  });
}

test("a native cancel that succeeds can finish without a completion handler", async () => {
  const tracked = trackedCancellation();
  let captured, cancelCalls = 0;
  const handle = { cancel() { assert.equal(this, handle); cancelCalls++; } };
  global.$http = { download(options) { captured = options; return handle; } };
  const observed = observe(http.send({ url: source, download: true, cancellation: tracked.token }));
  tracked.token.cancel();
  await flush();
  assertCancelled(observed.result);
  assert.equal(cancelCalls, 1);
  assert.equal(tracked.subscriptions, 0);
  captured.handler({ get data() { throw new Error("late IPA must not be normalized"); } });
});

test("cancellation during native startup cancels the subsequently returned handle", async () => {
  const tracked = trackedCancellation();
  let cancelCalls = 0;
  global.$http = {
    download() {
      tracked.token.cancel();
      return { cancel() { cancelCalls++; } };
    },
  };
  const observed = observe(http.send({ url: source, download: true, cancellation: tracked.token }));
  await flush();
  assertCancelled(observed.result);
  assert.equal(cancelCalls, 1);
  assert.equal(tracked.subscriptions, 0);
});

test("cancellation before a native call returns no handle still waits for its handler", async () => {
  const tracked = trackedCancellation();
  let captured;
  global.$http = {
    download(options) { captured = options; tracked.token.cancel(); },
  };
  const observed = observe(http.send({ url: source, download: true, cancellation: tracked.token }));
  await flush();
  assert.equal(observed.result, undefined);
  captured.handler(response(captured, "late IPA"));
  assertCancelled(await observed.done);
  assert.equal(tracked.subscriptions, 0);
});

test("a handler invoked synchronously by cancel settles once and releases its subscription", async () => {
  const tracked = trackedCancellation();
  let captured;
  global.$http = {
    request(options) {
      captured = options;
      return { cancel() { captured.handler({ error: new Error("native task cancelled") }); } };
    },
  };
  const observed = observe(http.send({ url: source, cancellation: tracked.token }));
  tracked.token.cancel();
  await flush();
  assertCancelled(observed.result);
  assert.equal(tracked.subscriptions, 0);
});

test("native startup errors retain their identity and do not leak cancellation listeners", async () => {
  const tracked = trackedCancellation();
  const failure = new Error("native startup failed");
  global.$http = { request() { throw failure; } };
  await assert.rejects(http.send({ url: source, cancellation: tracked.token }), error => error === failure);
  assert.equal(tracked.subscriptions, 0);
});

test("response normalization errors release cancellation listeners", async () => {
  const tracked = trackedCancellation();
  const failure = new Error("native response became unavailable");
  global.$http = {
    request(options) { options.handler({ get data() { throw failure; } }); },
  };
  await assert.rejects(http.send({ url: source, cancellation: tracked.token }), error => error === failure);
  assert.equal(tracked.subscriptions, 0);
});

test("stopped redirect recovery returns the last response with cookies without replay or parsing", async () => {
  let requests = 0, active = true;
  global.$http = {
    request(options) {
      requests++;
      active = false;
      options.handler({
        data: "redirected request",
        response: {
          statusCode: 200, url: "https://p37-buy.itunes.apple.com/download",
          headers: { "Set-Cookie": "session=updated; Domain=.itunes.apple.com; Path=/" },
        },
      });
    },
  };
  const result = await http.sendWithRedirectRecovery({
    method: "POST", url: "https://buy.itunes.apple.com/download", body: "request",
    shouldContinue: () => active,
  }, () => { throw new Error("stopped response must not be parsed"); });
  assert.equal(requests, 1);
  assert.deepEqual(http.setCookiesFromResponse(result), ["session=updated; Domain=.itunes.apple.com; Path=/"]);
});

test("stopping redirect recovery does not bypass the existing response origin checks", async () => {
  for (const finalUrl of ["https://unrelated.example/download", "http://buy.itunes.apple.com/download", "invalid url"]) {
    let requests = 0;
    global.$http = {
      request(options) {
        requests++;
        options.handler({ data: "", response: { statusCode: 200, url: finalUrl, headers: {} } });
      },
    };
    await assert.rejects(http.sendWithRedirectRecovery({
      method: "POST", url: "https://buy.itunes.apple.com/download", body: "request", shouldContinue: () => false,
    }, () => false), /重定向/);
    assert.equal(requests, 1);
  }
});

for (const cancelAtResponse of [true, false]) {
  test(`real purchase protocol ${cancelAtResponse ? "cancels before" : "retains"} the 2059 GAME fallback and preserves cookies`, async () => {
    const token = createCancellation();
    const cookies = [{ name: "session", value: "before", domain: "itunes.apple.com", path: "/", secure: true }];
    const account = {
      deviceIdentifier: "001122334455", directoryServicesIdentifier: "123", passwordToken: "synthetic",
      store: "US", cookies,
    };
    const calls = [];
    global.$http = {
      request(options) {
        const payload = plist.parsePlist(options.body);
        calls.push({ pricing: payload.pricingParameters, cookie: options.header.Cookie });
        if (calls.length === 1) {
          if (cancelAtResponse) token.cancel();
          options.handler(response(options, plist.buildPlist({ failureType: "2059" }), {
            "Set-Cookie": "session=after; Domain=.itunes.apple.com; Path=/; Secure",
          }));
        } else {
          options.handler(response(options, plist.buildPlist({ jingleDocType: "purchaseSuccess", status: 0 })));
        }
      },
    };
    const promise = purchase.purchaseApp(account, { id: "42", price: 0 }, {
      shouldContinue: () => !token.cancelled,
    });
    if (cancelAtResponse) {
      await assert.rejects(promise, error => {
        assert.equal(error.code, "download_cancelled");
        assert.equal(error.needsAppStore, false);
        assert.equal(error.updatedCookies.find(cookie => cookie.name === "session").value, "after");
        return true;
      });
      assert.deepEqual(calls, [{ pricing: "STDQ", cookie: "session=before" }]);
    } else {
      const result = await promise;
      assert.equal(result.updatedCookies.find(cookie => cookie.name === "session").value, "after");
      assert.deepEqual(calls, [
        { pricing: "STDQ", cookie: "session=before" }, { pricing: "GAME", cookie: "session=after" },
      ]);
    }
    assert.equal(account.cookies[0].value, "before", "the protocol hands cookies back without mutating account storage");
  });
}

test("an already cancelled stream never starts HEAD or reports a full-download fallback", async () => {
  const token = createCancellation();
  token.cancel();
  let requests = 0;
  global.$http = { request() { requests++; } };
  await assert.rejects(stream.tryChunkedDownload({ downloadURL: source }, null, {
    chunkDownload: false, cancellation: token,
  }), { code: "download_cancelled" });
  delete global.$file.merge;
  await assert.rejects(stream.downloadChunked(source, 10, null, { cancellation: token }), { code: "download_cancelled" });
  assert.equal(requests, 0);
});

test("HEAD cancellation waits for its native response and cannot fall back to a full download", async () => {
  const tracked = trackedCancellation();
  let captured;
  global.$http = { request(options) { captured = options; } };
  const observed = observe(stream.tryChunkedDownload({ downloadURL: source }, null, { cancellation: tracked.token }));
  assert.equal(captured.method, "HEAD");
  tracked.token.cancel();
  await flush();
  assert.equal(observed.result, undefined);
  captured.handler(response(captured, "", { "Content-Length": "10" }));
  assertCancelled(await observed.done);
  assert.equal(tracked.subscriptions, 0);
  assert.equal(files.size, 0);
});

test("HEAD metadata preserves cancellation into range requests", async () => {
  const tracked = trackedCancellation();
  let captured, requests = 0;
  global.$http = {
    request(options) {
      requests++;
      options.handler(response(options, "", {
        "Content-Length": String(stream.CHUNK_THRESHOLD_BYTES), "Accept-Ranges": "bytes", ETag: '"head-v1"',
      }));
    },
    download(options) { captured = options; requests++; },
  };
  const observed = observe(stream.tryChunkedDownload({ downloadURL: source }, null, { cancellation: tracked.token }));
  await flush();
  assert.ok(captured);
  assert.equal(captured.header["If-Match"], '"head-v1"');
  tracked.token.cancel();
  captured.handler(rangeResponse(captured, stream.CHUNK_THRESHOLD_BYTES));
  await flush();
  assertCancelled(observed.result);
  assert.equal(requests, 2);
  assert.equal(tracked.subscriptions, 0);
  assert.equal(files.size, 0);
  assert.equal(merges.length, 0);
});

test("cancelling from progress removes written parts and never requests the next range", async () => {
  const token = createCancellation();
  const total = stream.CHUNK_SIZE + 5;
  let requests = 0, progressCalls = 0;
  global.$http = { download(options) { requests++; options.handler(rangeResponse(options, total)); } };
  await assert.rejects(stream.downloadChunked(source, total, () => {
    progressCalls++;
    assert.equal(files.size, 1);
    token.cancel();
  }, { cancellation: token }), { code: "download_cancelled" });
  assert.equal(requests, 1);
  assert.equal(progressCalls, 1);
  assert.equal(files.size, 0);
  assert.equal(merges.length, 0);
});

test("cancelling an active later range drains it and removes the earlier parts", async () => {
  const token = createCancellation();
  const total = stream.CHUNK_SIZE + 5;
  let captured, requests = 0;
  global.$http = {
    download(options) {
      requests++;
      if (requests === 1) options.handler(rangeResponse(options, total));
      else captured = options;
    },
  };
  const observed = observe(stream.downloadChunked(source, total, null, { cancellation: token }));
  await flush();
  assert.equal(files.size, 1);
  assert.equal(requests, 2);
  token.cancel();
  await flush();
  assert.equal(observed.result, undefined);
  captured.handler(rangeResponse(captured, total));
  assertCancelled(await observed.done);
  assert.equal(files.size, 0);
  assert.equal(merges.length, 0);
  assert.equal(requests, 2);
});

test("cancelling during retry backoff finishes without waiting or retrying", async () => {
  const tracked = trackedCancellation();
  let retryCallback, requests = 0;
  global.$delay = (_seconds, callback) => { retryCallback = callback; };
  global.$http = {
    download(options) { requests++; options.handler({ error: new Error("connection reset") }); },
  };
  const observed = observe(stream.downloadChunked(source, 10, null, { cancellation: tracked.token }));
  await flush();
  assert.equal(typeof retryCallback, "function");
  tracked.token.cancel();
  await flush();
  assertCancelled(observed.result);
  assert.equal(tracked.subscriptions, 0);
  retryCallback();
  await flush();
  assert.equal(requests, 1);
  assert.equal(files.size, 0);
});

test("a retried range retains cancellation until its native handler drains", async () => {
  const tracked = trackedCancellation();
  let captured, requests = 0;
  global.$http = {
    download(options) {
      requests++;
      if (requests === 1) options.handler({ error: new Error("connection reset") });
      else captured = options;
    },
  };
  const observed = observe(stream.downloadChunked(source, 10, null, { cancellation: tracked.token }));
  await flush();
  assert.equal(requests, 2);
  tracked.token.cancel();
  await flush();
  assert.equal(observed.result, undefined);
  captured.handler(rangeResponse(captured, 10));
  assertCancelled(await observed.done);
  assert.equal(tracked.subscriptions, 0);
  assert.equal(requests, 2);
  assert.equal(files.size, 0);
});

test("cancellation during merge cleans the destination as well as the parts", async () => {
  const token = createCancellation();
  global.$http = { download(options) { options.handler(rangeResponse(options, 10)); } };
  global.$file.merge = ({ dest }) => { files.set(dest, { partial: true }); token.cancel(); return true; };
  await assert.rejects(stream.downloadChunked(source, 10, null, { cancellation: token }), { code: "download_cancelled" });
  assert.equal(files.size, 0);
});

for (const operation of ["probe", "downloadChunked", "tryChunkedDownload"]) {
  for (const mode of ["throw", "callback"]) {
    test(`${operation} preserves a ${mode} cancellation error without retry or conversion`, async () => {
      const failure = new DownloadCancelledError();
      let requests = 0;
      function respond(options) {
        requests++;
        if (mode === "throw") throw failure;
        options.handler({ error: failure });
      }
      global.$http = { request: respond, download: respond };
      const promise = operation === "probe" ? stream.probe(source)
        : operation === "downloadChunked" ? stream.downloadChunked(source, 10)
        : stream.tryChunkedDownload({ downloadURL: source });
      await assert.rejects(promise, error => error === failure);
      assert.equal(requests, 1);
      assert.equal(files.size, 0);
    });
  }
}
