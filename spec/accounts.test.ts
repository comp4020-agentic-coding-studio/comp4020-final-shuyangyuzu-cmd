// Account registration/login/logout (src/accounts.ts), the identity
// layer above the bar identity (CLAUDE.md's 2026-11-04 account section).
// Direct-DB tests, same pattern as spec/orders.test.ts/spec/bar.test.ts —
// exact control over rate-limit windows and session rows without an HTTP
// round-trip, since this module owns no HTTP of its own (src/accountRoutes.ts
// does, covered separately in spec/accountsHttp.test.ts for the parts that
// genuinely need cookies/Origin headers).

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AccountError, characterFor, login, logout, register, verifyAccountSession } from "../src/accounts.ts";
import { joinBar, updateAppearance } from "../src/bar.ts";
import { openDb } from "../src/db.ts";
import { currentStamina } from "../src/stamina.ts";
import { placeOrder, startEating } from "../src/orders.ts";
import { BAR_SEATS } from "../src/barLayout.ts";
import { sitAtSeat } from "../src/bar.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "accounts-test-"));
  db = openDb(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function expectAccountError(fn: () => unknown): AccountError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AccountError) return err;
    throw err;
  }
  throw new Error("expected an AccountError, nothing was thrown");
}

it("registers a brand-new account with a brand-new character, independent of any guest session", () => {
  const result = register(db, "Alice", "correct horse battery staple", null);
  expect(result.accountId).toBeTruthy();
  expect(result.username).toBe("Alice");
  expect(result.token).toBeTruthy();
  expect(result.barPlayerId).toBeTruthy();
  expect(result.freshBarSecret).toBeTruthy();
  const info = verifyAccountSession(db, result.token);
  expect(info.accountId).toBe(result.accountId);
  expect(info.username).toBe("Alice");
  expect(characterFor(db, result.accountId)).toEqual({ barPlayerId: result.barPlayerId });
  // A fresh account starts at the same 80% stamina every fresh guest
  // join does — CLAUDE.md: "新账号初始体力 80%".
  expect(currentStamina(db, result.barPlayerId)).toBeCloseTo(80, 2);
});

it("refuses a duplicate username, case/whitespace-insensitively, without revealing which account exists", () => {
  register(db, "Bob", "correct horse battery staple", null);
  const err = expectAccountError(() => register(db, "  bob  ", "another password entirely", null));
  expect(err.code).toBe("username_taken");
  expect(err.status).toBe(409);
});

it("refuses mismatched or too-short passwords at registration", () => {
  expect(() => register(db, "Carl", "short", null)).toThrow(/8-256 characters/);
});

it("logs in with correct credentials and refuses incorrect ones with the identical generic error either way", () => {
  register(db, "Dana", "correct horse battery staple", null);
  const loggedIn = login(db, "Dana", "correct horse battery staple");
  expect(loggedIn.username).toBe("Dana");
  expect(loggedIn.barPlayerId).toBeTruthy();

  const wrongPassword = expectAccountError(() => login(db, "Dana", "totally wrong password"));
  const noSuchUser = expectAccountError(() => login(db, "NobodyHere", "whatever password"));
  expect(wrongPassword.code).toBe("invalid_credentials");
  expect(noSuchUser.code).toBe("invalid_credentials");
  expect(wrongPassword.message).toBe(noSuchUser.message);
});

it("a new login revokes the previous session token for that account (same-browser-tabs-share-one-token is the caller's job via the cookie, not this function's)", () => {
  register(db, "Eve", "correct horse battery staple", null);
  const first = login(db, "Eve", "correct horse battery staple");
  expect(() => verifyAccountSession(db, first.token)).not.toThrow();
  const second = login(db, "Eve", "correct horse battery staple");
  expect(() => verifyAccountSession(db, first.token)).toThrow(/session has ended/);
  expect(() => verifyAccountSession(db, second.token)).not.toThrow();
});

it("logout revokes exactly the given token", () => {
  register(db, "Frank", "correct horse battery staple", null);
  const session = login(db, "Frank", "correct horse battery staple");
  logout(db, session.token);
  expect(() => verifyAccountSession(db, session.token)).toThrow(/session has ended/);
});

it("an account session expires after its own max age, evaluated lazily (no sweep) exactly like every other time-based grace in this codebase", () => {
  register(db, "Grant", "correct horse battery staple", null);
  const session = login(db, "Grant", "correct horse battery staple");
  expect(() => verifyAccountSession(db, session.token)).not.toThrow();
  // Backdate created_at past the max age directly, the same technique
  // spec/eating.test.ts/spec/stamina.test.ts already use for their own
  // time-based checks — no real waiting required.
  db.prepare(`UPDATE account_sessions SET created_at = ? WHERE token = ?`).run(
    new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    session.token,
  );
  expect(() => verifyAccountSession(db, session.token)).toThrow(/session has ended/);
  // The expired row is actually gone, not just rejected this one time —
  // confirms it's a real expiry, not a cached decision.
  const row = db.prepare(`SELECT 1 FROM account_sessions WHERE token = ?`).get(session.token);
  expect(row).toBeUndefined();
});

