// Ready-gating, voluntary leave, host transfer, and disband — playtest
// round 1 in PLAN.md. All black-box over HTTP; the time-based disconnect
// grace itself is covered separately in spec/presence.test.ts (see that
// file's header for why).

import { expect, inject, it } from "vitest";
import {
  createRoom,
  disbandRoom,
  getState,
  joinRoom,
  leaveRoom,
  readyUpAndStart,
  setReady,
  startGame,
} from "./helpers.ts";
import type { Session } from "./helpers.ts";

const baseUrl = inject("baseUrl");

it("a new player defaults to not ready", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  const state = await getState(baseUrl, host.code);
  const bobPublic = state.players.find((p) => p.id === bob.playerId);
  expect(bobPublic?.ready).toBe(false);
});

it("refuses to start until every present player is ready, host included", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;

  // Nobody ready yet.
  let res = await startGame(baseUrl, host.code, host);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("not_all_ready");

  // Only Bob ready — host hasn't readied up.
  await setReady(baseUrl, host.code, bob, true);
  res = await startGame(baseUrl, host.code, host);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("not_all_ready");

  // Host readies too — now it starts.
  await setReady(baseUrl, host.code, host, true);
  res = await startGame(baseUrl, host.code, host);
  expect(res.status).toBe(200);
});

it("can toggle ready back off before starting", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  await setReady(baseUrl, host.code, host, true);
  await setReady(baseUrl, host.code, bob, true);
  await setReady(baseUrl, host.code, bob, false);

  const res = await startGame(baseUrl, host.code, host);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("not_all_ready");
});

it("refuses to toggle ready once the game has started", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  await readyUpAndStart(baseUrl, host.code, host, [host, bob]);

  const res = await setReady(baseUrl, host.code, bob, true);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("not_lobby");
});

it("lets a non-host player leave, releasing their seat immediately", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;

  const res = await leaveRoom(baseUrl, host.code, bob);
  expect(res.status).toBe(200);

  const state = await getState(baseUrl, host.code);
  expect(state.players.map((p) => p.id)).toEqual([host.playerId]);
  expect(state.closed).toBe(false);
});

it("transfers host to the next player by join order when the host leaves", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  const carl = (await joinRoom(baseUrl, host.code, "Carl", "green")).body as Session;

  const res = await leaveRoom(baseUrl, host.code, host);
  expect(res.status).toBe(200);

  const state = await getState(baseUrl, host.code);
  expect(state.hostPlayerId).toBe(bob.playerId); // Bob joined before Carl
  expect(state.players.map((p) => p.id).sort()).toEqual([bob.playerId, carl.playerId].sort());
  expect(state.closed).toBe(false);
});

it("closes the room when the last player leaves", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const res = await leaveRoom(baseUrl, host.code, host);
  expect(res.status).toBe(200);

  const state = await getState(baseUrl, host.code);
  expect(state.closed).toBe(true);
  expect(state.closedAt).not.toBeNull();
});

it("refuses a mutating action on a closed room with 410, distinct from room_not_found", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  await leaveRoom(baseUrl, host.code, host); // last player leaves -> closes

  const join = await joinRoom(baseUrl, host.code, "Nobody", "red");
  expect(join.status).toBe(410);
  expect(join.body.error).toBe("room_closed");

  const missing = await joinRoom(baseUrl, "ZZZZZZ", "Nobody", "red");
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe("room_not_found");
});

it("GET /state on a closed room still answers 200 with closed:true (not an error page)", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  await leaveRoom(baseUrl, host.code, host);

  const state = await getState(baseUrl, host.code);
  expect(state.closed).toBe(true);
});

it("refuses to leave or act once the game has started (existing disconnect-tolerant policy applies instead)", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  await readyUpAndStart(baseUrl, host.code, host, [host, bob]);

  const res = await leaveRoom(baseUrl, host.code, bob);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("not_lobby");
});

it("disband is host-only", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;

  const res = await disbandRoom(baseUrl, host.code, bob, true);
  expect(res.status).toBe(403);
});

it("disband requires explicit confirmation, not just a bare request", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const res = await disbandRoom(baseUrl, host.code, host, false);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("confirm_required");

  const state = await getState(baseUrl, host.code);
  expect(state.closed).toBe(false);
});

it("disband closes the room immediately when confirmed by the host", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;

  const res = await disbandRoom(baseUrl, host.code, host, true);
  expect(res.status).toBe(200);

  const state = await getState(baseUrl, host.code);
  expect(state.closed).toBe(true);
  // Bob's own later actions should now see a closed room, not silence.
  const bobTriesReady = await setReady(baseUrl, host.code, bob, true);
  expect(bobTriesReady.status).toBe(410);
});

it("a player who has left can't act again as if still seated", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  await leaveRoom(baseUrl, host.code, bob);

  const res = await setReady(baseUrl, host.code, bob, true);
  expect(res.status).toBe(410);
  expect(res.body.error).toBe("player_removed");
});
