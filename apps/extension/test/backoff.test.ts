import { describe, expect, it } from "vitest";
import { blockedForMs, INITIAL_BACKOFF, nextBackoffState, resetBackoff } from "../src/lib/backoff";

describe("unlock backoff math", () => {
  it("does not block for the first 4 failures", () => {
    let state = INITIAL_BACKOFF;
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) state = nextBackoffState(state, now);
    expect(state.fails).toBe(4);
    expect(blockedForMs(state, now)).toBe(0);
  });

  it("blocks for 30s on the 5th failure", () => {
    let state = INITIAL_BACKOFF;
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) state = nextBackoffState(state, now);
    expect(state.fails).toBe(5);
    expect(blockedForMs(state, now)).toBe(30_000);
  });

  it("doubles the delay each additional failure, capped at 1 hour", () => {
    let state = INITIAL_BACKOFF;
    const now = 0;
    for (let i = 0; i < 6; i++) state = nextBackoffState(state, now);
    expect(blockedForMs(state, now)).toBe(60_000); // 6th failure -> 60s

    for (let i = 0; i < 20; i++) state = nextBackoffState(state, now); // way past the cap
    expect(blockedForMs(state, now)).toBe(3_600_000); // capped at 1 hour
  });

  it("resetBackoff clears fails and until", () => {
    const state = resetBackoff();
    expect(state).toEqual({ fails: 0, until: 0 });
  });

  it("blockedForMs counts down to zero as time passes", () => {
    const state = nextBackoffState({ fails: 4, until: 0 }, 0); // -> 5th failure, 30s block
    expect(blockedForMs(state, 0)).toBe(30_000);
    expect(blockedForMs(state, 15_000)).toBe(15_000);
    expect(blockedForMs(state, 30_000)).toBe(0);
    expect(blockedForMs(state, 60_000)).toBe(0);
  });
});
