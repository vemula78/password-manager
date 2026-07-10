// Google Drive backup client (Drive REST v3). Zero-knowledge: only already-encrypted
// backup packages (see backup.ts) ever pass through here. fetch and the OAuth access
// token are injected — the web shell uses Google Identity Services with a client ID from
// config; tests inject a mock. File names and metadata carry no user data.

export interface DriveDeps {
  fetch: typeof fetch;
  /** Returns a valid OAuth2 access token with scope drive.file. */
  getAccessToken(): Promise<string>;
}

export interface DriveFile {
  id: string;
  name: string;
  createdTime: string;
  size?: string;
}

export const BACKUP_FOLDER_NAME = "PasswordManagerBackups";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export class DriveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DriveError";
  }
}

export class DriveClient {
  constructor(private deps: DriveDeps) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.deps.getAccessToken();
    const res = await this.deps.fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      throw new DriveError(`Google Drive request failed (${res.status})`, res.status);
    }
    return res;
  }

  /** Find or create the dedicated backup folder; returns its id. */
  async ensureFolder(): Promise<string> {
    const q = encodeURIComponent(
      `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );
    const found = (await (await this.call(`${API}/files?q=${q}&fields=files(id,name)`)).json()) as {
      files: { id: string }[];
    };
    if (found.files.length > 0) return found.files[0]!.id;
    const created = (await (
      await this.call(`${API}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: BACKUP_FOLDER_NAME,
          mimeType: "application/vnd.google-apps.folder",
        }),
      })
    ).json()) as { id: string };
    return created.id;
  }

  /** Upload one encrypted backup package. */
  async uploadBackup(folderId: string, fileName: string, encryptedContent: string): Promise<DriveFile> {
    const boundary = "pwm-backup-boundary";
    const metadata = { name: fileName, parents: [folderId], mimeType: "application/octet-stream" };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n` +
      encryptedContent +
      `\r\n--${boundary}--`;
    const res = await this.call(
      `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,createdTime,size`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return (await res.json()) as DriveFile;
  }

  /** List backups in the folder, newest first. */
  async listBackups(folderId: string): Promise<DriveFile[]> {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const res = await this.call(
      `${API}/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=100`,
    );
    return ((await res.json()) as { files: DriveFile[] }).files;
  }

  async downloadBackup(fileId: string): Promise<string> {
    const res = await this.call(`${API}/files/${fileId}?alt=media`);
    return res.text();
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.call(`${API}/files/${fileId}`, { method: "DELETE" });
  }

  /** Enforce retention: keep the newest `retain` backups, delete the rest. */
  async prune(folderId: string, retain: number): Promise<number> {
    const files = await this.listBackups(folderId);
    const excess = files.slice(Math.max(retain, 1));
    for (const f of excess) await this.deleteFile(f.id);
    return excess.length;
  }
}
