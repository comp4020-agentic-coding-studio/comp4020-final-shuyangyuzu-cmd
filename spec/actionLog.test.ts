// Structured action logging (Crit 10: "narrate from flyctl logs, no
// clicking your own UI"). console.log happens inside the app process,
// which the HTTP-level spec files (inject("baseUrl")) run against as a
// separate, already-running process — they can't spy on its stdout. Every
// assertion here that needs to see an actual log line is a direct-DB test
// against src/*.ts functions, same pattern as spec/chat.test.ts and
// spec/tableDeparture.test.ts, spying on console.log for the duration of
// one it() block.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatActionLogLine } from "../src/actionLog.ts";
import { joinBar, moveBar, say, sitAtSeat } from "../src/bar.ts";
import { BAR_SEATS } from "../src/barLayout.ts";
import { openDb } from "../src/db.ts";
import {
  approveJoin,
  createRoom,
  disbandRoom,
  handoffToNpc,
  joinRoom,
  npcRoll,
  place,
  roll,
  setReady,
  startGame,
} from "../src/rooms.ts";
import { createTableRoom, joinTableRoom } from "../src/tables.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-actionlog-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// mockRestore() clears the spy's own recorded calls, so every caller below
// reads `spy.mock.calls` BEFORE restoring, not after.
function captureLogLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

it("the pure formatter never includes a given secret value", () => {
  const secret = "s3cr3t-value-that-must-never-appear";
  const line = formatActionLogLine({
    action: "roll",
    outcome: "ok",
    verified: true,
    actor: { kind: "room", id: "abcdef1234567890" },
    room: { code: "ABC123" },
    detail: { values: "1,2,3" },
  });
  expect(line).not.toContain(secret);
  expect(line).not.toMatch(/sessionSecret/i);
  expect(line).toContain("[action]");
  // Single line: no embedded newline that could split one event across
  // two lines in flyctl logs' line-based capture.
  expect(line.includes("\n")).toBe(false);
});

it("two bar identities with the same nickname log distinguishably different actor ids", () => {
  const a = joinBar(db, "Twin", "red", "warm");
  const b = joinBar(db, "Twin", "blue", "warm");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  say(db, a.playerId, a.sessionSecret, "msg-a", "Hello from A");
  say(db, b.playerId, b.sessionSecret, "msg-b", "Hello from B");
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"say"'));
  spy.mockRestore();

  expect(lines).toHaveLength(2);
  const idA = JSON.parse(lines[0].replace("[action] ", "")).actor.id;
  const idB = JSON.parse(lines[1].replace("[action] ", "")).actor.id;
  expect(idA).not.toBe(idB);
});

it("a wrong session secret on a bar action never logs a success line", () => {
  const a = joinBar(db, "RealPatron", "red", "warm");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  // bar.ts's own actions throw BarError directly (not caught/logged
  // inside bar.ts itself) — this test confirms the *throw* still happens
  // as before; app.onError (the actual log-producing choke point for
  // rejections) is covered over HTTP in spec/bar.test.ts's own
  // "refuses an action with a wrong session secret" case. What this test
  // adds is direct confirmation that no successful "ok" log line is ever
  // produced for a call that never got past requireBarSession.
  expect(() => say(db, a.playerId, "wrong-secret", "msg-1", "hi")).toThrow();
  const lines = captureLogLines(spy);
  spy.mockRestore();

  expect(lines.some((l) => l.includes('"action":"say"') && l.includes('"outcome":"ok"'))).toBe(false);
});

it("a non-host's approve/start/disband attempt never produces a success log line", () => {
  const host = createRoom(db, "Host", "red");
  const other = joinRoom(db, host.code, "Other", "blue");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});

  expect(() => startGame(db, host.code, other.playerId, other.sessionSecret)).toThrow();
  expect(() => disbandRoom(db, host.code, other.playerId, other.sessionSecret, true)).toThrow();
  const lines = captureLogLines(spy);
  spy.mockRestore();

  expect(lines.some((l) => l.includes('"action":"game_started"'))).toBe(false);
  expect(lines.some((l) => l.includes('"action":"room_disbanded"'))).toBe(false);
});

it("acting out of turn logs no success line for that attempt", () => {
  const host = createRoom(db, "Alice", "red");
  const bob = joinRoom(db, host.code, "Bob", "blue");
  setReady(db, host.code, host.playerId, host.sessionSecret, true);
  setReady(db, host.code, bob.playerId, bob.sessionSecret, true);
  startGame(db, host.code, host.playerId, host.sessionSecret);

  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  // Alice (host) goes first by join order — Bob acting now is out of turn.
  expect(() => roll(db, host.code, bob.playerId, bob.sessionSecret)).toThrow();
  const lines = captureLogLines(spy);
  spy.mockRestore();

  expect(lines.some((l) => l.includes('"action":"rolled"') && l.includes('"outcome":"ok"'))).toBe(false);
});

it("a retried idempotent say logs success once, not twice", () => {
  const a = joinBar(db, "Retrier", "red", "warm");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  say(db, a.playerId, a.sessionSecret, "retry-1", "Once");
  say(db, a.playerId, a.sessionSecret, "retry-1", "Once"); // same clientMsgId — idempotent no-op
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"say"') && l.includes('"outcome":"ok"'));
  spy.mockRestore();

  expect(lines).toHaveLength(1);
});

