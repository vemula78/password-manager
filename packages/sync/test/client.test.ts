// SyncClient tests against a scripted fake server. The vault is a REAL VaultStore with real
// libsodium crypto, because the properties under test are cryptographic: a tombstone the
// server forged must fail to open, and an item it corrupted must fail its AEAD tag.
//
// The two cases that matter most (and the reason this file exists) are:
//   * a forged tombstone must destroy nothing, and
//   * any authentication failure must abort the cycle with NO revision advanced,
// because both of those previously ended in a permanently missing credential.
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type Ciphertext,
  type SealedTombstone,
  type StorageAdapter,
  type VaultHeader,
  type VaultItem,
  VaultStore,
  initCrypto,
  randomId,
} from "@pw/core";
import { SyncClient, type SyncState } from "../src/client";
import { nextSyncBase } from "../src/merge";
import {
  RollbackDetectedError,
  SyncHeaderConflictError,
  SyncIntegrityError,
  type ChangesResponse,
  type HeaderPushRequest,
  type PushRequest,
} from "../src/protocol";

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

let tick = 0;
const now = () => new Date(1_770_000_000_000 + tick++ * 1000).toISOString();

async function makeVault(deviceId = "dev-local"): Promise<VaultStore> {
  return VaultStore.create("a strong master passphrase", memStorage(), { now, deviceId });
}

/** What the fake server will answer with on GET /vault/changes. */
interface Scripted {
  rev: number;
  headerRev: number;
  header?: VaultHeader;
  items: { id: string; ct: Ciphertext; rev: number }[];
  deletions: SealedTombstone[];
}

interface FakeServer {
  script: Scripted;
  /** Set to 409 to make the next matching push conflict. */
  pushStatus: number;
  pushServerRev: number;
  headerStatus: number;
  headerServerRev: number;
  pushes: PushRequest[];
  headerPushes: HeaderPushRequest[];
  changesQueries: string[];
  fetch: typeof fetch;
}

function fakeServer(script: Partial<Scripted> = {}): FakeServer {
  const s: FakeServer = {
    script: { rev: 0, headerRev: 0, items: [], deletions: [], ...script },
    pushStatus: 200,
    pushServerRev: 0,
    headerStatus: 200,
    headerServerRev: 1,
    pushes: [],
    headerPushes: [],
    changesQueries: [],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://sync.test");
      const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (v: unknown, status = 200) =>
        ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => v,
        }) as Response;

      if (path === "/login" || path === "/register") {
        return ok({ accountId: "acct-1", accessToken: "tok", expiresIn: 1800, refreshToken: "r" });
      }
      if (path === "/vault/changes" && (init?.method ?? "GET") === "GET") {
        s.changesQueries.push(url.search);
        const c: ChangesResponse = {
          rev: s.script.rev,
          headerRev: s.script.headerRev,
          ...(s.script.header ? { header: s.script.header } : {}),
          items: s.script.items,
          deletions: s.script.deletions,
        };
        return ok(c);
      }
      if (path === "/vault/changes") {
        s.pushes.push(body as PushRequest);
        if (s.pushStatus === 409) return ok({ error: "rev conflict", serverRev: s.pushServerRev }, 409);
        s.script.rev += 1;
        return ok({ rev: s.script.rev });
      }
      if (path === "/vault/header") {
        s.headerPushes.push(body as HeaderPushRequest);
        if (s.headerStatus === 409) {
          return ok({ error: "header rev conflict", serverRev: s.headerServerRev }, 409);
        }
        if (s.headerStatus >= 400) return ok({ error: "boom" }, s.headerStatus);
        s.script.headerRev += 1;
        return ok({ rev: s.script.headerRev });
      }
      throw new Error(`unexpected request to ${path}`);
    }) as unknown as typeof fetch,
  };
  return s;
}

async function signedInClient(server: FakeServer, deviceLabel = "iPhone"): Promise<SyncClient> {
  const c = new SyncClient({
    fetch: server.fetch,
    serverUrl: "http://sync.test",
    deviceId: "dev-local",
    deviceLabel,
    now,
  });
  await c.login("acct-1", "token-b64");
  return c;
}

