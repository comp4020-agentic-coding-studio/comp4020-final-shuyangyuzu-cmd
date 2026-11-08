// Product-direction-update, part 2: no two bar identities may occupy the
// same tile. Tested directly against hand-built databases (like
// spec/tableExpiry.test.ts) rather than over HTTP, since several of
// these need to control exactly who's "connected" without waiting out
// PRESENCE_STALE_MS for real.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BarError, findFreeTile, joinBar, moveBar, rejoinBar } from "../src/bar.ts";
import { defaultSpawn, isWalkable } from "../src/barLayout.ts";
import { openDb } from "../src/db.ts";
import { effectivePosition } from "../src/position.ts";
import { createTableRoom, getTablesStatus } from "../src/tables.ts";
import { openBlackjack, setBlackjackAway } from "../src/blackjack.ts";
import { openDomino, setDominoAway } from "../src/domino.ts";
import { openPoker, setPokerAway } from "../src/poker.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-occupancy-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function longAgo(): string {
  return new Date(Date.now() - 999_999_999).toISOString();
}

it("a move onto a tile occupied by another currently-connected patron is refused", () => {
  const a = joinBar(db, "A", "red");
  const spawn = defaultSpawn();
  const b = joinBar(db, "B", "blue");
  // Force A onto the spawn tile and B directly adjacent, for a
  // deterministic test regardless of where joinBar's own spawn search
  // happened to land each of them.
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(spawn.x, spawn.y, a.playerId);
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(spawn.x + 1, spawn.y, b.playerId);

  let caught: unknown;
  try {
    moveBar(db, b.playerId, b.sessionSecret, spawn.x, spawn.y);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BarError);
  expect((caught as BarError).code).toBe("tile_occupied");
});

it("a move onto a tile vacated by a now-disconnected patron succeeds", () => {
  const a = joinBar(db, "A", "red");
  const spawn = defaultSpawn();
  const b = joinBar(db, "B", "blue");
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(spawn.x + 1, spawn.y, b.playerId);
  db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(longAgo(), a.playerId);

  expect(() => moveBar(db, b.playerId, b.sessionSecret, spawn.x, spawn.y)).not.toThrow();
});

it("joining the bar twice in a row lands two patrons on two different tiles, even though both aim for the same default spawn", () => {
  const a = joinBar(db, "A", "red");
  const b = joinBar(db, "B", "blue");
  expect(`${a.x},${a.y}`).not.toBe(`${b.x},${b.y}`);
  expect(isWalkable(a.x, a.y)).toBe(true);
  expect(isWalkable(b.x, b.y)).toBe(true);
});

it("findFreeTile never returns a tile occupied by a connected patron, searching outward from the requested point", () => {
  const spawn = defaultSpawn();
  const a = joinBar(db, "A", "red");
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(spawn.x, spawn.y, a.playerId);
  const free = findFreeTile(db, spawn, "someone-else");
  expect(`${free.x},${free.y}`).not.toBe(`${spawn.x},${spawn.y}`);
  expect(isWalkable(free.x, free.y)).toBe(true);
});

it("rejoin relocates a patron whose old tile was legitimately claimed by someone else while they were away, without failing recovery", () => {
  const a = joinBar(db, "A", "red");
  const spawn = { x: a.x, y: a.y };
  // A goes stale, then B validly takes A's old spot (A no longer counts
  // as "there" once disconnected).
  db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(longAgo(), a.playerId);
  const b = joinBar(db, "B", "blue");
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(spawn.x, spawn.y, b.playerId);

  // A reconnects — must not error, and must not end up stacked on B.
  expect(() => rejoinBar(db, a.playerId, a.sessionSecret)).not.toThrow();
  const after = db.prepare(`SELECT x, y FROM bar_players WHERE id = ?`).get(a.playerId) as { x: number; y: number };
  expect(`${after.x},${after.y}`).not.toBe(`${spawn.x},${spawn.y}`);
  expect(isWalkable(after.x, after.y)).toBe(true);
});

it("rejoin leaves an identity's own tile alone when nobody else has claimed it", () => {
  const a = joinBar(db, "A", "red");
  rejoinBar(db, a.playerId, a.sessionSecret);
  const after = db.prepare(`SELECT x, y FROM bar_players WHERE id = ?`).get(a.playerId) as { x: number; y: number };
  expect(after).toEqual({ x: a.x, y: a.y });
});

it("effectivePosition reports a present game-table occupant's real chair tile, not their frozen pre-game bar coordinate", () => {
  const a = joinBar(db, "A", "red");
  const beforeGame = effectivePosition(db, a.playerId);
  expect(beforeGame).toEqual({ x: a.x, y: a.y });

  createTableRoom(db, "vegas-1", a.playerId, a.sessionSecret, "red");
  // Present (controller human, connected via the fresh joinedAt fallback,
  // no departure recorded) the moment they're seated — even in the
  // lobby, before the game starts, since GAME_CHAIRS are fixed physical
  // chairs independent of phase.
  const afterJoin = effectivePosition(db, a.playerId);
  expect(afterJoin).not.toEqual({ x: a.x, y: a.y });
});

it("effectivePosition falls back to the raw bar coordinate for a departed (away) game-table occupant", () => {
  const a = joinBar(db, "A", "red");
  createTableRoom(db, "vegas-1", a.playerId, a.sessionSecret, "red");
  db.prepare(
    `INSERT INTO table_departures (bar_player_id, table_id, left_at) VALUES (?, 'vegas-1', ?)`,
  ).run(a.playerId, new Date().toISOString());
  const pos = effectivePosition(db, a.playerId);
  expect(pos).toEqual({ x: a.x, y: a.y });
});

