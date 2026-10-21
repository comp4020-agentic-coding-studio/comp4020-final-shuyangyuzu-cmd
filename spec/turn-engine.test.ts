// Server-authoritative turn/phase enforcement (CLAUDE.md): whose turn it
// is, what phase the room is in, and that a request's session actually
// proves who it claims to be — all re-checked server-side regardless of
// what the client sends.

import { expect, inject, it } from "vitest";
import { createRoom, getState, joinRoom, placeDice, playFullRound, readyUpAndStart, rollDice } from "./helpers.ts";
import type { Session } from "./helpers.ts";

const baseUrl = inject("baseUrl");

async function startedTwoPlayerRoom(): Promise<{ code: string; host: Session; bob: Session }> {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  await readyUpAndStart(baseUrl, host.code, host, [host, bob]);
  const state=await getState(baseUrl,host.code);
  // These aliases are the first actor and the other actor, not host authority.
  return { code:host.code, host:state.currentPlayerId===host.playerId?host:bob, bob:state.currentPlayerId===host.playerId?bob:host };
}

it("refuses to roll out of turn", async () => {
  const { code, bob } = await startedTwoPlayerRoom();
  const res = await rollDice(baseUrl, code, bob); // the non-current player
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("not_your_turn");
});

it("refuses an action with a wrong session secret, even for the right player id", async () => {
  const { code, host } = await startedTwoPlayerRoom();
  const res = await rollDice(baseUrl, code, { playerId: host.playerId, sessionSecret: "wrong" });
  expect(res.status).toBe(403);
});

it("refuses a duplicate roll while a placement is still pending (idempotency)", async () => {
  const { code, host } = await startedTwoPlayerRoom();
  const first = await rollDice(baseUrl, code, host);
  expect(first.status).toBe(200);

  // A doubled click/retry of the same roll request must not re-roll —
  // the phase has already moved on.
  const second = await rollDice(baseUrl, code, host);
  expect(second.status).toBe(409);
  expect(second.body.error).toBe("wrong_phase");
});

it("refuses placing a value that wasn't rolled", async () => {
  const { code, host, bob } = await startedTwoPlayerRoom();
  const sessions: Record<string, Session> = { [host.playerId]: host, [bob.playerId]: bob };
  let state = await getState(baseUrl, code);
  // Eight dice CAN show all six faces. Advance legitimate turns until
  // a missing face exists; by a hand of five dice this is guaranteed.
  for (let turn = 0; turn < 8; turn++) {
    const actor = sessions[state.currentPlayerId!];
    const rolled = await rollDice(baseUrl, code, actor);
    expect(rolled.status).toBe(200);
    const values = new Set<number>(rolled.body.lastRoll.values);
    const absent = [1, 2, 3, 4, 5, 6].find((v) => !values.has(v));
    if (absent !== undefined) {
      const res = await placeDice(baseUrl, code, actor, absent);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("value_not_rolled");
      expect(await getState(baseUrl, code)).toEqual(rolled.body);
      return;
    }
    const placed = await placeDice(baseUrl, code, actor, rolled.body.lastRoll.values[0]);
    expect(placed.status).toBe(200);
    state = placed.body;
  }
  throw new Error("No missing face after eight valid turns");
});

it("refuses a duplicate placement of the same roll (idempotency)", async () => {
  const { code, host } = await startedTwoPlayerRoom();
  const rolled = await rollDice(baseUrl, code, host);
  const value = rolled.body.lastRoll.values[0];

  const first = await placeDice(baseUrl, code, host, value);
  expect(first.status).toBe(200);

  // Retrying the exact same placement must not double-apply it — by the
  // time it would be re-processed, the turn (and usually the phase) has
  // already moved on.
  const second = await placeDice(baseUrl, code, host, value);
  expect(second.status).toBe(409);
});

it("conserves dice across a full round: everyone's 8 are always accounted for", async () => {
  const host = await createRoom(baseUrl, "Alice", "red");
  const bob = (await joinRoom(baseUrl, host.code, "Bob", "blue")).body as Session;
  const carl = (await joinRoom(baseUrl, host.code, "Carl", "green")).body as Session;
  await readyUpAndStart(baseUrl, host.code, host, [host, bob, carl]);

  const sessions: Record<string, Session> = {
    [host.playerId]: host,
    [bob.playerId]: bob,
    [carl.playerId]: carl,
  };
  const final = await playFullRound(baseUrl, host.code, sessions);

  expect(final.phase).toBe("round_end");
  const inHand = final.players.reduce((sum, p) => sum + p.diceInHand, 0);
  const placed = final.casinos.reduce(
    (sum, c) => sum + Object.values(c.placements).reduce((s, n) => s + n, 0),
    0,
  );
  expect(inHand).toBe(0);
  expect(placed).toBe(final.players.length * 8);
});

it("skips a player who has run out of dice rather than waiting on them", async () => {
  // Not practical to force via the public API without pinning exact
  // rolls, so this checks the observable consequence instead: by
  // round_end every player's hand is empty, including whoever finished
  // first and had to be skipped for the rest of the round.
  const final = await (async () => {
    const r = await startedTwoPlayerRoom();
    const sessions: Record<string, Session> = { [r.host.playerId]: r.host, [r.bob.playerId]: r.bob };
    return playFullRound(baseUrl, r.code, sessions);
  })();
  for (const p of final.players) {
    expect(p.diceInHand).toBe(0);
  }
});

it("never exposes a session_secret in any state response", async () => {
  const { code } = await startedTwoPlayerRoom();
  const state = await getState(baseUrl, code);
  expect(JSON.stringify(state)).not.toMatch(/sessionSecret|session_secret/i);
});

it("never exposes the undrawn deck's contents, only its size", async () => {
  const { code } = await startedTwoPlayerRoom();
  const state = await getState(baseUrl, code);
  expect(typeof state.deckSize).toBe("number");
  expect((state as unknown as Record<string, unknown>).deck).toBeUndefined();
});
