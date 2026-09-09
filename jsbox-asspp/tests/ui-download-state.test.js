const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, flatten, deferred } = require("./helpers/ui");

const app = { id: "42", name: "Demo", bundleID: "com.example.demo", version: "1.0", price: 0 };

function harness(t) {
  const controls = new Map();
  const h = setup({ "services/downloader.js": { downloadControl: id => controls.get(id) || null } });
  const scheduled = [];
  h.context.setTimeout = callback => { scheduled.push(callback); return scheduled.length; };
  h.context.$alertActionType = { destructive: 1 };
  const alerts = [];
  h.context.$ui.alert = value => alerts.push(value);
  const common = h.load("ui/common.js");
  const queue = h.load("services/queue.js");
  const definitions = [];
  t.after(() => definitions.forEach(common.releaseDownloadButtons));
  function pill(context = {}, action = () => { throw new Error("unexpected duplicate download"); }) {
    const product = context.app || { ...app };
    const definition = common.actionPill(() => common.getButtonText(product, context.version), action, 64, {
      app: product, region: "CN", ...context,
    });
    definitions.push(definition);
    h.mount(definition);
    const button = flatten(definition).find(view => /^download-action-/.test(view.props && view.props.id || ""));
    const sender = h.nodes.get(button.props.id);
    const children = () => flatten(definition).map(view => h.nodes.get(view.props && view.props.id)).filter(Boolean);
    return {
      definition, button, sender,
      ring: () => children().find(node => node.definition.type === "canvas"),
      spinner: () => children().find(node => node.definition.type === "spinner"),
      tap: () => button.events.tapped(sender),
      dispose: () => { common.releaseDownloadButtons(definition); h.nodes.delete(sender.id); },
    };
  }
  function begin(extra = {}) {
    const task = queue.begin({ app: { ...app }, region: "CN", accountEmail: "a@example.test", ...extra });
    let cancelled = false;
    const listeners = new Set();
    const control = {
      id: task.id, name: app.name,
      canCancel: () => !cancelled && queue.snapshot().some(value => value.id === task.id && value.cancellable),
      cancel: () => {
        if (!control.canCancel()) return false;
        cancelled = true;
        queue.update(task.id, { status: "cancelling", cancellable: false });
        listeners.forEach(listener => listener());
        return true;
      },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    controls.set(task.id, control);
    return { task, control, get cancelled() { return cancelled; } };
  }
  const tick = () => { for (const callback of scheduled.splice(0)) callback(); };
  return { ...h, common, queue, controls, alerts, pill, begin, tick };
}

test("a list button adopts a detail task before the queue notification and after remount", t => {
  const h = harness(t);
  const list = h.pill();
  const { task } = h.begin();
  h.queue.update(task.id, { status: "downloading", progress: 0.49, downloadProgress: 0.5 });
  h.common.refreshDownloadButtons();
  assert.notEqual(list.sender.title, "获取", "returning to the list must adopt the running detail task");
  assert.equal(list.sender.accessibilityValue, "50%");
  assert.equal(list.ring().hidden, false);
  assert.equal(list.ring().info.value, 0.5);
  list.dispose();
  const remounted = h.pill();
  assert.equal(remounted.sender.title, "");
  assert.equal(remounted.sender.accessibilityValue, "50%");
  assert.equal(remounted.ring().hidden, false);
});

test("a restored task cancels through the shared confirmation and never starts another request", async t => {
  const h = harness(t);
  const run = h.begin();
  h.queue.update(run.task.id, { status: "downloading", downloadProgress: 0.25 });
  const list = h.pill();
  const detail = h.pill({ prominent: true });
  await list.tap();
  await detail.tap();
  assert.equal(h.alerts.length, 1);
  assert.equal(run.cancelled, false);
  h.alerts[0].actions.find(value => value.title === "取消下载").handler();
  h.tick();
  assert.equal(run.cancelled, true);
  assert.match(list.sender.accessibilityLabel, /正在取消/);
  assert.equal(list.spinner().loading, true);
  assert.equal(list.ring().hidden, true);
  h.queue.remove(run.task.id);
  h.tick();
  assert.equal(list.sender.title, "获取");
  assert.equal(detail.sender.title, "获取");
  assert.equal(list.spinner().loading, false);
});

test("active tasks are isolated by account, region, App and exact historical build ID", t => {
  const h = harness(t);
  const { task } = h.begin({ externalVersionId: "111" });
  h.queue.update(task.id, { status: "downloading", downloadProgress: 0.4 });
  for (const context of [
    {},
    { version: { externalVersionId: "112" } },
    { app: { ...app, id: "43" }, version: { externalVersionId: "111" } },
    { region: "US", version: { externalVersionId: "111" } },
    { accountEmail: "b@example.test", version: { externalVersionId: "111" } },
  ]) assert.equal(h.pill(context).sender.title, "获取");
  const history = h.pill({ version: { externalVersionId: "111" } });
  assert.equal(history.sender.accessibilityValue, "40%");
  h.switchAccount("b@example.test");
  h.common.refreshDownloadButtons();
  assert.equal(history.sender.title, "获取");
  h.switchAccount("a@example.test");
  h.common.refreshDownloadButtons();
  assert.equal(history.sender.accessibilityValue, "40%");
});

test("completion and failure restore all existing controls even after the initiating page is gone", t => {
  const h = harness(t);
  const origin = h.pill();
  const list = h.pill();
  const { task } = h.begin();
  h.tick();
  assert.equal(list.spinner().loading, true);
  origin.dispose();
  h.downloaded.add(app.id);
  h.queue.finish(task.id);
  h.tick();
  assert.equal(list.sender.title, "打开");
  assert.equal(list.spinner().loading, false);
  h.downloaded.clear();
  const retry = h.begin();
  h.tick();
  h.queue.fail(retry.task.id, new Error("connection lost"));
  h.tick();
  assert.equal(list.sender.title, "获取");
  assert.equal(list.ring().hidden, true);
  assert.equal(h.queue.snapshot()[0].status, "error", "failure remains in the download list");
});

test("public lookup preparation is shared across pages and survives disposal until task handoff", async t => {
  const h = harness(t);
  const pending = deferred();
  t.after(() => pending.resolve(false));
  let publish;
  const origin = h.pill({}, (_progress, onTask) => { publish = onTask; return pending.promise; });
  const promise = origin.tap();
  const list = h.pill();
  assert.equal(list.spinner().loading, true);
  await list.tap();
  origin.dispose();
  const run = h.begin();
  publish(run.control);
  h.queue.update(run.task.id, { status: "downloading", downloadProgress: 0.72 });
  h.tick();
  assert.equal(list.sender.accessibilityValue, "72%");
  h.downloaded.add(app.id);
  h.queue.finish(run.task.id);
  pending.resolve(true);
  await promise;
  h.tick();
  assert.equal(list.sender.title, "打开");
  assert.equal(list.spinner().loading, false);
});

test("task handoff uses its real account rather than leaving another account's preparation busy", async t => {
  const h = harness(t);
  const pending = deferred();
  t.after(() => pending.resolve(false));
  let publish;
  const origin = h.pill({}, (_progress, onTask) => { publish = onTask; return pending.promise; });
  const promise = origin.tap();
  h.switchAccount("b@example.test");
  const run = h.begin({ accountEmail: "b@example.test" });
  publish(run.control);
  h.switchAccount("a@example.test");
  h.common.refreshDownloadButtons();
  assert.equal(origin.sender.title, "获取", "account A must not adopt or cancel account B's control");
  const currentB = h.pill({ accountEmail: "b@example.test" });
  assert.equal(currentB.spinner().loading, true);
  await currentB.tap();
  h.alerts[0].actions.find(value => value.title === "取消下载").handler();
  assert.equal(run.cancelled, true);
  h.queue.remove(run.task.id);
  pending.resolve(false);
  await promise;
});

test("unknown-length transfer and final verification use a spinner and commit removes the stop action", async t => {
  const h = harness(t);
  const run = h.begin();
  const button = h.pill();
  h.queue.update(run.task.id, { status: "downloading", downloadProgress: null });
  h.tick();
  assert.equal(button.spinner().loading, true);
  assert.equal(button.ring().hidden, true);
  assert.equal(button.sender.accessibilityValue, "正在下载");
  h.queue.update(run.task.id, { status: "verifying", progress: 0.95, downloadProgress: 1, cancellable: false });
  h.tick();
  assert.equal(button.spinner().loading, true);
  assert.equal(button.sender.accessibilityValue, "正在校验");
  await button.tap();
  assert.equal(h.alerts.length, 0);
  assert.equal(run.cancelled, false);
  const stop = flatten(button.definition).find(view => /^download-stop-/.test(view.props.id || ""));
  assert.equal(h.nodes.get(stop.props.id).hidden, true);
});

test("all controls share one queue observer and release it when the last page is disposed", t => {
  const h = harness(t);
  const subscribe = h.queue.subscribe;
  let observers = 0;
  h.queue.subscribe = listener => {
    observers++;
    const unsubscribe = subscribe(listener);
    return () => { observers--; unsubscribe(); };
  };
  const first = h.pill(), second = h.pill();
  assert.equal(observers, 1);
  first.dispose();
  assert.equal(observers, 1);
  second.dispose();
  assert.equal(observers, 0);
  h.begin();
  const next = h.pill();
  assert.equal(observers, 1);
  assert.equal(next.spinner().loading, true);
  h.common.clearDownloadButtons();
  assert.equal(observers, 0);
});

test("circular byte progress redraws through the documented native bridge from twelve o'clock", t => {
  const h = harness(t);
  const { task } = h.begin();
  const button = h.pill();
  const redraws = [];
  button.ring().ocValue = () => ({ invoke: method => redraws.push(method) });
  h.queue.update(task.id, { status: "downloading", downloadProgress: 0.25 });
  h.tick();
  assert.deepEqual(redraws, ["setNeedsDisplay"]);
  const arcs = [];
  const ring = button.ring();
  ring.definition.events.draw({ frame: { width: 30, height: 30 }, info: ring.info }, {
    setLineWidth() {}, setLineCap() {}, setAlpha() {}, beginPath() {}, strokePath() {},
    addArc: (...args) => arcs.push(args),
  });
  assert.equal(arcs.length, 2);
  assert.equal(arcs[1][3], -Math.PI / 2);
  assert.equal(arcs[1][4], 0);
  assert.equal(button.sender.title, "", "the ring must not have a percentage title drawn over it");
  assert.equal(button.sender.accessibilityValue, "25%");
});

test("automatic progress updates use retained controls instead of scanning the native tree for every idle App", t => {
  const h = harness(t);
  const list = h.pill();
  for (let index = 0; index < 60; index++) h.pill({ app: { ...app, id: `other-${index}` } });
  const get = h.context.$ui.get;
  const nativeLookups = [];
  h.context.$ui.get = id => { nativeLookups.push(id); return get(id); };
  const { task } = h.begin();
  h.queue.update(task.id, { status: "downloading", downloadProgress: 0.33 });
  h.tick();
  assert.equal(list.sender.accessibilityValue, "33%");
  assert.deepEqual(nativeLookups, []);
  h.common.refreshDownloadButtons();
  assert.ok(nativeLookups.includes(list.sender.id), "page appearances still recover the current native instance");
});
