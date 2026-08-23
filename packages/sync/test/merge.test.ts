import { describe, expect, it } from "vitest";
import type { Tombstone, VaultItem } from "@pw/core";
import { TOMBSTONE_RETENTION_DAYS } from "@pw/core";
import { CONFLICT_TAG, conflictCopyTitle, mergeVaults, nextSyncBase } from "../src/merge";

const NOW = "2026-08-23T10:00:00.000Z";

function daysAgo(days: number, from = NOW): string {
  return new Date(Date.parse(from) - days * 86_400_000).toISOString();
}

function item(id: string, over: Partial<VaultItem> = {}): VaultItem {
  return {
    id,
    type: "login",
    title: id,
    folder: null,
    tags: [],
    favorite: false,
    archived: false,
    fields: { username: `${id}@example.com`, password: `pw-${id}` },
    customFields: [],
    notes: "",
    reminders: [],
    passwordHistory: [],
    versions: [],
    createdAt: daysAgo(100),
    updatedAt: daysAgo(100),
    lastUsedAt: null,
    ...over,
  };
}

function tomb(id: string, deletedAt: string, deviceId = "dev-remote"): Tombstone {
  return { id, deletedAt, deviceId };
}

/** Deterministic id source so conflict-copy ids are pinnable. */
function ids(prefix = "copy"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function merge(over: Partial<Parameters<typeof mergeVaults>[0]> = {}) {
  return mergeVaults({
    local: [],
    localDeletions: [],
    remote: [],
    remoteDeletions: [],
    deviceLabel: "iPhone",
    now: NOW,
    newId: ids(),
    ...over,
  });
}

const find = (r: { items: VaultItem[] }, id: string) => r.items.find((i) => i.id === id);

describe("mergeVaults — no-op cases", () => {
  it("merges two empty vaults", () => {
    const r = merge();
    expect(r.items).toEqual([]);
    expect(r.deletions).toEqual([]);
    expect(r.changedIds).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("takes either copy when both sides are byte-identical, with no spurious duplicate", () => {
    const a = item("a", { updatedAt: daysAgo(1) });
    const r = merge({ local: [a], remote: [structuredClone(a)] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toEqual(a);
    expect(r.conflicts).toEqual([]);
    expect(r.changedIds).toEqual([]);
  });

  it("treats identical edits made independently on both devices as no conflict", () => {
    // Same field values, same updatedAt — e.g. both devices applied the same password change.
    const edited = item("a", { fields: { username: "u", password: "new" }, updatedAt: daysAgo(1) });
    const r = merge({ local: [edited], remote: [structuredClone(edited)] });
    expect(r.conflicts).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.fields.password).toBe("new");
  });

  it("ignores key order when comparing items", () => {
    const a = item("a");
    const b = { ...structuredClone(a), fields: { password: a.fields.password!, username: a.fields.username! } };
    const r = merge({ local: [a], remote: [b] });
    expect(r.conflicts).toEqual([]);
    expect(r.items).toHaveLength(1);
  });
});

describe("mergeVaults — additions", () => {
  it("includes a genuine remote addition and marks it changed", () => {
    const r = merge({ remote: [item("new")] });
    expect(r.items.map((i) => i.id)).toEqual(["new"]);
    expect(r.changedIds).toEqual(["new"]);
    expect(r.conflicts).toEqual([]);
  });

  it("keeps a local-only item, and pushes it when the base shows the server never saw it", () => {
    const a = item("a");
    const withBase = merge({ local: [a], base: {} });
    expect(withBase.items.map((i) => i.id)).toEqual(["a"]);
    expect(withBase.changedIds).toEqual(["a"]);

    const knownToServer = merge({ local: [a], base: nextSyncBase([a]) });
    expect(knownToServer.changedIds).toEqual([]);
  });

  it("keeps a local-only item without a base, without claiming it changed", () => {
    const r = merge({ local: [item("a")] });
    expect(r.items.map((i) => i.id)).toEqual(["a"]);
    expect(r.changedIds).toEqual([]);
  });

  it("keeps both sides' additions", () => {
    const r = merge({ local: [item("l")], remote: [item("r")], base: {} });
    expect(r.items.map((i) => i.id).sort()).toEqual(["l", "r"]);
    expect(r.conflicts).toEqual([]);
  });

  it("handles an empty remote and an empty local vault", () => {
    expect(merge({ local: [item("a")], remote: [] }).items).toHaveLength(1);
    expect(merge({ local: [], remote: [item("a")] }).items).toHaveLength(1);
  });

  it("edits to DIFFERENT items on both sides both survive, with no conflict", () => {
    const localEdit = item("a", { fields: { username: "u", password: "local-new" }, updatedAt: daysAgo(1) });
    const remoteEdit = item("b", { fields: { username: "u", password: "remote-new" }, updatedAt: daysAgo(1) });
    const r = merge({
      local: [localEdit, item("b")],
      remote: [item("a"), remoteEdit],
      base: nextSyncBase([item("a"), item("b")]),
    });
    expect(r.conflicts).toEqual([]);
    expect(find(r, "a")!.fields.password).toBe("local-new");
    expect(find(r, "b")!.fields.password).toBe("remote-new");
  });
});

describe("mergeVaults — concurrent edits to the same item", () => {
  const localEdit = item("a", {
    title: "Bank",
    fields: { username: "u", password: "LOCAL-secret" },
    notes: "typed on the laptop",
    updatedAt: "2026-08-20T09:00:00.000Z",
  });
  const remoteEdit = item("a", {
    title: "Bank",
    fields: { username: "u", password: "REMOTE-secret" },
    notes: "typed on the phone",
    updatedAt: "2026-08-21T09:00:00.000Z",
  });

  it("newer remote wins and the losing LOCAL edit survives verbatim as a conflicted copy", () => {
    const r = merge({ local: [localEdit], remote: [remoteEdit] });

    expect(r.conflicts).toEqual([{ id: "a", conflictCopyId: "copy-1", title: "Bank" }]);
    expect(find(r, "a")!.fields.password).toBe("REMOTE-secret");

    const copy = find(r, "copy-1")!;
    // The whole point: the loser's password is still retrievable.
    expect(copy.fields.password).toBe("LOCAL-secret");
    expect(copy.notes).toBe("typed on the laptop");
    expect(copy.title).toBe(conflictCopyTitle("Bank", "iPhone", NOW));
    expect(copy.title).toContain("(conflicted copy — iPhone, 23-Aug-2026)");
    expect(copy.tags).toContain(CONFLICT_TAG);
    expect(copy.id).not.toBe("a");
    expect(r.changedIds).toEqual(["a", "copy-1"]);
  });

  it("newer local wins and the losing REMOTE edit survives verbatim", () => {
    const r = merge({ local: [remoteEdit], remote: [localEdit] });
    expect(find(r, "a")!.fields.password).toBe("REMOTE-secret");
    expect(find(r, "copy-1")!.fields.password).toBe("LOCAL-secret");
  });

  it("a local edit against an UNCHANGED remote copy is not a conflict when a base is given", () => {
    const base = item("a", { fields: { password: "old" }, updatedAt: daysAgo(9) });
    const mine = item("a", { fields: { password: "mine" }, updatedAt: daysAgo(1) });
    const r = merge({ local: [mine], remote: [structuredClone(base)], base: nextSyncBase([base]) });
    expect(r.conflicts).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(find(r, "a")!.fields.password).toBe("mine");
    expect(r.changedIds).toEqual(["a"]);
  });

  it("a remote edit against an UNCHANGED local copy is not a conflict when a base is given", () => {
    const base = item("a", { fields: { password: "old" }, updatedAt: daysAgo(9) });
    const theirs = item("a", { fields: { password: "theirs" }, updatedAt: daysAgo(1) });
    const r = merge({ local: [structuredClone(base)], remote: [theirs], base: nextSyncBase([base]) });
    expect(r.conflicts).toEqual([]);
    expect(find(r, "a")!.fields.password).toBe("theirs");
    expect(r.changedIds).toEqual(["a"]);
  });

  it("without a base, an edit against a stale copy is conservatively treated as a conflict", () => {
    const stale = item("a", { fields: { password: "old" }, updatedAt: daysAgo(9) });
    const mine = item("a", { fields: { password: "mine" }, updatedAt: daysAgo(1) });
    const r = merge({ local: [mine], remote: [stale] });
    expect(r.conflicts).toHaveLength(1);
    expect(find(r, "copy-1")!.fields.password).toBe("old"); // duplicate, never data loss
  });

  it("resolves an exact updatedAt tie to the local copy and still preserves the remote", () => {
    const l = item("a", { fields: { password: "L" }, updatedAt: daysAgo(1) });
    const rem = item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) });
    const r = merge({ local: [l], remote: [rem] });
    expect(find(r, "a")!.fields.password).toBe("L");
    expect(find(r, "copy-1")!.fields.password).toBe("R");
  });

  it("does not double-tag an item that already carries the conflict tag", () => {
    const l = item("a", { tags: ["bank", CONFLICT_TAG], fields: { password: "L" }, updatedAt: daysAgo(2) });
    const rem = item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) });
    const r = merge({ local: [l], remote: [rem] });
    expect(find(r, "copy-1")!.tags).toEqual(["bank", CONFLICT_TAG]);
  });

  it("does not mutate the input items", () => {
    const l = structuredClone(localEdit);
    const rem = structuredClone(remoteEdit);
    merge({ local: [l], remote: [rem] });
    expect(l).toEqual(localEdit);
    expect(rem).toEqual(remoteEdit);
  });

  it("clock-skew inversion: remote is genuinely newer but stamped earlier — no data loss", () => {
    // The remote device's clock is 10 minutes slow, so the true-newer remote edit loses LWW.
    const skewedRemote = item("a", {
      fields: { username: "u", password: "REALLY-newest" },
      updatedAt: "2026-08-20T08:50:00.000Z",
    });
    const r = merge({ local: [localEdit], remote: [skewedRemote] });
    expect(find(r, "a")!.fields.password).toBe("LOCAL-secret"); // wrong winner, accepted
    // But the true-newest value is still in the vault, which is the whole tolerance argument.
    const survivingPasswords = r.items.map((i) => i.fields.password);
    expect(survivingPasswords).toContain("REALLY-newest");
    expect(survivingPasswords).toContain("LOCAL-secret");
    expect(r.conflicts).toHaveLength(1);
  });

  it("generates deterministic conflict-copy ids from the injected id function", () => {
    const a = merge({ local: [localEdit], remote: [remoteEdit] });
    const b = merge({ local: [localEdit], remote: [remoteEdit] });
    expect(a).toEqual(b);
  });
});

