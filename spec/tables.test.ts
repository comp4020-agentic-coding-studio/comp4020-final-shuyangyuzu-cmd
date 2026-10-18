// Phase 2: each physical Vegas table bound to its own independent game
// room. Black-box over HTTP — see PLAN.md for the pivot this is part
// of, and CLAUDE.md for the one-table-at-a-time / furniture-is-fixed
// constraints this is built to satisfy.
//
// There are only 2 real *online* Vegas tables (the nine-table layout's
// own reduction, Crit 9 phase 8 — a third slot, "vegas-npc-1", is a solo
// kiosk with entirely different rules, covered separately below), shared
// by every online-table test in this file (tests within one file run
// sequentially in vitest, but nothing here assumes a *specific* table id
// stays free by the time a later test runs) — every test that needs an
// empty online table asks the server which one currently is, rather than
// hardcoding "vegas-1" and hoping.

import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

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

async function joinBar(nickname: string, color: string) {
  const { body } = await postJson("/api/bar/join", { nickname, color, skin: "warm" });
  return { playerId: body.playerId, sessionSecret: body.sessionSecret };
}

interface TableView {
  id: string;
  gameType: string;
  available: boolean;
  tableMode: "online" | "npc";
  status: string;
  roomCode: string | null;
  playerCount: number;
  takenColors: string[];
  pendingCount: number;
}

async function tablesStatus(): Promise<TableView[]> {
  const { body } = await getJson("/api/bar/tables");
  return body;
}

async function anEmptyVegasTable(): Promise<string> {
  const tables = await tablesStatus();
  const empty = tables.find((t) => t.gameType === "vegas" && t.tableMode === "online" && t.status === "empty");
  if (!empty) throw new Error("no empty online Vegas table available for this test — only 2 exist");
  return empty.id;
}

it("lists nine tables — 2 online + 1 NPC Vegas playable, 6 reserved that can never be created/joined", async () => {
  const tables = await tablesStatus();
  expect(tables).toHaveLength(9);
  expect(tables.filter((t) => t.gameType === "vegas")).toHaveLength(3);
  const reserved = tables.filter((t) => !t.available);
  expect(reserved).toHaveLength(6);

  const patron = await joinBar("Reservist", "red");
  for (const t of reserved) {
    const create = await postJson(`/api/bar/tables/${t.id}/create`, { ...patron, color: "red" });
    expect(create.status).toBe(404);
    const join = await postJson(`/api/bar/tables/${t.id}/join`, { ...patron, color: "blue" });
    expect(join.status).toBe(404);
  }
});

it("creating a game at a table reuses the bar nickname, no re-entry, and frees it again on disband", async () => {
  const tableId = await anEmptyVegasTable();
  const patron = await joinBar("Hosty McHostface", "purple");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...patron, color: "red" });
  expect(created.status).toBe(201);
  const roomState = await getJson(`/api/rooms/${created.body.code}/state`);
  expect(roomState.body.players[0].nickname).toBe("Hosty McHostface");

  // Clean up so this table is free for the rest of the file — every
  // test in it shares just 3 real tables.
  const disband = await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
  expect(disband.status).toBe(200);
  const after = await tablesStatus();
  expect(after.find((t) => t.id === tableId)?.status).toBe("empty");
});

it("table status reflects a real room: waiting, player count, taken colors, and a pending request's own effect", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("Alice", "purple");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });
  expect(created.status).toBe(201);

  let t = (await tablesStatus()).find((x) => x.id === tableId)!;
  expect(t.status).toBe("waiting");
  expect(t.playerCount).toBe(1);
  expect(t.takenColors).toEqual(["red"]);
  expect(t.roomCode).toBe(created.body.code);
  expect(t.pendingCount).toBe(0);

  // Phase 3 (product-direction-update): joining a table that already has
  // a host is a *request*, not an immediate seat — playerCount must not
  // move yet.
  const guest = await joinBar("Bob", "teal");
  const requested = await postJson(`/api/bar/tables/${tableId}/join`, { ...guest, color: "blue" });
  expect(requested.status).toBe(201);
  expect(requested.body.code).toBe(created.body.code);
  expect(requested.body.pending).toBe(true);

  t = (await tablesStatus()).find((x) => x.id === tableId)!;
  expect(t.playerCount).toBe(1);
  expect(t.takenColors).toEqual(["red"]);
  expect(t.pendingCount).toBe(1);

  // Only once the host approves it does the seat (and the table status)
  // actually change.
  const approved = await postJson(
    `/api/rooms/${created.body.code}/requests/${requested.body.playerId}/approve`,
    created.body,
  );
  expect(approved.status).toBe(200);

  t = (await tablesStatus()).find((x) => x.id === tableId)!;
  expect(t.playerCount).toBe(2);
  expect(t.takenColors.sort()).toEqual(["blue", "red"]);
  expect(t.pendingCount).toBe(0);

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true }); // free it back up
});

