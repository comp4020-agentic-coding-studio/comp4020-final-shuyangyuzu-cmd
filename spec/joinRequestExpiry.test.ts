// Phase 3 (product-direction-update): a pending join request that
// nobody acts on expires via the same lazy lobby-disconnect-grace sweep
// a stale lobby seat already uses (src/rooms.ts's sweepStaleLobbyPlayers),
// reusing LOBBY_GRACE_MS rather than inventing a second threshold.
// Tested directly against a hand-built database, same reasoning as
// spec/tableExpiry.test.ts: the real grace period defaults to a real
// minute, far too slow for an automated wait — back-dating the request's
// own `requestedAt` is instant and deterministic.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createRoom, getPublicState, requestJoin, RoomError } from "../src/rooms.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-join-request-expiry-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function longAgo(): string {
  return new Date(Date.now() - 999_999_999).toISOString();
}

it("a pending request nobody acted on expires on the next read, past the lobby grace period", () => {
  const host = createRoom(db, "ExpiryHost", "red");
  const requested = requestJoin(db, host.code, "NeverApproved", "blue");

  let state = getPublicState(db, host.code);
  expect(state.pendingRequests).toHaveLength(1);

  const roomRow = db.prepare(`SELECT id, state_json FROM rooms WHERE code = ?`).get(host.code) as {
    id: string;
    state_json: string;
  };
  const json = JSON.parse(roomRow.state_json);
  json.pendingRequests[0].requestedAt = longAgo();
  db.prepare(`UPDATE rooms SET state_json = ? WHERE id = ?`).run(JSON.stringify(json), roomRow.id);

  state = getPublicState(db, host.code);
  expect(state.pendingRequests).toHaveLength(0);

  // The expired request's session is really gone, not just hidden.
  const sessionRow = db.prepare(`SELECT 1 FROM sessions WHERE player_id = ?`).get(requested.playerId);
  expect(sessionRow).toBeUndefined();
});

it("an expired request doesn't close the room or touch the host if the host themself is still present", () => {
  const host = createRoom(db, "StillHere", "green");
  requestJoin(db, host.code, "Expires", "blue");

  const roomRow = db.prepare(`SELECT id, state_json FROM rooms WHERE code = ?`).get(host.code) as {
    id: string;
    state_json: string;
  };
  const json = JSON.parse(roomRow.state_json);
  json.pendingRequests[0].requestedAt = longAgo();
  db.prepare(`UPDATE rooms SET state_json = ? WHERE id = ?`).run(JSON.stringify(json), roomRow.id);

  const state = getPublicState(db, host.code);
  expect(state.closed).toBe(false);
  expect(state.hostPlayerId).toBe(host.playerId);
  expect(state.players).toHaveLength(1);
  expect(state.pendingRequests).toHaveLength(0);
});

it("requestJoin refuses a nonexistent/closed room the same way joinRoom already does", () => {
  expect(() => requestJoin(db, "ZZZZZZ", "Nobody", "red")).toThrow(RoomError);
});
