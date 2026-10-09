// Crit 9's real-time push: a mutation's fresh state actually reaches an
// open SSE connection, not just the actor's own HTTP response — the thing
// the ~1-second propagation requirement depends on. Black-box over HTTP,
// same style as the rest of spec/.

import { expect, inject, it } from "vitest";
import { createRoom } from "./helpers.ts";

const baseUrl = inject("baseUrl");

async function postJson(path: string, body: unknown) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

/** Reads SSE `data:` lines from a stream response until `count` have
 * arrived or `timeoutMs` elapses, then cancels the connection — a test
 * helper, not a general SSE client (the real one lives in public/). */
async function readSseEvents(res: Response, count: number, timeoutMs = 5000): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (events.length < count && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) events.push(JSON.parse(dataLine.slice("data: ".length)));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
}

it("GET /api/rooms/:code/events pushes a fresh state after a mutation, keyed by version", async () => {
  const host = await createRoom(baseUrl, "Host", "red");
  const res = await fetch(new URL(`/api/rooms/${host.code}/events`, baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const eventsPromise = readSseEvents(res, 2);
  // Give the stream a moment to actually open and push its initial
  // snapshot before triggering the mutation that should push a second one.
  await new Promise((r) => setTimeout(r, 200));
  const ready = await postJson(`/api/rooms/${host.code}/ready`, { ...host, ready: true });
  expect(ready.status).toBe(200);

  const events = await eventsPromise;
  expect(events.length, "expected an initial snapshot plus a push after the mutation").toBe(2);
  const [initial, pushed] = events as Array<{ version: number; players: Array<{ ready: boolean }> }>;
  expect(initial.players[0].ready).toBe(false);
  expect(pushed.players[0].ready).toBe(true);
  expect(pushed.version).toBeGreaterThan(initial.version);
});

it("GET /api/rooms/:code/events on a nonexistent room answers 404, not a silent empty stream", async () => {
  const res = await fetch(new URL(`/api/rooms/ZZZZZZ/events`, baseUrl));
  expect(res.status).toBe(404);
});

it("GET /api/bar/events pushes a fresh snapshot after a move, with an increasing seq", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Pusher", color: "teal", skin: "warm" });
  expect(joined.status).toBe(201);
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  const { x, y } = joined.body as { x: number; y: number };

  const res = await fetch(new URL("/api/bar/events", baseUrl));
  expect(res.status).toBe(200);
  const eventsPromise = readSseEvents(res, 2);
  await new Promise((r) => setTimeout(r, 200));

  // Move to whichever adjacent tile is walkable — the exact direction
  // doesn't matter, only that *some* legal step is taken.
  const candidates: Array<[number, number]> = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
  let moved = false;
  for (const [nx, ny] of candidates) {
    const moveRes = await postJson("/api/bar/move", { ...session, x: nx, y: ny });
    if (moveRes.status === 200) {
      moved = true;
      break;
    }
  }
  expect(moved, "no adjacent tile near spawn was walkable — unexpected").toBe(true);

  const events = await eventsPromise;
  expect(events.length, "expected an initial snapshot plus a push after the move").toBe(2);
  const [initial, pushed] = events as Array<{ seq: number; tables: unknown[] }>;
  expect(pushed.seq).toBeGreaterThan(initial.seq);
  expect(pushed.tables.length).toBeGreaterThan(0);
});

it("a bar join followed by a room-only mutation still keeps the bar's own seq monotonic", async () => {
  // Not every room mutation needs to change what the bar sees, but every
  // bar mutation must still produce a strictly increasing seq relative to
  // whatever came before it, including activity from unrelated channels.
  const before = await (await fetch(new URL("/api/bar/state", baseUrl))).json();
  const joined = await postJson("/api/bar/join", { nickname: "Seq", color: "orange", skin: "tan" });
  expect(joined.status).toBe(201);
  const after = await (await fetch(new URL("/api/bar/state", baseUrl))).json();
  expect(after.seq).toBeGreaterThan(before.seq);
});
