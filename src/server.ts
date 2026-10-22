// Entry point. Serves the client, the API, and /readme/ — see CLAUDE.md
// for the request-handling rules every route below holds to, and
// PLAN.md for what each endpoint is for.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { logAction, runWithVerificationTracking, wasIdentityVerified } from "./actionLog.ts";
import * as bar from "./bar.ts";
import { BarError } from "./bar.ts";
import { FURNITURE, GAME_CHAIRS, GRID_COLS, GRID_ROWS, TILE_SIZE } from "./barLayout.ts";
import * as chat from "./chat.ts";
import { ChatError } from "./chat.ts";
import { dbPathFromEnv, openDb } from "./db.ts";
import * as live from "./live.ts";
import { renderReadme } from "./markdown.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import { TableError } from "./tables.ts";
import * as tables from "./tables.ts";
import type { Color, PublicState } from "./types.ts";
import { BUILD_VERSION, renderIndexHtml } from "./version.ts";
import * as voice from "./voice.ts";
import { registerPoker } from './pokerRoutes.ts';
import { getIceServers } from "./iceConfig.ts";

// Every outgoing room payload carries `epoch` (SERVER_EPOCH, constant for
// this process) and `rev` (this room's own push-revision, src/live.ts) in
// addition to the existing `version` (the DB's optimistic-concurrency
// column, still reused by game actions for idempotency — unaffected).
// `rev` is the client's staleness gate from here on, not `version`: see
// src/live.ts's header for why a heartbeat or presence timeout bumping
// `version` would be wrong (it would make an unrelated roll/place race
// against it), and PLAN.md's Crit 9 phase 7 entry for the independent
// review that caught this.
// `voiceCall` rides this same payload, same channel — no new transport
// (CLAUDE.md's voice-call section: the public summary is just one more
// field on the state every room mutation already broadcasts). Only
// JOINED participants are ever named here (voice.getPublicCallSummary's
// own contract) — an invited-but-undecided player's identity never
// appears on this public payload at all.
type LivePublicState = PublicState & live.LiveCursor & { voiceCall: voice.PublicVoiceCall };

function withLiveCursor(state: PublicState, rev: number): LivePublicState {
  return { ...state, epoch: live.SERVER_EPOCH, rev, voiceCall: voice.getPublicCallSummary(db, state.code) };
}

/** A plain read of a room's current public state — a GET, a rejoin, or
 * the snapshot sent when an SSE connection first opens. Reports the
 * *current* rev; reading never bumps it (only an actual broadcast-worthy
 * change does — see publishRoomState and tickRoomPresence below). */
function currentRoomState(code: string): LivePublicState {
  return withLiveCursor(rooms.getPublicState(db, code), live.currentRoomRev(code));
}

/** The slice of a room's public state that can change from presence
 * (connected flags) or the lazy disconnect-grace sweep (closed,
 * hostPlayerId, who's still seated) alone, with no real mutation and no
 * `version` bump — what tickRoomPresence diffs against the last thing
 * actually broadcast to decide whether there's anything new to push.
 * Voice-call membership can also change this way (reconciliation dropping
 * a participant whose seat just got swept) — included here for exactly
 * that reason, not because a call itself is a presence concept. */
function roomPresenceSignature(state: PublicState): string {
  return JSON.stringify({
    closed: state.closed,
    hostPlayerId: state.hostPlayerId,
    players: state.players.map((p) => ({ id: p.id, connected: p.connected })),
    voiceCall: voice.getPublicCallSummary(db, state.code),
  });
}
const lastRoomPresenceSignature = new Map<string, string>();

// A room mutation's own fresh public state, pushed to that room's SSE
// subscribers right after it commits — the same JSON this route is about
// to return to the actor, just also broadcast.
function publishRoomState(code: string, state: PublicState): LivePublicState {
  const withCursor = withLiveCursor(state, live.bumpRoomRev(code));
  lastRoomPresenceSignature.set(code, roomPresenceSignature(withCursor));
  live.publishRoom(code, withCursor);
  return withCursor;
}

/** Re-checks a room's presence-derived public view (this is the existing
 * lazy sweep/connected computation in rooms.getPublicState — not a new
 * mutation path, just an extra caller of the same read) and broadcasts
 * only if it actually changed since the last thing this channel
 * broadcast. Called right after a heartbeat (so "they're back" reaches
 * everyone else immediately) and by the presence ticker below (so "they
 * went quiet" reaches everyone else without anyone having to click
 * anything — CLAUDE.md's Crit 9 phase 7 entry). The first check for a
 * room (no prior signature recorded) seeds the baseline without
 * publishing, so a brand-new SSE subscriber doesn't get a redundant
 * duplicate push on the very next tick. */
function tickRoomPresence(code: string): void {
  const state = rooms.getPublicState(db, code);
  const signature = roomPresenceSignature(state);
  if (!lastRoomPresenceSignature.has(code)) {
    lastRoomPresenceSignature.set(code, signature);
    return;
  }
  if (lastRoomPresenceSignature.get(code) === signature) return;
  publishRoomState(code, state);
}

// Combined bar + table-occupancy snapshot — one payload, one sequence
// number, so a bystander in the bar sees a table's status change without
// polling a separate endpoint for it. `seq` is the bar channel's
// staleness sequence (see src/live.ts); passing it in rather than reading
// it internally keeps "did this call actually mutate anything" (bump) and
// "just report the current number" (read) visibly distinct at each call
// site below. `epoch` is this process's own SERVER_EPOCH — see the room
// comment above and src/live.ts's header for why a raw seq alone isn't
// enough across a restart.
function barSnapshot(seq: number): { epoch: number; seq: number; players: bar.PublicBarPlayer[]; tables: tables.TableStatusView[] } {
  return { epoch: live.SERVER_EPOCH, seq, players: bar.getPublicBarState(db).players, tables: tables.getTablesStatus(db) };
}

