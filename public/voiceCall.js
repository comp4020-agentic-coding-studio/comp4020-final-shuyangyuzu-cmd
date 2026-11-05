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
// A real bug found by reproducing it directly, not assumed from the code:
// WebRTC's own `connectionState` is NOT guaranteed to ever reach "failed"
// in bounded time. When ICE genuinely cannot find a working candidate pair
// (two peers behind symmetric NATs or AP/client-isolated Wi-Fi, no TURN
// configured), Chrome can sit at "new"/"checking" forever — confirmed with
// a forced iceTransportPolicy:"relay" + no TURN servers repro that stayed
// at connectionState "new" for 60+ seconds straight. The previous code
// only ever reacted to the "failed" transition, so this case showed
// "Connecting audio…" with no error and no retry, indefinitely — exactly
// the reported symptom. This timeout is the fix: a peer stuck off
// "connected" this long is treated the same as a "failed" one (one more
// bounded ICE-restart attempt, surfaced as a clear error), so nothing can
// hang forever silently.
const CONNECT_TIMEOUT_MS = 15000;

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
  // A real bug found and reproduced directly (two rapid Reconnects, the
  // first negotiation's answer deliberately delayed past the second):
  // nothing previously distinguished "this offer/answer/ICE-candidate
  // belongs to the CURRENT peer connection attempt for this remote" from
  // "...belongs to a PREVIOUS, already-superseded attempt." A stale
  // answer for an offer a since-closed pc already sent could still be
  // applied to the new pc in its place — signalingState alone can't tell
  // the two apart, since a fresh offer also leaves the new pc in
  // "have-local-offer". The result: signalingState reaches "stable" (so
  // nothing *looks* wrong) but the actual SDP/ICE credentials now
  // mismatch what was really offered, and the connection can never
  // establish media — audio silently never arrives, with no error until
  // CONNECT_TIMEOUT_MS eventually notices. Fixed with a per-remote
  // monotonic "attempt" tag carried in every outgoing offer/answer/
  // ice-candidate signal (never anything sensitive — just this tab's own
  // local counter) and checked on receipt; a signal whose attempt tag
  // doesn't match the CURRENT attempt for that remote is dropped as
  // stale, never applied.
  const peerAttempt = new Map(); // remotePlayerId -> current attempt number
  const remoteAudioEls = new Map(); // remotePlayerId -> <audio>
  const pendingCandidates = new Map(); // remotePlayerId -> RTCIceCandidateInit[]
  const reconnectAttempts = new Map(); // remotePlayerId -> count
  const blockedAudio = new Set();
  const peerHealth = new Map();
  const offersInFlight = new Map();
  const signalChains = new Map();
  let healthTimer = null;
  // A short, bounded, privacy-safe negotiation log — never SDP, never the
  // real IP/candidate string, never player ids beyond an 8-char prefix
  // (the same truncation src/actionLog.ts already uses for this exact
  // reason). Exists purely for the "Copy call diagnostics" button below,
  // so two people hitting a real connection failure can each paste a
  // short, aligned, shareable summary instead of guessing from the UI
  // alone. Capped so a long call never grows this unboundedly.
  const negotiationLog = [];
  const NEGOTIATION_LOG_MAX = 60;
  function logNegotiation(remoteId, text) {
    negotiationLog.push({ t: Date.now(), remote: remoteId.slice(0, 8), text });
    if (negotiationLog.length > NEGOTIATION_LOG_MAX) negotiationLog.shift();
  }

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
    negotiationLog.length = 0;
    diagnosticsCopyStatus = null;
    showDiagnosticsFallback = false;
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
      logNegotiation(remoteId, `closing peer connection (was ${pc.connectionState}, attempt=${pc.__attempt})`);
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
    blockedAudio.delete(remoteId);
    peerHealth.delete(remoteId);
    offersInFlight.delete(remoteId);
    // Deliberately NOT clearing peerAttempt here: closePeer is exactly
    // what a reconnect calls right before creating the NEXT pc for this
    // same remote, and the whole point of this counter is to keep
    // increasing across that close/recreate so the new round's number
    // never collides with the one it's superseding (see peerAttempt's
    // own comment above). Only a full call teardown (teardownMedia,
    // below) resets it — this remote is genuinely gone at that point,
    // not just getting a fresh peer connection within the same call.
  }

  function teardownMedia() {
    clearInterval(healthTimer); healthTimer = null;
    for (const remoteId of [...peerConnections.keys()]) closePeer(remoteId);
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      localStream = null;
    }
    pendingCandidates.clear();
    reconnectAttempts.clear();
    blockedAudio.clear(); peerHealth.clear(); offersInFlight.clear(); signalChains.clear();
    peerAttempt.clear();
  }

  async function playRemote(remoteId, audio) {
    try {
      await audio.play();
      if (remoteAudioEls.get(remoteId) !== audio) return;
      blockedAudio.delete(remoteId);
    } catch {
      if (remoteAudioEls.get(remoteId) !== audio) return;
      blockedAudio.add(remoteId);
    }
    onNeedsRedraw();
  }

  function enableSound() {
    // Calls play synchronously inside the user's click, before any await.
    for (const [id,audio] of remoteAudioEls) playRemote(id,audio);
  }

  function startHealthChecks() {
    clearInterval(healthTimer);
    healthTimer=setInterval(async()=>{
      for(const [id,pc] of peerConnections){
        const health=peerHealth.get(id);if(!health||!pc.getStats)continue;
        try{
          const report=await pc.getStats();if(peerConnections.get(id)!==pc)continue;
          let packets=0,sent=0,level=null,pairType=null,pairNominated=null;
          const candidates={};
          report.forEach(s=>{
            if(s.type==='local-candidate'||s.type==='remote-candidate')candidates[s.id]=s;
          });
          report.forEach(s=>{
            if(s.type==='inbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio'))packets+=s.packetsReceived||0;
            if(s.type==='outbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio'))sent+=s.packetsSent||0;
            if(s.type==='media-source'&&s.kind==='audio'&&typeof s.audioLevel==='number')level=s.audioLevel;
            if(s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated){
              pairNominated=true;
              const local=candidates[s.localCandidateId];
              pairType=local?.candidateType??null;
            }
          });
          if(packets>health.packets)health.receivedAt=Date.now();
          health.packets=packets;health.sent=sent;health.micLevel=level;
          health.pairType=pairType;health.pairNominated=pairNominated;
        }catch{ /* Closed links are removed by the connection handler. */ }
        // A peer that never reaches "connected" has no guarantee it will
        // ever reach "failed" either (see CONNECT_TIMEOUT_MS's own comment
        // above) — this bounded watchdog is what actually detects that
        // real-world stuck case, since onconnectionstatechange alone does
        // not fire for a connection that simply never changes state.
        // Retries at the same CONNECT_TIMEOUT_MS cadence, bounded by
        // attemptIceRestart's own MAX_SIGNAL_RECONNECT_ATTEMPTS cap (which
        // closes a genuinely dead link rather than retrying forever).
        if(pc.connectionState!=='connected'&&pc.connectionState!=='closed'&&Date.now()-(health.lastRestartAt??health.started)>CONNECT_TIMEOUT_MS){
          health.lastRestartAt=Date.now();
          reportConnectionError();
          attemptIceRestart(id);
        }
      }
      if(ownStatus==='joined')onNeedsRedraw();
    },2000);
    healthTimer?.unref?.();
  }

  async function announceReady(restart=false) {
    if(ownStatus!=='joined'||!callId)return;
    const ctx=context(),id=callId;
    await Promise.all(latestVoiceCall.participants.filter(p=>p.playerId!==session.playerId).map(p=>
      request(ctx,'/voice/signal',{callId:id,toPlayerId:p.playerId,signalType:'ready',data:{restart}})));
  }

  function reportConnectionError() {
    if(ownStatus!=='joined')return;
    lastErrorMessage='Audio connection could not be established. Reconnect audio; if it still fails on different networks, a TURN relay may be needed.';
    onNeedsRedraw();
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
      // A candidate queued while waiting for a remote description can
      // still be stale by the time it's flushed (queued during round N,
      // flushed only after round N+1's own remoteDescription landed) —
      // the same staleness check applied at receive time below.
      if (candidate.attempt !== pc.__attempt) continue;
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
    // This pc's own idea of "which negotiation round is current" — see
    // the peerAttempt declaration's own comment above for the real bug
    // this closes. Left unset here deliberately: only the code that
    // actually SENDS a fresh offer (offerTo's first send, or
    // attemptIceRestart) ever assigns a new value by drawing the next
    // number from the shared peerAttempt map, and only the code that
    // RECEIVES an offer adopts that offer's own attempt value — this is
    // what keeps both sides' numbers in agreement for the same round
    // without either side guessing the other's number independently.
    pc.__attempt = 0;
    peerConnections.set(remoteId, pc);
    peerHealth.set(remoteId,{started:Date.now(),packets:0,sent:0,receivedAt:null,micLevel:null,pairType:null,pairNominated:null});
    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate && active()) {
        // `attempt` rides inside `data` itself, not as a sibling field —
        // the server's own relaySignal forwards `data` opaquely and
        // never reads a field beside it (src/server.ts's voice/signal
        // route), so a sibling property would be silently dropped.
        const c = ev.candidate;
        logNegotiation(remoteId, `sent local ICE candidate (type=${c.type ?? '?'}) attempt=${pc.__attempt}`);
        request(ctx, "/voice/signal", { callId: id, toPlayerId: remoteId, signalType: "ice-candidate", data: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment, attempt: pc.__attempt } }).catch(() => {});
      } else if (!ev.candidate && active()) {
        logNegotiation(remoteId, `local ICE gathering complete attempt=${pc.__attempt}`);
      }
    };
    pc.ontrack = (ev) => {
      if (!active()) return;
      logNegotiation(remoteId, 'ontrack: remote audio track received');
      let audioEl = remoteAudioEls.get(remoteId);
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.setAttribute('playsinline','');
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        remoteAudioEls.set(remoteId, audioEl);
      }
      audioEl.srcObject = ev.streams?.[0] || new MediaStream([ev.track]);
      playRemote(remoteId,audioEl);
    };
    pc.onconnectionstatechange = () => {
      if (!active()) return;
      logNegotiation(remoteId, `connectionState=${pc.connectionState} attempt=${pc.__attempt}`);
      if (pc.connectionState === "connected") {
        reconnectAttempts.set(remoteId, 0);
        if([...peerConnections.values()].every(p=>p.connectionState==='connected'))lastErrorMessage=null;
        onNeedsRedraw();
      } else if (pc.connectionState === "failed") {
        reportConnectionError();
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
      // A fresh negotiation round — same reasoning as offerTo's own
      // comment above: draw the next attempt number before offering.
      pc.__attempt = (peerAttempt.get(remoteId) ?? 0) + 1;
      peerAttempt.set(remoteId, pc.__attempt);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      if (!isCurrent(ctx) || generation !== mediaGeneration) return;
      logNegotiation(remoteId, `sent ICE-restart offer attempt=${pc.__attempt}`);
      await request(ctx, "/voice/signal", { callId: id, toPlayerId: remoteId, signalType: "offer", data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp, attempt: pc.__attempt } });
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
      await offerTo(remoteId,pc);
    } else {
      // The caller may have joined alone. Its later public roster update
      // must tell the newly joined initiator that this receiver is ready.
      await request(ctx,'/voice/signal',{callId:id,toPlayerId:remoteId,signalType:'ready',data:{restart:false}});
    }
  }

  function offerTo(remoteId,pc,restart=false) {
    if(offersInFlight.has(remoteId))return offersInFlight.get(remoteId);
    const ctx=context(),id=callId,generation=mediaGeneration;
    const pending=(async()=>{
      if(pc.connectionState==='connected'&&!restart)return;
      if(pc.signalingState!=='have-local-offer'){
        // A genuinely NEW offer starts a new negotiation round — draw the
        // next attempt number from the shared, per-remote counter so this
        // tab's own next offer/answer/ICE-candidate for THIS round is
        // distinguishable from whatever round preceded it (see
        // peerAttempt's own comment above). Resending an EXISTING,
        // still-pending local offer below (the `else` of this branch)
        // deliberately does NOT draw a new number — it's the same round.
        pc.__attempt=(peerAttempt.get(remoteId)??0)+1;
        peerAttempt.set(remoteId,pc.__attempt);
        const offer=await pc.createOffer(restart?{iceRestart:true}:{});
        if(!isCurrent(ctx)||generation!==mediaGeneration||peerConnections.get(remoteId)!==pc)return;
        await pc.setLocalDescription(offer);
      }
      if(!isCurrent(ctx)||generation!==mediaGeneration||peerConnections.get(remoteId)!==pc)return;
      logNegotiation(remoteId,`sent offer${restart?' (restart)':''} attempt=${pc.__attempt}`);
      await request(ctx,'/voice/signal',{callId:id,toPlayerId:remoteId,signalType:'offer',data:{type:pc.localDescription.type,sdp:pc.localDescription.sdp,attempt:pc.__attempt}});
    })();
    offersInFlight.set(remoteId,pending);
    pending.finally(()=>{if(offersInFlight.get(remoteId)===pending)offersInFlight.delete(remoteId);}).catch(()=>{});
    return pending;
  }

  function reconnectAudio() {
    if(ownStatus!=='joined')return;
    mediaGeneration++;lastErrorMessage=null;
    for(const id of [...peerConnections.keys()])closePeer(id);
    reconcilePeerMesh();announceReady(true).catch(reportConnectionError);
    onNeedsRedraw();
  }

  function reconcilePeerMesh() {
    if (ownStatus !== "joined" || !callId) return;
    const others = latestVoiceCall.participants.map((p) => p.playerId).filter((id) => id !== session.playerId);
    for (const id of others) connectToParticipant(id).catch(reportConnectionError);
    for (const id of [...peerConnections.keys()]) {
      if (!others.includes(id)) closePeer(id);
    }
  }

  async function handleSignal(msg) {
    if (ownStatus !== 'joined' || !localStream || msg.callId !== callId || !isActiveParticipant(msg.from)) return;
    const ctx = context(), generation = mediaGeneration, id = callId;
    const { from, signalType, data } = msg;
    let pc = peerConnections.get(from);
    const active = () => isCurrent(ctx) && generation === mediaGeneration && id === callId && ownStatus === 'joined' && (!pc||peerConnections.get(from)===pc);
    if(signalType==='ready'){
      if(session.playerId<from){
        if(!pc){await connectToParticipant(from);pc=peerConnections.get(from);}
        const pending=offersInFlight.get(from);
        if(pending)await pending;
        if(pc&&active())await offerTo(from,pc,data?.restart===true);
      }
      return;
    }
    if (signalType === "offer") {
      if (!pc) {
        const iceServers = await ensureIceServers();
        if (!active()) return;
        pc = createPeer(from, iceServers);
      }
      // The answerer ADOPTS the offerer's own attempt number for this
      // round rather than generating its own — this is what lets both
      // sides agree on "which round is this" with no coordinator (see
      // peerAttempt's own comment above). A duplicate resend of the
      // SAME offer (same attempt, already answered) still short-circuits
      // to resending the existing answer, unchanged from before.
      if(pc.remoteDescription?.sdp===data.sdp&&pc.localDescription?.type==='answer'){
        logNegotiation(from,`received duplicate offer attempt=${data.attempt} — resent existing answer`);
        await request(ctx,'/voice/signal',{callId:id,toPlayerId:from,signalType:'answer',data:{type:pc.localDescription.type,sdp:pc.localDescription.sdp,attempt:pc.__attempt}});return;
      }
      pc.__attempt=data.attempt??pc.__attempt;
      logNegotiation(from,`received offer, applying attempt=${pc.__attempt}`);
      await pc.setRemoteDescription(data);
      if (!active()) return;
      await flushPendingCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!active()) return;
      logNegotiation(from,`sent answer attempt=${pc.__attempt}`);
      await request(ctx, "/voice/signal", { callId: id, toPlayerId: from, signalType: "answer", data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp, attempt: pc.__attempt } });
    } else if (signalType === "answer") {
      // The real bug this round fixed, reproduced directly: a stale
      // answer for a PREVIOUS negotiation round must never be applied to
      // the CURRENT one just because signalingState happens to still say
      // "have-local-offer" (a fresh offer leaves it in that same state).
      // data.attempt is the round the SENDER (the answerer) was actually
      // answering; pc.__attempt is the round THIS side most recently
      // offered — only a match is the real, current answer.
      if (pc && pc.signalingState === 'have-local-offer' && data.attempt === pc.__attempt) {
        logNegotiation(from,`received answer, applying attempt=${data.attempt}`);
        await pc.setRemoteDescription(data);
        await flushPendingCandidates(from, pc);
      } else if (pc) {
        logNegotiation(from,`DROPPED stale/mismatched answer: msg.attempt=${data.attempt} current=${pc.__attempt} signalingState=${pc.signalingState}`);
      }
    } else if (signalType === "ice-candidate") {
      if (pc && pc.remoteDescription) {
        // A stale candidate for a round this pc has already moved past
        // (remoteDescription is set, but for a DIFFERENT attempt) is
        // simply discarded — queuing it would only ever apply it to the
        // wrong round once some later remoteDescription lands.
        if (data.attempt !== pc.__attempt) {
          logNegotiation(from,`DROPPED stale ICE candidate: msg.attempt=${data.attempt} current=${pc.__attempt}`);
          return;
        }
        try {
          await pc.addIceCandidate(data);
        } catch {
          // Benign — a candidate that no longer applies.
        }
      } else {
        // pc doesn't exist yet, or its remoteDescription hasn't landed
        // yet — queue it; flushPendingCandidates (above) re-checks
        // data.attempt against pc.__attempt at flush time, once pc
        // actually exists, so a candidate queued for a round that's
        // since been superseded still never gets misapplied.
        const queue = pendingCandidates.get(from) ?? [];
        queue.push(data);
        pendingCandidates.set(from, queue);
      }
    }
  }

  function queueSignal(msg) {
    const ctx=context(),generation=mediaGeneration;
    const previous=signalChains.get(msg.from)||Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      if(!isCurrent(ctx)||generation!==mediaGeneration)return;
      if(ownStatus==='joined'&&msg.callId===callId&&!isActiveParticipant(msg.from))await refreshOwnView();
      if(isCurrent(ctx)&&generation===mediaGeneration)await handleSignal(msg);
    });
    signalChains.set(msg.from,next);
    next.catch(reportConnectionError).finally(()=>{if(signalChains.get(msg.from)===next)signalChains.delete(msg.from);});
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
        } else queueSignal(msg);
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
      if (isCurrent(ctx) && eventSource === es) refreshOwnView().then(()=>announceReady()).catch(reportConnectionError);
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
      startHealthChecks();
      reconcilePeerMesh();
      const queued = joiningSignals;
      joiningSignals = [];
      for (const msg of queued) {
        if (!active()) return;
        await handleSignal(msg).catch(() => {});
      }
      await announceReady().catch(reportConnectionError);
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

  // Everything below is deliberately plain English and truncated/derived
  // ids only — never SDP, never a real IP/candidate string, never a
  // session secret, never a full player id (CLAUDE.md: signaling detail
  // never belongs in a log; the same reasoning applies here). The
  // "alignment id" is the call's own server-generated UUID (callId),
  // truncated the same way src/actionLog.ts already truncates ids for
  // exactly this reason — it lets two people compare notes on the SAME
  // call/negotiation without exposing a credential, since callId is not
  // a secret (it's already visible in the public room state everyone in
  // the call already has).
  function diagnosticsText() {
    const lines = [];
    lines.push(`Las Vegas voice-call diagnostics — ${new Date().toISOString()}`);
    lines.push(`room ${code ?? '?'} · call ${(callId ?? '?').slice(0, 8)} · you ${(session?.playerId ?? '?').slice(0, 8)} · own status ${ownStatus}`);
    const relay = (iceServersCache?.servers || []).some(s => [].concat(s.urls).some(u => /^turns?:/.test(u)));
    lines.push(`TURN configured on this call: ${relay ? 'yes' : 'no'}`);
    lines.push('');
    lines.push('Peers:');
    for (const p of latestVoiceCall.participants) {
      if (p.playerId === session?.playerId) continue;
      const pc = peerConnections.get(p.playerId);
      const health = peerHealth.get(p.playerId);
      const short = p.playerId.slice(0, 8);
      if (!pc) { lines.push(`  ${short}: no peer connection yet`); continue; }
      lines.push(`  ${short}: connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState} signalingState=${pc.signalingState} attempt=${pc.__attempt}`);
      if (health) {
        lines.push(`    candidate pair: ${health.pairType ?? 'none selected yet'}${health.pairNominated ? ' (nominated)' : ''}`);
        lines.push(`    audio packets: received=${health.packets} sent=${health.sent} mic-level=${health.micLevel == null ? 'n/a' : health.micLevel.toFixed(4)}`);
        lines.push(`    last audio received: ${health.receivedAt ? new Date(health.receivedAt).toISOString() : 'never'}`);
      }
    }
    lines.push('');
    lines.push('Negotiation log (most recent last):');
    if (!negotiationLog.length) lines.push('  (empty — nothing has happened yet this call)');
    for (const entry of negotiationLog) {
      lines.push(`  [+${((entry.t - (negotiationLog[0]?.t ?? entry.t)) / 1000).toFixed(1)}s] ${entry.remote}: ${entry.text}`);
    }
    return lines.join('\n');
  }

  let diagnosticsCopyStatus = null; // transient feedback text, or null

  async function copyDiagnostics() {
    const text = diagnosticsText();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      diagnosticsCopyStatus = 'Copied — paste it wherever you share results.';
    } catch {
      // Honest fallback, matching this app's existing clipboard-failure
      // pattern (public/mixology.js, public/tavern.js's recovery codes):
      // never claim success when the clipboard genuinely failed.
      diagnosticsCopyStatus = 'Could not copy automatically — select and copy the text below.';
      showDiagnosticsFallback = true;
    }
    onNeedsRedraw();
  }

  let showDiagnosticsFallback = false;

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

    if(ownStatus==='joined'){
      const others=vc.participants.filter(p=>p.playerId!==session.playerId);
      const connected=others.filter(p=>peerConnections.get(p.playerId)?.connectionState==='connected').length;
      items.push(el('span',{class:'voice-link-summary',role:'status'},others.length?`Audio: ${connected}/${others.length} connected`:'Waiting for someone to join'));
      if(blockedAudio.size)items.push(el('button',{class:'secondary',onclick:enableSound},'Enable sound'));
    }

    if (panelExpanded && ownStatus === "joined") {
      const list = el(
        "ul",
        { class: "voice-call-participants" },
        vc.participants.map((p) =>
          el("li", {}, [
            el("span", { class: `swatch ${p.color}` }),
            `${p.nickname}${p.playerId === session.playerId ? " (you)" : ""}`,
            p.muted ? el("span", { class: "voice-muted-tag" }, " 🔇") : null,
            p.playerId!==session.playerId?el('small',{},peerConnections.get(p.playerId)?.connectionState==='connected'?(blockedAudio.has(p.playerId)?'Playback blocked':peerHealth.get(p.playerId)?.receivedAt&&Date.now()-peerHealth.get(p.playerId).receivedAt<6000?'Receiving audio':'Connected · waiting for audio'):'Connecting audio…'):null,
          ].filter(Boolean)),
        ),
      );
      const muteBtn = el(
        "button",
        { type: "button", class: "secondary", onclick: toggleMute },
        isMutedLocally() ? "Unmute" : "Mute",
      );
      const hangupBtn = el("button", { type: "button", class: "danger", onclick: hangUp }, "Hang up");
      const relay=(iceServersCache?.servers||[]).some(s=>[].concat(s.urls).some(u=>/^turns?:/.test(u)));
      const health=[...peerHealth.values()].find(h=>h.micLevel!==null);
      const diagnosticsBtn = el('button',{class:'secondary',onclick:copyDiagnostics},'Copy call diagnostics');
      const diagnosticsBits = [diagnosticsCopyStatus ? el('p',{class:'voice-network-note',role:'status'},diagnosticsCopyStatus) : null];
      if (showDiagnosticsFallback) {
        diagnosticsBits.push(el('textarea',{readonly:true,rows:6,style:'width:100%;font-size:10px;','aria-label':'Call diagnostics to copy'},diagnosticsText()));
      }
      items.push(el("div", { class: "voice-call-panel" }, [list,
        el('p',{class:'voice-network-note'},relay?'Relay available when needed':'Direct connection only · some networks need a TURN relay'),
        ...(health?[el('p',{class:'voice-network-note'},isMutedLocally()?'Microphone muted':health.micLevel>.005?'Microphone: sound detected':'Microphone: quiet')]:[]),
        el('button',{class:'secondary',onclick:reconnectAudio},'Reconnect audio'),
        diagnosticsBtn,
        ...diagnosticsBits.filter(Boolean),
        el("div", { class: "voice-call-actions" }, [muteBtn, hangupBtn])]));
    }

    if (lastErrorMessage) {
      items.push(
        el("div", { class: "voice-call-error", role: "status" }, [
          lastErrorMessage,
          el("button", { type: "button", class: "secondary", onclick: () => { lastErrorMessage = null; ownStatus==='joined'?reconnectAudio():startOrJoinCall(); } }, "Retry"),
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
