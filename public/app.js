// Client for the Vegas-dice-game prototype. Plain JS, no framework, no
// build step — matches src/server.ts's "run it directly" approach.
// Functional, not visually finished: the spec (crit 8) explicitly says
// "the feature list... and the polish can all wait", and the visual
// identity (product decision 5 in PLAN.md) is the student's own call to
// design, not this MVP's.
//
// Routing: a single route() dispatcher driven by the URL and `popstate`,
// so the browser's own back/forward buttons and an explicit "back to
// home" button go through the same code path — see PLAN.md's playtest
// round 1 section for why the previous one-off `replaceState` wasn't
// enough.

const assetVersion = new URL(document.querySelector('script[type="module"]').src).searchParams.get('v');
const { createTavern } = await import(`./tavern.js?v=${assetVersion}`);
// The one client-side staleness-gate implementation, shared with
// tavern.js (passed through to it below) rather than each view keeping
// its own hand-written copy — see public/liveSync.js's own doc comment
// for why (Crit 9 phase 7's independent review).
const { shouldApplyLiveUpdate } = await import(`./liveSync.js?v=${assetVersion}`);
const { createVoiceCall } = await import(`./voiceCall.js?v=${assetVersion}`);
const voiceCall = createVoiceCall({ el });
const { createPokerUI } = await import(`./poker.js?v=${assetVersion}`);
const pokerUI = createPokerUI({el,navigate});
const COLORS = ["red", "blue", "green", "yellow", "purple"];
const HEARTBEAT_MS = 5000; // comfortably under the server's default PRESENCE_STALE_MS (15s)
let activeRoomCode = null;
// Cheap insurance only, not the primary path (Crit 9: live updates come
// from GET /api/rooms/:code/events over SSE, below) — in case a stream
// silently stalls without EventSource noticing. Gated through the same
// staleness check as everything else, so it's a no-op whenever the
// stream is doing its job.
const FALLBACK_POLL_MS = 10000;

const root = document.getElementById("app");

// ---- Storage --------------------------------------------------------

function roomSessionKey(code) {
  return `vegas:room:${code.toUpperCase()}`;
}

function loadSession(code) {
  try {
    const raw = localStorage.getItem(roomSessionKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // private window, cleared storage, etc. — fall through to join
  }
}

function saveSession(code, session) {
  try {
    localStorage.setItem(roomSessionKey(code), JSON.stringify(session));
    localStorage.setItem("vegas:lastRoom", code.toUpperCase());
  } catch {
    // Storage may be unavailable (private window, quota); the game still
    // works for this tab, it just can't survive a reload. Not fatal.
  }
}

function clearSession(code) {
  try {
    localStorage.removeItem(roomSessionKey(code));
    if (localStorage.getItem("vegas:lastRoom") === code.toUpperCase()) {
      localStorage.removeItem("vegas:lastRoom");
    }
  } catch {
    // nothing to do
  }
}

/** For Home's "return to your room" offer — only returned if a session
 * for it still actually exists (not just a dangling pointer). */
function lastActiveRoom() {
  try {
    const code = localStorage.getItem("vegas:lastRoom");
    if (!code) return null;
    return loadSession(code) ? code : null;
  } catch {
    return null;
  }
}

// ---- API helpers ------------------------------------------------------

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

async function getState(code) {
  const res = await fetch(`/api/rooms/${code}/state`);
  if (!res.ok) throw Object.assign(new Error("room not found"), { status: res.status });
  return res.json();
}

// ---- Tiny DOM helper --------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    // Boolean HTML attributes (disabled, checked, ...) are "on" purely by
    // being present — setAttribute("disabled", null) stringifies to the
    // attribute string "null", which still counts as present and so
    // still disables the element. null/undefined/false must omit the
    // attribute entirely, not stringify it.
    else if (v === null || v === undefined || v === false) continue;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of [].concat(children)) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function render(node) {
  document.body.classList.toggle("table-mode", node.classList.contains("table"));
  root.replaceChildren(node);
}

function backToHomeButton() {
  // Navigates only — never calls /leave. Phase 2: this is explicitly
  // *not* the same action as the Leave room button in the lobby, and
  // the two must not be confused in the copy (PLAN.md).
  return el(
    "button",
    {
      type: "button",
      class: "secondary",
      onclick: async () => {
        // Persist the three-minute departure before navigating. Room
        // identity covers direct invitation users without a bar identity;
        // the optional bar binding uses its separate session.
        try {
          const code=codeFromUrl(),roomSession=code?loadSession(code):null;
          if(code&&roomSession)await api(`/rooms/${code}/depart`,roomSession);
          const barSession = JSON.parse(localStorage.getItem("vegas:bar:session") || "null");
          if (barSession?.playerId && barSession?.sessionSecret) {
            const response = await fetch("/api/bar/depart", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(barSession),
            });
            if (!response.ok) throw new Error('Could not save your departure. Please try again.');
          }
        } catch (error) {
          alert(error.message || 'Could not return to the bar. Please try again.');
          return;
        }
        navigate("/");
      },
    },
    "Back to the bar",
  );
}

// ---- Router -------------------------------------------------------------

function codeFromUrl() {
  return new URLSearchParams(location.search).get("room")?.toUpperCase() || null;
}

function navigate(path) {
  history.pushState(null, "", path);
  route();
}

window.addEventListener("popstate", route);

