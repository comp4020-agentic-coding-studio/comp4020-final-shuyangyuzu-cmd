// Client for the Vegas-dice-game prototype. Plain JS, no framework, no
// build step — matches src/server.ts's "run it directly" approach.
// Functional, not visually finished: the spec (crit 8) explicitly says
// "the feature list... and the polish can all wait", and the visual
// identity (product decision 5 in PLAN.md) is the student's own call to
// design, not this MVP's.

const COLORS = ["red", "blue", "green", "yellow"];
const POLL_MS = 1500;

const root = document.getElementById("app");
const params = new URLSearchParams(location.search);
const roomFromUrl = params.get("room");

function storageKey(code) {
  return `vegas:${code.toUpperCase()}`;
}

function loadSession(code) {
  try {
    const raw = localStorage.getItem(storageKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // private window, cleared storage, etc. — fall through to join
  }
}

function saveSession(code, session) {
  try {
    localStorage.setItem(storageKey(code), JSON.stringify(session));
  } catch {
    // Storage may be unavailable (private window, quota); the game still
    // works for this tab, it just can't survive a reload. Not fatal.
  }
}

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

// ---- Entry form (create or join) -----------------------------------

function entryView(initialCode) {
  let mode = initialCode ? "join" : "choose";
  let selectedColor = COLORS[0];
  let nicknameValue = ""; // survives a mode switch (e.g. "Join instead"), unlike a rebuilt <input>'s own value

  function build() {
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
          // Update the selection in place, rather than calling build()
          // (a full form rebuild) — build() creates fresh input
          // elements, which would silently wipe whatever the player had
          // already typed into the nickname field.
          selectedColor = c;
          swatchButtons.forEach((btn, i) => btn.classList.toggle("selected", COLORS[i] === selectedColor));
        },
      }),
    );
    const colorPicker = el("div", { class: "colors" }, swatchButtons);

    const onSubmit = async (e) => {
      e.preventDefault();
      const nickname = nicknameInput.value.trim();
      if (!nickname) return;
      try {
        if (mode === "choose" || mode === "create") {
          const session = await api("/rooms", { nickname, color: selectedColor });
          saveSession(session.code, session);
          history.replaceState(null, "", `?room=${session.code}`);
          enterRoom(session.code);
        } else {
          const code = initialCode.toUpperCase();
          const session = await api(`/rooms/${code}/join`, { nickname, color: selectedColor });
          saveSession(code, session);
          enterRoom(code);
        }
      } catch (err) {
        showError(err);
      }
    };

    const form = el("form", { onsubmit: onSubmit }, [
      el("h2", {}, mode === "join" ? `Join room ${initialCode?.toUpperCase() ?? ""}` : "Start a table"),
      nicknameInput,
      colorPicker,
      el("button", { type: "submit" }, mode === "join" ? "Join" : "Create room"),
    ]);

    const switcher =
      mode === "choose"
        ? el("p", {}, [
            "Have a room code? ",
            el("a", { href: "#", onclick: (e) => { e.preventDefault(); mode = "join-code"; initialCode = ""; build(); } }, "Join instead"),
          ])
        : null;

    const codeField =
      mode === "join-code"
        ? el("input", {
            type: "text",
            placeholder: "Room code (6 characters)",
            maxlength: "6",
            oninput: (e) => {
              initialCode = e.target.value;
            },
          })
        : null;
    if (codeField) form.insertBefore(codeField, form.firstChild.nextSibling);

    const errorBox = el("p", { class: "error", id: "entry-error" });

    render(
      el("div", { class: "entry" }, [
        el("h1", {}, "Vegas"),
        el("p", { class: "note" }, [
          "Built for a handful of friends sitting around one table, each on ",
          "their own phone — not for matchmaking with strangers.",
        ]),
        form,
        errorBox,
        switcher,
      ].filter(Boolean)),
    );
  }

  function showError(err) {
    const box = document.getElementById("entry-error");
    if (box) box.textContent = err.message ?? "something went wrong";
  }

  build();
}

// ---- Table / lobby view ---------------------------------------------

