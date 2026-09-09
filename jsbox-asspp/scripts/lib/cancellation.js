// 下载任务的协作取消：不依赖 JSBox 是否提供 AbortController 或原生请求句柄。
class DownloadCancelledError extends Error {
  constructor() {
    super("下载已取消");
    this.name = "DownloadCancelledError";
    this.code = "download_cancelled";
    this.needsAppStore = false;
  }
}

function createCancellation() {
  let cancelled = false;
  const listeners = new Set();
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return false;
      cancelled = true;
      const pending = Array.from(listeners);
      listeners.clear();
      for (const listener of pending) {
        try { listener(); } catch (_err) {}
      }
      return true;
    },
    subscribe(listener) {
      if (cancelled) listener();
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    throwIfCancelled() {
      if (cancelled) throw new DownloadCancelledError();
    },
  };
}

function assertActive(cancellation) {
  if (cancellation) cancellation.throwIfCancelled();
}

function isCancelled(error) {
  return !!error && String(error.code) === "download_cancelled";
}

module.exports = { createCancellation, assertActive, isCancelled, DownloadCancelledError };
