// Sync client: pull → merge → push, driven by the shell. Offline-first — every failure
// leaves the local vault fully usable, and the next call retries from the last good rev.
// All crypto stays in @pw/core; all conflict logic stays in merge.ts. This file is plumbing.
import type { Ciphertext, SealedTombstone, Tombstone, VaultItem, VaultStore } from "@pw/core";
import { type SyncSession, isExpired } from "./auth";
import { type SyncBase, mergeVaults, nextSyncBase } from "./merge";
import {
  type ChangesResponse,
  type KdfInfoResponse,
  type LoginRequest,
  type RegisterRequest,
  type PushRequest,
  type PushResponse,
  type Rev,
  type SessionResponse,
  type HeaderPushRequest,
  type IntegrityFailure,
  RollbackDetectedError,
  SyncAuthError,
  SyncConflictError,
  SyncHeaderConflictError,
  SyncIntegrityError,
} from "./protocol";

export interface SyncState {
  lastSyncRev: Rev;
  /** Highest rev ever observed; a lower offer means the server is rolling us back (§8). */
  highestSeenRev: Rev;
  /**
   * Highest vault-header revision this device has accepted. A SEPARATE counter from
   * `lastSyncRev` (review §3): the server bumps `headerRev` only on header pushes and `rev`
   * only on item pushes, so comparing a header revision against an item revision hides
   * password rotations from any device that has pushed items since. Optional so an older
   * persisted state object still loads; absent means 0, i.e. "send me any header you have".
   */
  lastHeaderRev?: Rev;
}

export interface SyncOutcome {
  rev: Rev;
  pulled: number;
  pushed: number;
  conflicts: { id: string; conflictCopyId: string; title: string }[];
  /** Non-fatal things the UI must surface (rollback warnings, header changes). */
  warnings: string[];
}

export interface SyncClientDeps {
  fetch: typeof fetch;
  serverUrl: string;
  deviceId: string;
  deviceLabel: string;
  now?: () => string;
}

export class SyncClient {
  private session: SyncSession | null = null;
  private readonly now: () => string;

  constructor(private deps: SyncClientDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private url(path: string): string {
    return `${this.deps.serverUrl.replace(/\/+$/, "")}${path}`;
  }

  private async json<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (auth) {
      if (!this.session) throw new SyncAuthError("Not signed in to the sync server.");
      headers.Authorization = `Bearer ${this.session.accessToken}`;
    }
    const res = await this.deps.fetch(this.url(path), { ...init, headers });
    if (res.status === 401) throw new SyncAuthError();
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRev?: Rev };
      throw new SyncConflictError(body.serverRev ?? 0);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Sync request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  /**
   * Sign in with an ALREADY-DERIVED auth token (see deriveAuthToken). The client never
   * receives the master password, so there is nothing here to leak into a closure, a React
   * state tree, or a stack trace. The session lives in memory only, for as long as the vault
   * stays unlocked — see auth.ts.
   */
  async login(accountId: string, authTokenB64: string): Promise<void> {
    const body: LoginRequest = {
      accountId,
      authTokenB64,
      deviceId: this.deps.deviceId,
      deviceLabel: this.deps.deviceLabel,
    };
    const s = await this.json<SessionResponse>(
      "/login",
      { method: "POST", body: JSON.stringify(body) },
      false,
    );
    this.session = {
      accountId: s.accountId,
      accessToken: s.accessToken,
      expiresAt: Date.now() + s.expiresIn * 1000,
      authTokenB64,
    };
  }