function route() {
  stopHeartbeat();
  stopLive();
  // Leaving the room view entirely (back to the bar, exit, a navigate
  // away) always tears down the voice call's media/connections —
  // CLAUDE.md: "返回大厅、退出游戏、房间解散、座位转交 NPC 时，退出语音并
  // 释放麦克风、音频播放和连接。" Re-entering the same room (below) starts
  // a fresh, unjoined voice-call state — never auto-rejoins, never
  // auto-opens the mic.
  voiceCall.leaveRoom();

  tavern.stop();
  const code = codeFromUrl();
  if (activeRoomCode && !code) {
    try {
      const oldSession=loadSession(activeRoomCode);
      if(oldSession)fetch(`/api/rooms/${activeRoomCode}/depart`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(oldSession),keepalive:true}).catch(()=>{});
      const barSession=JSON.parse(localStorage.getItem('vegas:bar:session')||'null');
      if(barSession)fetch('/api/bar/depart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(barSession),keepalive:true}).catch(()=>{});
    } catch {}
  }
  activeRoomCode=code;
  pokerUI.routeChanged();
  if(new URLSearchParams(location.search).has('poker')){pokerUI.mount();return;}
  if (!code) {
    tavern.mount();
    return;
  }
  const upper = code.toUpperCase();
  const session = loadSession(upper);
  if (session) {
    enterRoom(upper, session);
  } else {
    renderJoinOrClosed(upper);
  }
}

// ---- Classic direct game entry (create/join by code) ---------------------
//
// This is exactly the old Home screen's content, extracted so it can sit
// underneath the bar canvas rather than replace the whole page — bare
// "/" is the bar now, but direct create/join-by-code access to a Vegas
// game must keep working unmodified (PLAN.md: "existing entry point...
// stays reachable"). It manages its own re-renders into `container`
// rather than calling the global render(), so picking a color doesn't
// wipe out the bar canvas sitting next to it.

function buildClassicPanel() {
  const container = el("div", { class: "classic-entry" });
  let selectedColor = COLORS[0];
  let nicknameValue = "";
  try {
    const patron = JSON.parse(localStorage.getItem('vegas:bar:session') || 'null');
    nicknameValue = patron?.nickname || '';
    if (COLORS.includes(patron?.color)) selectedColor = patron.color;
  } catch { /* storage may be unavailable */ }
  let joinCodeValue = "";

  function build() {
    const last = lastActiveRoom();

    const nicknameInput = el("input", {
      type: "text",
      placeholder: "Your nickname",
      maxlength: "20",
      id: "nickname",
      value: nicknameValue,
      oninput: (e) => {
        nicknameValue = e.target.value;
      },
    });
    const swatchButtons = COLORS.map((c) =>
      el("button", {
        type: "button",
        class: `color-swatch ${c}` + (c === selectedColor ? " selected" : ""),
        "aria-label": c,
        onclick: () => {
          selectedColor = c;
          swatchButtons.forEach((btn, i) => btn.classList.toggle("selected", COLORS[i] === selectedColor));
        },
      }),
    );

    const errorBox = el("p", { class: "error", id: "entry-error" });

    const createForm = el(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const nickname = nicknameInput.value.trim();
          if (!nickname) return;
          try {
            const session = await api("/rooms", { nickname, color: selectedColor });
            saveSession(session.code, session);
            navigate(`/?room=${session.code}`);
          } catch (err) {
            errorBox.textContent = err.message ?? "something went wrong";
          }
        },
      },
      [
        el("h2", {}, "Start a table"),
        nicknameInput,
        el("div", { class: "colors" }, swatchButtons),
        el("button", { type: "submit" }, "Create room"),
      ],
    );

    const joinByCodeForm = el(
      "form",
      {
        class: "join-by-code",
        onsubmit: (e) => {
          e.preventDefault();
          const code = joinCodeValue.trim();
          if (code) navigate(`/?room=${code.toUpperCase()}`);
        },
      },
      [
        el("input", {
          type: "text",
          placeholder: "Room code (6 characters)",
          maxlength: "6",
          oninput: (e) => {
            joinCodeValue = e.target.value;
          },
        }),
        el("button", { type: "submit" }, "Go"),
      ],
    );

    container.replaceChildren(
      ...[
        el("h2", {}, "Play directly"),
        el("p", { class: "note" }, "Create a new table, or jump straight into one you have a code for — without going through the bar floor below."),
        last
          ? el("div", { class: "return-banner" }, [
              el("p", {}, `You still have a seat in room ${last}.`),
              el(
                "button",
                { type: "button", onclick: () => navigate(`/?room=${last}`) },
                "Return to that room",
              ),
            ])
          : null,
        createForm,
        errorBox,
        el("p", {}, "Have a room code?"),
        joinByCodeForm,
      ].filter(Boolean),
    );
  }

  build();
  return container;
}

// ---- Join (a code with no local session) --------------------------------

async function renderJoinOrClosed(code) {
  render(el("p", {}, "Loading…"));
  let state;
  try {
    state = await getState(code);
  } catch {
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Las Vegas"),
        el("p", { class: "error" }, `No room found for code ${code}.`),
        backToHomeButton(),
      ]),
    );
    return;
  }

  if (state.closed) {
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Las Vegas"),
        el("p", {}, `Room ${code} has closed.`),
        backToHomeButton(),
      ]),
    );
    return;
  }

  if (state.phase !== "lobby") {
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Las Vegas"),
        el("p", {}, `Room ${code} has already started, and this browser doesn't hold a seat in it.`),
        backToHomeButton(),
      ]),
    );
    return;
  }

  renderJoinForm(code, state);
}

