// The turn engine and settlement, as pure functions over RoomState. Kept
// free of I/O and of Express/Hono/SQLite so they're directly unit-testable;
// src/rooms.ts is what wraps a call to one of these in a DB transaction.
//
// Rules citation: PLAN.md, itself citing the official rulebook. The four
// worked examples in spec/settlement.test.ts are taken from that PDF
// verbatim and are what this file is built to satisfy.

import { dealToMinimum } from "./deck.ts";
import type { Rng } from "./rng.ts";
import { rollDice } from "./rng.ts";
import type { Casino, Player, RoomState } from "./types.ts";

export class GameError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function clone(state: RoomState): RoomState {
  // structuredClone is fine here: everything in RoomState is plain
  // data (no functions, no class instances) by construction.
  return structuredClone(state);
}

export function startGame(state: RoomState, rng: Rng): RoomState {
  if (state.phase !== "lobby") {
    throw new GameError("the game has already started", "already_started");
  }
  const players = Object.values(state.players);
  if (players.length < 2) {
    throw new GameError("at least 2 players are needed to start", "not_enough_players");
  }

  const next = clone(state);
  const turnOrder = players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.id);

  let deck = shuffleDeck(next.deck, rng);
  const casinos: Casino[] = [];
  for (let value = 1 as 1 | 2 | 3 | 4 | 5 | 6; value <= 6; value++) {
    const { drawn, remaining } = dealToMinimum(deck);
    casinos.push({ value, bills: drawn, placements: {} });
    deck = remaining;
  }

  for (const id of turnOrder) {
    next.players[id].diceInHand = 8;
    next.players[id].wonBills = [];
  }

  next.turnOrder = turnOrder;
  next.currentPlayerId = turnOrder[0];
  next.casinos = casinos;
  next.deck = deck;
  next.lastRoll = null;
  next.phase = "awaiting_roll";
  return next;
}

function shuffleDeck(deck: number[], rng: Rng): number[] {
  const result = deck.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function applyRoll(state: RoomState, playerId: string, rng: Rng): RoomState {
  if (state.phase !== "awaiting_roll") {
    throw new GameError("the room isn't waiting on a roll right now", "wrong_phase");
  }
  if (state.currentPlayerId !== playerId) {
    throw new GameError("it isn't your turn", "not_your_turn");
  }
  const player = state.players[playerId];
  if (!player || player.diceInHand <= 0) {
    throw new GameError("you have no dice left to roll", "no_dice");
  }

  const next = clone(state);
  const values = rollDice(player.diceInHand, rng);
  next.lastRoll = { playerId, values };
  next.phase = "awaiting_placement";
  return next;
}

export function applyPlacement(state: RoomState, playerId: string, value: number): RoomState {
  if (state.phase !== "awaiting_placement") {
    throw new GameError("there's no roll waiting to be placed right now", "wrong_phase");
  }
  if (state.currentPlayerId !== playerId) {
    throw new GameError("it isn't your turn", "not_your_turn");
  }
  if (!state.lastRoll || state.lastRoll.playerId !== playerId) {
    throw new GameError("there's no roll of yours waiting to be placed", "no_roll");
  }
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new GameError("not a valid die value", "bad_value");
  }
  const count = state.lastRoll.values.filter((v) => v === value).length;
  if (count === 0) {
    throw new GameError("you didn't roll that value", "value_not_rolled");
  }

  const next = clone(state);
  const casino = next.casinos[value - 1];
  casino.placements[playerId] = (casino.placements[playerId] ?? 0) + count;
  next.players[playerId].diceInHand -= count;
  next.lastRoll = null;

  const nextPlayerId = findNextPlayerWithDice(next, playerId);
  if (nextPlayerId === null) {
    return settleRound(next);
  }
  next.currentPlayerId = nextPlayerId;
  next.phase = "awaiting_roll";
  return next;
}

function findNextPlayerWithDice(state: RoomState, afterPlayerId: string): string | null {
  const order = state.turnOrder;
  const startIndex = order.indexOf(afterPlayerId);
  for (let step = 1; step <= order.length; step++) {
    const id = order[(startIndex + step) % order.length];
    if (state.players[id].diceInHand > 0) return id;
  }
  return null;
}

/** One casino's payout, per the official rule:
 *  1. any two-or-more-way tie on dice count cancels those players out —
 *     they win nothing here;
 *  2. the untied are ranked by dice count descending;
 *  3. highest gets the casino's highest banknote, next gets the next, etc.;
 *  4. more ranked players than banknotes: the lowest-ranked miss out;
 *  5. any banknote left over goes to the bottom of the draw pile. */
function settleCasino(
  casino: Casino,
  deck: number[],
): { payouts: Map<string, number[]>; deck: number[] } {
  const byCount = new Map<number, string[]>();
  for (const [playerId, count] of Object.entries(casino.placements)) {
    if (count <= 0) continue;
    const group = byCount.get(count) ?? [];
    group.push(playerId);
    byCount.set(count, group);
  }

  const rankedPlayers = [...byCount.keys()]
    .sort((a, b) => b - a)
    .flatMap((count) => {
      const group = byCount.get(count)!;
      return group.length === 1 ? group : []; // a tie cancels the whole group
    });

  const sortedBills = [...casino.bills].sort((a, b) => b - a);
  const payouts = new Map<string, number[]>();
  for (let i = 0; i < rankedPlayers.length && i < sortedBills.length; i++) {
    payouts.set(rankedPlayers[i], [sortedBills[i]]);
  }
  const leftover = sortedBills.slice(rankedPlayers.length);
  return { payouts, deck: [...deck, ...leftover] };
}

export function settleRound(state: RoomState): RoomState {
  const next = clone(state);
  let deck = next.deck;
  for (const casino of next.casinos) {
    const { payouts, deck: deckAfter } = settleCasino(casino, deck);
    deck = deckAfter;
    casino.payout = {};
    for (const [playerId, bills] of payouts) {
      next.players[playerId].wonBills.push(...bills);
      casino.payout[playerId] = bills[0];
    }
    casino.bills = [];
  }
  next.deck = deck;
  next.currentPlayerId = null;
  next.lastRoll = null;
  next.phase = "round_end";
  return next;
}

export function diceConservationHolds(state: RoomState): boolean {
  const players = Object.values(state.players) as Player[];
  const inHand = players.reduce((sum, p) => sum + p.diceInHand, 0);
  const placed = state.casinos.reduce(
    (sum, c) => sum + Object.values(c.placements).reduce((s, n) => s + n, 0),
    0,
  );
  return inHand + placed === players.length * 8;
}
