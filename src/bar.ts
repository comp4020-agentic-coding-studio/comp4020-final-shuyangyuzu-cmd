// The bar: a separate identity layer from a game room's (CLAUDE.md) —
// its own tables, its own session secrets, its own presence. Phase 1
// scope only: join/rejoin, heartbeat, grid-tile movement (server-
// validated against src/barLayout.ts), and a public snapshot for
// rendering. Table click-to-join/create (Phase 2), ordering (Phase 3),
// and seating (Phase 4) are deliberately not here yet.

import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { logAction, markIdentityVerified, transact } from "./actionLog.ts";
import { BAR_SEATS, defaultSpawn, FURNITURE, GRID_COLS, GRID_ROWS, isValidStep, isWalkingFloor } from "./barLayout.ts";
import { isConnected } from "./presence.ts";
import { effectivePosition } from "./position.ts";
import { currentStamina, initStamina, recordHeartbeat as recordStaminaHeartbeat } from "./stamina.ts";

// A separate, larger palette from the Vegas table's 4 (PLAN.md decision:
// the bar isn't capped at 4 patrons). Keep in sync with public/app.js's
// BAR_COLORS — there's no shared module between server and this plain-JS
// client to enforce that automatically, so spec/bar.test.ts exercises
// every one of these against the real endpoint to catch drift.
export const BAR_COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"] as const;
export type BarColor = (typeof BAR_COLORS)[number];

// Separate presence storage from the game-room `presence` table on
// purpose: that table's room_id column has a real foreign key into
// `rooms`, so a bar identity (which isn't a room player) can't share it
// without either violating that constraint or weakening it for
// everyone. `isConnected` (the pure time-comparison) is still reused —
// it has no table coupling at all.

