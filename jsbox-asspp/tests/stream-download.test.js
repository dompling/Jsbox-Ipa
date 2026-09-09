const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const stream = require("../scripts/services/stream-download");
const http = require("../scripts/lib/http");
const originalSend = http.send;
const originalFile = global.$file;
const originalDelay = global.$delay;
let files, dirs, merges, httpCalls;

function dataBytes(size) {
  return { byteArray: new Uint8Array(size) };
}

function rangeResponse(options, total, extraHeaders) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
  assert.ok(match, "request contains one explicit byte range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  return {
    status: 206, finalUrl: options.url, rawData: dataBytes(end - start + 1),
    headers: {
      "content-range": "bytes " + start + "-" + end + "/" + total,
      "content-length": String(end - start + 1),
      ...extraHeaders,
    },
  };
}

function setServer(handler) {
  http.send = async (options) => {
    httpCalls.push(options);
    return handler(options, httpCalls.length - 1);
  };
}

beforeEach(() => {
  files = new Map();
  dirs = new Set(["downloads"]);
  merges = [];
  httpCalls = [];
  global.$delay = (_seconds, callback) => callback();
  global.$file = {
    exists: (path) => dirs.has(path) || files.has(path),
    isDirectory: (path) => dirs.has(path),
    mkdir: (path) => { dirs.add(path); return true; },
    write: ({ path, data }) => { files.set(path, data); return true; },
    delete: (path) => files.delete(path),
    merge: ({ files: partFiles, dest, chunkSize }) => {
      assert.ok(partFiles.every((path) => files.has(path)));
      merges.push({ partFiles, dest, chunkSize });
      files.set(dest, { parts: partFiles.length });
      return true;
    },
  };
  setServer((options) => options.method === "HEAD" ? {
    status: 200,
    headers: { "accept-ranges": "bytes", "content-length": "3000000" },
    finalUrl: options.url,
  } : rangeResponse(options, 100));
});

afterEach(() => {
  http.send = originalSend;
  global.$file = originalFile;
  global.$delay = originalDelay;
});

test("probe requires successful HEAD, advertised ranges and an integer length", async () => {
  const valid = await stream.probe("https://cdn.example/app.ipa");
  assert.equal(valid.length, 3000000);
  assert.equal(httpCalls[0].headers["Accept-Encoding"], "identity");
  for (const response of [
    { headers: { "accept-ranges": "bytes", "content-length": "3000000" } },
    { status: "invalid", headers: { "accept-ranges": "bytes", "content-length": "3000000" } },
    { status: 503, headers: { "accept-ranges": "bytes", "content-length": "3000000" } },
    { status: 200, headers: { "accept-ranges": "none", "content-length": "3000000" } },
    ...["0", "-1", "1.5", "1e8", "Infinity", "9007199254740992"].map((length) => ({
      status: 200, headers: { "accept-ranges": "bytes", "content-length": length },
    })),
  ]) {
    setServer(() => ({ ...response, finalUrl: "https://cdn.example/app.ipa" }));
    assert.equal(await stream.probe("https://cdn.example/app.ipa"), null);
  }
});

test("small, disabled and unsupported-runtime downloads retain nonfatal fallback", async () => {
  const small = await stream.tryChunkedDownload({ downloadURL: "https://cdn.example/app.ipa" });
  assert.equal(small.reason, "too-small");
  assert.notEqual(small.fatal, true);
  const disabled = await stream.tryChunkedDownload({}, null, { chunkDownload: false });
  assert.equal(disabled.reason, "disabled");
  assert.notEqual(disabled.fatal, true);
  delete global.$file.merge;
  const unsupported = await stream.tryChunkedDownload({ downloadURL: "https://cdn.example/app.ipa" });
  assert.equal(unsupported.reason, "no-file-merge");
  assert.notEqual(unsupported.fatal, true);
});

test("valid ranges merge in order, report actual progress and remove all parts", async () => {
  const total = stream.CHUNK_SIZE + 7;
  const progress = [];
  setServer((options) => rangeResponse(options, total));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", total, (written, all) => progress.push([written, all]));
  assert.equal(result.ok, true);
  assert.equal(result.size, total);
  assert.deepEqual(httpCalls.map((call) => call.headers.Range), [
    "bytes=0-" + (stream.CHUNK_SIZE - 1), "bytes=" + stream.CHUNK_SIZE + "-" + (total - 1),
  ]);
  assert.ok(httpCalls.every((call) => call.headers["Accept-Encoding"] === "identity"));
  assert.deepEqual(progress, [[stream.CHUNK_SIZE, total], [total, total]]);
  assert.equal(merges.length, 1);
  assert.deepEqual([...files.keys()], [result.path]);
});