  /**
   * Create a new account on this server and sign in. The vault header goes up as-is — it
   * carries KDF params and wrapped key envelopes, all of which are safe in plaintext by
   * design; the wrapping keys never leave the device.
   */
  async register(
    label: string,
    authTokenB64: string,
    store: VaultStore,
  ): Promise<string> {
    const body: RegisterRequest = {
      label,
      kdf: store.getHeader().kdf,
      authTokenB64,
      header: store.getHeader(),
      deviceId: this.deps.deviceId,
      deviceLabel: this.deps.deviceLabel,
    };
    const s = await this.json<SessionResponse>(
      "/register",
      { method: "POST", body: JSON.stringify(body) },
      false,
    );
    this.session = {
      accountId: s.accountId,
      accessToken: s.accessToken,
      expiresAt: Date.now() + s.expiresIn * 1000,
      authTokenB64,
    };
    return s.accountId;
  }

  /** Fetch the KDF params an existing account was created with (unauthenticated). */
  async fetchKdf(accountId: string): Promise<KdfInfoResponse["kdf"]> {
    const r = await this.json<KdfInfoResponse>(
      `/kdf?accountId=${encodeURIComponent(accountId)}`,
      {},
      false,
    );
    return r.kdf;
  }

  isSignedIn(): boolean {
    return !!this.session && !isExpired(this.session, Date.now());
  }

  private async ensureSession(): Promise<void> {
    if (!this.session) throw new SyncAuthError("Not signed in to the sync server.");
    if (!isExpired(this.session, Date.now())) return;
    // Renew with the in-memory auth token — no password prompt, no persisted refresh token.
    const s = await this.json<SessionResponse>(
      "/login",
      {
        method: "POST",
        body: JSON.stringify({
          accountId: this.session.accountId,
          authTokenB64: this.session.authTokenB64,
          deviceId: this.deps.deviceId,
          deviceLabel: this.deps.deviceLabel,
        } satisfies LoginRequest),
      },
      false,
    );
    this.session = { ...this.session, accessToken: s.accessToken, expiresAt: Date.now() + s.expiresIn * 1000 };
  }

