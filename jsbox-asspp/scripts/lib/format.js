// 通用格式化工具（纯 JS）。

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

// 生成 12 位十六进制 GUID（6 字节），与 ApplePackage Configuration
// deviceIdentifier（机器标识）对齐。
function generateDeviceId() {
  const bytes = [];
  const cryptoObj =
    typeof crypto !== "undefined" && crypto.getRandomValues
      ? crypto
      : undefined;
  if (cryptoObj) {
    const arr = new Uint8Array(6);
    cryptoObj.getRandomValues(arr);
    bytes.push(...arr);
  } else {
    for (let i = 0; i < 6; i++) {
      bytes.push(Math.floor(Math.random() * 256));
    }
  }
  return bytes
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 安全的文件名（保留扩展名）。
function sanitizeFileName(name) {
  const cleaned = String(name || "download")
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "download";
}

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const CURRENCY_SYMBOLS = {
  CNY: "¥",
  USD: "$",
  JPY: "¥",
  HKD: "HK$",
  TWD: "NT$",
  KRW: "₩",
  GBP: "£",
  EUR: "€",
  AUD: "A$",
  CAD: "CA$",
  SGD: "S$",
  NZD: "NZ$",
  CHF: "CHF ",
  INR: "₹",
  RUB: "₽",
  BRL: "R$",
  MXN: "MX$",
  SEK: "SEK ",
  NOK: "NOK ",
  DKK: "DKK ",
  PLN: "PLN ",
  TRY: "₺",
  ZAR: "R ",
};

function formatPrice(amount, currency, fallback) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return "免费";
  const code = String(currency || "").trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  if (symbol) return `${symbol}${value.toFixed(2)}`;
  if (fallback) return String(fallback);
  return `${value.toFixed(2)}${code ? ` ${code}` : ""}`;
}

module.exports = {
  formatBytes,
  formatDate,
  formatDateTime,
  generateDeviceId,
  sanitizeFileName,
  truncate,
  formatPrice,
};
