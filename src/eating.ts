// Seated eating/drinking's own small, server-authoritative action
// lifecycle: start -> in progress -> complete. See CLAUDE.md's "Seated
// eating and drinking" section for the full product rule this exists to
// satisfy. Deliberately its own leaf module, like src/position.ts and
// src/stamina.ts — several higher modules (bar.ts, orders.ts, tables.ts,
// poker.ts) all need to check "is this identity currently mid an eating
// action" to gate their own actions (move, stand, order, join a game),
// and a leaf module with no dependency on any of them avoids a cycle
// between any pair.
//
// Completion is never a client "I'm done" callback — the user's own
// instruction: a server action's duration can't be trusted to the
// client, and completion must have a real recovery mechanism rather
// than depending on the client reliably sending an end request. Instead,
// exactly like bar_speech's own display window and table_departures' own
// three-minute clock, ends_at is an absolute server timestamp set once
// at start, and "still eating" is just `ends_at > now`, re-evaluated
// fresh on every single read with no sweep, no timer, and nothing that
// can "get stuck": a server restart, a dropped connection, or simply
// nobody ever asking again all still leave this fact correctly
// computable the next time anyone does ask.
//
// Stamina restoration and the held item(s) being flipped to "consumed"
// both happen atomically at the moment an eating action STARTS (inside
// the same transaction as the lock row below — see src/orders.ts's
// startEating), not at the end of the 8 seconds. This keeps the
// already-idempotent, already-tested consumeHeldItem machinery
// (src/orders.ts) completely unchanged in its own contract — exactly
// once per held item, nothing new to make safe across a restart — and
// means this module's own row only ever has to answer "is a movement/
// ordering/game-join lock currently active for this identity", never
// "is there a reward still owed." A lock that silently vanishes (a
// crash mid-animation) costs nothing beyond itself: the stamina/held-
// item state it was protecting already committed before the lock row
// did, in the same transaction — there is no "pending restore" anywhere
// in this design for a restart to lose.

import type Database from "better-sqlite3";

export type EatingKind = "meal" | "drink";

export const EATING_DURATION_MS = Number(process.env.EATING_DURATION_MS ?? 8000);

export interface EatingAction {
  kinds: readonly EatingKind[];
  startedAt: string;
  endsAt: string;
}

interface EatingRow {
  kinds: string;
  idempotency_key: string | null;
  started_at: string;
  ends_at: string;
}

function rawRow(db: Database.Database, playerId: string): EatingRow | undefined {
  return db
    .prepare(`SELECT kinds, idempotency_key, started_at, ends_at FROM bar_eating_actions WHERE player_id = ?`)
    .get(playerId) as EatingRow | undefined;
}

function toAction(row: EatingRow): EatingAction {
  return { kinds: JSON.parse(row.kinds), startedAt: row.started_at, endsAt: row.ends_at };
}

/** The row regardless of expiry, plus whether it's still active right
 * now — src/orders.ts's startEating needs the raw row (to compare an
 * idempotency key even after it's expired), while every gating check
 * below only needs the boolean. Exported so startEating can read it
 * without this module needing to know anything about OrderError. */
export function activeEatingRow(
  db: Database.Database,
  playerId: string,
  now = new Date(),
): { row: EatingRow; active: boolean } | null {
  const row = rawRow(db, playerId);
  if (!row) return null;
  return { row, active: new Date(row.ends_at).getTime() > now.getTime() };
}

/** Is this identity currently locked into an eating/drinking action? —
 * the one check every gating call site (bar.ts's move/stand,
 * orders.ts's placeOrder, tables.ts's create/join/start-npc, poker.ts's
 * ensureFree) shares, so none of them can drift into disagreeing about
 * what "still eating" means. */
export function isEating(db: Database.Database, playerId: string, now = new Date()): boolean {
  return activeEatingRow(db, playerId, now)?.active ?? false;
}

/** The current action for display — null once ends_at has passed, the
 * same lazy-expiry read every other grace period in this codebase
 * already uses (never deleted, just filtered out on read). Used both for
 * this identity's own authenticated view and (CLAUDE.md: "other players
 * can see holding/eating status") every bystander's public one. */
export function currentEatingAction(db: Database.Database, playerId: string, now = new Date()): EatingAction | null {
  const found = activeEatingRow(db, playerId, now);
  return found?.active ? toAction(found.row) : null;
}

/** Writes the lock row — called by src/orders.ts's startEating, inside
 * the same transaction that already consumed the held item(s) and
 * restored stamina. Never exported for any other call site to mutate;
 * every other module in this file only ever reads, for gating. */
export function writeEatingLock(
  db: Database.Database,
  playerId: string,
  kinds: readonly EatingKind[],
  idempotencyKey: string,
  now = new Date(),
): EatingAction {
  const startedAt = now.toISOString();
  const endsAt = new Date(now.getTime() + EATING_DURATION_MS).toISOString();
  db.prepare(
    `INSERT INTO bar_eating_actions (player_id, kinds, idempotency_key, started_at, ends_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET kinds = excluded.kinds, idempotency_key = excluded.idempotency_key, started_at = excluded.started_at, ends_at = excluded.ends_at`,
  ).run(playerId, JSON.stringify(kinds), idempotencyKey, startedAt, endsAt);
  return { kinds, startedAt, endsAt };
}