it("refuses joining a table with no game yet", async () => {
  const tableId = await anEmptyVegasTable();
  const patron = await joinBar("Lonely", "orange");
  const res = await postJson(`/api/bar/tables/${tableId}/join`, { ...patron, color: "red" });
  expect(res.status).toBe(404);
  expect(res.body.error).toBe("table_empty");
});

it("refuses creating a second game at a table that already has one", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("First", "pink");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });
  expect(created.status).toBe(201);

  const other = await joinBar("Second", "yellow");
  const res = await postJson(`/api/bar/tables/${tableId}/create`, { ...other, color: "blue" });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("table_occupied");

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("a patron can only be seated at one table at a time, server-enforced", async () => {
  const tableA = await anEmptyVegasTable();
  const patron = await joinBar("OneSeat", "teal");
  const first = await postJson(`/api/bar/tables/${tableA}/create`, { ...patron, color: "green" });
  expect(first.status).toBe(201);

  const tableB = await anEmptyVegasTable(); // a *different* table — tableA is now occupied
  expect(tableB).not.toBe(tableA);
  const res = await postJson(`/api/bar/tables/${tableB}/create`, { ...patron, color: "yellow" });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("already_seated");

  await postJson(`/api/rooms/${first.body.code}/disband`, { ...first.body, confirm: true });
});

it("re-requesting create/join for the table you're already at returns the same seat, not a duplicate player", async () => {
  const tableId = await anEmptyVegasTable();
  const patron = await joinBar("Idempotent", "pink");
  const first = await postJson(`/api/bar/tables/${tableId}/create`, { ...patron, color: "green" });
  expect(first.status).toBe(201);

  const again = await postJson(`/api/bar/tables/${tableId}/join`, { ...patron, color: "green" });
  expect(again.status).toBe(201);
  expect(again.body.code).toBe(first.body.code);
  expect(again.body.playerId).toBe(first.body.playerId);

  const state = await getJson(`/api/rooms/${first.body.code}/state`);
  expect(state.body.players.filter((p: { nickname: string }) => p.nickname === "Idempotent")).toHaveLength(1);

  await postJson(`/api/rooms/${first.body.code}/disband`, { ...first.body, confirm: true });
});

it("a disbanded room's table becomes available again, with no stale binding, and is genuinely reusable", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("Disbander", "orange");
  const room = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "yellow" });
  expect(room.status).toBe(201);

  const disband = await postJson(`/api/rooms/${room.body.code}/disband`, { ...room.body, confirm: true });
  expect(disband.status).toBe(200);

  const status = await tablesStatus();
  const t = status.find((x) => x.id === tableId)!;
  expect(t.status).toBe("empty");
  expect(t.roomCode).toBeNull();

  const another = await joinBar("NextUp", "teal");
  const recreated = await postJson(`/api/bar/tables/${tableId}/create`, { ...another, color: "green" });
  expect(recreated.status).toBe(201);
  expect(recreated.body.code).not.toBe(room.body.code);

  await postJson(`/api/rooms/${recreated.body.code}/disband`, { ...recreated.body, confirm: true });
});

it("a table also frees up when its last player leaves (not only on explicit disband)", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("SoleOccupant", "blue");
  const room = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });
  expect(room.status).toBe(201);

  const leave = await postJson(`/api/rooms/${room.body.code}/leave`, room.body);
  expect(leave.status).toBe(200);

  const t = (await tablesStatus()).find((x) => x.id === tableId)!;
  expect(t.status).toBe("empty");
});

// ---- Product-direction-update (2026-10-11): activeSeat, the fix for
// "Return to your game" leaking across bar identities. Appended here
// (not a separate file) because these tests need real Vegas tables, and
// this file's own header already explains why those can't be shared
// safely with a concurrently-running file. ----

it("a brand-new bar identity's own join response always reports activeSeat: null", async () => {
  const patron = await joinBar("Fresh", "red");
  const res = await postJson("/api/bar/rejoin", patron);
  expect(res.body.activeSeat).toBeNull();
});

