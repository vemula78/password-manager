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

async function registerAndLogin(app: Awaited<ReturnType<typeof buildApp>>) {
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
  const { accountId, accessToken } = reg.json();
  return { accountId, accessToken };
}

describe("sync routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp(new InMemorySyncRepository(), config);
  });

  it("push then pull round-trips an item", async () => {
    const { accessToken } = await registerAndLogin(app);
    const auth = { authorization: `Bearer ${accessToken}` };

    const push = await app.inject({
      method: "POST",
      url: "/vault/changes",
      headers: auth,
      payload: {
        baseRev: 0,
        items: [{ id: "item-1", ct: { nonceB64: "n1", ctB64: "c1" } }],
        deletions: [],
      },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({ rev: 1 });

    const pull = await app.inject({ method: "GET", url: "/vault/changes?since=0", headers: auth });
    expect(pull.statusCode).toBe(200);
    const body = pull.json();
    expect(body.rev).toBe(1);
    expect(body.items).toEqual([{ id: "item-1", ct: { nonceB64: "n1", ctB64: "c1" }, rev: 1 }]);
  });

  it("rejects a push with a stale baseRev with 409 + serverRev", async () => {
    const { accessToken } = await registerAndLogin(app);
    const auth = { authorization: `Bearer ${accessToken}` };

    await app.inject({
      method: "POST",
      url: "/vault/changes",
      headers: auth,
      payload: { baseRev: 0, items: [{ id: "a", ct: { nonceB64: "n", ctB64: "c" } }], deletions: [] },
    });

    const stalePush = await app.inject({
      method: "POST",
      url: "/vault/changes",
      headers: auth,
      payload: { baseRev: 0, items: [{ id: "b", ct: { nonceB64: "n", ctB64: "c" } }], deletions: [] },
    });
    expect(stalePush.statusCode).toBe(409);
    expect(stalePush.json()).toEqual({ error: "rev conflict", serverRev: 1 });
  });

  it("a deletion tombstone removes the item and is visible on pull, as an opaque sealed blob", async () => {
    const { accessToken } = await registerAndLogin(app);
    const auth = { authorization: `Bearer ${accessToken}` };

    await app.inject({
      method: "POST",
      url: "/vault/changes",
      headers: auth,
      payload: { baseRev: 0, items: [{ id: "a", ct: { nonceB64: "n", ctB64: "c" } }], deletions: [] },
    });
    // Tombstones are SEALED (SealedTombstone = { id, ct }): the server never receives or
    // stores a plaintext deletedAt/deviceId. `ct` is opaque and never inspected here.
    const sealedCt = { nonceB64: "tn", ctB64: "tc" };
    const delPush = await app.inject({
      method: "POST",
      url: "/vault/changes",
      headers: auth,
      payload: {
        baseRev: 1,
        items: [],
        deletions: [{ id: "a", ct: sealedCt }],
      },
    });
    expect(delPush.statusCode).toBe(200);

    const pull = await app.inject({ method: "GET", url: "/vault/changes?since=0", headers: auth });
    const body = pull.json();
    expect(body.items).toEqual([]);
    expect(body.deletions).toHaveLength(1);
    expect(body.deletions[0]).toEqual({ id: "a", ct: sealedCt });
    // No plaintext deletion metadata anywhere on the wire.
    expect(body.deletions[0]).not.toHaveProperty("deletedAt");
    expect(body.deletions[0]).not.toHaveProperty("deviceId");
  });

  it("rejects sync routes with an expired/garbage token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/vault/changes?since=0",
      headers: { authorization: "Bearer garbage.token" },
    });
    expect(res.statusCode).toBe(401);
  });

  describe("header push (master password rotation)", () => {
    it("rotates the header and the auth hash atomically, and the old token stops working", async () => {
      const { accountId, accessToken } = await registerAndLogin(app);
      const auth = { authorization: `Bearer ${accessToken}` };

      const newHeader = { ...fakeHeader(), createdAt: new Date().toISOString() };
      const headerPush = await app.inject({
        method: "POST",
        url: "/vault/header",
        headers: auth,
        payload: { baseHeaderRev: 0, header: newHeader, newAuthTokenB64: "bmV3dG9rZW4=" },
      });
      expect(headerPush.statusCode).toBe(200);
      expect(headerPush.json()).toEqual({ rev: 1 });

      // old authToken no longer logs in
      const oldLogin = await app.inject({
        method: "POST",
        url: "/login",
        payload: { accountId, authTokenB64: "Y29ycmVjdA==", deviceId: "device-1", deviceLabel: "MacBook" },
      });
      expect(oldLogin.statusCode).toBe(401);

      // new authToken does
      const newLogin = await app.inject({
        method: "POST",
        url: "/login",
        payload: { accountId, authTokenB64: "bmV3dG9rZW4=", deviceId: "device-1", deviceLabel: "MacBook" },
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it("rejects a stale baseHeaderRev with 409, leaving header and auth hash untouched", async () => {
      const { accountId, accessToken } = await registerAndLogin(app);
      const auth = { authorization: `Bearer ${accessToken}` };

      await app.inject({
        method: "POST",
        url: "/vault/header",
        headers: auth,
        payload: { baseHeaderRev: 0, header: fakeHeader(), newAuthTokenB64: "Zmlyc3Q=" },
      });

      const staleHeaderPush = await app.inject({
        method: "POST",
        url: "/vault/header",
        headers: auth,
        payload: { baseHeaderRev: 0, header: fakeHeader(), newAuthTokenB64: "c2Vjb25k" },
      });
      expect(staleHeaderPush.statusCode).toBe(409);
      expect(staleHeaderPush.json()).toEqual({ error: "header rev conflict", serverRev: 1 });

      // the first rotation's token still works — the rejected second push changed nothing
      const login = await app.inject({
        method: "POST",
        url: "/login",
        payload: { accountId, authTokenB64: "Zmlyc3Q=", deviceId: "device-1", deviceLabel: "MacBook" },
      });
      expect(login.statusCode).toBe(200);
    });

    it("header push without a new authToken leaves auth unchanged (password-independent header edit)", async () => {
      const { accountId, accessToken } = await registerAndLogin(app);
      const auth = { authorization: `Bearer ${accessToken}` };

      await app.inject({
        method: "POST",
        url: "/vault/header",
        headers: auth,
        payload: { baseHeaderRev: 0, header: fakeHeader() },
      });

      const login = await app.inject({
        method: "POST",
        url: "/login",
        payload: { accountId, authTokenB64: "Y29ycmVjdA==", deviceId: "device-1", deviceLabel: "MacBook" },
      });
      expect(login.statusCode).toBe(200);
    });
  });

  // Review §3: header_rev and account rev are separate counters. GET /vault/changes must
  // compare headerRev against `sinceHeader`, never against the item `since` — otherwise a
  // device whose item rev is already ahead of the header rev never sees a header change.
  it("returns the header when headerRev > sinceHeader even though item rev is far ahead (rev=10, headerRev=1)", async () => {
    const { accessToken } = await registerAndLogin(app);
    const auth = { authorization: `Bearer ${accessToken}` };

    // Push 10 item revisions.
    for (let i = 0; i < 10; i++) {
      const push = await app.inject({
        method: "POST",
        url: "/vault/changes",
        headers: auth,
        payload: { baseRev: i, items: [{ id: `item-${i}`, ct: { nonceB64: "n", ctB64: "c" } }], deletions: [] },
      });
      expect(push.statusCode).toBe(200);
    }

    // One header push -> headerRev becomes 1.
    const headerPush = await app.inject({
      method: "POST",
      url: "/vault/header",
      headers: auth,
      payload: { baseHeaderRev: 0, header: fakeHeader() },
    });
    expect(headerPush.statusCode).toBe(200);
    expect(headerPush.json()).toEqual({ rev: 1 });

    // A device already at item rev=10 pulling with sinceHeader=0 MUST still get the header —
    // comparing headerRev against `since` (10) would wrongly withhold it (1 > 10 is false).
    const pull = await app.inject({
      method: "GET",
      url: "/vault/changes?since=10&sinceHeader=0",
      headers: auth,
    });
    expect(pull.statusCode).toBe(200);
    const body = pull.json();
    expect(body.rev).toBe(10);
    expect(body.headerRev).toBe(1);
    expect(body.header).toBeDefined();

    // Once the device has recorded sinceHeader=1, it must not be sent again.
    const pullAgain = await app.inject({
      method: "GET",
      url: "/vault/changes?since=10&sinceHeader=1",
      headers: auth,
    });
    expect(pullAgain.json().header).toBeUndefined();
  });

  // A missing sinceHeader must be treated as 0, for compatibility with a client that hasn't
  // started sending it yet.
  it("treats a missing sinceHeader as 0", async () => {
    const { accessToken } = await registerAndLogin(app);
    const auth = { authorization: `Bearer ${accessToken}` };

    await app.inject({
      method: "POST",
      url: "/vault/header",
      headers: auth,
      payload: { baseHeaderRev: 0, header: fakeHeader() },
    });

    const pull = await app.inject({ method: "GET", url: "/vault/changes?since=0", headers: auth });
    expect(pull.json().header).toBeDefined();
  });

});
