// Server-computed, server-validated, persisted stamina for a bar
// identity. The client only ever displays this — see CLAUDE.md's
// "Stamina" section for the full constraint list this module exists to
// satisfy, in particular: offline time never decays it, the same
// identity open in several tabs consumes only one copy of it (there is
// exactly one row per bar_players.id, same as bar_presence itself), and
// it has zero effect on any game's rules at any level.
//
// The core invariant `recomputeStamina` relies on: "this identity has
// been online continuously since last_computed_at." That invariant does
// NOT hold for free just by comparing bar_presence.last_seen_at to `now`
// at read time — by the time a reconnect's own heartbeat has already
// overwritten last_seen_at with a fresh value, the evidence that a gap
// ever happened is gone (a freshly-written last_seen_at always looks
// "connected as of right now," gap or no gap). So gap-detection cannot
// live in a lazy read; it has to live at the one place that still has
// the OLD last_seen_at in hand, immediately before overwriting it:
// recordHeartbeat below, called from bar.ts's recordBarHeartbeat — the
// single choke point every bar-identity action already funnels through.
// This is the same "evaluated fresh, no separate sweep" spirit as the
// lobby disconnect grace, just anchored to the one call site that can
// actually see a gap before it's overwritten, rather than to every read.

import type Database from "better-sqlite3";
import { isConnected } from "./presence.ts";

export const STAMINA_INITIAL = 80;
// 21%/hour: a continuous ~3h online session lands at 80 - 21*3 = 17%,
// matching the user's own "just under 20% after about 3 hours" target.
export const STAMINA_DECAY_PER_HOUR = Number(process.env.STAMINA_DECAY_PER_HOUR ?? 21);
export const STAMINA_MEAL_RESTORE = 70;
export const STAMINA_DRINK_RESTORE = 30;
export const STAMINA_LOW_THRESHOLD = 20;
export const STAMINA_MAX = 100;
export const STAMINA_MIN = 0;

interface StaminaRow {
  value: number;
  last_computed_at: string;
}

function clamp(value: number): number {
  return Math.max(STAMINA_MIN, Math.min(STAMINA_MAX, value));
}

function decayFor(ms: number): number {
  return (ms / (60 * 60 * 1000)) * STAMINA_DECAY_PER_HOUR;
}

/** Creates a brand-new identity's stamina row at join time — never left
 * to a lazy read's own default, since a read-time default would be
 * indistinguishable from "never computed yet," and this value must
 * actually persist across restarts/redeploys (CLAUDE.md). */
export function initStamina(db: Database.Database, playerId: string, now = new Date()): void {
  db.prepare(
    `INSERT INTO bar_stamina (player_id, value, last_computed_at) VALUES (?, ?, ?)
     ON CONFLICT(player_id) DO NOTHING`,
  ).run(playerId, STAMINA_INITIAL, now.toISOString());
}

/** Advances stored stamina to `now`, charging decay for the full
 * elapsed interval since last_computed_at — valid ONLY when the caller
 * already knows this identity has been online continuously across that
 * whole interval (every call site below satisfies this by construction).
 * A no-op, non-writing read if this identity has no stamina row yet
 * (shouldn't happen post-join; initStamina is the only writer of a first
 * row). */
export function recomputeStamina(db: Database.Database, playerId: string, now = new Date()): number {
  const row = db.prepare(`SELECT value, last_computed_at FROM bar_stamina WHERE player_id = ?`).get(playerId) as
    | StaminaRow
    | undefined;
  if (!row) return STAMINA_INITIAL;
  const elapsedMs = Math.max(0, now.getTime() - new Date(row.last_computed_at).getTime());
  const value = clamp(row.value - decayFor(elapsedMs));
  db.prepare(`UPDATE bar_stamina SET value = ?, last_computed_at = ? WHERE player_id = ?`).run(
    value,
    now.toISOString(),
    playerId,
  );
  return value;
}

/** The gap-aware hook — called once, from bar.ts's recordBarHeartbeat,
 * BEFORE that function overwrites bar_presence.last_seen_at with a new
 * value. Every bar-identity action already funnels through
 * recordBarHeartbeat (join, rejoin, heartbeat, move, sit, stand, say,
 * appearance, and the menu's own order/consume routes), so wiring this
 * in exactly once here covers every real path with no per-call-site
 * opt-in required — the same reasoning src/actionLog.ts's
 * installTransactionLogging already relies on for its own single choke
 * point.
 *
 * Reads the OLD last_seen_at (still in the database, not yet
 * overwritten) to tell a routine heartbeat (arriving well within
 * PRESENCE_STALE_MS of the last one — this identity was online the
 * whole time, charge decay normally) apart from a genuine reconnect
 * after a gap (the old last_seen_at is already stale relative to `now` —
 * this identity was offline for some unknown stretch in between, which
 * must cost nothing). In the gap case: decay is charged only up through
 * the last moment we actually know they were online (the stale
 * last_seen_at itself, not `now`), then last_computed_at is fast-
 * forwarded to `now` with no further charge for the gap — the new
 * online streak starts clean from this heartbeat. */
export function recordHeartbeat(db: Database.Database, playerId: string, now = new Date()): void {
  const presence = db.prepare(`SELECT last_seen_at FROM bar_presence WHERE player_id = ?`).get(playerId) as
    | { last_seen_at: string }
    | undefined;
  if (presence && !isConnected(presence.last_seen_at, now)) {
    recomputeStamina(db, playerId, new Date(presence.last_seen_at)); // charge only up to the last known-online instant
    db.prepare(`UPDATE bar_stamina SET last_computed_at = ? WHERE player_id = ?`).run(now.toISOString(), playerId); // skip the gap itself
  } else {
    recomputeStamina(db, playerId, now); // a routine heartbeat — continuously online since last_computed_at
  }
}

/** Restores `amount` on top of the freshly recomputed current value,
 * clamped to 100 — the only function in this module that ever increases
 * stamina. Calls recordHeartbeat first (rather than assuming continuity)
 * because consuming a held item is itself a fresh authenticated bar
 * action — this guarantees correctness even if no other heartbeat has
 * run since a reconnect, without requiring the order routes to remember
 * to call recordHeartbeat separately. The caller (src/orders.ts's
 * held-item consume) is responsible for its own exactly-once guard
 * before calling this — restoring is not itself idempotent, the same way
 * every other "apply exactly once" action in this codebase guards at its
 * own call site rather than inside the underlying pure mutation. */
export function restoreStamina(db: Database.Database, playerId: string, amount: number, now = new Date()): number {
  recordHeartbeat(db, playerId, now);
  const row = db.prepare(`SELECT value FROM bar_stamina WHERE player_id = ?`).get(playerId) as
    | { value: number }
    | undefined;
  const next = clamp((row?.value ?? STAMINA_INITIAL) + amount);
  db.prepare(`UPDATE bar_stamina SET value = ?, last_computed_at = ? WHERE player_id = ?`).run(
    next,
    now.toISOString(),
    playerId,
  );
  return next;
}

/** Read-only display value for a player already known to be online
 * (getPublicBarState only ever calls this for its own `online` filter's
 * results) — a plain continuation recompute is correct here precisely
 * because the identity is, by construction, connected right now, and the
 * gap (if any) was already closed at the most recent recordHeartbeat
 * call; advancing a few more seconds to the read time is a harmless,
 * correct true-up between heartbeats, not a second gap-detection path. */
export function currentStamina(db: Database.Database, playerId: string, now = new Date()): number {
  return recomputeStamina(db, playerId, now);
}
