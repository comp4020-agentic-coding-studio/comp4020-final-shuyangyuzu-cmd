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
// number (a game room's existing `version` column for room channels; the
// counter below for the bar channel) and discarding anything not strictly
// newer than the last one it applied — this module just delivers
// payloads in commit order, it doesn't dedupe or buffer them itself.

type Send = (data: string) => void;

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

export function subscribeBar(send: Send): () => void {
  barSubscribers.add(send);
  return () => {
    barSubscribers.delete(send);
  };
}

// A single, process-wide counter: the bar has no per-row version column
// the way a game room's `rooms.version` does (its state is many
// independently-updated rows, not one versioned blob), so this is the
// bar channel's own monotonic sequence instead. Resetting to 0 on a
// restart is fine — there are no SSE subscribers left to have seen a
// higher number by the time a fresh process has any, and every client
// always does one unconditional fresh fetch on connect/reconnect
// regardless of what it last saw.
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