it("activeSeat reflects a real table binding, and clears again once the room closes — all re-validated server-side, not cached", async () => {
  const tableId = await anEmptyVegasTable();
  const patron = await joinBar("Seated", "blue");

  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...patron, color: "red" });
  expect(created.status).toBe(201);

  const rejoined = await postJson("/api/bar/rejoin", patron);
  expect(rejoined.body.activeSeat).toEqual({ tableId, roomCode: created.body.code, pending: false });

  const appearance = await postJson("/api/bar/appearance", { ...patron, nickname: "Seated", color: "blue", skin: "warm" });
  expect(appearance.body.activeSeat).toEqual({ tableId, roomCode: created.body.code, pending: false });

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });

  const after = await postJson("/api/bar/rejoin", patron);
  expect(after.body.activeSeat).toBeNull();
});

it("activeSeat.pending is true for a requester, flips to false once approved", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("PendingHost", "orange");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });
  const guestBar = await joinBar("PendingGuest", "teal");
  const requested = await postJson(`/api/bar/tables/${tableId}/join`, { ...guestBar, color: "blue" });
  expect(requested.body.pending).toBe(true);

  const rejoinedPending = await postJson("/api/bar/rejoin", guestBar);
  expect(rejoinedPending.body.activeSeat).toEqual({ tableId, roomCode: created.body.code, pending: true });

  await postJson(`/api/rooms/${created.body.code}/requests/${requested.body.playerId}/approve`, created.body);

  const rejoinedApproved = await postJson("/api/bar/rejoin", guestBar);
  expect(rejoinedApproved.body.activeSeat).toEqual({ tableId, roomCode: created.body.code, pending: false });

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("a second, brand-new bar identity never inherits a different identity's active seat", async () => {
  const tableId = await anEmptyVegasTable();
  const first = await joinBar("First", "green");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...first, color: "red" });
  expect(created.status).toBe(201);

  const second = await joinBar("SecondAndUnrelated", "yellow");
  const secondRejoin = await postJson("/api/bar/rejoin", second);
  expect(secondRejoin.body.activeSeat).toBeNull();

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("activeSeat clears when the lone player voluntarily leaves (not just on disband)", async () => {
  const tableId = await anEmptyVegasTable();
  const patron = await joinBar("Leaver", "purple");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...patron, color: "red" });
  expect(created.status).toBe(201);

  await postJson(`/api/rooms/${created.body.code}/leave`, created.body);

  const after = await postJson("/api/bar/rejoin", patron);
  expect(after.body.activeSeat).toBeNull();
});

// ---- Phase 3 (product-direction-update): online-table join approval ----