  /**
   * One full sync cycle. Returns the new state for the caller to persist.
   *
   * On SyncConflictError (the server moved while we were pushing) the cycle retries from a
   * fresh pull, up to `maxAttempts`. Each retry re-merges, so no edit is lost to a race.
   */
  async sync(
    store: VaultStore,
    state: SyncState,
    base: SyncBase,
    maxAttempts = 3,
  ): Promise<{ state: SyncState; base: SyncBase; outcome: SyncOutcome }> {
    await this.ensureSession();
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.cycle(store, state, base);
      } catch (e) {
        if (!(e instanceof SyncConflictError)) throw e;
        lastErr = e;
        // Re-pull from what the server says it has, then merge and push again.
        state = { ...state, lastSyncRev: Math.min(state.lastSyncRev, e.serverRev) };
      }
    }
    throw lastErr;
  }

  /**
   * Push a rotated vault header (master-password change or post-recovery password set), and
   * with it the new server auth token, in ONE compare-and-set transaction (review §2).
   *
   * Before this existed nothing in the client ever called `POST /vault/header`: the UI
   * rewrapped the header locally and the server kept the OLD header and the OLD auth-token
   * hash, so the old master password stayed valid against the server forever and no other
   * device ever learned about the change. That silent failure is why this throws loudly
   * instead of returning a status: the caller must NOT commit the local password change as
   * "done" unless this resolves.
   *
   * Pass `newAuthTokenB64` (from `deriveAuthToken(newPassword, newKdf)`) whenever the master
   * password itself changed, so the server rotates the header and the verifier atomically.
   * Omit it only for a header change that does not affect the password (e.g. rotating the
   * recovery envelope alone).
   *
   * Returns the new state, with `lastHeaderRev` advanced to what the server assigned. On
   * SyncHeaderConflictError the server was NOT modified; sync first, then retry.
   */
  async pushHeader(
    store: VaultStore,
    state: SyncState,
    newAuthTokenB64?: string,
  ): Promise<{ state: SyncState; headerRev: Rev }> {
    await this.ensureSession();
    const header = store.getHeader();
    const body: HeaderPushRequest = {
      baseHeaderRev: state.lastHeaderRev ?? 0,
      header,
      ...(newAuthTokenB64 !== undefined
        ? { newAuthTokenB64, newKdf: header.kdf }
        : {}),
    };
    let res: PushResponse;
    try {
      res = await this.json<PushResponse>("/vault/header", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A 409 here is not a mergeable race — two devices changing the master password has no
      // sane resolution — so translate it into its own loud error rather than the generic
      // item-push conflict, which the caller would retry.
      if (e instanceof SyncConflictError) throw new SyncHeaderConflictError(e.serverRev);
      throw e;
    }
    // Keep the in-memory session usable: the credential the server now expects is the new
    // one, so a later token renewal must present it.
    if (newAuthTokenB64 !== undefined && this.session) {
      this.session = { ...this.session, authTokenB64: newAuthTokenB64 };
    }
    return { state: { ...state, lastHeaderRev: res.rev }, headerRev: res.rev };
  }

  private async cycle(
    store: VaultStore,
    state: SyncState,
    base: SyncBase,
  ): Promise<{ state: SyncState; base: SyncBase; outcome: SyncOutcome }> {
    const warnings: string[] = [];
    const sinceHeader = state.lastHeaderRev ?? 0;

    const changes = await this.json<ChangesResponse>(
      `/vault/changes?since=${encodeURIComponent(String(state.lastSyncRev))}` +
        `&sinceHeader=${encodeURIComponent(String(sinceHeader))}`,
    );

    // Freeze/rollback detection (SYNC-DESIGN.md §8): a server that offers a rev lower than
    // one we have already seen is withholding changes. Refuse rather than silently regress.
    if (changes.rev < state.highestSeenRev) {
      throw new RollbackDetectedError(state.highestSeenRev, changes.rev);
    }

    // ---- authenticate EVERYTHING before anything is applied ------------------
    // Review §6: a single unverifiable object must abort the whole cycle. Warning and
    // skipping still committed the merge and advanced lastSyncRev, so a server could corrupt
    // one new item once and that credential would never be offered again from the advanced
    // revision — permanently missing on this device. Collect every failure (so the user sees
    // the full picture, not just the first) and throw before applyMerge, before the base is
    // saved, and before any revision moves.
    const failures: IntegrityFailure[] = [];

    const remote: VaultItem[] = [];
    for (const env of changes.items) {
      try {
        remote.push(store.decryptItem(env.id, env.ct));
      } catch (e) {
        failures.push({ kind: "item", id: env.id, reason: reasonOf(e) });
      }
    }

    // Review §1 (CRITICAL): a tombstone is a destroy-this-credential instruction. Open every
    // one under the Vault Key — a forged, altered, or transplanted tombstone cannot produce a
    // valid AEAD tag and throws here. Nothing is deleted for a tombstone we cannot
    // authenticate; the cycle aborts with the ids named.
    const remoteDeletions: Tombstone[] = [];
    for (const sealed of changes.deletions) {
      try {
        remoteDeletions.push(store.openSealedTombstone(sealed));
      } catch (e) {
        failures.push({ kind: "tombstone", id: sealed.id, reason: reasonOf(e) });
      }
    }

    if (failures.length > 0) throw new SyncIntegrityError(failures);

    // ---- completeness check (review §5) --------------------------------------
    // A malicious server can return an EQUAL OR HIGHER rev with items silently missing, which
    // the rev-monotonicity guard above cannot see. Now that tombstones are authenticated, one
    // case IS detectable: an item this device has already synced (it is in the SyncBase)
    // absent from a FULL server snapshot with no tombstone the server could not have forged.
    //
    // HONEST SCOPE — this is a detection mitigation, NOT a proof of completeness. There is no
    // authenticated manifest or revision hash chain, so:
    //   * it only applies to a full snapshot (since === 0); on an incremental pull, absence is
    //     indistinguishable from "unchanged since `since`" and proves nothing;
    //   * it cannot detect withholding of items this device has never seen (a fresh device
    //     with an empty base is still blind);
    //   * the SyncBase itself lives in ordinary device storage and is not a trust anchor.
    // What it does guarantee is that we never CONVERGE to the server's narrower view: the
    // local copy is kept and re-pushed, and the user is told.
    if (state.lastSyncRev === 0) {
      const serverKnows = new Set(changes.items.map((i) => i.id));
      const tombstoned = new Set(remoteDeletions.map((d) => d.id));
      const missing = Object.keys(base).filter(
        (id) => !serverKnows.has(id) && !tombstoned.has(id),
      );
      if (missing.length > 0) {
        warnings.push(
          `The server's snapshot is missing ${missing.length} entr${missing.length === 1 ? "y" : "ies"} ` +
            "this device has already synced, with no valid deletion record for them. " +
            "The local copies have been kept and re-uploaded. If you did not delete them " +
            "elsewhere, the server may be withholding data.",
        );
      }
    }

    // A header change means the master password or recovery key was rotated elsewhere. The
    // Vault Key is unchanged, so item ciphertexts stay valid — but this device's derived KEK
    // no longer matches, so it must re-authenticate with the new password.
    let lastHeaderRev = sinceHeader;
    if (changes.header) {
      if (JSON.stringify(changes.header) === JSON.stringify(store.getHeader())) {
        // Already holding it (this device pushed it, or it arrived with a restore) — record
        // the revision so we stop asking for it.
        lastHeaderRev = Math.max(lastHeaderRev, changes.headerRev);
      } else {
        // Deliberately do NOT advance lastHeaderRev here: the rotation has not been acted on
        // until the user unlocks with the new password, and dropping the marker would make
        // the warning disappear after one sync while the device stayed on the old credential.
        warnings.push(
          "The master password or recovery key was changed on another device. " +
            "Unlock with the new master password to continue syncing.",
        );
      }
    } else {
      lastHeaderRev = Math.max(lastHeaderRev, changes.headerRev);
    }

    const merged = mergeVaults({
      local: store.listItems({ includeArchived: true }),
      localDeletions: store.getDeletions(),
      remote,
      remoteDeletions,
      base,
      deviceLabel: this.deps.deviceLabel,
      now: this.now(),
    });

    await store.applyMerge(merged.items, merged.deletions, merged.changedIds);

    // Push everything the merge changed, plus anything the server has not seen.
    const serverHas = new Set(changes.items.map((i) => i.id));
    const toPush = new Set<string>(merged.changedIds);
    for (const item of store.listItems({ includeArchived: true })) {
      if (!serverHas.has(item.id)) toPush.add(item.id);
    }
    const cts: { id: string; ct: Ciphertext }[] = store
      .getItemCiphertexts()
      .filter((e) => toPush.has(e.id));

    let rev = changes.rev;
    let pushed = 0;
    // Sealed, not plaintext: the server must never be handed a deletion it could replay,
    // re-target, or read a deletion history out of.
    const deletions: SealedTombstone[] = store.getSealedDeletions();
    if (cts.length > 0 || deletions.length > 0) {
      const body: PushRequest = { baseRev: changes.rev, items: cts, deletions };
      const res = await this.json<PushResponse>("/vault/changes", {
        method: "POST",
        body: JSON.stringify(body),
      });
      rev = res.rev;
      pushed = cts.length;
    }

    return {
      state: {
        lastSyncRev: rev,
        highestSeenRev: Math.max(state.highestSeenRev, rev),
        lastHeaderRev,
      },
      // The base advances only once the push has succeeded — otherwise this device would
      // claim agreement with a server that never received its changes, and the next merge
      // would treat its own unpushed edits as "unchanged since last sync" and lose them.
      base: nextSyncBase(store.listItems({ includeArchived: true })),
      outcome: { rev, pulled: remote.length, pushed, conflicts: merged.conflicts, warnings },
    };
  }
}

/** Error text for an integrity failure, without leaking anything decrypted (there is none). */
function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
