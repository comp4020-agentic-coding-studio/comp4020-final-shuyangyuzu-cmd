// Phone-style room voice calls (CLAUDE.md's voice-call section): a
// WebRTC mesh between up to 5 seated human players of an Online room.
// This module owns everything about the call that must survive app.js's
// full-DOM re-render on every state push (the RTCPeerConnections, the
// local mic stream, the hidden <audio> elements) — none of that can live
// inside the tree render() replaces, so it's kept in this module's own
// closure instead, with only small, freshly-built DOM fragments (the
// header widget, the incoming-call prompt) handed back to app.js each
// time its own state changes.
//
// Server authority is unchanged by any of this: every membership
// decision (who's invited, who's joined, who's muted, when the call
// ends) is the server's, read back from the room's own public state
// (state.voiceCall) on every push — this module never decides on its
// own who's "in the call," it only reflects what the server already
// decided and carries the actual audio between participants the server
// already authorized.

const MAX_SIGNAL_RECONNECT_ATTEMPTS = 3;
const SIGNAL_RECONNECT_DELAY_MS = 1500;

function micErrorMessage(err) {
  if (err && err.name === "NotAllowedError") return "Microphone permission was denied. Allow it in your browser's site settings, then try again.";
  if (err && err.name === "NotFoundError") return "No microphone was found on this device.";
  if (err && (err.name === "NotReadableError" || err.name === "AbortError")) return "Could not access the microphone — it may be in use by another app.";
  return "Could not start voice chat: " + (err && err.message ? err.message : "unknown error");
}