it("the host can decline a pending request outright, and the declined requester's session can't be reused", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("DeclineHost", "purple");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });
  const guestBar = await joinBar("Declined", "teal");
  const requested = await postJson(`/api/bar/tables/${tableId}/join`, { ...guestBar, color: "blue" });
  expect(requested.body.pending).toBe(true);

  const rejected = await postJson(
    `/api/rooms/${created.body.code}/requests/${requested.body.playerId}/reject`,
    created.body,
  );
  expect(rejected.status).toBe(200);

  const state = await getJson(`/api/rooms/${created.body.code}/state`);
  expect(state.body.players).toHaveLength(1);
  expect(state.body.pendingRequests).toHaveLength(0);

  // The declined session is really gone, not just hidden from the list.
  const tryHeartbeat = await postJson(`/api/rooms/${created.body.code}/heartbeat`, {
    playerId: requested.body.playerId,
    sessionSecret: requested.body.sessionSecret,
  });
  expect(tryHeartbeat.status).toBe(403);

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("a requester can cancel their own pending request", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("CancelHost", "orange");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "green" });
  const guestBar = await joinBar("ChangedMind", "pink");
  const requested = await postJson(`/api/bar/tables/${tableId}/join`, { ...guestBar, color: "blue" });

  const cancelled = await postJson(`/api/rooms/${created.body.code}/requests/cancel`, requested.body);
  expect(cancelled.status).toBe(200);

  const state = await getJson(`/api/rooms/${created.body.code}/state`);
  expect(state.body.pendingRequests).toHaveLength(0);
  expect(state.body.players).toHaveLength(1);

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("only the host can approve or reject a pending request — not the requester's own session", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("RealHost", "yellow");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });
  const otherBar = await joinBar("NotTheHost", "teal");
  const other = await postJson(`/api/bar/tables/${tableId}/join`, { ...otherBar, color: "blue" });

  const selfApprove = await postJson(
    `/api/rooms/${created.body.code}/requests/${other.body.playerId}/approve`,
    other.body, // the requester's own (real, valid) session — not the host's
  );
  expect(selfApprove.status).toBe(403);
  expect(selfApprove.body.error).toBe("not_host");

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("approval re-validates color at commit time — two pending requests for the same color, only one can win", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("ColorHost", "orange");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "green" });
  const guestABar = await joinBar("GuestA", "teal");
  const guestA = await postJson(`/api/bar/tables/${tableId}/join`, { ...guestABar, color: "blue" });
  const guestBBar = await joinBar("GuestB", "pink");
  // Both pending requests choose the same color — allowed, since a
  // pending request doesn't reserve anything (PLAN.md).
  const guestB = await postJson(`/api/bar/tables/${tableId}/join`, { ...guestBBar, color: "blue" });
  expect(guestB.status).toBe(201);

  const approveA = await postJson(
    `/api/rooms/${created.body.code}/requests/${guestA.body.playerId}/approve`,
    created.body,
  );
  expect(approveA.status).toBe(200);

  const approveB = await postJson(
    `/api/rooms/${created.body.code}/requests/${guestB.body.playerId}/approve`,
    created.body,
  );
  expect(approveB.status).toBe(409);
  expect(approveB.body.error).toBe("color_taken");

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("approval re-validates capacity at commit time — never more than 5 seated players, and a full room refuses new requests outright", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("CapHost", "red");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "red" });

  // 5, not 4 — the official rulebook ships 5 player colours' worth of
  // dice (src/rooms.ts's MAX_PLAYERS comment has the citation); this is
  // the one test in this file that encodes the literal capacity number.
  const colorsToFill = ["blue", "green", "yellow", "purple"];
  const requests = [];
  for (const color of colorsToFill) {
    const bar = await joinBar(`Cap-${color}`, "teal");
    requests.push(await postJson(`/api/bar/tables/${tableId}/join`, { ...bar, color }));
  }
  for (const r of requests) {
    const res = await postJson(`/api/rooms/${created.body.code}/requests/${r.body.playerId}/approve`, created.body);
    expect(res.status).toBe(200);
  }
  const state = await getJson(`/api/rooms/${created.body.code}/state`);
  expect(state.body.players).toHaveLength(5);

  const lateBar = await joinBar("TooLate", "pink");
  const lateRequest = await postJson(`/api/bar/tables/${tableId}/join`, { ...lateBar, color: "red" });
  expect(lateRequest.status).toBe(409);
  expect(lateRequest.body.error).toBe("room_full");

  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("a pending request doesn't appear as a seated player and doesn't block readying up the real seats", async () => {
  const tableId = await anEmptyVegasTable();
  const host = await joinBar("StartHost", "blue");
  const created = await postJson(`/api/bar/tables/${tableId}/create`, { ...host, color: "blue" });
  const guestBar = await joinBar("SecondSeat", "teal");
  const guest = await postJson(`/api/bar/tables/${tableId}/join`, { ...guestBar, color: "green" });
  const approved = await postJson(
    `/api/rooms/${created.body.code}/requests/${guest.body.playerId}/approve`,
    created.body,
  );
  expect(approved.status).toBe(200);

  // A third patron's request stays pending — must not block or appear as
  // a seat.
  const lateBar = await joinBar("StillPending", "pink");
  const late = await postJson(`/api/bar/tables/${tableId}/join`, { ...lateBar, color: "yellow" });
  expect(late.body.pending).toBe(true);

  const readyHost = await postJson(`/api/rooms/${created.body.code}/ready`, { ...created.body, ready: true });
  const readyGuest = await postJson(`/api/rooms/${created.body.code}/ready`, { ...guest.body, ready: true });
  expect(readyHost.status).toBe(200);
  expect(readyGuest.status).toBe(200);
  expect(readyHost.body.players).toHaveLength(2); // the pending request never counted
  expect(readyHost.body.pendingRequests).toHaveLength(1);

  // Stay in the lobby (never actually start) so this table can still be
  // disbanded and freed for the rest of this file's shared 3 tables.
  await postJson(`/api/rooms/${created.body.code}/disband`, { ...created.body, confirm: true });
});

it("refuses an action with a wrong bar session secret", async () => {
  const tableId = await anEmptyVegasTable();
  const patron = await joinBar("Impostee", "blue");
  const res = await postJson(`/api/bar/tables/${tableId}/create`, {
    playerId: patron.playerId,
    sessionSecret: "wrong",
    color: "red",
  });
  expect(res.status).toBe(403);
});

// ---- Phase 5 (product-direction-update): the solo Vegas NPC table ----