function barPresenceSignature(snap: { players: bar.PublicBarPlayer[]; tables: tables.TableStatusView[] }): string {
  return JSON.stringify(snap.players) + "|" + JSON.stringify(snap.tables);
}
let lastBarPresenceSignature: string | null = null;

// Broadcasts the bar channel after a mutation. Called after every
// room-mutating endpoint too (not just bar/table ones): a room's phase
// change can flip its bound table's displayed status (lobby -> in
// progress -> finished), and src/rooms.ts deliberately doesn't know
// about src/tables.ts (CLAUDE.md's bar/game separation), so there's no
// cheaper way to know "did this specific mutation change a table's
// bucket" without adding that coupling. Trades a little precision for
// not adding it — negligible cost at this app's scale.
function publishBarSnapshot(): void {
  const snap = barSnapshot(live.bumpBarSeq());
  lastBarPresenceSignature = barPresenceSignature(snap);
  live.publishBar(snap);
}

/** Same idea as tickRoomPresence, for the bar's single channel: a patron
 * going stale (or coming back) changes who getPublicBarState's filter
 * returns, with no mutation and no seq bump of its own — this is what
 * notices that and republishes only when the visible set actually
 * changed. */
function tickBarPresence(): void {
  const snap = barSnapshot(live.currentBarSeq());
  const signature = barPresenceSignature(snap);
  if (lastBarPresenceSignature === null) {
    lastBarPresenceSignature = signature;
    return;
  }
  if (lastBarPresenceSignature === signature) return;
  publishBarSnapshot();
}

// How often the presence ticker below re-checks already-watched channels
// for a purely time-driven change (nobody's heartbeat landing, nobody
// taking any action). Env-overridable for the same reason
// PRESENCE_STALE_MS/LOBBY_GRACE_MS already are (src/presence.ts): a
// dedicated short-interval instance can verify this without waiting out
// the production default for real in an automated check.
const LIVE_PRESENCE_TICK_MS = Number(process.env.LIVE_PRESENCE_TICK_MS ?? 1000);

// The 3-minute away-from-table clock (CLAUDE.md's leave/exit states).
// Env-overridable for the same reason every other threshold in this file
// is — a dedicated short-interval instance can verify this for real.
const AWAY_FROM_TABLE_MS = Number(process.env.AWAY_FROM_TABLE_MS ?? tables.DEFAULT_AWAY_FROM_TABLE_MS);

// A short, human-readable pause between an NPC's roll and its placement
// (and between one NPC's turn and whoever's next) — "a brief display
// pause," not an instant back-to-back resolution. Env-overridable like
// everything else time-based in this file.
const NPC_TURN_DELAY_MS = Number(process.env.NPC_TURN_DELAY_MS ?? 700);

// Rooms with an NPC turn already scheduled (a setTimeout in flight) —
// the in-memory guard against double-scheduling from this process. Not
// the only thing preventing a double-execution: rooms.npcRoll/npcPlace
// are themselves idempotent (a second call against state that's already
// moved on is a no-op), so even a restart mid-wait — which clears this
// Set, same as every other in-memory thing in this file — can't actually
// double-apply a turn, only at worst schedule a redundant check that
// finds nothing to do.
const npcTurnInFlight = new Set<string>();

/** Checks whether `code`'s current player is NPC-controlled and, if so,
 * schedules the one pending action (a roll or a placement) after a short
 * display pause. Called from the same ticker as the presence/departure
 * checks below, for the same reason and under the same gate — an NPC
 * seat with nobody watching the room simply pauses, exactly like
 * presence detection already does, and picks back up the moment the room
 * is watched again (no separate, unconditional background timer). */
function scheduleNpcTurnIfNeeded(code: string): void {
  if (npcTurnInFlight.has(code)) return;
  let state: PublicState;
  try {
    state = rooms.getPublicState(db, code);
  } catch {
    return; // room gone — nothing to schedule
  }
  if (state.closed) return;
  if (state.phase !== "awaiting_roll" && state.phase !== "awaiting_placement") return;
  const current = state.players.find((p) => p.id === state.currentPlayerId);
  if (!current || current.controller !== "npc") return;

  npcTurnInFlight.add(code);
  setTimeout(() => {
    try {
      const acted = state.phase === "awaiting_roll" ? rooms.npcRoll(db, code) : rooms.npcPlace(db, code);
      if (acted) {
        const after = publishRoomState(code, rooms.getPublicState(db, code));
        // A placement can end the round, which flips the bound table's
        // displayed status for anyone watching from the bar — same as a
        // human's own place handler already accounts for.
        if (after.phase === "round_end" || after.phase === "game_end") publishBarSnapshot();
      }
    } catch {
      // Room closed in the meantime, etc. — fine, there's nothing left to act on.
    } finally {
      npcTurnInFlight.delete(code);
    }
  }, NPC_TURN_DELAY_MS);
}

const db = openDb(dbPathFromEnv());
const app = new Hono();

