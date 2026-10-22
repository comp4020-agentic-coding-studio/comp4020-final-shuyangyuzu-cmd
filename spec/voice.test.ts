// Room voice calls (CLAUDE.md's voice-call section): phone-style invite
// calling for up to MAX_PLAYERS seated humans in an Online room. Black-box
// over HTTP, same style as the rest of spec/ — no reaching into src/
// internals.

import { expect, inject, it } from "vitest";
import { createRoom, joinRoom, readyUpAndStart, type Session } from "./helpers.ts";

const baseUrl = inject("baseUrl");

async function postJson(path: string, body: unknown) {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function startCall(code: string, session: Session) {
  return postJson(`/api/rooms/${code}/voice/start`, session);
}
async function respond(code: string, session: Session, callId: string, accept: boolean) {
  return postJson(`/api/rooms/${code}/voice/respond`, { ...session, callId, accept });
}
async function leaveCall(code: string, session: Session, callId: string) {
  return postJson(`/api/rooms/${code}/voice/leave`, { ...session, callId });
}
async function setMuted(code: string, session: Session, callId: string, muted: boolean) {
  return postJson(`/api/rooms/${code}/voice/mute`, { ...session, callId, muted });
}
async function ownView(code: string, session: Session) {
  return postJson(`/api/rooms/${code}/voice/state`, session);
}
async function signal(code: string, session: Session, callId: string, toPlayerId: string, signalType: string, data: unknown) {
  return postJson(`/api/rooms/${code}/voice/signal`, { ...session, callId, toPlayerId, signalType, data });
}

async function createThreePlayerRoom(): Promise<{ code: string; a: Session; b: Session; c: Session }> {
  const a = await createRoom(baseUrl, "Alice", "red");
  const bRes = await joinRoom(baseUrl, a.code, "Bob", "blue");
  const cRes = await joinRoom(baseUrl, a.code, "Carol", "green");
  return { code: a.code, a, b: bRes.body as Session, c: cRes.body as Session };
}

it("starting a call invites every other seated human, and accepting adds them as a participant", async () => {
  const { code, a, b } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  expect(started.status).toBe(200);
  expect(started.body.voiceCall.active).toBe(true);
  expect(started.body.voiceCall.participants.map((p: any) => p.playerId)).toEqual([a.playerId]);

  const bView = await ownView(code, b);
  expect(bView.body.own.status).toBe("invited");
  expect(bView.body.own.invitedBy).toBe("Alice");

  const callId = started.body.voiceCall.callId;
  const accepted = await respond(code, b, callId, true);
  expect(accepted.status).toBe(200);
  const ids = accepted.body.voiceCall.participants.map((p: any) => p.playerId).sort();
  expect(ids).toEqual([a.playerId, b.playerId].sort());
});

it("declining doesn't join, doesn't affect the game, and the decliner can join later from the header", async () => {
  const { code, a, c } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  const callId = started.body.voiceCall.callId;

  const declined = await respond(code, c, callId, false);
  expect(declined.status).toBe(200);
  expect(declined.body.voiceCall.participants.some((p: any) => p.playerId === c.playerId)).toBe(false);

  // Later joins the already-running call via the same start-or-join route
  // the header's "加入通话" action uses.
  const joined = await startCall(code, c);
  expect(joined.status).toBe(200);
  expect(joined.body.voiceCall.callId).toBe(callId);
  expect(joined.body.voiceCall.participants.some((p: any) => p.playerId === c.playerId)).toBe(true);
});

it("two players starting a call simultaneously merge into one call, never two", async () => {
  const { code, a, b } = await createThreePlayerRoom();
  const [r1, r2] = await Promise.all([startCall(code, a), startCall(code, b)]);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  // Same callId either way — the real "merge, not two calls" guarantee.
  expect(r1.body.voiceCall.callId).toBe(r2.body.voiceCall.callId);
  // Each response reflects the snapshot at the instant it was generated,
  // so whichever write committed first may report only itself — that's
  // an ordering artifact, not a correctness guarantee either response
  // makes on its own. The actual guarantee is eventual: read back once
  // both requests have resolved and confirm both callers really landed
  // in the one merged call, never silently dropped.
  const finalState = await fetch(new URL(`/api/rooms/${code}/state`, baseUrl)).then((r) => r.json());
  const ids = finalState.voiceCall.participants.map((p: any) => p.playerId).sort();
  expect(ids).toEqual([a.playerId, b.playerId].sort());
});

it("repeated accept of the same invite, or a stale/old invite id, doesn't duplicate membership", async () => {
  const { code, a, b } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  const callId = started.body.voiceCall.callId;

  await respond(code, b, callId, true);
  const again = await respond(code, b, callId, true); // repeated accept
  expect(again.status).toBe(200);
  const count = again.body.voiceCall.participants.filter((p: any) => p.playerId === b.playerId).length;
  expect(count).toBe(1);

  // A stale callId (from a call that's already ended) is a harmless no-op,
  // not an error that could wedge the UI.
  await leaveCall(code, a, callId);
  await leaveCall(code, b, callId);
  const staleRespond = await respond(code, a, "not-a-real-call-id", true);
  expect(staleRespond.status).toBe(200);
  expect(staleRespond.body.voiceCall.active).toBe(false);
});

it("participant count is accurate: muting doesn't decrease it, hangup only removes self, last leaver ends the call", async () => {
  const { code, a, b, c } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  const callId = started.body.voiceCall.callId;
  await respond(code, b, callId, true);
  await respond(code, c, callId, true);

  const muted = await setMuted(code, b, callId, true);
  expect(muted.status).toBe(200);
  expect(muted.body.voiceCall.participants.length).toBe(3);
  expect(muted.body.voiceCall.participants.find((p: any) => p.playerId === b.playerId).muted).toBe(true);

  // Initiator leaves — call continues for the other two.
  const aLeft = await leaveCall(code, a, callId);
  expect(aLeft.status).toBe(200);
  expect(aLeft.body.voiceCall.active).toBe(true);
  expect(aLeft.body.voiceCall.participants.map((p: any) => p.playerId).sort()).toEqual([b.playerId, c.playerId].sort());

  const bLeft = await leaveCall(code, b, callId);
  expect(bLeft.body.voiceCall.active).toBe(true);
  expect(bLeft.body.voiceCall.participants.map((p: any) => p.playerId)).toEqual([c.playerId]);

  const cLeft = await leaveCall(code, c, callId);
  expect(cLeft.body.voiceCall.active).toBe(false);
  expect(cLeft.body.voiceCall.callId).toBeNull();
  expect(cLeft.body.voiceCall.participants).toEqual([]);
});

it("a late-joining room player can see and join an already-running call", async () => {
  const a = await createRoom(baseUrl, "Alice", "red");
  const started = await startCall(a.code, a);
  expect(started.body.voiceCall.active).toBe(true);

  const bRes = await joinRoom(baseUrl, a.code, "Bob", "blue");
  const b = bRes.body as Session;
  const state = await fetch(new URL(`/api/rooms/${a.code}/state`, baseUrl)).then((r) => r.json());
  expect(state.voiceCall.active).toBe(true);

  const joined = await startCall(a.code, b);
  expect(joined.status).toBe(200);
  expect(joined.body.voiceCall.callId).toBe(started.body.voiceCall.callId);
  expect(joined.body.voiceCall.participants.some((p: any) => p.playerId === b.playerId)).toBe(true);
});

it("voice calls aren't available in offline (solo NPC) games", async () => {
  // A solo NPC game is a single-human room created through the bar's
  // start-npc route — closest equivalent reachable from this spec file
  // without a bar identity is checking the room-level rejection directly
  // via the public `solo` flag's own gate in src/voice.ts. Exercised here
  // against a freshly created solo room via the bar API.
  const patron = await postJson("/api/bar/join", { nickname: "SoloVoice", color: "teal", skin: "warm" });
  expect(patron.status).toBe(201);
  const started = await postJson("/api/bar/tables/vegas-npc-1/start-npc", { ...patron.body, color: "red", playerCount: 2 });
  expect(started.status).toBe(201);
  const soloCode = started.body.code;
  const soloSession: Session = { playerId: started.body.playerId, sessionSecret: started.body.sessionSecret };

  const res = await startCall(soloCode, soloSession);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("voice_not_available");
});

it("an unauthenticated / forged session is rejected for every voice action", async () => {
  const { code, a } = await createThreePlayerRoom();
  const forged = { playerId: a.playerId, sessionSecret: "not-the-real-secret" };
  const res = await startCall(code, forged);
  expect(res.status).toBe(403);
  expect(res.body.error).toBe("unauthorized");
});

it("a pending (not-yet-approved) join request cannot start or join a call", async () => {
  // An online table's pending requester has a real session (so it can
  // watch the room stream) but is not a seated Player — voice calls must
  // refuse it the same way any other seated-player-only action does.
  // Uses the bar's online-table flow (src/tables.ts), the only path that
  // produces a genuinely pending (not auto-seated) request.
  const hostPatron = await postJson("/api/bar/join", { nickname: "VoiceHost", color: "teal", skin: "warm" });
  expect(hostPatron.status).toBe(201);
  const created = await postJson("/api/bar/tables/vegas-2/create", { ...hostPatron.body, color: "red" });
  expect(created.status).toBe(201);

  const guestPatron = await postJson("/api/bar/join", { nickname: "VoiceGuest", color: "orange", skin: "tan" });
  expect(guestPatron.status).toBe(201);
  const requested = await postJson("/api/bar/tables/vegas-2/join", { ...guestPatron.body, color: "blue" });
  expect(requested.status).toBe(201);
  expect(requested.body.pending).toBe(true);
  const pendingSession: Session = { playerId: requested.body.playerId, sessionSecret: requested.body.sessionSecret };

  const res = await startCall(created.body.code, pendingSession);
  expect(res.status).toBe(410); // player_removed: a pending request is never a seated Player
});

it("cross-room: a valid session for one room cannot act on another room's call", async () => {
  const room1 = await createThreePlayerRoom();
  const room2 = await createRoom(baseUrl, "OtherHost", "red");
  const started1 = await startCall(room1.code, room1.a);
  expect(started1.status).toBe(200);
  // room1's host's session is only valid against room1 — using it against
  // room2's code should fail exactly like every other authenticated room
  // action already does (requireSession is scoped by room_id).
  const crossed = await startCall(room2.code, room1.a);
  expect(crossed.status).toBe(403);
});

it("after a game starts, an NPC-handed-off seat cannot start or join the room's call", async () => {
  const a = await createRoom(baseUrl, "Alice", "red");
  const bRes = await joinRoom(baseUrl, a.code, "Bob", "blue");
  const b = bRes.body as Session;
  const code = a.code;
  const started = await readyUpAndStart(baseUrl, code, a, [a, b]);
  expect(started.status).toBe(200);
  // Exit b's seat, which (post-start) hands it off to NPC control rather
  // than removing the player — exactly the controller:"npc" case voice
  // calls must refuse.
  const exited = await postJson(`/api/rooms/${code}/exit`, b);
  expect(exited.status).toBe(200);
  const afterExit = await startCall(code, b);
  expect(afterExit.status).toBe(403);
  expect(afterExit.body.error).toBe("npc_controlled");
});

it("signaling is relayed only between two already-joined participants, never broadcast, and never to a non-participant", async () => {
  const { code, a, b, c } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  const callId = started.body.voiceCall.callId;
  await respond(code, b, callId, true);
  // c never joins.

  const ok = await signal(code, a, callId, b.playerId, "offer", { sdp: "v=0..." });
  expect(ok.status).toBe(200);

  const refusedToC = await signal(code, a, callId, c.playerId, "offer", { sdp: "v=0..." });
  expect(refusedToC.status).toBe(409);
  expect(refusedToC.body.error).toBe("not_in_call");

  const refusedFromC = await signal(code, c, callId, a.playerId, "offer", { sdp: "v=0..." });
  expect(refusedFromC.status).toBe(409);
});

it("signaling rejects a stale/ended call id and an oversized payload", async () => {
  const { code, a, b } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  const callId = started.body.voiceCall.callId;
  await respond(code, b, callId, true);

  const tooBig = await signal(code, a, callId, b.playerId, "offer", { sdp: "x".repeat(20000) });
  expect(tooBig.status).toBe(413);

  await leaveCall(code, a, callId);
  await leaveCall(code, b, callId);
  const afterEnd = await signal(code, a, callId, b.playerId, "offer", { sdp: "v=0..." });
  expect(afterEnd.status).toBe(410);
});

it("the public room payload never includes an invited-but-undecided player's identity, only joined participants", async () => {
  const { code, a, b } = await createThreePlayerRoom();
  await startCall(code, a);
  // b is invited but hasn't responded yet — the public payload (what
  // every SSE subscriber and every plain GET /state sees) must not name
  // b anywhere in its voiceCall summary, only in b's own authenticated
  // voice/state response (checked separately above).
  const publicState = await fetch(new URL(`/api/rooms/${code}/state`, baseUrl)).then((r) => r.json());
  expect(publicState.voiceCall.participants.map((p: any) => p.playerId)).toEqual([a.playerId]);
  expect(publicState.voiceCall.participants.some((p: any) => p.playerId === b.playerId)).toBe(false);
});

it("mute requires being an active joined participant, not merely invited or a stranger", async () => {
  const { code, a, b } = await createThreePlayerRoom();
  const started = await startCall(code, a);
  const callId = started.body.voiceCall.callId;
  // b is only invited, not joined yet.
  const muteAttempt = await setMuted(code, b, callId, true);
  expect(muteAttempt.status).toBe(409);
  expect(muteAttempt.body.error).toBe("not_in_call");
});

it('returning to the bar releases voice immediately while reserving the game seat',async()=>{
  const {code,a,b}=await createThreePlayerRoom();
  const started=await startCall(code,a),callId=started.body.voiceCall.callId;
  await respond(code,b,callId,true);
  expect((await postJson(`/api/rooms/${code}/depart`,a)).status).toBe(200);
  const remaining=await ownView(code,b);
  expect(remaining.body.participants.map((p:any)=>p.playerId)).toEqual([b.playerId]);
  expect((await signal(code,a,callId,b.playerId,'offer',{sdp:'test'})).status).toBe(403);
  expect((await signal(code,b,callId,a.playerId,'offer',{sdp:'test'})).status).toBe(409);
  expect((await startCall(code,a)).status).toBe(403);
  const state=await fetch(`${baseUrl}/api/rooms/${code}/state`).then(r=>r.json());
  expect(state.players.some((p:any)=>p.id===a.playerId)).toBe(true);
  await postJson(`/api/rooms/${code}/resume`,a);
  expect((await startCall(code,a)).status).toBe(200);
});
