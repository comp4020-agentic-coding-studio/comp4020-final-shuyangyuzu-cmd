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
const COLORS = ["red", "blue", "green", "yellow"];
const HEARTBEAT_MS = 5000; // comfortably under the server's default PRESENCE_STALE_MS (15s)
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
      onclick: () => {
        // Returning to the bar while a table binding is still active
        // starts the 2-minute away-from-table clock (CLAUDE.md's
        // leave/exit states) — a best-effort, fire-and-forget signal
        // alongside the navigation itself, not something this click
        // blocks on. Reads the bar session directly from localStorage
        // (same pattern buildClassicPanel already uses for the nickname
        // prefill) since this view only otherwise holds the game room's
        // own session, a different identity space (CLAUDE.md).
        try {
          const barSession = JSON.parse(localStorage.getItem("vegas:bar:session") || "null");
          if (barSession?.playerId && barSession?.sessionSecret) {
            fetch("/api/bar/depart", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(barSession),
            }).catch(() => {});
          }
        } catch {
          // No bar identity on this browser, or storage unavailable —
          // nothing to depart from.
        }
        navigate("/");
      },
    },
    "Back to the bar",
  );
}

// ---- Router -------------------------------------------------------------

function codeFromUrl() {
  return new URLSearchParams(location.search).get("room");
}

function navigate(path) {
  history.pushState(null, "", path);
  route();
}

window.addEventListener("popstate", route);

function route() {
  stopHeartbeat();
  stopLive();

  tavern.stop();
  const code = codeFromUrl();
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
        el("h1", {}, "Vegas"),
        el("p", { class: "error" }, `No room found for code ${code}.`),
        backToHomeButton(),
      ]),
    );
    return;
  }

  if (state.closed) {
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Vegas"),
        el("p", {}, `Room ${code} has closed.`),
        backToHomeButton(),
      ]),
    );
    return;
  }

  if (state.phase !== "lobby") {
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Vegas"),
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
        el("h1", {}, "Vegas"),
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
  api(`/rooms/${code}/rejoin`, session)
    .then((state) => {
      startHeartbeat(code, session);
      // rejoin's own response is already the room's current state —
      // hand it straight to startLive instead of fetching it again.
      startLive(code, session, state);
    })
    .catch(() => {
      render(
        el("div", { class: "entry" }, [
          el("h1", {}, "Vegas"),
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

function stopLive() {
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
    if (!state.closed && !stillSeated) {
      // Swept out while we weren't looking (disconnect grace expired) —
      // this browser's seat is just gone, same as a voluntary leave.
      stopLive();
      stopHeartbeat();
      clearSession(code);
      render(
        el("div", { class: "entry" }, [
          el("h1", {}, "Vegas"),
          el("p", {}, "You were removed from this room after being disconnected too long."),
          backToHomeButton(),
        ]),
      );
      return;
    }
    renderTable(code, session, state);
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

function renderTable(code, session, state) {
  if (state.closed) {
    stopLive();
    stopHeartbeat();
    clearSession(code);
    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Vegas"),
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
    el("h1", {}, "Vegas"),
    el("p", {}, ["Room ", el("strong", {}, code)]),
    copyInviteLinkControl(shareLink),
  ]);

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
        `${p.nickname}${tags.length ? ` (${tags.join(", ")})` : ""} — ${p.diceInHand} dice — $${p.moneyTotal.toLocaleString()}`,
      ]);
    }),
  );

  let body;
  if (state.phase === "lobby") {
    body = lobbyControls(code, session, state, isHost, me);
  } else if (state.phase === "round_end") {
    body = el("div", {}, [
      el("h2", {}, "Round over"),
      el("p", {}, "Final money totals are shown above. Thanks for playing!"),
    ]);
  } else {
    body = el("div", {}, [casinoTable(state), turnControls(code, session, state, isMyTurn)]);
  }

  const notes = el("details", { class: "notes" }, [
    el("summary", {}, "About this version"),
    el(
      "p",
      {},
      "Winnings are shown openly to everyone here, continuously — unlike the physical board game, where they're kept face-down and hidden until the end. A deliberate choice for a shared, multi-phone table.",
    ),
    el(
      "p",
      {},
      "Your seat is tied to this browser's storage. Clearing site data, or opening the game on a different device, loses it with no way back.",
    ),
  ]);

  render(el("div", { class: "table" }, [header, playerList, body, notes, backToHomeButton()]));
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
          await api(`/rooms/${code}/leave`, session);
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
    el("p", {}, `Waiting for players (${state.players.length}/4). Need at least 2, and everyone ready, to start.`),
    notReady.length > 0
      ? el("p", { class: "turn-note" }, `Waiting on: ${notReady.map((p) => p.nickname).join(", ")}`)
      : null,
    readyBtn,
    leaveBtn,
    el(
      "p",
      { class: "note" },
      "\"Back to the bar\" keeps your seat here — come back any time. \"Leave table\" gives it up for good.",
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

function casinoTable(state) {
  return el(
    "div",
    { class: "casinos" },
    state.casinos.map((c) =>
      el("div", { class: "casino" }, [
        el("h3", {}, `Casino ${c.value}`),
        el("p", { class: "bills" }, c.bills.length ? `$${c.bills.map((b) => b.toLocaleString()).join(", $")}` : "—"),
        el(
          "ul",
          {},
          Object.entries(c.placements)
            .filter(([, count]) => count > 0)
            .map(([playerId, count]) => {
              const p = state.players.find((pl) => pl.id === playerId);
              return el("li", {}, `${p?.nickname ?? "?"}: ${count}`);
            }),
        ),
      ]),
    ),
  );
}

function turnControls(code, session, state, isMyTurn) {
  if (!isMyTurn) {
    const current = state.players.find((p) => p.id === state.currentPlayerId);
    return el("p", { class: "turn-note" }, `Waiting on ${current?.nickname ?? "…"}.`);
  }

  if (state.phase === "awaiting_roll") {
    return el(
      "button",
      {
        onclick: async () => {
          try {
            applyIncoming(await api(`/rooms/${code}/roll`, session));
          } catch (err) {
            alert(err.message);
          }
        },
      },
      "Roll",
    );
  }

  if (state.phase === "awaiting_placement" && state.lastRoll) {
    const counts = new Map();
    for (const v of state.lastRoll.values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return el("div", { class: "placement" }, [
      el("p", {}, `You rolled: ${state.lastRoll.values.join(", ")}`),
      el(
        "div",
        { class: "value-buttons" },
        [...counts.entries()].map(([value, count]) =>
          el(
            "button",
            {
              onclick: async () => {
                try {
                  applyIncoming(await api(`/rooms/${code}/place`, { ...session, value }));
                } catch (err) {
                  alert(err.message);
                }
              },
            },
            `Place all ${count}×${value}`,
          ),
        ),
      ),
    ]);
  }

  return el("p", {}, "…");
}

// ---- Boot -------------------------------------------------------------

const tavern = createTavern({ el, render, navigate, buildClassicPanel, saveSession, shouldApplyLiveUpdate });
route();