function renderJoinForm(code, initialState) {
  const takenColors = new Set(initialState.players.map((p) => p.color));
  const firstAvailable = COLORS.find((c) => !takenColors.has(c)) ?? COLORS[0];
  let selectedColor = firstAvailable;
  let nicknameValue = "";

  function build(state) {
    const stillTaken = new Set(state.players.map((p) => p.color));
    if (stillTaken.has(selectedColor)) {
      selectedColor = COLORS.find((c) => !stillTaken.has(c)) ?? selectedColor;
    }

    const nicknameInput = el("input", {
      type: "text",
      placeholder: "Your nickname",
      maxlength: "20",
      id: "nickname",
      value: nicknameValue,
      oninput: (e) => {
        nicknameValue = e.target.value;
      },
    });

    const swatchButtons = COLORS.map((c) => {
      const takenByOther = stillTaken.has(c);
      return el("button", {
        type: "button",
        class: `color-swatch ${c}` + (c === selectedColor ? " selected" : "") + (takenByOther ? " taken" : ""),
        disabled: takenByOther,
        "aria-label": takenByOther ? `${c} (taken)` : c,
        onclick: () => {
          selectedColor = c;
          swatchButtons.forEach((btn, i) => btn.classList.toggle("selected", COLORS[i] === selectedColor));
        },
      });
    });

    const errorBox = el("p", { class: "error", id: "entry-error" });

    const form = el(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const nickname = nicknameInput.value.trim();
          if (!nickname) return;
          try {
            const session = await api(`/rooms/${code}/join`, { nickname, color: selectedColor });
            saveSession(code, session);
            enterRoom(code, session); // URL is already ?room=CODE — no history change needed
          } catch (err) {
            errorBox.textContent = err.message ?? "something went wrong";
          }
        },
      },
      [
        el("h2", {}, `Join room ${code}`),
        nicknameInput,
        el("div", { class: "colors" }, swatchButtons),
        el("button", { type: "submit" }, "Join"),
      ],
    );

    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Las Vegas"),
        el("p", { class: "note" }, [
          "Built for a handful of friends sitting around one table, each on ",
          "their own phone — not for matchmaking with strangers.",
        ]),
        form,
        errorBox,
        backToHomeButton(),
      ]),
    );
  }

  build(initialState);
}

// ---- Table / lobby view ---------------------------------------------

function enterRoom(code, session) {
  // Confirm the stored session is still valid before committing to it —
  // a cleared/rotated secret should fall back to a clear message with a
  // way out, not a silent dead end (CLAUDE.md: identity recovery is
  // browser-local and has no fallback once that's gone; the UI says so).
  api(`/rooms/${code}/resume`, session).then(()=>api(`/rooms/${code}/rejoin`, session))
    .then((state) => {
      startHeartbeat(code, session);
      // A refresh/reopen never auto-rejoins a voice call or opens the mic
      // on its own (CLAUDE.md) — enterRoom only wires up the private
      // signaling channel and its own-view catch-up fetch; actually
      // joining still requires the player's own click.
      voiceCall.enterRoom(code, session, () => { if (lastRenderedState) renderTable(code, session, lastRenderedState); });
      // rejoin's own response is already the room's current state —
      // hand it straight to startLive instead of fetching it again.
      startLive(code, session, state);
    })
    .catch(() => {
      render(
        el("div", { class: "entry" }, [
          el("h1", {}, "Las Vegas"),
          el(
            "p",
            { class: "error" },
            "This browser's saved seat for this room no longer works (cleared data, or a different device). There's no way to recover it — ask the host for a fresh invite if the room hasn't started yet.",
          ),
          backToHomeButton(),
        ]),
      );
    });
}

let eventSource = null;
let fallbackPollHandle = null;
let heartbeatHandle = null;
// The staleness gate's baseline, as a single `{epoch, seq}` cursor (or
// `null` before the first payload is ever applied) — see
// public/liveSync.js's shouldApplyLiveUpdate for the actual decision
// logic (shared with tavern.js, and mirroring src/live.ts's own copy
// exactly). A strictly-newer epoch resets this baseline unconditionally,
// which is what lets this tab keep receiving updates across a real
// server restart without a page reload (an independent review found a
// version-only gate would reject every post-restart payload forever,
// since a restarted process's sequence legitimately restarts at 0 — see
// PLAN.md's Crit 9 phase 7).
let liveCursor = null;
let liveGeneration = 0;
let visibilityHandler = null;
// Set by startLive to its own staleness-gated apply function, so an
// action handler (ready/start/roll/place/...) can hand its own request's
// already-fresh response straight to the live view instead of discarding
// it and waiting on the stream's next push.
let applyIncoming = () => {};
// A plain "go fetch the current state and apply it" — used for the
// fallback poll, the on-reconnect/on-visible resync, and as a safety net;
// always goes through the same staleness gate as everything else.
let refreshNow = () => {};
// The last state renderTable actually drew — voiceCall's own redraw
// callback (an invite arriving, a mic error, a mute toggle) re-renders
// from this rather than needing its own copy of the room's full state.
let lastRenderedState = null;

function stopLive() {
  liveGeneration++;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (fallbackPollHandle) clearInterval(fallbackPollHandle);
  fallbackPollHandle = null;
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    window.removeEventListener("focus", visibilityHandler);
    visibilityHandler = null;
  }
  liveCursor = null;
  applyIncoming = () => {};
  refreshNow = () => {};
}

function stopHeartbeat() {
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  heartbeatHandle = null;
}

function startHeartbeat(code, session) {
  stopHeartbeat();
  const tick = () => api(`/rooms/${code}/heartbeat`, session).catch(() => {});
  tick();
  heartbeatHandle = setInterval(tick, HEARTBEAT_MS);
}