function recordBarHeartbeat(db: Database.Database, playerId: string, now = new Date()): void {
  // Stamina's own gap-detection reads the OLD last_seen_at, so it must
  // run before this INSERT/UPDATE overwrites it (src/stamina.ts's
  // recordHeartbeat doc comment explains why this can't be a lazy read
  // done later) — this function is the one choke point every bar-
  // identity action already funnels through (join, rejoin, heartbeat,
  // move, sit, stand, say, appearance, and the menu routes), so wiring
  // it in exactly once here covers every real path with no per-call-site
  // opt-in required.
  recordStaminaHeartbeat(db, playerId, now);
  db.prepare(
    `INSERT INTO bar_presence (player_id, last_seen_at) VALUES (?, ?)
     ON CONFLICT(player_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(playerId, now.toISOString());
}

function barLastSeenTimes(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`SELECT player_id, last_seen_at FROM bar_presence`).all() as Array<{
    player_id: string;
    last_seen_at: string;
  }>;
  return new Map(rows.map((r) => [r.player_id, r.last_seen_at]));
}

// ---- Tile occupancy (product-direction-update: "avoid two characters on
// the same tile") ----
//
// "Occupied" means one specific thing everywhere in this file: some
// *other*, *currently connected* bar identity's effective position
// (src/position.ts — a game-table occupant's real chair tile, not their
// frozen pre-game coordinate) is exactly this tile. A disconnected
// patron's old tile is never a permanent obstacle — it simply stops
// counting the moment their heartbeat goes stale past the same
// PRESENCE_STALE_MS threshold the bar's own "who's online" list already
// uses (src/presence.ts's isConnected), with no second, bar-specific
// definition of "gone" to keep in sync with that one. This is also what
// keeps a returning identity's own recovery unbroken: reconnecting never
// fails because "your own tile is yours" — see isTileOccupiedByOther's
// `excludePlayerId` and rejoinBar's repair step below.
function isTileOccupiedByOther(
  db: Database.Database,
  x: number,
  y: number,
  excludePlayerId: string,
  now = new Date(),
): boolean {
  // Checked against each online patron's *effective* position
  // (src/position.ts), not a direct SQL match on stored x/y — a game-
  // table occupant's real chair tile is what blocks, not their frozen
  // pre-game coordinate (CLAUDE.md). Online patron counts are small
  // enough at this app's scale that a per-row lookup here is cheap; a
  // SQL-only equality check can't express "effective position" at all,
  // since that's resolved through the game room's own state, not a
  // column on this table.
  const rows = db
    .prepare(
      `SELECT bp.id as id, pr.last_seen_at as lastSeen
       FROM bar_players bp JOIN bar_presence pr ON pr.player_id = bp.id
       WHERE bp.id != ?`,
    )
    .all(excludePlayerId) as Array<{ id: string; lastSeen: string }>;
  for (const r of rows) {
    if (!isConnected(r.lastSeen, now)) continue;
    const pos = effectivePosition(db, r.id);
    if (pos && pos.x === x && pos.y === y) return true;
  }
  return false;
}

/** A free, walkable tile at or near `near` — used for a brand-new join's
 * spawn point, and to repair a reconnecting or just-migrated identity
 * whose stored tile is no longer walkable or has since been legitimately
 * claimed by someone else while this identity was away. Expanding
 * outward ring by ring from `near` keeps the result close to where the
 * caller actually wanted to land, rather than jumping to an arbitrary
 * free tile anywhere on the map. Always terminates: the grid is finite,
 * and realistic patron counts never come close to filling it — the
 * degenerate "searched everywhere, found nothing" case falls back to
 * `near` itself rather than throwing, which is never reached in practice
 * but keeps the function total. */
export function findFreeTile(
  db: Database.Database,
  near: { x: number; y: number },
  excludePlayerId: string,
  now = new Date(),
): { x: number; y: number } {
  const free = (x: number, y: number) => isWalkingFloor(x, y) && !isTileOccupiedByOther(db, x, y, excludePlayerId, now);
  if (free(near.x, near.y)) return near;
  const maxRadius = GRID_COLS + GRID_ROWS;
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only, inner tiles already checked
        const x = near.x + dx;
        const y = near.y + dy;
        if (free(x, y)) return { x, y };
      }
    }
  }
  return near;
}

export class BarError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function newSessionSecret(): string {
  return randomBytes(24).toString("base64url");
}

export interface JoinedBar {
  playerId: string;
  sessionSecret: string;
  x: number;
  y: number;
}

export const BAR_SKINS = ["fair", "warm", "tan", "brown", "deep"] as const;
export function joinBar(db: Database.Database, nickname: string, color: BarColor, skin = "warm"): JoinedBar {
  const trimmed = nickname.trim();
  if (!trimmed) throw new BarError("nickname is required", "nickname_required", 400);
  if (!BAR_COLORS.includes(color)) throw new BarError("not a valid color", "bad_color", 400);
  if (!BAR_SKINS.includes(skin as typeof BAR_SKINS[number])) throw new BarError("not a valid skin tone", "bad_skin", 400);

  const id = randomUUID();
  const sessionSecret = newSessionSecret();
  const now = new Date().toISOString();

  const { x, y } = transact(db, () => {
    // Found inside the same transaction as the INSERT — two joins
    // landing in the same synchronous transaction callback can never
    // interleave (one Node process, one connection, better-sqlite3's
    // transactions are synchronous), so two patrons joining at once
    // always get two different tiles, never a race where both compute
    // the same "free" tile before either is actually seated there. A
    // brand-new identity never appears in bar_presence yet, so it can
    // never exclude itself from its own search — "" never matches a real
    // bar_players.id, which is always a UUID.
    //
    // A small random jitter around the canonical spawn point — rather
    // than always spiralling outward from the exact same fixed tile —
    // keeps a burst of simultaneous joins from packing into one
    // ever-tightening ring around a single point; each lands "near"
    // spawn, not stacked shoulder-to-shoulder against whoever joined a
    // moment earlier.
    const spawn = defaultSpawn();
    const jitter = { x: spawn.x + Math.floor(Math.random() * 5) - 2, y: spawn.y + Math.floor(Math.random() * 5) - 2 };
    const { x, y } = findFreeTile(db, jitter, "", new Date(now));
    db.prepare(
      `INSERT INTO bar_players (id, nickname, color, skin, x, y, current_table_id, current_seat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(id, trimmed, color, skin, x, y, now);
    db.prepare(`INSERT INTO bar_sessions (player_id, session_secret) VALUES (?, ?)`).run(id, sessionSecret);
    recordBarHeartbeat(db, id, new Date(now));
    initStamina(db, id, new Date(now));
    logAction(db, {
      action: "join_bar",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id, nickname: trimmed },
      detail: { color, skin },
    });
    return { x, y };
  });

  return { playerId: id, sessionSecret, x, y };
}

