// Clipboard with auto-clear (spec: "Clipboard should auto-clear after a configurable
// timeout"). We only clear if the clipboard still holds the value we put there, so we
// never stomp on something the user copied later. No secrets are logged anywhere.
import * as Clipboard from "expo-clipboard";

let pendingClear: ReturnType<typeof setTimeout> | null = null;

export async function copyWithAutoClear(value: string, clearAfterSeconds: number): Promise<void> {
  await Clipboard.setStringAsync(value);
  if (pendingClear) clearTimeout(pendingClear);
  if (clearAfterSeconds > 0) {
    pendingClear = setTimeout(() => {
      void (async () => {
        try {
          const current = await Clipboard.getStringAsync();
          if (current === value) await Clipboard.setStringAsync("");
        } catch {
          // best effort
        }
      })();
    }, clearAfterSeconds * 1000);
  }
}
