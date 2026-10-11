// Phase 2 (product-direction-update): the 2-minute away-from-table clock
// (CLAUDE.md's leave/exit states). Tested directly against hand-built
// databases, same reasoning as spec/tableExpiry.test.ts: the real clock
// defaults to 2 real minutes, far too slow for an automated test to wait
// out — back-dating a table_departures row directly is instant and
// deterministic, and exercises the exact enforcement function
// (tables.enforceExpiredDepartures) rather than a restated copy of it.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BAR_SEATS } from "../src/barLayout.ts";
import { joinBar, sitAtSeat } from "../src/bar.ts";
import { openDb } from "../src/db.ts";
import { getPublicState, setReady, startGame } from "../src/rooms.ts";
import {
  clearDepartureForGamePlayer,
  createTableRoom,
  departActiveTable,
  enforceExpiredDepartures,
  joinTableRoom,
} from "../src/tables.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-table-departure-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function backDateDeparture(barPlayerId: string, awayMs: number): void {
  db.prepare(`UPDATE table_departures SET left_at = ? WHERE bar_player_id = ?`).run(
    new Date(Date.now() - awayMs - 1000).toISOString(),
    barPlayerId,
  );
}

it("sitting at a real seat while bound to a game table records a departure", () => {
  const patron = joinBar(db, "Host", "red", "warm");
  createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "red");

  const seat = BAR_SEATS[0];
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(seat.x, seat.y, patron.playerId);
  sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id);

  const row = db.prepare(`SELECT table_id FROM table_departures WHERE bar_player_id = ?`).get(patron.playerId) as
    | { table_id: string }
    | undefined;
  expect(row?.table_id).toBe("vegas-1");
});

it("departActiveTable records a departure for whatever table this identity is currently bound to", () => {
  const patron = joinBar(db, "Navigator", "blue", "warm");
  createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "blue");

  departActiveTable(db, patron.playerId, patron.sessionSecret);

  const row = db.prepare(`SELECT table_id FROM table_departures WHERE bar_player_id = ?`).get(patron.playerId) as
    | { table_id: string }
    | undefined;
  expect(row?.table_id).toBe("vegas-1");
});

it("departActiveTable is a harmless no-op with no active table binding", () => {
  const patron = joinBar(db, "Unbound", "green", "warm");
  expect(() => departActiveTable(db, patron.playerId, patron.sessionSecret)).not.toThrow();
  const row = db.prepare(`SELECT 1 FROM table_departures WHERE bar_player_id = ?`).get(patron.playerId);
  expect(row).toBeUndefined();
});

it("clearDepartureForGamePlayer cancels a pending departure (the 'I'm actually back' signal)", () => {
  const patron = joinBar(db, "Returning", "yellow", "warm");
  const created = createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "yellow");
  departActiveTable(db, patron.playerId, patron.sessionSecret);

  clearDepartureForGamePlayer(db, created.playerId);

  const row = db.prepare(`SELECT 1 FROM table_departures WHERE bar_player_id = ?`).get(patron.playerId);
  expect(row).toBeUndefined();
});

it("a departure under the 2-minute threshold is left alone — nothing to enforce yet", () => {
  const patron = joinBar(db, "StillWithinGrace", "purple", "warm");
  const created = createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "green");
  departActiveTable(db, patron.playerId, patron.sessionSecret);
  // Left_at is "now" — nowhere near the default 120000ms threshold.

  const affected = enforceExpiredDepartures(db, 120000);
  expect(affected).toEqual([]);
  const state = getPublicState(db, created.code);
  expect(state.players.map((p) => p.id)).toContain(created.playerId);
});

it("an expired departure from a still-lobby seat releases it exactly like a voluntary leave", () => {
  const host = joinBar(db, "LobbyHost", "orange", "warm");
  const created = createTableRoom(db, "vegas-1", host.playerId, host.sessionSecret, "blue");
  departActiveTable(db, host.playerId, host.sessionSecret);
  backDateDeparture(host.playerId, 120000);

  const affected = enforceExpiredDepartures(db, 120000);
  expect(affected).toEqual([created.code]);

  const state = getPublicState(db, created.code);
  // Sole player gone -> room closes, same as src/rooms.ts's own
  // voluntary-leave behavior (spec/lobby.test.ts covers that contract
  // directly; this only checks the departure clock actually invokes it).
  expect(state.closed).toBe(true);
});

it("an expired departure from an in-progress game hands the seat to NPC control — dice, winnings, and turn order untouched", () => {
  const host = joinBar(db, "GameHost", "teal", "warm");
  const created = createTableRoom(db, "vegas-1", host.playerId, host.sessionSecret, "red");
  const guestBar = joinBar(db, "GameGuest", "pink", "warm");
  const guest = joinTableRoom(db, "vegas-1", guestBar.playerId, guestBar.sessionSecret, "yellow");

  setReady(db, created.code, created.playerId, created.sessionSecret, true);
  setReady(db, created.code, guest.playerId, guest.sessionSecret, true);
  startGame(db, created.code, created.playerId, created.sessionSecret);

  const before = getPublicState(db, created.code);
  const hostBefore = before.players.find((p) => p.id === created.playerId)!;
  expect(before.phase).not.toBe("lobby");
  expect(hostBefore.controller).toBe("human");

  departActiveTable(db, host.playerId, host.sessionSecret);
  backDateDeparture(host.playerId, 120000);

  const affected = enforceExpiredDepartures(db, 120000);
  expect(affected).toEqual([created.code]);

  const after = getPublicState(db, created.code);
  const hostAfter = after.players.find((p) => p.id === created.playerId)!;
  expect(hostAfter.controller).toBe("npc");
  // Nothing about the actual game state changed — same dice count, same
  // seat, same turn order, same everything else about the round.
  expect(hostAfter.diceInHand).toBe(hostBefore.diceInHand);
  expect(hostAfter.seat).toBe(hostBefore.seat);
  expect(hostAfter.wonBills).toEqual(hostBefore.wonBills);
  expect(after.turnOrder).toEqual(before.turnOrder);
  expect(after.phase).toBe(before.phase);
});
