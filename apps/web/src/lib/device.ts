// Per-device identity passed into VaultStore so tombstones and conflict copies can say
// which device they came from. Stable per browser profile; not a secret, never synced.
import { loadConfig } from "./config";

export function storeOptions(): { deviceId: string } {
  const cfg = loadConfig();
  return { deviceId: cfg.deviceId };
}

export function deviceLabel(): string {
  return loadConfig().deviceLabel;
}
