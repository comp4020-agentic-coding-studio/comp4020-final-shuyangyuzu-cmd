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

  async function api(path, body) {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
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
  }

  async function ensureIceServers() {
    if (iceServersCache && iceServersCache.callId === callId) return iceServersCache.servers;
    const res = await roomApi("/voice/ice-servers", {});
    iceServersCache = { callId, servers: res.iceServers };
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

  async function createPeer(remoteId, iceServers) {
    const pc = new RTCPeerConnection({ iceServers });
    peerConnections.set(remoteId, pc);
    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        roomApi("/voice/signal", { callId, toPlayerId: remoteId, signalType: "ice-candidate", data: ev.candidate }).catch(() => {});
      }
    };
    pc.ontrack = (ev) => {
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
      if (!peerConnections.has(remoteId)) return;
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await roomApi("/voice/signal", { callId, toPlayerId: remoteId, signalType: "offer", data: pc.localDescription });
    } catch {
      // Will be retried on the next failed transition, up to the cap above.
    }
  }

  async function connectToParticipant(remoteId) {
    if (peerConnections.has(remoteId) || remoteId === session.playerId) return;
    const iceServers = await ensureIceServers();
    const pc = await createPeer(remoteId, iceServers);
    // Deterministic initiator per pair, so both sides independently reach
    // the same decision with no coordinator and no glare: the
    // lexicographically smaller playerId always offers, the other always
    // waits for that offer.
    if (session.playerId < remoteId) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await roomApi("/voice/signal", { callId, toPlayerId: remoteId, signalType: "offer", data: pc.localDescription });
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
    const { from, signalType, data } = msg;
    let pc = peerConnections.get(from);
    if (signalType === "offer") {
      if (!pc) {
        const iceServers = await ensureIceServers();
        pc = await createPeer(from, iceServers);
      }
      await pc.setRemoteDescription(data);
      await flushPendingCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await roomApi("/voice/signal", { callId, toPlayerId: from, signalType: "answer", data: pc.localDescription });
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
    es.onmessage = (ev) => {
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
        handleSignal(msg).catch(() => {});
      } else if (msg.type === "removed_from_call" || msg.type === "call_ended") {
        if (msg.callId === callId || msg.type === "call_ended") {
          teardownMedia();
          callId = null;
          ownStatus = "none";
          panelExpanded = false;
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
      refreshOwnView().catch(() => {});
    };
    eventSource = es;
  }

  async function refreshOwnView() {
    const view = await roomApi("/voice/state", {});
    latestVoiceCall = { active: view.active, callId: view.callId, startedBy: view.startedBy, participants: view.participants };
    if (view.own.status === "joined" && ownStatus !== "joined") {
      // A stale 'joined' row from before this tab's own page load (a
      // refresh, or a brand-new tab) — this fresh JS state has no real
      // peer connections for it, so it must not silently count as present
      // (CLAUDE.md: refresh never auto-rejoins or auto-opens the mic).
      // Correcting this is honest, not a lie: from this tab's perspective
      // it genuinely isn't connected right now.
      callId = view.callId;
      try {
        await roomApi("/voice/leave", { callId: view.callId });
      } catch {
        // Already gone by the time we got here — fine either way.
      }
      callId = null;
      ownStatus = "none";
    } else if (view.own.status === "invited") {
      ownStatus = "invited";
      callId = view.callId;
      incomingInvite = { callId: view.callId, inviterNickname: view.own.invitedBy };
    } else {
      ownStatus = "none";
      callId = null;
    }
    onNeedsRedraw();
  }

  async function acquireMic() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return localStream;
  }

  async function startOrJoinCall() {
    if (busy) return;
    busy = true;
    lastErrorMessage = null;
    onNeedsRedraw();
    try {
      // Mic permission is requested only by the person's own deliberate
      // action, and must succeed BEFORE anything is created/joined
      // server-side — a failed permission request must never leave a
      // fake "in progress" call behind (CLAUDE.md).
      await acquireMic();
      const res = await roomApi("/voice/start", {});
      latestVoiceCall = res.voiceCall;
      callId = res.voiceCall.callId;
      ownStatus = "joined";
      incomingInvite = null;
      reconcilePeerMesh();
    } catch (err) {
      teardownMedia();
      lastErrorMessage = micErrorMessage(err);
    } finally {
      busy = false;
      onNeedsRedraw();
    }
  }

  async function acceptInvite() {
    if (busy || !incomingInvite) return;
    busy = true;
    lastErrorMessage = null;
    const invite = incomingInvite;
    onNeedsRedraw();
    try {
      await acquireMic();
      const res = await roomApi("/voice/respond", { callId: invite.callId, accept: true });
      latestVoiceCall = res.voiceCall;
      callId = invite.callId;
      ownStatus = "joined";
      incomingInvite = null;
      reconcilePeerMesh();
    } catch (err) {
      lastErrorMessage = micErrorMessage(err);
      teardownMedia();
    } finally {
      busy = false;
      onNeedsRedraw();
    }
  }

  async function declineInvite() {
    if (!incomingInvite) return;
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
    const leavingCallId = callId;
    teardownMedia();
    ownStatus = "none";
    callId = null;
    panelExpanded = false;
    onNeedsRedraw();
    try {
      await roomApi("/voice/leave", { callId: leavingCallId });
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
    code = newCode;
    session = newSession;
    onNeedsRedraw = redraw || (() => {});
    connectPrivateChannel();
    refreshOwnView().catch(() => {});
  }

  function leaveRoom() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    teardownMedia();
    callId = null;
    ownStatus = "none";
    incomingInvite = null;
    panelExpanded = false;
    lastErrorMessage = null;
    latestVoiceCall = { active: false, callId: null, startedBy: null, participants: [] };
    iceServersCache = null;
  }

  // Called every time app.js applies a fresh public room state — keeps
  // the mesh in sync with the server's own authoritative membership list.
  function onStateUpdate(state) {
    latestVoiceCall = state.voiceCall ?? latestVoiceCall;
    reconcilePeerMesh();
  }

  function widget(state, me) {
    if (!me || me.controller !== "human" || state.solo) return null;
    const vc = state.voiceCall ?? latestVoiceCall;
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