it("an NPC-controlled seat's turn logs with controller: npc and no verified:false", () => {
  const host = createRoom(db, "Human", "red");
  const bob = joinRoom(db, host.code, "Bob", "blue");
  setReady(db, host.code, host.playerId, host.sessionSecret, true);
  setReady(db, host.code, bob.playerId, bob.sessionSecret, true);
  startGame(db, host.code, host.playerId, host.sessionSecret);

  // Hand Bob's seat to NPC control directly (same mechanism
  // tables.enforceExpiredDepartures uses internally) so npcRoll has
  // something to act on, without waiting out a real 2-minute clock.
  // Whoever's turn it is first (join order: host first) must roll/place
  // before Bob's turn comes up — drive one full human turn first.
  roll(db, host.code, host.playerId, host.sessionSecret);
  const fresh = JSON.parse(
    (db.prepare(`SELECT state_json FROM rooms WHERE id = (SELECT id FROM rooms WHERE code = ?)`).get(host.code) as {
      state_json: string;
    }).state_json,
  );
  place(db, host.code, host.playerId, host.sessionSecret, fresh.lastRoll.values[0]);
  handoffToNpc(db, host.code, bob.playerId);

  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const acted = npcRoll(db, host.code);
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"rolled"') && l.includes('"outcome":"ok"'));
  spy.mockRestore();

  expect(acted).toBe(true);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0].replace("[action] ", ""));
  expect(parsed.detail.controller).toBe("npc");
  expect(parsed.verified).toBe(true);
});

it("table binding (create_table) logs correlate the bar identity and the room player it just became", () => {
  const patron = joinBar(db, "Correlated", "red", "warm");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const created = createTableRoom(db, "vegas-1", patron.playerId, patron.sessionSecret, "red");
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"create_table"'));
  spy.mockRestore();

  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0].replace("[action] ", ""));
  expect(parsed.actor.kind).toBe("bar");
  expect(parsed.detail.roomPlayerId).toBe(created.playerId.slice(0, 8));
  expect(parsed.room.code).toBe(created.code);
});

it("a pending join request's logged action never claims a seat (pending: true in detail)", () => {
  const host = joinBar(db, "TableHost", "red", "warm");
  createTableRoom(db, "vegas-1", host.playerId, host.sessionSecret, "red");
  const other = joinBar(db, "Requester", "blue", "warm");

  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  joinTableRoom(db, "vegas-1", other.playerId, other.sessionSecret, "blue");
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"join_table"'));
  spy.mockRestore();

  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0].replace("[action] ", ""));
  expect(parsed.detail.pending).toBe(true);
});

it("a bar move is logged only once within the debounce window, not once per step", () => {
  const patron = joinBar(db, "Walker", "red", "warm");
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  // Two immediate successive moves in different directions — whichever
  // succeeds, the point under test is the logging frequency, not the
  // exact path, so this tries a few candidate single steps and only
  // counts logged lines for moves that actually succeeded.
  const candidates: Array<[number, number]> = [
    [patron.x + 1, patron.y],
    [patron.x - 1, patron.y],
    [patron.x, patron.y + 1],
    [patron.x, patron.y - 1],
  ];
  let moved = 0;
  for (const [x, y] of candidates) {
    try {
      moveBar(db, patron.playerId, patron.sessionSecret, x, y);
      moved++;
      if (moved >= 2) break;
    } catch {
      // not a legal step from the current tile — try the next candidate
    }
  }
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"move"'));
  spy.mockRestore();

  expect(moved).toBeGreaterThanOrEqual(1);
  // Regardless of how many moveBar calls actually succeeded above, the
  // debounce means at most one "move" log line appears within the
  // default 3s window.
  expect(lines.length).toBeLessThanOrEqual(1);
});

it("sitting back down in your own already-occupied seat is a no-op and logs nothing new", () => {
  const patron = joinBar(db, "Sitter", "red", "warm");
  const seat = BAR_SEATS[0];
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(seat.x, seat.y, patron.playerId);
  sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id);

  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  sitAtSeat(db, patron.playerId, patron.sessionSecret, seat.id); // re-clicking the same chair
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"sit"'));
  spy.mockRestore();

  expect(lines).toHaveLength(0);
});

it("host approval logs the approving host, not the approved player, as the actor", () => {
  const host = joinBar(db, "ApprovingHost", "red", "warm");
  const created = createTableRoom(db, "vegas-1", host.playerId, host.sessionSecret, "red");
  const requester = joinBar(db, "Requesting", "blue", "warm");
  const requested = joinTableRoom(db, "vegas-1", requester.playerId, requester.sessionSecret, "blue");

  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  approveJoin(db, created.code, created.playerId, created.sessionSecret, requested.playerId);
  const lines = captureLogLines(spy).filter((l) => l.includes('"action":"join_approved"'));
  spy.mockRestore();

  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0].replace("[action] ", ""));
  expect(parsed.actor.id).toBe(created.playerId.slice(0, 8));
});