// Establishes a fresh, per-request verification context BEFORE anything
// else runs — the outermost middleware, registered first, so its
// AsyncLocalStorage context is still active for every later middleware,
// every route handler, and (critically) app.onError itself when a
// handler throws. Hono's own compose() calls onError from the exact
// dispatch frame that caught the exception, which is still nested inside
// this middleware's own `await next()` call (nothing here ever escapes
// to a new macrotask via setTimeout/setImmediate, so the ALS context
// genuinely survives every await in between) — confirmed by reading
// node_modules/hono/dist/compose.js's dispatch() implementation. Without
// this, there is no way for app.onError to know whether THIS specific
// request's own call to requireSession/requireBarSession actually
// succeeded before whatever got rejected — src/actionLog.ts's own header
// explains why guessing that from the rejection's error code was wrong.
app.use("*", async (c, next) => {
  // Expire before request-specific identity tracking: a timer's verified
  // stored session must never count as proof of this HTTP caller's identity.
  sweepTableDepartures();
  await runWithVerificationTracking(() => next());
});

// No Cache-Control header at all (the previous state) lets a browser
// serve app.js/index.html/styles.css straight from its own disk cache
// on a normal reload, with no request ever reaching the server — so a
// deploy can be live, correct, and verified, and a real person's own
// browser still shows the previous version. `no-cache` (not `no-store`)
// still lets the browser keep a cached copy, but forces it to
// revalidate with the server (a conditional request) on every use —
// cheap for an app this size, and the only way a server-side fix
// reliably becomes something a returning player's browser actually
// shows, without asking everyone to hard-refresh.
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", c.req.path.startsWith('/api/poker/')?'private, no-store':"no-cache");
});

// Best-effort claimed identity for a rejected request — read from the
// already-parsed JSON body (Hono's HonoRequest.json() caches its parsed
// result, so a second call here after a handler already consumed it
// returns the cached value, never a second body read) or, for the few
// GET/SSE routes that carry identity as query params instead (chat's
// message history and event stream), from there. Never a nickname here:
// a nickname only ever comes from a verified DB row elsewhere in this
// file, never an unverified request — a failed identity claim must not
// be dressed up as if it were confirmed. Returns null when neither source
// carries a playerId at all (e.g. a 404 on a nonexistent room code, which
// has no identity involved).
async function claimedRejectionActor(c: Context): Promise<{ kind: "bar" | "room"; id: string } | null> {
  let body: Record<string, unknown> = {};
  try {
    const value = await c.req.json();
    if(value && typeof value==='object' && !Array.isArray(value))body=value as Record<string,unknown>;
  } catch {
    // No JSON body on this request (a GET, or a body-less retry) — fall
    // through to query params below.
  }
  const fromBody = typeof body.playerId === "string" ? body.playerId : undefined;
  const fromQuery = c.req.query("playerId");
  const id = fromBody || fromQuery;
  if (!id) return null;
  const kind: "bar" | "room" = c.req.path.startsWith("/api/bar") || c.req.path.startsWith('/api/poker') ? "bar" : "room";
  return { kind, id };
}

app.onError(async (err, c) => {
  if (err instanceof RoomError || err instanceof BarError || err instanceof TableError || err instanceof ChatError) {
    const status = err.status as 400 | 403 | 404 | 409 | 410 | 413 | 429;
    const actor = await claimedRejectionActor(c);
    // `wasIdentityVerified()` is real evidence, not an inference from the
    // error's own code: a follow-up review caught that the original
    // `err.code !== "unauthorized"` heuristic was wrong, because most
    // rejections in src/rooms.ts never reach requireSession at all —
    // loadOpenRoom/loadRoomAfterSweep throw room_not_found/room_closed
    // first, and the old code logged verified: true for those too,
    // falsely implying a session check had run and passed when none ever
    // did. This reads whether requireSession/requireBarSession actually
    // ran and succeeded at any point during THIS request (via the
    // AsyncLocalStorage context the middleware above established).
    logAction(db, {
      action: `${c.req.method} ${c.req.path}`,
      outcome: "rejected",
      verified: wasIdentityVerified(),
      actor,
      error: { code: err.code, message: err.message },
    });
    return c.json({ error: err.code, message: err.message }, status);
  }
  console.error(err);
  return c.json({ error: "internal_error", message: "something went wrong" }, 500);
});

// Server-rendered, not a static file: this is what injects BUILD_VERSION
// into the asset URLs (see src/version.ts for why a Cache-Control header
// alone isn't enough). Registered before the catch-all serveStatic below
// so it takes precedence for exactly "/".
app.get("/", (c) => c.html(renderIndexHtml()));

app.get("/readme/", (c) => c.html(renderReadme()));

app.get("/version", (c) => c.json({ version: BUILD_VERSION }));

interface CreateJoinBody {
  nickname?: unknown;
  color?: unknown;
}

function asNickname(body: CreateJoinBody): string {
  return typeof body.nickname === "string" ? body.nickname : "";
}

function asColor(body: CreateJoinBody): Color {
  return body.color as Color;
}

app.post("/api/rooms", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateJoinBody;
  const result = rooms.createRoom(db, asNickname(body), asColor(body));
  return c.json(result, 201);
});

app.post("/api/rooms/:code/join", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as CreateJoinBody;
  const result = rooms.joinRoom(db, code, asNickname(body), asColor(body));
  // joinRoom's own return value is just the new player's credentials, not
  // the room's full state — fetch that separately to broadcast it (the
  // host, already in the lobby, is likely already subscribed).
  publishRoomState(code, rooms.getPublicState(db, code));
  publishBarSnapshot();
  return c.json(result, 201);
});

interface AuthedBody {
  playerId?: unknown;
  sessionSecret?: unknown;
}

function playerId(body: AuthedBody): string {
  return typeof body.playerId === "string" ? body.playerId : "";
}

function sessionSecret(body: AuthedBody): string {
  return typeof body.sessionSecret === "string" ? body.sessionSecret : "";
}

