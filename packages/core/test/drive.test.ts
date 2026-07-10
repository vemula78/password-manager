import { describe, expect, it } from "vitest";
import { BACKUP_FOLDER_NAME, DriveClient, DriveError } from "../src/drive";

interface Call {
  url: string;
  init: RequestInit;
}

/** Minimal Drive v3 mock: folder search/create, multipart upload, list, delete. */
function mockDrive(existingFolder = false) {
  const calls: Call[] = [];
  const files: { id: string; name: string; createdTime: string }[] = [];
  let idSeq = 1;
  const folderId = "folder-1";

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });

    if (url.includes("/files?q=") && url.includes("in%20parents")) {
      return respond({ files: [...files].reverse() });
    }
    if (url.includes("/files?q=") && url.includes("vnd.google-apps.folder")) {
      return respond({ files: existingFolder ? [{ id: folderId }] : [] });
    }
    if (url.includes("upload/drive/v3/files")) {
      const f = { id: `file-${idSeq++}`, name: `upload-${idSeq}`, createdTime: new Date(idSeq * 1000).toISOString() };
      files.push(f);
      return respond(f);
    }
    if (url.match(/\/files\/[^?]+\?alt=media/)) {
      return new Response("encrypted-backup-content");
    }
    if (init.method === "DELETE") {
      const id = url.split("/").pop()!;
      const i = files.findIndex((f) => f.id === id);
      if (i >= 0) files.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (init.method === "POST" && url.endsWith("/files")) {
      return respond({ id: folderId });
    }
    return respond({ error: "unexpected" }, 500);
  }) as unknown as typeof fetch;

  const client = new DriveClient({
    fetch: fetchImpl,
    getAccessToken: async () => "test-token",
  });
  return { client, calls, files, folderId };
}

describe("DriveClient", () => {
  it("creates the dedicated folder when missing, reuses it when present", async () => {
    const fresh = mockDrive(false);
    expect(await fresh.client.ensureFolder()).toBe("folder-1");
    const createCall = fresh.calls.find((c) => c.init.method === "POST");
    expect(createCall).toBeDefined();
    expect(String(createCall!.init.body)).toContain(BACKUP_FOLDER_NAME);

    const existing = mockDrive(true);
    expect(await existing.client.ensureFolder()).toBe("folder-1");
    expect(existing.calls.some((c) => c.init.method === "POST")).toBe(false);
  });

  it("sends the bearer token and uploads content as octet-stream multipart", async () => {
    const { client, calls } = mockDrive(true);
    await client.uploadBackup("folder-1", "vault-backup-x.pwmbackup", "ENCRYPTED");
    const upload = calls.find((c) => c.url.includes("upload/drive"));
    expect(upload).toBeDefined();
    expect((upload!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(String(upload!.init.body)).toContain("ENCRYPTED");
    expect(String(upload!.init.body)).toContain("application/octet-stream");
  });

  it("prunes to the retention count, deleting oldest first", async () => {
    const { client, files } = mockDrive(true);
    for (let i = 0; i < 5; i++) await client.uploadBackup("folder-1", `b${i}`, "x");
    expect(files).toHaveLength(5);
    const deleted = await client.prune("folder-1", 3);
    expect(deleted).toBe(2);
    expect(files).toHaveLength(3);
  });

  it("downloads backup content and surfaces HTTP failures as DriveError", async () => {
    const { client } = mockDrive(true);
    expect(await client.downloadBackup("file-1")).toBe("encrypted-backup-content");

    const failing = new DriveClient({
      fetch: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
      getAccessToken: async () => "t",
    });
    await expect(failing.ensureFolder()).rejects.toThrow(DriveError);
  });
});
