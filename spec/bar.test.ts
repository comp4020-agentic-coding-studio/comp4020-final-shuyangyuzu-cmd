// The bar's Phase 1 server behavior: identity, presence, and
// server-validated grid movement. Black-box over HTTP, same style as the
// game's own spec files — see PLAN.md for the pivot this is part of.

import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

it("persists selected skin tone across rejoin and rejects unsupported appearance", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Appearance", color: "purple", skin: "deep" });
  expect(joined.status).toBe(201);
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  const recovered = await postJson("/api/bar/rejoin", session);
  expect(recovered.body.players.find((p: { id: string }) => p.id === session.playerId).skin).toBe("deep");
  const bad = await postJson("/api/bar/join", { nickname: "Invalid", color: "blue", skin: "anything" });
  expect(bad.status).toBe(400);
  const changed = await postJson("/api/bar/appearance", { ...session, nickname: "Same person", color: "blue", skin: "fair" });
  expect(changed.status).toBe(200);
  expect(changed.body.players.find((p: { id: string }) => p.id === session.playerId))
    .toMatchObject({ nickname: "Same person", color: "blue", skin: "fair" });
  const forbidden = await postJson("/api/bar/appearance", { ...session, sessionSecret: "wrong", nickname: "Impostor", color: "red", skin: "deep" });
  expect(forbidden.status).toBe(403);
});

async function postJson(path: string, body: unknown) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(path: string) {
  const res = await fetch(new URL(path, baseUrl));
  return { status: res.status, body: await res.json() };
}

it("exposes a fixed nine-table, two-row layout — 3 playable Vegas tables (2 online + 1 NPC), 6 reserved slots", async () => {
  const { body } = await getJson("/api/bar/layout");
  expect(body.gridCols).toBeGreaterThan(0);
  expect(body.gridRows).toBeGreaterThan(0);
  const vegas = body.tables.filter((t: { gameType: string }) => t.gameType === "vegas");
  const reserved = body.tables.filter((t: { available: boolean }) => !t.available);
  expect(vegas).toHaveLength(3);
  expect(reserved).toHaveLength(6);
  for (const t of reserved) {
    expect(t.label.toLowerCase()).toContain("not yet open");
  }
});

it("joining the bar spawns on a walkable tile and shows up in state", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Alice", color: "red" });
  expect(joined.status).toBe(201);
  expect(typeof joined.body.x).toBe("number");
  expect(typeof joined.body.y).toBe("number");

  const state = await getJson("/api/bar/state");
  const me = state.body.players.find((p: { id: string }) => p.id === joined.body.playerId);
  expect(me).toBeDefined();
  expect(me.nickname).toBe("Alice");
  expect(me.x).toBe(joined.body.x);
  expect(me.y).toBe(joined.body.y);
});

it("a public bar player never carries a session_secret", async () => {
  await postJson("/api/bar/join", { nickname: "Bob", color: "blue" });
  const state = await getJson("/api/bar/state");
  expect(JSON.stringify(state.body)).not.toMatch(/sessionSecret|session_secret/i);
});

it("refuses an action with a wrong session secret", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Carl", color: "green" });
  const res = await postJson("/api/bar/heartbeat", { playerId: joined.body.playerId, sessionSecret: "wrong" });
  expect(res.status).toBe(403);
});

it("accepts a single adjacent step onto a walkable tile", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Dana", color: "yellow" });
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  // The spawn row is kept clear of furniture by design (src/barLayout.ts),
  // so a sideways step is always valid regardless of exact spawn x.
  const res = await postJson("/api/bar/move", { ...session, x: joined.body.x + 1, y: joined.body.y });
  expect(res.status).toBe(200);
  const me = res.body.players.find((p: { id: string }) => p.id === joined.body.playerId);
  expect(me.x).toBe(joined.body.x + 1);
  expect(me.y).toBe(joined.body.y);
});

it("refuses a move more than one tile away", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Eve", color: "purple" });
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  const res = await postJson("/api/bar/move", { ...session, x: joined.body.x + 5, y: joined.body.y });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("invalid_move");
});

// A jump straight to the counter from spawn is invalid for two
// combined reasons (too far AND furniture) — precise, isolated coverage
// of "furniture alone, holding adjacency fixed" is in
// spec/barLayout.test.ts's pure isWalkable/isValidStep tests instead,
// since the default spawn tile has no furniture directly adjacent to it
// to test that in isolation over HTTP.
it("refuses a move onto the bar counter (far + non-walkable)", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Fay", color: "teal" });
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  const res = await postJson("/api/bar/move", { ...session, x: 5, y: 1 });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("invalid_move");
});

it("refuses a move out of bounds", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Gus", color: "orange" });
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };
  const res = await postJson("/api/bar/move", { ...session, x: -1, y: joined.body.y });
  expect(res.status).toBe(409);
});
