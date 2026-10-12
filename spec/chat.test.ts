// Product-direction-update, part 3: proximity-triggered 1:1 chat.
// Direct-DB tests (like spec/occupancy.test.ts) — several of these need
// exact control over who's online/adjacent, and one deliberately trips a
// real rate limit without waiting out its window.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { joinBar, moveBar } from "../src/bar.ts";
import { isValidStep } from "../src/barLayout.ts";
import { ChatError, listMessages, openThread, requireThreadAccess, sendMessage } from "../src/chat.ts";
import { openDb } from "../src/db.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-chat-test-"));
  db = openDb(join(dir, "vegas.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function adjacentPair(nicknameA = "A", nicknameB = "B") {
  const a = joinBar(db, nicknameA, "red");
  const b = joinBar(db, nicknameB, "blue");
  // Force a deterministic adjacency regardless of where findFreeTile
  // happened to land each of them (spec/occupancy.test.ts's own pattern)
  // — and keep the returned objects' own x/y in sync with this override,
  // since joinBar's original return value is otherwise stale the moment
  // a raw UPDATE moves the row out from under it.
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(a.x, a.y, a.playerId);
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(a.x + 1, a.y, b.playerId);
  b.x = a.x + 1;
  b.y = a.y;
  return { a, b };
}

/** Catches anything with a `.code` string (BarError, TableError,
 * ChatError all shape errors the same way) — chat access checks often
 * fail through requireBarSession itself (src/bar.ts), not only through
 * src/chat.ts's own ChatError, and a caller of requireThreadAccess has
 * no way to tell which happened without checking both classes. */
function catchError(fn: () => unknown): { code: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ChatError || (err instanceof Error && "code" in err)) return err as { code: string };
    throw err;
  }
  throw new Error("expected an error with a .code");
}

it("opens a thread between two online, adjacent patrons and returns empty history", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  expect(opened.otherNickname).toBe("B");
  expect(opened.messages).toEqual([]);
  // Re-opening (e.g. clicking again) hands back the SAME thread, not a
  // second one for the same pair.
  const reopened = openThread(db, b.playerId, b.sessionSecret, a.playerId);
  expect(reopened.threadId).toBe(opened.threadId);
});

it("refuses to open a thread with someone more than one tile away", () => {
  const a = joinBar(db, "Far1", "red");
  const b = joinBar(db, "Far2", "blue");
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(a.x, a.y, a.playerId);
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(a.x + 5, a.y, b.playerId);
  const err = catchError(() => openThread(db, a.playerId, a.sessionSecret, b.playerId));
  expect(err.code).toBe("too_far");
});

it("refuses to open a thread with an offline patron", () => {
  const { a, b } = adjacentPair("Online1", "WentQuiet");
  db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(
    new Date(Date.now() - 999_999_999).toISOString(),
    b.playerId,
  );
  const err = catchError(() => openThread(db, a.playerId, a.sessionSecret, b.playerId));
  expect(err.code).toBe("recipient_offline");
});

it("refuses to chat with yourself", () => {
  const a = joinBar(db, "Solo", "red");
  const err = catchError(() => openThread(db, a.playerId, a.sessionSecret, a.playerId));
  expect(err.code).toBe("self_chat");
});

it("sends a message, delivers it to listMessages, and a third identity cannot read it", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  const sent = sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, "client-1", "Hey there");
  expect(sent.body).toBe("Hey there");
  expect(sent.senderId).toBe(a.playerId);

  const seenByB = listMessages(db, opened.threadId, 0);
  expect(seenByB).toHaveLength(1);
  expect(seenByB[0].id).toBe(sent.id);

  const outsider = joinBar(db, "Nosy", "green");
  const err = catchError(() => requireThreadAccess(db, opened.threadId, outsider.playerId, outsider.sessionSecret));
  expect(err.code).toBe("unauthorized");
  // A forged/guessed secret for an actual participant is still refused —
  // never a client-supplied identity alone.
  const forged = catchError(() => requireThreadAccess(db, opened.threadId, a.playerId, "wrong-secret"));
  expect(forged.code).toBe("unauthorized");
});

it("retrying the same clientMsgId is idempotent — never a duplicate, never a second message", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  const first = sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, "retry-1", "Once");
  const retried = sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, "retry-1", "Once");
  expect(retried).toEqual(first);
  expect(listMessages(db, opened.threadId, 0)).toHaveLength(1);
});

it("refuses an empty message and a message over the length limit", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  expect(catchError(() => sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, "m1", "   ")).code).toBe(
    "empty_message",
  );
  expect(
    catchError(() => sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, "m2", "x".repeat(501))).code,
  ).toBe("too_long");
});

it("refuses a send from someone who isn't a participant in that thread", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  const outsider = joinBar(db, "Butting In", "green");
  const err = catchError(() => sendMessage(db, opened.threadId, outsider.playerId, outsider.sessionSecret, "m1", "hi"));
  expect(err.code).toBe("unauthorized");
});

it("refuses sending once either party has walked apart since the thread was opened", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  // b walks away — a legal step, same path a real client would take.
  // Spawn tiles carry a small random jitter (src/bar.ts's joinBar), so a
  // fixed "+1" offset isn't reliably walkable; try each cardinal
  // direction that actually increases b's distance from a, same
  // robustness the shared HTTP tests already need for the same reason
  // (spec/bar.test.ts).
  const candidates: Array<[number, number]> = [[b.x + 1, b.y], [b.x - 1, b.y], [b.x, b.y + 1], [b.x, b.y - 1]];
  const away = candidates.find(
    ([x, y]) => isValidStep(b.x, b.y, x, y) && Math.abs(x - a.x) + Math.abs(y - a.y) > 1,
  );
  expect(away, "expected at least one walkable neighbour further from a").toBeDefined();
  moveBar(db, b.playerId, b.sessionSecret, away![0], away![1]);
  const err = catchError(() => sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, "m1", "still there?"));
  expect(err.code).toBe("too_far");
});

it("enforces a send-rate limit per sender", () => {
  const { a, b } = adjacentPair();
  const opened = openThread(db, a.playerId, a.sessionSecret, b.playerId);
  let limited = false;
  for (let i = 0; i < 20; i++) {
    try {
      sendMessage(db, opened.threadId, a.playerId, a.sessionSecret, `burst-${i}`, `msg ${i}`);
    } catch (err) {
      if (err instanceof ChatError && err.code === "rate_limited") {
        limited = true;
        break;
      }
      throw err;
    }
  }
  expect(limited).toBe(true);
});