// Crit 9: live updates via SSE rather than a fixed poll interval — see
// CLAUDE.md for what this push transport is and isn't allowed to carry
// (server-computed state outward only). `initialState`, when given
// (rejoin's own response), is applied immediately instead of waiting on
// a first fetch or the stream's first frame.
function startLive(code, session, initialState) {
  stopLive();
  const generation=liveGeneration;
  let latestState=null, ownBalance=null, requestedBankVersion=-1;
  function draw(state){
    const visible=ownBalance?.version===state.version?{...state,players:state.players.map(p=>p.id===session.playerId?{...p,moneyTotal:ownBalance.moneyTotal,wonBills:ownBalance.wonBills}:p)}:state;
    renderTable(code,session,visible);
  }

  function apply(state) {
    // The one staleness rule, used for every source of state below (the
    // stream, a fallback fetch, and an action's own response) —
    // public/liveSync.js's shouldApplyLiveUpdate, the single
    // implementation shared with tavern.js and mirroring src/live.ts's
    // own copy exactly (see that function's doc comment for the full
    // contract: a newer epoch always wins and resets the baseline, an
    // older epoch never wins even arriving late, same-epoch falls back
    // to strictly-newer-rev). Deliberately gated on `rev`, not
    // `state.version` (the DB's own optimistic-concurrency column) —
    // `rev` is this channel's own push-revision, bumped for a
    // presence-only change too (a `connected` flag flipping, a lobby
    // seat finally swept) that never touches `version` at all (CLAUDE.md:
    // a heartbeat must never race a real game action over the same
    // counter).
    if (typeof state.epoch === "number" && typeof state.rev === "number") {
      const incoming = { epoch: state.epoch, seq: state.rev };
      if (!shouldApplyLiveUpdate(liveCursor, incoming)) return;
      liveCursor = incoming;
    }

    const stillSeated = state.players.some((p) => p.id === session.playerId);
    const stillPending = !stillSeated && (state.pendingRequests ?? []).some((r) => r.id === session.playerId);
    if (!state.closed && !stillSeated && !stillPending) {
      // Neither a seated player nor a pending request anymore — swept out
      // while we weren't looking (disconnect grace expired), or a
      // request that was declined or expired. Same outcome either way:
      // this browser's seat is just gone.
      stopLive();
      stopHeartbeat();
      clearSession(code);
      render(
        el("div", { class: "entry" }, [
          el("h1", {}, "Las Vegas"),
          el("p", {}, "You were removed from this room (disconnected too long, or a pending request was declined or expired)."),
          backToHomeButton(),
        ]),
      );
      return;
    }
    if (stillPending) {
      renderPendingRequest(code, session, state);
      return;
    }
    latestState=state;draw(state);
    if(!state.closed&&state.phase!=='game_end'&&requestedBankVersion!==state.version&&state.players.some(p=>p.id===session.playerId&&p.controller==='human')){
      requestedBankVersion=state.version;
      api(`/rooms/${code}/winnings`,session).then(bank=>{
        if(generation!==liveGeneration||!latestState||bank.version!==latestState.version)return;
        ownBalance=bank;draw(latestState);
      }).catch(()=>{if(generation===liveGeneration)requestedBankVersion=-1;});
    }
  }
  applyIncoming = apply;

  async function fetchAndApply() {
    try {
      apply(await getState(code));
    } catch {
      // transient — the fallback poll or the next stream event will retry
    }
  }
  refreshNow = fetchAndApply;

  function connect() {
    const es = new EventSource(`/api/rooms/${code}/events`);
    es.onmessage = (ev) => {
      try {
        apply(JSON.parse(ev.data));
      } catch {
        // malformed/ping frame — ignore
      }
    };
    // Fires on the initial connect *and* on every automatic reconnect —
    // either way, do one unconditional fresh fetch rather than trust
    // that nothing was missed while the connection was down. Note this
    // fresh fetch is *not* on its own what makes a post-restart recovery
    // work (an earlier version of this comment claimed that) — it still
    // goes through the same epoch/rev gate above, which is what actually
    // lets a lower post-restart rev back in. This fetch's job is purely
    // the ordinary "catch up on anything missed while disconnected"
    // case, within a single server generation.
    es.onopen = () => {
      fetchAndApply();
    };
    eventSource = es;
  }

  visibilityHandler = () => {
    if (document.visibilityState !== "visible") return;
    // A backgrounded tab can have its EventSource silently suspended by
    // the browser; coming back to the tab is exactly when a stale view
    // would otherwise sit unnoticed, so reconnect if needed and always
    // force one fresh read regardless.
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) connect();
    fetchAndApply();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("focus", visibilityHandler);

  if (initialState) apply(initialState);
  connect();
  if (!initialState) fetchAndApply();
  fallbackPollHandle = setInterval(fetchAndApply, FALLBACK_POLL_MS);
}

function copyInviteLinkControl(shareLink) {
  const status = el("span", { class: "copy-status" });
  const copyBtn = el(
    "button",
    {
      type: "button",
      class: "secondary",
      onclick: async () => {
        try {
          if (!navigator.clipboard) throw new Error("no Clipboard API");
          await navigator.clipboard.writeText(shareLink);
          status.textContent = "copied!";
        } catch {
          // No silent "copied!" lie (playtest round 1 root cause #1):
          // if the automatic copy can't be confirmed, fall back to a
          // selected, manually-copyable field instead of pretending it
          // worked.
          linkField.focus();
          linkField.select();
          status.textContent = "selected — press Ctrl/Cmd+C to copy";
        }
      },
    },
    "Copy",
  );
  const linkField = el("input", { type: "text", readonly: "", value: shareLink, class: "invite-link-field" });
  return el("div", { class: "invite-link" }, [linkField, copyBtn, status]);
}

