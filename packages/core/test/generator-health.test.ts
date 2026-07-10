import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto } from "../src/crypto";
import { generatePassphrase, generatePassword, generatePin } from "../src/generator";
import { analyzeHealth, estimateStrength } from "../src/health";
import type { VaultItem } from "../src/model";

beforeAll(async () => {
  await initCrypto();
});

describe("password generator", () => {
  it("honours length and includes every selected character class", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({
        length: 20, lower: true, upper: true, digits: true, symbols: true, excludeAmbiguous: true,
      });
      expect(pw).toHaveLength(20);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
      expect(pw).not.toMatch(/[0O1lI|]/); // ambiguous excluded
    }
  });

  it("generates distinct passwords (CSPRNG sanity)", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword()));
    expect(seen.size).toBe(100);
  });

  it("passphrases have the requested word count and separator", () => {
    const pp = generatePassphrase({ words: 5, separator: "-", capitalize: true, includeNumber: false });
    expect(pp.split("-")).toHaveLength(5);
    for (const w of pp.split("-")) expect(w).toMatch(/^[A-Z]/);
  });

  it("PINs are numeric with the requested length", () => {
    expect(generatePin(6)).toMatch(/^\d{6}$/);
  });
});

function item(id: string, type: VaultItem["type"], fields: Record<string, string>): VaultItem {
  return {
    id, type, title: id, folder: null, tags: [], favorite: false, archived: false,
    fields, customFields: [], notes: "", reminders: [], passwordHistory: [], versions: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01", lastUsedAt: null,
  };
}

describe("password health", () => {
  it("classifies strength sensibly", () => {
    expect(estimateStrength("password123").strength).toBe("very-weak"); // common list
    expect(estimateStrength("abc").strength).toBe("very-weak");
    expect(estimateStrength("Tr0ub4dor&3horse-staple").strength).toBe("strong");
  });

  it("detects weak and reused passwords across items", () => {
    const report = analyzeHealth([
      item("a", "login", { username: "u", password: "shared-pass-99" }),
      item("b", "netbanking", { loginPassword: "shared-pass-99", transactionPassword: "abc" }),
      item("c", "login", { password: "G8#kPz!vQ2mL9xWr" }),
    ]);
    expect(report.totalPasswords).toBe(4);
    expect(report.weak.map((u) => u.fieldKey)).toContain("transactionPassword");
    expect(report.reused).toHaveLength(1);
    expect(report.reused[0]!).toHaveLength(2);
    expect(report.score).toBeLessThan(100);
  });

  it("ignores archived items and gives an empty vault a perfect score", () => {
    const archived = { ...item("a", "login", { password: "123456" }), archived: true };
    const report = analyzeHealth([archived]);
    expect(report.totalPasswords).toBe(0);
    expect(report.score).toBe(100);
  });
});
