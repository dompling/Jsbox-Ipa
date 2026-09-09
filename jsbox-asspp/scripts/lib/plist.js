// 极简 Apple XML plist 编解码器（纯 JS）。
// Apple 私有 Store API 的请求/响应均为 plist，这里只覆盖实际用到的类型：
// dict / array / string / integer / real / true / false / date / data。

const b64 = require("./b64");

function escapeXML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXML(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    return `<string>${escapeXML(value)}</string>`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `<integer>${value}</integer>`
      : `<real>${value}</real>`;
  }
  if (typeof value === "boolean") {
    return value ? "<true/>" : "<false/>";
  }
  if (value instanceof Date) {
    return `<date>${value.toISOString()}</date>`;
  }
  if (Array.isArray(value)) {
    return `<array>${value.map(encodeValue).join("")}</array>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter(
      (k) => value[k] !== undefined && value[k] !== null
    );
    const body = keys
      .map((k) => `<key>${escapeXML(k)}</key>${encodeValue(value[k])}`)
      .join("");
    return `<dict>${body}</dict>`;
  }
  throw new Error(`unsupported plist value type: ${typeof value}`);
}

function buildPlist(root) {
  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  return `${header}<plist version="1.0">${encodeValue(root)}</plist>`;
}

// ---------- 解析 ----------

class Parser {
  constructor(xml) {
    this.xml = String(xml || "");
    this.pos = 0;
  }

  skipWhitespace() {
    while (this.pos < this.xml.length && /\s/.test(this.xml[this.pos])) {
      this.pos++;
    }
  }

  startsWith(text) {
    return this.xml.startsWith(text, this.pos);
  }

  // 解析一个开始标签：<name ...> 或 <name/>，忽略属性，返回标签名。
  readTagName() {
    this.skipWhitespace();
    if (this.xml[this.pos] !== "<") {
      throw new Error("expected '<' at " + this.pos);
    }
    const end = this.xml.indexOf(">", this.pos);
    if (end < 0) throw new Error("unterminated tag at " + this.pos);
    const raw = this.xml.slice(this.pos + 1, end);
    this.pos = end + 1;
    const trimmed = raw.trim();
    const selfClosing = trimmed.endsWith("/");
    const namePart = selfClosing ? trimmed.slice(0, -1) : trimmed;
    const name = namePart.trim().split(/\s+/)[0];
    return selfClosing ? `${name}/` : name;
  }

  expect(value) {
    if (!this.startsWith(value)) {
      throw new Error(`expected '${value}' at ${this.pos}: ${this.xml.slice(this.pos, this.pos + 40)}`);
    }
    this.pos += value.length;
  }

  readTextUntil(closeTag, trim = true) {
    const idx = this.xml.indexOf(closeTag, this.pos);
    if (idx < 0) throw new Error(`missing ${closeTag}`);
    const text = this.xml.slice(this.pos, idx);
    this.pos = idx + closeTag.length;
    return unescapeXML(trim ? text.trim() : text);
  }

  parseValue() {
    this.skipWhitespace();
    const tag = this.readTagName();
    const selfClosing = tag.endsWith("/");
    const name = selfClosing ? tag.slice(0, -1).trim() : tag.trim();

    if (name === "true" || name === "false") {
      return name === "true";
    }

    if (selfClosing) {
      if (name === "string") return "";
      if (name === "dict") return {};
      if (name === "array") return [];
      if (name === "data") return [];
      throw new Error(`unexpected self-closing tag <${name}/>`);
    }

    const close = `</${name}>`;
    switch (name) {
      case "string":
        return this.readTextUntil(close, false);
      case "integer":
        return parseInt(this.readTextUntil(close), 10);
      case "real":
        return parseFloat(this.readTextUntil(close));
      case "date":
        return new Date(this.readTextUntil(close));
      case "data": {
        const text = this.readTextUntil(close).replace(/\s+/g, "");
        return b64.base64Decode(text);
      }
      case "dict": {
        const dict = {};
        for (;;) {
          this.skipWhitespace();
          if (this.startsWith("</dict>")) {
            this.pos += 7;
            return dict;
          }
          const keyTag = this.readTagName().trim();
          if (keyTag !== "key") throw new Error("expected <key> in dict");
          const key = this.readTextUntil("</key>");
          dict[key] = this.parseValue();
        }
      }
      case "array": {
        const array = [];
        for (;;) {
          this.skipWhitespace();
          if (this.startsWith("</array>")) {
            this.pos += 8;
            return array;
          }
          array.push(this.parseValue());
        }
      }
      default:
        throw new Error(`unsupported plist tag <${name}>`);
    }
  }

  parseRoot() {
    // 跳过 XML 声明 / DOCTYPE / 注释
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith("<?") || this.startsWith("<!") || this.startsWith("<!--")) {
        const end = this.xml.indexOf(">", this.pos);
        if (end < 0) throw new Error("unterminated prolog");
        this.pos = end + 1;
      } else {
        break;
      }
    }
    const tag = this.readTagName().trim();
    if (tag !== "plist") throw new Error("not a plist document");
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.pos < this.xml.length) {
      // 容忍尾部垃圾（通常为换行）
      const rest = this.xml.slice(this.pos).trim();
      if (rest && !rest.startsWith("</plist>")) {
        throw new Error(`unexpected trailing content: ${rest.slice(0, 40)}`);
      }
    }
    return value;
  }
}

function parsePlist(xml) {
  return new Parser(xml).parseRoot();
}

// 粗略判断响应是否为 plist（避免把 HTML 错误页当 plist 继续解析）。
function looksLikePlist(body) {
  return typeof body === "string" && body.indexOf("<plist") >= 0;
}

module.exports = {
  buildPlist,
  parsePlist,
  looksLikePlist,
  escapeXML,
  unescapeXML,
};