app.post("/api/rooms/:code/rejoin", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.rejoin(db, code, playerId(body), sessionSecret(body));
  // Deliberately does NOT clear any pending away-from-table departure —
  // a follow-up review caught that an earlier version of this handler
  // did, which is wrong: rejoin fires from a room view that may simply
  // have been left open the whole time (an old tab's own mount, not a
  // deliberate return), and a passive "the browser/tab is still here"
  // signal proves nothing about whether the *person* physically went
  // back to the table. Clearing a departure now requires an explicit
  // bar-world action (src/tables.ts's resumeActiveTable, called from
  // public/tavern.js before navigating back into a table's room) —
  // CLAUDE.md's leave/exit states.
  // The sweep that rejoin() already ran can itself change the presence
  // signature (e.g. this read finally pushes a since-stale player's
  // removal past the point every other viewer last saw) — recheck before
  // answering, not just on the next unrelated mutation or tick.
  tickRoomPresence(code);
  return c.json(currentRoomState(code));
});

app.get("/api/rooms/:code/state", (c) => {
  const code = c.req.param("code");
  return c.json(currentRoomState(code));
});

app.post("/api/rooms/:code/start", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.startGame(db, code, playerId(body), sessionSecret(body));
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  publishBarSnapshot();
  return c.json(state);
});

app.post('/api/rooms/:code/next-round',async c=>{
  const body=(await c.req.json()) as AuthedBody & {expectedRound?:unknown};
  const code=c.req.param('code');
  rooms.nextRound(db,code,playerId(body),sessionSecret(body),Number(body.expectedRound));
  const state=publishRoomState(code,rooms.getPublicState(db,code));publishBarSnapshot();return c.json(state);
});
app.post('/api/rooms/:code/winnings',async c=>{
  const body=(await c.req.json()) as AuthedBody;
  return c.json(rooms.ownWinnings(db,c.req.param('code'),playerId(body),sessionSecret(body)));
});

app.post("/api/rooms/:code/roll", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.roll(db, code, playerId(body), sessionSecret(body));
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

app.post("/api/rooms/:code/place", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { value?: unknown };
  rooms.place(db, code, playerId(body), sessionSecret(body), Number(body.value));
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  // A placement can end the round (phase -> round_end), which flips the
  // bound table's displayed status for anyone watching from the bar.
  if (state.phase === "round_end" || state.phase === "game_end") publishBarSnapshot();
  return c.json(state);
});

app.post("/api/rooms/:code/heartbeat", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.heartbeat(db, code, playerId(body), sessionSecret(body));
  // Deliberately does NOT clear a pending away-from-table departure — the
  // exact bug a follow-up review caught: a heartbeat fires automatically
  // every few seconds for as long as a room tab is open, including one
  // left open in the background while that same identity's bar avatar
  // sits at a completely different table or dining chair. "The browser
  // is still connected" proves nothing about whether the person actually
  // went back to *this* table — only an explicit bar-world action does
  // (src/tables.ts's resumeActiveTable). See CLAUDE.md's leave/exit
  // states for the reasoning and PLAN.md's product-direction-update
  // entry for the reproduction this fixes.
  // Deliberately minimal response — a heartbeat fires every few seconds
  // per player; it doesn't need to carry the full room state back each
  // time. But this heartbeat can be exactly what flips someone's own
  // `connected` flag back to true for everyone else watching, so recheck
  // and push if so — immediate "they're back", not just on the next
  // ticker pass (see tickRoomPresence above).
  tickRoomPresence(code);
  return c.json({ ok: true });
});

app.post("/api/rooms/:code/ready", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { ready?: unknown };
  rooms.setReady(db, code, playerId(body), sessionSecret(body), body.ready === true);
  // Ready/cancel-ready never changes what a table shows from the bar
  // (phase stays "lobby", player count and colors are unaffected) — only
  // the room's own lobby view needs this, not a bar broadcast too.
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

app.post("/api/rooms/:code/leave", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.leaveRoom(db, code, playerId(body), sessionSecret(body));
  // Leaving frees a color (and can close the room) — both visible on a
  // bound table's status from the bar, not just inside the room's lobby.
  publishRoomState(code, rooms.getPublicState(db, code));
  publishBarSnapshot();
  return c.json({ ok: true });
});

app.post("/api/rooms/:code/exit", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.exitGame(db, code, playerId(body), sessionSecret(body));
  publishRoomState(code, rooms.getPublicState(db, code));
  publishBarSnapshot();
  return c.json({ ok: true });
});

app.post('/api/rooms/:code/depart',async(c)=>{
  const body=(await c.req.json()) as AuthedBody;
  const code=c.req.param('code');
  rooms.departGame(db,code,playerId(body),sessionSecret(body));
  // Reconcile and push voice removal now; the game seat still has its grace.
  publishRoomState(code,rooms.getPublicState(db,code));
  return c.json({ok:true});
});
app.post('/api/rooms/:code/resume',async(c)=>{
  const body=(await c.req.json()) as AuthedBody;
  rooms.resumeGame(db,c.req.param('code'),playerId(body),sessionSecret(body));return c.json(currentRoomState(c.req.param('code')));
});

app.post("/api/rooms/:code/disband", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { confirm?: unknown };
  rooms.disbandRoom(db, code, playerId(body), sessionSecret(body), body.confirm === true);
  // Closes the room — the remaining lobby view needs to see `closed` without
  // a reload, and a bound table frees up for the bar view too.
  publishRoomState(code, rooms.getPublicState(db, code));
  publishBarSnapshot();
  return c.json({ ok: true });
});

// ---- Phase 3 (product-direction-update): online-table join approval —
// all plain room-session actions, no bar identity involved (the host
// already has their own room credentials from being seated; CLAUDE.md's
// bar/game separation). ----

