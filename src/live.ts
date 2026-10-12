// In-process pub-sub for pushing fresh public state to open SSE
// connections. One Fly machine, no HA (fly.toml), so there's exactly one
// Node process at a time — an in-memory registry is the whole mechanism,
// no external broker needed.
//
// This module only ever carries server-computed public state outward; it
// never receives anything from a client. Every write still goes through
// the existing, already-authenticated, already-tested POST endpoints —
// this is a transport for broadcasting their result, not a new way to
// mutate anything (CLAUDE.md: server authority is unchanged by this).
//
// Staleness is resolved by the receiver comparing a monotonic sequence
// number and discarding anything not strictly newer than the last one it
// applied — this module just delivers payloads in commit order, it
// doesn't dedupe or buffer them itself. Two corrections from an
// independent review of the first version of this file, both recorded in
// full in PLAN.md's Crit 9 phase 7 entry:
//
// 1. A game room's `rooms.version` column (reused directly as the first
//    version of this staleness number) is also idempotency's own
//    optimistic-concurrency counter — bumping it for anything that isn't
//    a real game-state mutation (a heartbeat, a presence timeout) would
//    make an unrelated roll/place race against it. So a room's push
//    sequence is its own counter here (`roomViewSeq`/`currentRoomRev`/
//    `bumpRoomRev`), never `rooms.version` — see src/server.ts's
//    `publishRoomState` for where the two are kept visibly separate in
//    every outgoing payload (`version` for display/debugging, `rev` for
//    the staleness gate).
// 2. Every counter in this file is in-memory and resets to 0 on a
//    process restart — including this corrected one. A client that saw
//    rev/seq 202 before a restart, pointed at a freshly-restarted
//    process reporting 0/1/2..., would reject every payload forever
//    under a bare "incoming <= lastSeen" rule: nothing in that rule ever
//    lets a *smaller* number back in. `SERVER_EPOCH` (below) disambiguates
//    "this number" from "this number, from which server generation" —
//    see `shouldApplyLiveUpdate`'s own doc comment for the exact
//    contract every client-side `applyIncoming` now implements.

type Send = (data: string) => void;

// Set once, when this module first loads (i.e. once per process) — a
// real restart always produces a strictly later wall-clock time than the
// process it replaced, which is all the ordering this needs (there's
// only ever one Node process at a time, per fly.toml's `--ha=false`, so
// there's no risk of two live epochs racing each other).
export const SERVER_EPOCH = Date.now();

export interface LiveCursor {
  epoch: number;
  rev: number;
}

/** Pure: should a payload carrying `incoming` replace whatever a view
 * last actually applied (`current`, or `null` if nothing has been
 * applied yet)? The one staleness rule every client-side `applyIncoming`
 * (public/app.js, public/tavern.js) implements, kept here too so it's
 * unit-testable without a browser (see spec/liveSync.test.ts) — both
 * copies must stay in sync with this contract, not just with each other.
 *
 *  - Nothing applied yet: always apply (there's no baseline to protect).
 *  - A strictly newer epoch always wins, regardless of `rev` — a
 *    restarted process's rev legitimately starts back at 0, and that
 *    must not be read as "older than everything this view has seen."
 *  - A strictly older epoch never wins, even if it arrives *after* a
 *    newer one was already applied — a late response from (or a queued
 *    frame on a connection to) a since-dead process must not regress a
 *    view that has already moved on to the process that replaced it.
 *  - Within the same epoch, strictly-newer `rev` wins — the original
 *    rule this replaces, now scoped to "newer within this server
 *    generation" rather than "newer, full stop." */
export function shouldApplyLiveUpdate(current: LiveCursor | null, incoming: LiveCursor): boolean {
  if (current === null) return true;
  if (incoming.epoch !== current.epoch) return incoming.epoch > current.epoch;
  return incoming.rev > current.rev;
}

const roomSubscribers = new Map<string, Set<Send>>();
const barSubscribers = new Set<Send>();

export function subscribeRoom(code: string, send: Send): () => void {
  let set = roomSubscribers.get(code);
  if (!set) {
    set = new Set();
    roomSubscribers.set(code, set);
  }
  set.add(send);
  return () => {
    set!.delete(send);
    if (set!.size === 0) roomSubscribers.delete(code);
  };
}

export function publishRoom(code: string, payload: unknown): void {
  const set = roomSubscribers.get(code);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const send of set) send(data);
}

/** Room codes with at least one open SSE subscriber right now — what
 * src/server.ts's presence ticker iterates, so it only ever does work
 * (a DB read) for a room someone is actually watching live, never a
 * background sweep of every room that's ever existed. */
