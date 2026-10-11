// Crit 9's real-time push: a mutation's fresh state actually reaches an
// open SSE connection, not just the actor's own HTTP response — the thing
// the ~1-second propagation requirement depends on. Black-box over HTTP,
// same style as the rest of spec/.

import { expect, inject, it } from "vitest";
import { createRoom, heartbeat, joinRoom } from "./helpers.ts";
import { PRESENCE_STALE_MS } from "../src/presence.ts";

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

/** Like readSseEvents, but keeps reading for the full `timeoutMs` window
 * instead of stopping at a fixed count — for watching a connection that
 * should receive some unknown-in-advance number of pushes (zero, one, or
 * more) purely from time passing, with nobody taking any action. Used
 * below to catch a presence-driven push (Crit 9 phase 7's independent
 * review, problem 2), which a fixed-count reader can't wait for. */
async function collectSseEvents(res: Response, timeoutMs: number): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        reader.read(),
        new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), remaining)),
      ]);
      if (result === timedOut) break;
      const { value, done } = result as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        // A keep-alive ping is `event: ping\ndata: ` — an empty payload,
        // deliberately not JSON-parsed.
        if (dataLine && dataLine.length > "data: ".length) events.push(JSON.parse(dataLine.slice("data: ".length)));
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

// ---- Crit 9 phase 7: an independent review's two findings -----------
//
// 1. src/live.ts's sequence counters are in-memory and reset to 0 on a
//    restart, but a client's own high-water mark doesn't — the fix is
//    covered at the unit level in spec/liveSync.test.ts (shouldApplyLiveUpdate)
//    plus a real kill-and-restart-with-an-open-page check recorded in
//    PLAN.md (not reproducible inside this always-up shared server).
// 2. Presence (connected/online) can change a room's or the bar's public
//    view with no mutating action at all — nothing used to bump a
//    sequence number or broadcast anything when that happened. The tests
//    below are the real, automated regression check for that: they wait
//    out the actual production PRESENCE_STALE_MS default with an SSE
//    connection open the whole time and nobody taking any action, same
//    trade-off spec/settlement.test.ts already makes elsewhere in this
//    suite for a different slow-but-real check (an explicit, generous
//    per-test timeout rather than a shortened production default).

it("room payloads carry a process epoch and a push-revision (rev) distinct from the DB's version column", async () => {
  const host = await createRoom(baseUrl, "Epoch", "red");
  const state = (await (await fetch(new URL(`/api/rooms/${host.code}/state`, baseUrl))).json()) as {
    epoch: number;
    rev: number;
    version: number;
  };
  expect(typeof state.epoch).toBe("number");
  expect(typeof state.rev).toBe("number");
  expect(typeof state.version).toBe("number");

  // Same process, same epoch, wherever it's reported from.
  const res = await fetch(new URL(`/api/rooms/${host.code}/events`, baseUrl));
  const [initial] = (await readSseEvents(res, 1)) as Array<{ epoch: number }>;
  expect(initial.epoch).toBe(state.epoch);
});

it("bar payloads carry the same process epoch across a plain read and the SSE channel", async () => {
  const state = (await (await fetch(new URL("/api/bar/state", baseUrl))).json()) as { epoch: number };
  expect(typeof state.epoch).toBe("number");

  const res = await fetch(new URL("/api/bar/events", baseUrl));
  const [initial] = (await readSseEvents(res, 1)) as Array<{ epoch: number }>;
  expect(initial.epoch).toBe(state.epoch);
});

it("a heartbeat that changes nobody's visible state doesn't bump the room's push-revision (no spurious churn)", async () => {
  const host = await createRoom(baseUrl, "Steady", "red");
  const before = (await (await fetch(new URL(`/api/rooms/${host.code}/state`, baseUrl))).json()) as { rev: number; version: number };
  const hb = await heartbeat(baseUrl, host.code, host);
  expect(hb.status).toBe(200);
  const after = (await (await fetch(new URL(`/api/rooms/${host.code}/state`, baseUrl))).json()) as { rev: number; version: number };
  expect(after.rev).toBe(before.rev);
  expect(after.version).toBe(before.version);
});

// No bar-channel equivalent of the "no spurious churn" check above: the
// bar's seq is one single global counter shared by every bar patron in
// this entire test run (unlike a room, which gets its own isolated rev
// per randomly-generated code), and this suite already runs its spec
// files concurrently against one shared server — see the "keeps the
// bar's own seq monotonic" test above, which is itself written to
// tolerate exactly that (`toBeGreaterThan`, never equality). A before/
// after equality check here would be genuinely flaky, not a real signal:
// another file's bar join or move landing in the same window would bump
// it too, correctly, for reasons that have nothing to do with this test.

const PRESENCE_WAIT_MS = PRESENCE_STALE_MS + 2000; // comfortably past the stale threshold, plus margin for the 1s presence-ticker interval and test overhead
const PRESENCE_TEST_TIMEOUT_MS = PRESENCE_WAIT_MS + 5000;

it.concurrent(
  "a room player's connected flag going stale reaches an already-open SSE connection on its own, with no mutating action taken (Crit 9 review, problem 2)",
  async () => {
    const host = await createRoom(baseUrl, "Quiet", "red");
    await joinRoom(baseUrl, host.code, "Still", "blue");
    // Neither player heartbeats again after this point, and nothing else
    // touches this room, for the whole wait below.

    const res = await fetch(new URL(`/api/rooms/${host.code}/events`, baseUrl));
    const events = (await collectSseEvents(res, PRESENCE_WAIT_MS)) as Array<{
      players: Array<{ connected: boolean }>;
    }>;

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].players.every((p) => p.connected)).toBe(true);

    const last = events[events.length - 1];
    expect(
      last.players.some((p) => !p.connected),
      "expected a later push showing at least one player gone stale, with nobody ever taking an action",
    ).toBe(true);
  },
  PRESENCE_TEST_TIMEOUT_MS,
);

it.concurrent(
  "a bar patron going stale disappears from an already-open SSE connection on its own, with no mutating action taken (Crit 9 review, problem 2)",
  async () => {
    const joined = await postJson("/api/bar/join", { nickname: "Lonely", color: "pink", skin: "deep" });
    expect(joined.status).toBe(201);
    // No further heartbeat, move, or any other action for this patron
    // for the whole wait below.

    const res = await fetch(new URL("/api/bar/events", baseUrl));
    const events = (await collectSseEvents(res, PRESENCE_WAIT_MS)) as Array<{ players: Array<{ id: string }> }>;

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].players.some((p) => p.id === joined.body.playerId)).toBe(true);

    const last = events[events.length - 1];
    expect(
      last.players.some((p) => p.id === joined.body.playerId),
      "expected the patron to have disappeared from a later push once their heartbeat went stale, with nobody taking any action",
    ).toBe(false);
  },
  PRESENCE_TEST_TIMEOUT_MS,
);