export function createVoiceCall({ el }) {
  let code = null;
  let session = null;
  let eventSource = null;
  let iceServersCache = null; // { callId, servers } — refetched per new call

  let callId = null; // this tab's own current call id, or null
  let ownStatus = "none"; // "none" | "invited" | "joined"
  let localStream = null;
  const peerConnections = new Map(); // remotePlayerId -> RTCPeerConnection
  const remoteAudioEls = new Map(); // remotePlayerId -> <audio>
  const pendingCandidates = new Map(); // remotePlayerId -> RTCIceCandidateInit[]
  const reconnectAttempts = new Map(); // remotePlayerId -> count

  let panelExpanded = false;
  let busy = false; // true while a start/accept/decline/leave request is in flight — suppresses double-clicks
  let lastErrorMessage = null;
  let incomingInvite = null; // { callId, inviterNickname } or null
  let latestVoiceCall = { active: false, callId: null, startedBy: null, participants: [] };
  let onNeedsRedraw = () => {};
  let roomGeneration = 0;
  let mediaGeneration = 0;
  let membershipRevision = 0;
  let viewRequest = 0;
  let voiceCursor = null;
  let joiningSignals = [];

  function applySummary(state) {
    if (!state.voiceCall) return false;
    if (typeof state.epoch === 'number' && typeof state.rev === 'number') {
      if (voiceCursor && (state.epoch < voiceCursor.epoch || state.epoch === voiceCursor.epoch && state.rev < voiceCursor.rev)) return false;
      voiceCursor = {epoch:state.epoch,rev:state.rev};
    }
    latestVoiceCall = state.voiceCall;
    return true;
  }

  function context() { return { generation: roomGeneration, code, session }; }
  function isCurrent(ctx) { return ctx.generation === roomGeneration && ctx.code === code && !!session; }
  function request(ctx, path, body = {}, keepalive = false) {
    return api(`/rooms/${ctx.code}${path}`, { ...ctx.session, ...body }, keepalive);
  }
  function stopStream(stream) { for (const track of stream.getTracks()) track.stop(); }
  function resetMembership() {
    mediaGeneration++;
    membershipRevision++;
    teardownMedia();
    ownStatus = 'none';
    callId = null;
    panelExpanded = false;
    busy = false;
    joiningSignals = [];
  }

  async function api(path, body, keepalive = false) {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      keepalive,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.message ?? "request failed"), { code: data.error, status: res.status });
    return data;
  }

  function roomApi(path, body) {
    return api(`/rooms/${code}${path}`, { ...session, ...body });
  }

  function isActiveParticipant(playerId) {
    return latestVoiceCall.participants.some((p) => p.playerId === playerId);
  }

  function closePeer(remoteId) {
    const pc = peerConnections.get(remoteId);
    if (pc) {
      pc.close();
      peerConnections.delete(remoteId);
    }
    const audioEl = remoteAudioEls.get(remoteId);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
      remoteAudioEls.delete(remoteId);
    }
    pendingCandidates.delete(remoteId);
    reconnectAttempts.delete(remoteId);
  }

  function teardownMedia() {
    for (const remoteId of [...peerConnections.keys()]) closePeer(remoteId);
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      localStream = null;
    }
    pendingCandidates.clear();
    reconnectAttempts.clear();
  }

  async function ensureIceServers() {
    if (iceServersCache && iceServersCache.callId === callId) return iceServersCache.servers;
    const ctx = context(), id = callId, generation = mediaGeneration;
    const res = await request(ctx, "/voice/ice-servers");
    if (!isCurrent(ctx) || id !== callId || generation !== mediaGeneration || ownStatus !== 'joined') throw new Error('call changed');
    iceServersCache = { callId: id, servers: res.iceServers };
    return res.iceServers;
  }

  async function flushPendingCandidates(remoteId, pc) {
    const queued = pendingCandidates.get(remoteId);
    if (!queued) return;
    pendingCandidates.delete(remoteId);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // A late/invalid candidate after the connection moved on — not fatal.
      }
    }
  }

  function createPeer(remoteId, iceServers) {
    if (peerConnections.has(remoteId)) return peerConnections.get(remoteId);
    const ctx = context(), id = callId, generation = mediaGeneration;
    const active = () => isCurrent(ctx) && id === callId && generation === mediaGeneration && ownStatus === 'joined' && peerConnections.get(remoteId) === pc;
    const pc = new RTCPeerConnection({ iceServers });
    peerConnections.set(remoteId, pc);
    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate && active()) {
        request(ctx, "/voice/signal", { callId: id, toPlayerId: remoteId, signalType: "ice-candidate", data: ev.candidate }).catch(() => {});
      }
    };
    pc.ontrack = (ev) => {
      if (!active()) return;
      let audioEl = remoteAudioEls.get(remoteId);
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        remoteAudioEls.set(remoteId, audioEl);
      }
      audioEl.srcObject = ev.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (!active()) return;
      if (pc.connectionState === "connected") {
        reconnectAttempts.set(remoteId, 0);
        onNeedsRedraw();
      } else if (pc.connectionState === "failed") {
        attemptIceRestart(remoteId);
      }
      if (pc.connectionState === "failed" || pc.connectionState === "connected") onNeedsRedraw();
    };
    return pc;
  }

  // Bounded retry only — a genuinely dead peer link is closed, not
  // retried forever (CLAUDE.md: "失联不能永久占用人数"; a mesh link that
  // can't recover degrades gracefully rather than hanging the whole call).
  async function attemptIceRestart(remoteId) {
    const ctx = context(), id = callId, generation = mediaGeneration;
    const pc = peerConnections.get(remoteId);
    if (!pc) return;
    const attempts = reconnectAttempts.get(remoteId) ?? 0;
    if (attempts >= MAX_SIGNAL_RECONNECT_ATTEMPTS) {
      closePeer(remoteId);
      onNeedsRedraw();
      return;
    }
    reconnectAttempts.set(remoteId, attempts + 1);
    // Only the deterministic initiator side restarts ICE — the other side
    // just waits for the restart offer, same rule as the initial connect.
    if (!(session.playerId < remoteId)) return;
    try {
      await new Promise((r) => setTimeout(r, SIGNAL_RECONNECT_DELAY_MS));
      if (!isCurrent(ctx) || generation !== mediaGeneration || peerConnections.get(remoteId) !== pc) return;
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      if (!isCurrent(ctx) || generation !== mediaGeneration) return;
      await request(ctx, "/voice/signal", { callId: id, toPlayerId: remoteId, signalType: "offer", data: pc.localDescription });
    } catch {
      // Will be retried on the next failed transition, up to the cap above.
    }
  }

  async function connectToParticipant(remoteId) {
    if (peerConnections.has(remoteId) || remoteId === session.playerId) return;
    const ctx = context(), id = callId, generation = mediaGeneration;
    const iceServers = await ensureIceServers();
    if (!isCurrent(ctx) || generation !== mediaGeneration || !isActiveParticipant(remoteId) || peerConnections.has(remoteId)) return;
    const pc = createPeer(remoteId, iceServers);
    // Deterministic initiator per pair, so both sides independently reach
    // the same decision with no coordinator and no glare: the
    // lexicographically smaller playerId always offers, the other always
    // waits for that offer.
    if (session.playerId < remoteId) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!isCurrent(ctx) || generation !== mediaGeneration) return;
      await request(ctx, "/voice/signal", { callId: id, toPlayerId: remoteId, signalType: "offer", data: pc.localDescription });
    }
  }

  function reconcilePeerMesh() {
    if (ownStatus !== "joined" || !callId) return;
    const others = latestVoiceCall.participants.map((p) => p.playerId).filter((id) => id !== session.playerId);
    for (const id of others) connectToParticipant(id).catch(() => {});
    for (const id of [...peerConnections.keys()]) {
      if (!others.includes(id)) closePeer(id);
    }
  }

  async function handleSignal(msg) {
    if (ownStatus !== 'joined' || !localStream || msg.callId !== callId || !isActiveParticipant(msg.from)) return;
    const ctx = context(), generation = mediaGeneration, id = callId;
    const active = () => isCurrent(ctx) && generation === mediaGeneration && id === callId && ownStatus === 'joined';
    const { from, signalType, data } = msg;
    let pc = peerConnections.get(from);
    if (signalType === "offer") {
      if (!pc) {
        const iceServers = await ensureIceServers();
        if (!active()) return;
        pc = createPeer(from, iceServers);
      }
      await pc.setRemoteDescription(data);
      if (!active()) return;
      await flushPendingCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!active()) return;
      await request(ctx, "/voice/signal", { callId: id, toPlayerId: from, signalType: "answer", data: pc.localDescription });
    } else if (signalType === "answer") {
      if (pc) {
        await pc.setRemoteDescription(data);
        await flushPendingCandidates(from, pc);
      }
    } else if (signalType === "ice-candidate") {
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(data);
        } catch {
          // Benign — a candidate that no longer applies.
        }
      } else {
        const queue = pendingCandidates.get(from) ?? [];
        queue.push(data);
        pendingCandidates.set(from, queue);
      }
    }
  }

  function connectPrivateChannel() {
    if (eventSource) eventSource.close();
    const url = `/api/rooms/${code}/voice/events?playerId=${encodeURIComponent(session.playerId)}&sessionSecret=${encodeURIComponent(session.sessionSecret)}`;
    const es = new EventSource(url);
    const ctx = context();
    es.onmessage = (ev) => {
      if (!isCurrent(ctx) || eventSource !== es) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "invited") {
        incomingInvite = { callId: msg.callId, inviterNickname: msg.inviterNickname };
        onNeedsRedraw();
      } else if (msg.type === "signal") {
        // The server may push the first offer before the HTTP join
        // response arrives. Keep it only during this explicit mic join.
        if (busy && localStream && ownStatus !== 'joined') {
          if (joiningSignals.length < 128) joiningSignals.push(msg);
        } else handleSignal(msg).catch(() => {});
      } else if (msg.type === "removed_from_call" || msg.type === "call_ended") {
        if (msg.callId === callId) {
          resetMembership();
          onNeedsRedraw();
        }
        if (incomingInvite && incomingInvite.callId === msg.callId) {
          incomingInvite = null;
          onNeedsRedraw();
        }
      }
    };
    // Reconnecting after a drop never assumes nothing was missed — refetch
    // the authoritative own-view (same "a dropped connection is never
    // trusted to have delivered everything" rule CLAUDE.md states for the
    // room/bar channels).
    es.onopen = () => {
      if (isCurrent(ctx) && eventSource === es) refreshOwnView().catch(() => {});
    };
    eventSource = es;
  }

  async function refreshOwnView() {
    const ctx = context(), revision = membershipRevision, serial = ++viewRequest;
    const view = await request(ctx, '/voice/state');
    if (!isCurrent(ctx) || revision !== membershipRevision || serial !== viewRequest || busy) return;
    latestVoiceCall = { active: view.active, callId: view.callId, startedBy: view.startedBy, participants: view.participants };
    if (view.own.status === 'joined') {
      if (ownStatus === 'joined' && localStream && callId === view.callId) {
        // A reconnect of this same page keeps its live media and controls.
        reconcilePeerMesh();
      } else {
        // A fresh page has no media: release stale membership without opening a mic.
        resetMembership();
        await request(ctx, '/voice/leave', { callId: view.callId }).catch(() => {});
        if (!isCurrent(ctx)) return;
      }
    } else {
      if (ownStatus === 'joined') resetMembership();
      ownStatus = view.own.status === 'invited' ? 'invited' : 'none';
      callId = ownStatus === 'invited' ? view.callId : null;
      incomingInvite = ownStatus === 'invited' ? { callId: view.callId, inviterNickname: view.own.invitedBy } : null;
    }
    onNeedsRedraw();
  }

  async function joinCall(invite = null) {
    if (busy || !session) return;
    const ctx = context(), generation = ++mediaGeneration;
    membershipRevision++;
    const active = () => isCurrent(ctx) && generation === mediaGeneration;
    busy = true;
    lastErrorMessage = null;
    onNeedsRedraw();
    try {
      // Keep the acquired stream local until the permission promise belongs
      // to the current room/operation. A navigation cannot cancel the OS
      // prompt, but its late result must be stopped without making a join.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!active()) { stopStream(stream); return; }
      localStream = stream;
      const res = await request(ctx, invite ? '/voice/respond' : '/voice/start', invite ? {callId:invite.callId,accept:true} : {});
      const joined = res.voiceCall;
      if (!active()) {
        // The join may have committed while the user was navigating away.
        // Clean up that captured room, never use a later room's credentials.
        if (joined?.participants.some(p => p.playerId === ctx.session.playerId) && !(isCurrent(ctx) && ownStatus === 'joined' && callId === joined.callId)) {
          await request(ctx, '/voice/leave', {callId:joined.callId}, true).catch(() => {});
        }
        return;
      }
      if (!joined?.active || !joined.participants.some(p => p.playerId === ctx.session.playerId) || invite && joined.callId !== invite.callId) {
        throw new Error('That invitation has ended. Join the current call from the phone icon.');
      }
      applySummary(res);
      callId = joined.callId;
      ownStatus = 'joined';
      incomingInvite = null;
      membershipRevision++;
      reconcilePeerMesh();
      const queued = joiningSignals;
      joiningSignals = [];
      for (const msg of queued) {
        if (!active()) return;
        await handleSignal(msg).catch(() => {});
      }
    } catch (err) {
      if (!active()) return;
      teardownMedia();
      ownStatus = 'none';
      callId = null;
      lastErrorMessage = micErrorMessage(err);
    } finally {
      if (active()) { busy = false; onNeedsRedraw(); }
    }
  }

  function startOrJoinCall() { return joinCall(); }
  function acceptInvite() { if (incomingInvite) return joinCall(incomingInvite); }

  async function declineInvite() {
    if (busy || !incomingInvite) return;
    membershipRevision++;
    const invite = incomingInvite;
    incomingInvite = null;
    onNeedsRedraw();
    try {
      await roomApi("/voice/respond", { callId: invite.callId, accept: false });
    } catch {
      // Already resolved/expired — fine, the prompt is already closed.
    }
  }

  async function hangUp() {
    if (!callId) return;
    const ctx = context();
    const leavingCallId = callId;
    resetMembership();
    onNeedsRedraw();
    try {
      await request(ctx, "/voice/leave", { callId: leavingCallId });
    } catch {
      // Already resolved — fine.
    }
  }

  async function toggleMute() {
    if (!localStream || !callId) return;
    const nowMuted = !localStream.getAudioTracks().every((t) => t.enabled === false);
    for (const t of localStream.getAudioTracks()) t.enabled = !nowMuted;
    try {
      await roomApi("/voice/mute", { callId, muted: nowMuted });
    } catch {
      // Best-effort — local mute still applies even if the server update lags.
    }
    onNeedsRedraw();
  }

  function isMutedLocally() {
    if (!localStream) return false;
    return localStream.getAudioTracks().every((t) => !t.enabled);
  }

  // ---- Public surface ---------------------------------------------------

  function enterRoom(newCode, newSession, redraw) {
    leaveRoom();
    code = newCode;
    session = newSession;
    onNeedsRedraw = redraw || (() => {});
    connectPrivateChannel();
    refreshOwnView().catch(() => {});
  }

  function leaveRoom() {
    const ctx = context(), leavingCallId = callId;
    roomGeneration++;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    resetMembership();
    incomingInvite = null;
    panelExpanded = false;
    lastErrorMessage = null;
    latestVoiceCall = { active: false, callId: null, startedBy: null, participants: [] };
    iceServersCache = null;
    voiceCursor = null;
    code = null;
    session = null;
    onNeedsRedraw = () => {};
    if (ctx.session && leavingCallId) request(ctx, '/voice/leave', {callId:leavingCallId}, true).catch(() => {});
  }

  // Called every time app.js applies a fresh public room state — keeps
  // the mesh in sync with the server's own authoritative membership list.
  function onStateUpdate(state) {
    if (!applySummary(state)) return;
    if (ownStatus === 'joined' && (!latestVoiceCall.active || latestVoiceCall.callId !== callId || !isActiveParticipant(session.playerId))) resetMembership();
    reconcilePeerMesh();
  }

  function widget(state, me) {
    if (!me || me.controller !== "human" || state.solo) return null;
    const vc = latestVoiceCall;
    const items = [];
    const iconLabel = vc.active ? `${vc.participants.length} in call` : "Start voice call";
    const icon = el(
      "button",
      {
        type: "button",
        class: "voice-call-icon",
        "aria-label": vc.active ? `Voice call: ${vc.participants.length} people in call` : "Start a voice call",
        title: iconLabel,
        onclick: () => {
          if (ownStatus === "joined") {
            panelExpanded = !panelExpanded;
            onNeedsRedraw();
          } else {
            startOrJoinCall();
          }
        },
      },
      vc.active ? ["📞", el("span", { class: "voice-call-count" }, String(vc.participants.length))] : "📞",
    );
    items.push(icon);

    if (panelExpanded && ownStatus === "joined") {
      const list = el(
        "ul",
        { class: "voice-call-participants" },
        vc.participants.map((p) =>
          el("li", {}, [
            el("span", { class: `swatch ${p.color}` }),
            `${p.nickname}${p.playerId === session.playerId ? " (you)" : ""}`,
            p.muted ? el("span", { class: "voice-muted-tag" }, " 🔇") : null,
          ].filter(Boolean)),
        ),
      );
      const muteBtn = el(
        "button",
        { type: "button", class: "secondary", onclick: toggleMute },
        isMutedLocally() ? "Unmute" : "Mute",
      );
      const hangupBtn = el("button", { type: "button", class: "danger", onclick: hangUp }, "Hang up");
      items.push(el("div", { class: "voice-call-panel" }, [list, el("div", { class: "voice-call-actions" }, [muteBtn, hangupBtn])]));
    }

    if (lastErrorMessage) {
      items.push(
        el("div", { class: "voice-call-error", role: "status" }, [
          lastErrorMessage,
          el("button", { type: "button", class: "secondary", onclick: () => { lastErrorMessage = null; startOrJoinCall(); } }, "Retry"),
        ]),
      );
    }

    return el("div", { class: "voice-call-widget" }, items);
  }

  function incomingInviteModal() {
    if (!incomingInvite) return null;
    return el("div", { class: "voice-invite-toast", role: "alertdialog", "aria-label": "Incoming voice call" }, [
      el("p", {}, `${incomingInvite.inviterNickname || "Someone"} started a voice call`),
      lastErrorMessage ? el("p", { class: "error" }, lastErrorMessage) : null,
      el("div", { class: "voice-invite-actions" }, [
        el("button", { type: "button", onclick: acceptInvite }, "Accept"),
        el("button", { type: "button", class: "secondary", onclick: declineInvite }, "Decline"),
      ]),
    ].filter(Boolean));
  }

  return { enterRoom, leaveRoom, onStateUpdate, widget, incomingInviteModal };
}
