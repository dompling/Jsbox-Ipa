(function (root) {
  "use strict";

  const CERTIFICATE_URL = "https://s.mzstatic.com/sap/setupCert.plist";
  const SETUP_URL = "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy";
  const DEFAULT_PROXY_URL = "http://xiaobai.com/";
  const SCRIPT_BASE_URL = (() => {
    const script = typeof document === "undefined" ? null : document.currentScript;
    const base = script && script.src
      ? script.src
      : (typeof document === "undefined" ? "./" : document.baseURI);
    return new URL(".", base).href;
  })();
  const NATIVE_MEMORY_SHIMS = new Set([
    "_malloc", "_malloc_good_size", "_calloc", "_free",
    "_memcpy", "_memmove", "_memset", "___bzero",
    "___memcpy_chk", "___memset_chk", "_strlen", "_pthread_once",
    "_pthread_mutex_lock", "_pthread_mutex_unlock",
    "_pthread_rwlock_init", "_pthread_rwlock_init$UNIX2003",
    "_pthread_rwlock_unlock", "_pthread_rwlock_unlock$UNIX2003",
    "_pthread_rwlock_wrlock", "_pthread_rwlock_wrlock$UNIX2003"
  ]);

  let runtimePromise = null;
  let defaultSignerPromise = null;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = resolve;
      script.onerror = () => reject(new Error("load script failed: " + url));
      document.head.appendChild(script);
    });
  }

  function bytesToBase64(bytes) {
    let text = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(text);
  }

  function isAllowedUpstream(value) {
    const match = /^(https):\/\/([^/?#]+)(\/.*)?$/i.exec(String(value || "").trim());
    if (!match) return false;
    if (match[1].toLowerCase() !== "https") return false;
    const authority = String(match[2]).toLowerCase();
    if (authority.indexOf("@") >= 0) return false;
    const host = authority.split(":")[0];
    return (
      host === "mzstatic.com" ||
      host.endsWith(".mzstatic.com") ||
      host === "apple.com" ||
      host.endsWith(".apple.com")
    );
  }

  function pickEndpoint(value, fallback) {
    return isAllowedUpstream(value) ? String(value).trim() : fallback;
  }

  // WASM 拥有近乎原生的执行权限，绝不能从任意可配置的远程域加载。
  // 只允许与脚本自身同源的 URL，否则回退到默认地址。
  function isSameOriginAsScript(value) {
    try {
      return new URL(value, SCRIPT_BASE_URL).origin === new URL(SCRIPT_BASE_URL).origin;
    } catch (_error) {
      return false;
    }
  }

  function textToBase64(value) {
    return bytesToBase64(new TextEncoder().encode(value));
  }

  // DAAP 购买记录的 items 请求是 DMAP 二进制，不能先转成 UTF-8 字符串，
  // 否则签名输入会被重编码。调用方传入已经按原始字节编码的 Base64。
  function normalizeBase64(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function base64ToBytes(value) {
    const text = atob(value);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
  }

  function unsigned64(value) {
    return BigInt.asUintN(64, BigInt(value));
  }

  function installShimBridge() {
    const registered = new Map();
    const nativeEntries = new Set();
    root.sapWasmShimHandled = false;

    root.sapWasmRegisterShim = (address, name) => {
      const value = BigInt(address);
      registered.set(value, name);
      if (NATIVE_MEMORY_SHIMS.has(name)) nativeEntries.add(value);
    };

    root.sapWasmTrapHook = (handle, address) => {
      root.sapWasmShimHandled = false;
      const current = unsigned64(address);
      const name = registered.get(current);
      if (name && NATIVE_MEMORY_SHIMS.has(name)) return;
      if (!name) {
        for (const start of nativeEntries) {
          if (current > start && current < start + 64n) return;
        }
      }
      handle.emu_stop();
    };
  }

  async function initialize(options) {
    if (runtimePromise) return runtimePromise;

    runtimePromise = (async () => {
      const unicornURL = options.unicornURL || new URL("unicorn_x86.js", SCRIPT_BASE_URL).href;
      const wasmExecURL = options.wasmExecURL || new URL("wasm_exec.js", SCRIPT_BASE_URL).href;
      const wasmURL = options.wasmURL || new URL("sap.wasm", SCRIPT_BASE_URL).href;

      if (typeof root.MUnicorn !== "function") await loadScript(unicornURL);
      if (typeof root.MUnicorn !== "function") throw new Error("Unicorn.js factory is unavailable");
      root.unicornModule = await root.MUnicorn();
      if (!root.unicornModule) throw new Error("Unicorn.js initialization failed");

      installShimBridge();
      if (typeof root.Go !== "function") await loadScript(wasmExecURL);
      if (typeof root.Go !== "function") throw new Error("Go WASM runtime is unavailable");

      const response = await fetch(wasmURL, { cache: "no-store" });
      if (!response.ok) throw new Error("load SAP WASM failed: " + response.status);
      const bytes = await response.arrayBuffer();
      const go = new root.Go();
      const compiled = await WebAssembly.instantiate(bytes, go.importObject);
      go.run(compiled.instance);

      const deadline = Date.now() + 30000;
      while (!root.sapWasmSignerReady) {
        if (Date.now() >= deadline) throw new Error("SAP WASM initialization timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();

    try {
      await runtimePromise;
    } catch (error) {
      runtimePromise = null;
      throw error;
    }
  }

  function proxyURL(proxyBase, upstream) {
    const target = new URL(proxyBase, document.baseURI);
    target.search = "";
    target.searchParams.set("url", upstream);
    return target.href;
  }

  // JSBox 的本地 $server 为了兼容旧版 WebView，会把二进制响应包装成
  // `{status, contentType, base64}` JSON。普通浏览器仍走原始二进制响应。
  async function proxyFetch(proxyBase, upstream, options, proxyEncoding) {
    const response = await fetch(proxyURL(proxyBase, upstream), options || {});
    if (proxyEncoding !== "base64-json") return response;
    let envelope;
    try {
      envelope = await response.json();
    } catch (_error) {
      throw new Error("SAP 代理返回了无法解析的响应");
    }
    const status = Number(envelope && envelope.status) || response.status || 502;
    const contentType = String(
      (envelope && envelope.contentType) || "application/octet-stream"
    );
    const payload = base64ToBytes(String((envelope && envelope.base64) || ""));
    return {
      ok: envelope && envelope.ok === true && status >= 200 && status < 300,
      status,
      headers: { get: name => String(name).toLowerCase() === "content-type" ? contentType : null },
      arrayBuffer: async () => payload.buffer,
      text: async () => new TextDecoder().decode(payload),
    };
  }

  async function requestCertificate(proxyBase, signOptions) {
    const opts = signOptions || {};
    const response = await proxyFetch(
      proxyBase,
      pickEndpoint(opts.certificateURL, CERTIFICATE_URL),
      { cache: "no-store" },
      opts.proxyEncoding
    );
    if (!response.ok) throw new Error("fetch SAP setup certificate failed: " + response.status);
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  async function exchangeSetup(proxyBase, requestBase64, signOptions) {
    const opts = signOptions || {};
    const response = await proxyFetch(
      proxyBase,
      pickEndpoint(opts.setupURL, SETUP_URL),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-plist" },
        body: base64ToBytes(requestBase64),
      },
      opts.proxyEncoding
    );
    if (!response.ok) throw new Error("SAP setup request failed: " + response.status);
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }

  async function loadSapSigner(options) {
    options = options || {};
    await initialize(options);
    const proxyBase = options.proxyURL || DEFAULT_PROXY_URL;
    let queue = Promise.resolve();

    function signBase64(bodyBase64, signOptions) {
      const operation = queue.then(async () => {
        if (typeof bodyBase64 !== "string" || bodyBase64.length === 0) {
          throw new TypeError("bodyBase64 must be a non-empty string");
        }
        const requestProxy = signOptions && signOptions.proxyURL
          ? signOptions.proxyURL
          : proxyBase;
        // 给真机排障用的子步骤定位：出错时在消息前缀标注到底是证书下载、
        // WASM 准备签名，还是与 Apple 交换 setup 消息 / 完成签名时失败。
        const stage = (label, error) => {
          const message = error && (error.message || String(error));
          return new Error(`[${label}] ${message}`);
        };

        let certificate;
        try {
          certificate = await requestCertificate(requestProxy, signOptions);
        } catch (error) {
          throw stage("证书下载", error);
        }

        let preparation;
        try {
          // Pass explicit UTF-8 bytes across the JS/WASM boundary. SAP signs
          // the exact request body, so an implicit string conversion is unsafe.
          preparation = JSON.parse(
            root.sapWasmPrepareSetup(normalizeBase64(bodyBase64), certificate)
          );
          if (preparation.error) throw new Error(preparation.error);
        } catch (error) {
          throw stage("准备签名", error);
        }

        let reply;
        try {
          reply = await exchangeSetup(
            requestProxy,
            preparation.requestBase64,
            signOptions
          );
        } catch (error) {
          throw stage("交换 setup", error);
        }

        try {
          const completion = JSON.parse(root.sapWasmFinishSetup(reply));
          if (completion.error) throw new Error(completion.error);
          if (
            typeof completion.signatureBase64 !== "string" ||
            completion.signatureBase64.length === 0
          ) {
            throw new Error("SAP signer returned an empty signature");
          }
          return completion.signatureBase64;
        } catch (error) {
          throw stage("完成签名", error);
        }
      });
      queue = operation.catch(() => {});
      return operation;
    }

    function sign(xml, signOptions) {
      if (typeof xml !== "string" || xml.length === 0) {
        return Promise.reject(new TypeError("xml must be a non-empty string"));
      }
      return signBase64(textToBase64(xml), signOptions);
    }

    function signBytes(bodyBase64, signOptions) {
      return signBase64(bodyBase64, signOptions);
    }

    return { sign, signBytes };
  }

  function sapSign(xml, options) {
    if (!defaultSignerPromise) defaultSignerPromise = loadSapSigner(options || {});
   
    return defaultSignerPromise.then(signer => signer.sign(xml, options || {}));
  }

  function sapSignBytes(bodyBase64, options) {
    if (!defaultSignerPromise) defaultSignerPromise = loadSapSigner(options || {});
    return defaultSignerPromise.then(signer => signer.signBytes(bodyBase64, options || {}));
  }

  root.loadSapSigner = loadSapSigner;
  root.sapSign = sapSign;
  root.sapSignBytes = sapSignBytes;
})(typeof globalThis === "undefined" ? window : globalThis);
