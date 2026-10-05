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

const COLORS = ["red", "blue", "green", "yellow"];
const POLL_MS = 1500;
const HEARTBEAT_MS = 5000; // comfortably under the server's default PRESENCE_STALE_MS (15s)

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
  return el("button", { type: "button", class: "secondary", onclick: () => navigate("/") }, "Back to home");
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
  stopPolling();
  stopBarLoop();
  const code = codeFromUrl();
  if (!code) {
    renderBarPage();
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

// ---- The bar (Phase 1: visuals, movement, identity, sync) -----------------
//
// A separate identity layer from a game room's, on purpose (CLAUDE.md):
// its own localStorage key, its own session secret, its own heartbeat —
// never the same rows as a Vegas room's player. Table click-to-join/
// create (Phase 2), ordering (Phase 3), and seating (Phase 4) aren't
// wired yet; the 6 game-table tiles are visible but inert this phase.

const BAR_COLORS = ["red", "blue", "green", "yellow", "purple", "teal", "orange", "pink"];
const BAR_SESSION_KEY = "vegas:bar:session";
const BAR_POLL_MS = 1500; // matches the existing game-state poll — no architecture change this phase
const BAR_HEARTBEAT_MS = 5000;

function loadBarSession() {
  try {
    const raw = localStorage.getItem(BAR_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveBarSession(session) {
  try {
    localStorage.setItem(BAR_SESSION_KEY, JSON.stringify(session));
  } catch {
    // tab-only fallback, same as the game's session storage
  }
}

let barLayoutCache = null;
async function getBarLayout() {
  if (barLayoutCache) return barLayoutCache;
  const res = await fetch("/api/bar/layout");
  barLayoutCache = await res.json();
  return barLayoutCache;
}

async function barApi(path, body) {
  const res = await fetch(`/api/bar${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message ?? "request failed"), { code: data.error, status: res.status });
  return data;
}

async function getBarState() {
  const res = await fetch("/api/bar/state");
  return res.json();
}

let barHeartbeatHandle = null;
let barPollHandle = null;

function stopBarLoop() {
  if (barHeartbeatHandle) clearInterval(barHeartbeatHandle);
  if (barPollHandle) clearInterval(barPollHandle);
  barHeartbeatHandle = null;
  barPollHandle = null;
}

// Warm wood-tavern palette, drawn procedurally — no imported tileset or
// copied assets (CLAUDE.md). Deliberately simple: two floor tones, flat
// furniture blocks, no lighting effects.
const BAR_PALETTE = {
  floorA: "#5a3b26",
  floorB: "#6b4631",
  counter: "#3d2817",
  counterTop: "#8a5a33",
  stool: "#2e1d10",
  diningTable: "#7a4b2a",
  diningTableTop: "#9c6b3f",
  tableFelt: "#2d5a3d",
  tableFeltReserved: "#4a4a44",
  tableLabel: "#f4e9d8",
  textOutline: "#1a120b",
};

const BAR_SWATCH_HEX = {
  red: "#d1495b",
  blue: "#3a86ff",
  green: "#2a9d8f",
  yellow: "#e9c46a",
  purple: "#9b5de5",
  teal: "#2ec4b6",
  orange: "#f4895f",
  pink: "#f06ba8",
};

function drawBarScene(ctx, layout, state, tileSize) {
  const { gridCols, gridRows, tables } = layout;
  ctx.clearRect(0, 0, gridCols * tileSize, gridRows * tileSize);

  // Floor
  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? BAR_PALETTE.floorA : BAR_PALETTE.floorB;
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }

  function tileRect(x, y, w, h) {
    return [x * tileSize, y * tileSize, w * tileSize, h * tileSize];
  }

  // Counter (hardcoded to match src/barLayout.ts's FURNITURE — Phase 1
  // doesn't fetch dining-table/stool positions from the server since
  // they're not interactive yet; only the game tables come from /api/bar/layout).
  ctx.fillStyle = BAR_PALETTE.counter;
  ctx.fillRect(...tileRect(3, 1, 14, 1));
  ctx.fillStyle = BAR_PALETTE.counterTop;
  ctx.fillRect(3 * tileSize, 1 * tileSize, 14 * tileSize, tileSize * 0.3);

  for (const sx of [3, 6, 9, 12, 15]) {
    ctx.fillStyle = BAR_PALETTE.stool;
    const cx = sx * tileSize + tileSize / 2;
    const cy = 2 * tileSize + tileSize / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, tileSize * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const dx of [1, 8, 15]) {
    ctx.fillStyle = BAR_PALETTE.diningTable;
    ctx.fillRect(...tileRect(dx, 4, 2, 2));
    ctx.fillStyle = BAR_PALETTE.diningTableTop;
    const cx = (dx + 1) * tileSize;
    const cy = 5 * tileSize;
    ctx.beginPath();
    ctx.arc(cx, cy, tileSize * 0.75, 0, Math.PI * 2);
    ctx.fill();
  }

  // Game tables — these DO come from the server (src/bar.ts getGameTables()).
  for (const t of tables) {
    const [px, py, pw, ph] = tileRect(t.x, t.y, 2, 2);
    ctx.fillStyle = t.available ? BAR_PALETTE.tableFelt : BAR_PALETTE.tableFeltReserved;
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = BAR_PALETTE.textOutline;
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);

    ctx.font = `${Math.round(tileSize * 0.32)}px monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = BAR_PALETTE.tableLabel;
    const label = t.available ? t.label : t.label.split(" — ")[0];
    ctx.fillText(label, px + pw / 2, py + ph / 2 - 2);
    if (!t.available) {
      ctx.font = `${Math.round(tileSize * 0.22)}px monospace`;
      ctx.fillStyle = "#c9c9c0";
      ctx.fillText("not yet open", px + pw / 2, py + ph / 2 + tileSize * 0.3);
    }
  }

  // Patrons
  for (const p of state.players) {
    const cx = p.x * tileSize + tileSize / 2;
    const cy = p.y * tileSize + tileSize / 2;
    ctx.fillStyle = BAR_SWATCH_HEX[p.color] ?? "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, tileSize * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = BAR_PALETTE.textOutline;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = `${Math.round(tileSize * 0.3)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = BAR_PALETTE.textOutline;
    ctx.fillText(p.nickname, cx + 1, cy - tileSize * 0.45 + 1);
    ctx.fillStyle = "#fff";
    ctx.fillText(p.nickname, cx, cy - tileSize * 0.45);
  }
}

async function renderBarIdentitySetup(container) {
  let selectedColor = BAR_COLORS[0];
  let nicknameValue = "";

  function build() {
    const nicknameInput = el("input", {
      type: "text",
      placeholder: "Your nickname",
      maxlength: "20",
      value: nicknameValue,
      oninput: (e) => {
        nicknameValue = e.target.value;
      },
    });
    const swatchButtons = BAR_COLORS.map((c) =>
      el("button", {
        type: "button",
        class: `color-swatch ${c}` + (c === selectedColor ? " selected" : ""),
        "aria-label": c,
        onclick: () => {
          selectedColor = c;
          swatchButtons.forEach((btn, i) => btn.classList.toggle("selected", BAR_COLORS[i] === selectedColor));
        },
      }),
    );
    const errorBox = el("p", { class: "error" });

    const form = el(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const nickname = nicknameInput.value.trim();
          if (!nickname) return;
          try {
            const session = await barApi("/join", { nickname, color: selectedColor });
            saveBarSession({ playerId: session.playerId, sessionSecret: session.sessionSecret });
            renderBarPage();
          } catch (err) {
            errorBox.textContent = err.message ?? "something went wrong";
          }
        },
      },
      [
        el("h2", {}, "Walk into the bar"),
        nicknameInput,
        el("div", { class: "colors" }, swatchButtons),
        el("button", { type: "submit" }, "Enter the bar"),
      ],
    );
    container.replaceChildren(form, errorBox);
  }

  build();
}

// Mirrors the non-game furniture hardcoded in drawBarScene (the counter,
// stools, dining tables aren't part of /api/bar/layout's response since
// they're not interactive yet — see that function's own comment). Used
// here so a click can be rejected locally, without a doomed round trip
// to the server, for the same reason the server itself would reject it.
const STATIC_FURNITURE_RECTS = [
  { x: 3, y: 1, w: 14, h: 1 },
  ...[3, 6, 9, 12, 15].map((x) => ({ x, y: 2, w: 1, h: 1 })),
  ...[1, 8, 15].map((x) => ({ x, y: 4, w: 2, h: 2 })),
];

function tileCoveredByRect(x, y, rects) {
  return rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

function renderBarCanvas(container, session) {
  const canvasWrap = el("div", { class: "bar-canvas-wrap" });
  const canvas = el("canvas");
  const status = el("p", { class: "bar-status" }, "Tap a floor tile to walk there.");
  canvasWrap.appendChild(canvas);
  container.appendChild(canvasWrap);
  container.appendChild(status);

  getBarLayout().then((layout) => {
    const { gridCols, gridRows, tileSize } = layout;
    canvas.width = gridCols * tileSize;
    canvas.height = gridRows * tileSize;
    const ctx = canvas.getContext("2d");

    const furnitureRects = [...STATIC_FURNITURE_RECTS, ...layout.tables.map((t) => ({ x: t.x, y: t.y, w: 2, h: 2 }))];
    let latestState = { players: [] };
    let myPos = null;

    function redraw() {
      drawBarScene(ctx, layout, latestState, tileSize);
    }

    function tick() {
      getBarState()
        .then((state) => {
          latestState = state;
          const mine = state.players.find((p) => p.id === session.playerId);
          if (mine) myPos = { x: mine.x, y: mine.y };
          redraw();
        })
        .catch(() => {});
    }
    barApi("/heartbeat", session).catch(() => {});
    tick();
    barHeartbeatHandle = setInterval(() => barApi("/heartbeat", session).catch(() => {}), BAR_HEARTBEAT_MS);
    barPollHandle = setInterval(tick, BAR_POLL_MS);

    canvas.addEventListener("click", async (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const tx = Math.floor(((e.clientX - rect.left) * scaleX) / tileSize);
      const ty = Math.floor(((e.clientY - rect.top) * scaleY) / tileSize);

      const table = layout.tables.find((t) => tx >= t.x && tx < t.x + 2 && ty >= t.y && ty < t.y + 2);
      if (table) {
        status.textContent = table.available
          ? `${table.label} — table selection and joining land in Phase 2.`
          : `${table.label}.`;
        return;
      }

      // Client-side pre-check against the exact same rules the server
      // enforces (src/barLayout.ts's isValidStep) — not a replacement for
      // server validation, just avoiding a doomed request for an
      // obviously-invalid click (too far, or onto non-game furniture),
      // which would otherwise still show up as a failed network request
      // even though the app handles the resulting error gracefully.
      if (tx < 0 || tx >= gridCols || ty < 0 || ty >= gridRows) {
        status.textContent = "That's outside the bar.";
        return;
      }
      if (tileCoveredByRect(tx, ty, furnitureRects)) {
        status.textContent = "Can't stand there — try an open floor tile.";
        return;
      }
      if (myPos) {
        const dx = Math.abs(tx - myPos.x);
        const dy = Math.abs(ty - myPos.y);
        const isAdjacent = dx <= 1 && dy <= 1 && (dx !== 0 || dy !== 0);
        if (!isAdjacent) {
          status.textContent = "Too far — walk there one step at a time.";
          return;
        }
      }

      try {
        await barApi("/move", { ...session, x: tx, y: ty });
        status.textContent = "Tap a floor tile to walk there.";
      } catch (err) {
        if (err.code !== "invalid_move") status.textContent = err.message ?? "couldn't move there";
      }
    });
  });
}

function renderBarPage() {
  // barSection's *position* in the page is fixed synchronously, even
  // though what fills it in (identity setup, or the canvas once rejoin
  // resolves) arrives later via a promise — otherwise the classic panel
  // below, appended synchronously at the end of this function, would
  // render before the bar section's async content ever lands, putting
  // it in the wrong place. Caught before shipping, not after.
  const barSection = el("div");
  const page = el("div", { class: "bar-page" }, [
    el("h1", {}, "Vegas — The Bar"),
    el(
      "p",
      { class: "note" },
      "A shared table where friends walk in, order at the counter, and go play a game. Texas hold'em, dominoes, and blackjack tables are reserved, not yet open.",
    ),
    barSection,
  ]);
  render(page);

  const session = loadBarSession();
  if (!session) {
    renderBarIdentitySetup(barSection);
  } else {
    // Confirm the saved identity is still valid before committing to it —
    // same pattern as the game's rejoin check.
    barApi("/rejoin", session)
      .then(() => renderBarCanvas(barSection, session))
      .catch(() => {
        try {
          localStorage.removeItem(BAR_SESSION_KEY);
        } catch {
          // nothing to do
        }
        renderBarIdentitySetup(barSection);
      });
  }

  page.appendChild(buildClassicPanel());
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
    .then(() => {
      startHeartbeat(code, session);
      startPolling(code, session);
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

let pollHandle = null;
let heartbeatHandle = null;
// Set by startPolling to its own tick function, so an action handler
// (ready/start/roll/place/...) can force an immediate state refresh
// right after its own request succeeds, rather than leaving the player
// looking at a stale view for up to POLL_MS until the next scheduled
// tick — which is both confusing and was caught producing a flaky-
// looking "the button didn't work" moment during verification.
let refreshNow = () => {};

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
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

function startPolling(code, session) {
  stopPolling();
  const tick = () =>
    getState(code)
      .then((state) => {
        const stillSeated = state.players.some((p) => p.id === session.playerId);
        if (!state.closed && !stillSeated) {
          // Swept out while we weren't looking (disconnect grace
          // expired) — this browser's seat is just gone, same as a
          // voluntary leave from elsewhere.
          stopPolling();
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
      })
      .catch(() => {});
  refreshNow = tick;
  tick();
  pollHandle = setInterval(tick, POLL_MS);
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
    stopPolling();
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
          await api(`/rooms/${code}/ready`, { ...session, ready: !me.ready });
          refreshNow();
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
        try {
          await api(`/rooms/${code}/leave`, session);
        } catch (err) {
          alert(err.message);
          return;
        }
        stopPolling();
        stopHeartbeat();
        clearSession(code);
        navigate("/");
      },
    },
    "Leave room",
  );

  const children = [
    el("p", {}, `Waiting for players (${state.players.length}/4). Need at least 2, and everyone ready, to start.`),
    notReady.length > 0
      ? el("p", { class: "turn-note" }, `Waiting on: ${notReady.map((p) => p.nickname).join(", ")}`)
      : null,
    readyBtn,
    leaveBtn,
  ];

  if (isHost) {
    children.push(
      el(
        "button",
        {
          disabled: !everyoneReady,
          onclick: async () => {
            try {
              await api(`/rooms/${code}/start`, session);
              refreshNow();
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
            stopPolling();
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
            await api(`/rooms/${code}/roll`, session);
            refreshNow();
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
                  await api(`/rooms/${code}/place`, { ...session, value });
                  refreshNow();
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

route();
