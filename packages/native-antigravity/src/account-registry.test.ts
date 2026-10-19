import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AccountRegistry } from "./account-registry.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { startNativeProxy, NATIVE_PROXY_PORT } from "./native-proxy.js";
import { NativeRouteError, sha256 } from "./native-protocol.js";
import { ensureNativeBrowserReady } from "./browser-readiness.js";
import type { NativeBrowserBackend } from "./browser-backend.js";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("AccountRegistry initializes empty registry and persists atomic JSON", () => {
  const tmp = createTempDir("account-reg-init-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);
    assert.deepEqual(reg.list(), []);
    assert.equal(reg.getActive(), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureDefault adopts existing profile/state without copying cookies", () => {
  const tmp = createTempDir("account-reg-default-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);
    const existingProfile = path.join(tmp, "existing_profile");
    const existingState = path.join(tmp, "existing_state");
    fs.mkdirSync(existingProfile, { recursive: true });
    fs.mkdirSync(existingState, { recursive: true });
    fs.writeFileSync(path.join(existingProfile, "Cookies"), "dummy_cookie_data");

    const defaultAcc = reg.ensureDefault({
      profilePath: existingProfile,
      statePath: existingState,
      debugPort: 9223,
    });

    assert.ok(defaultAcc);
    assert.equal(defaultAcc.displayName, "Default Account");
    assert.equal(defaultAcc.debugPort, 9223);
    assert.equal(defaultAcc.enabled, true);
    assert.equal(reg.getActive()?.accountId, defaultAcc.accountId);

    // Call again; should return existing without duplicates
    const secondCall = reg.ensureDefault({
      profilePath: existingProfile,
      statePath: existingState,
    });
    assert.ok(secondCall);
    assert.equal(secondCall.accountId, defaultAcc.accountId);
    assert.equal(reg.list().length, 1);

    // Verify existing cookies were untouched
    assert.equal(fs.readFileSync(path.join(existingProfile, "Cookies"), "utf8"), "dummy_cookie_data");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("add() rejects profile conflict and CDP port collision, auto-allocates port", () => {
  const tmp = createTempDir("account-reg-add-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);

    const acc1 = reg.add({
      displayName: "Personal",
      profilePath: path.join(tmp, "profile1"),
      statePath: path.join(tmp, "state1"),
      debugPort: 9223,
    });
    assert.equal(acc1.debugPort, 9223);

    // Duplicate profile path should throw ACCOUNT_PROFILE_CONFLICT
    assert.throws(
      () => reg.add({
        displayName: "Conflict Profile",
        profilePath: path.join(tmp, "profile1"),
        statePath: path.join(tmp, "state2"),
      }),
      (err: unknown) => err instanceof NativeRouteError && err.code === "ACCOUNT_PROFILE_CONFLICT"
    );

    // Duplicate port should throw PORT_COLLISION
    assert.throws(
      () => reg.add({
        displayName: "Conflict Port",
        profilePath: path.join(tmp, "profile2"),
        statePath: path.join(tmp, "state2"),
        debugPort: 9223,
      }),
      (err: unknown) => err instanceof NativeRouteError && err.code === "PORT_COLLISION"
    );

    // Omitting port should auto-allocate next available port (9224)
    const acc2 = reg.add({
      displayName: "Work",
      profilePath: path.join(tmp, "profile2"),
      statePath: path.join(tmp, "state2"),
    });
    assert.equal(acc2.debugPort, 9224);
    assert.equal(reg.list().length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setActive, disable, enable, and find by id or display name", () => {
  const tmp = createTempDir("account-reg-switch-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);

    const a1 = reg.add({
      displayName: "Personal Account",
      profilePath: path.join(tmp, "p1"),
      statePath: path.join(tmp, "s1"),
    });
    const a2 = reg.add({
      displayName: "Work Account",
      profilePath: path.join(tmp, "p2"),
      statePath: path.join(tmp, "s2"),
    });

    // Active is a1 by default
    assert.equal(reg.getActive()?.accountId, a1.accountId);

    // Switch to Work Account by display name (case-insensitive)
    reg.setActive("work account");
    assert.equal(reg.getActive()?.accountId, a2.accountId);

    // Disable active account (Work Account); should auto-switch active to Personal Account
    reg.disable(a2.accountId);
    assert.equal(reg.getActive()?.accountId, a1.accountId);
    assert.equal(reg.get(a2.accountId)?.enabled, false);

    // Switching to disabled account throws ACCOUNT_DISABLED
    assert.throws(
      () => reg.setActive("Work Account"),
      (err: unknown) => err instanceof NativeRouteError && err.code === "ACCOUNT_DISABLED"
    );

    // Re-enable
    reg.enable(a2.accountId);
    assert.equal(reg.get(a2.accountId)?.enabled, true);

    // Lookup by find()
    assert.equal(reg.find("personal account")?.accountId, a1.accountId);
    assert.equal(reg.find(a2.accountId)?.displayName, "Work Account");
    assert.equal(reg.find("nonexistent"), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("disable account does NOT delete chat history or state files", () => {
  const tmp = createTempDir("account-reg-preservation-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);

    const statePath = path.join(tmp, "state1");
    fs.mkdirSync(statePath, { recursive: true });
    const historyFile = path.join(statePath, "conversation-history.json");
    fs.writeFileSync(historyFile, JSON.stringify({ conversations: [{ id: "c1", turns: 5 }] }));

    const acc = reg.add({
      displayName: "Preserved Account",
      profilePath: path.join(tmp, "p1"),
      statePath,
    });

    reg.disable(acc.accountId);
    assert.equal(reg.get(acc.accountId)?.enabled, false);

    // Conversation file is preserved exactly as was
    assert.ok(fs.existsSync(historyFile));
    const content = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    assert.equal(content.conversations[0].turns, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("AccountRegistry reloads on external disk change", () => {
  const tmp = createTempDir("account-reg-reload-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg1 = new AccountRegistry(regPath);
    const reg2 = new AccountRegistry(regPath);

    reg1.add({
      displayName: "External Account",
      profilePath: path.join(tmp, "p1"),
      statePath: path.join(tmp, "s1"),
    });

    // reg2 should pick up the addition on next access
    const list2 = reg2.list();
    assert.equal(list2.length, 1);
    assert.equal(list2[0].displayName, "External Account");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("NativeBrowserBackendPool isolates workers by profile, port, and identity", async () => {
  const tmp = createTempDir("pool-isolation-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);

    const a1 = reg.add({
      displayName: "Account A",
      profilePath: path.join(tmp, "pA"),
      statePath: path.join(tmp, "sA"),
      debugPort: 9223,
      identityFingerprint: "fingerprint_A",
    });
    const a2 = reg.add({
      displayName: "Account B",
      profilePath: path.join(tmp, "pB"),
      statePath: path.join(tmp, "sB"),
      debugPort: 9224,
      identityFingerprint: "fingerprint_B",
    });

    const instantiatedBackends: Array<{ accountId: string; backend: NativeBrowserBackend }> = [];
    const pool = new NativeBrowserBackendPool(reg, "dummy-cli.js", (account) => {
      const mockBackend: NativeBrowserBackend = {
        async generate(_requestId, _prompt, _signal) {
          return "response_from_" + account.displayName;
        },
        async close() {},
      };
      instantiatedBackends.push({ accountId: account.accountId, backend: mockBackend });
      return mockBackend;
    });

    // Request 1: active is Account A
    assert.equal(reg.getActive()?.accountId, a1.accountId);
    const resA = await pool.generate("req-1", "hello A", new AbortController().signal);
    assert.equal(resA, "response_from_Account A");
    assert.equal(instantiatedBackends.length, 1);
    assert.equal(instantiatedBackends[0].accountId, a1.accountId);

    // Switch active to Account B
    reg.setActive(a2.accountId);
    const resB = await pool.generate("req-2", "hello B", new AbortController().signal);
    assert.equal(resB, "response_from_Account B");
    assert.equal(instantiatedBackends.length, 2);
    assert.equal(instantiatedBackends[1].accountId, a2.accountId);

    // Switch back to Account A -> reuses existing worker without creating new one
    reg.setActive(a1.accountId);
    const resA2 = await pool.generate("req-3", "hello A again", new AbortController().signal);
    assert.equal(resA2, "response_from_Account A");
    assert.equal(instantiatedBackends.length, 2); // Still 2

    await pool.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Identity mismatch in profile throws ACCOUNT_IDENTITY_CHANGED before Send", async () => {
  // Detected identity differs from expected
  const call = async (name: string) => {
    if (name === "gemini_status") {
      return {
        browserState: "ready",
        accountState: "signed_in",
        activeRequestId: null,
        accountIdentity: {
          name: "Wrong Account",
          email: "wrong@example.com",
          fingerprint: sha256("wrong@example.com"),
        },
      };
    }
    return {};
  };

  await assert.rejects(
    ensureNativeBrowserReady(call, new AbortController().signal, 1000, sha256("expected@example.com")),
    (err: unknown) => {
      return err instanceof NativeRouteError &&
        err.code === "ACCOUNT_IDENTITY_CHANGED" &&
        err.phase === "checkpoint" &&
        err.delivery === "not_sent";
    }
  );
});

test("Health endpoint exposes active account summary and control switches account", async () => {
  const tmp = createTempDir("proxy-health-account-");
  try {
    const regPath = path.join(tmp, "accounts.json");
    const reg = new AccountRegistry(regPath);
    const acc1 = reg.add({
      displayName: "Default Account",
      profilePath: path.join(tmp, "p1"),
      statePath: path.join(tmp, "s1"),
      debugPort: 9223,
    });
    const acc2 = reg.add({
      displayName: "Secondary Account",
      profilePath: path.join(tmp, "p2"),
      statePath: path.join(tmp, "s2"),
      debugPort: 9224,
      identityFingerprint: "sec_fp",
    });

    const mockBackend: NativeBrowserBackend = {
      async generate() { return "ok"; },
      async close() {},
    };

    const controlToken = "test_token_123456789012345678901234";
    const proxy = await startNativeProxy({
      backend: mockBackend,
      accountRegistry: reg,
      stateDirectory: tmp,
      controlToken,
      port: 0, // OS assigned free port
    });

    try {
      // Check health
      const res1 = await fetch(`http://127.0.0.1:${proxy.port}/__native/health`);
      const body1 = await res1.json();
      assert.equal(body1.account.accountId, acc1.accountId);
      assert.equal(body1.account.displayName, "Default Account");
      assert.equal(body1.account.identityVerified, false);

      // Switch account via control endpoint
      const switchRes = await fetch(`http://127.0.0.1:${proxy.port}/__native/account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-native-control-token": controlToken,
        },
        body: JSON.stringify({ action: "use", accountId: acc2.accountId }),
      });
      assert.equal(switchRes.status, 200);

      // Check health again; active account must be Secondary
      const res2 = await fetch(`http://127.0.0.1:${proxy.port}/__native/health`);
      const body2 = await res2.json();
      assert.equal(body2.account.accountId, acc2.accountId);
      assert.equal(body2.account.displayName, "Secondary Account");
      assert.equal(body2.account.identityVerified, false);
      assert.equal(body2.account.identityRegistered, true);
    } finally {
      await proxy.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
