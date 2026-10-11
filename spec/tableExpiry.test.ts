// Product-direction-update regression (2026-10-11): a bar table's
// displayed status must never outrun the room's own lazy lobby-
// disconnect-grace sweep — the reported bug was "shows someone present,
// joining says the room is already closed," traced to src/tables.ts
// reading `rooms` directly instead of going through rooms.ts's own
// sweep-applying read.
//
// Tested directly against hand-built databases (like
// spec/db-migration.test.ts), not over HTTP against the shared running
// server: the real bug needs a player to go stale past LOBBY_GRACE_MS
// (60s by default), and the shared server can't have its env changed
// mid-suite (the same constraint spec/presence.test.ts documents for
// time-based logic) — back-dating a presence row directly is instant and
// deterministic, not a 60-second real wait.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { joinBar } from "../src/bar.ts";
import { openDb } from "../src/db.ts";
import { createRoom } from "../src/rooms.ts";
import { createTableRoom, getActiveSeat, getTablesStatus } from "../src/tables.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-table-expiry-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Well past any real PRESENCE_STALE_MS/LOBBY_GRACE_MS default without
 * depending on their exact values — the point is "unambiguously long
 * gone," not a specific threshold (those are covered precisely by
 * spec/presence.test.ts's own pure-function tests). */
function longAgo(): string {
  return new Date(Date.now() - 999_999_999).toISOString();
}

it("a table whose only player has gone stale past the lobby grace reports empty, not a stale 'waiting' — even though nothing has read the room directly yet", () => {
  const created = createRoom(db, "Solo", "red");
  const roomRow = db.prepare(`SELECT id FROM rooms WHERE code = ?`).get(created.code) as { id: string };
  db.prepare(`UPDATE tables SET current_room_id = ? WHERE id = 'vegas-1'`).run(roomRow.id);
  db.prepare(`UPDATE presence SET last_seen_at = ? WHERE player_id = ?`).run(longAgo(), created.playerId);

  // Nobody has called rooms.getPublicState (or any room endpoint) on this
  // room since it went stale — getTablesStatus is the first thing to
  // look. The fixed version routes through the same lazy sweep every
  // other room read already uses; the broken version read `rooms`
  // directly and would still report "waiting" here with the long-gone
  // player still counted.
  const status = getTablesStatus(db);
  const vegas1 = status.find((t) => t.id === "vegas-1")!;
  expect(vegas1.status).toBe("empty");
  expect(vegas1.roomCode).toBeNull();
  expect(vegas1.playerCount).toBe(0);
});

it("a chosen colour maps to its physical chair regardless of joining first", () => {
  const patron = joinBar(db, "Yellow host", "purple", "deep");
  createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "yellow");
  const table = getTablesStatus(db).find((t) => t.id === "vegas-1")!;
  expect(table.seats[0]).toBeNull();
  expect(table.seats[3]).toMatchObject({ color: "yellow", barPlayerId: patron.playerId, skin: "deep", present: true });
  db.prepare("INSERT INTO table_departures (bar_player_id, table_id, left_at) VALUES (?, ?, ?)").run(patron.playerId, "vegas-1", new Date().toISOString());
  expect(getTablesStatus(db).find((t) => t.id === "vegas-1")!.seats[3]).toMatchObject({ present: false });
});

it("a bar identity's stale table binding (its host gone past grace) is cleared, not mistaken for 'already seated' at a dead room", () => {
  const patron = joinBar(db, "Returning", "red", "warm");
  const created = createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "red");
  db.prepare(`UPDATE presence SET last_seen_at = ? WHERE player_id = ?`).run(longAgo(), created.playerId);

  expect(getActiveSeat(db, patron.playerId)).toBeNull();

  // A fresh game at a different table must succeed — refusing this as
  // "already_seated" against a room that's actually dead was the exact
  // mechanism behind the reported bug.
  const fresh = createTableRoom(db, "vegas-2", patron.playerId, patron.sessionSecret, "blue");
  expect(fresh.code).not.toBe(created.code);
});

it("getTablesStatus clearing a stale binding and a direct join attempt agree with each other (no more 'shows waiting, join says closed')", () => {
  const created = createRoom(db, "AloneHost", "green");
  const roomRow = db.prepare(`SELECT id FROM rooms WHERE code = ?`).get(created.code) as { id: string };
  db.prepare(`UPDATE tables SET current_room_id = ? WHERE id = 'vegas-2'`).run(roomRow.id);
  db.prepare(`UPDATE presence SET last_seen_at = ? WHERE player_id = ?`).run(longAgo(), created.playerId);

  const beforeAnyAction = getTablesStatus(db).find((t) => t.id === "vegas-2")!;
  expect(beforeAnyAction.status).toBe("empty"); // not "waiting" with a player who's actually long gone

  // And a fresh create at this now-correctly-reported-empty table must
  // actually succeed — status and action must never disagree.
  const newcomer = joinBar(db, "Newcomer", "blue", "warm");
  const fresh = createTableRoom(db, "vegas-2", newcomer.playerId, newcomer.sessionSecret, "blue");
  expect(fresh.code).not.toBe(created.code);
});