// Exported for src/tables.ts — table creation/joining acts on behalf of
// a bar identity, so it needs the same proof-of-identity check every
// other bar action already uses, not a copy of it.
export function requireBarSession(db: Database.Database, playerId: string, sessionSecret: string): void {
  const row = db.prepare(`SELECT session_secret FROM bar_sessions WHERE player_id = ?`).get(playerId) as
    | { session_secret: string }
    | undefined;
  if (!row || row.session_secret !== sessionSecret) {
    throw new BarError("not authorized for this bar identity", "unauthorized", 403);
  }
  // Real proof, recorded the instant the check actually passes — see
  // src/actionLog.ts's own header and src/rooms.ts's requireSession for
  // why this can't be inferred afterward from an error's own code.
  markIdentityVerified();
}

/** Re-authenticates and refreshes this identity's own heartbeat — and,
 * because a tile that was legitimately free while this identity was
 * disconnected may since have been claimed by someone else (a stale
 * patron is never a permanent obstacle — isTileOccupiedByOther above),
 * repairs a now-invalid stored position before it's ever reported back
 * to this returning identity. This is "占位释放规则...不能破坏身份恢复"
 * made concrete: recovery itself can never fail or collide just because
 * someone else validly moved into this identity's old spot while it was
 * away. A no-op in the overwhelmingly common case (nobody took it). */
export function rejoinBar(db: Database.Database, playerId: string, sessionSecret: string): void {
  requireBarSession(db, playerId, sessionSecret);
  transact(db, () => {
    const row = db.prepare(`SELECT x, y, nickname FROM bar_players WHERE id = ?`).get(playerId) as
      | { x: number; y: number; nickname: string }
      | undefined;
    if (row) {
      const now = new Date();
      const seated = db.prepare(`SELECT 1 FROM bar_seats WHERE occupied_by = ? AND x = ? AND y = ?`).get(playerId, row.x, row.y);
      if ((!seated && !isWalkingFloor(row.x, row.y)) || isTileOccupiedByOther(db, row.x, row.y, playerId, now)) {
        const free = findFreeTile(db, row, playerId, now);
        db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(free.x, free.y, playerId);
      }
    }
    recordBarHeartbeat(db, playerId);
    logAction(db, {
      action: "rejoin_bar",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: playerId, nickname: row?.nickname },
    });
  });
}

export function updateAppearance(db: Database.Database, playerId: string, sessionSecret: string, nickname: string, color: BarColor, skin: string): void {
  requireBarSession(db, playerId, sessionSecret);
  if (!nickname.trim() || nickname.trim().length > 20) throw new BarError("nickname must be 1–20 characters", "nickname_required", 400);
  if (!BAR_COLORS.includes(color)) throw new BarError("not a valid color", "bad_color", 400);
  if (!BAR_SKINS.includes(skin as typeof BAR_SKINS[number])) throw new BarError("not a valid skin tone", "bad_skin", 400);
  db.prepare("UPDATE bar_players SET nickname = ?, color = ?, skin = ? WHERE id = ?").run(nickname.trim(), color, skin, playerId);
  recordBarHeartbeat(db, playerId);
  logAction(db, {
    action: "update_appearance",
    outcome: "ok",
    verified: true,
    actor: { kind: "bar", id: playerId, nickname: nickname.trim() },
    detail: { color, skin },
  });
}

export function barHeartbeat(db: Database.Database, playerId: string, sessionSecret: string): void {
  requireBarSession(db, playerId, sessionSecret);
  recordBarHeartbeat(db, playerId);
}

// A bar move fires on every single tile step — logging every one of them
// would flood `flyctl logs` and actively hurt the crit's own "narrate from
// logs" readability (a constant stream of "moved to (12,7)" lines, where
// the useful signal is "they're here and active," not the exact path
// taken). A move is logged only once per BAR_MOVE_LOG_WINDOW_MS per
// player — same env-overridable-threshold pattern as every other
// time-based constant in this codebase (src/presence.ts,
// SPEECH_DISPLAY_MS above), and the same in-memory per-player map shape
// `speechTimestamps` below already uses for its own rate limit.
const BAR_MOVE_LOG_WINDOW_MS = Number(process.env.BAR_MOVE_LOG_WINDOW_MS ?? 3000);
const lastLoggedMoveAt = new Map<string, number>();