app.post("/api/rooms/:code/requests/:requestId/approve", async (c) => {
  const code = c.req.param("code");
  const requestId = c.req.param("requestId");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.approveJoin(db, code, playerId(body), sessionSecret(body), requestId);
  // A newly-seated player changes both the room's own lobby view and the
  // bar's table-status view (playerCount, takenColors). Returns the fresh
  // state, same convention every other room mutation follows, so the
  // host's own client can apply it directly.
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  publishBarSnapshot();
  return c.json(state);
});

app.post("/api/rooms/:code/requests/:requestId/reject", async (c) => {
  const code = c.req.param("code");
  const requestId = c.req.param("requestId");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.rejectJoin(db, code, playerId(body), sessionSecret(body), requestId);
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

app.post("/api/rooms/:code/requests/cancel", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.cancelJoinRequest(db, code, playerId(body), sessionSecret(body));
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

// ---- Room voice calls (phone-style invite calling, Online rooms only —
// CLAUDE.md's voice-call section). Every route re-verifies a real
// session, current seat, human controller and room/call identity itself
// (src/voice.ts's own requireSeatedHumanPlayer and callId checks) — never
// trusts a client-claimed state. Every mutation re-broadcasts the room's
// public state so the new voiceCall summary (participant count, who's
// joined/muted) reaches every open SSE viewer within about a second, same
// as any other room mutation; the personal side (an invite landing, a
// forced removal, SDP/ICE signaling) goes out over the separate private
// per-(room,player) channel below, never this broadcast.

app.post("/api/rooms/:code/voice/start", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  voice.startOrJoinCall(db, code, playerId(body), sessionSecret(body));
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

app.post("/api/rooms/:code/voice/respond", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { callId?: unknown; accept?: unknown };
  voice.respondToInvite(db, code, playerId(body), sessionSecret(body), String(body.callId ?? ""), body.accept === true);
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

app.post("/api/rooms/:code/voice/leave", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { callId?: unknown };
  voice.leaveCall(db, code, playerId(body), sessionSecret(body), String(body.callId ?? ""));
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

app.post("/api/rooms/:code/voice/mute", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { callId?: unknown; muted?: unknown };
  voice.setMuted(db, code, playerId(body), sessionSecret(body), String(body.callId ?? ""), body.muted === true);
  const state = publishRoomState(code, rooms.getPublicState(db, code));
  return c.json(state);
});

// Signaling relay — never broadcast, delivered only to the named
// recipient's own private channel (CLAUDE.md: "SDP、ICE、会话凭证不能广播
// 给公共 SSE 订阅者"). Deliberately does NOT call publishRoomState: a
// signal changes nothing about the call's public membership/mute state,
// only carries a private negotiation message between two already-joined
// participants.
app.post("/api/rooms/:code/voice/signal", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & {
    callId?: unknown;
    toPlayerId?: unknown;
    signalType?: unknown;
    data?: unknown;
  };
  voice.relaySignal(
    db,
    code,
    playerId(body),
    sessionSecret(body),
    String(body.callId ?? ""),
    String(body.toPlayerId ?? ""),
    String(body.signalType ?? ""),
    body.data,
  );
  return c.json({ ok: true });
});

// Authenticated personal fallback — what a client fetches on page
// load/reconnect to catch up on a pending invite or call state it might
// have missed while its own .../voice/events connection was down (the
// same "never trust a dropped connection alone" principle CLAUDE.md
// already states for the room/bar channels).
app.post("/api/rooms/:code/voice/state", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  return c.json(voice.getOwnVoiceView(db, code, playerId(body), sessionSecret(body)));
});

// The ICE server list (STUN always; TURN only if real credentials are
// configured via env — see src/iceConfig.ts) a joined participant's
// RTCPeerConnection needs to actually negotiate. Gated behind the same
// seated-human check as every other voice action — not because the STUN
// URL itself is sensitive, but because a configured TURN credential is
// exactly the kind of thing CLAUDE.md says must never be handed to an
// unauthenticated caller, and there is no cheaper way to tell "a real
// TURN secret" from "just the public STUN URL" at this call site than
// gating the whole response the same way.
app.post("/api/rooms/:code/voice/ice-servers", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.requireSeatedHumanPlayer(db, code, playerId(body), sessionSecret(body));
  return c.json({ iceServers: getIceServers() });
});

// This caller's own private voice channel — invites, forced removals,
// and the actual SDP/ICE signaling relay, scoped to exactly this
// (room, player) pair (src/live.ts's subscribeRoomVoice/
// publishToRoomVoice). Authenticated via query params, same reasoning
// as the chat inbox stream above (a GET/EventSource has no body).
app.get("/api/rooms/:code/voice/events", (c) => {
  const code = c.req.param("code");
  const pId = c.req.query("playerId") ?? "";
  const secret = c.req.query("sessionSecret") ?? "";
  rooms.requireSeatedHumanPlayer(db, code, pId, secret); // thrown synchronously, before streamSSE opens the response
  return streamSSE(c, async (stream) => {
    const send = (data: string) => {
      stream.writeSSE({ data }).catch(() => {});
    };
    const unsubscribe = live.subscribeRoomVoice(code, pId, send);
    stream.onAbort(() => unsubscribe());
    while (!stream.closed && !stream.aborted) {
      try {
        await stream.sleep(SSE_PING_MS);
      } catch {
        break;
      }
      if (stream.closed || stream.aborted) break;
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }
    unsubscribe();
  });
});

// ---- The bar (Phase 1: identity, movement, presence — see PLAN.md) ----

interface BarAuthedBody {
  playerId?: unknown;
  sessionSecret?: unknown;
}

function barPlayerId(body: BarAuthedBody): string {
  return typeof body.playerId === "string" ? body.playerId : "";
}

function barSessionSecret(body: BarAuthedBody): string {
  return typeof body.sessionSecret === "string" ? body.sessionSecret : "";
}

app.get("/api/bar/layout", (c) =>
  c.json({
    gridCols: GRID_COLS,
    gridRows: GRID_ROWS,
    tileSize: TILE_SIZE,
    furniture: FURNITURE,
    tables: bar.getGameTables(),
    // Phase 2 (product-direction-update): static dining/stool seat
    // positions — live occupancy comes from each streamed player's own
    // seatId, the same split FURNITURE/tables already uses.
    seats: bar.getSeatLayout(),
    gameChairs: GAME_CHAIRS,
  }),
);

// Every bar response below now carries {seq, players, tables} instead of
// just {players} — a plain read reports the *current* seq (no mutation
// happened just by being read); a mutation bumps it once and broadcasts
// the identical payload to every other open SSE connection, so the
// actor's own response and everyone else's pushed copy always agree.
app.get("/api/bar/state", (c) => c.json(barSnapshot(live.currentBarSeq())));

app.post("/api/bar/join", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateJoinBody & { skin?: unknown };
  // Deliberately not asColor() — the bar's palette is separate from and
  // larger than the Vegas table's 4 (bar.BAR_COLORS), per PLAN.md.
  const result = bar.joinBar(db, asNickname(body), body.color as bar.BarColor, typeof body.skin === "string" ? body.skin : "warm");
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  // A brand-new bar identity has no prior table binding at all — always
  // null here, by construction, not a special case. Included anyway so
  // the client has one uniform contract across join/rejoin/appearance
  // rather than branching on whether the field is present.
  return c.json({ ...result, activeSeat: tables.getActiveSeat(db, result.playerId) }, 201);
});

app.post("/api/bar/rejoin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  bar.rejoinBar(db, barPlayerId(body), barSessionSecret(body));
  // A rejoin is re-authentication + a heartbeat — it can be exactly what
  // makes this patron visible again to everyone else, so recheck and push
  // if so (tickBarPresence's own diff decides whether anything actually
  // changed; this call itself never bumps seq just for being asked).
  tickBarPresence();
  // `activeSeat` is this caller's own re-validated table binding (or
  // null) — attached only to this direct response, never to the
  // broadcast `barSnapshot` every other subscriber receives (that stays
  // exactly what it was: public player/table data, nothing identity-
  // specific). This is what "Return to your game" is driven by
  // client-side now, instead of a locally-cached room code (PLAN.md's
  // product-direction-update entry — the bug an independent review and
  // the student both caught: a new bar character inheriting a stale
  // previous character's game).
  return c.json({ ...barSnapshot(live.currentBarSeq()), activeSeat: tables.getActiveSeat(db, barPlayerId(body)) });
});