const freshState = (over: Partial<SyncState> = {}): SyncState => ({
  lastSyncRev: 0,
  highestSeenRev: 0,
  ...over,
});

async function addLogin(store: VaultStore, title: string): Promise<VaultItem> {
  return store.addItem({ type: "login", title, fields: { username: "u", password: "p" } });
}

/** Encrypt an item under ANOTHER vault's key — i.e. what a hostile server can actually make. */
async function foreignCiphertext(id: string): Promise<Ciphertext> {
  const other = await makeVault("dev-attacker");
  const item = await addLogin(other, "attacker");
  const cts = other.getItemCiphertexts();
  const ct = cts.find((c) => c.id === item.id)!.ct;
  // Re-label it as the victim's id: the AD binding (item:{id}) now mismatches too.
  return { ...ct };
}

// ---------------------------------------------------------------------------
// 1. CRITICAL — forged tombstones (review §1)
// ---------------------------------------------------------------------------

describe("forged tombstones", () => {
  it("does not delete anything for a tombstone the server fabricated", async () => {
    const store = await makeVault();
    const secret = await addLogin(store, "Bank");
    const base = nextSyncBase(store.listItems({ includeArchived: true }));

    // The server knows the opaque item id (it stores it) and invents a deletion for it.
    const server = fakeServer({
      rev: 5,
      deletions: [
        { id: secret.id, ct: { v: 1, n: "AAAA", c: "BBBB" } as unknown as Ciphertext },
      ],
    });
    const client = await signedInClient(server);

    await expect(client.sync(store, freshState(), base)).rejects.toBeInstanceOf(SyncIntegrityError);

    // The credential is still here, untouched.
    expect(store.getItem(secret.id)?.title).toBe("Bank");
    expect(store.listItems({ includeArchived: true })).toHaveLength(1);
    expect(store.getDeletions()).toHaveLength(0);
  });

  it("does not delete anything for a tombstone transplanted onto another item id", async () => {
    const store = await makeVault();
    const doomed = await addLogin(store, "Doomed");
    const keeper = await addLogin(store, "Keeper");
    await store.deleteItem(doomed.id);

    // A genuine sealed tombstone for `doomed`, re-labelled by the server as one for `keeper`.
    const genuine = store.getSealedDeletions()[0]!;
    expect(genuine.id).toBe(doomed.id);
    const transplanted: SealedTombstone = { id: keeper.id, ct: genuine.ct };

    const server = fakeServer({ rev: 5, deletions: [transplanted] });
    const client = await signedInClient(server);

    await expect(
      client.sync(store, freshState(), nextSyncBase(store.listItems({ includeArchived: true }))),
    ).rejects.toBeInstanceOf(SyncIntegrityError);
    expect(store.getItem(keeper.id)?.title).toBe("Keeper");
  });

  it("names the offending tombstone id and calls out tampering", async () => {
    const store = await makeVault();
    const secret = await addLogin(store, "Bank");
    const server = fakeServer({
      rev: 3,
      deletions: [{ id: secret.id, ct: { v: 1, n: "AAAA", c: "BBBB" } as unknown as Ciphertext }],
    });
    const client = await signedInClient(server);

    const err = await client.sync(store, freshState(), {}).catch((e) => e);
    expect(err).toBeInstanceOf(SyncIntegrityError);
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0].kind).toBe("tombstone");
    expect(err.failures[0].id).toBe(secret.id);
    expect(err.message).toMatch(/TAMPERED/);
    expect(err.message).toMatch(/Nothing was applied/);
  });

  it("still honours a genuine sealed tombstone from another device", async () => {
    // Same vault key on both devices, so a real deletion made elsewhere opens fine here.
    const store = await makeVault("dev-a");
    const item = await addLogin(store, "Old card");
    await store.deleteItem(item.id);
    const sealed = store.getSealedDeletions()[0]!;
    // Put the item back so the tombstone arrives as if from the remote side.
    await store.applyMerge([item], [], [item.id]);
    expect(store.getItem(item.id)).toBeDefined();

    const server = fakeServer({ rev: 4, deletions: [sealed] });
    const client = await signedInClient(server);
    const { outcome } = await client.sync(store, freshState(), { [item.id]: item.updatedAt });

    expect(store.getItem(item.id)).toBeUndefined();
    expect(outcome.rev).toBeGreaterThanOrEqual(4);
  });

  it("pushes SEALED tombstones, never plaintext ones", async () => {
    const store = await makeVault();
    const item = await addLogin(store, "Gone");
    await store.deleteItem(item.id);

    const server = fakeServer({ rev: 2 });
    const client = await signedInClient(server);
    await client.sync(store, freshState(), {});

    expect(server.pushes).toHaveLength(1);
    const pushed = server.pushes[0]!.deletions;
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.id).toBe(item.id);
    expect(pushed[0]).toHaveProperty("ct");
    // No deletion time and no device attribution in the clear.
    expect(JSON.stringify(pushed[0])).not.toContain("deletedAt");
    expect(JSON.stringify(pushed[0])).not.toContain("dev-local");
  });
});