export function moveBar(db: Database.Database, playerId: string, sessionSecret: string, x: number, y: number): void {
  requireBarSession(db, playerId, sessionSecret);
  if(db.prepare('SELECT 1 FROM poker_members WHERE bar_id=? AND active=1').get(playerId))throw new BarError('Leave your poker table before walking in the bar','already_seated',409);

  const nickname = db.prepare(`SELECT nickname FROM bar_players WHERE id = ?`).get(playerId) as
    | { nickname: string }
    | undefined;

  transact(db, () => {
    const row = db.prepare(`SELECT x, y FROM bar_players WHERE id = ?`).get(playerId) as
      | { x: number; y: number }
      | undefined;
    if (!row) throw new BarError("no such bar identity", "player_not_found", 404);
    if (!isValidStep(row.x, row.y, x, y)) {
      throw new BarError("not a valid move from your current tile", "invalid_move", 409);
    }
    // Checked and written inside this one synchronous transaction, the
    // same reason joinBar's own spawn search is race-free: two patrons
    // stepping onto the same tile at once can never both see it as free,
    // because nothing else can run between this check and the write
    // below (CLAUDE.md's idempotency section — this is that same
    // optimistic-concurrency principle, just a direct atomic check
    // rather than a version column, since a single UPDATE here needs no
    // separate "did someone else already write" re-check after the fact).
    if (isTileOccupiedByOther(db, x, y, playerId)) {
      throw new BarError("someone is already standing there", "tile_occupied", 409);
    }
    db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(x, y, playerId);
    // Moving away is an implicit stand-up — a seat's occupancy must never
    // outlive the patron actually being on that tile (PLAN.md Phase 2:
    // "standing up and moving must not trap the character inside
    // furniture," and more basically, a chair can't show "occupied" once
    // its occupant has visibly walked off).
    db.prepare(`UPDATE bar_seats SET occupied_by = NULL WHERE occupied_by = ?`).run(playerId);

    const now = Date.now();
    const last = lastLoggedMoveAt.get(playerId);
    if (last === undefined || now - last >= BAR_MOVE_LOG_WINDOW_MS) {
      lastLoggedMoveAt.set(playerId, now);
      logAction(db, {
        action: "move",
        outcome: "ok",
        verified: true,
        actor: { kind: "bar", id: playerId, nickname: nickname?.nickname },
        detail: { x, y },
      });
    }
  });
  recordBarHeartbeat(db, playerId);
}

export interface PublicSeat {
  id: string;
  furnitureId: string;
  x: number;
  y: number;
}

/** Every real seat's static layout — fetched once by the client via
 * GET /api/bar/layout, same as FURNITURE already is. Live occupancy is
 * read from each PublicBarPlayer's own `seatId` in the streamed bar
 * state, not duplicated here. */
export function getSeatLayout(): PublicSeat[] {
  return BAR_SEATS.map((s) => ({ id: s.id, furnitureId: s.furnitureId, x: s.x, y: s.y }));
}

/** Sitting moves a patron from adjacent floor into the chair atomically.
 * Chairs are not walking shortcuts. Existing seated coordinates remain
 * accepted for idempotent re-clicks and legacy positions. One real seat
 * at a time per patron; sitting back down in the same seat you're
 * already in is a harmless no-op, not an error (re-clicking your own
 * chair shouldn't surface a confusing refusal). */
