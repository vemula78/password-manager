import { describe, expect, it } from "vitest";
import {
  AUTO_LOCK_DEFAULT_MINUTES,
  clampAutoLockMinutes,
  isValidAutoLockMinutes,
  isValidClipboardClearSeconds,
} from "../src/lib/bounds";

describe("isValidAutoLockMinutes", () => {
  it("accepts the bounds and values between them", () => {
    expect(isValidAutoLockMinutes(1)).toBe(true);
    expect(isValidAutoLockMinutes(5)).toBe(true);
    expect(isValidAutoLockMinutes(240)).toBe(true);
  });
  it('rejects 0 — no "never lock" setting', () => {
    expect(isValidAutoLockMinutes(0)).toBe(false);
  });
  it("rejects out-of-range, non-integer, and non-number input", () => {
    expect(isValidAutoLockMinutes(-1)).toBe(false);
    expect(isValidAutoLockMinutes(241)).toBe(false);
    expect(isValidAutoLockMinutes(2.5)).toBe(false);
    expect(isValidAutoLockMinutes(NaN)).toBe(false);
    expect(isValidAutoLockMinutes(Infinity)).toBe(false);
    expect(isValidAutoLockMinutes("5")).toBe(false);
    expect(isValidAutoLockMinutes(null)).toBe(false);
    expect(isValidAutoLockMinutes(undefined)).toBe(false);
  });
});

describe("isValidClipboardClearSeconds", () => {
  it("accepts 5..300 integers", () => {
    expect(isValidClipboardClearSeconds(5)).toBe(true);
    expect(isValidClipboardClearSeconds(30)).toBe(true);
    expect(isValidClipboardClearSeconds(300)).toBe(true);
  });
  it("rejects out-of-range and non-integer input", () => {
    expect(isValidClipboardClearSeconds(4)).toBe(false);
    expect(isValidClipboardClearSeconds(0)).toBe(false);
    expect(isValidClipboardClearSeconds(301)).toBe(false);
    expect(isValidClipboardClearSeconds(10.5)).toBe(false);
  });
});

describe("clampAutoLockMinutes", () => {
  it("passes through valid values", () => {
    expect(clampAutoLockMinutes(7)).toBe(7);
  });
  it('coerces invalid values (including the web app\'s "0 = never") to the default', () => {
    expect(clampAutoLockMinutes(0)).toBe(AUTO_LOCK_DEFAULT_MINUTES);
    expect(clampAutoLockMinutes(999)).toBe(AUTO_LOCK_DEFAULT_MINUTES);
    expect(clampAutoLockMinutes(undefined)).toBe(AUTO_LOCK_DEFAULT_MINUTES);
  });
});
