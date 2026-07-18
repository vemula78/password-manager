import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS, parseCsvToLoginItems } from "../src/importCsv";

describe("parseCsvToLoginItems", () => {
  it("parses an Apple Passwords-style export", () => {
    const csv =
      "Title,URL,Username,Password,Notes,OTPAuth\n" +
      "Example Bank,https://example.com,alice,hunter2pass,Primary account,\n" +
      "Github,https://github.com,alice@example.com,gh-pass-1,,otpauth://totp/GitHub:alice?secret=ABC123&issuer=GitHub\n";

    const result = parseCsvToLoginItems(csv);
    expect(result.totalRows).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.items).toHaveLength(2);

    expect(result.items[0]).toEqual({
      title: "Example Bank",
      fields: { username: "alice", password: "hunter2pass", url: "https://example.com" },
      notes: "Primary account",
    });
    expect(result.items[1]!.otpauth).toBe("otpauth://totp/GitHub:alice?secret=ABC123&issuer=GitHub");
  });

  it("handles quoted fields with embedded commas, quotes, and newlines", () => {
    const csv =
      'Title,URL,Username,Password,Notes\n' +
      '"Acme, Inc.",https://acme.example,bob,"pa""ss,word","line one\nline two"\n';
    const result = parseCsvToLoginItems(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe("Acme, Inc.");
    expect(result.items[0]!.fields.password).toBe('pa"ss,word');
    expect(result.items[0]!.notes).toBe("line one\nline two");
  });

  it("tolerates common header name variants (Chrome-style export)", () => {
    const csv = "name,url,username,password,note\nMy Site,https://site.example,carol,pw123,a note\n";
    const result = parseCsvToLoginItems(csv);
    expect(result.items[0]).toMatchObject({
      title: "My Site",
      fields: { username: "carol", password: "pw123", url: "https://site.example" },
      notes: "a note",
    });
  });

  it("skips fully blank rows and rows with no usable data", () => {
    const csv = "Title,URL,Username,Password,Notes\n,,,,\nReal Item,https://x.example,u,p,\n";
    const result = parseCsvToLoginItems(csv);
    expect(result.totalRows).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe("Real Item");
  });

  it("falls back to URL or username as the title when Title is missing", () => {
    const csv = "URL,Username,Password\nhttps://noname.example,someone,pw\n";
    const result = parseCsvToLoginItems(csv);
    expect(result.items[0]!.title).toBe("https://noname.example");
  });

  it("returns empty result for an empty file", () => {
    expect(parseCsvToLoginItems("")).toEqual({ items: [], skipped: 0, totalRows: 0, truncated: false });
  });

  it("handles a header-only file with no data rows", () => {
    const result = parseCsvToLoginItems("Title,URL,Username,Password,Notes\n");
    expect(result.totalRows).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("truncates at MAX_IMPORT_ROWS and reports truncation", () => {
    const header = "Title,Username,Password\n";
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 10 }, (_, i) => `Item ${i},user${i},pass${i}`).join("\n");
    const result = parseCsvToLoginItems(header + rows + "\n");
    expect(result.totalRows).toBe(MAX_IMPORT_ROWS + 10);
    expect(result.items).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("does not choke on unknown/extra columns, and ignores them", () => {
    const csv = "Title,Username,Password,Category,Favorite\nItem,u,p,Finance,true\n";
    const result = parseCsvToLoginItems(csv);
    expect(result.items[0]).toEqual({
      title: "Item",
      fields: { username: "u", password: "p" },
      notes: "",
    });
  });
});
