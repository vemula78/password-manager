import { beforeEach, describe, expect, it } from "vitest";
import type { KdfParams, VaultHeader } from "@pw/core";
import { buildApp } from "../src/index.js";
import { InMemorySyncRepository } from "../src/memory-repo.js";
import type { ServerConfig } from "../src/auth.js";

function fakeKdf(): KdfParams {
  return { alg: "argon2id13", opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, saltB64: "AAAAAAAAAAAAAAAAAAAAAA==" };
}

function fakeHeader(): VaultHeader {
  return {
    version: 1,
    kdf: fakeKdf(),
    vkEnvelopes: { kek: { nonceB64: "n", ctB64: "c" } },
    bkEnvelopes: { kek: { nonceB64: "n", ctB64: "c" } },
    createdAt: new Date().toISOString(),
  };
}

const config: ServerConfig = { serverSecret: Buffer.from("test-secret-at-least-32-bytes-long!!") };

describe("auth routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repo: InMemorySyncRepository;

  beforeEach(async () => {
    repo = new InMemorySyncRepository();
    app = await buildApp(repo, config);
  });

  it("GET /kdf returns a deterministic dummy for unknown accounts", async () => {
    const r1 = await app.inject({ method: "GET", url: "/kdf?accountId=unknown-1" });
    const r2 = await app.inject({ method: "GET", url: "/kdf?accountId=unknown-1" });
    const r3 = await app.inject({ method: "GET", url: "/kdf?accountId=unknown-2" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual(r2.json());
    expect(r1.json()).not.toEqual(r3.json());
  });

  it("GET /kdf returns the real account's kdf params for a registered account", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        label: "primary",
        kdf: fakeKdf(),
        authTokenB64: "dG9rZW4x",
        header: fakeHeader(),
        deviceId: "device-1",
        deviceLabel: "MacBook",
      },
    });
    expect(reg.statusCode).toBe(201);
    const { accountId } = reg.json();

    const kdfRes = await app.inject({ method: "GET", url: `/kdf?accountId=${accountId}` });
    expect(kdfRes.json()).toEqual({ kdf: fakeKdf() });
  });

  it("rejects login with the wrong authToken", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        label: "primary",
        kdf: fakeKdf(),
        authTokenB64: "Y29ycmVjdA==",
        header: fakeHeader(),
        deviceId: "device-1",
        deviceLabel: "MacBook",
      },
    });
    const { accountId } = reg.json();

    const login = await app.inject({
      method: "POST",
      url: "/login",
      payload: { accountId, authTokenB64: "d3Jvbmc=", deviceId: "device-1", deviceLabel: "MacBook" },
    });
    expect(login.statusCode).toBe(401);
  });

  it("logs in with the correct authToken and issues a working access token", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        label: "primary",
        kdf: fakeKdf(),
        authTokenB64: "Y29ycmVjdA==",
        header: fakeHeader(),
        deviceId: "device-1",
        deviceLabel: "MacBook",
      },
    });
    const { accountId } = reg.json();

    const login = await app.inject({
      method: "POST",
      url: "/login",
      payload: { accountId, authTokenB64: "Y29ycmVjdA==", deviceId: "device-1", deviceLabel: "MacBook" },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken } = login.json();

    const changes = await app.inject({
      method: "GET",
      url: "/vault/changes?since=0",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(changes.statusCode).toBe(200);
  });

  it("refresh rotates the refresh token and revoke kills it", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        label: "primary",
        kdf: fakeKdf(),
        authTokenB64: "Y29ycmVjdA==",
        header: fakeHeader(),
        deviceId: "device-1",
        deviceLabel: "MacBook",
      },
    });
    const { accountId, accessToken, refreshToken } = reg.json();
    const auth = { authorization: `Bearer ${accessToken}` };

    const refreshed = await app.inject({
      method: "POST",
      url: "/refresh",
      payload: { accountId, deviceId: "device-1", refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const { refreshToken: newRefreshToken } = refreshed.json();

    // old refresh token no longer works
    const reusedOld = await app.inject({
      method: "POST",
      url: "/refresh",
      payload: { accountId, deviceId: "device-1", refreshToken },
    });
    expect(reusedOld.statusCode).toBe(401);

    const revoke = await app.inject({
      method: "POST",
      url: "/devices/revoke",
      headers: auth,
      payload: { deviceId: "device-1" },
    });
    expect(revoke.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: "POST",
      url: "/refresh",
      payload: { accountId, deviceId: "device-1", refreshToken: newRefreshToken },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("rejects requests without a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/vault/changes?since=0" });
    expect(res.statusCode).toBe(401);
  });

  describe("device revocation authorization (review §7)", () => {
    async function register(app: Awaited<ReturnType<typeof buildApp>>, deviceId = "device-1") {
      const reg = await app.inject({
        method: "POST",
        url: "/register",
        payload: {
          label: "primary",
          kdf: fakeKdf(),
          authTokenB64: "Y29ycmVjdA==",
          header: fakeHeader(),
          deviceId,
          deviceLabel: "MacBook",
        },
      });
      return reg.json() as { accountId: string; accessToken: string; refreshToken: string };
    }

    it("rejects an unauthenticated revoke request", async () => {
      const { accountId } = await register(app);
      const res = await app.inject({
        method: "POST",
        url: "/devices/revoke",
        payload: { accountId, deviceId: "device-1" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("cannot revoke a device on a different account (accountId is derived from the token, not the body)", async () => {
      const victim = await register(app, "victim-device");
      const auth = { authorization: `Bearer ${victim.accessToken}` };

      // Attacker holds a valid token (their own, or here the victim's — either way the
      // accountId used is whatever the TOKEN says) but supplies a fabricated cross-account
      // accountId/deviceId in the body, hoping the server trusts the body instead.
      const res = await app.inject({
        method: "POST",
        url: "/devices/revoke",
        headers: auth,
        payload: { accountId: "someone-elses-account", deviceId: "someone-elses-device" },
      });
      // The body's accountId is ignored; the token's own account has no such device.
      expect(res.statusCode).toBe(404);

      // The victim's own device is untouched — refresh still works.
      const refreshed = await app.inject({
        method: "POST",
        url: "/refresh",
        payload: { accountId: victim.accountId, deviceId: "victim-device", refreshToken: victim.refreshToken },
      });
      expect(refreshed.statusCode).toBe(200);
    });

    it("revokes only the caller's own device", async () => {
      const { accessToken, accountId, refreshToken } = await register(app);
      const auth = { authorization: `Bearer ${accessToken}` };

      const res = await app.inject({
        method: "POST",
        url: "/devices/revoke",
        headers: auth,
        payload: { deviceId: "device-1" },
      });
      expect(res.statusCode).toBe(204);

      const refreshed = await app.inject({
        method: "POST",
        url: "/refresh",
        payload: { accountId, deviceId: "device-1", refreshToken },
      });
      expect(refreshed.statusCode).toBe(401);
    });
  });

  // Review §9: /register, /login, /refresh were unauthenticated and unlimited.
  describe("rate limiting and registration gating (review §9)", () => {
    it("closes registration by default once one account exists", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/register",
        payload: {
          label: "primary",
          kdf: fakeKdf(),
          authTokenB64: "Y29ycmVjdA==",
          header: fakeHeader(),
          deviceId: "device-1",
          deviceLabel: "MacBook",
        },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: "/register",
        payload: {
          label: "second",
          kdf: fakeKdf(),
          authTokenB64: "b3RoZXI=",
          header: fakeHeader(),
          deviceId: "device-2",
          deviceLabel: "iPhone",
        },
      });
      expect(second.statusCode).toBe(403);
    });

    it("REGISTRATION_OPEN allows a second account when explicitly set", async () => {
      const openRepo = new InMemorySyncRepository();
      const openApp = await buildApp(openRepo, { ...config, registrationOpen: true });

      const first = await openApp.inject({
        method: "POST",
        url: "/register",
        payload: {
          label: "primary",
          kdf: fakeKdf(),
          authTokenB64: "Y29ycmVjdA==",
          header: fakeHeader(),
          deviceId: "device-1",
          deviceLabel: "MacBook",
        },
      });
      expect(first.statusCode).toBe(201);

      const second = await openApp.inject({
        method: "POST",
        url: "/register",
        payload: {
          label: "second",
          kdf: fakeKdf(),
          authTokenB64: "b3RoZXI=",
          header: fakeHeader(),
          deviceId: "device-2",
          deviceLabel: "iPhone",
        },
      });
      expect(second.statusCode).toBe(201);
    });

    it("rate-limits /login per IP, tighter than /kdf's 30/min", async () => {
      const reg = await app.inject({
        method: "POST",
        url: "/register",
        payload: {
          label: "primary",
          kdf: fakeKdf(),
          authTokenB64: "Y29ycmVjdA==",
          header: fakeHeader(),
          deviceId: "device-1",
          deviceLabel: "MacBook",
        },
      });
      const { accountId } = reg.json();

      let sawRateLimited = false;
      for (let i = 0; i < 15; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/login",
          payload: { accountId, authTokenB64: "d3Jvbmc=", deviceId: "device-1", deviceLabel: "MacBook" },
        });
        if (res.statusCode === 429) {
          sawRateLimited = true;
          break;
        }
        expect(res.statusCode).toBe(401); // wrong password, but not yet rate-limited
      }
      expect(sawRateLimited).toBe(true);
    });

    it("rate-limits /register per IP", async () => {
      const openRepo = new InMemorySyncRepository();
      const openApp = await buildApp(openRepo, { ...config, registrationOpen: true });

      let sawRateLimited = false;
      for (let i = 0; i < 10; i++) {
        const res = await openApp.inject({
          method: "POST",
          url: "/register",
          payload: {
            label: `account-${i}`,
            kdf: fakeKdf(),
            authTokenB64: "Y29ycmVjdA==",
            header: fakeHeader(),
            deviceId: `device-${i}`,
            deviceLabel: "MacBook",
          },
        });
        if (res.statusCode === 429) {
          sawRateLimited = true;
          break;
        }
      }
      expect(sawRateLimited).toBe(true);
    });
  });
});
