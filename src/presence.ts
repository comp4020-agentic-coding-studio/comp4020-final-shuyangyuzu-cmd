// Heartbeat-based presence, kept in its own table rather than inside the
// versioned room-state blob. A heartbeat lands every few seconds per
// player; if it had to go through the same optimistic-concurrency
// version column every other action uses (CLAUDE.md), it would spuriously
// collide with real game actions arriving at the same moment. This table
// has no version column at all — a heartbeat is just "last_seen_at for
// this player, now", upserted unconditionally.
//
// Two different thresholds, two different purposes:
// - PRESENCE_STALE_MS: how recent a heartbeat has to be for a player to
//   show as "connected" in the UI. Short — this is a liveness indicator.
// - LOBBY_GRACE_MS: how long a lobby seat is held after a player goes
//   quiet before they're auto-removed. Long — this is "are they really
//   gone", per product decision 4 in PLAN.md's playtest-round-1 section.
// Both are env-overridable so the pure decision functions below can be
// unit-tested with whatever values are convenient, without the real
// server (or a real person) ever needing to wait out the production
// default to find out if the logic is right.

export const PRESENCE_STALE_MS = Number(process.env.PRESENCE_STALE_MS ?? 15000);
export const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS ?? 60000);

import type Database from "better-sqlite3";

export function recordHeartbeat(db: Database.Database, roomId: string, playerId: string, now = new Date()): void {
  db.prepare(
    `INSERT INTO presence (player_id, room_id, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(playerId, roomId, now.toISOString());
}

export function lastSeenTimes(db: Database.Database, roomId: string): Map<string, string> {
  const rows = db.prepare(`SELECT player_id, last_seen_at FROM presence WHERE room_id = ?`).all(roomId) as Array<{
    player_id: string;
    last_seen_at: string;
  }>;
  return new Map(rows.map((r) => [r.player_id, r.last_seen_at]));
}

export function forgetPresence(db: Database.Database, playerId: string): void {
  db.prepare(`DELETE FROM presence WHERE player_id = ?`).run(playerId);
}

/** Pure: is this player currently "connected" for display purposes?
 * `lastSeen` is their own last heartbeat if any, else their join time
 * (a player who just joined and hasn't heartbeated yet isn't stale). */
export function isConnected(lastSeen: string, now: Date, staleMs = PRESENCE_STALE_MS): boolean {
  return now.getTime() - new Date(lastSeen).getTime() <= staleMs;
}

/** Pure: has this lobby seat gone past its disconnect grace period and
 * should be auto-released? */
export function isPastGrace(lastSeen: string, now: Date, graceMs = LOBBY_GRACE_MS): boolean {
  return now.getTime() - new Date(lastSeen).getTime() > graceMs;
}

/** Pure: given the remaining players (after removing whoever's past
 * grace or has voluntarily left) and who the host was, who becomes host
 * next? Product decision: the remaining player with the lowest seat
 * number — i.e. next by join order. Returns null if nobody's left. */
export function pickNextHost<T extends { id: string; seat: number }>(
  remainingPlayers: readonly T[],
): string | null {
  if (remainingPlayers.length === 0) return null;
  return remainingPlayers.slice().sort((a, b) => a.seat - b.seat)[0].id;
}