// Phase 3 (product-direction-update): shown instead of the normal lobby
// while this browser's own request to join an online table hasn't been
// approved yet — a pending request is never a player (CLAUDE.md: doesn't
// count toward MAX_PLAYERS, isn't seated), so it gets its own screen
// rather than a half-populated table view.
function renderPendingRequest(code, session, state) {
  const mine = (state.pendingRequests ?? []).find((r) => r.id === session.playerId);
  render(
    el("div", { class: "entry" }, [
      el("h1", {}, "Las Vegas"),
      el("p", {}, `Waiting for the host of room ${code} to approve your request to join${mine ? ` as ${mine.nickname}` : ""}.`),
      el(
        "p",
        { class: "note" },
        "You'll be seated automatically the moment the host approves you — this page updates live, no need to refresh.",
      ),
      el(
        "button",
        {
          type: "button",
          class: "secondary",
          onclick: async () => {
            try {
              await api(`/rooms/${code}/requests/cancel`, session);
            } catch {
              // Already approved, declined, or expired — navigating away
              // below is the right outcome regardless.
            }
            stopLive();
            stopHeartbeat();
            clearSession(code);
            navigate("/");
          },
        },
        "Cancel request",
      ),
    ]),
  );
}

function renderTable(code, session, state) {
  lastRenderedState = state;
  // Voice-call membership is part of the same public state push, so this
  // is where the client's own mesh stays in sync with the server's
  // authoritative participant list — every state update, not just a
  // voice-specific action's own response (CLAUDE.md: the server decides
  // who's in the call; the client only reflects and connects to that).
  voiceCall.onStateUpdate(state);

  if (state.closed) {
    stopLive();
    stopHeartbeat();
    clearSession(code);
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Las Vegas"),
        el("p", {}, `Room ${code} has closed.`),
        backToHomeButton(),
      ]),
    );
    return;
  }

  const me = state.players.find((p) => p.id === session.playerId);
  const isHost = state.hostPlayerId === session.playerId;
  const isMyTurn = state.currentPlayerId === session.playerId;
  const shareLink = `${location.origin}/?room=${code}`;

  const header = el("header", {}, [
    el("h1", {}, "Las Vegas"),
    gameRulesButton(),
    voiceCall.widget(state, me),
    el("p", {class:"table-subtitle"}, state.solo ? `OFFLINE MODE · ${state.players.length - 1} computer opponents` : ["Room ", el("strong", {}, code)]),
    ...(state.solo ? [] : [copyInviteLinkControl(shareLink)]),
  ].filter(Boolean));
  if(state.phase!=='lobby')header.appendChild(el('p',{class:'round-marker'},`Round ${state.round} / ${state.totalRounds} · First player: ${state.players.find(p=>p.id===state.startingPlayerId)?.nickname??'—'}`));

  const playerList = el(
    "ul",
    { class: "players" },
    state.players.map((p) => {
      const tags = [];
      if (p.id === state.hostPlayerId) tags.push("host");
      if (state.phase === "lobby") tags.push(p.ready ? "ready" : "not ready");
      if (!p.connected) tags.push("disconnected");
      return el("li", { class: p.id === state.currentPlayerId ? "current-turn" : "" }, [
        el("span", { class: `swatch ${p.color}` }),
        `${p.nickname}${tags.length ? ` (${tags.join(", ")})` : ""} — ${p.diceInHand} dice — ${p.moneyTotal==null?'Hidden':`$${p.moneyTotal.toLocaleString()}`}`,
      ]);
    }),
  );

  // Phase 3 (product-direction-update): visible to everyone (same
  // transparency as the player list itself — CLAUDE.md), but Approve/
  // Decline only render for the host; a non-host sees who's waiting and
  // nothing they can act on, which is itself useful ("someone wants in").
  const pendingSection =
    state.pendingRequests && state.pendingRequests.length > 0
      ? el("section", { class: "pending-requests" }, [
          el("h3", {}, "Waiting to join"),
          el(
            "ul",
            {},
            state.pendingRequests.map((r) =>
              el("li", {}, [
                el("span", { class: `swatch ${r.color}` }),
                `${r.nickname} `,
                ...(isHost
                  ? [
                      el(
                        "button",
                        {
                          type: "button",
                          onclick: async () => {
                            try {
                              applyIncoming(await api(`/rooms/${code}/requests/${r.id}/approve`, session));
                            } catch (err) {
                              alert(err.message);
                            }
                          },
                        },
                        "Approve",
                      ),
                      el(
                        "button",
                        {
                          type: "button",
                          class: "secondary",
                          onclick: async () => {
                            try {
                              applyIncoming(await api(`/rooms/${code}/requests/${r.id}/reject`, session));
                            } catch (err) {
                              alert(err.message);
                            }
                          },
                        },
                        "Decline",
                      ),
                    ]
                  : [el("span", { class: "note" }, "(waiting for the host)")]),
              ]),
            ),
          ),
        ])
      : null;

  let body;
  if (state.phase === "lobby") {
    body = lobbyControls(code, session, state, isHost, me);
  } else if (state.phase === "round_end") {
    const error=el('p',{class:'error',role:'status'});
    body = el("div", {}, [hexBoard(code, session, state, false),
      el("h2", {}, `Round ${state.round} complete`),
      el('ul',{class:'round-payouts'},state.players.map(p=>{
        const gained=state.casinos.reduce((sum,c)=>sum+(c.payout?.[p.id]||0),0);
        return el('li',{},`${p.nickname}: +$${gained.toLocaleString()} this round`);
      })),
      el('p',{},isHost?`Review the payouts, then start round ${state.round+1}.`:`Waiting for ${state.players.find(p=>p.id===state.hostPlayerId)?.nickname??'the host'} to start round ${state.round+1}.`),
      ...(isHost?[el('button',{class:'next-round-button',onclick:async e=>{
        const button=e.currentTarget;button.disabled=true;
        try{applyIncoming(await api(`/rooms/${code}/next-round`,{...session,expectedRound:state.round}));}
        catch(err){error.textContent=err.message;button.disabled=false;}
      }},`Start round ${state.round+1}`)]:[]),error,
    ]);
  } else if(state.phase==='game_end'){
    const names=state.winnerIds.map(id=>state.players.find(p=>p.id===id)?.nickname??id);
    body=el('section',{class:'game-results'},[
      el('h2',{},names.length===1?`Winner: ${names[0]}`:`Joint winners: ${names.join(' & ')}`),
      el('p',{},'All 4 rounds complete. Most money wins; tied totals are decided by banknote count. A complete tie shares the win.'),
      el('table',{class:'final-standings','aria-label':'Final standings'},[
        el('thead',{},[el('tr',{},['Rank','Player','Total','Banknotes'].map(text=>el('th',{scope:'col'},text)))]),
        el('tbody',{},state.standings.map(row=>el('tr',{class:row.rank===1?'winner-row':''},[
          el('td',{},String(row.rank)),el('td',{},state.players.find(p=>p.id===row.playerId)?.nickname??row.playerId),
          el('td',{},`$${row.moneyTotal.toLocaleString()}`),el('td',{},String(row.banknoteCount)),
        ]))),
      ]),hexBoard(code,session,state,false),
    ]);
  } else {
    body = hexBoard(code, session, state, isMyTurn);
  }

  const notes = el("details", { class: "notes" }, [
    el("summary", {}, "About this version"),
    el(
      "p",
      {},
      "Your accumulated winnings are private until the end of round 4. You can see your own bank; everyone sees the final standings. Casino payouts remain visible when a round settles.",
    ),
    el(
      "p",
      {},
      "Your seat is tied to this browser's storage. Clearing site data, or opening the game on a different device, loses it with no way back.",
    ),
  ]);

  // The board also stays visible at settlement and already includes the
  // player totals. Only the lobby needs the separate roster.
  const showPlayerListHere = state.phase === "lobby";
  render(
    el(
      "div",
      { class: "table" },
      [header, showPlayerListHere ? playerList : null, pendingSection, body, notes,
        state.phase !== 'lobby' ? exitGameButton(code,session,state.solo) : null,
        el('p',{class:'note'},'Back to the bar keeps your seat for 3 minutes. Exit game leaves immediately.'),backToHomeButton(),
        // Floats above everything else but is a small corner toast, not a
        // full-screen overlay — CLAUDE.md: must never cover key game
        // controls (roll/place/rules/exit stay fully clickable underneath).
        voiceCall.incomingInviteModal()].filter(
        Boolean,
      ),
    ),
  );
}

