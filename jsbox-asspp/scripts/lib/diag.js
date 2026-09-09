// 真机诊断环形缓冲。
//
// 主要给「已购」这类私有协议排障用：把登录/更新/列表请求的关键状态
// 记成短记录，优先存进 $prefs 单 key（JSBox 可持久化），没有 $prefs 的
// Node 单测环境退化为进程内内存缓冲。每条记录刻意保持精简，避免刷爆
// $prefs；需要详细内容时可通过 tailText() 拼进错误/空态提示里直接查看。

const KEY = "jasspp.diag.v1";
const RECENT = 40;
let memory = [];

function readAll() {
  try {
    if (typeof $prefs !== "undefined" && $prefs && typeof $prefs.get === "function") {
      const raw = $prefs.get(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch (_e) {}
  return memory;
}

function writeAll(list) {
  memory = list;
  try {
    if (typeof $prefs !== "undefined" && $prefs && typeof $prefs.set === "function") {
      try {
        $prefs.set(KEY, JSON.stringify(list));
      } catch (_e) {}
    }
  } catch (_e) {}
}

function stamp() {
  try {
    return new Date().toISOString();
  } catch (_e) {
    return "";
  }
}

// 追加一条短记录，仅保留最近 RECENT 条。
function record(entry) {
  const list = readAll();
  list.push(Object.assign({ t: stamp() }, entry || {}));
  writeAll(list.slice(-RECENT));
  return list.length;
}

// 返回最近若干条（新→旧按写入顺序，尾部为最新）。
function tail(limit) {
  const count = Math.max(1, Number(limit) || RECENT);
  return readAll().slice(-count);
}

// 便于拼进 UI 文本/错误信息：每条一行 JSON。
function tailText(limit) {
  return tail(limit)
    .map((entry) => {
      try {
        return JSON.stringify(entry);
      } catch (_e) {
        return String(entry);
      }
    })
    .join("\n");
}

function clear() {
  writeAll([]);
}

module.exports = {
  KEY,
  RECENT,
  record,
  tail,
  tailText,
  clear,
};
