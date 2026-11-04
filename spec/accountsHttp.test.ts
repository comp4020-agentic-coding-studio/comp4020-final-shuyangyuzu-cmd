// HTTP-level coverage for account registration/login/logout
// (src/accountRoutes.ts) — spec/accounts.test.ts already pins down
// src/accounts.ts's own internal logic directly; this file exists
// because the cookie plumbing, same-origin check, and the actual
// in-progress-game-seat takeover only exist at the HTTP layer and can't
// be exercised by calling accounts.ts's functions directly.
//
// Node's fetch doesn't act as a cookie jar across calls the way a real
// browser does, so this file's own tiny `extractCookie`/requests carry
// the cookie by hand between calls — this is what a browser does
// automatically, made explicit here so the test can control exactly
// which "device" (cookie) is making each request.

import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

function extractCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  return raw.split(";")[0]; // "vegas_account=<token>"
}

async function postJson(
  path: string,
  body: unknown,
  cookie?: string | null,
): Promise<{ status: number; body: any; cookie: string | null; res: Response }> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, cookie: extractCookie(res), res };
}

async function getJson(path: string, cookie?: string | null): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json() };
}

let uniqueCounter = 0;
function uniqueUsername(prefix: string): string {
  // Kept within accounts.ts's own 24-char username limit — Date.now()
  // alone, base36, is 8 chars; a per-call counter avoids collisions
  // between tests that run within the same millisecond.
  uniqueCounter += 1;
  return `${prefix}${Date.now().toString(36)}${uniqueCounter}`.slice(0, 24);
}

it("registers, sets a session cookie, and /api/accounts/me reports the logged-in account", async () => {
  const username = uniqueUsername("httpreg");
  const reg = await postJson("/api/accounts/register", { username, password: "correct horse battery staple", confirmPassword: "correct horse battery staple" });
  expect(reg.status).toBe(201);
  expect(reg.cookie).toBeTruthy();
  expect(reg.body.barSessionSecret).toBeTruthy();
  expect(reg.body.barPlayerId).toBeTruthy();

  const me = await getJson("/api/accounts/me", reg.cookie);
  expect(me.body.account.username).toBe(username);
  expect(me.body.barPlayerId).toBe(reg.body.barPlayerId);
});

it("/api/accounts/me reports a guest (no account) when there's no cookie at all", async () => {
  const me = await getJson("/api/accounts/me");
  expect(me.body.account).toBeNull();
});

it("refuses a duplicate username at the HTTP layer with 409", async () => {
  const username = uniqueUsername("httpdupe");
  const first = await postJson("/api/accounts/register", { username, password: "correct horse battery staple", confirmPassword: "correct horse battery staple" });
  expect(first.status).toBe(201);
  const second = await postJson("/api/accounts/register", { username, password: "another password here", confirmPassword: "another password here" });
  expect(second.status).toBe(409);
  expect(second.body.error).toBe("username_taken");
});

it("refuses mismatched confirm-password at the HTTP layer before ever touching the database", async () => {
  const username = uniqueUsername("httpmismatch");
  const res = await postJson("/api/accounts/register", { username, password: "correct horse battery staple", confirmPassword: "different password entirely" });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("password_mismatch");
  // Confirm it genuinely never created the account (not just a
  // different-looking failure for the same underlying success).
  const login = await postJson("/api/accounts/login", { username, password: "correct horse battery staple" });
  expect(login.status).toBe(401);
});

it("logs in with the correct cookie-delivered session, and logout revokes it", async () => {
  const username = uniqueUsername("httplogin");
  const password = "correct horse battery staple";
  await postJson("/api/accounts/register", { username, password, confirmPassword: password });

  const login = await postJson("/api/accounts/login", { username, password });
  expect(login.status).toBe(200);
  expect(login.cookie).toBeTruthy();
  const me = await getJson("/api/accounts/me", login.cookie);
  expect(me.body.account.username).toBe(username);

  const logout = await postJson("/api/accounts/logout", {}, login.cookie);
  expect(logout.status).toBe(200);
  const meAfter = await getJson("/api/accounts/me", login.cookie);
  expect(meAfter.body.account).toBeNull();
});

it("refuses incorrect credentials with 401 and a generic message", async () => {
  const username = uniqueUsername("httpwrong");
  await postJson("/api/accounts/register", { username, password: "correct horse battery staple", confirmPassword: "correct horse battery staple" });
  const res = await postJson("/api/accounts/login", { username, password: "totally wrong password" });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe("invalid_credentials");
});

// ---- Multi-device session policy: a new login elsewhere invalidates the
// previous device's account session cookie — the user's own explicit
// product decision (CLAUDE.md's account section). Same-browser multiple
// tabs share one cookie, so this is specifically about two DIFFERENT
// cookies (simulated here as two separately-held cookie strings, exactly
// as two browsers/devices would each hold their own). ----
it("a login from device B revokes device A's account session, but both share the same underlying character", async () => {
  const username = uniqueUsername("httpmulti");
  const password = "correct horse battery staple";
  const reg = await postJson("/api/accounts/register", { username, password, confirmPassword: password });
  const deviceA = reg.cookie;

  const meA = await getJson("/api/accounts/me", deviceA);
  expect(meA.body.account).not.toBeNull();

  const loginB = await postJson("/api/accounts/login", { username, password });
  const deviceB = loginB.cookie;
  expect(loginB.body.barPlayerId).toBe(reg.body.barPlayerId); // same character

  // Device A's cookie is now stale.
  const meAafter = await getJson("/api/accounts/me", deviceA);
  expect(meAafter.body.account).toBeNull();
  // Device B's cookie is valid.
  const meB = await getJson("/api/accounts/me", deviceB);
  expect(meB.body.account.username).toBe(username);
});

