// Per-device sync base, mirroring loadSyncBase/saveSyncBase in apps/web/src/lib/storage.ts.
// Kept OUT of the vault file because it must not sync: each device has its own view of
// "what the server and I last agreed on".
//
// Contains NO secrets — only opaque item ids and edit timestamps, both of which the sync
// server necessarily sees anyway. Plain JSON file in the app-private document directory,
// same non-sensitive tier as sync-config.json and prefs.json.
import { File, Paths } from "expo-file-system";
import type { SyncBase } from "@pw/sync";

const FILENAME = "sync-base.json";

function file(): File {
  return new File(Paths.document, FILENAME);
}

export function loadSyncBase(): SyncBase {
  try {
    const f = file();
    if (!f.exists) return {};
    const v = JSON.parse(f.textSync());
    return v && typeof v === "object" ? (v as SyncBase) : {};
  } catch {
    return {};
  }
}

export function saveSyncBase(base: SyncBase): void {
  file().write(JSON.stringify(base));
}
