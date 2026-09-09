const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

let secure;
let prefs;
let keychainWritable;
let prefsWritable;

function loadDevice() {
  delete require.cache[require.resolve("../scripts/store/device")];
  return require("../scripts/store/device");
}

beforeEach(() => {
  secure = new Map();
  prefs = new Map();
  keychainWritable = true;
  prefsWritable = true;
  global.$keychain = {
    get: (key, domain) => secure.get(`${domain}:${key}`),
    set: (key, value, domain) => {
      if (!keychainWritable) return false;
      secure.set(`${domain}:${key}`, String(value));
      return true;
    },
  };
  global.$prefs = {
    get: (key) => prefs.get(key),
    set: (key, value) => {
      if (!prefsWritable) return false;
      prefs.set(key, value);
      return true;
    },
  };
});

test("device identifier is stable once persisted to Keychain", () => {
  const device = loadDevice();
  const first = device.getDeviceIdentifier();
  const second = device.getDeviceIdentifier();

  assert.match(first, /^[0-9A-F]{12}$/);
  assert.strictEqual(second, first);
  assert.strictEqual(secure.get(`${device.DOMAIN}:${device.KEY}`), first);
});

test("device identifier falls back to prefs when Keychain cannot write", () => {
  keychainWritable = false;
  const device = loadDevice();
  const value = device.getDeviceIdentifier();

  assert.match(value, /^[0-9A-F]{12}$/);
  assert.strictEqual(prefs.get(device.PREF_KEY), value);
});

test("device identifier fails closed when neither storage can persist it", () => {
  keychainWritable = false;
  prefsWritable = false;
  const device = loadDevice();

  assert.throws(
    () => device.getDeviceIdentifier(),
    /无法持久化设备标识/
  );
});
