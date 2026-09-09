// 轻量 URL 解析器：JSBox 的 JavaScriptCore 版本不一定提供完整 WHATWG
// URL。优先使用原生 URL 做规范化，缺失或解析失败时回退到这里，覆盖本项目
// 实际需要的 http(s) URL 字段（协议、主机、端口、路径、查询和凭据）。

function parse(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return null;

  try {
    if (typeof URL === "function") {
      const native = new URL(text);
      return {
        protocol: String(native.protocol || "").toLowerCase(),
        username: String(native.username || ""),
        password: String(native.password || ""),
        hostname: String(native.hostname || "").toLowerCase(),
        port: String(native.port || ""),
        pathname: native.pathname || "/",
        search: native.search || "",
        hash: native.hash || "",
        origin: native.origin || "",
        toString: () => native.toString(),
      };
    }
  } catch (_e) {}

  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(
    text
  );
  if (!match) return null;

  let authority = match[2];
  if (!authority) return null;
  let username = "";
  let password = "";
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userInfo = authority.slice(0, at);
    const colon = userInfo.indexOf(":");
    username = colon >= 0 ? userInfo.slice(0, colon) : userInfo;
    password = colon >= 0 ? userInfo.slice(colon + 1) : "";
    authority = authority.slice(at + 1);
  }

  let hostname = authority;
  let port = "";
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    hostname = authority.slice(1, close).toLowerCase();
    const suffix = authority.slice(close + 1);
    if (suffix) {
      if (!/^:\d+$/.test(suffix)) return null;
      port = suffix.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      const candidatePort = authority.slice(colon + 1);
      if (!/^\d+$/.test(candidatePort)) return null;
      hostname = authority.slice(0, colon);
      port = candidatePort;
    }
    hostname = hostname.toLowerCase();
  }
  if (!hostname) return null;

  const protocol = `${match[1].toLowerCase()}:`;
  const pathname = match[3] || "/";
  const search = match[4] || "";
  const hash = match[5] || "";
  const authorityText = hostname.includes(":") ? `[${hostname}]` : hostname;
  const origin = `${protocol}//${authorityText}${port ? `:${port}` : ""}`;
  return {
    protocol,
    username,
    password,
    hostname,
    port,
    pathname,
    search,
    hash,
    origin,
    toString() {
      return `${origin}${pathname}${search}${hash}`;
    },
  };
}

module.exports = { parse };