function exitGameButton(code,session,solo){
  return el('button',{class:'danger',onclick:()=>{
    const error=el('p',{class:'error',role:'status'});
    const dialog=el('dialog',{class:'rules-dialog','aria-label':'Confirm exit'},[
      el('h2',{},'Exit game?'),
      el('p',{},solo?'This ends your offline game immediately.':'A computer will take your seat while other human players continue. If nobody remains, the game ends.'),
      error,
      el('button',{class:'secondary',onclick:()=>dialog.close()},'Keep playing'),
      el('button',{class:'danger',onclick:async e=>{
        e.currentTarget.disabled=true;
        try{await api(`/rooms/${code}/exit`,session);}
        catch(err){error.textContent=err.message;e.currentTarget.disabled=false;return;}
        dialog.close();stopLive();stopHeartbeat();clearSession(code);navigate('/');
      }},'Confirm exit'),
    ]);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.appendChild(dialog);dialog.showModal();
  }},'Exit game');
}

function gameRulesButton(){
  return el('button',{class:'rules-button secondary','aria-label':'Game rules',title:'Game rules',onclick:()=>{
    const dialog=el('dialog',{class:'rules-dialog','aria-labelledby':'vegas-rules-title'},[
      el('h2',{id:'vegas-rules-title'},'How to play Las Vegas'),
      el('p',{},'A game of dice placement and competing for casino prizes. Choose a colour when taking a seat; everyone shares the six casinos.'),
      el('ol',{},[
        el('li',{},'2–5 players start with 8 dice each. Casinos 1–6 each receive at least $50,000 in prizes.'),
        el('li',{},'On your turn, roll all remaining dice. Choose one face and place every die with that face on the matching casino.'),
        el('li',{},'Continue in turn until all dice are placed. At each casino, every player tied on dice count is excluded from its payout.'),
        el('li',{},'Among the remaining players, most dice earns the highest banknote, next most earns the next banknote, and so on. No banknote left means no prize.'),
      ]),
      el('h3',{},'This website'),
      el('p',{},'Play four rounds. Most total money wins; tied totals compare banknote count. If both tie, share the win. Your bank is private until the end. The server randomly chooses the first starter, then the marker passes to the next seat each round. The host starts each next round. Royale special casino tiles and large-die powers are not included.'),
      el('p',{},'Online: request a seat and wait for host approval, then everyone readies up. Offline: play against computer opponents; an internet connection is still required.'),
      el('p',{},'Back to the bar reserves your seat for 3 minutes. Exit game leaves immediately. The game keeps running while these rules are open.'),
      el('a',{href:'https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf',target:'_blank',rel:'noopener'},'Original official rules'),
      el('button',{class:'secondary',onclick:()=>dialog.close()},'Close rules'),
    ]);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.appendChild(dialog);dialog.showModal();
  }},'📜');
}