describe("mergeVaults — delete vs edit", () => {
  const editedAt = "2026-08-20T09:00:00.000Z";
  const edited = item("a", { fields: { password: "still-needed" }, updatedAt: editedAt });

  it("remote delete AFTER the local edit wins: the item goes, the tombstone stays", () => {
    const r = merge({
      local: [edited],
      remote: [],
      remoteDeletions: [tomb("a", "2026-08-21T09:00:00.000Z")],
    });
    expect(r.items).toEqual([]);
    expect(r.deletions.map((d) => d.id)).toEqual(["a"]);
    expect(r.changedIds).toEqual(["a"]);
  });

  it("remote delete BEFORE the local edit loses: the edit resurrects and the tombstone is dropped", () => {
    const r = merge({
      local: [edited],
      remote: [],
      remoteDeletions: [tomb("a", "2026-08-19T09:00:00.000Z")],
    });
    expect(find(r, "a")!.fields.password).toBe("still-needed");
    expect(r.deletions).toEqual([]);
    expect(r.changedIds).toEqual(["a"]);
  });

  it("local delete AFTER the remote edit wins", () => {
    const r = merge({
      local: [],
      localDeletions: [tomb("a", "2026-08-21T09:00:00.000Z", "dev-local")],
      remote: [edited],
    });
    expect(r.items).toEqual([]);
    expect(r.deletions.map((d) => d.id)).toEqual(["a"]);
    expect(r.changedIds).toEqual([]);
  });

  it("local delete BEFORE the remote edit loses: the remote edit resurrects the item", () => {
    const r = merge({
      local: [],
      localDeletions: [tomb("a", "2026-08-19T09:00:00.000Z", "dev-local")],
      remote: [edited],
    });
    expect(find(r, "a")!.fields.password).toBe("still-needed");
    expect(r.deletions).toEqual([]);
    expect(r.changedIds).toEqual(["a"]);
  });

  it("a delete newer than BOTH concurrent edits removes the item and makes no conflict copy", () => {
    const l = item("a", { fields: { password: "L" }, updatedAt: "2026-08-19T00:00:00.000Z" });
    const rem = item("a", { fields: { password: "R" }, updatedAt: "2026-08-20T00:00:00.000Z" });
    const r = merge({
      local: [l],
      remote: [rem],
      remoteDeletions: [tomb("a", "2026-08-21T00:00:00.000Z")],
    });
    expect(r.items).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.deletions.map((d) => d.id)).toEqual(["a"]);
  });

  it("a delete older than the LWW winner keeps the item and still preserves the loser", () => {
    const l = item("a", { fields: { password: "L" }, updatedAt: "2026-08-19T00:00:00.000Z" });
    const rem = item("a", { fields: { password: "R" }, updatedAt: "2026-08-22T00:00:00.000Z" });
    const r = merge({
      local: [l],
      remote: [rem],
      remoteDeletions: [tomb("a", "2026-08-21T00:00:00.000Z")],
    });
    expect(find(r, "a")!.fields.password).toBe("R");
    expect(find(r, "copy-1")!.fields.password).toBe("L");
    expect(r.deletions).toEqual([]);
  });

  it("keeps a tombstone for an item neither side still holds", () => {
    const r = merge({ localDeletions: [tomb("gone", daysAgo(3), "dev-local")] });
    expect(r.deletions).toEqual([tomb("gone", daysAgo(3), "dev-local")]);
    expect(r.items).toEqual([]);
  });
});

