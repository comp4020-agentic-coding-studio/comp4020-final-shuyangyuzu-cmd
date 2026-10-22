// Phone-style, invite-based room voice calls — Online rooms only (never
// Offline/solo NPC games, never a pending join request, never an
// NPC-controlled seat; CLAUDE.md's identity/authority rules apply
// unchanged). WebRTC mesh audio between up to MAX_PLAYERS seated humans;
// this module is the signaling/membership half only — it never touches
// audio itself (no media server, nothing recorded, nothing saved).
//
// Layered the same one-directional way src/tables.ts and src/chat.ts
// already sit above src/rooms.ts (CLAUDE.md): this module is a pure
// consumer of rooms.getPublicState/requireSeatedHumanPlayer, and
// rooms.ts/types.ts know nothing about it. A call's own two tables
// (room_voice_calls/room_voice_participants, src/db.ts) are new, separate
// tables — nothing about rooms.state_json or its version column changes
// because of a call starting, someone muting, or a call ending; a voice
// mutation bumps the room's SSE push-revision (`rev`) exactly like a
// presence-only change does (src/live.ts), never `rooms.version`.
//
// Membership is reconciled lazily, on every read — the same "evaluated
// fresh, no background sweep" principle CLAUDE.md already establishes
// for the lobby disconnect grace and the away-from-table clock: a
// participant who's left the room, been hand-off'd to NPC control, or
// whose room closed is dropped from the call the next time anyone reads
// its state, which in practice is within about a second (src/server.ts's
// existing presence ticker already calls getPublicCallSummary every
// tick for every actively-watched room) — no new background timer.
//
// What this module will NEVER do, per CLAUDE.md's public-response rules:
// put an invited-but-not-yet-joined player's identity on the public room
// payload (only JOINED participants are public — exactly what the
// expand panel is allowed to show everyone), broadcast SDP/ICE/signaling
// anywhere but the one (room, recipient) private channel, or log a
// signal's actual payload (src/actionLog.ts's own ActionLogEntry.detail
// type only accepts scalars, so there is no field wide enough to carry
// one even by accident).

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { logAction, transact } from "./actionLog.ts";
import * as live from "./live.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import type { PublicState } from "./types.ts";

// An invite nobody's acted on for this long is treated as implicitly
// expired (deleted, same as an explicit decline) the next time anything
// reconciles this call — never a repeated ring, matching CLAUDE.md's "no
// continuous ringing" requirement; this is what makes a stale incoming-
// call prompt eventually go away even if the recipient's own tab never
// explicitly declines it. Env-overridable like every other time-based
// threshold in this codebase, for the same reason (a dedicated short-
// interval test instance, not a real 30s wait).
const VOICE_INVITE_TTL_MS = Number(process.env.VOICE_INVITE_TTL_MS ?? 30000);

// A generous allowance for the handful of start/respond/leave/mute
// requests a real call naturally produces — this is a "don't let a
// script hammer the endpoint" backstop, not a UX-facing limit a real
// person could ever hit by clicking normally.
const ACTION_RATE_LIMIT_COUNT = Number(process.env.VOICE_ACTION_RATE_LIMIT_COUNT ?? 20);
const ACTION_RATE_LIMIT_WINDOW_MS = Number(process.env.VOICE_ACTION_RATE_LIMIT_WINDOW_MS ?? 10000);
const actionTimestamps = new Map<string, number[]>();

function checkRateLimit(map: Map<string, number[]>, key: string, count: number, windowMs: number, now: number): void {
  const recent = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= count) {
    throw new RoomError("too many voice-call requests — wait a moment", "rate_limited", 429);
  }
  recent.push(now);
  map.set(key, recent);
}

// A real SDP offer/answer is a few KB of text; an ICE candidate is tiny.
// This is generous headroom, not a tuned-to-the-byte limit — its job is
// only to stop a malformed/hostile payload from being relayed at all.
const MAX_SIGNAL_PAYLOAD_CHARS = 16000;
const SIGNAL_RATE_LIMIT_COUNT = Number(process.env.VOICE_SIGNAL_RATE_LIMIT_COUNT ?? 100);
const SIGNAL_RATE_LIMIT_WINDOW_MS = Number(process.env.VOICE_SIGNAL_RATE_LIMIT_WINDOW_MS ?? 10000);
const signalTimestamps = new Map<string, number[]>();

