// Shared black-box HTTP helpers for the game's own spec tests. Everything
// here goes through the same public API a browser would use — no
// reaching into src/ internals, per the course's "assert the contract"
// guidance (see the start skill: tests should survive a change of
// approach or stack).

import type { Color, PublicState } from "../src/types.ts";

export interface Session {
  playerId: string;
  sessionSecret: string;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

export async function createRoom(
  baseUrl: string,
  nickname: string,
  color: Color,
): Promise<Session & { code: string }> {
  const { status, body } = await postJson(new URL("/api/rooms", baseUrl).toString(), { nickname, color });
  if (status !== 201) throw new Error(`createRoom failed: ${JSON.stringify(body)}`);
  return body;
}

export async function joinRoom(
  baseUrl: string,
  code: string,
  nickname: string,
  color: Color,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/join`, baseUrl).toString(), { nickname, color });
}

export async function getState(baseUrl: string, code: string): Promise<PublicState> {
  const res = await fetch(new URL(`/api/rooms/${code}/state`, baseUrl));
  if (res.status !== 200) throw new Error(`getState failed: ${res.status}`);
  return res.json();
}

export async function startGame(
  baseUrl: string,
  code: string,
  session: Session,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/start`, baseUrl).toString(), session);
}

export async function setReady(
  baseUrl: string,
  code: string,
  session: Session,
  ready: boolean,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/ready`, baseUrl).toString(), { ...session, ready });
}

export async function leaveRoom(
  baseUrl: string,
  code: string,
  session: Session,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/leave`, baseUrl).toString(), session);
}

export async function disbandRoom(
  baseUrl: string,
  code: string,
  session: Session,
  confirm: boolean,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/disband`, baseUrl).toString(), { ...session, confirm });
}

export async function heartbeat(
  baseUrl: string,
  code: string,
  session: Session,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/heartbeat`, baseUrl).toString(), session);
}

/** Marks every given session ready, then starts the game — the setup
 * every turn-engine/settlement test needs now that start requires
 * everyone (host included) to be ready, not just present. */
export async function readyUpAndStart(
  baseUrl: string,
  code: string,
  host: Session,
  sessions: readonly Session[],
): Promise<{ status: number; body: any }> {
  for (const s of sessions) {
    const res = await setReady(baseUrl, code, s, true);
    if (res.status !== 200) throw new Error(`setReady failed: ${JSON.stringify(res.body)}`);
  }
  return startGame(baseUrl, code, host);
}

export async function rollDice(
  baseUrl: string,
  code: string,
  session: Session,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/roll`, baseUrl).toString(), session);
}

export async function placeDice(
  baseUrl: string,
  code: string,
  session: Session,
  value: number,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/place`, baseUrl).toString(), { ...session, value });
}

export async function rejoin(
  baseUrl: string,
  code: string,
  session: Session,
): Promise<{ status: number; body: any }> {
  return postJson(new URL(`/api/rooms/${code}/rejoin`, baseUrl).toString(), session);
}

/** Plays one full room (2-4 players, each already created/joined) to
 * round_end, always placing the first value in each roll. Dice values
 * are server-rolled (CLAUDE.md: server-authoritative RNG), so this can't
 * pin an exact outcome — see spec/settlement.test.ts for how the tie
 * rule is still checked precisely despite that. */
export async function playFullRound(
  baseUrl: string,
  code: string,
  sessions: Record<string, Session>,
): Promise<PublicState> {
  let state = await getState(baseUrl, code);
  let guard = 0;
  while (state.phase !== "round_end" && state.phase !== "game_end") {
    if (++guard > 200) throw new Error("playFullRound: too many turns, something's stuck");
    const session = sessions[state.currentPlayerId!];
    const rolled = await rollDice(baseUrl, code, session);
    if (rolled.status !== 200) throw new Error(`roll failed: ${JSON.stringify(rolled.body)}`);
    const value = rolled.body.lastRoll.values[0];
    const placed = await placeDice(baseUrl, code, session, value);
    if (placed.status !== 200) throw new Error(`place failed: ${JSON.stringify(placed.body)}`);
    state = placed.body;
  }
  return state;
}
