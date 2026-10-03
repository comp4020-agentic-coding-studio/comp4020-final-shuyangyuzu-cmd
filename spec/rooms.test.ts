// Room lifecycle: create, join, capacity, host-only start, and rejoin —
// product decisions 1, 2 and 6 in PLAN.md. All black-box, over HTTP.

import { expect, inject, it } from "vitest";
import { createRoom, getState, joinRoom, readyUpAndStart, rejoin, startGame } from "./helpers.ts";
import type { Session } from "./helpers.ts";

const baseUrl = inject("baseUrl");

it("creates a room with the host already seated", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const state = await getState(baseUrl, host.code);
  expect(state.hostPlayerId).toBe(host.playerId);
  expect(state.players).toHaveLength(1);
  expect(state.players[0].nickname).toBe("Alice");
  expect(state.phase).toBe("lobby");
});

// Product decision 6: 6 characters, case-insensitive, and excluding
// characters that are easy to mis-type or mis-read aloud.
it("generates a 6-character room code from an unambiguous alphabet", async () => {
  const CONFUSING = /[0O1IL]/;
  for (let i = 0; i < 5; i++) {
    const host = await createRoom(baseUrl, `Host${i}`, "red");
    expect(host.code).toHaveLength(6);
    expect(host.code).toMatch(/^[A-Z0-9]+$/);
    expect(host.code).not.toMatch(CONFUSING);
  }
});

it("lets a second and third player join by code", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = await joinRoom(baseUrl, host.code, "Bob", "blue");
  expect(bob.status).toBe(201);
  const carl = await joinRoom(baseUrl, host.code, "Carl", "green");
  expect(carl.status).toBe(201);

  const state = await getState(baseUrl, host.code);
  expect(state.players.map((p) => p.nickname)).toEqual(["Alice", "Bob", "Carl"]);
});

it("refuses a 5th player (2-4 only)", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  await joinRoom(baseUrl, host.code, "Bob", "blue");
  await joinRoom(baseUrl, host.code, "Carl", "green");
  await joinRoom(baseUrl, host.code, "Dana", "yellow");

  const fifth = await joinRoom(baseUrl, host.code, "Eve", "red");
  expect(fifth.status).toBe(409);
});

it("refuses a color already taken in the room", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const clash = await joinRoom(baseUrl, host.code, "Bob", "red");
  expect(clash.status).toBe(409);
});

it("refuses to join a room that doesn't exist", async () => {
  const res = await joinRoom(baseUrl, "ZZZZZZ", "Nobody", "red");
  expect(res.status).toBe(404);
});

// Product decision 2: only the host can start.
it("refuses to start the game for anyone but the host", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = await joinRoom(baseUrl, host.code, "Bob", "blue");

  const res = await startGame(baseUrl, host.code, bob.body);
  expect(res.status).toBe(403);

  const stillLobby = await getState(baseUrl, host.code);
  expect(stillLobby.phase).toBe("lobby");
});

// Product decision 1: the real start action needs at least 2 players.
it("refuses to start with only the host present", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const res = await startGame(baseUrl, host.code, host);
  expect(res.status).toBe(409);
});

it("starts the game once a second player has joined and everyone is ready", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;

  const res = await readyUpAndStart(baseUrl, host.code, host, [host, bob]);
  expect(res.status).toBe(200);
  expect(res.body.phase).toBe("awaiting_roll");
});

// Product decision 2: seats close once the game has started, but
// existing players can still rejoin.
it("closes new joins once the game has started, but allows rejoin", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = await joinRoom(baseUrl, host.code, "Bob", "blue");
  await readyUpAndStart(baseUrl, host.code, host, [host, bob.body as Session]);

  const lateJoin = await joinRoom(baseUrl, host.code, "Carl", "green");
  expect(lateJoin.status).toBe(409);

  const rejoined = await rejoin(baseUrl, host.code, bob.body);
  expect(rejoined.status).toBe(200);
});

it("refuses rejoin with a wrong session secret", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const res = await rejoin(baseUrl, host.code, { playerId: host.playerId, sessionSecret: "not-the-secret" });
  expect(res.status).toBe(403);
});