describe("mergeVaults — tombstone union and garbage collection", () => {
  it("keeps the EARLIER deletedAt when both sides tombstoned the same id", () => {
    const early = tomb("a", "2026-08-01T00:00:00.000Z", "dev-local");
    const late = tomb("a", "2026-08-05T00:00:00.000Z", "dev-remote");
    expect(merge({ localDeletions: [early], remoteDeletions: [late] }).deletions).toEqual([early]);
    expect(merge({ localDeletions: [late], remoteDeletions: [early] }).deletions).toEqual([early]);
  });

  it("unions tombstones from both sides", () => {
    const r = merge({
      localDeletions: [tomb("a", daysAgo(2), "dev-local")],
      remoteDeletions: [tomb("b", daysAgo(3))],
    });
    expect(r.deletions.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("garbage-collects tombstones older than the retention window", () => {
    const fresh = tomb("keep", daysAgo(TOMBSTONE_RETENTION_DAYS - 1));
    const stale = tomb("gc", daysAgo(TOMBSTONE_RETENTION_DAYS + 1));
    const r = merge({ remoteDeletions: [fresh, stale] });
    expect(r.deletions.map((d) => d.id)).toEqual(["keep"]);
  });

  it("an expired tombstone no longer suppresses a remote item (retention window exceeded)", () => {
    const resurrected = item("a", { updatedAt: daysAgo(TOMBSTONE_RETENTION_DAYS + 5) });
    const r = merge({
      remote: [resurrected],
      localDeletions: [tomb("a", daysAgo(TOMBSTONE_RETENTION_DAYS + 2), "dev-local")],
    });
    expect(r.items.map((i) => i.id)).toEqual(["a"]);
    expect(r.deletions).toEqual([]);
  });
});

describe("mergeVaults — offline device rejoining after 30 days", () => {
  it("reconciles many local changes against many remote changes without losing anything", () => {
    const offlineAt = daysAgo(30);
    const base = ["a", "b", "c", "d", "e"].map((id) => item(id, { updatedAt: offlineAt }));

    // Local (the device that was offline): edited a and b, added f, deleted c.
    const local = [
      item("a", { fields: { password: "local-a" }, updatedAt: daysAgo(25) }),
      item("b", { fields: { password: "local-b" }, updatedAt: daysAgo(2) }),
      item("d", { updatedAt: offlineAt }),
      item("e", { updatedAt: offlineAt }),
      item("f", { fields: { password: "local-f" }, updatedAt: daysAgo(10) }),
    ];
    const localDeletions = [tomb("c", daysAgo(20), "dev-local")];

    // Remote (the rest of the fleet): edited a and b too, deleted d, added g.
    const remote = [
      item("a", { fields: { password: "remote-a" }, updatedAt: daysAgo(3) }),
      item("b", { fields: { password: "remote-b" }, updatedAt: daysAgo(20) }),
      item("c", { updatedAt: offlineAt }),
      item("e", { updatedAt: offlineAt }),
      item("g", { fields: { password: "remote-g" }, updatedAt: daysAgo(5) }),
    ];
    const remoteDeletions = [tomb("d", daysAgo(4))];

    const r = merge({ local, localDeletions, remote, remoteDeletions, base: nextSyncBase(base) });

    // a: remote newer → remote wins, local edit preserved. b: local newer → mirror image.
    expect(find(r, "a")!.fields.password).toBe("remote-a");
    expect(find(r, "b")!.fields.password).toBe("local-b");
    const passwords = r.items.map((i) => i.fields.password);
    expect(passwords).toContain("local-a");
    expect(passwords).toContain("remote-b");
    expect(r.conflicts.map((c) => c.id).sort()).toEqual(["a", "b"]);

    // c deleted locally while the remote still had an untouched copy → stays deleted.
    expect(find(r, "c")).toBeUndefined();
    // d deleted remotely while the local copy was untouched → stays deleted.
    expect(find(r, "d")).toBeUndefined();
    expect(r.deletions.map((d) => d.id)).toEqual(["c", "d"]);

    // e untouched everywhere; f and g are additions from each side.
    expect(find(r, "e")).toBeDefined();
    expect(find(r, "f")!.fields.password).toBe("local-f");
    expect(find(r, "g")!.fields.password).toBe("remote-g");

    // 5 survivors + 2 conflict copies, nothing silently dropped.
    expect(r.items).toHaveLength(7);
    expect(r.changedIds).toEqual(["a", "b", "copy-1", "copy-2", "d", "f", "g"]);
  });
});

describe("mergeVaults — idempotency", () => {
  it("re-merging a merge result is a complete no-op (no conflict-copy junk build-up)", () => {
    const first = merge({
      local: [item("a", { fields: { password: "L" }, updatedAt: daysAgo(2) })],
      remote: [item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) })],
      remoteDeletions: [tomb("z", daysAgo(1))],
      base: {},
    });
    expect(first.conflicts).toHaveLength(1);

    const second = mergeVaults({
      local: first.items,
      localDeletions: first.deletions,
      remote: structuredClone(first.items),
      remoteDeletions: structuredClone(first.deletions),
      base: nextSyncBase(first.items),
      deviceLabel: "iPhone",
      now: NOW,
      newId: ids("second"),
    });

    expect(second.conflicts).toEqual([]);
    expect(second.changedIds).toEqual([]);
    expect(second.items).toEqual(first.items);
    expect(second.deletions).toEqual(first.deletions);

    const third = mergeVaults({
      local: second.items,
      localDeletions: second.deletions,
      remote: structuredClone(second.items),
      remoteDeletions: structuredClone(second.deletions),
      base: nextSyncBase(second.items),
      deviceLabel: "iPhone",
      now: NOW,
      newId: ids("third"),
    });
    expect(third.items).toEqual(second.items);
    expect(third.conflicts).toEqual([]);
  });

  it("is stable when only one side has pulled the merge result yet", () => {
    const first = merge({
      local: [item("a", { fields: { password: "L" }, updatedAt: daysAgo(2) })],
      remote: [item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) })],
    });
    // The other device still holds only its own copy of "a"; merging again must not clone.
    const second = mergeVaults({
      local: first.items,
      localDeletions: first.deletions,
      remote: [item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) })],
      remoteDeletions: [],
      deviceLabel: "iPhone",
      now: NOW,
      newId: ids("second"),
    });
    expect(second.conflicts).toEqual([]);
    expect(second.items).toHaveLength(2);
    expect(second.items.map((i) => i.fields.password).sort()).toEqual(["L", "R"]);
  });
});

