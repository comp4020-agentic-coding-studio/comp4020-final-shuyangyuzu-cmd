// src/presence.ts's time-based decisions, tested directly rather than
// over HTTP: isConnected/isPastGrace/pickNextHost are the contract
// themselves (there's no separate "real" behavior to compare them
// against), and testing them with synthetic timestamps is the only way
// to check a 60-second grace period without either waiting 60 real
// seconds in every `pnpm check` run or hacking a second server instance
// with different env into the one this suite's global-setup already
// found. See PLAN.md's playtest-round-1 section for this trade-off, and
// spec/lobby.test.ts for the HTTP-level behavior these decisions feed
// into (ready-gating, leave, disband, host transfer, closed rooms) —
// none of which need real time to pass to test.

import { describe, expect, it } from "vitest";
import { isConnected, isPastGrace, pickNextHost } from "../src/presence.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const secondsAfter = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();

describe("isConnected", () => {
  it("is true right at T0 with staleMs covering it", () => {
    expect(isConnected(secondsAfter(0), T0, 15000)).toBe(true);
  });

  it("is true just under the threshold", () => {
    const lastSeen = secondsAfter(0);
    const now = new Date(T0.getTime() + 14999);
    expect(isConnected(lastSeen, now, 15000)).toBe(true);
  });

  it("is false just over the threshold", () => {
    const lastSeen = secondsAfter(0);
    const now = new Date(T0.getTime() + 15001);
    expect(isConnected(lastSeen, now, 15000)).toBe(false);
  });
});

describe("isPastGrace", () => {
  it("is false well within the grace period", () => {
    const now = new Date(T0.getTime() + 59000);
    expect(isPastGrace(secondsAfter(0), now, 60000)).toBe(false);
  });

  it("is true once the grace period has elapsed", () => {
    const now = new Date(T0.getTime() + 60001);
    expect(isPastGrace(secondsAfter(0), now, 60000)).toBe(true);
  });

  it("resets on a fresh heartbeat, exactly as a comeback-within-grace needs", () => {
    // 59s since the original heartbeat, but a fresh one landed 1s ago.
    const freshHeartbeat = secondsAfter(58);
    const now = new Date(T0.getTime() + 59000);
    expect(isPastGrace(freshHeartbeat, now, 60000)).toBe(false);
  });
});

describe("pickNextHost", () => {
  it("picks the remaining player with the lowest seat (join order)", () => {
    const players = [
      { id: "c", seat: 2 },
      { id: "a", seat: 0 },
      { id: "b", seat: 1 },
    ];
    // "a" (seat 0, the original host) has already been removed by the
    // caller before this is called — this is choosing among whoever's
    // left.
    expect(pickNextHost(players)).toBe("a");
    expect(pickNextHost(players.filter((p) => p.id !== "a"))).toBe("b");
  });

  it("returns null when nobody's left", () => {
    expect(pickNextHost([])).toBeNull();
  });
});
