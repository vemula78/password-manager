// Google Drive connection for the web shell: loads Google Identity Services, obtains an
// OAuth access token (kept in memory only — never persisted), and builds a DriveClient
// from @pw/core. Only encrypted backup packages ever pass through Drive.
import { DriveClient } from "@pw/core";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GSI_SRC = "https://accounts.google.com/gsi/client";

interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }): TokenClient;
        };
      };
    };
  }
}

let gsiLoaded: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gsiLoaded) {
    gsiLoaded = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = GSI_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gsiLoaded = null;
        reject(new Error("Could not load Google sign-in (are you offline?)."));
      };
      document.head.appendChild(s);
    });
  }
  return gsiLoaded;
}

let accessToken: string | null = null;
let tokenExpiresAt = 0;

export function driveConnected(): boolean {
  return !!accessToken && Date.now() < tokenExpiresAt - 60_000;
}

export function disconnectDrive(): void {
  accessToken = null;
  tokenExpiresAt = 0;
}

/** Interactive connect: pops the Google consent flow. Requires a configured client id. */
export async function connectDrive(clientId: string): Promise<void> {
  if (!navigator.onLine) throw new Error("You are offline — Google Drive is unavailable.");
  if (!clientId) throw new Error("Set your Google OAuth Client ID first.");
  await loadGsi();
  await new Promise<void>((resolve, reject) => {
    const tc = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error ?? "Google did not return an access token."));
          return;
        }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in ?? 3600) * 1000;
        resolve();
      },
      error_callback: (err) =>
        reject(new Error(err?.message ?? "Google sign-in was closed or failed.")),
    });
    tc.requestAccessToken();
  });
}

export function getDriveClient(): DriveClient {
  return new DriveClient({
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    getAccessToken: async () => {
      if (!driveConnected()) throw new Error("Google Drive is not connected.");
      return accessToken!;
    },
  });
}