// ---------------------------------------------------------------------------
// 2. HIGH — failed authentication must abort the cycle (review §6)
// ---------------------------------------------------------------------------

describe("integrity failure aborts the whole cycle", () => {
  it("does not advance any revision when one item fails its AEAD tag", async () => {
    const store = await makeVault();
    const mine = await addLogin(store, "Mine");
    const state = freshState({ lastSyncRev: 4, highestSeenRev: 4 });
    const base = nextSyncBase(store.listItems({ includeArchived: true }));

    const server = fakeServer({
      rev: 9,
      items: [{ id: randomId(), ct: await foreignCiphertext("x"), rev: 9 }],
    });
    const client = await signedInClient(server);

    const err = await client.sync(store, state, base).catch((e) => e);
    expect(err).toBeInstanceOf(SyncIntegrityError);
    expect(err.failures[0].kind).toBe("item");

    // Nothing pushed, nothing merged, and the caller's state object is untouched, so the
    // next sync retries from exactly the same revision.
    expect(server.pushes).toHaveLength(0);
    expect(state).toEqual({ lastSyncRev: 4, highestSeenRev: 4 });
    expect(store.getItem(mine.id)?.title).toBe("Mine");
  });

  it("reports every failure, not just the first", async () => {
    const store = await makeVault();
    const a = await addLogin(store, "A");
    const server = fakeServer({
      rev: 3,
      items: [
        { id: randomId(), ct: await foreignCiphertext("x"), rev: 3 },
        { id: randomId(), ct: await foreignCiphertext("y"), rev: 3 },
      ],
      deletions: [{ id: a.id, ct: { v: 1, n: "AA", c: "BB" } as unknown as Ciphertext }],
    });
    const client = await signedInClient(server);

    const err = await client.sync(store, freshState(), {}).catch((e) => e);
    expect(err).toBeInstanceOf(SyncIntegrityError);
    expect(err.failures).toHaveLength(3);
    expect(err.failures.filter((f: { kind: string }) => f.kind === "item")).toHaveLength(2);
    expect(err.failures.filter((f: { kind: string }) => f.kind === "tombstone")).toHaveLength(1);
  });

  it("aborts before the local vault is touched, so no credential is lost", async () => {
    const store = await makeVault();
    const keep = await addLogin(store, "Keep me");
    const before = store.listItems({ includeArchived: true });

    const server = fakeServer({
      rev: 7,
      items: [{ id: randomId(), ct: await foreignCiphertext("z"), rev: 7 }],
    });
    const client = await signedInClient(server);
    await expect(client.sync(store, freshState(), {})).rejects.toBeInstanceOf(SyncIntegrityError);

    expect(store.listItems({ includeArchived: true })).toEqual(before);
    expect(store.getItem(keep.id)).toBeDefined();
  });

  it("a corrupted item is NOT skipped-and-forgotten: the retry still receives it", async () => {
    // Build a VALID ciphertext for an item this store does not hold, so it can only arrive
    // from the server — the exact shape of "a newly created remote item".
    const store = await makeVault();
    const incoming = await addLogin(store, "Remote entry");
    const validCt = store.getItemCiphertexts().find((c) => c.id === incoming.id)!.ct;
    await store.applyMerge([], [], []);
    expect(store.getItem(incoming.id)).toBeUndefined();

    const state = freshState({ lastSyncRev: 2, highestSeenRev: 2 });
    const server = fakeServer({
      rev: 6,
      items: [{ id: incoming.id, ct: await foreignCiphertext(incoming.id), rev: 6 }],
    });
    const client = await signedInClient(server);

    await expect(client.sync(store, state, {})).rejects.toBeInstanceOf(SyncIntegrityError);
    expect(state.lastSyncRev).toBe(2); // did NOT consume the revision

    // The server now serves the genuine copy at the same revision; because we never moved
    // past it, retrying from the unchanged state recovers the credential.
    server.script.items = [{ id: incoming.id, ct: validCt, rev: 6 }];
    const ok = await client.sync(store, state, {});
    expect(store.getItem(incoming.id)?.title).toBe("Remote entry");
    expect(ok.outcome.pulled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. HIGH — header revision is its own counter (review §3)
// ---------------------------------------------------------------------------

describe("header revision tracking", () => {
  it("sends sinceHeader alongside since, from a separate counter", async () => {
    const store = await makeVault();
    const server = fakeServer({ rev: 10, headerRev: 3 });
    const client = await signedInClient(server);

    await client.sync(store, freshState({ lastSyncRev: 10, highestSeenRev: 10, lastHeaderRev: 3 }), {});

    expect(server.changesQueries[0]).toContain("since=10");
    expect(server.changesQueries[0]).toContain("sinceHeader=3");
  });

  it("defaults sinceHeader to 0 for state persisted before this field existed", async () => {
    const store = await makeVault();
    const server = fakeServer({ rev: 2, headerRev: 0 });
    const client = await signedInClient(server);
    await client.sync(store, { lastSyncRev: 2, highestSeenRev: 2 }, {});
    expect(server.changesQueries[0]).toContain("sinceHeader=0");
  });

  it("advances lastHeaderRev independently of lastSyncRev", async () => {
    const store = await makeVault();
    const server = fakeServer({ rev: 8, headerRev: 4 });
    const client = await signedInClient(server);
    const { state } = await client.sync(store, freshState({ lastSyncRev: 8, highestSeenRev: 8 }), {});
    expect(state.lastHeaderRev).toBe(4);
    expect(state.lastSyncRev).toBe(8);
  });

  it("warns and does NOT advance lastHeaderRev when a foreign header arrives", async () => {
    const store = await makeVault();
    const foreign = (await makeVault("dev-other")).getHeader();
    const server = fakeServer({ rev: 5, headerRev: 2, header: foreign });
    const client = await signedInClient(server);

    const { state, outcome } = await client.sync(store, freshState({ lastSyncRev: 5, highestSeenRev: 5 }), {});
    expect(outcome.warnings.some((w) => w.includes("master password"))).toBe(true);
    // Still 0: the rotation has not been acted on, so the warning must not vanish next sync.
    expect(state.lastHeaderRev ?? 0).toBe(0);
  });

  it("accepts our own header back without warning and records its revision", async () => {
    const store = await makeVault();
    const server = fakeServer({ rev: 5, headerRev: 2, header: store.getHeader() });
    const client = await signedInClient(server);
    const { state, outcome } = await client.sync(store, freshState({ lastSyncRev: 5, highestSeenRev: 5 }), {});
    expect(outcome.warnings).toHaveLength(0);
    expect(state.lastHeaderRev).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. HIGH — pushHeader rotates header + auth verifier (review §2)
// ---------------------------------------------------------------------------

describe("pushHeader", () => {
  it("posts the header with a compare-and-set against lastHeaderRev", async () => {
    const store = await makeVault();
    const server = fakeServer({ headerRev: 3 });
    const client = await signedInClient(server);

    const { state, headerRev } = await client.pushHeader(
      store,
      freshState({ lastHeaderRev: 3 }),
      { newAuthTokenB64: "new-auth-token" },
    );

    expect(server.headerPushes).toHaveLength(1);
    expect(server.headerPushes[0]!.baseHeaderRev).toBe(3);
    expect(server.headerPushes[0]!.newAuthTokenB64).toBe("new-auth-token");
    expect(server.headerPushes[0]!.newKdf).toEqual(store.getHeader().kdf);
    expect(headerRev).toBe(4);
    expect(state.lastHeaderRev).toBe(4);
  });

  it("omits the auth token when only the header changed", async () => {
    const store = await makeVault();
    const server = fakeServer();
    const client = await signedInClient(server);
    await client.pushHeader(store, freshState());
    expect(server.headerPushes[0]).not.toHaveProperty("newAuthTokenB64");
    expect(server.headerPushes[0]!.baseHeaderRev).toBe(0);
  });

  it("throws SyncHeaderConflictError on 409 and says the server was not updated", async () => {
    const store = await makeVault();
    const server = fakeServer();
    server.headerStatus = 409;
    server.headerServerRev = 7;
    const client = await signedInClient(server);

    const err = await client.pushHeader(store, freshState(), { newAuthTokenB64: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncHeaderConflictError);
    expect(err.serverHeaderRev).toBe(7);
    expect(err.message).toMatch(/NOT updated/);
  });

  it("surfaces a network failure rather than reporting success", async () => {
    const store = await makeVault();
    const server = fakeServer();
    server.headerStatus = 500;
    const client = await signedInClient(server);
    await expect(client.pushHeader(store, freshState(), { newAuthTokenB64: "t" })).rejects.toThrow();
  });

  it("keeps the in-memory session usable after the credential rotates", async () => {
    const store = await makeVault();
    const server = fakeServer();
    const client = await signedInClient(server);
    await client.pushHeader(store, freshState(), { newAuthTokenB64: "rotated-token" });
    expect(client.isSignedIn()).toBe(true);
    // A later sync must still work with the rotated credential.
    server.script.rev = 1;
    await expect(client.sync(store, freshState(), {})).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 5. HIGH — incomplete-but-high-revision detection (review §5)
// ---------------------------------------------------------------------------

describe("incomplete snapshot detection", () => {
  it("keeps and warns about a synced item missing from a full snapshot with no tombstone", async () => {
    const store = await makeVault();
    const a = await addLogin(store, "Keep A");
    const b = await addLogin(store, "Keep B");
    const base = nextSyncBase(store.listItems({ includeArchived: true }));

    // Server claims a high rev but returns only one of the two items, and no tombstone.
    const cts = store.getItemCiphertexts();
    const server = fakeServer({
      rev: 99,
      items: [{ id: a.id, ct: cts.find((c) => c.id === a.id)!.ct, rev: 99 }],
    });
    const client = await signedInClient(server);

    const { outcome } = await client.sync(store, freshState(), base);

    expect(outcome.warnings.some((w) => w.includes("missing 1 entry"))).toBe(true);
    // Never converge to the server's narrower view.
    expect(store.getItem(b.id)?.title).toBe("Keep B");
    // …and re-upload it.
    expect(server.pushes[0]!.items.map((i) => i.id)).toContain(b.id);
  });

  it("does not warn when the absence is explained by an authentic tombstone", async () => {
    const store = await makeVault();
    const a = await addLogin(store, "A");
    const gone = await addLogin(store, "Gone");
    const base = nextSyncBase(store.listItems({ includeArchived: true }));
    await store.deleteItem(gone.id);
    const sealed = store.getSealedDeletions()[0]!;

    const cts = store.getItemCiphertexts();
    const server = fakeServer({
      rev: 40,
      items: [{ id: a.id, ct: cts.find((c) => c.id === a.id)!.ct, rev: 40 }],
      deletions: [sealed],
    });
    const client = await signedInClient(server);
    const { outcome } = await client.sync(store, freshState(), base);
    expect(outcome.warnings).toHaveLength(0);
  });

  it("does not warn on an incremental pull, where absence proves nothing", async () => {
    const store = await makeVault();
    await addLogin(store, "A");
    await addLogin(store, "B");
    const base = nextSyncBase(store.listItems({ includeArchived: true }));

    const server = fakeServer({ rev: 12, items: [] });
    const client = await signedInClient(server);
    const { outcome } = await client.sync(
      store,
      freshState({ lastSyncRev: 11, highestSeenRev: 11 }),
      base,
    );
    expect(outcome.warnings).toHaveLength(0);
  });

  it("still rejects an outright rev rollback", async () => {
    const store = await makeVault();
    const server = fakeServer({ rev: 3 });
    const client = await signedInClient(server);
    await expect(
      client.sync(store, freshState({ lastSyncRev: 9, highestSeenRev: 9 }), {}),
    ).rejects.toBeInstanceOf(RollbackDetectedError);
  });
});

// ---------------------------------------------------------------------------
// 6. Regression cover for the surface the e2e test depends on
// ---------------------------------------------------------------------------

describe("sync surface", () => {
  it("register / login / isSignedIn / fetchKdf still work", async () => {
    const store = await makeVault();
    const server = fakeServer();
    const client = new SyncClient({
      fetch: server.fetch,
      serverUrl: "http://sync.test/",
      deviceId: "dev-local",
      deviceLabel: "Mac",
      now,
    });
    expect(client.isSignedIn()).toBe(false);
    const accountId = await client.register("home", "tok", store);
    expect(accountId).toBe("acct-1");
    expect(client.isSignedIn()).toBe(true);
  });

  it("returns { state, base, outcome } and advances the base only after a push", async () => {
    const store = await makeVault();
    const item = await addLogin(store, "Item");
    const server = fakeServer({ rev: 1 });
    const client = await signedInClient(server);

    const r = await client.sync(store, freshState({ lastSyncRev: 1, highestSeenRev: 1 }), {});
    expect(r.state.lastSyncRev).toBe(2);
    expect(r.base[item.id]).toBe(store.getItem(item.id)!.updatedAt);
    expect(r.outcome.pushed).toBe(1);
  });

  it("retries the cycle after a 409 and eventually succeeds", async () => {
    const store = await makeVault();
    await addLogin(store, "Item");
    const server = fakeServer({ rev: 5 });
    server.pushStatus = 409;
    server.pushServerRev = 5;

    let attempts = 0;
    const wrapped = new SyncClient({
      fetch: (async (i: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(i), "http://sync.test");
        if (url.pathname === "/vault/changes" && init?.method === "POST") {
          attempts += 1;
          if (attempts >= 2) server.pushStatus = 200;
        }
        return server.fetch(i as never, init as never);
      }) as unknown as typeof fetch,
      serverUrl: "http://sync.test",
      deviceId: "dev-local",
      deviceLabel: "iPhone",
      now,
    });
    await wrapped.login("acct-1", "tok");
    const r = await wrapped.sync(store, freshState({ lastSyncRev: 5, highestSeenRev: 5 }), {});
    expect(attempts).toBe(2);
    expect(r.outcome.pushed).toBe(1);
  });

  it("settings are not part of the wire protocol (review §10)", async () => {
    const store = await makeVault();
    await addLogin(store, "Item");
    const server = fakeServer({ rev: 1 });
    const client = await signedInClient(server);
    await client.sync(store, freshState({ lastSyncRev: 1, highestSeenRev: 1 }), {});
    expect(server.pushes[0]).not.toHaveProperty("settings");
    // Settings stay device-local and keep their defaults.
    expect(store.getSettings().autoLockMinutes).toBe(DEFAULT_SETTINGS.autoLockMinutes);
  });
});