export function sitAtSeat(db: Database.Database, playerId: string, sessionSecret: string, seatId: string): void {
  requireBarSession(db, playerId, sessionSecret);
  if(db.prepare('SELECT 1 FROM poker_members WHERE bar_id=? AND active=1').get(playerId))throw new BarError('Leave your poker table before sitting elsewhere','already_seated',409);
  const seat = BAR_SEATS.find((s) => s.id === seatId);
  if (!seat) throw new BarError("no such seat", "seat_not_found", 404);

  transact(db, () => {
    const player = db.prepare(`SELECT x, y, nickname, current_table_id FROM bar_players WHERE id = ?`).get(playerId) as
      | { x: number; y: number; nickname: string; current_table_id: string | null }
      | undefined;
    if (!player) throw new BarError("no such bar identity", "player_not_found", 404);
    if (Math.abs(player.x - seat.x) + Math.abs(player.y - seat.y) > 1) {
      throw new BarError("walk beside the seat before sitting down", "not_at_seat", 409);
    }

    const mine = db.prepare(`SELECT id FROM bar_seats WHERE occupied_by = ?`).get(playerId) as
      | { id: string }
      | undefined;
    if (mine) {
      if (mine.id === seatId) return; // already sitting here — a harmless no-op, nothing new to log
      throw new BarError("stand up from your current seat first", "already_seated_elsewhere", 409);
    }

    const row = db.prepare(`SELECT occupied_by FROM bar_seats WHERE id = ?`).get(seatId) as
      | { occupied_by: string | null }
      | undefined;
    if (!row) throw new BarError("no such seat", "seat_not_found", 404);
    if (row.occupied_by) throw new BarError("someone is already sitting there", "seat_taken", 409);
    if (isTileOccupiedByOther(db, seat.x, seat.y, playerId)) throw new BarError("someone is already there", "seat_taken", 409);

    db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(seat.x, seat.y, playerId);
    db.prepare(`UPDATE bar_seats SET occupied_by = ? WHERE id = ?`).run(playerId, seatId);

    // Sitting at a real seat while bound to a game table means stepping
    // away from it, physically — starts (or refreshes) the 3-minute
    // away-from-table clock (CLAUDE.md's leave/exit states). Standing
    // back up from this seat does NOT clear the clock on its own — only
    // actually re-engaging with the game (a heartbeat/rejoin/action
    // there) does, so briefly sitting down somewhere else and standing
    // right back up can't be used to silently reset a departure that's
    // already ticking.
    if (player.current_table_id) {
      db.prepare(
        `INSERT INTO table_departures (bar_player_id, table_id, left_at) VALUES (?, ?, ?)
         ON CONFLICT(bar_player_id) DO NOTHING`,
      ).run(playerId, player.current_table_id, new Date().toISOString());
    }
    logAction(db, {
      action: "sit",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: playerId, nickname: player.nickname },
      detail: { seatId },
    });
  });
  recordBarHeartbeat(db, playerId);
}

/** Idempotent: standing when not seated anywhere is a harmless no-op. */
export function standFromSeat(db: Database.Database, playerId: string, sessionSecret: string): void {
  requireBarSession(db, playerId, sessionSecret);
  transact(db, () => {
    const seat = db.prepare(`SELECT x, y FROM bar_seats WHERE occupied_by = ?`).get(playerId) as { x: number; y: number } | undefined;
    if (seat) {
      const exit = [[0, 1], [-1, 0], [1, 0], [0, -1]].map(([dx, dy]) => ({ x: seat.x + dx, y: seat.y + dy }))
        .find((p) => isWalkingFloor(p.x, p.y) && !isTileOccupiedByOther(db, p.x, p.y, playerId));
      if (!exit) throw new BarError("the space beside this chair is occupied", "seat_exit_blocked", 409);
      db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(exit.x, exit.y, playerId);
    }
    const row = db.prepare(`SELECT nickname FROM bar_players WHERE id = ?`).get(playerId) as
      | { nickname: string }
      | undefined;
    const result = db.prepare(`UPDATE bar_seats SET occupied_by = NULL WHERE occupied_by = ?`).run(playerId);
    if (result.changes > 0) {
      logAction(db, {
        action: "stand",
        outcome: "ok",
        verified: true,
        actor: { kind: "bar", id: playerId, nickname: row?.nickname },
      });
    }
  });
  recordBarHeartbeat(db, playerId);
}

// ---- Public tavern speech (product-direction-update, part 3's
// replacement for private 1:1 chat, after the student's own acceptance
// testing — CLAUDE.md's "Public tavern speech" section has the full
// design) ----