function lobbyControls(code, session, state, isHost, me) {
  const notReady = state.players.filter((p) => !p.ready);
  const everyoneReady = state.players.length >= 2 && notReady.length === 0;

  const readyBtn = el(
    "button",
    {
      onclick: async () => {
        try {
          // The action's own response is already the room's fresh,
          // versioned state — apply it directly rather than discarding
          // it and waiting on a separate fetch or the stream's next push.
          applyIncoming(await api(`/rooms/${code}/ready`, { ...session, ready: !me.ready }));
        } catch (err) {
          alert(err.message);
        }
      },
    },
    me.ready ? "Cancel ready" : "Ready",
  );

  const leaveBtn = el(
    "button",
    {
      type: "button",
      class: "secondary",
      onclick: async () => {
        if (!confirm("Leave this table? Your seat is given up — someone else could take it.")) return;
        try {
          await api(`/rooms/${code}/exit`, session);
        } catch (err) {
          alert(err.message);
          return;
        }
        stopLive();
        stopHeartbeat();
        clearSession(code);
        navigate("/");
      },
    },
    "Leave table",
  );

  const children = [
    el("p", {}, `Waiting for players (${state.players.length}/5). Need at least 2, and everyone ready, to start.`),
    notReady.length > 0
      ? el("p", { class: "turn-note" }, `Waiting on: ${notReady.map((p) => p.nickname).join(", ")}`)
      : null,
    readyBtn,
    leaveBtn,
    el(
      "p",
      { class: "note" },
      "Back to the bar keeps your seat for 3 minutes. Leave table gives it up immediately.",
    ),
  ];

  if (isHost) {
    children.push(
      el(
        "button",
        {
          disabled: !everyoneReady,
          onclick: async () => {
            try {
              applyIncoming(await api(`/rooms/${code}/start`, session));
            } catch (err) {
              alert(err.message);
            }
          },
        },
        "Start game",
      ),
    );
    children.push(
      el(
        "button",
        {
          type: "button",
          class: "danger",
          onclick: async () => {
            if (!confirm("Disband this room for everyone? This can't be undone.")) return;
            try {
              await api(`/rooms/${code}/disband`, { ...session, confirm: true });
            } catch (err) {
              alert(err.message);
              return;
            }
            stopLive();
            stopHeartbeat();
            clearSession(code);
            navigate("/");
          },
        },
        "Disband room",
      ),
    );
  } else {
    children.push(el("p", {}, "Waiting for the host to start."));
  }

  return el("div", {}, children.filter(Boolean));
}