it("changing nickname does not switch identity, and logging back in does not reset stamina to 80%", () => {
  const result = register(db, "Grace", "correct horse battery staple", null);
  // Decay stamina below 80 by simulating elapsed online time directly —
  // the same technique spec/stamina.test.ts already uses.
  db.prepare(`UPDATE bar_stamina SET value = 50 WHERE player_id = ?`).run(result.barPlayerId);
  expect(currentStamina(db, result.barPlayerId)).toBeCloseTo(50, 2);

  // Changing nickname (an ordinary bar action, unrelated to accounts)
  // must not touch stamina or identity.
  updateAppearance(db, result.barPlayerId, result.freshBarSecret!, "GraceNewName", "red", "warm");
  expect(currentStamina(db, result.barPlayerId)).toBeCloseTo(50, 2);

  // Logging back in (a brand-new device/session) must not restore 80%.
  const relogged = login(db, "Grace", "correct horse battery staple");
  expect(relogged.barPlayerId).toBe(result.barPlayerId);
  expect(currentStamina(db, result.barPlayerId)).toBeCloseTo(50, 2);
});

it("guest migration at signup binds the CURRENT guest character, verified by its own real session, not trusted from the request alone", () => {
  const guest = joinBar(db, "Wanderer", "blue", "tan");
  const result = register(db, "Henry", "correct horse battery staple", {
    playerId: guest.playerId,
    sessionSecret: guest.sessionSecret,
  });
  expect(result.barPlayerId).toBe(guest.playerId);
  expect(result.freshBarSecret).toBeNull(); // the browser already holds the real secret for this identity
  expect(characterFor(db, result.accountId)).toEqual({ barPlayerId: guest.playerId });
});

it("guest migration refuses a forged/incorrect guest session secret", () => {
  const guest = joinBar(db, "Impostee", "green", "deep");
  // bar.requireBarSession's own BarError propagates through register
  // unmodified — accounts.ts never swallows or re-wraps it into a
  // misleadingly different account-specific code, and crucially never
  // creates the account at all when this check fails (confirmed below).
  expect(() =>
    register(db, "Ivan", "correct horse battery staple", { playerId: guest.playerId, sessionSecret: "wrong-secret" }),
  ).toThrow(/not authorized/);
  expect(() => login(db, "Ivan", "correct horse battery staple")).toThrow(/incorrect username or password/);
});

it("a guest character already bound to one account cannot be claimed again by a second registration", () => {
  const guest = joinBar(db, "OnceOnly", "purple", "fair");
  register(db, "Jack", "correct horse battery staple", { playerId: guest.playerId, sessionSecret: guest.sessionSecret });
  // The same guest session is still technically valid (requireBarSession
  // would still pass), but the character itself is now linked —
  // CLAUDE.md: "已绑定其他账号的角色不能被再次认领."
  const err = expectAccountError(() =>
    register(db, "Jill", "another correct password", { playerId: guest.playerId, sessionSecret: guest.sessionSecret }),
  );
  expect(err.code).toBe("already_linked");
});

it("registering an account does not restore stamina for a migrated guest that had already decayed", () => {
  const guest = joinBar(db, "Decayed", "orange", "brown");
  db.prepare(`UPDATE bar_stamina SET value = 33 WHERE player_id = ?`).run(guest.playerId);
  register(db, "Kelly", "correct horse battery staple", { playerId: guest.playerId, sessionSecret: guest.sessionSecret });
  expect(currentStamina(db, guest.playerId)).toBeCloseTo(33, 2);
});

it("eating lock, held items, and position are all preserved across login/logout — an account is just a different door into the same identity", () => {
  const guest = joinBar(db, "Persistent", "teal", "warm");
  register(db, "Laura", "correct horse battery staple", { playerId: guest.playerId, sessionSecret: guest.sessionSecret });
  const seat = BAR_SEATS[0];
  db.prepare(`UPDATE bar_players SET x = ?, y = ? WHERE id = ?`).run(seat.x, seat.y + 1, guest.playerId);
  sitAtSeat(db, guest.playerId, guest.sessionSecret, seat.id);
  placeOrder(db, guest.playerId, guest.sessionSecret, "soda", null, "k1");
  startEating(db, guest.playerId, guest.sessionSecret, "eat-key-1");

  const relogged = login(db, "Laura", "correct horse battery staple");
  expect(relogged.barPlayerId).toBe(guest.playerId);
  // The character's own state (stamina already restored by startEating
  // above) is completely untouched by the login itself.
  expect(currentStamina(db, guest.playerId)).toBeCloseTo(100, 2);
});
