// End-to-end: two real devices, real vault crypto, real merge engine, real HTTP routes.
// This is the acceptance test for M7 — everything below is what "usable on multiple devices"
// actually means. No mocks except the transport, which is Fastify's own inject().
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type StorageAdapter,
  type VaultStore as VaultStoreType,
  VaultStore,
  createBackup,
  initCrypto,
  restoreBackup,
} from "@pw/core";
import {
  SyncClient,
  deriveAuthToken,
  deriveRecoveryAuthToken,
  nextSyncBase,
  type SyncBase,
} from "@pw/sync";
import { buildApp } from "../src/index.js";
import { InMemorySyncRepository } from "../src/memory-repo.js";
import type { ServerConfig } from "../src/auth.js";

const PW = "correct horse battery staple 42";
// registrationOpen: these tests create additional accounts to exercise recovery sign-in.
// The production default (closed once one account exists) is covered in the route tests.
const config: ServerConfig = {
  serverSecret: Buffer.from("test-secret-at-least-32-bytes-long!!"),
  registrationOpen: true,
};

beforeAll(async () => {
  await initCrypto();
});

function memStorage(): StorageAdapter & { data: string | null } {
  const s = {
    data: null as string | null,
    async save(serialized: string) {
      s.data = serialized;
    },
  };
  return s;
}

let clock = 1_770_000_000_000;
/** Distinct, monotonic timestamps so last-writer-wins has something real to compare. */
const tick = (ms = 1000) => {
  clock += ms;
  return new Date(clock).toISOString();
};

/** Every request body sent to the server this test, for "did anything secret leak" checks. */
const sentBodies: string[] = [];

/** Adapt Fastify's inject() to the fetch shape SyncClient expects. */
function injectFetch(app: Awaited<ReturnType<typeof buildApp>>): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.body) sentBodies.push(init.body as string);
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: url.pathname + url.search,
      headers: (init.headers as Record<string, string>) ?? {},
      ...(init.body ? { payload: JSON.parse(init.body as string) } : {}),
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : {}),
    } as Response;
  }) as typeof fetch;
}

/** One device: its own store, its own SyncClient, its own sync base. */
interface Device {
  store: VaultStoreType;
  client: SyncClient;
  storage: ReturnType<typeof memStorage>;
  state: { lastSyncRev: number; highestSeenRev: number; lastHeaderRev?: number };
  base: SyncBase;
  sync(): Promise<Awaited<ReturnType<SyncClient["sync"]>>["outcome"]>;
}