// The hexagonal board: six casinos arranged clockwise around a central
// dice-rolling area, matching the physical game's own real-table layout
// (the student's two reference photos) — casino 1 at the top, 2/3/4/5/6
// continuing clockwise, each casino's own bills shown toward the board's
// outer edge and its own placed dice (by colour and count) shown toward
// the centre, a plain readable restyle of the same six `.casino` cards
// the previous grid layout already rendered, not a new game mode. This
// replaces both the old casinoTable() grid and turnControls()'s separate
// call site: the roll/place controls now live inside the central dice
// bowl instead of below the grid, since that's where the reference photos
// put the physical dice tray — same api() calls, same accessible button
// text ("Roll" / "Place all N×V"), nothing about the actual game logic
// changes, only where its existing markup is positioned on screen.
//
// Deliberately NOT borrowed from the reference photos: any of Vegas
// Royale's own rule differences (a large weighted die, poker chips,
// bonus-sorted payouts, character abilities, a three-round match) — only
// the six-casinos-around-a-bowl spatial arrangement is reused, per the
// student's own explicit instruction. This remains the single-round base
// game already documented in PLAN.md/README.md.
function boardDie(value, color = 'ivory') {
  const pips = {1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
  return el('span', {class:`board-die die-${color}`,role:'img','aria-label':`${color} die showing ${value}`},
    Array.from({length:9},(_,i)=>el('i',{class:pips[value].includes(i)?'pip':'pip empty','aria-hidden':'true'})));
}
function casinoRing() {
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 800 800');svg.setAttribute('class','casino-ring');svg.setAttribute('aria-hidden','true');
  const point=(r,a)=>`${400+r*Math.cos(a)},${400+r*Math.sin(a)}`;
  for(let i=0;i<6;i++){
    const a=(-120+i*60)*Math.PI/180,b=a+Math.PI/3;
    const path=document.createElementNS(ns,'polygon');
    path.setAttribute('points',[point(287,a),point(287,b),point(151,b),point(151,a)].join(' '));
    path.setAttribute('fill',i%2?'#343b35':'#29372f');path.setAttribute('stroke','#ba965f');path.setAttribute('stroke-width','3');
    svg.appendChild(path);
  }
  const tray=document.createElementNS(ns,'polygon');
  tray.setAttribute('points',Array.from({length:6},(_,i)=>point(146,(-120+i*60)*Math.PI/180)).join(' '));
  tray.setAttribute('fill','#174a3a');tray.setAttribute('stroke','#bb8d53');tray.setAttribute('stroke-width','15');svg.appendChild(tray);
  return svg;
}
function hexBoard(code, session, state, isMyTurn) {
  const angleFor=value=>(-90+(value-1)*60)*Math.PI/180;
  const position=(value,r)=>{const a=angleFor(value);return `left:${50+r*Math.cos(a)}%;top:${50+r*Math.sin(a)}%`;};
  const casinoNames=['SUNSET','THE PALMS','STARLIGHT','GOLDEN HOUR','THE GRAND','MOONRISE'];
  const pieces=state.casinos.flatMap(c=>{
    const placements=Object.entries(c.placements).filter(([,n])=>n>0).map(([id,n])=>{
      const p=state.players.find(p=>p.id===id);
      return el('li',{class:'placed-dice',title:`${p?.nickname??'Player'}: ${n} dice`},[boardDie(c.value,p?.color||'ivory'),el('b',{},`×${n}`)]);
    });
    const skyline=el('span',{class:'casino-skyline','aria-hidden':'true'},[18,30,23,38,16].map((h,i)=>el('i',{style:`height:${h}px;--tower:${i}`})));
    const card=el('section',{class:`hex-casino casino-${c.value}`,style:position(c.value,24),'aria-label':`Casino ${c.value}`},[
      el('h3',{},[el('span',{class:'casino-number'},String(c.value)),el('span',{},casinoNames[c.value-1])]),
      skyline,el('ul',{class:'hex-casino-dice'},placements),
    ]);
    const bills=el('div',{class:`banknotes notes-${c.value}`,style:position(c.value,43.5),'aria-label':`Casino ${c.value} prizes`},c.bills.map(amount=>
      el('span',{class:`banknote note-${Math.floor(amount/10000)%3}`},[el('small',{},'LAS VEGAS'),el('strong',{},`$${amount.toLocaleString()}`),el('small',{},'CASINO BANK')])));
    return [card,bills];
  });
  const current=state.players.find(p=>p.id===state.currentPlayerId);
  const finished=state.phase==='round_end'||state.phase==='game_end';
  const rolled=state.lastRoll?.values||[];
  const tray=el('div',{class:'dice-bowl'},[
    el('span',{class:'tray-label'},'LAS VEGAS'),
    el('div',{class:'rolled-dice'},rolled.map(v=>boardDie(v,state.players.find(p=>p.id===state.lastRoll.playerId)?.color||'ivory'))),
    el('span',{class:'tray-caption'},finished?'ROUND COMPLETE':rolled.length?'CHOOSE A FACE BELOW':'THE DICE TRAY'),
  ]);
  const actionChildren=[el('div',{class:'turn-heading'},[
    el('span',{class:'eyebrow'},finished?'SETTLEMENT':isMyTurn?'YOUR TURN':'AT THE TABLE'),
    el('strong',{},finished?'Round complete':isMyTurn?(state.phase==='awaiting_roll'?'Roll your remaining dice':'Choose one face to place'):`Waiting on ${current?.nickname??'…'}`),
    el('span',{class:'turn-help'},finished?'Equal counts cancel. Remaining dice win the highest available bills.':isMyTurn?'All dice showing the chosen face go to its matching casino.':'The table updates automatically.'),
  ])];
  if(isMyTurn&&state.phase==='awaiting_roll')actionChildren.push(el('button',{class:'roll-action',onclick:async()=>{
    try{applyIncoming(await api(`/rooms/${code}/roll`,session));}catch(e){alert(e.message);}
  }},'Roll'));
  if(isMyTurn&&state.phase==='awaiting_placement'&&state.lastRoll){
    const counts=new Map();for(const v of rolled)counts.set(v,(counts.get(v)||0)+1);
    actionChildren.push(el('div',{class:'value-buttons'},[...counts.entries()].sort(([a],[b])=>a-b).map(([value,count])=>el('button',{
      class:'place-action','aria-label':`Place all ${count}×${value}`,onclick:async()=>{
        try{applyIncoming(await api(`/rooms/${code}/place`,{...session,value}));}catch(e){alert(e.message);}
      },
    },[boardDie(value,current?.color||'ivory'),el('span',{},`${count} dice → ${value}`)]))));
  }
  const players=el('ul',{class:'hex-players'},state.players.map(p=>el('li',{
    class:`player-seat${p.id===state.currentPlayerId?' current-turn':''}`,style:`--player-color:var(--dice-${p.color})`,
  },[
    el('span',{class:'player-token','aria-hidden':'true'},'♟'),
    el('div',{class:'player-identity'},[el('strong',{},p.controller==='npc'?p.nickname.replace(/\s*\(NPC\)$/,''):p.nickname),el('small',{},p.controller==='npc'?'NPC':p.id===session.playerId?'YOU':p.connected?'ONLINE':'AWAY')]),
    el('div',{class:'player-totals'},[el('span',{},`${p.diceInHand} dice`),el('strong',{},p.moneyTotal==null?(p.id===session.playerId?'Your bank…':'Hidden'):`$${p.moneyTotal.toLocaleString()}`)]),
  ])));
  return el('div',{class:'hex-board-wrap'},[
    el('div',{class:'board-caption'},[el('span',{},'VEGAS DICE'),el('span',{},`ROUND ${state.round} / ${state.totalRounds} · 2–5 PLAYERS`)]),
    el('div',{class:'hex-board'},[casinoRing(),...pieces,tray]),
    el('section',{class:'table-controls','aria-label':'Turn controls'},actionChildren),players,
  ]);
}

// ---- Boot -------------------------------------------------------------

const tavern = createTavern({ el, render, navigate, buildClassicPanel, saveSession, shouldApplyLiveUpdate });
route();
