import { describe, expect, it } from "vitest";
import { compareHosts, evaluateFillSafety, extractHost, isLookalike } from "../src/lib/domain";

describe("extractHost", () => {
  it("extracts the lowercased hostname", () => {
    expect(extractHost("https://Example.com/login")).toBe("example.com");
  });
  it("returns null for unparseable input", () => {
    expect(extractHost("not a url")).toBeNull();
  });
});

describe("compareHosts", () => {
  it("matches identical hosts", () => {
    expect(compareHosts("sbi.co.in", "sbi.co.in")).toBe("exact");
  });
  it("ignores a leading www.", () => {
    expect(compareHosts("www.sbi.co.in", "sbi.co.in")).toBe("exact");
  });
  it("recognizes subdomains as related", () => {
    expect(compareHosts("netbanking.sbi.co.in", "sbi.co.in")).toBe("subdomain");
  });
  it("flags unrelated hosts as a mismatch", () => {
    expect(compareHosts("evil.example", "sbi.co.in")).toBe("mismatch");
  });
});

describe("isLookalike", () => {
  it("flags confusable character substitution", () => {
    expect(isLookalike("paypa1.com", "paypal.com")).toBe(true);
  });
  it("flags a small edit-distance typosquat", () => {
    expect(isLookalike("hdfcbnk.com", "hdfcbank.com")).toBe(true);
  });
  it("does not flag unrelated hosts as lookalikes", () => {
    expect(isLookalike("evil-totally-different.example", "sbi.co.in")).toBe(false);
  });
  it("does not flag identical hosts", () => {
    expect(isLookalike("sbi.co.in", "sbi.co.in")).toBe(false);
  });
});

describe("evaluateFillSafety", () => {
  it("requires no confirmation for an exact https match", () => {
    const r = evaluateFillSafety("https://sbi.co.in/login", "https://sbi.co.in");
    expect(r.requiresConfirmation).toBe(false);
  });
  it("requires confirmation on http:// pages", () => {
    const r = evaluateFillSafety("http://sbi.co.in/login", "https://sbi.co.in");
    expect(r.requiresConfirmation).toBe(true);
    expect(r.reasons.some((x) => x.includes("secure connection"))).toBe(true);
  });
  it("requires confirmation and calls out phishing on a lookalike domain", () => {
    const r = evaluateFillSafety("https://sbi-secure-login.example/login", "https://sbi.co.in");
    expect(r.requiresConfirmation).toBe(true);
  });
  it("requires confirmation on a plain domain mismatch", () => {
    const r = evaluateFillSafety("https://totallyunrelated.example", "https://sbi.co.in");
    expect(r.requiresConfirmation).toBe(true);
  });
});
