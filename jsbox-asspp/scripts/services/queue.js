// 下载中任务队列（进程内状态）。
//
// 下载是异步流程（授权 -> 获取下载信息 -> 拉包 -> 校验 -> 入库），下载页
// 需要在不依赖 Apple 元数据落盘前就看到“正在下载”的行与实时进度。这里只
// 保存运行期状态与订阅通知：App 进程被杀后任务自然消失（下载本身也会
// 中断），已完成文件始终以本地库为准，不做跨启动持久化。

let sequence = 0;
const tasks = [];
const listeners = new Set();
let notifyTimer = null;

function emitSoon() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (_e) {}
    }
  }, 250);
}

function findTask(id) {
  return tasks.find((task) => task.id === id) || null;
}

function appMeta(app) {
  return {
    id: String((app && app.id) || ""),
    bundleID: String((app && app.bundleID) || ""),
    name: String((app && app.name) || "下载中"),
    price: app && ["number", "string"].includes(typeof app.price) ? app.price : null,
    owned: !!(app && app.owned),
    version: String((app && app.version) || ""),
    artworkUrl: String(
      (app && (app.artworkUrl100 || app.artworkUrl || app.icon)) || ""
    ),
  };
}

// 仅保存下载意图与账号引用，不保存 Cookie、密码或令牌。
function begin(meta) {
  const task = {
    id: `dl-${Date.now()}-${sequence++}`,
    app: appMeta(meta && meta.app),
    region: String((meta && meta.region) || ""),
    accountEmail: String((meta && meta.accountEmail) || "").trim().toLowerCase(),
    externalVersionId: String((meta && meta.externalVersionId) || ""),
    status: "preparing", // preparing | downloading | cancelling | verifying | injecting | saving | error
    cancellable: true,
    progress: 0,
    downloadProgress: null, // 字节进度；未知长度时不伪造百分比。
    message: "准备下载…",
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.unshift(task);
  emitSoon();
  return task;
}

// 更新任务字段（message/progress/status 等），字段白名单避免把任意对象写进去。
function update(id, patch) {
  const task = findTask(id);
  if (!task) return null;
  const source = patch || {};
  if (source.status !== undefined) {
    task.status = String(source.status);
    if (task.status !== "error") task.error = "";
  }
  if (source.progress !== undefined) {
    const value = Number(source.progress) || 0;
    task.progress = Math.max(0, Math.min(1, value));
  }
  if (source.downloadProgress !== undefined) {
    const value = Number(source.downloadProgress);
    task.downloadProgress = source.downloadProgress === null || !Number.isFinite(value)
      ? null : Math.max(0, Math.min(1, value));
  }
  if (source.message !== undefined) task.message = String(source.message);
  if (source.cancellable !== undefined) task.cancellable = source.cancellable === true;
  task.updatedAt = Date.now();
  emitSoon();
  return task;
}

// 成功完成：任务退出队列，下载列表立刻能看到本地库中的新文件。
function finish(id) {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return;
  tasks.splice(index, 1);
  emitSoon();
}

// 失败：保留任务让用户可以从下载页点按重试。
function fail(id, error) {
  const task = findTask(id);
  if (!task) return;
  task.status = "error";
  task.cancellable = false;
  task.progress = 0;
  task.downloadProgress = null;
  task.message = "下载失败";
  task.error = String((error && (error.message || error)) || error || "未知错误");
  task.updatedAt = Date.now();
  emitSoon();
  return task;
}

function remove(id) {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return;
  tasks.splice(index, 1);
  emitSoon();
}

function snapshot() {
  // 页面用前后快照判断是否需要重建状态按钮，不能共享会被 update 改写的对象。
  return tasks.map(task => Object.assign({}, task, { app: Object.assign({}, task.app) }));
}

function subscribe(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

module.exports = {
  begin,
  update,
  finish,
  fail,
  remove,
  snapshot,
  subscribe,
};
