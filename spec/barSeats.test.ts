// Phase 2 (product-direction-update): real dining/stool seating —
// src/bar.ts's sitAtSeat/standFromSeat tested directly against a
// hand-built database (like spec/tableExpiry.test.ts), not over HTTP:
// sitting requires actually standing on the seat's own tile, and walking
// there for real from the shared server's fixed spawn point would mean
// dozens of single-step /move calls — this exercises the same validation
// logic deterministically and fast by placing a patron's position
// directly, the same trade-off this suite already makes elsewhere for
// time- or setup-heavy scenarios.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BarError, getPublicBarState, joinBar, moveBar, sitAtSeat, standFromSeat } from "../src/bar.ts";
import { BAR_SEATS, GAME_CHAIRS, FURNITURE, isValidStep, isWalkingFloor } from "../src/barLayout.ts";
import { openDb } from "../src/db.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-bar-seats-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function placeAt(playerId: string, x: number, y: number): void {
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(x, y, playerId);
}

it("sitting requires reaching the chair, and accepts its adjacent floor", () => {
  const seat = BAR_SEATS[0];
  const patron = joinBar(db, "Walker", "red", "warm");
  expect(() => sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id)).toThrow(BarError);

  placeAt(patron.playerId, seat.x, seat.y + 1);
  expect(() => sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id)).not.toThrow();
  const state = getPublicBarState(db);
  expect(state.players.find((p) => p.id === patron.playerId)?.seatId).toBe(seat.id);
  expect(state.players.find((p) => p.id === patron.playerId)).toMatchObject({ x: seat.x, y: seat.y });
  standFromSeat(db, patron.playerId, patron.sessionSecret);
  const standing = getPublicBarState(db).players.find(p=>p.id===patron.playerId)!;
  expect(standing.seatId).toBeNull();
  expect(isWalkingFloor(standing.x,standing.y)).toBe(true);
});

it("the actual move action rejects empty chairs and the middle cabinet", () => {
  const patron=joinBar(db,"No clipping","blue","warm");
  const wall=FURNITURE.find(f=>f.id==="back-bar")!;
  for(const obstacle of [BAR_SEATS[0],GAME_CHAIRS[0],{x:wall.x,y:wall.y}]) {
    placeAt(patron.playerId,obstacle.x-1,obstacle.y);
    expect(()=>moveBar(db,patron.playerId,patron.sessionSecret,obstacle.x,obstacle.y)).toThrow(BarError);
    expect(db.prepare("SELECT x,y FROM bar_players WHERE id = ?").get(patron.playerId)).toEqual({x:obstacle.x-1,y:obstacle.y});
  }
});

it("refuses a second patron sitting in an already-occupied seat", () => {
  const seat = BAR_SEATS[0];
  const a = joinBar(db, "A", "red", "warm");
  placeAt(a.playerId, seat.x, seat.y);
  sitAtSeat(db, a.playerId, a.sessionSecret, seat.id);

  const b = joinBar(db, "B", "blue", "warm");
  placeAt(b.playerId, seat.x, seat.y);
  expect(() => sitAtSeat(db, b.playerId, b.sessionSecret, seat.id)).toThrow(BarError);
});

it("re-sitting in the same seat you're already in is a harmless no-op", () => {
  const seat = BAR_SEATS[0];
  const patron = joinBar(db, "Settled", "green", "warm");
  placeAt(patron.playerId, seat.x, seat.y);
  sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id);
  expect(() => sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id)).not.toThrow();
});

it("refuses sitting at a second seat without standing from the first", () => {
  const [seatA, seatB] = BAR_SEATS;
  const patron = joinBar(db, "OneSeat", "yellow", "warm");
  placeAt(patron.playerId, seatA.x, seatA.y);
  sitAtSeat(db, patron.playerId, patron.sessionSecret, seatA.id);
  placeAt(patron.playerId, seatB.x, seatB.y);
  expect(() => sitAtSeat(db, patron.playerId, patron.sessionSecret, seatB.id)).toThrow(BarError);
});

it("standing up frees the seat for someone else", () => {
  const seat = BAR_SEATS[0];
  const a = joinBar(db, "Leaver", "purple", "warm");
  placeAt(a.playerId, seat.x, seat.y);
  sitAtSeat(db, a.playerId, a.sessionSecret, seat.id);
  standFromSeat(db, a.playerId, a.sessionSecret);

  const b = joinBar(db, "NextUp", "orange", "warm");
  placeAt(b.playerId, seat.x, seat.y);
  expect(() => sitAtSeat(db, b.playerId, b.sessionSecret, seat.id)).not.toThrow();
});

it("standing when not seated anywhere is a harmless no-op", () => {
  const patron = joinBar(db, "NeverSat", "pink", "warm");
  expect(() => standFromSeat(db, patron.playerId, patron.sessionSecret)).not.toThrow();
});

it("moving away from a seat automatically stands you up — a chair can't show occupied once you've visibly walked off", () => {
  const seat = BAR_SEATS[0];
  const patron = joinBar(db, "Mover", "teal", "warm");
  placeAt(patron.playerId, seat.x, seat.y);
  sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id);

  // A seat tile is, by construction, always walkable (barLayout.test.ts
  // covers that in general) — find any one valid single-step neighbor.
  const candidates: Array<[number, number]> = [
    [seat.x + 1, seat.y],
    [seat.x - 1, seat.y],
    [seat.x, seat.y + 1],
    [seat.x, seat.y - 1],
  ];
  const next = candidates.find(([x, y]) => isValidStep(seat.x, seat.y, x, y));
  expect(next, "expected at least one walkable neighbor of a seat tile").toBeDefined();
  moveBar(db, patron.playerId, patron.sessionSecret, next![0], next![1]);

  const state = getPublicBarState(db);
  expect(state.players.find((p) => p.id === patron.playerId)?.seatId).toBeNull();
});