const SPEECH_MAX_LENGTH = 500;
const SPEECH_DISPLAY_MS = Number(process.env.SPEECH_DISPLAY_MS ?? 8000);
// Same in-memory sliding-window shape as src/chat.ts's own limiter —
// not shared code, since this is a different action with its own
// threshold, but the same reasoning (cheap at this app's scale,
// env-overridable so a test can trip it without a production-sized
// burst).
const SPEECH_RATE_LIMIT_COUNT = Number(process.env.SPEECH_RATE_LIMIT_COUNT ?? 5);
const SPEECH_RATE_LIMIT_WINDOW_MS = Number(process.env.SPEECH_RATE_LIMIT_WINDOW_MS ?? 10000);
const speechTimestamps = new Map<string, number[]>();

function checkSpeechRateLimit(playerId: string, now: number): void {
  const recent = (speechTimestamps.get(playerId) ?? []).filter((t) => now - t < SPEECH_RATE_LIMIT_WINDOW_MS);
  if (recent.length >= SPEECH_RATE_LIMIT_COUNT) {
    throw new BarError("sending too fast — wait a moment", "rate_limited", 429);
  }
  recent.push(now);
  speechTimestamps.set(playerId, recent);
}

/** Says something publicly — everyone watching the bar sees it as a
 * bubble over this patron's head (reported via the ordinary
 * `getPublicBarState`/bar SSE channel, no separate transport). Identity
 * and nickname are the server's own (`requireBarSession`), never a
 * client-supplied value. `clientMsgId` is the idempotency key: a retried
 * send with the same id is a silent no-op — it must NOT restart the
 * 8-second display clock, the one thing that actually distinguishes a
 * genuine resend-with-a-fresh-utterance (which *does* replace the bubble
 * and restart the clock, by product decision) from a network retry of
 * the exact same one. */
export function say(db: Database.Database, playerId: string, sessionSecret: string, clientMsgId: string, text: string): void {
  requireBarSession(db, playerId, sessionSecret);
  if (typeof clientMsgId !== "string" || !clientMsgId) {
    throw new BarError("missing client message id", "bad_request", 400);
  }
  const trimmed = (text ?? "").toString().trim();
  if (!trimmed) throw new BarError("message can't be empty", "empty_message", 400);
  if (trimmed.length > SPEECH_MAX_LENGTH) {
    throw new BarError(`message must be at most ${SPEECH_MAX_LENGTH} characters`, "too_long", 400);
  }

  transact(db, () => {
    const player = db.prepare(`SELECT nickname FROM bar_players WHERE id = ?`).get(playerId) as
      | { nickname: string }
      | undefined;
    const existing = db.prepare(`SELECT client_msg_id FROM bar_speech WHERE player_id = ?`).get(playerId) as
      | { client_msg_id: string }
      | undefined;
    if (existing?.client_msg_id === clientMsgId) return; // a retry of the bubble already showing — no-op, no re-timing

    checkSpeechRateLimit(playerId, Date.now());
    const expiresAt = new Date(Date.now() + SPEECH_DISPLAY_MS).toISOString();
    db.prepare(
      `INSERT INTO bar_speech (player_id, text, client_msg_id, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET text = excluded.text, client_msg_id = excluded.client_msg_id, expires_at = excluded.expires_at`,
    ).run(playerId, trimmed, clientMsgId, expiresAt);
    // Logs the sender, message id, and length only — never the text
    // itself (the spec's own constraint: a speech action's log entry
    // doesn't need the body to be useful for narration, and logging
    // public chat content verbatim is unnecessary exposure this file
    // doesn't need to take on). Only reached on a genuinely new
    // utterance — the idempotent no-op above returns before this,
    // so a retried send with the same clientMsgId never produces a
    // second "ok" line for what is, from the operator's perspective,
    // one single action.
    logAction(db, {
      action: "say",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: playerId, nickname: player?.nickname },
      detail: { clientMsgId, length: trimmed.length },
    });
  });
  recordBarHeartbeat(db, playerId);
}

