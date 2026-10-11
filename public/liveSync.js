// Shared client-side staleness gate for both the game-room view
// (public/app.js) and the bar/world view (public/tavern.js) — ONE
// implementation, not two independently hand-written copies, so they
// can't quietly drift from each other or from src/live.ts's own
// shouldApplyLiveUpdate, which this mirrors exactly (same name, same
// contract). A Crit 9 phase 7 independent review pointed out that two
// copies passing the same manual trace isn't the same guarantee as one
// copy both views actually call — this file, plus
// spec/clientLiveSync.test.ts (which imports this exact file, not a
// restatement of it), is the fix. See src/live.ts's own doc comment for
// the full reasoning behind each rule below; see PLAN.md's Crit 9 phase 7
// entry for the bug this was written to stop (a server restart
// permanently rejected by a client holding a pre-restart high-water
// mark) and the follow-up review that asked for the exact
// accept-A/accept-B/reject-late-A/keep-accepting-B sequence to be proven,
// not just each half of it separately.
//
//  - No baseline yet (`current === null`): always apply — there's
//    nothing on screen yet to protect.
//  - A strictly newer `epoch` (a different server process generation —
//    e.g. a restart) always wins, regardless of `seq`: a freshly
//    restarted process's own sequence legitimately starts back at 0,
//    which must not be read as "older than everything already applied."
//  - A strictly older epoch never wins, even arriving *after* a newer
//    one was already applied — a late response from (or a queued SSE
//    frame on a connection to) a process that's since died must not
//    regress a view that has already moved on to its replacement. This
//    is the exact case an independent review asked to see proven end to
//    end, not just asserted: accept epoch A's rev 202, accept epoch B's
//    rev 0 (the restart), then a late epoch-A response (however high its
//    own rev) must still be rejected, and B's own subsequent updates
//    must keep applying normally afterward.
//  - Within the same epoch, strictly-newer `seq` wins — the original,
//    pre-epoch rule, now scoped to "newer within this server
//    generation."
//
// There is deliberately no separate "connection id" or "request
// generation" concept beyond (epoch, seq): within one epoch, the
// server's own seq is already a total order over every mutation and
// presence tick in that generation, independent of which specific
// EventSource connection or HTTP request happened to deliver a given
// payload — a stale duplicate or reordered delivery from an old
// connection object is caught by the plain seq comparison exactly the
// same as a stale duplicate from the current connection would be. Epoch
// is the only extra axis a restart adds.
export function shouldApplyLiveUpdate(current, incoming) {
  if (current === null) return true;
  if (incoming.epoch !== current.epoch) return incoming.epoch > current.epoch;
  return incoming.seq > current.seq;
}
