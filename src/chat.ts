// Proximity-triggered 1:1 chat (product-direction-update, part 3). A
// thread exists per unordered pair of bar identities — never a tavern-
// wide broadcast, never readable by anyone but its two participants
// (CLAUDE.md: the existing public bar SSE channel must never carry a
// private message's body, and this module's own reads/writes are each
// gated on the caller actually being one of the two).
//
// "Online and adjacent" is re-checked here at both open and send time,
// using the same effective-position notion src/bar.ts's own tile
// occupancy already uses (src/position.ts) — a game-table occupant's
// real chair tile, never a frozen pre-game coordinate, so a chat
// started with someone mid-game targets where they're actually sitting.

import type Database from "better-sqlite3";
import { requireBarSession } from "./bar.ts";
import { isConnected } from "./presence.ts";
import { effectivePosition } from "./position.ts";

export class ChatError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MAX_MESSAGE_LENGTH = 500;

// A simple in-memory sliding-window limiter, the same style as every
// other time-based in-memory structure in this codebase (e.g.
// src/server.ts's npcTurnInFlight) — reasonable at this app's scale, and
// env-overridable for the same reason PRESENCE_STALE_MS etc. are
// (src/presence.ts), so a dedicated test can trip it without sending a
// production-sized burst of messages.
const RATE_LIMIT_COUNT = Number(process.env.CHAT_RATE_LIMIT_COUNT ?? 5);
const RATE_LIMIT_WINDOW_MS = Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS ?? 10000);
const sendTimestamps = new Map<string, number[]>();

