# Your harness

Rules the agent holds itself to while building this app. See `PLAN.md` for
what's being built and why; this file is the how.

## Server authority

The server is the only source of truth for anything that must be fair or
consistent across players:

- **Randomness.** Dice rolls and deck shuffling happen server-side, using
  the server's own RNG. The client never generates a result and sends it
  up to be recorded.
- **Identity.** Every state-changing request carries a player id and their
  `session_secret`. The server checks the secret matches that player in
  that room before doing anything else. A mismatch is rejected, not
  logged as a soft warning.
- **Turn and phase.** Every action (roll, place) is checked against whose
  turn it is and what phase the room is in before it's allowed. "The
  client's UI happened to only show the button to the right player" is not
  a control — the server re-checks regardless of what the client sent or
  omitted.

## Transactions

A single player action (join, start, roll, place, a casino's settlement)
updates the room's state **and** appends to its event log in one database
transaction. Never split these across two writes — a crash or a
concurrent request between them must not be able to leave an event logged
with no matching state change, or vice versa.

## Idempotency

Duplicate requests happen — a doubled click, a retried fetch after a
flaky connection. None of the following may be applied twice from one
logical action:

- a dice roll
- a placement
- a casino settlement

The concrete mechanism: state carries a version/sequence number; a
write is only applied if the request's expected version matches the
room's current version at commit time, inside the same transaction as the
write itself (an optimistic-concurrency check, not a client-side
debounce — the client can still double-send, the server must still only
apply it once).

## What a public response may never contain

- `session_secret`, for any player, ever — not even the requesting
  player's own, in case a response is ever logged or cached somewhere it
  shouldn't be.
- The draw pile's future order. Bills already placed on a casino, already
  won by a player, or already returned to the bottom are fine to show;
  what hasn't been drawn yet is not, even though this week's single round
  never actually reshuffles mid-game.

## Identity recovery

A returning player is recognized by a `session_secret` held in their own
browser's storage. There is no account, no email, no recovery path if
that storage is cleared or the game is opened on a different device — the
UI says this plainly rather than implying a recovery option that doesn't
exist.

## Scope discipline

No chat, no matchmaking beyond a single room's own link/code, no AI
player, no neutral white-dice variant, no more than one round, no
sub-second real-time sync. These are explicitly deferred to the final
project (see `PLAN.md`) — do not build ahead of what crit 8 asks for.

## Presence: heartbeat, not unload

A player's "connected" status is a heartbeat the client sends every few
seconds while the page is open — never the browser's `unload` or
`beforeunload` event. Those events are unreliable (don't fire on a
crash, a killed tab, a phone's OS reclaiming the page) and firing a
"leave" directly from one conflates "the page is closing" with "the
player is gone", which aren't the same thing — a refresh also closes the
page. The server decides someone's gone by the *absence* of heartbeats
for long enough, never by a client-side close signal.

Heartbeats land in their own table (`src/presence.ts`), never inside the
versioned `rooms.state_json` blob. A heartbeat every few seconds per
player would otherwise collide with that blob's optimistic-concurrency
version check on every other real action — the same version column that
makes idempotency work above would instead make a heartbeat and a game
action spuriously conflict with each other.

## The lobby disconnect grace is evaluated lazily

There is no background timer sweeping rooms for stale players. The grace
period (and the shorter "connected" threshold) are both checked fresh,
every time, as "now minus last heartbeat" — on every read of a room's
state and before every action on it. This isn't just simpler: it's the
only version that's correct under Fly's `auto_stop_machines`, where the
whole process (and any timer it was running) stops existing when nobody's
asking. A purely time-based check gets the right answer whether one
second or one day has passed since anyone last looked.

This sweep only ever touches a room still in its lobby phase. A game
that has already started keeps its original disconnect-tolerant policy
unchanged: no auto-removal, no auto-skip, ever — ties are between a
*lobby* seat being held or released and a *round in progress* never
losing a player, and the two must not be allowed to blur together.

## Ready-gating is a server check, not a disabled button

`startGame` itself verifies every player is both `ready` and currently
connected (by heartbeat, not by their own say-so) before allowing a
start — the client disabling its own Start button is UX, not the
control. A disconnected player's stale `ready: true` must never be
enough on its own.

## A closed room is a state, not an error

Once a room closes (its last player left, or the host disbanded it),
`rooms.closed_at` is set once and never unset. `GET /state` on a closed
room still answers 200 with `closed: true` — closed is something a
viewer (including an old invite link) should be able to see plainly, not
something that looks like a broken link or a typo'd code. Every
*mutating* action on a closed room, by contrast, refuses outright (410
`room_closed`), distinct from 404 `room_not_found` (a code that was
never real) — a client needs to tell those two apart to show the right
message.

## Destructive room actions require an explicit confirm

Disbanding a room ends it for everyone with no undo. The server requires
a literal `confirm: true` in the request body — a bare POST (a stray
retry, a script, a misclick that somehow skips the client's own confirm
dialog) must not be able to destroy a room. The client-side confirmation
dialog is a courtesy; the server's check is the actual control.

## Routing goes through one dispatcher

The client has exactly one function (`route()`) that decides what to
render, driven by the current URL and invoked on every `popstate` as
well as on load. Anything that changes what should be on screen —
creating a room, joining, an explicit "back to home" button — changes
the URL (`pushState`) and calls `route()`, rather than directly
rendering a view inline. A one-off `history.replaceState` call with no
`popstate` listener is how the previous version silently broke the
browser's own back/forward buttons; don't reintroduce that shape.
