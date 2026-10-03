// Entry point. Serves the client, the API, and /readme/ — see CLAUDE.md
// for the request-handling rules every route below holds to, and
// PLAN.md for what each endpoint is for.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { dbPathFromEnv, openDb } from "./db.ts";
import { renderReadme } from "./markdown.ts";
import { RoomError } from "./rooms.ts";
import * as rooms from "./rooms.ts";
import type { Color } from "./types.ts";

const db = openDb(dbPathFromEnv());
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof RoomError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400 | 403 | 404 | 409 | 410);
  }
  console.error(err);
  return c.json({ error: "internal_error", message: "something went wrong" }, 500);
});

app.get("/readme/", (c) => c.html(renderReadme()));

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

app.use("/*", serveStatic({ root: "./public", index: "index.html" }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`listening on http://0.0.0.0:${info.port}`);
});
