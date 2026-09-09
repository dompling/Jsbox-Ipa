const { test } = require("node:test");
const assert = require("node:assert");

const queue = require("../scripts/services/queue");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("queue tracks lifecycle from begin to finish and notifies subscribers", async () => {
  const seen = [];
  const unsubscribe = queue.subscribe((snapshot) => seen.push(snapshot.length));
  const task = queue.begin({
    app: { name: "Demo", id: "1", artworkUrl100: "https://example.com/demo.png" },
    region: "CN",
  });
  assert.ok(task.id);
  assert.strictEqual(task.status, "preparing");
  assert.strictEqual(task.app.name, "Demo");
  assert.strictEqual(task.region, "CN");

  queue.update(task.id, { status: "downloading", progress: 0.42, message: "下载中" });
  queue.fail(task.id, new Error("连接失败"));
  const failed = queue.snapshot().find((item) => item.id === task.id);
  assert.strictEqual(failed.status, "error");
  assert.strictEqual(failed.progress, 0);
  assert.match(failed.error, /连接失败/);

  queue.finish(task.id);
  assert.strictEqual(queue.snapshot().length, 0);
  await sleep(350);
  assert.ok(seen.length >= 1, "subscriber should receive at least one snapshot");
  unsubscribe();
});

test("queue clamps progress, ignores unknown ids and supports unsubscribe", async () => {
  const seen = [];
  const unsubscribe = queue.subscribe(() => seen.push(1));
  const task = queue.begin({ app: { name: "X" } });
  queue.update("missing", { status: "error" });
  queue.update(task.id, { progress: 9 });
  assert.strictEqual(queue.snapshot()[0].progress, 1);
  queue.update(task.id, { progress: -3 });
  assert.strictEqual(queue.snapshot()[0].progress, 0);
  queue.remove(task.id);
  unsubscribe();
  await sleep(300);
  const before = seen.length;
  queue.begin({ app: { name: "Y" } });
  await sleep(300);
  assert.strictEqual(seen.length, before, "unsubscribed listener should not fire");
  for (const item of queue.snapshot()) queue.remove(item.id);
});

test("queue retains retry intent without copying account credentials", () => {
  const task = queue.begin({
    app: { id: "42", name: "Demo", price: null, version: "1.0", passwordToken: "must-not-copy" },
    region: "US", accountEmail: "Original@Example.invalid", externalVersionId: "111",
    password: "must-not-copy", cookies: [{ value: "must-not-copy" }],
  });
  try {
    assert.strictEqual(task.accountEmail, "original@example.invalid");
    assert.strictEqual(task.externalVersionId, "111");
    assert.strictEqual(task.app.price, null);
    assert.strictEqual(task.app.version, "1.0");
    assert.ok(!JSON.stringify(task).includes("must-not-copy"));
  } finally {
    queue.remove(task.id);
  }
});

test("queue snapshots preserve previous UI state and cancellation availability", () => {
  const task = queue.begin({ app: { id: "42", name: "Demo" } });
  try {
    const before = queue.snapshot();
    queue.update(task.id, { status: "cancelling", message: "正在取消…", cancellable: false });
    assert.strictEqual(before[0].status, "preparing", "UI diffing needs the state from the preceding snapshot");
    assert.strictEqual(before[0].cancellable, true);
    assert.strictEqual(queue.snapshot()[0].cancellable, false);
    before[0].app.name = "changed snapshot";
    assert.strictEqual(queue.snapshot()[0].app.name, "Demo");
  } finally {
    queue.remove(task.id);
  }
});
