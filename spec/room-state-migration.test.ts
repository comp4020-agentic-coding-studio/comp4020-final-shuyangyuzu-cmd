// Production regression: an old room's JSON lacked pendingRequests and
// controller. Resolving a returning bar identity therefore returned 500.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { joinBar } from "../src/bar.ts";
import { openDb } from "../src/db.ts";
import { getPublicState, rejoin } from "../src/rooms.ts";
import { createTableRoom, getActiveSeat, getTablesStatus } from "../src/tables.ts";

let dir: string;
let path: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-json-migration-"));
  path = join(dir, "vegas.db");
  db = openDb(path);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function legacyRoom() {
  const patron = joinBar(db, "Returning", "red", "warm");
  const room = createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "red");
  const row = db.prepare("SELECT id, state_json FROM rooms WHERE code = ?").get(room.code) as { id: string; state_json: string };
  const state = JSON.parse(row.state_json);
  delete state.pendingRequests;
  delete state.players[room.playerId].controller;
  db.prepare("UPDATE rooms SET state_json = ? WHERE id = ?").run(JSON.stringify(state), row.id);
  return { patron, room, row, state };
}

it("migrates legacy JSON so returning identities and table status work, preserving the room and session", () => {
  const { patron, room, row, state } = legacyRoom();
  expect(() => getActiveSeat(db, patron.playerId)).toThrow(); // exact production failure before startup migration
  db.close();
  db = openDb(path);
  expect(getActiveSeat(db, patron.playerId)).toMatchObject({ tableId: "vegas-1", roomCode: room.code });
  expect(getTablesStatus(db).find((t) => t.id === "vegas-1")).toMatchObject({ status: "waiting", playerCount: 1 });
  expect(() => rejoin(db, room.code, room.playerId, room.sessionSecret)).not.toThrow();
  const saved = db.prepare("SELECT state_json, version FROM rooms WHERE id = ?").get(row.id) as { state_json: string; version: number };
  expect(saved.version).toBe(1);
  expect(JSON.parse(saved.state_json)).toEqual({ ...state, pendingRequests: [], players: { ...state.players, [room.playerId]: { ...state.players[room.playerId], controller: "human" } } });
});

it("migrates closed legacy rooms too, allowing stale bindings to clear normally", () => {
  const { patron, room, row } = legacyRoom();
  db.prepare("UPDATE rooms SET closed_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  db.close();
  db = openDb(path);
  expect(getPublicState(db, room.code)).toMatchObject({ closed: true, pendingRequests: [] });
  expect(getActiveSeat(db, patron.playerId)).toBeNull();
});

it("preserves started-game progress and is idempotent without overwriting existing NPC controllers or requests", () => {
  const { room, row, state } = legacyRoom();
  state.phase = "awaiting_placement";
  state.turnOrder = [room.playerId];
  state.currentPlayerId = room.playerId;
  state.lastRoll = { playerId: room.playerId, values: [1, 3] };
  state.players[room.playerId].controller = "npc";
  state.players[room.playerId].wonBills = [90000];
  state.pendingRequests = [{ id: "pending", nickname: "Guest", color: "blue", requestedAt: new Date().toISOString() }];
  const original = JSON.stringify(state);
  db.prepare("UPDATE rooms SET state_json = ?, version = 42 WHERE id = ?").run(original, row.id);
  const events = db.prepare("SELECT * FROM events").all();
  db.close();
  db = openDb(path);
  db.close();
  db = openDb(path);
  expect(db.prepare("SELECT state_json, version FROM rooms WHERE id = ?").get(row.id)).toEqual({ state_json: original, version: 42 });
  expect(db.prepare("SELECT * FROM events").all()).toEqual(events);
  expect(getPublicState(db, room.code)).toMatchObject({ phase: "awaiting_placement", lastRoll: state.lastRoll, players: [expect.objectContaining({ controller: "npc", wonBills: [90000] })] });
});