test("native byteArray length is checked rather than trusting response headers", async () => {
  let reads = 0;
  setServer((options) => ({
    ...rangeResponse(options, 100),
    rawData: { get byteArray() { reads += 1; return [1, 2]; } },
  }));
  const progress = [];
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100, (...args) => progress.push(args));
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(reads, 1);
  assert.deepEqual(progress, []);
  assert.equal(files.size, 0);
});

for (const range of [undefined, "bytes 1-99/100", "bytes 0-98/100", "bytes 0-99/101", "bytes 0-99/*", "bytes */100", "garbage"]) {
  test("mismatched or missing Content-Range is fatal: " + range, async () => {
    setServer((options) => rangeResponse(options, 100, { "content-range": range }));
    const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(httpCalls.length, 1, "invalid protocol data is not retried");
    assert.equal(files.size, 0);
    assert.equal(merges.length, 0);
  });
}

for (const size of [99, 101]) {
  test("a " + size + "-byte body cannot satisfy a 100-byte range", async () => {
    setServer((options) => ({ ...rangeResponse(options, 100), rawData: dataBytes(size) }));
    const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(files.size, 0);
    assert.equal(httpCalls.length, 1);
  });
}

for (const headers of [
  { "content-length": "99" }, { "content-length": "invalid" }, { "content-encoding": "gzip" },
  { "content-type": "multipart/byteranges; boundary=example" }, { "content-type": "text/html" },
  { "content-type": "application/json" },
]) {
  test("range representation must be consistent: " + JSON.stringify(headers), async () => {
    setServer((options) => rangeResponse(options, 100, headers));
    const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(files.size, 0);
  });
}

for (const status of [200, 412, 416]) {
  test("HTTP " + status + " on a range is fatal, never a full-download fallback", async () => {
    setServer((options) => ({ ...rangeResponse(options, 100), status }));
    const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(httpCalls.length, 1);
    assert.equal(files.size, 0);
  });
}