it("starting a solo Vegas-NPC game with no playerCount defaults to 5 — 1 human + 4 NPCs — and starts immediately, no waiting", async () => {
  const patron = await joinBar("SoloPlayer", "red");
  const started = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...patron, color: "red" });
  expect(started.status).toBe(201);
  expect(started.body.pending).toBe(false);

  const state = await getJson(`/api/rooms/${started.body.code}/state`);
  expect(state.body.phase).not.toBe("lobby"); // already started
  expect(state.body.players).toHaveLength(5);
  const human = state.body.players.find((p: { id: string }) => p.id === started.body.playerId);
  expect(human.controller).toBe("human");
  expect(state.body.players.filter((p: { controller: string }) => p.controller === "npc")).toHaveLength(4);
  // The 4 NPCs took exactly the 4 colors the human didn't.
  expect(state.body.players.map((p: { color: string }) => p.color).sort()).toEqual(
    ["red", "blue", "green", "yellow", "purple"].sort(),
  );
});

it("playerCount controls how many NPCs are seated — 2 means 1 NPC, 5 means 4 NPCs, out-of-range is refused", async () => {
  const two = await joinBar("SoloTwo", "red");
  const twoStarted = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...two, color: "red", playerCount: 2 });
  expect(twoStarted.status).toBe(201);
  const twoState = await getJson(`/api/rooms/${twoStarted.body.code}/state`);
  expect(twoState.body.players).toHaveLength(2);
  expect(twoState.body.players.filter((p: { controller: string }) => p.controller === "npc")).toHaveLength(1);

  const five = await joinBar("SoloFive", "blue");
  const fiveStarted = await postJson("/api/bar/tables/vegas-npc-1/start-npc", {
    ...five,
    color: "blue",
    playerCount: 5,
  });
  expect(fiveStarted.status).toBe(201);
  const fiveState = await getJson(`/api/rooms/${fiveStarted.body.code}/state`);
  expect(fiveState.body.players).toHaveLength(5);

  const tooFew = await joinBar("SoloTooFew", "green");
  const tooFewRes = await postJson("/api/bar/tables/vegas-npc-1/start-npc", {
    ...tooFew,
    color: "green",
    playerCount: 1,
  });
  expect(tooFewRes.status).toBe(400);
  expect(tooFewRes.body.error).toBe("bad_player_count");

  const tooMany = await joinBar("SoloTooMany", "yellow");
  const tooManyRes = await postJson("/api/bar/tables/vegas-npc-1/start-npc", {
    ...tooMany,
    color: "yellow",
    playerCount: 6,
  });
  expect(tooManyRes.status).toBe(400);
  expect(tooManyRes.body.error).toBe("bad_player_count");
});

it("re-clicking the NPC table while already mid-game there hands back that same game, not a second one", async () => {
  const patron = await joinBar("ReclickSolo", "blue");
  const first = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...patron, color: "blue" });
  expect(first.status).toBe(201);

  const again = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...patron, color: "blue" });
  expect(again.status).toBe(201);
  expect(again.body.code).toBe(first.body.code);
  expect(again.body.playerId).toBe(first.body.playerId);
});

it("two different visitors each get their own independent NPC game — never shown as joinable to each other", async () => {
  const a = await joinBar("SoloA", "green");
  const startedA = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...a, color: "green" });
  const b = await joinBar("SoloB", "yellow");
  const startedB = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...b, color: "yellow" });

  expect(startedA.body.code).not.toBe(startedB.body.code);

  // The shared bar view never shows either of these as a joinable online
  // room, regardless of how many private NPC games are running right now.
  const status = (await tablesStatus()).find((t) => t.id === "vegas-npc-1")!;
  expect(status.status).toBe("empty");
  expect(status.roomCode).toBeNull();
  expect(status.playerCount).toBe(0);
  expect(status.tableMode).toBe("npc");

  // And the classic /join path for an online table must not work against
  // an NPC table's id — it's a different kind of fixture entirely.
  const wrongEndpoint = await postJson("/api/bar/tables/vegas-npc-1/join", { ...a, color: "red" });
  expect(wrongEndpoint.status).toBe(404);
});

it("refuses starting a solo game at a reserved NPC slot", async () => {
  const patron = await joinBar("ReservedSolo", "orange");
  const res = await postJson("/api/bar/tables/texas-npc-1/start-npc", { ...patron, color: "red" });
  expect(res.status).toBe(404);
});

it("refuses starting a solo NPC game at an online table's id", async () => {
  const patron = await joinBar("WrongMode", "teal");
  const res = await postJson("/api/bar/tables/vegas-1/start-npc", { ...patron, color: "red" });
  expect(res.status).toBe(404);
});