export interface PublicVoiceParticipant {
  playerId: string;
  nickname: string;
  color: string;
  muted: boolean;
}

/** What every public room payload (GET /state, rejoin, every mutation's
 * own response, every SSE push) carries about voice — participants means
 * JOINED only; an invited-but-undecided player is never named here
 * (CLAUDE.md). `active: false` (callId/startedBy null, empty
 * participants) is the steady "nobody's calling" state every room starts
 * and ends in. */
export interface PublicVoiceCall {
  active: boolean;
  callId: string | null;
  startedBy: string | null;
  participants: PublicVoiceParticipant[];
}

interface CallRow {
  id: string;
  room_code: string;
  started_by: string;
  started_at: string;
}

function getActiveCallRow(db: Database.Database, code: string): CallRow | undefined {
  return db
    .prepare(`SELECT id, room_code, started_by, started_at FROM room_voice_calls WHERE room_code = ?`)
    .get(code) as CallRow | undefined;
}

// Game seats may remain reserved for three minutes, but voice permission
// ends immediately on either direct-room or bar-bound departure.
function isAway(db: Database.Database, playerId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM room_departures WHERE player_id = ?
    UNION ALL SELECT 1 FROM table_departures d JOIN bar_players b ON b.id = d.bar_player_id
    WHERE b.current_game_player_id = ? LIMIT 1`).get(playerId, playerId);
}

function requirePresentHuman(db: Database.Database, code: string, playerId: string, secret: string): PublicState {
  const state = rooms.requireSeatedHumanPlayer(db, code, playerId, secret);
  if (isAway(db, playerId)) throw new RoomError('return to your game before joining voice', 'voice_away', 403);
  return state;
}

/** Notifies every still-invited participant that the call they were
 * asked to is now gone (CLAUDE.md: "来电尚未接受时若通话已结束，提示同步
 * 关闭"), then deletes every row for this call — nothing left to collide
 * with, re-join by old id, or leak membership from. Deliberately never
 * notifies a participant who had already joined and is now gone too
 * (they're the one who just left/triggered this, or were already removed
 * by reconciliation above — either way there's no one left to tell). */
function endCallEntirely(db: Database.Database, code: string, callId: string): void {
  const stillInvited = db
    .prepare(`SELECT player_id FROM room_voice_participants WHERE call_id = ? AND status = 'invited'`)
    .all(callId) as Array<{ player_id: string }>;
  db.prepare(`DELETE FROM room_voice_participants WHERE call_id = ?`).run(callId);
  db.prepare(`DELETE FROM room_voice_calls WHERE id = ?`).run(callId);
  for (const row of stillInvited) {
    live.publishToRoomVoice(code, row.player_id, { type: "call_ended", callId });
  }
  logAction(db, { action: "voice_call_ended", outcome: "ok", verified: true, actor: null, room: { code }, detail: { callId } });
}

/** The one place membership is actually reconciled against truth — run
 * on every read (getPublicCallSummary, below), never on a separate
 * background timer. Drops any participant who is no longer a seated,
 * human-controlled player of this room (left, exited into NPC handoff,
 * or the room itself closed) and, separately, any 'invited' row whose
 * ring has gone past VOICE_INVITE_TTL_MS. If that leaves nobody actually
 * joined, the call ends entirely (notifying anyone still invited). A
 * forcibly-dropped JOINED participant (as opposed to one who explicitly
 * hung up through leaveCall) gets a direct push so their own still-open
 * tab tears down its connection even if they never clicked anything
 * themselves (CLAUDE.md's leave/exit states: "座位转交 NPC 时，退出语音并
 * 释放麦克风..."). */
function reconcileParticipants(db: Database.Database, code: string, call: CallRow, state: PublicState): void {
  const seatedHumans = new Map(
    state.closed ? [] : state.players.filter((p) => p.controller === "human" && !isAway(db, p.id)).map((p) => [p.id, p] as const),
  );
  const rows = db
    .prepare(`SELECT player_id, status, invited_at FROM room_voice_participants WHERE call_id = ?`)
    .all(call.id) as Array<{ player_id: string; status: string; invited_at: string }>;
  const now = Date.now();
  let anyJoined = false;
  for (const row of rows) {
    const player = seatedHumans.get(row.player_id);
    // Dropped for one of two reasons, both covered the same way: no longer
    // a seated human at all (left/exited/handed-off/room closed), or —
    // for an already-JOINED participant specifically — gone quiet past
    // the room's own presence-stale threshold (a closed tab, a crashed
    // device, a refresh that hasn't heartbeated again yet). A plain
    // refresh in practice recovers its heartbeat within a second or two,
    // well under that threshold, so it is never treated as a leave here —
    // matching CLAUDE.md's "a refresh is never a leave" rule — while a
    // genuinely gone participant doesn't permanently occupy the visible
    // count ("失联不能永久占用人数"). Reusing `connected` (already derived
    // by rooms.getPublicState from the same heartbeat table every other
    // presence check in this codebase already relies on) is deliberate:
    // no second, voice-specific liveness signal to keep in sync with the
    // first.
    const stillPresent = !!player && (row.status !== "joined" || player.connected);
    if (!stillPresent) {
      db.prepare(`DELETE FROM room_voice_participants WHERE call_id = ? AND player_id = ?`).run(call.id, row.player_id);
      if (row.status === "joined") {
        live.publishToRoomVoice(code, row.player_id, { type: "removed_from_call", callId: call.id });
      }
      continue;
    }
    if (row.status === "invited" && now - new Date(row.invited_at).getTime() > VOICE_INVITE_TTL_MS) {
      db.prepare(`DELETE FROM room_voice_participants WHERE call_id = ? AND player_id = ?`).run(call.id, row.player_id);
      continue;
    }
    if (row.status === "joined") anyJoined = true;
  }
  if (!anyJoined) endCallEntirely(db, code, call.id);
}

/** The public summary — safe to broadcast on the room's existing public
 * SSE channel and to return from a plain, unauthenticated GET /state
 * (nothing here is more sensitive than the player list itself already
 * is). Always reconciles first, so "active" and the participant list are
 * never stale by more than this one call. */
export function getPublicCallSummary(db: Database.Database, code: string): PublicVoiceCall {
  const state = rooms.getPublicState(db, code);
  const call = getActiveCallRow(db, code);
  if (!call) return { active: false, callId: null, startedBy: null, participants: [] };
  transact(db, () => reconcileParticipants(db, code, call, state));
  const after = getActiveCallRow(db, code);
  if (!after) return { active: false, callId: null, startedBy: null, participants: [] };
  const rows = db
    .prepare(`SELECT player_id, muted FROM room_voice_participants WHERE call_id = ? AND status = 'joined'`)
    .all(after.id) as Array<{ player_id: string; muted: number }>;
  const participants = rows
    .map((r) => {
      const p = state.players.find((pp) => pp.id === r.player_id);
      return { playerId: r.player_id, nickname: p?.nickname ?? "", color: p?.color ?? "", muted: !!r.muted };
    })
    .sort((a, b) => a.playerId.localeCompare(b.playerId));
  return { active: true, callId: after.id, startedBy: after.started_by, participants };
}

export interface OwnVoiceView extends PublicVoiceCall {
  own: { status: "none" | "invited" | "joined"; muted: boolean; invitedBy: string | null };
}

/** Authenticated, personal view — the fallback fetch a client makes on
 * page load/reconnect to catch up on a pending invite it might have
 * missed while its own SSE connection to .../voice/events was down (the
 * same "a dropped connection is never trusted to have delivered
 * everything" principle CLAUDE.md already states for the room/bar
 * channels). */
export function getOwnVoiceView(db: Database.Database, code: string, playerId: string, sessionSecret: string): OwnVoiceView {
  rooms.requireSeatedHumanPlayer(db, code, playerId, sessionSecret);
  const summary = getPublicCallSummary(db, code);
  if (!summary.callId) return { ...summary, own: { status: "none", muted: false, invitedBy: null } };
  const row = db
    .prepare(`SELECT status, muted FROM room_voice_participants WHERE call_id = ? AND player_id = ?`)
    .get(summary.callId, playerId) as { status: string; muted: number } | undefined;
  if (!row) return { ...summary, own: { status: "none", muted: false, invitedBy: null } };
  let invitedBy: string | null = null;
  if (row.status === "invited") {
    const call = getActiveCallRow(db, code);
    const state = rooms.getPublicState(db, code);
    invitedBy = call ? state.players.find((p) => p.id === call.started_by)?.nickname ?? null : null;
  }
  return { ...summary, own: { status: row.status as "invited" | "joined", muted: !!row.muted, invitedBy } };
}

/** Starts a new call (inviting every other seated human) or merges into
 * one that already exists (CLAUDE.md: "两人同时发起时，服务器必须合并到
 * 同一场房间通话") — the same operation serves both the phone-icon
 * "start a call" action and the header's "join the call already in
 * progress" action; the only difference is whether this caller's own
 * INSERT is the one that actually creates the room_voice_calls row
 * (`changes === 1`), which is also exactly how the merge race resolves
 * itself: two simultaneous first clicks both attempt the INSERT ON
 * CONFLICT(room_code) DO NOTHING; whichever commits first is the real
 * initiator and sends invites, the other's insert is a no-op and that
 * caller simply joins the winner's call like any other participant —
 * no application-level locking needed (the same single-writer-process
 * reasoning every other race in this codebase already relies on). */
export function startOrJoinCall(db: Database.Database, code: string, playerId: string, sessionSecret: string): PublicVoiceCall {
  checkRateLimit(actionTimestamps, `${code}:${playerId}`, ACTION_RATE_LIMIT_COUNT, ACTION_RATE_LIMIT_WINDOW_MS, Date.now());
  const state = requirePresentHuman(db, code, playerId, sessionSecret);
  if (state.solo) throw new RoomError("voice calls aren't available in offline games", "voice_not_available", 409);
  const nickname = state.players.find((p) => p.id === playerId)?.nickname ?? "";

  return transact(db, () => {
    const now = new Date().toISOString();
    const existing = getActiveCallRow(db, code);
    let callId: string;
    let createdFresh = false;
    if (existing) {
      callId = existing.id;
    } else {
      callId = randomUUID();
      const info = db
        .prepare(`INSERT INTO room_voice_calls (id, room_code, started_by, started_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(room_code) DO NOTHING`)
        .run(callId, code, playerId, now);
      if (info.changes === 1) {
        createdFresh = true;
      } else {
        // Lost the race — re-read the real winner's row rather than trust
        // the id this call just generated.
        callId = getActiveCallRow(db, code)!.id;
      }
    }

    const alreadyIn = db
      .prepare(`SELECT status FROM room_voice_participants WHERE call_id = ? AND player_id = ?`)
      .get(callId, playerId) as { status: string } | undefined;
    if (!alreadyIn || alreadyIn.status !== "joined") {
      db.prepare(
        `INSERT INTO room_voice_participants (call_id, player_id, status, muted, invited_at, joined_at)
         VALUES (?, ?, 'joined', 0, ?, ?)
         ON CONFLICT(call_id, player_id) DO UPDATE SET status = 'joined', joined_at = excluded.joined_at`,
      ).run(callId, playerId, now, now);
      logAction(db, {
        action: "voice_call_join",
        outcome: "ok",
        verified: true,
        actor: { kind: "room", id: playerId, nickname },
        room: { code },
        detail: { callId, startedNewCall: createdFresh },
      });
    }

    if (createdFresh) {
      const others = state.players.filter((p) => p.id !== playerId && p.controller === "human" && !isAway(db, p.id));
      for (const other of others) {
        db.prepare(
          `INSERT INTO room_voice_participants (call_id, player_id, status, muted, invited_at, joined_at)
           VALUES (?, ?, 'invited', 0, ?, NULL)
           ON CONFLICT(call_id, player_id) DO NOTHING`,
        ).run(callId, other.id, now);
        live.publishToRoomVoice(code, other.id, { type: "invited", callId, roomCode: code, inviterNickname: nickname });
      }
      logAction(db, {
        action: "voice_call_started",
        outcome: "ok",
        verified: true,
        actor: { kind: "room", id: playerId, nickname },
        room: { code },
        detail: { callId, inviteCount: others.length },
      });
    }

    return getPublicCallSummary(db, code);
  });
}

/** Accept or decline a specific invitation. Idempotent and never
 * destructively errors on a stale/already-resolved invite — the UI was
 * always going to close the prompt either way, whether because the call
 * ended (reconciliation's own `call_ended` push already told this player
 * that proactively) or because a duplicate click/retry raced an earlier
 * one. Declining never deletes anything beyond this player's own
 * participant row: no 'declined' status is kept, which is exactly what
 * makes "a decliner can click 加入通话 from the header at any time" true
 * with no special-case logic — nothing distinguishes a past decliner
 * from anyone else who was never invited at all, once this row is gone. */
export function respondToInvite(
  db: Database.Database,
  code: string,
  playerId: string,
  sessionSecret: string,
  callId: string,
  accept: boolean,
): PublicVoiceCall {
  checkRateLimit(actionTimestamps, `${code}:${playerId}`, ACTION_RATE_LIMIT_COUNT, ACTION_RATE_LIMIT_WINDOW_MS, Date.now());
  const state = requirePresentHuman(db, code, playerId, sessionSecret);
  const nickname = state.players.find((p) => p.id === playerId)?.nickname ?? "";
  return transact(db, () => {
    const call = getActiveCallRow(db, code);
    if (!call || call.id !== callId) return getPublicCallSummary(db, code);
    const row = db
      .prepare(`SELECT status FROM room_voice_participants WHERE call_id = ? AND player_id = ?`)
      .get(callId, playerId) as { status: string } | undefined;
    if (!row) return getPublicCallSummary(db, code);
    if (accept) {
      if (row.status !== "joined") {
        db.prepare(`UPDATE room_voice_participants SET status = 'joined', joined_at = ? WHERE call_id = ? AND player_id = ?`).run(
          new Date().toISOString(),
          callId,
          playerId,
        );
        logAction(db, {
          action: "voice_call_accept",
          outcome: "ok",
          verified: true,
          actor: { kind: "room", id: playerId, nickname },
          room: { code },
          detail: { callId },
        });
      }
    } else {
      db.prepare(`DELETE FROM room_voice_participants WHERE call_id = ? AND player_id = ?`).run(callId, playerId);
      logAction(db, {
        action: "voice_call_decline",
        outcome: "ok",
        verified: true,
        actor: { kind: "room", id: playerId, nickname },
        room: { code },
        detail: { callId },
      });
    }
    return getPublicCallSummary(db, code);
  });
}

/** Hangs up — removes only the caller, never ends the call for anyone
 * else unless this was genuinely the last joined participant
 * (CLAUDE.md/PLAN.md: "发起者不是通话管理员，挂断只退出自己"). Idempotent:
 * a stale callId or a double-click against an already-left state is a
 * silent no-op. */
export function leaveCall(db: Database.Database, code: string, playerId: string, sessionSecret: string, callId: string): PublicVoiceCall {
  const state = rooms.requireSeatedHumanPlayer(db, code, playerId, sessionSecret);
  const nickname = state.players.find((p) => p.id === playerId)?.nickname ?? "";
  return transact(db, () => {
    const call = getActiveCallRow(db, code);
    if (!call || call.id !== callId) return getPublicCallSummary(db, code);
    const row = db
      .prepare(`SELECT status FROM room_voice_participants WHERE call_id = ? AND player_id = ?`)
      .get(callId, playerId) as { status: string } | undefined;
    if (!row) return getPublicCallSummary(db, code);
    db.prepare(`DELETE FROM room_voice_participants WHERE call_id = ? AND player_id = ?`).run(callId, playerId);
    logAction(db, {
      action: "voice_call_leave",
      outcome: "ok",
      verified: true,
      actor: { kind: "room", id: playerId, nickname },
      room: { code },
      detail: { callId },
    });
    const remaining = (
      db.prepare(`SELECT COUNT(*) as n FROM room_voice_participants WHERE call_id = ? AND status = 'joined'`).get(callId) as {
        n: number;
      }
    ).n;
    if (remaining === 0) endCallEntirely(db, code, callId);
    return getPublicCallSummary(db, code);
  });
}

/** Still counts toward the public "X people in call" count (CLAUDE.md:
 * "静音玩家仍计入通话人数") — this only ever flips the `muted` flag on an
 * already-JOINED participant row, never anything about membership. */
export function setMuted(
  db: Database.Database,
  code: string,
  playerId: string,
  sessionSecret: string,
  callId: string,
  muted: boolean,
): PublicVoiceCall {
  requirePresentHuman(db, code, playerId, sessionSecret);
  return transact(db, () => {
    const call = getActiveCallRow(db, code);
    if (!call || call.id !== callId) throw new RoomError("that call has ended", "voice_call_ended", 410);
    const info = db
      .prepare(`UPDATE room_voice_participants SET muted = ? WHERE call_id = ? AND player_id = ? AND status = 'joined'`)
      .run(muted ? 1 : 0, callId, playerId);
    if (info.changes === 0) throw new RoomError("you're not an active participant in this call", "not_in_call", 409);
    return getPublicCallSummary(db, code);
  });
}

/** Relays one piece of WebRTC signaling (an SDP offer/answer, or a
 * single ICE candidate) from one joined participant to another, over
 * each recipient's own private channel only (src/live.ts's
 * publishToRoomVoice) — never the public room SSE broadcast, and never
 * to anyone who isn't, right now, a JOINED participant of this exact
 * call on both ends (CLAUDE.md: "只有已接受并加入的成员才能交换媒体信
 * 令"). This is the one function in this module that runs often enough
 * (a real WebRTC negotiation produces a handful of ICE candidates) to
 * need its own, more generous rate limit, separate from the
 * start/respond/leave/mute actions above. */
export function relaySignal(
  db: Database.Database,
  code: string,
  playerId: string,
  sessionSecret: string,
  callId: string,
  toPlayerId: string,
  signalType: string,
  data: unknown,
): void {
  const state = requirePresentHuman(db, code, playerId, sessionSecret);
  if (typeof signalType !== "string" || !signalType) throw new RoomError("missing signal type", "bad_request", 400);
  if (typeof toPlayerId !== "string" || !toPlayerId) throw new RoomError("missing recipient", "bad_request", 400);
  const serialized = JSON.stringify(data ?? null);
  if (serialized.length > MAX_SIGNAL_PAYLOAD_CHARS) throw new RoomError("signal payload too large", "payload_too_large", 413);

  const call = getActiveCallRow(db, code);
  if (!call || call.id !== callId) throw new RoomError("that call has ended", "voice_call_ended", 410);
  const fromRow = db
    .prepare(`SELECT status FROM room_voice_participants WHERE call_id = ? AND player_id = ?`)
    .get(callId, playerId) as { status: string } | undefined;
  const toRow = db
    .prepare(`SELECT status FROM room_voice_participants WHERE call_id = ? AND player_id = ?`)
    .get(callId, toPlayerId) as { status: string } | undefined;
  const recipient = state.players.find(p => p.id === toPlayerId);
  if (fromRow?.status !== "joined" || toRow?.status !== "joined" || !recipient || recipient.controller !== 'human' || !recipient.connected || isAway(db, toPlayerId)) {
    throw new RoomError("both sides must be active call participants", "not_in_call", 409);
  }

  checkRateLimit(signalTimestamps, `${callId}:${playerId}`, SIGNAL_RATE_LIMIT_COUNT, SIGNAL_RATE_LIMIT_WINDOW_MS, Date.now());
  // Never logged beyond its type/size — src/actionLog.ts's own
  // ActionLogEntry.detail type only accepts scalar values by
  // construction, so there is no field here wide enough to carry the
  // actual SDP/ICE payload even by accident (CLAUDE.md).
  logAction(db, {
    action: "voice_signal",
    outcome: "ok",
    verified: true,
    actor: { kind: "room", id: playerId },
    room: { code },
    detail: { callId, toPlayer: toPlayerId.slice(0, 8), signalType },
  });
  live.publishToRoomVoice(code, toPlayerId, { type: "signal", callId, from: playerId, signalType, data });
}
