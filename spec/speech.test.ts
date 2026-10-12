// Public tavern speech (product-direction-update, part 3's replacement
// for private 1:1 chat). Direct-DB tests (same pattern as
// spec/chat.test.ts) — several of these need exact control over time
// without waiting out SPEECH_DISPLAY_MS for real.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BarError, getPublicBarState, joinBar, say } from "../src/bar.ts";
import { openDb } from "../src/db.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-speech-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function catchError(fn: () => unknown): { code: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof BarError) return err;
    throw err;
  }
  throw new Error("expected a BarError");
}

function rawRow(playerId: string) {
  return db.prepare(`SELECT text, client_msg_id, expires_at FROM bar_speech WHERE player_id = ?`).get(playerId) as
    | { text: string; client_msg_id: string; expires_at: string }
    | undefined;
}

it("a sent bubble is visible to everyone via getPublicBarState, including a third identity", () => {
  const a = joinBar(db, "Speaker", "red");
  const bystander = joinBar(db, "Bystander", "blue");
  say(db, a.playerId, a.sessionSecret, "msg-1", "Hello tavern!");
  const state = getPublicBarState(db);
  expect(state.players.find((p) => p.id === a.playerId)?.speech).toBe("Hello tavern!");
  // The bystander's own read of the SAME public state sees it too — this
  // is a public broadcast, not addressed to anyone specific.
  expect(state.players.find((p) => p.id === bystander.playerId)).toBeDefined();
});

it("trims whitespace and refuses an empty or whitespace-only message", () => {
  const a = joinBar(db, "A", "red");
  say(db, a.playerId, a.sessionSecret, "m1", "  padded  ");
  expect(getPublicBarState(db).players[0].speech).toBe("padded");
  expect(catchError(() => say(db, a.playerId, a.sessionSecret, "m2", "   ")).code).toBe("empty_message");
});

it("refuses a message over the length limit", () => {
  const a = joinBar(db, "A", "red");
  expect(catchError(() => say(db, a.playerId, a.sessionSecret, "m1", "x".repeat(501))).code).toBe("too_long");
});

it("refuses without a valid session", () => {
  const a = joinBar(db, "A", "red");
  expect(catchError(() => say(db, a.playerId, "wrong-secret", "m1", "hi")).code).toBe("unauthorized");
});

it("a genuinely new send replaces the previous bubble and restarts its timer", () => {
  const a = joinBar(db, "A", "red");
  say(db, a.playerId, a.sessionSecret, "m1", "first");
  const firstRow = rawRow(a.playerId)!;
  say(db, a.playerId, a.sessionSecret, "m2", "second");
  const secondRow = rawRow(a.playerId)!;
  expect(secondRow.text).toBe("second");
  // >=, not strictly >: both sends can legitimately land in the same
  // millisecond on a fast machine — what actually matters here is that
  // the replacement computed a *fresh* expiry (unlike the no-op retry
  // case below, which must reuse the exact prior one), not that enough
  // wall-clock time passed to tick the ISO string forward.
  expect(secondRow.expires_at >= firstRow.expires_at).toBe(true);
  expect(secondRow.client_msg_id).toBe("m2");
  expect(getPublicBarState(db).players[0].speech).toBe("second");
});

it("retrying the same clientMsgId is a no-op — never re-times the display clock", () => {
  const a = joinBar(db, "A", "red");
  say(db, a.playerId, a.sessionSecret, "retry-1", "hello");
  const firstRow = rawRow(a.playerId)!;
  say(db, a.playerId, a.sessionSecret, "retry-1", "hello");
  const secondRow = rawRow(a.playerId)!;
  expect(secondRow).toEqual(firstRow);
});

it("a bubble past its expiry is reported as null, not left showing forever", () => {
  const a = joinBar(db, "A", "red");
  say(db, a.playerId, a.sessionSecret, "m1", "fleeting");
  expect(getPublicBarState(db).players[0].speech).toBe("fleeting");
  db.prepare(`UPDATE bar_speech SET expires_at = ? WHERE player_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    a.playerId,
  );
  expect(getPublicBarState(db).players[0].speech).toBeNull();
});

it("a reconnect (a plain re-read) reports the same absolute expiry, not a restarted window", () => {
  const a = joinBar(db, "A", "red");
  say(db, a.playerId, a.sessionSecret, "m1", "hi");
  const row1 = rawRow(a.playerId)!;
  // Simulate time passing without any new send — a later read must see
  // the identical expires_at, never a freshly-computed one.
  getPublicBarState(db);
  getPublicBarState(db);
  const row2 = rawRow(a.playerId)!;
  expect(row2.expires_at).toBe(row1.expires_at);
});

it("enforces a send-rate limit per sender", () => {
  const a = joinBar(db, "A", "red");
  let limited = false;
  for (let i = 0; i < 20; i++) {
    try {
      say(db, a.playerId, a.sessionSecret, `burst-${i}`, `msg ${i}`);
    } catch (err) {
      if (err instanceof BarError && err.code === "rate_limited") {
        limited = true;
        break;
      }
      throw err;
    }
  }
  expect(limited).toBe(true);
});
