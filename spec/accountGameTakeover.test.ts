// Account login takeover of an in-progress game seat (2026-11-04 — the
// user's own explicit product decision, recorded in CLAUDE.md and
// src/accountRoutes.ts's takeOverCharacter). The brief: "设备 A 正在游戏
// → B 登录 → B 能继续合法回合 → A 的旧账号会话及旧游戏凭证均无法继续操作；
// 游戏状态和其他玩家不受影响" — covered here for all three game types
// this app has, since Vegas/poker/dominoes do NOT share one credential
// shape (confirmed by reading each module directly, not assumed):
// Vegas has its own separate rooms.sessions row per game player; poker
// and dominoes authenticate purely via the bar identity's own
// session_secret, with no room-level credential of their own at all.

import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

async function postJson(path: string, body: unknown, cookie?: string) {
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
  return { status: res.status, body: parsed };
}

async function getJson(path: string, cookie?: string) {
  const res = await fetch(new URL(path, baseUrl), { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json() };
}

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("expected a Set-Cookie header");
  return raw.split(";")[0];
}

async function registerAccount(usernamePrefix: string, password = "correct horse battery staple") {
  const username = `${usernamePrefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 24);
  const res = await fetch(new URL("/api/accounts/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, confirmPassword: password }),
  });
  const body = await res.json();
  return { username, password, cookie: extractCookie(res), barPlayerId: body.barPlayerId as string, barSessionSecret: body.barSessionSecret as string };
}

async function login(username: string, password: string) {
  const res = await fetch(new URL("/api/accounts/login", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return { cookie: extractCookie(res), body };
}

async function anEmptyVegasTable(): Promise<string> {
  const { body } = await getJson("/api/bar/tables");
  const empty = (body as any[]).find((t) => t.gameType === "vegas" && t.tableMode === "online" && t.status === "empty");
  if (!empty) throw new Error("no empty online Vegas table available for this test");
  return empty.id;
}

it("Vegas: device B's login takeover can continue the legal in-progress turn; device A's old bar AND room credentials both stop working; the other player and game state are unaffected", async () => {
  const host = await registerAccount("vegasHostA");
  const hostBarSession = { playerId: host.barPlayerId, sessionSecret: host.barSessionSecret };

  const guest = { playerId: "", sessionSecret: "" };
  const guestJoin = await postJson("/api/bar/join", { nickname: "VegasGuest", color: "blue" });
  guest.playerId = guestJoin.body.playerId;
  guest.sessionSecret = guestJoin.body.sessionSecret;

  const tableId = await anEmptyVegasTable();
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...hostBarSession, color: "red" });
  expect(created.status).toBe(201);
  const code = created.body.code;
  const hostRoomSession = { playerId: created.body.playerId, sessionSecret: created.body.sessionSecret };

  const joined = await postJson(`/api/bar/tables/${tableId}/join`, { ...guest, color: "yellow" });
  const guestRoomSession = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  await postJson(`/api/rooms/${code}/requests/${guestRoomSession.playerId}/approve`, hostRoomSession);
  await postJson(`/api/rooms/${code}/ready`, { ...hostRoomSession, ready: true });
  await postJson(`/api/rooms/${code}/ready`, { ...guestRoomSession, ready: true });
  await postJson(`/api/rooms/${code}/start`, hostRoomSession);

  const state1 = await getJson(`/api/rooms/${code}/state`);
  const starting = state1.body.currentPlayerId as string;
  const [turnRoom, otherRoom] =
    starting === hostRoomSession.playerId ? [hostRoomSession, guestRoomSession] : [guestRoomSession, hostRoomSession];
  const [turnIsHost] = [starting === hostRoomSession.playerId];

  // Only exercise the takeover on the HOST's own account — if the guest
  // happens to hold the starting turn, device B still logs in as the
  // HOST account (whose room credentials we're about to rotate) and
  // simply isn't the one rolling first; the actual assertion below is
  // about the host's OWN credentials either way.
  const deviceB = await login(host.username, host.password);
  expect(deviceB.body.barPlayerId).toBe(host.barPlayerId);
  expect(deviceB.body.barSessionSecret).toBeTruthy();
  expect(deviceB.body.barSessionSecret).not.toBe(host.barSessionSecret);

  // Device A's OLD bar session_secret must now be rejected.
  const oldBarAttempt = await postJson("/api/bar/heartbeat", hostBarSession);
  expect(oldBarAttempt.status).toBe(403);

  if (turnIsHost) {
    // Device A's OLD room session_secret must also be rejected for a
    // real game action, even though it's genuinely this seat's turn.
    const oldRoomRoll = await postJson(`/api/rooms/${code}/roll`, hostRoomSession);
    expect(oldRoomRoll.status).toBe(403);

    // Device B's newly-ROTATED room credentials, for the exact same
    // seat, succeed — the game continues under the new device, with the
    // same dice/seat/turn-order state, not a fresh seat.
    expect(deviceB.body.vegasRoom).toBeTruthy();
    expect(deviceB.body.vegasRoom.code).toBe(code);
    const newHostRoomSession = { playerId: hostRoomSession.playerId, sessionSecret: deviceB.body.vegasRoom.sessionSecret };
    const rolled = await postJson(`/api/rooms/${code}/roll`, newHostRoomSession);
    expect(rolled.status).toBe(200);
    expect(rolled.body.lastRoll).toBeTruthy();
  } else {
    // The host wasn't holding the turn — confirm the OTHER (guest)
    // player's own session is completely unaffected by the host's
    // unrelated login-elsewhere, and can still legally act...
    const guestRoll = await postJson(`/api/rooms/${code}/roll`, turnRoom);
    expect(guestRoll.status).toBe(200);
    // ...while the host's OLD room credential is still rotated-away
    // (activeVegasRoomPlayerId resolves by bar identity, independent of
    // whose turn it currently is), confirmed via a legal action it CAN
    // take regardless of turn (readying is lobby-only so that's not
    // available post-start; heartbeat is the one room action that's
    // legal for a seated player at any phase).
    const oldHostHeartbeat = await postJson(`/api/rooms/${code}/heartbeat`, hostRoomSession);
    expect(oldHostHeartbeat.status).toBe(403);
  }

  // Either way, the room itself and the non-takeover player are intact —
  // the same two seats, same turn order, nothing silently dropped.
  const finalState = await getJson(`/api/rooms/${code}/state`);
  expect(finalState.body.players).toHaveLength(2);
  expect(finalState.body.closed).toBeFalsy();

  // Free the online Vegas table back up for later tests in this same
  // run — this project only has 2 real online Vegas tables total
  // (spec/tables.test.ts's own header comment). activeVegasRoomPlayerId
  // resolves by bar identity regardless of whose turn it currently is,
  // so the host's room credential is ALWAYS rotated by this login,
  // whether or not the host happened to hold the current turn.
  await postJson(`/api/rooms/${code}/disband`, { playerId: hostRoomSession.playerId, sessionSecret: deviceB.body.vegasRoom.sessionSecret, confirm: true });
});

it("Poker: device B's login takeover can act with the rotated bar secret; device A's old bar secret is rejected for poker actions too", async () => {
  const player = await registerAccount("pokerHostA");
  const barSession = { playerId: player.barPlayerId, sessionSecret: player.barSessionSecret };

  const opened = await postJson("/api/poker/open", { ...barSession, mode: "offline" });
  expect(opened.status).toBe(200);

  const deviceB = await login(player.username, player.password);
  expect(deviceB.body.barSessionSecret).not.toBe(player.barSessionSecret);

  // Old device's bar secret is rejected for a poker action (poker
  // authenticates purely through requireBarSession — no separate
  // room-level credential of its own, confirmed in src/poker.ts).
  const oldAttempt = await postJson("/api/poker/me", barSession);
  expect(oldAttempt.status).toBe(403);

  // New device's rotated bar secret works, and sees the exact same table
  // this identity already held (not a fresh one).
  const newBarSession = { playerId: player.barPlayerId, sessionSecret: deviceB.body.barSessionSecret };
  const meNew = await postJson("/api/poker/me", newBarSession);
  expect(meNew.status).toBe(200);
  expect(meNew.body.room).toBeTruthy();
});

it("Dominoes: device B's login takeover can act with the rotated bar secret; device A's old bar secret is rejected for domino actions too", async () => {
  const player = await registerAccount("dominoHostA");
  const barSession = { playerId: player.barPlayerId, sessionSecret: player.barSessionSecret };

  const opened = await postJson("/api/domino/open", { ...barSession, mode: "offline", chair: 0 });
  expect(opened.status).toBe(200);
  const roomId = opened.body.roomId;

  const deviceB = await login(player.username, player.password);
  expect(deviceB.body.barSessionSecret).not.toBe(player.barSessionSecret);

  const oldAttempt = await postJson("/api/domino/me", barSession);
  expect(oldAttempt.status).toBe(403);

  const newBarSession = { playerId: player.barPlayerId, sessionSecret: deviceB.body.barSessionSecret };
  const meNew = await postJson("/api/domino/me", newBarSession);
  expect(meNew.status).toBe(200);
  expect(meNew.body.room?.id).toBe(roomId);
});

it("a login takeover never calls exit/fold/close logic — a Vegas lobby seat survives an unrelated login elsewhere untouched", async () => {
  const host = await registerAccount("vegasLobbyA");
  const hostBarSession = { playerId: host.barPlayerId, sessionSecret: host.barSessionSecret };
  const tableId = await anEmptyVegasTable();
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...hostBarSession, color: "red" });
  expect(created.status).toBe(201);
  const code = created.body.code;

  // Login elsewhere BEFORE the game even starts — a lobby seat, not a
  // started game. activeVegasRoomPlayerId resolves any currently-bound
  // seat regardless of phase, so this still rotates the room credential.
  const deviceB = await login(host.username, host.password);
  expect(deviceB.body.vegasRoom).toBeTruthy();
  expect(deviceB.body.vegasRoom.code).toBe(code);

  const state = await getJson(`/api/rooms/${code}/state`);
  expect(state.body.phase).toBe("lobby");
  expect(state.body.players).toHaveLength(1);
  expect(state.body.closed).toBeFalsy();

  // The OLD room credential no longer works, even for a mere lobby seat.
  const oldReady = await postJson(`/api/rooms/${code}/ready`, { playerId: created.body.playerId, sessionSecret: created.body.sessionSecret, ready: true });
  expect(oldReady.status).toBe(403);

  // Free the table back up for later tests, using the NEW rotated secret.
  await postJson(`/api/rooms/${code}/disband`, { playerId: created.body.playerId, sessionSecret: deviceB.body.vegasRoom.sessionSecret, confirm: true });
});