app.post("/api/bar/appearance", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & CreateJoinBody & { skin?: unknown };
  bar.updateAppearance(db, barPlayerId(body), barSessionSecret(body), asNickname(body), body.color as bar.BarColor, typeof body.skin === "string" ? body.skin : "warm");
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  return c.json({ ...snap, activeSeat: tables.getActiveSeat(db, barPlayerId(body)) });
});

app.post("/api/bar/heartbeat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  bar.barHeartbeat(db, barPlayerId(body), barSessionSecret(body));
  // Same reasoning as the room heartbeat above: this is exactly the
  // moment a stale patron can become visible again, so recheck and push
  // immediately rather than waiting for the ticker's next pass.
  tickBarPresence();
  return c.json({ ok: true, activeSeat: tables.getActiveSeat(db, barPlayerId(body)) });
});

app.post("/api/bar/move", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { x?: unknown; y?: unknown };
  bar.moveBar(db, barPlayerId(body), barSessionSecret(body), Number(body.x), Number(body.y));
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  return c.json(snap);
});

// Public tavern speech (product-direction-update, part 3's replacement
// for private 1:1 chat) — rides the same public bar snapshot/SSE
// broadcast every other bar mutation already does, no separate channel:
// a bubble appearing is exactly as visible to everyone watching as a
// patron moving or sitting down already is.
app.post("/api/bar/say", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { clientMsgId?: unknown; text?: unknown };
  bar.say(
    db,
    barPlayerId(body),
    barSessionSecret(body),
    typeof body.clientMsgId === "string" ? body.clientMsgId : "",
    typeof body.text === "string" ? body.text : "",
  );
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  return c.json(snap);
});

// ---- Phase 2 (product-direction-update): real dining/stool seats ----

app.post("/api/bar/seats/:seatId/sit", async (c) => {
  const seatId = c.req.param("seatId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  bar.sitAtSeat(db, barPlayerId(body), barSessionSecret(body), seatId);
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  return c.json(snap);
});

app.post("/api/bar/stand", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  bar.standFromSeat(db, barPlayerId(body), barSessionSecret(body));
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  return c.json(snap);
});

// Fired (best-effort — see public/app.js's backToHomeButton) when a
// patron navigates from a table-bound game room's view back to the bar,
// independent of src/bar.ts's sitAtSeat starting the same clock for the
// "sat down somewhere else instead" trigger (CLAUDE.md's leave/exit
// states).
app.post("/api/bar/depart", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  tables.departActiveTable(db, barPlayerId(body), barSessionSecret(body));
  return c.json({ ok: true });
});

