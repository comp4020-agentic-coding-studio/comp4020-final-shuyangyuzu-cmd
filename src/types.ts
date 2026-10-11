// Shared shapes for the room/game state. See PLAN.md for the rules these
// encode, and CLAUDE.md for the constraints on how they're read and written.

export type Color = "red" | "blue" | "green" | "yellow";

export const COLORS: readonly Color[] = ["red", "blue", "green", "yellow"];

export type Phase = "lobby" | "awaiting_roll" | "awaiting_placement" | "round_end";

export interface Player {
  id: string;
  nickname: string;
  color: Color;
  seat: number;
  diceInHand: number;
  /** Bills won this round, kept as a list (not just a sum) so a later,
   * multi-round version of this app can judge an equal-total tie by who
   * holds more banknotes, per the official rule. */
  wonBills: number[];
  /** Lobby-only. Defaults false on join; the host must ready up too.
   * Meaningless once the game has started (left at whatever it was). */
  ready: boolean;
  /** When this player joined — the sweep's fallback "last seen" baseline
   * until their first heartbeat lands, so nobody is swept as stale in the
   * first few seconds after joining. */
  joinedAt: string;
  /** "human" for every join/create today; flips to "npc" one-way, either
   * when the host adds a Vegas-NPC seat directly (a later phase) or when
   * a departed human's started-game seat is handed off (CLAUDE.md's
   * leave/exit states) — never deleted, never reclaimed by the original
   * human. Defaults "human" everywhere a Player is constructed. */
  controller: "human" | "npc";
}

export interface Casino {
  value: 1 | 2 | 3 | 4 | 5 | 6;
  bills: number[];
  /** playerId -> dice placed here this round. Absent/0 entries are equivalent. */
  placements: Record<string, number>;
  /** Set once this casino settles: playerId -> the single banknote they
   * won here. Absent for a player who was tied out or ranked below the
   * last available bill. Undefined entirely before settlement. */
  payout?: Record<string, number>;
}

export interface LastRoll {
  playerId: string;
  values: number[];
}

/** The room's live, mutable round state. Never sent to a client as-is —
 * see toPublicState, which drops the deck's future order. */
export interface RoomState {
  phase: Phase;
  /** Fixed at game start: join order for round 1. */
  turnOrder: string[];
  currentPlayerId: string | null;
  players: Record<string, Player>;
  lastRoll: LastRoll | null;
  casinos: Casino[];
  /** Remaining banknotes, draw order hidden from clients. Index 0 is the
   * top of the pile (next drawn); pushes to the end go to the bottom. */
  deck: number[];
}

export interface Room {
  id: string;
  code: string;
  hostPlayerId: string;
  createdAt: string;
  closedAt: string | null;
  state: RoomState;
  version: number;
}

/** What a client ever gets to see of a player: never session_secret. */
export interface PublicPlayer {
  id: string;
  nickname: string;
  color: Color;
  seat: number;
  diceInHand: number;
  wonBills: number[];
  moneyTotal: number;
  ready: boolean;
  /** Derived at read time from how recently a heartbeat landed — never
   * stored, so it's never stale (CLAUDE.md). */
  connected: boolean;
  controller: "human" | "npc";
}

export interface PublicCasino {
  value: number;
  bills: number[];
  placements: Record<string, number>;
  payout?: Record<string, number>;
}

export interface PublicState {
  code: string;
  hostPlayerId: string;
  /** Set once the room has closed (host disbanded it, or its last player
   * left). The rest of the payload is still whatever it last was —
   * clients gate on this flag rather than expect a different shape. */
  closed: boolean;
  closedAt: string | null;
  phase: Phase;
  turnOrder: string[];
  currentPlayerId: string | null;
  players: PublicPlayer[];
  lastRoll: LastRoll | null;
  casinos: PublicCasino[];
  /** How many banknotes are left to draw — never their values or order. */
  deckSize: number;
  version: number;
}