export function subscribedRoomCodes(): string[] {
  return [...roomSubscribers.keys()];
}

// A room's own push-revision — separate from `rooms.version` (see this
// file's header comment for why). Resets to 0 per room per process, same
// as `barSeq` below, for the same reason: SERVER_EPOCH disambiguates it
// from any pre-restart value a client might still be holding.
const roomViewSeq = new Map<string, number>();

/** The current push-revision for a room, unchanged — for a plain read
 * (GET /state, rejoin, or the snapshot sent when an SSE connection first
 * opens), which reports "this is current as of rev N" without minting a
 * new N just by being read. */
export function currentRoomRev(code: string): number {
  return roomViewSeq.get(code) ?? 0;
}

/** Bumps and returns a room's new push-revision — called once per actual
 * broadcast-worthy change to that room's public view, whether triggered
 * by a mutation or by the presence ticker noticing a connected flag (or
 * the lazy disconnect-grace sweep) changed on its own. */
export function bumpRoomRev(code: string): number {
  const next = (roomViewSeq.get(code) ?? 0) + 1;
  roomViewSeq.set(code, next);
  return next;
}

export function subscribeBar(send: Send): () => void {
  barSubscribers.add(send);
  return () => {
    barSubscribers.delete(send);
  };
}

/** Whether anyone currently has the bar's SSE channel open — gates the
 * presence ticker's (otherwise pointless) work the same way
 * subscribedRoomCodes() does for room channels. */
export function hasBarSubscribers(): boolean {
  return barSubscribers.size > 0;
}

// A single, process-wide counter: the bar has no per-row version column
// the way a game room's `rooms.version` does (its state is many
// independently-updated rows, not one versioned blob), so this is the
// bar channel's own monotonic sequence instead. Resetting to 0 on a
// restart is, on its own, NOT fine — a browser tab that kept its page
// open across the restart still holds whatever high-water seq it last
// saw, and a bare "fresh fetch after reconnect" doesn't help, because
// that fresh fetch still reports the new process's own low seq and still
// goes through the exact same "incoming <= lastSeen" filter as everything
// else (an independent review caught this; an earlier version of this
// comment claimed the reconnect fetch alone was sufficient — it wasn't,
// see the file header and SERVER_EPOCH above for the actual fix).
let barSeq = 0;

/** The current sequence number, unchanged — for a plain read (GET
 * /api/bar/state, or the snapshot pushed when an SSE connection first
 * opens), which must report "this is current as of seq N", not mint a
 * new N just by being read. */
export function currentBarSeq(): number {
  return barSeq;
}

/** Bumps and returns the new sequence number — called once per actual
 * mutation, right before broadcasting it, so the mutating request's own
 * HTTP response and everyone else's pushed copy carry the identical
 * number. */
export function bumpBarSeq(): number {
  return ++barSeq;
}

export function publishBar(payload: unknown): void {
  if (barSubscribers.size === 0) return;
  const data = JSON.stringify(payload);
  for (const send of barSubscribers) send(data);
}

// ---- Private 1:1 chat (product-direction-update, part 3) ----
//
// One channel per bar identity, never per thread and never the shared
// bar channel above: a message is pushed only to its sender and its
// recipient's own authenticated subscription, so a third party — even
// one who's guessed or computed a thread id — has no channel to listen
// on at all (src/server.ts's subscribe route re-checks the subscriber's
// own session before ever registering it here, same as every other
// bar/chat endpoint; this registry itself is keyed by player id purely
// as routing, not as its own access control).
const chatInboxSubscribers = new Map<string, Set<Send>>();

export function subscribeChatInbox(playerId: string, send: Send): () => void {
  let set = chatInboxSubscribers.get(playerId);
  if (!set) {
    set = new Set();
    chatInboxSubscribers.set(playerId, set);
  }
  set.add(send);
  return () => {
    set!.delete(send);
    if (set!.size === 0) chatInboxSubscribers.delete(playerId);
  };
}

/** Delivers `payload` to one player's own inbox channel only — called
 * twice per sent message (once for the sender's other open tabs/devices,
 * once for the recipient), never broadcast. A no-op if that player has
 * no open subscription right now; a message is still safely persisted
 * (src/chat.ts) and picked up by their next GET .../messages catch-up
 * fetch whenever they do reconnect. */
export function publishToPlayer(playerId: string, payload: unknown): void {
  const set = chatInboxSubscribers.get(playerId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const send of set) send(data);
}