test("strong ETag guards every chunk and a changed representation removes prior parts", async () => {
  const total = stream.CHUNK_SIZE + 3;
  const progress = [];
  setServer((options, index) => rangeResponse(options, total, { etag: index ? '"v2"' : '"v1"' }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", total, (written) => progress.push(written), { etag: '"v1"' });
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.ok(httpCalls.every((call) => call.headers["If-Match"] === '"v1"'));
  assert.ok(httpCalls.every((call) => call.headers["If-Range"] === undefined));
  assert.deepEqual(progress, [stream.CHUNK_SIZE]);
  assert.equal(files.size, 0);
});

test("a strong ETag learned on the first chunk guards subsequent requests", async () => {
  const total = stream.CHUNK_SIZE + 3;
  setServer((options) => rangeResponse(options, total, { etag: '"first-response"' }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", total);
  assert.equal(result.ok, true);
  assert.equal(httpCalls[0].headers["If-Match"], undefined);
  assert.equal(httpCalls[1].headers["If-Match"], '"first-response"');
});

test("weak ETags are not sent as If-Match or If-Range validators", async () => {
  setServer((options) => rangeResponse(options, 100, { etag: 'W/"v1"' }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100, null, { etag: 'W/"v1"' });
  assert.equal(result.ok, true);
  assert.equal(httpCalls[0].headers["If-Match"], undefined);
  assert.equal(httpCalls[0].headers["If-Range"], undefined);
});

test("changed Last-Modified is rejected when no strong validator is available", async () => {
  setServer((options) => rangeResponse(options, 100, { "last-modified": "Tue, 08 Sep 2026 02:00:00 GMT" }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100, null, { lastModified: "Tue, 08 Sep 2026 01:00:00 GMT" });
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
});

test("HEAD redirects to HTTP or credentials are fatal before any GET", async () => {
  for (const finalUrl of ["http://cdn.example/app.ipa", "https://user:secret@cdn.example/app.ipa"]) {
    httpCalls = [];
    setServer(() => ({
      status: 200,
      headers: { "accept-ranges": "bytes", "content-length": String(stream.CHUNK_THRESHOLD_BYTES) },
      finalUrl,
    }));
    const result = await stream.tryChunkedDownload({ downloadURL: "https://cdn.example/app.ipa" });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(httpCalls.length, 1);
  }
});

test("ranges use the secure final URL and strong ETag returned by HEAD", async () => {
  const finalUrl = "https://edge.example/app.ipa";
  setServer((options) => options.method === "HEAD" ? {
    status: 200,
    headers: { "accept-ranges": "bytes", "content-length": String(stream.CHUNK_THRESHOLD_BYTES), etag: '"head-v1"' },
    finalUrl,
  } : { status: 200, finalUrl, headers: {}, rawData: dataBytes(1) });
  const result = await stream.tryChunkedDownload({ downloadURL: "https://cdn.example/app.ipa" });
  assert.equal(result.fatal, true);
  assert.equal(httpCalls[1].url, finalUrl);
  assert.equal(httpCalls[1].headers["If-Match"], '"head-v1"');
});

test("a chunk redirected to HTTP is rejected before writing", async () => {
  setServer((options) => ({ ...rangeResponse(options, 100), finalUrl: "http://cdn.example/app.ipa" }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(files.size, 0);
});

test("identical ETags on different HTTPS resources cannot be combined", async () => {
  const total = stream.CHUNK_SIZE + 3;
  setServer((options, index) => ({
    ...rangeResponse(options, total, { etag: '"v1"' }),
    finalUrl: index ? "https://other.example/another.ipa" : options.url,
  }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", total, null, { etag: '"v1"' });
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(httpCalls.length, 2);
  assert.equal(files.size, 0);
  assert.equal(merges.length, 0);
});

test("successful HEAD and range responses must identify their final resource URL", async () => {
  setServer(() => ({
    status: 200,
    headers: { "accept-ranges": "bytes", "content-length": String(stream.CHUNK_THRESHOLD_BYTES) },
  }));
  const probed = await stream.tryChunkedDownload({ downloadURL: "https://cdn.example/app.ipa" });
  assert.equal(probed.ok, false);
  assert.equal(probed.fatal, true);
  assert.equal(httpCalls.length, 1);

  httpCalls = [];
  setServer((options) => ({ ...rangeResponse(options, 100), finalUrl: "" }));
  const chunked = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(chunked.ok, false);
  assert.equal(chunked.fatal, true);
  assert.equal(httpCalls.length, 1);
  assert.equal(files.size, 0);
});

test("resource comparison normalizes HTTPS host case, default port and fragments", async () => {
  setServer((options) => ({
    ...rangeResponse(options, 100), finalUrl: "HTTPS://CDN.EXAMPLE:443/app.ipa#ignored",
  }));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, true);
});

test("transient transport errors retry the same range with bounded attempts", async () => {
  setServer((options, index) => index === 0
    ? { failed: true, error: new Error("connection reset"), headers: {} }
    : rangeResponse(options, 100));
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, true);
  assert.equal(httpCalls.length, 2);
  assert.equal(httpCalls[0].headers.Range, httpCalls[1].headers.Range);
});

test("exhausted transport retries are fatal without leaving partial files", async () => {
  setServer(() => { throw new Error("connection reset"); });
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(httpCalls.length, 2);
  assert.equal(files.size, 0);
});

test("a failed write cleans its partially created current file without downloading again", async () => {
  global.$file.write = ({ path, data }) => { files.set(path, data); return false; };
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(httpCalls.length, 1);
  assert.equal(files.size, 0);
});

test("merge failure removes its partial destination and all source parts", async () => {
  global.$file.merge = ({ dest }) => { files.set(dest, { incomplete: true }); return false; };
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(files.size, 0);
});

test("merge without a resulting file is not success", async () => {
  global.$file.merge = () => undefined;
  const result = await stream.downloadChunked("https://cdn.example/app.ipa", 100);
  assert.equal(result.ok, false);
  assert.equal(result.fatal, true);
  assert.equal(files.size, 0);
});

test("invalid source URLs and unsafe totals cannot start requests", async () => {
  for (const [url, total] of [
    ["http://cdn.example/app.ipa", 100], ["https://user:secret@cdn.example/app.ipa", 100],
    ["https:///app.ipa", 100], ["https://cdn.example/app.ipa", 0],
    ["https://cdn.example/app.ipa", -1], ["https://cdn.example/app.ipa", 1.5],
    ["https://cdn.example/app.ipa", Number.MAX_SAFE_INTEGER + 1],
  ]) {
    const result = await stream.downloadChunked(url, total);
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
  }
  assert.equal(httpCalls.length, 0);
  assert.equal(files.size, 0);
});