export interface PublicBarPlayer {
  id: string;
  nickname: string;
  color: string;
  skin: string;
  x: number;
  y: number;
  /** The real seat (dining/stool) this patron currently occupies, if
   * any — null otherwise. A game table's own chairs are never reported
   * here (src/tables.ts's getTablesStatus reports those, from the bound
   * room's own player roster, since that's a different occupancy
   * concept entirely — PLAN.md's product-direction-update entry). */
  seatId: string | null;
  /** This patron's current speech bubble text, or null if they have none
   * active right now — computed fresh on every read by comparing
   * `bar_speech.expires_at` against "now" (the same lazy-evaluation
   * principle as the lobby disconnect grace: no sweep, no timer, just
   * "is this still true as of this exact read"). Never the absolute
   * expiry itself: the client doesn't run its own countdown, it just
   * draws whatever's here and stops the moment a fresh snapshot omits it
   * (CLAUDE.md's "Public tavern speech" section). */
  speech: string | null;
  /** Server-computed, read-only (CLAUDE.md's "Stamina" section) — never
   * settable through this or any other request body; only src/orders.ts's
   * consume action and src/stamina.ts's own decay math ever change the
   * underlying value. Reported for every online player the same way
   * position/seatId already are, even though the client only ever
   * renders the viewer's own value. */
  stamina: number;
}

export interface PublicGameTable {
  id: string;
  gameType: string;
  available: boolean;
  x: number;
  y: number;
  label: string;
  /** Phase 1: always "not_wired" for the 3 Vegas tables (status/joining
   * lands in Phase 2) and "reserved" for Texas/dominoes/blackjack. */
  status: "not_wired" | "reserved";
}

export interface PublicBarState {
  players: PublicBarPlayer[];
}

/** Online patrons only — a stale heartbeat removes the avatar from view
 * without touching the bar_players row itself (identity, table
 * membership, and any order survive; "离线后移除在线角色,但保留身份、
 * 订单和游戏进度" per PLAN.md). Nothing is deleted here, ever. */
export function getPublicBarState(db: Database.Database): PublicBarState {
  const rows = db.prepare(`SELECT id, nickname, color, skin, x, y FROM bar_players`).all() as Array<{
    id: string;
    nickname: string;
    color: string;
    skin: string;
    x: number;
    y: number;
  }>;
  const now = new Date();
  const seen = barLastSeenTimes(db);
  const online = rows.filter((p) => {
    const lastSeen = seen.get(p.id);
    return lastSeen !== undefined && isConnected(lastSeen, now);
  });
  const seatedBy = new Map(
    (db.prepare(`SELECT id, occupied_by FROM bar_seats WHERE occupied_by IS NOT NULL`).all() as Array<{
      id: string;
      occupied_by: string;
    }>).map((s) => [s.occupied_by, s.id]),
  );
  const nowIso = now.toISOString();
  const speechBy = new Map(
    (db.prepare(`SELECT player_id, text FROM bar_speech WHERE expires_at > ?`).all(nowIso) as Array<{
      player_id: string;
      text: string;
    }>).map((s) => [s.player_id, s.text]),
  );
  return {
    players: online.map((p) => {
      // A present game-table occupant is reported at their real chair
      // tile, never their frozen pre-game coordinate (src/position.ts) —
      // this is what makes another patron's pathfinding/click-targeting
      // agree with what's actually drawn at the chair, rather than an
      // invisible stale position nobody can see or reach (CLAUDE.md).
      const pos = effectivePosition(db, p.id) ?? { x: p.x, y: p.y };
      return {
        id: p.id,
        nickname: p.nickname,
        color: p.color,
        skin: p.skin,
        x: pos.x,
        y: pos.y,
        seatId: seatedBy.get(p.id) ?? null,
        speech: speechBy.get(p.id) ?? null,
        stamina: currentStamina(db, p.id, now),
      };
    }),
  };
}

/** Static furniture, including the 6 game-table slots — fetched once by
 * the client, not polled (it never changes at runtime). Phase 1 doesn't
 * wire table status to a real room yet, so every Vegas table reports
 * "not_wired" rather than a real empty/waiting/in-game status — that's
 * Phase 2's job (see PLAN.md's phase breakdown). */
export function getGameTables(): PublicGameTable[] {
  return FURNITURE.filter((f) => f.kind === "game_table").map((f) => ({
    id: f.id,
    gameType: f.gameType!,
    available: f.available!,
    x: f.x,
    y: f.y,
    label: f.label,
    status: f.available ? "not_wired" : "reserved",
  }));
}
