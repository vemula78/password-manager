import { describe, expect, it } from "vitest";
import {
  fillRefusedKeysFor,
  isFillRefusedField,
  requiresPerFillConfirmation,
} from "../src/lib/sensitiveFields";
import { fillableFieldsFor } from "../src/lib/fillableFields";

describe("isFillRefusedField", () => {
  it("refuses netbanking transaction password", () => {
    expect(isFillRefusedField("netbanking", "transactionPassword")).toBe(true);
  });
  it("refuses netbanking MPIN and TPIN", () => {
    expect(isFillRefusedField("netbanking", "mpin")).toBe(true);
    expect(isFillRefusedField("netbanking", "tpin")).toBe(true);
  });
  it("refuses card CVV", () => {
    expect(isFillRefusedField("card", "cvv")).toBe(true);
  });
  it("refuses demat trading TPIN and trading password is not auto-refused by kind, but is not in the fillable map anyway", () => {
    expect(isFillRefusedField("demat", "tpin")).toBe(true);
  });
  it("does not refuse an ordinary login password", () => {
    expect(isFillRefusedField("login", "password")).toBe(false);
  });
  it("does not refuse netbanking's ordinary login password", () => {
    expect(isFillRefusedField("netbanking", "loginPassword")).toBe(false);
  });
  it("returns false for a field that does not exist on the template", () => {
    expect(isFillRefusedField("login", "doesNotExist")).toBe(false);
  });
});

describe("requiresPerFillConfirmation", () => {
  it("requires confirmation for netbanking, demat, and govid", () => {
    expect(requiresPerFillConfirmation("netbanking")).toBe(true);
    expect(requiresPerFillConfirmation("demat")).toBe(true);
    expect(requiresPerFillConfirmation("govid")).toBe(true);
  });
  it("does not require confirmation for a plain login", () => {
    expect(requiresPerFillConfirmation("login")).toBe(false);
  });
});

describe("fillableFieldsFor never points at a refused field", () => {
  it("holds for every item type with a mapping", () => {
    const types = ["login", "netbanking", "demat", "govid", "insurance", "wifi"] as const;
    for (const t of types) {
      const { passwordKey } = fillableFieldsFor(t);
      if (passwordKey) expect(isFillRefusedField(t, passwordKey)).toBe(false);
    }
  });
});

describe("fillRefusedKeysFor", () => {
  it("lists all pin-like and explicit refused keys for netbanking", () => {
    const keys = fillRefusedKeysFor("netbanking");
    expect(keys).toEqual(
      expect.arrayContaining(["transactionPassword", "profilePassword", "mpin", "tpin"]),
    );
  });
});
