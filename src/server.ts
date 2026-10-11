// Entry point. Serves the client, the API, and /readme/ — see CLAUDE.md
// for the request-handling rules every route below holds to, and
// PLAN.md for what each endpoint is for.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as bar from "./bar.ts";
import { BarError } from "./bar.ts";
import { FURNITURE, GRID_COLS, GRID_ROWS, TILE_SIZE } from "./barLayout.ts";
import { dbPathFromEnv, openDb } from "./db.ts";
import * as live from "./live.ts";
import { renderReadme } from "./markdown.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import { TableError } from "./tables.ts";
import * as tables from "./tables.ts";
import type { Color, PublicState } from "./types.ts";
import { BUILD_VERSION, renderIndexHtml } from "./version.ts";

// Every outgoing room payload carries `epoch` (SERVER_EPOCH, constant for
// this process) and `rev` (this room's own push-revision, src/live.ts) in
// addition to the existing `version` (the DB's optimistic-concurrency
// column, still reused by game actions for idempotency — unaffected).
// `rev` is the client's staleness gate from here on, not `version`: see
// src/live.ts's header for why a heartbeat or presence timeout bumping
// `version` would be wrong (it would make an unrelated roll/place race
// against it), and PLAN.md's Crit 9 phase 7 entry for the independent
// review that caught this.
type LivePublicState = PublicState & live.LiveCursor;

function withLiveCursor(state: PublicState, rev: number): LivePublicState {
  return { ...state, epoch: live.SERVER_EPOCH, rev };
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
 * actually broadcast to decide whether there's anything new to push. */
function roomPresenceSignature(state: PublicState): string {
  return JSON.stringify({
    closed: state.closed,
    hostPlayerId: state.hostPlayerId,
    players: state.players.map((p) => ({ id: p.id, connected: p.connected })),
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

const db = openDb(dbPathFromEnv());
const app = new Hono();

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
  c.header("Cache-Control", "no-cache");
});

app.onError((err, c) => {
  if (err instanceof RoomError || err instanceof BarError || err instanceof TableError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400 | 403 | 404 | 409 | 410);
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
  if (state.phase === "round_end") publishBarSnapshot();
  return c.json(state);
});

app.post("/api/rooms/:code/heartbeat", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.heartbeat(db, code, playerId(body), sessionSecret(body));
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
  c.json({ gridCols: GRID_COLS, gridRows: GRID_ROWS, tileSize: TILE_SIZE, furniture: FURNITURE, tables: bar.getGameTables() }),
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
  return c.json({ ok: true });
});

app.post("/api/bar/move", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { x?: unknown; y?: unknown };
  bar.moveBar(db, barPlayerId(body), barSessionSecret(body), Number(body.x), Number(body.y));
  const snap = barSnapshot(live.bumpBarSeq());
  live.publishBar(snap);
  return c.json(snap);
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
setInterval(() => {
  if (live.hasBarSubscribers()) tickBarPresence();
  for (const code of live.subscribedRoomCodes()) tickRoomPresence(code);
}, LIVE_PRESENCE_TICK_MS);

// No `index` option — "/" is handled explicitly above (it needs
// templating, not a raw file serve); this just serves app.js, styles.css,
// etc. The `?v=` query string on those is ignored for path matching
// (serveStatic matches by pathname only), which is exactly what makes it
// work as a cache-busting token rather than a routing concern.
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`listening on http://0.0.0.0:${info.port}`);
});
