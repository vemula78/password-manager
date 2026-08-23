// Sync client: pull → merge → push, driven by the shell. Offline-first — every failure
// leaves the local vault fully usable, and the next call retries from the last good rev.
// All crypto stays in @pw/core; all conflict logic stays in merge.ts. This file is plumbing.
import type { Ciphertext, Tombstone, VaultItem, VaultStore } from "@pw/core";
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
  RollbackDetectedError,
  SyncAuthError,
  SyncConflictError,
} from "./protocol";

export interface SyncState {
  lastSyncRev: Rev;
  /** Highest rev ever observed; a lower offer means the server is rolling us back (§8). */
  highestSeenRev: Rev;
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

  private async cycle(
    store: VaultStore,
    state: SyncState,
    base: SyncBase,
  ): Promise<{ state: SyncState; base: SyncBase; outcome: SyncOutcome }> {
    const warnings: string[] = [];

    const changes = await this.json<ChangesResponse>(
      `/vault/changes?since=${encodeURIComponent(String(state.lastSyncRev))}`,
    );

    // Freeze/rollback detection (SYNC-DESIGN.md §8): a server that offers a rev lower than
    // one we have already seen is withholding changes. Refuse rather than silently regress.
    if (changes.rev < state.highestSeenRev) {
      throw new RollbackDetectedError(state.highestSeenRev, changes.rev);
    }

    // A header change means the master password or recovery key was rotated elsewhere. The
    // Vault Key is unchanged, so item ciphertexts stay valid — but this device's derived KEK
    // no longer matches, so it must re-authenticate with the new password.
    if (changes.header) {
      const local = JSON.stringify(store.getHeader());
      if (JSON.stringify(changes.header) !== local) {
        warnings.push(
          "The master password or recovery key was changed on another device. " +
            "Unlock with the new master password to continue syncing.",
        );
      }
    }

    const remote: VaultItem[] = [];
    for (const env of changes.items) {
      try {
        remote.push(store.decryptItem(env.id, env.ct));
      } catch {
        // Authentication failure on a single item: the server sent something we cannot
        // verify. Never drop it silently — surface it and keep the local copy authoritative.
        warnings.push(
          `A synced entry failed its integrity check and was ignored (id ${env.id.slice(0, 6)}…). ` +
            "This can mean the server returned corrupted or tampered data.",
        );
      }
    }

    const merged = mergeVaults({
      local: store.listItems({ includeArchived: true }),
      localDeletions: store.getDeletions(),
      remote,
      remoteDeletions: changes.deletions,
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
    const deletions: Tombstone[] = store.getDeletions();
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
      state: { lastSyncRev: rev, highestSeenRev: Math.max(state.highestSeenRev, rev) },
      // The base advances only once the push has succeeded — otherwise this device would
      // claim agreement with a server that never received its changes, and the next merge
      // would treat its own unpushed edits as "unchanged since last sync" and lose them.
      base: nextSyncBase(store.listItems({ includeArchived: true })),
      outcome: { rev, pulled: remote.length, pushed, conflicts: merged.conflicts, warnings },
    };
  }
}