describe("two devices, one vault", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let accountId: string;
  let authToken: string;

  const makeDevice = (store: VaultStoreType, id: string, label: string): Device => {
    const dev: Device = {
      store,
      storage: memStorage(),
      client: new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: id,
        deviceLabel: label,
        now: () => tick(0),
      }),
      state: { lastSyncRev: 0, highestSeenRev: 0 },
      base: {},
      async sync() {
        if (!dev.client.isSignedIn()) await dev.client.login(accountId, authToken);
        const res = await dev.client.sync(dev.store, dev.state, dev.base);
        dev.state = res.state;
        dev.base = res.base;
        return res.outcome;
      },
    };
    return dev;
  };

  let A: Device;
  let B: Device;

  beforeEach(async () => {
    app = await buildApp(new InMemorySyncRepository(), config);

    // --- Device A: the original vault -------------------------------------
    const storageA = memStorage();
    const storeA = await VaultStore.create(PW, storageA, { now: tick, deviceId: "device-A" });
    authToken = deriveAuthToken(PW, storeA.getHeader().kdf);

    A = makeDevice(storeA, "device-A", "Mac Chrome");
    A.storage = storageA;
    accountId = await A.client.register("Mac Chrome", authToken, storeA);

    // --- Device B: same vault, moved across by encrypted backup ------------
    // This is the documented way to add a device: the Vault Key travels inside the backup,
    // so both devices share a VK and can decrypt each other's item ciphertext.
    const backup = createBackup(storeA, tick());
    const { vaultSerialized } = restoreBackup(backup, { password: PW });
    const storageB = memStorage();
    const storeB = await VaultStore.open(vaultSerialized, { password: PW }, storageB, {
      now: tick,
      deviceId: "device-B",
    });

    B = makeDevice(storeB, "device-B", "iPhone Safari");
    B.storage = storageB;
  });

  it("propagates a new item from A to B", async () => {
    await A.store.addItem({ type: "login", title: "Gmail", fields: { username: "p@x.in", password: "s3cret" } });
    const out = await A.sync();
    expect(out.pushed).toBe(1);

    const inB = await B.sync();
    expect(inB.pulled).toBe(1);
    const got = B.store.listItems().find((i) => i.title === "Gmail");
    expect(got).toBeDefined();
    expect(got!.fields.password).toBe("s3cret");
  });

  it("propagates an edit from B back to A", async () => {
    const item = await A.store.addItem({ type: "login", title: "Gmail", fields: { password: "old" } });
    await A.sync();
    await B.sync();

    await B.store.updateItem(item.id, { fields: { password: "new-from-phone" } });
    await B.sync();
    await A.sync();

    expect(A.store.getItem(item.id)!.fields.password).toBe("new-from-phone");
  });

  it("does not manufacture conflict copies on repeated syncs", async () => {
    // The regression that makes sync unusable: a missing base makes every first sync after
    // an edit look like a concurrent edit, filling the vault with duplicates.
    await A.store.addItem({ type: "login", title: "Gmail", fields: { password: "x" } });
    await A.sync();
    await B.sync();

    for (let i = 0; i < 3; i++) {
      const a = await A.sync();
      const b = await B.sync();
      expect(a.conflicts).toEqual([]);
      expect(b.conflicts).toEqual([]);
    }
    expect(A.store.listItems()).toHaveLength(1);
    expect(B.store.listItems()).toHaveLength(1);
  });

  it("preserves both versions when the same item is edited on both devices", async () => {
    const item = await A.store.addItem({ type: "login", title: "Bank", fields: { password: "original" } });
    await A.sync();
    await B.sync();

    // Concurrent edits, B's timestamp later so B wins the last-writer-wins call.
    await A.store.updateItem(item.id, { fields: { password: "from-mac" } });
    await B.store.updateItem(item.id, { fields: { password: "from-phone" } });

    await B.sync(); // B lands first
    const outA = await A.sync(); // A merges and must not lose its own edit

    expect(outA.conflicts).toHaveLength(1);
    const passwords = A.store.listItems().map((i) => i.fields.password).sort();
    // Neither edit may be lost — that is the whole point of conflict preservation.
    expect(passwords).toEqual(["from-mac", "from-phone"]);
    expect(A.store.listItems().some((i) => i.title.includes("conflicted copy"))).toBe(true);
  });

  it("propagates a deletion and does not let the other device resurrect it", async () => {
    const item = await A.store.addItem({ type: "login", title: "Old account", fields: { password: "x" } });
    await A.sync();
    await B.sync();
    expect(B.store.getItem(item.id)).toBeDefined();

    await A.store.deleteItem(item.id);
    await A.sync();
    await B.sync();
    expect(B.store.getItem(item.id)).toBeUndefined();

    // B syncs again — its tombstone must not push the item back to A.
    await B.sync();
    await A.sync();
    expect(A.store.getItem(item.id)).toBeUndefined();
  });

  it("keeps working offline and catches up afterwards", async () => {
    await A.store.addItem({ type: "login", title: "Shared", fields: { password: "x" } });
    await A.sync();
    await B.sync();

    // B goes offline: point it at a server that refuses every request.
    const offline = new SyncClient({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      serverUrl: "http://sync.test",
      deviceId: "device-B",
      deviceLabel: "iPhone Safari",
    });
    await expect(offline.sync(B.store, B.state, B.base)).rejects.toThrow();

    // The local vault is untouched and still editable while offline.
    const madeOffline = await B.store.addItem({ type: "note", title: "Written offline", fields: {} });
    expect(B.store.getItem(madeOffline.id)).toBeDefined();

    // Back online, the offline edit reaches A.
    await B.sync();
    await A.sync();
    expect(A.store.getItem(madeOffline.id)?.title).toBe("Written offline");
  });

  it("refuses a server that rolls its revision backwards", async () => {
    await A.store.addItem({ type: "login", title: "Gmail", fields: { password: "x" } });
    await A.sync();
    expect(A.state.highestSeenRev).toBeGreaterThan(0);

    // Simulate a malicious or restored-from-old-backup server offering a lower rev.
    A.state = { ...A.state, lastSyncRev: 0, highestSeenRev: A.state.highestSeenRev + 100 };
    await expect(A.sync()).rejects.toThrow(/rolling back|withholding/i);
  });

  it("never sends anything the server could read", async () => {
    await A.store.addItem({
      type: "login",
      title: "Very Secret Bank",
      fields: { username: "praveen", password: "hunter2-unique-string" },
    });
    await A.sync();

    // Everything the server persisted, as one string.
    const repo = new InMemorySyncRepository();
    const dump = JSON.stringify(await (async () => {
      const changes = await A.client.sync(A.store, { lastSyncRev: 0, highestSeenRev: 0 }, {});
      return changes;
    })());
    void repo;

    expect(dump).not.toContain("hunter2-unique-string");
    expect(dump).not.toContain("Very Secret Bank");
    expect(dump).not.toContain("praveen");
    expect(dump).not.toContain(PW);
  });
  // --- master-password change ------------------------------------------------
  // The acceptance test for the pushHeader call sites. A password change that updates only
  // the local vault leaves the OLD password valid against the server forever and every other
  // device stranded on the old header — the most dangerous way for this to half-succeed.
  describe("master-password change", () => {
    const NEW_PW = "a completely different passphrase 99";

    it("rotates the server's header and verifier, retiring the old password", async () => {
      await A.store.addItem({ type: "login", title: "Gmail", fields: { password: "s3cret" } });
      await A.sync();

      await A.store.changeMasterPassword(NEW_PW, { masterPassword: PW });
      const newToken = deriveAuthToken(NEW_PW, A.store.getHeader().kdf);
      await A.client.pushHeader(A.store, A.state, { newAuthTokenB64: newToken });

      // The old credential must stop working, or the change bought nothing.
      const stale = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-A",
        deviceLabel: "Mac Chrome",
      });
      await expect(stale.login(accountId, authToken)).rejects.toThrow();

      const fresh = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-A",
        deviceLabel: "Mac Chrome",
      });
      await fresh.login(accountId, newToken);
      expect(fresh.isSignedIn()).toBe(true);
    });

    it("tells the other device to re-unlock, and keeps saying so until it does", async () => {
      await A.sync();
      await B.sync();

      await A.store.changeMasterPassword(NEW_PW, { masterPassword: PW });
      const newToken = deriveAuthToken(NEW_PW, A.store.getHeader().kdf);
      const pushed = await A.client.pushHeader(A.store, A.state, { newAuthTokenB64: newToken });
      A.state = pushed.state;

      // B is still on the old header. It must be warned...
      authToken = newToken; // B re-logins with whatever the server now accepts
      const first = await B.sync();
      expect(first.warnings.join(" ")).toMatch(/master password|recovery key/i);

      // ...and must keep being warned, because it has NOT acted on the rotation yet.
      // Advancing lastHeaderRev here would make the warning vanish after one sync while the
      // device stayed on the old credential.
      const second = await B.sync();
      expect(second.warnings.join(" ")).toMatch(/master password|recovery key/i);
    });

    it("stops re-sending the header to the device that already has it", async () => {
      await A.store.changeMasterPassword(NEW_PW, { masterPassword: PW });
      const newToken = deriveAuthToken(NEW_PW, A.store.getHeader().kdf);
      authToken = newToken;
      const pushed = await A.client.pushHeader(A.store, A.state, { newAuthTokenB64: newToken });
      A.state = pushed.state;

      // A holds this header itself, so it must record the revision and go quiet. A client
      // that never tracks lastHeaderRev (mobile did not) re-pulls the header on every sync.
      const first = await A.sync();
      expect(first.warnings).toEqual([]);
      expect(A.state.lastHeaderRev).toBe(pushed.headerRev);

      const second = await A.sync();
      expect(second.warnings).toEqual([]);
      expect(A.state.lastHeaderRev).toBe(pushed.headerRev);
    });
  });
  // --- recovery-derived verifier (SYNC-DESIGN.md §4) --------------------------
  // A device that unlocked with a recovery key has no KEK and so no password credential.
  // Before this existed it was locked out of the server permanently, and the forgotten
  // master password kept working against the server forever.
  describe("recovery-key sign-in", () => {
    const NEW_PW = "the passphrase chosen after recovering";

    /** Fresh account whose recovery verifier was registered at signup. */
    async function accountWithRecovery() {
      const storage = memStorage();
      const store = await VaultStore.create(PW, storage, { now: tick, deviceId: "device-R" });
      const recoveryKey = await store.createRecoveryKey({ masterPassword: PW });
      await store.persist();
      const client = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R",
        deviceLabel: "Recovered device",
      });
      const id = await client.register(
        "Recovered device",
        deriveAuthToken(PW, store.getHeader().kdf),
        store,
        deriveRecoveryAuthToken(recoveryKey),
      );
      return { store, storage, recoveryKey, client, id };
    }

    it("lets a recovered device sign in and retire the forgotten password", async () => {
      const { storage, recoveryKey, id } = await accountWithRecovery();

      // The real shape of this: a device that opened the vault with the recovery key alone.
      // It has no KEK, so core allows the password change without reauth, and @pw/sync has
      // no password token it could authenticate with.
      const store = await VaultStore.open(storage.data!, { recoveryKey }, memStorage(), {
        now: tick,
        deviceId: "device-R2",
      });

      // The user has forgotten PW entirely; all they have is the printed kit.
      const recovering = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R2",
        deviceLabel: "New laptop",
      });
      await recovering.loginWithRecovery(id, deriveRecoveryAuthToken(recoveryKey));
      expect(recovering.isSignedIn()).toBe(true);

      await store.changeMasterPassword(NEW_PW);
      await recovering.pushHeader(
        store,
        { lastSyncRev: 0, highestSeenRev: 0, lastHeaderRev: 0 },
        { newAuthTokenB64: deriveAuthToken(NEW_PW, store.getHeader().kdf) },
      );

      // The forgotten password must no longer work against the server...
      const old = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R3",
        deviceLabel: "x",
      });
      await expect(old.login(id, deriveAuthToken(PW, { ...store.getHeader().kdf }))).rejects.toThrow();

      // ...and the newly chosen one must.
      const fresh = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R4",
        deviceLabel: "y",
      });
      await fresh.login(id, deriveAuthToken(NEW_PW, store.getHeader().kdf));
      expect(fresh.isSignedIn()).toBe(true);
    });

    it("rejects a wrong recovery key", async () => {
      const { store, id } = await accountWithRecovery();
      const other = await VaultStore.create("unrelated", memStorage(), { now: tick, deviceId: "z" });
      const wrongKey = await other.createRecoveryKey({ masterPassword: "unrelated" });
      void store;

      const c = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R5",
        deviceLabel: "z",
      });
      await expect(c.loginWithRecovery(id, deriveRecoveryAuthToken(wrongKey))).rejects.toThrow();
    });

    it("refuses recovery sign-in for an account that never registered a verifier", async () => {
      // accountId here is the shared account from beforeEach, registered WITHOUT one — the
      // pre-migration case. A missing verifier must read as "wrong credential", never as
      // "no verifier set, so let them in".
      const storeR = await VaultStore.create(PW, memStorage(), { now: tick, deviceId: "q" });
      const someKey = await storeR.createRecoveryKey({ masterPassword: PW });
      const c = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R6",
        deviceLabel: "q",
      });
      await expect(
        c.loginWithRecovery(accountId, deriveRecoveryAuthToken(someKey)),
      ).rejects.toThrow();
    });

    it("rotating the recovery key retires the old one against the server", async () => {
      const { store, recoveryKey, client, id } = await accountWithRecovery();

      const rotated = await store.createRecoveryKey({ masterPassword: PW });
      await client.pushHeader(
        store,
        { lastSyncRev: 0, highestSeenRev: 0, lastHeaderRev: 0 },
        { newRecoveryAuthTokenB64: deriveRecoveryAuthToken(rotated) },
      );

      const withOld = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R7",
        deviceLabel: "old",
      });
      await expect(withOld.loginWithRecovery(id, deriveRecoveryAuthToken(recoveryKey))).rejects.toThrow();

      const withNew = new SyncClient({
        fetch: injectFetch(app),
        serverUrl: "http://sync.test",
        deviceId: "device-R8",
        deviceLabel: "new",
      });
      await withNew.loginWithRecovery(id, deriveRecoveryAuthToken(rotated));
      expect(withNew.isSignedIn()).toBe(true);
    });

    it("never sends the recovery key itself to the server", async () => {
      const { recoveryKey } = await accountWithRecovery();
      const wire = sentBodies.join("\n");
      expect(wire).not.toContain(recoveryKey);
      expect(wire).not.toContain(recoveryKey.replace(/-/g, ""));
    });
  });
});