// The one thing that clears a pending departure — see
// tables.resumeActiveTable's own doc comment for why this has to be a
// deliberate, explicit bar-world action and not a passive room
// heartbeat/rejoin (a follow-up review caught an earlier version doing
// exactly that, which was wrong).
app.post("/api/bar/resume", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  tables.resumeActiveTable(db, barPlayerId(body), barSessionSecret(body));
  return c.json({ ok: true, activeSeat: tables.getActiveSeat(db, barPlayerId(body)) });
});

// ---- Phase 2: each Vegas table bound to its own independent room ----

app.get("/api/bar/tables", (c) => c.json(tables.getTablesStatus(db)));

app.post("/api/bar/tables/:tableId/create", async (c) => {
  const tableId = c.req.param("tableId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { color?: unknown };
  const result = tables.createTableRoom(db, tableId, barPlayerId(body), barSessionSecret(body), body.color as Color);
  // A new table-bound room exists, and the bar's own table-status view
  // changed — both channels get a push.
  publishRoomState(result.code, rooms.getPublicState(db, result.code));
  publishBarSnapshot();
  return c.json(result, 201);
});

app.post("/api/bar/tables/:tableId/join", async (c) => {
  const tableId = c.req.param("tableId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { color?: unknown };
  const result = tables.joinTableRoom(db, tableId, barPlayerId(body), barSessionSecret(body), body.color as Color);
  publishRoomState(result.code, rooms.getPublicState(db, result.code));
  publishBarSnapshot();
  return c.json(result, 201);
});

// A solo Vegas-NPC table (Crit 9 phase 8) — no waiting, no approval, and
// deliberately no publishBarSnapshot(): an NPC table's own shared status
// never changes (it always just reports "empty/startable" regardless of
// how many private games are running there — src/tables.ts's
// getTablesStatus), so there's nothing new for anyone else watching the
// bar to see.
app.post("/api/bar/tables/:tableId/start-npc", async (c) => {
  const tableId = c.req.param("tableId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { color?: unknown; playerCount?: unknown };
  // Defaults to 5 (the full table) when the client sends nothing — the
  // product default ("默认五人"), not a fallback for a missing feature;
  // tables.startNpcGame validates the real 2-COLORS.length range
  // regardless of what a client sends.
  const playerCount = typeof body.playerCount === "number" ? body.playerCount : 5;
  const result = tables.startNpcGame(db, tableId, barPlayerId(body), barSessionSecret(body), body.color as Color, playerCount);
  publishRoomState(result.code, rooms.getPublicState(db, result.code));
  return c.json(result, 201);
});

// ---- Proximity-triggered 1:1 chat (product-direction-update, part 3) ----
//
// Every mutating action here is a plain POST with {playerId,
// sessionSecret} like every other bar action; the two read-only/stream
// routes accept the same pair as query parameters instead, since a GET
// has no body and EventSource can't attach custom headers — the
// server-side check (src/chat.ts's requireBarSession/requireThreadAccess)
// is identical either way, only where the proof travels differs.

app.post("/api/bar/chat/open", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { otherPlayerId?: unknown };
  const otherPlayerId = typeof body.otherPlayerId === "string" ? body.otherPlayerId : "";
  const result = chat.openThread(db, barPlayerId(body), barSessionSecret(body), otherPlayerId);
  return c.json(result, 201);
});

app.get("/api/bar/chat/:threadId/messages", (c) => {
  const threadId = c.req.param("threadId");
  const pId = c.req.query("playerId") ?? "";
  const secret = c.req.query("sessionSecret") ?? "";
  chat.requireThreadAccess(db, threadId, pId, secret);
  const afterId = Number(c.req.query("afterId") ?? "0") || 0;
  return c.json({ messages: chat.listMessages(db, threadId, afterId) });
});

app.post("/api/bar/chat/:threadId/send", async (c) => {
  const threadId = c.req.param("threadId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { clientMsgId?: unknown; body?: unknown };
  const sender = barPlayerId(body);
  const message = chat.sendMessage(
    db,
    threadId,
    sender,
    barSessionSecret(body),
    typeof body.clientMsgId === "string" ? body.clientMsgId : "",
    typeof body.body === "string" ? body.body : "",
  );
  // Delivered only to the two participants' own authenticated inbox
  // channels (src/live.ts) — never the shared public bar SSE stream
  // (CLAUDE.md). Includes the sender's own id so the push is pushed to
  // the sender's *other* open tabs/devices too, each of which applies it
  // the same idempotent way a direct response already would.
  const other = chat.otherParticipantOf(db, threadId, sender);
  const senderNickname = (db.prepare(`SELECT nickname FROM bar_players WHERE id = ?`).get(sender) as { nickname: string } | undefined)?.nickname ?? "";
  const payload = { ...message, senderNickname };
  live.publishToPlayer(sender, payload);
  live.publishToPlayer(other, payload);
  return c.json(message, 201);
});

// ---- Real-time push (Crit 9) — see CLAUDE.md for what this transport is
// and isn't allowed to carry: server-computed public state outward only,
// never a client write. src/live.ts holds the in-process subscriber
// registry; everything here just wires an SSE connection to it. ----

const SSE_PING_MS = 20000;

app.get("/api/rooms/:code/events", (c) => {
  const code = c.req.param("code");
  // Thrown synchronously, before streamSSE opens the response — caught by
  // the same app.onError as every other route, same RoomError shape
  // (e.g. a nonexistent code still answers 404 room_not_found, not a
  // silently-empty stream).
  const initial = currentRoomState(code);
  return streamSSE(c, async (stream) => {
    const send = (data: string) => {
      stream.writeSSE({ data }).catch(() => {});
    };
    const unsubscribe = live.subscribeRoom(code, send);
    stream.onAbort(() => unsubscribe());
    await stream.writeSSE({ data: JSON.stringify(initial) }).catch(() => {});
    while (!stream.closed && !stream.aborted) {
      try {
        await stream.sleep(SSE_PING_MS);
      } catch {
        break;
      }
      if (stream.closed || stream.aborted) break;
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }
    unsubscribe();
  });
});

app.get("/api/bar/events", (c) => {
  return streamSSE(c, async (stream) => {
    const send = (data: string) => {
      stream.writeSSE({ data }).catch(() => {});
    };
    const unsubscribe = live.subscribeBar(send);
    stream.onAbort(() => unsubscribe());
    await stream.writeSSE({ data: JSON.stringify(barSnapshot(live.currentBarSeq())) }).catch(() => {});
    while (!stream.closed && !stream.aborted) {
      try {
        await stream.sleep(SSE_PING_MS);
      } catch {
        break;
      }
      if (stream.closed || stream.aborted) break;
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }
    unsubscribe();
  });
});

// The private chat inbox channel — one per bar identity, authenticated
// via query params (see the chat section above for why), never the
// shared bar channel. No initial snapshot payload: unlike a room/the bar
// (one piece of state with one current value), this channel only ever
// carries individual message events as they happen — a client fetches a
// specific thread's own history via GET .../messages when it opens that
// dialog, which is also how it catches up on anything sent while this
// stream was disconnected.
app.get("/api/bar/chat/events", (c) => {
  const pId = c.req.query("playerId") ?? "";
  const secret = c.req.query("sessionSecret") ?? "";
  bar.requireBarSession(db, pId, secret); // thrown synchronously, before streamSSE opens the response
  return streamSSE(c, async (stream) => {
    const send = (data: string) => {
      stream.writeSSE({ data }).catch(() => {});
    };
    const unsubscribe = live.subscribeChatInbox(pId, send);
    stream.onAbort(() => unsubscribe());
    while (!stream.closed && !stream.aborted) {
      try {
        await stream.sleep(SSE_PING_MS);
      } catch {
        break;
      }
      if (stream.closed || stream.aborted) break;
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }
    unsubscribe();
  });
});

// Presence can change a room's or the bar's publicly-visible state with
// no mutating action at all — a heartbeat simply stopping, or a lobby
// seat finally going past its disconnect grace. Nothing calls an endpoint
// when that happens, so nothing would otherwise trigger a push: an open
// SSE viewer would only find out on someone else's next unrelated action,
// or the 10s client-side fallback poll (Crit 9 phase 7's independent
// review, problem 2 — see PLAN.md). This re-checks every *currently
// watched* channel (never an unwatched one — live.subscribedRoomCodes /
// hasBarSubscribers do nothing when nobody's connected) on a short
// interval, and only actually republishes when tickRoomPresence /
// tickBarPresence's own diff finds a real change — not a blind push every
// tick.
//
// This does not reintroduce the background-sweep timer CLAUDE.md rules
// out for the lobby disconnect grace: that grace condition is still
// evaluated lazily, as "now minus last heartbeat", by the exact same
// rooms.getPublicState call a GET already makes. This loop is just an
// extra caller of that same read, bounded to rooms someone is actually
// watching live — not a new mutation path, and genuinely idle (no DB
// work at all) whenever nobody's connected to either channel, which is
// what keeps it compatible with Fly's auto_stop_machines: an asleep
// machine has no open SSE connections, so every iteration of this loop is
// a no-op until something wakes it up the normal way (a real request).
function sweepTableDepartures(): void {
  const affectedCodes = [...new Set([...tables.enforceExpiredDepartures(db, AWAY_FROM_TABLE_MS),...rooms.expireGameDepartures(db,AWAY_FROM_TABLE_MS)])];
  for (const code of affectedCodes) publishRoomState(code, rooms.getPublicState(db, code));
  if (affectedCodes.length > 0) publishBarSnapshot();
}

setInterval(() => {
  if (live.hasBarSubscribers()) tickBarPresence();
  for (const code of live.subscribedRoomCodes()) tickRoomPresence(code);

  // The 3-minute away-from-table clock (CLAUDE.md's leave/exit states):
  // same "only while something's actually watching" gate as presence
  // above, since there's no point enforcing a clock nobody can see the
  // result of and the machine would otherwise be asleep anyway. Unlike
  // the presence tick's own diff-before-publish, this always re-publishes
  // whatever rooms tables.enforceExpiredDepartures actually changed
  // (pre-start leave, or a started game's NPC handoff) — those are real
  // mutations with their own version bump already, not a presence-only
  // recompute, so there's nothing to diff against.
  if (live.hasBarSubscribers() || live.subscribedRoomCodes().length > 0) {
    sweepTableDepartures();
  }

  // Minimal viable NPC turn-taking (Crit 9 phase 8's production-risk
  // fix): a departure handoff alone only flips `controller` — without
  // this, a started game with a handed-off seat would simply sit
  // turn-stalled forever. Scoped to rooms someone's actually watching,
  // same reasoning as everything else in this ticker.
  for (const code of live.subscribedRoomCodes()) scheduleNpcTurnIfNeeded(code);
}, LIVE_PRESENCE_TICK_MS);

// No `index` option — "/" is handled explicitly above (it needs
// templating, not a raw file serve); this just serves app.js, styles.css,
// etc. The `?v=` query string on those is ignored for path matching
// (serveStatic matches by pathname only), which is exactly what makes it
// work as a cache-busting token rather than a routing concern.
registerPoker(app,db);
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`listening on http://0.0.0.0:${info.port}`);
});
