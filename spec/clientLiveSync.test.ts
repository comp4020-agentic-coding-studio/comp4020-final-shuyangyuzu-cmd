// Imports the REAL browser file, public/liveSync.js — not a restatement
// of its logic — so this is a test of the actual client implementation,
// not of a hand-written copy that happens to agree with src/live.ts on
// paper. public/app.js and public/tavern.js both call this exact
// function (threaded through createTavern's options from app.js — see
// public/liveSync.js's own doc comment) rather than each keeping its own
// independently-written gate, which is what a second review of the first
// version of this fix pointed out: two copies individually matching
// spec/liveSync.test.ts's pure-function contract is not the same
// guarantee as there being exactly one copy both views actually run.
//
// vitest's default environment is Node, and this file has zero DOM
// dependency (no `document`/`window`/`fetch`), so importing it directly
// here needs no jsdom setup — unlike public/app.js (a top-level script
// that touches `document` immediately on load) or the bulk of
// public/tavern.js (canvas/DOM-driven), neither of which can be
// imported this plainly.

import { describe, expect, it } from "vitest";
import { shouldApplyLiveUpdate } from "../public/liveSync.js";

describe("public/liveSync.js shouldApplyLiveUpdate (the real client file)", () => {
  it("applies the first payload, applies a newer same-epoch seq, and rejects a stale/duplicate same-epoch seq", () => {
    expect(shouldApplyLiveUpdate(null, { epoch: 1000, seq: 0 })).toBe(true);
    const current = { epoch: 1000, seq: 5 };
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, seq: 6 })).toBe(true);
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, seq: 5 })).toBe(false);
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, seq: 2 })).toBe(false);
  });

  // The exact ordering a follow-up review asked to see proven as one
  // continuous sequence, not just as two separately-true facts: accept
  // epoch A, accept epoch B (the restart), reject a LATE epoch-A response
  // arriving *after* B was already accepted, and confirm B's own later
  // updates keep applying normally afterward. A client that only checked
  // `incoming.epoch !== current.epoch` (treating any different epoch as
  // "newer") would wrongly accept the late A response at step 3 and snap
  // the view back to pre-restart state — this function (and the actual
  // client code, since this import is that code) must not do that.
  it("walks the full accept-A / accept-B / reject-late-A / keep-accepting-B sequence a restart produces", () => {
    let cursor = null;

    // Step 1: client accepts old epoch A, seq 202 (matches the
    // independent review's own repro numbers).
    const stepA = { epoch: 1000, seq: 202 };
    expect(shouldApplyLiveUpdate(cursor, stepA)).toBe(true);
    cursor = stepA;

    // Step 2: the server restarts; a genuinely new connection/fetch
    // delivers the new process's epoch B, seq 0.
    const stepB = { epoch: 2000, seq: 0 };
    expect(shouldApplyLiveUpdate(cursor, stepB)).toBe(true);
    cursor = stepB;

    // Step 3: A's own old HTTP response or SSE callback finally arrives,
    // late, after B has already been accepted — even with a seq far
    // higher than anything B has produced. This must still be rejected:
    // it's from a server generation this view has already moved past.
    // Mirrors the real call site exactly (public/liveSync.js's own
    // callers): the cursor is only ever reassigned when the gate says
    // yes, so a rejected update leaves it at B, unchanged.
    const lateA = { epoch: 1000, seq: 999999 };
    expect(shouldApplyLiveUpdate(cursor, lateA)).toBe(false);
    expect(cursor).toEqual(stepB);

    // Step 4: B's own subsequent, legitimate updates must keep applying
    // normally — the rejection in step 3 must not have wedged the gate.
    expect(shouldApplyLiveUpdate(cursor, { epoch: 2000, seq: 1 })).toBe(true);
    cursor = { epoch: 2000, seq: 1 };
    expect(shouldApplyLiveUpdate(cursor, { epoch: 2000, seq: 2 })).toBe(true);
  });

  it("does not treat 'a different epoch' as automatically newer — only a strictly greater one", () => {
    // Guards against the specific wrong implementation a reviewer named
    // directly: `incoming.epoch !== current.epoch` alone says nothing
    // about direction. A late, lower-epoch arrival must compare `<`, not
    // merely `!==`.
    const current = { epoch: 2000, seq: 3 };
    expect(shouldApplyLiveUpdate(current, { epoch: 1000, seq: 999 })).toBe(false);
    expect(shouldApplyLiveUpdate(current, { epoch: 3000, seq: 0 })).toBe(true);
  });
});
