// Remaining account lifecycle coverage not already in spec/accounts.test.ts
// (core register/login/logout logic) or spec/accountsHttp.test.ts (the
// cookie/session-cookie/multi-device-cookie layer): server-restart
// persistence, guest isolation (a new guest never inherits a previous
// guest/account's data), and a cross-feature identity regression
// confirming speech/orders/eating all still work correctly for a
// logged-in account exactly as they do for a guest, since none of those
// modules were changed by this round and none of them should need to be.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { login, register, verifyAccountSession } from "../src/accounts.ts";
import { joinBar, say, sitAtSeat, updateAppearance } from "../src/bar.ts";
import { BAR_SEATS } from "../src/barLayout.ts";
import { openDb } from "../src/db.ts";
import { placeOrder, startEating } from "../src/orders.ts";
import { currentStamina } from "../src/stamina.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "accounts-lifecycle-test-"));
  db = openDb(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("account data (credentials, character binding, stamina) survives a server restart (reopening the same database file)", () => {
  const path = join(dir, "test.db");
  // Close the beforeEach-opened db and reopen against the same path, so
  // this test controls the file directly rather than relying on the
  // shared `db`/`dir` from beforeEach for the "restart" itself.
  db.close();
  let liveDb = openDb(path);
  const result = register(liveDb, "RestartUser", "correct horse battery staple", null);
  liveDb.prepare(`UPDATE bar_stamina SET value = 42 WHERE player_id = ?`).run(result.barPlayerId);
  liveDb.close();

  // A genuine process restart: a brand-new openDb() call against the
  // same on-disk file, not a cached connection.
  liveDb = openDb(path);
  try {
    const info = verifyAccountSession(liveDb, result.token);
    expect(info.username).toBe("RestartUser");
    const relogged = login(liveDb, "RestartUser", "correct horse battery staple");
    expect(relogged.barPlayerId).toBe(result.barPlayerId);
    expect(currentStamina(liveDb, result.barPlayerId)).toBeCloseTo(42, 1);
  } finally {
    liveDb.close();
  }
  db = openDb(path); // afterEach's own db.close() needs a live handle
});

it("a brand-new guest never inherits a previous guest's or account's data, even in the same browser/session lineage", () => {
  const firstGuest = joinBar(db, "FirstGuest", "red", "warm");
  db.prepare(`UPDATE bar_stamina SET value = 15 WHERE player_id = ?`).run(firstGuest.playerId);
  register(db, "FirstAccount", "correct horse battery staple", { playerId: firstGuest.playerId, sessionSecret: firstGuest.sessionSecret });

  // A brand-new guest join (as if the same browser cleared storage and
  // joined fresh, or a different person opened the app) gets a genuinely
  // new identity — never the prior guest's id, stamina, or anything else.
  const secondGuest = joinBar(db, "SecondGuest", "blue", "tan");
  expect(secondGuest.playerId).not.toBe(firstGuest.playerId);
  expect(currentStamina(db, secondGuest.playerId)).toBeCloseTo(80, 2);
});

it("changing nickname does not switch identity — the same account, same bar identity, before and after", () => {
  const result = register(db, "NicknameTest", "correct horse battery staple", null);
  const before = db.prepare(`SELECT account_id FROM bar_players WHERE id = ?`).get(result.barPlayerId) as { account_id: string };
  updateAppearance(db, result.barPlayerId, result.freshBarSecret!, "ANewNickname", "blue", "tan");
  const after = db.prepare(`SELECT id, account_id, nickname FROM bar_players WHERE id = ?`).get(result.barPlayerId) as {
    id: string;
    account_id: string;
    nickname: string;
  };
  expect(after.id).toBe(result.barPlayerId); // same identity
  expect(after.account_id).toBe(before.account_id); // still the same account
  expect(after.nickname).toBe("ANewNickname"); // display name alone changed
  // A subsequent login still finds the exact same character, unaffected
  // by the rename.
  const relogged = login(db, "NicknameTest", "correct horse battery staple");
  expect(relogged.barPlayerId).toBe(result.barPlayerId);
});

// ---- Cross-feature identity regression: speech, orders, and seated
// eating are all untouched by this round, but a logged-in account's bar
// identity must work through each of them exactly the same way a
// guest's does — nothing about an account should require (or
// accidentally bypass) any of their own existing checks. ----
it("a logged-in account's bar identity can speak, order, and eat/drink exactly like a guest's can", () => {
  const result = register(db, "FullFeatureUser", "correct horse battery staple", null);
  const id = result.barPlayerId, secret = result.freshBarSecret!;

  say(db, id, secret, "msg-1", "Hello from a logged-in account");
  const spoke = db.prepare(`SELECT text FROM bar_speech WHERE player_id = ?`).get(id) as { text: string } | undefined;
  expect(spoke?.text).toBe("Hello from a logged-in account");

  const seat = BAR_SEATS[0];
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(seat.x, seat.y + 1, id);
  sitAtSeat(db, id, secret, seat.id);
  placeOrder(db, id, secret, "soda", null, "account-order-key");
  const before = currentStamina(db, id);
  startEating(db, id, secret, "account-eat-key");
  expect(currentStamina(db, id)).toBeGreaterThan(before);
});