function enterRoom(code) {
  const session = loadSession(code);
  if (!session) {
    entryView(code);
    return;
  }
  // Confirm the stored session is still valid before committing to it —
  // a cleared/rotated secret should fall back to the join form, not a
  // silent dead end (CLAUDE.md: identity recovery is browser-local and
  // has no fallback once that's gone; the UI says so, it doesn't hide it).
  api(`/rooms/${code}/rejoin`, session)
    .then(() => startPolling(code, session))
    .catch(() => {
      render(
        el("div", { class: "entry" }, [
          el("h1", {}, "Vegas"),
          el("p", { class: "error" }, "This browser's saved seat for this room no longer works (cleared data, or a different device). There's no way to recover it — ask the host for a fresh invite if the room hasn't started yet."),
        ]),
      );
    });
}

let pollHandle = null;

function startPolling(code, session) {
  if (pollHandle) clearInterval(pollHandle);
  const tick = () => getState(code).then((state) => renderTable(code, session, state)).catch(() => {});
  tick();
  pollHandle = setInterval(tick, POLL_MS);
}

function renderTable(code, session, state) {
  const me = state.players.find((p) => p.id === session.playerId);
  const isHost = state.hostPlayerId === session.playerId;
  const isMyTurn = state.currentPlayerId === session.playerId;

  const shareLink = `${location.origin}/?room=${code}`;

  const header = el("header", {}, [
    el("h1", {}, "Vegas"),
    el("p", {}, [
      "Room ",
      el("strong", {}, code),
      " — ",
      el("a", { href: shareLink, onclick: (e) => { e.preventDefault(); navigator.clipboard?.writeText(shareLink); e.target.textContent = "copied!"; } }, "copy invite link"),
    ]),
  ]);

  const playerList = el(
    "ul",
    { class: "players" },
    state.players.map((p) =>
      el("li", { class: p.id === state.currentPlayerId ? "current-turn" : "" }, [
        el("span", { class: `swatch ${p.color}` }),
        `${p.nickname}${p.id === state.hostPlayerId ? " (host)" : ""} — ${p.diceInHand} dice — $${p.moneyTotal.toLocaleString()}`,
      ]),
    ),
  );

  let body;
  if (state.phase === "lobby") {
    body = el("div", {}, [
      el("p", {}, `Waiting for players (${state.players.length}/4). Need at least 2 to start.`),
      isHost
        ? el("button", {
            disabled: state.players.length < 2 ? "" : null,
            onclick: async () => {
              try {
                await api(`/rooms/${code}/start`, session);
              } catch (err) {
                alert(err.message);
              }
            },
          }, "Start game")
        : el("p", {}, "Waiting for the host to start."),
    ]);
  } else if (state.phase === "round_end") {
    body = el("div", {}, [
      el("h2", {}, "Round over"),
      el("p", {}, "Final money totals are shown above. Thanks for playing!"),
    ]);
  } else {
    body = el("div", {}, [
      casinoTable(state),
      turnControls(code, session, state, isMyTurn),
    ]);
  }

  const notes = el("details", { class: "notes" }, [
    el("summary", {}, "About this version"),
    el("p", {}, "Winnings are shown openly to everyone here, continuously — unlike the physical board game, where they're kept face-down and hidden until the end. A deliberate choice for a shared, multi-phone table."),
    el("p", {}, "Your seat is tied to this browser's storage. Clearing site data, or opening the game on a different device, loses it with no way back."),
  ]);

  render(el("div", { class: "table" }, [header, playerList, body, notes]));
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
    return el("button", {
      onclick: async () => {
        try {
          await api(`/rooms/${code}/roll`, session);
        } catch (err) {
          alert(err.message);
        }
      },
    }, "Roll");
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
          el("button", {
            onclick: async () => {
              try {
                await api(`/rooms/${code}/place`, { ...session, value });
              } catch (err) {
                alert(err.message);
              }
            },
          }, `Place all ${count}×${value}`),
        ),
      ),
    ]);
  }

  return el("p", {}, "…");
}

// ---- Boot -------------------------------------------------------------

(function init() {
  if (roomFromUrl) {
    const session = loadSession(roomFromUrl);
    if (session) {
      enterRoom(roomFromUrl.toUpperCase());
      return;
    }
    entryView(roomFromUrl);
    return;
  }
  entryView(null);
})();
