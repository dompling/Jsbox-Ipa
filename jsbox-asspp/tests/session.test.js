const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const session = require("../scripts/apple/session");
const accounts = require("../scripts/store/accounts");
const auth = require("../scripts/apple/auth");

function expiredError() {
  const err = new Error("登录已过期，请重新登录");
  err.code = "2034";
  return err;
}

beforeEach(() => {
  global.$prefs = {
    get: () => undefined,
    set: () => true,
  };
  accounts.getAccount = (email) => ({
    email: String(email).trim().toLowerCase(),
    autoRelogin: true,
    deviceIdentifier: "GUID1",
    passwordToken: "stale",
    cookies: [],
  });
  accounts.saveAccount = (value) => value;
  auth.authenticate = async (options) => ({
    email: options.email,
    passwordToken: "fresh-token",
    directoryServicesIdentifier: "ds1",
    cookies: [{ name: "fresh", value: "1", domain: "itunes.apple.com" }],
    deviceIdentifier: options.deviceId,
  });
});

test("withFreshSession re-authenticates with stored password and retries once on expiry", async () => {
  accounts.getAutoLoginPassword = () => "saved-password";
  let runs = 0;
  let authCalls = 0;
  auth.authenticate = async (options) => {
    authCalls += 1;
    assert.strictEqual(options.password, "saved-password");
    assert.strictEqual(options.deviceId, "GUID1");
    return {
      email: options.email,
      passwordToken: "fresh-token",
      cookies: [],
      deviceIdentifier: options.deviceId,
    };
  };

  const run = async (account) => {
    runs += 1;
    if (runs === 1) {
      assert.strictEqual(account.passwordToken, "stale");
      throw expiredError();
    }
    assert.strictEqual(account.passwordToken, "fresh-token");
    return { apps: ["A", "B"] };
  };

  const value = await session.withFreshSession(
    { email: "user@example.com", autoRelogin: true, passwordToken: "stale" },
    run
  );
  assert.deepStrictEqual(value, { apps: ["A", "B"] });
  assert.strictEqual(runs, 2);
  assert.strictEqual(authCalls, 1);
});

test("without a stored password the expiry error is rethrown and no re-auth is attempted", async () => {
  accounts.getAutoLoginPassword = () => null;
  let authCalls = 0;
  auth.authenticate = async () => {
    authCalls += 1;
    throw new Error("unexpected");
  };

  await assert.rejects(
    session.withFreshSession(
      { email: "user@example.com", autoRelogin: true },
      async () => {
        throw expiredError();
      }
    ),
    /登录已过期/
  );
  assert.strictEqual(authCalls, 0);
});

test("a non-expiry error is not treated as a re-login trigger", async () => {
  accounts.getAutoLoginPassword = () => "saved-password";
  let authCalls = 0;
  auth.authenticate = async () => {
    authCalls += 1;
    return { email: "user@example.com" };
  };

  await assert.rejects(
    session.withFreshSession(
      { email: "user@example.com", autoRelogin: true },
      async () => {
        throw new Error("网络超时");
      }
    ),
    /网络超时/
  );
  assert.strictEqual(authCalls, 0);
});
