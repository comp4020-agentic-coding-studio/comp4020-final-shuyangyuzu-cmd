// src/live.ts's cross-restart staleness contract (shouldApplyLiveUpdate),
// tested directly against synthetic cursors rather than by actually
// restarting a server mid-suite — the same trade-off spec/presence.test.ts
// makes for isConnected/isPastGrace, and for the same reason: the exact
// scenario this guards against (a server process actually restarting)
// never happens mid-run against the single global-setup server the rest
// of this suite shares. See PLAN.md's Crit 9 phase 7 entry for the actual
// restart-with-an-open-browser-page verification this can't replace.
//
// Found by an independent review, reproduced directly before any fix
// existed: a client that had already seen seq 202 before a restart,
// pointed at a freshly-restarted process reporting seq 0/1/2..., rejected
// every payload forever under the old "incoming <= lastSeen discard"
// rule — nothing in that rule ever lets a *smaller* number back in, no
// matter how many times the client reconnects or force-fetches.

import { describe, expect, it } from "vitest";
import { shouldApplyLiveUpdate, type LiveCursor } from "../src/live.ts";

describe("shouldApplyLiveUpdate", () => {
  it("applies the very first payload a view ever sees, whatever its numbers", () => {
    expect(shouldApplyLiveUpdate(null, { epoch: 1000, rev: 0 })).toBe(true);
  });

  it("applies a strictly newer rev within the same epoch (the original rule)", () => {
    const current: LiveCursor = { epoch: 1000, rev: 5 };
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, rev: 6 })).toBe(true);
  });

  it("discards a stale or duplicate rev within the same epoch", () => {
    const current: LiveCursor = { epoch: 1000, rev: 5 };
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, rev: 5 })).toBe(false);
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, rev: 3 })).toBe(false);
  });

  it("the exact reported bug: a restarted process's low rev must not be rejected just because it's lower than a pre-restart high-water mark", () => {
    // The independent review's own repro numbers: seq 202 before a
    // restart, seq 0 on the freshly-restarted process. Under the old
    // bare "incoming <= lastSeen" rule this would be rejected (0 <= 202)
    // and every subsequent payload from the new process would be
    // rejected too, forever, since the new process's seq only grows from
    // 0 — it would take 203 real mutations before anything got through.
    const beforeRestart: LiveCursor = { epoch: 1000, rev: 202 };
    const afterRestart: LiveCursor = { epoch: 2000, rev: 0 };
    expect(shouldApplyLiveUpdate(beforeRestart, afterRestart)).toBe(true);
  });

  it("a newer epoch resets the baseline even mid-stream, and the new epoch's own sequence then behaves normally from there", () => {
    let current: LiveCursor | null = { epoch: 1000, rev: 50 };
    const afterRestart: LiveCursor = { epoch: 2000, rev: 0 };
    expect(shouldApplyLiveUpdate(current, afterRestart)).toBe(true);
    current = afterRestart;
    expect(shouldApplyLiveUpdate(current, { epoch: 2000, rev: 0 })).toBe(false); // duplicate
    expect(shouldApplyLiveUpdate(current, { epoch: 2000, rev: 1 })).toBe(true);
  });

  it("never lets a late response from an already-superseded (older) epoch regress a view that has moved on", () => {
    // Simulates: an in-flight request to the old process, or a queued
    // frame on a connection to it, finally arriving after the client has
    // already reconnected to the newer process that replaced it and
    // applied its state.
    const movedOn: LiveCursor = { epoch: 2000, rev: 3 };
    const lateFromOldProcess: LiveCursor = { epoch: 1000, rev: 999 };
    expect(shouldApplyLiveUpdate(movedOn, lateFromOldProcess)).toBe(false);
  });

  // A follow-up review asked for the full sequence proven end to end in
  // one test, not just as separately-true facts above — accepting A then
  // B doesn't by itself prove a late A arriving *after* B is still
  // rejected, and rejecting a late A in isolation doesn't by itself prove
  // B's own later updates keep working afterward. See
  // spec/clientLiveSync.test.ts for the identical sequence run against
  // the actual browser file (public/liveSync.js), not just this
  // server-side copy.
  it("walks the full accept-A / accept-B / reject-late-A / keep-accepting-B sequence a restart produces", () => {
    let cursor: LiveCursor | null = null;

    const stepA: LiveCursor = { epoch: 1000, rev: 202 };
    expect(shouldApplyLiveUpdate(cursor, stepA)).toBe(true);
    cursor = stepA;

    const stepB: LiveCursor = { epoch: 2000, rev: 0 };
    expect(shouldApplyLiveUpdate(cursor, stepB)).toBe(true);
    cursor = stepB;

    const lateA: LiveCursor = { epoch: 1000, rev: 999999 };
    expect(shouldApplyLiveUpdate(cursor, lateA)).toBe(false);
    expect(cursor).toEqual(stepB); // a rejection must never reassign the cursor

    expect(shouldApplyLiveUpdate(cursor, { epoch: 2000, rev: 1 })).toBe(true);
  });

  it("does not treat 'a different epoch' as automatically newer — only a strictly greater one", () => {
    // Directly guards the wrong implementation shape a reviewer named:
    // `incoming.epoch !== current.epoch` alone says nothing about
    // direction and would wrongly accept a late, lower-epoch arrival.
    const current: LiveCursor = { epoch: 2000, rev: 3 };
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, rev: 999 })).toBe(false);
    expect(shouldApplyLiveUpdate(current, { epoch: 3000, rev: 0 })).toBe(true);
  });
});