describe("nextSyncBase", () => {
  it("maps id → updatedAt for exactly the items committed", () => {
    const a = item("a", { updatedAt: daysAgo(2) });
    const b = item("b", { updatedAt: daysAgo(5) });
    expect(nextSyncBase([a, b])).toEqual({ a: a.updatedAt, b: b.updatedAt });
    expect(nextSyncBase([])).toEqual({});
  });

  it("round-trips: the base from a merge result makes the next merge a no-op", () => {
    const first = merge({
      local: [item("a", { fields: { password: "L" }, updatedAt: daysAgo(2) })],
      remote: [item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) })],
      base: {},
    });
    const second = mergeVaults({
      local: first.items,
      localDeletions: first.deletions,
      remote: structuredClone(first.items),
      remoteDeletions: structuredClone(first.deletions),
      base: nextSyncBase(first.items),
      deviceLabel: "iPhone",
      now: NOW,
      newId: ids("second"),
    });
    expect(second.changedIds).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });

  it("an id absent from the base is treated as a genuine concurrent edit", () => {
    const r = merge({
      local: [item("a", { fields: { password: "L" }, updatedAt: daysAgo(2) })],
      remote: [item("a", { fields: { password: "R" }, updatedAt: daysAgo(1) })],
      base: { other: daysAgo(9) },
    });
    expect(r.conflicts).toHaveLength(1);
    expect(find(r, "copy-1")!.fields.password).toBe("L");
  });

  it("both sides matching the base but disagreeing on content still preserves both", () => {
    // Contradictory input (same updatedAt, different plaintext). Never resolve it by dropping.
    const at = daysAgo(4);
    const r = merge({
      local: [item("a", { fields: { password: "L" }, updatedAt: at })],
      remote: [item("a", { fields: { password: "R" }, updatedAt: at })],
      base: { a: at },
    });
    expect(r.items.map((i) => i.fields.password).sort()).toEqual(["L", "R"]);
    expect(r.conflicts).toHaveLength(1);
  });
});

describe("mergeVaults — input validation", () => {
  it("throws on an unparseable timestamp rather than silently treating it as the epoch", () => {
    expect(() => merge({ local: [item("a", { updatedAt: "not-a-date" })], remote: [item("a")] })).toThrow(
      /unparseable timestamp/,
    );
  });
});
