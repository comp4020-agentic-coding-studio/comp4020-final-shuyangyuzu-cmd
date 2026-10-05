// Entry point. Serves the client, the API, and /readme/ — see CLAUDE.md
// for the request-handling rules every route below holds to, and
// PLAN.md for what each endpoint is for.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import * as bar from "./bar.ts";
import { BarError } from "./bar.ts";
import { FURNITURE, GRID_COLS, GRID_ROWS, TILE_SIZE } from "./barLayout.ts";
import { dbPathFromEnv, openDb } from "./db.ts";
import { renderReadme } from "./markdown.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import { TableError } from "./tables.ts";
import * as tables from "./tables.ts";
import type { Color } from "./types.ts";
import { BUILD_VERSION, renderIndexHtml } from "./version.ts";

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
  return c.json(rooms.getPublicState(db, code));
});

app.get("/api/rooms/:code/state", (c) => {
  const code = c.req.param("code");
  return c.json(rooms.getPublicState(db, code));
});

app.post("/api/rooms/:code/start", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.startGame(db, code, playerId(body), sessionSecret(body));
  return c.json(rooms.getPublicState(db, code));
});

app.post("/api/rooms/:code/roll", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.roll(db, code, playerId(body), sessionSecret(body));
  return c.json(rooms.getPublicState(db, code));
});

app.post("/api/rooms/:code/place", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { value?: unknown };
  rooms.place(db, code, playerId(body), sessionSecret(body), Number(body.value));
  return c.json(rooms.getPublicState(db, code));
});

app.post("/api/rooms/:code/heartbeat", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.heartbeat(db, code, playerId(body), sessionSecret(body));
  // Deliberately minimal — a heartbeat fires every few seconds per
  // player; it doesn't need to carry the full room state back each time.
  return c.json({ ok: true });
});

app.post("/api/rooms/:code/ready", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { ready?: unknown };
  rooms.setReady(db, code, playerId(body), sessionSecret(body), body.ready === true);
  return c.json(rooms.getPublicState(db, code));
});

app.post("/api/rooms/:code/leave", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody;
  rooms.leaveRoom(db, code, playerId(body), sessionSecret(body));
  return c.json({ ok: true });
});

app.post("/api/rooms/:code/disband", async (c) => {
  const code = c.req.param("code");
  const body = (await c.req.json().catch(() => ({}))) as AuthedBody & { confirm?: unknown };
  rooms.disbandRoom(db, code, playerId(body), sessionSecret(body), body.confirm === true);
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

app.get("/api/bar/state", (c) => c.json(bar.getPublicBarState(db)));

app.post("/api/bar/join", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateJoinBody & { skin?: unknown };
  // Deliberately not asColor() — the bar's palette is separate from and
  // larger than the Vegas table's 4 (bar.BAR_COLORS), per PLAN.md.
  const result = bar.joinBar(db, asNickname(body), body.color as bar.BarColor, typeof body.skin === "string" ? body.skin : "warm");
  return c.json(result, 201);
});

app.post("/api/bar/rejoin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  bar.rejoinBar(db, barPlayerId(body), barSessionSecret(body));
  return c.json(bar.getPublicBarState(db));
});

app.post("/api/bar/appearance", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & CreateJoinBody & { skin?: unknown };
  bar.updateAppearance(db, barPlayerId(body), barSessionSecret(body), asNickname(body), body.color as bar.BarColor, typeof body.skin === "string" ? body.skin : "warm");
  return c.json(bar.getPublicBarState(db));
});

app.post("/api/bar/heartbeat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody;
  bar.barHeartbeat(db, barPlayerId(body), barSessionSecret(body));
  return c.json({ ok: true });
});

app.post("/api/bar/move", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { x?: unknown; y?: unknown };
  bar.moveBar(db, barPlayerId(body), barSessionSecret(body), Number(body.x), Number(body.y));
  return c.json(bar.getPublicBarState(db));
});

// ---- Phase 2: each Vegas table bound to its own independent room ----

app.get("/api/bar/tables", (c) => c.json(tables.getTablesStatus(db)));

app.post("/api/bar/tables/:tableId/create", async (c) => {
  const tableId = c.req.param("tableId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { color?: unknown };
  const result = tables.createTableRoom(db, tableId, barPlayerId(body), barSessionSecret(body), body.color as Color);
  return c.json(result, 201);
});

app.post("/api/bar/tables/:tableId/join", async (c) => {
  const tableId = c.req.param("tableId");
  const body = (await c.req.json().catch(() => ({}))) as BarAuthedBody & { color?: unknown };
  const result = tables.joinTableRoom(db, tableId, barPlayerId(body), barSessionSecret(body), body.color as Color);
  return c.json(result, 201);
});

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