function checkRateLimit(playerId: string, now: number): void {
  const recent = (sendTimestamps.get(playerId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_COUNT) {
    throw new ChatError("sending too fast — wait a moment", "rate_limited", 429);
  }
  recent.push(now);
  sendTimestamps.set(playerId, recent);
}

export function threadIdFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

function requireOnline(db: Database.Database, playerId: string, now: Date): void {
  const row = db.prepare(`SELECT last_seen_at FROM bar_presence WHERE player_id = ?`).get(playerId) as
    | { last_seen_at: string }
    | undefined;
  if (!row || !isConnected(row.last_seen_at, now)) {
    throw new ChatError("that person isn't in the bar right now", "recipient_offline", 409);
  }
}

/** Manhattan distance of exactly 1 — a direct N/S/E/W neighbour, the same
 * "adjacent" the approach-tile walk (public/tavern.js) always lands
 * exactly on, never a looser "within range" notion. */
function requireAdjacent(db: Database.Database, aId: string, bId: string): void {
  const a = effectivePosition(db, aId);
  const b = effectivePosition(db, bId);
  if (!a || !b) throw new ChatError("could not locate both patrons", "not_found", 404);
  const dist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  if (dist !== 1) throw new ChatError("you need to be standing right next to them", "too_far", 409);
}

export interface ChatMessage {
  id: number;
  threadId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

interface ChatThreadRow {
  player_a: string;
  player_b: string;
}

function requireParticipant(db: Database.Database, threadId: string, playerId: string): ChatThreadRow {
  const row = db.prepare(`SELECT player_a, player_b FROM chat_threads WHERE id = ?`).get(threadId) as
    | ChatThreadRow
    | undefined;
  if (!row || (row.player_a !== playerId && row.player_b !== playerId)) {
    throw new ChatError("not your conversation", "unauthorized", 403);
  }
  return row;
}

function otherParticipant(row: ChatThreadRow, playerId: string): string {
  return row.player_a === playerId ? row.player_b : row.player_a;
}

export function listMessages(db: Database.Database, threadId: string, afterId = 0, limit = 200): ChatMessage[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  return db
    .prepare(
      `SELECT id, thread_id as threadId, sender_id as senderId, body, created_at as createdAt
       FROM chat_messages WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(threadId, afterId, capped) as ChatMessage[];
}

export interface OpenedThread {
  threadId: string;
  otherPlayerId: string;
  otherNickname: string;
  messages: ChatMessage[];
}

/** Opens (creating if needed) the thread between `playerId` and
 * `otherPlayerId` — re-validates both are online and adjacent right now,
 * the same gate sending a message re-checks, so a client can't open a
 * dialog by racing ahead of its own walk-there animation. Idempotent:
 * re-opening an existing thread just hands back its history, never a
 * second thread for the same pair (the id is the pair itself). */
export function openThread(
  db: Database.Database,
  playerId: string,
  sessionSecret: string,
  otherPlayerId: string,
): OpenedThread {
  requireBarSession(db, playerId, sessionSecret);
  if (playerId === otherPlayerId) throw new ChatError("that's you", "self_chat", 400);
  const other = db.prepare(`SELECT nickname FROM bar_players WHERE id = ?`).get(otherPlayerId) as
    | { nickname: string }
    | undefined;
  if (!other) throw new ChatError("no such patron", "not_found", 404);

  const now = new Date();
  requireOnline(db, playerId, now);
  requireOnline(db, otherPlayerId, now);
  requireAdjacent(db, playerId, otherPlayerId);

  const threadId = threadIdFor(playerId, otherPlayerId);
  const tx = db.transaction(() => {
    const [a, b] = [playerId, otherPlayerId].sort();
    db.prepare(
      `INSERT INTO chat_threads (id, player_a, player_b, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(threadId, a, b, now.toISOString());
  });
  tx();

  return { threadId, otherPlayerId, otherNickname: other.nickname, messages: listMessages(db, threadId, 0) };
}

/** Re-validated the same way openThread is — a thread already existing
 * doesn't exempt a message from needing both parties online and adjacent
 * *right now* (CLAUDE.md: the server, not the client's own walk having
 * finished a moment ago, is what decides this). `clientMsgId` is the
 * idempotency key: a retried send with the same id returns the already-
 * stored row rather than creating a second message or erroring. */
export function sendMessage(
  db: Database.Database,
  threadId: string,
  playerId: string,
  sessionSecret: string,
  clientMsgId: string,
  body: string,
): ChatMessage {
  requireBarSession(db, playerId, sessionSecret);
  if (typeof clientMsgId !== "string" || !clientMsgId) {
    throw new ChatError("missing client message id", "bad_request", 400);
  }
  const trimmed = (body ?? "").toString().trim();
  if (!trimmed) throw new ChatError("message can't be empty", "empty_message", 400);
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError(`message must be at most ${MAX_MESSAGE_LENGTH} characters`, "too_long", 400);
  }

  const tx = db.transaction((): { message: ChatMessage; isNew: boolean } => {
    const thread = requireParticipant(db, threadId, playerId);
    const existing = db
      .prepare(
        `SELECT id, thread_id as threadId, sender_id as senderId, body, created_at as createdAt
         FROM chat_messages WHERE thread_id = ? AND sender_id = ? AND client_msg_id = ?`,
      )
      .get(threadId, playerId, clientMsgId) as ChatMessage | undefined;
    if (existing) return { message: existing, isNew: false };

    const other = otherParticipant(thread, playerId);
    const now = new Date();
    requireOnline(db, playerId, now);
    requireOnline(db, other, now);
    requireAdjacent(db, playerId, other);
    checkRateLimit(playerId, now.getTime());

    const nowIso = now.toISOString();
    const info = db
      .prepare(`INSERT INTO chat_messages (thread_id, sender_id, client_msg_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(threadId, playerId, clientMsgId, trimmed, nowIso);
    return {
      message: { id: Number(info.lastInsertRowid), threadId, senderId: playerId, body: trimmed, createdAt: nowIso },
      isNew: true,
    };
  });
  const { message } = tx();
  return message;
}

/** The other participant's id — used by src/server.ts to know who else
 * to push a sent message to over the private chat channel. */
export function otherParticipantOf(db: Database.Database, threadId: string, playerId: string): string {
  const row = requireParticipant(db, threadId, playerId);
  return otherParticipant(row, playerId);
}

/** Full auth for a GET or SSE-subscribe against a specific thread (the
 * message-history fetch and the per-thread catch-up query) — real
 * identity proof (never a client-supplied id alone), *and* actually
 * being one of this thread's two participants. A thread id derived from
 * a sorted pair of player ids is not itself a secret (CLAUDE.md:
 * everything a public response carries is, by definition, not
 * confidential) — what actually keeps a third party out is this check,
 * not the id being hard to guess. */
export function requireThreadAccess(
  db: Database.Database,
  threadId: string,
  playerId: string,
  sessionSecret: string,
): void {
  requireBarSession(db, playerId, sessionSecret);
  requireParticipant(db, threadId, playerId);
}