it("same-browser multiple tabs (identical cookie) never log each other out", async () => {
  const username = uniqueUsername("httptabs");
  const password = "correct horse battery staple";
  const reg = await postJson("/api/accounts/register", { username, password, confirmPassword: password });
  const cookie = reg.cookie;

  // Two "tabs" both holding the exact same cookie — neither a fresh
  // login nor a logout happened between these two reads.
  const tab1 = await getJson("/api/accounts/me", cookie);
  const tab2 = await getJson("/api/accounts/me", cookie);
  expect(tab1.body.account.username).toBe(username);
  expect(tab2.body.account.username).toBe(username);
});

it("a cross-site Origin is refused on a state-changing account route", async () => {
  const username = uniqueUsername("httporigin");
  const res = await fetch(new URL("/api/accounts/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ username, password: "correct horse battery staple", confirmPassword: "correct horse battery staple" }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe("bad_origin");
});

it("guest migration at signup: the new account controls the exact pre-existing guest character, not a new one", async () => {
  const guestJoin = await postJson("/api/bar/join", { nickname: "Migratee", color: "blue" });
  const guestSession = { playerId: guestJoin.body.playerId, sessionSecret: guestJoin.body.sessionSecret };

  const username = uniqueUsername("httpmigrate");
  const reg = await postJson("/api/accounts/register", {
    username,
    password: "correct horse battery staple",
    confirmPassword: "correct horse battery staple",
    migrateGuest: guestSession,
  });
  expect(reg.status).toBe(201);
  expect(reg.body.barPlayerId).toBe(guestSession.playerId);
  // No fresh secret reported — the browser already holds the real one
  // for this identity (it's the same browser that was already the guest).
  expect(reg.body.barSessionSecret).toBeUndefined();

  // The original guest session_secret still works — migration never
  // rotated it (only a later LOGIN's takeover does that).
  const appearance = await postJson("/api/bar/appearance", { ...guestSession, nickname: "Migratee", color: "blue", skin: "warm" });
  expect(appearance.status).toBe(200);
});

// ---- Explicit logout must revoke more than just the account cookie —
// CLAUDE.md: "旧的 bar/game session 路径也要检查，不能让退出后残留的旧凭证
// 绕过新会话机制". A cached or leaked copy of this browser's own bar
// session_secret must stop working the instant logout completes, the
// same rotation a new-device login already performs — just with the
// freshly-minted secret handed to nobody, since there is no "new device"
// at logout time. ----
it("explicit logout rotates this account's bar session_secret, not just the account cookie — a cached copy of the old secret stops working", async () => {
  const username = uniqueUsername("httplogoutrot");
  const password = "correct horse battery staple";
  const reg = await postJson("/api/accounts/register", { username, password, confirmPassword: password });
  const oldBarSecret = reg.body.barSessionSecret;
  const barPlayerId = reg.body.barPlayerId;

  const beforeLogout = await postJson("/api/bar/heartbeat", { playerId: barPlayerId, sessionSecret: oldBarSecret });
  expect(beforeLogout.status).toBe(200);

  const logout = await postJson("/api/accounts/logout", {}, reg.cookie);
  expect(logout.status).toBe(200);

  const afterLogout = await postJson("/api/bar/heartbeat", { playerId: barPlayerId, sessionSecret: oldBarSecret });
  expect(afterLogout.status).toBe(403);
});

it("explicit logout also rotates an actively-bound Vegas room's own session_secret", async () => {
  const username = uniqueUsername("httplogoutroom");
  const password = "correct horse battery staple";
  const reg = await postJson("/api/accounts/register", { username, password, confirmPassword: password });
  const barSession = { playerId: reg.body.barPlayerId, sessionSecret: reg.body.barSessionSecret };

  const tablesRes = await getJson("/api/bar/tables");
  const emptyTable = tablesRes.body.find((t: any) => t.gameType === "vegas" && t.tableMode === "online" && t.status === "empty");
  const created = await postJson(`/api/bar/tables/${emptyTable.id}/create`, { ...barSession, color: "red" });
  const roomSession = { playerId: created.body.playerId, sessionSecret: created.body.sessionSecret };

  await postJson("/api/accounts/logout", {}, reg.cookie);

  const oldRoomAttempt = await postJson(`/api/rooms/${created.body.code}/ready`, { ...roomSession, ready: true });
  expect(oldRoomAttempt.status).toBe(403);

  // Clean up — log back in to get a fresh credential and disband, so
  // this doesn't permanently consume one of only 2 online Vegas tables.
  const relogin = await postJson("/api/accounts/login", { username, password });
  await postJson(`/api/rooms/${created.body.code}/disband`, {
    playerId: roomSession.playerId,
    sessionSecret: relogin.body.vegasRoom.sessionSecret,
    confirm: true,
  });
});