// 2026-11-08 acceptance fix: marking yourself "away" at Blackjack,
// Dominoes or Poker previously left `effectivePosition` still reporting
// the real chair tile (the query only ever checked `active=1`, and an
// away row is still active=1) — so a player who clicked "I'm away" and
// then "Back to the bar" remained rendered seated at the game chair
// forever instead of standing up and appearing at their own real,
// walkable bar tile, exactly the "明确提示现有暂离规则，不要误导" gap the
// user's own manual review found. Each of these three mirrors the
// existing Vegas `departed` test immediately above, for the three games
// that previously had no equivalent check at all.
it("effectivePosition falls back to the raw bar coordinate for an away Blackjack occupant", () => {
  const a = joinBar(db, "A", "red");
  openBlackjack(db, a.playerId, a.sessionSecret, 0);
  expect(effectivePosition(db, a.playerId)).not.toEqual({ x: a.x, y: a.y });
  setBlackjackAway(db, a.playerId, a.sessionSecret, true);
  expect(effectivePosition(db, a.playerId)).toEqual({ x: a.x, y: a.y });
  // Clearing away restores the chair position — the player isn't stuck
  // standing even though their seat/membership row was never released.
  setBlackjackAway(db, a.playerId, a.sessionSecret, false);
  expect(effectivePosition(db, a.playerId)).not.toEqual({ x: a.x, y: a.y });
});

it("effectivePosition falls back to the raw bar coordinate for an away Dominoes occupant", () => {
  const a = joinBar(db, "A", "red");
  openDomino(db, a.playerId, a.sessionSecret, "online", 0);
  expect(effectivePosition(db, a.playerId)).not.toEqual({ x: a.x, y: a.y });
  setDominoAway(db, a.playerId, a.sessionSecret, true);
  expect(effectivePosition(db, a.playerId)).toEqual({ x: a.x, y: a.y });
  setDominoAway(db, a.playerId, a.sessionSecret, false);
  expect(effectivePosition(db, a.playerId)).not.toEqual({ x: a.x, y: a.y });
});

it("effectivePosition falls back to the raw bar coordinate for an away Poker occupant", () => {
  const a = joinBar(db, "A", "red");
  openPoker(db, a.playerId, a.sessionSecret, "online");
  expect(effectivePosition(db, a.playerId)).not.toEqual({ x: a.x, y: a.y });
  setPokerAway(db, a.playerId, a.sessionSecret, true);
  expect(effectivePosition(db, a.playerId)).toEqual({ x: a.x, y: a.y });
  setPokerAway(db, a.playerId, a.sessionSecret, false);
  expect(effectivePosition(db, a.playerId)).not.toEqual({ x: a.x, y: a.y });
});

// The same fix, confirmed from the bar's own public-facing read path
// (src/tables.ts's getTablesStatus, which public/tavern.js's seated-
// figure rendering and "· away" nickname-tag suffix both depend on) —
// not just the lower-level effectivePosition function in isolation.
// Before this fix, `present` for these three games never considered
// `away` at all, so a bystander's own screen kept drawing an away
// player's sprite seated at the chair with no "away" label, identical to
// an actively-playing occupant.
it("getTablesStatus reports an away Blackjack/Dominoes/Poker occupant as not present, for the bar's own seated-figure rendering", () => {
  const a = joinBar(db, "A", "red"), b = joinBar(db, "B", "blue"), c = joinBar(db, "C", "green");
  openBlackjack(db, a.playerId, a.sessionSecret, 0);
  openDomino(db, b.playerId, b.sessionSecret, "online", 0);
  openPoker(db, c.playerId, c.sessionSecret, "online");
  setBlackjackAway(db, a.playerId, a.sessionSecret, true);
  setDominoAway(db, b.playerId, b.sessionSecret, true);
  setPokerAway(db, c.playerId, c.sessionSecret, true);
  const status = getTablesStatus(db);
  const bjSeat = status.find(t => t.id === "blackjack-1")!.seats.find(s => s?.barPlayerId === a.playerId);
  const dominoSeat = status.find(t => t.id === "dominoes-1")!.seats.find(s => s?.barPlayerId === b.playerId);
  const pokerSeat = status.find(t => t.id === "texas-1")!.seats.find(s => s?.barPlayerId === c.playerId);
  expect(bjSeat?.present).toBe(false);
  expect(dominoSeat?.present).toBe(false);
  expect(pokerSeat?.present).toBe(false);
  // Clearing away restores present — confirms this is genuinely driven
  // by the away flag, not some other side effect of marking it.
  setBlackjackAway(db, a.playerId, a.sessionSecret, false);
  setDominoAway(db, b.playerId, b.sessionSecret, false);
  setPokerAway(db, c.playerId, c.sessionSecret, false);
  const after = getTablesStatus(db);
  expect(after.find(t => t.id === "blackjack-1")!.seats.find(s => s?.barPlayerId === a.playerId)?.present).toBe(true);
  expect(after.find(t => t.id === "dominoes-1")!.seats.find(s => s?.barPlayerId === b.playerId)?.present).toBe(true);
  expect(after.find(t => t.id === "texas-1")!.seats.find(s => s?.barPlayerId === c.playerId)?.present).toBe(true);
});
