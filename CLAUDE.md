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

## A schema change needs a real migration, not just a wider CREATE TABLE

`CREATE TABLE IF NOT EXISTS` only helps a table that doesn't exist yet.
Against the real, already-deployed Fly volume, every table from the
first deploy already exists — adding a column to that `CREATE TABLE`
statement changes what a *fresh* database looks like and does nothing
to the one actually running in production. Every new column goes
through `addColumnIfMissing` (`src/db.ts`), checked with `PRAGMA
table_info` first. And because every local test defaults to a fresh
database (`rm -rf data` first), a schema change needs its own test
built against a database in the *previous* shape by hand — see
`spec/db-migration.test.ts` — not just the rest of the suite passing,
which proves nothing about this specific failure mode.

## Every response sets Cache-Control, deliberately

A browser can serve `app.js`, `index.html`, or `styles.css` straight
from its own disk cache on an ordinary reload with no request ever
reaching the server at all — found the hard way: a deploy can be live,
byte-identical to source, and fully verified by every automated check
(which always start from an empty cache), while a real returning
player's browser still shows what it cached from before. Every response
carries `Cache-Control: no-cache` — not `no-store` — so a browser can
still keep a copy but must revalidate with the server before using it.

## The bar is a separate identity layer, never merged with a game room's

A bar identity (nickname/color/position in the shared tavern) and a game
room's player record are different things, with different tables and
different session secrets, even though both follow the same "secret in
localStorage + heartbeat presence + lazy sweep" shape. Being present in
the bar never implies being seated at any table's game, and vice versa.
This separation exists specifically so nothing about the already-verified
room/session/ready/leave/disband logic has to change, or risk breaking,
to make room for the bar — if a refactor would require touching
`rooms`/`sessions`/`presence`/`events`' existing shape to fit the bar in,
that's the wrong design; add new tables instead.

## Furniture is fixed; it is never created or deleted at runtime

A physical table (a Vegas table, or a reserved Texas/dominoes/blackjack
slot) and a bar seat are fixtures, seeded once and permanent. What
changes at runtime is only which game room (if any) a table currently
points at, or which patron (if any) occupies a seat — never the fixture
rows themselves. A finished, disbanded, or abandoned game room is never
deleted and never overwritten; a table whose game ends just has its
pointer cleared, and the next game started there is a new room row.

## A patron holds at most one open table at a time

Enforced server-side on the bar identity, the same way every other rule
in this file is: starting or joining a different table while already
seated at an open one is refused outright, not just hidden by the
client's own UI. Switching tables requires the existing `/leave` first.

## Movement is server-validated; the client may plan a path

A move request names a destination tile; the server confirms it is adjacent
and walkable, without trusting a client-reported starting position. The
user's 6 October spatial-interface direction supersedes the original
one-click-per-step constraint: the client may find a path to a clicked
destination, but submits and awaits each legal step individually. Camera
coordinates must never be sent as world coordinates. Keyboard and touch
controls share these same movement checks.

## The bar is a full-screen world, with a following camera

The entry flow is a floating character editor over the visible map, with
independent clothing color and skin-tone selection and a live sprite preview.
Joining goes directly into the map. The canvas viewport follows the patron;
it never shrinks the whole world into a webpage card. Furniture coordinates
come from `/api/bar/layout`, the same definition the server checks. The old
game forms are reachable from a secondary overlay, not stacked under the map.
Persist skin tone through an additive migration that preserves old identities.
Include every client module in the version hash and in versioned resource URLs.

## A direction-hold control must stop cleanly, by default

A press-and-hold movement control (the on-screen d-pad) keeps stepping
only while the triggering pointer is actually still down on it. Every
way that stops being true — pointer released anywhere (not just on the
button), pointer cancelled, pointer leaves the button, the window loses
focus, the document is hidden (tab/app switch) — must stop the hold.
Getting this list right matters more than the stepping logic itself: a
hold that silently keeps going after the finger has left is the failure
mode that actually matters here, so default to adding another stop
condition rather than assuming the common ones are enough. A plain tap
(no hold) still takes exactly one step. Listeners bound for a hold are
removed on navigation/unmount, not left attached to a detached button.

Automated event-simulated tests (jsdom, synthetic pointer events) are
not a substitute for checking this on a real touchscreen — they prove
the listener wiring is correct, not that a physical long-press behaves
right on an actual phone. Don't report this behavior as device-verified
until someone has actually held a finger on it.

## Visual assets: original or clearly licensed, never copied

The bar's tiles and sprites are either drawn in code or hand-authored and
committed to the repo — not lifted from Stardew Valley, Gather, Red Dead
Redemption 2, or any other reference, which are inspirations for the
*spatial language and atmosphere*, not asset sources. Any external asset
would need a stated, checked licence and a recorded source in the repo;
absent that, the default is draw-it-ourselves.

## Routing goes through one dispatcher

The client has exactly one function (`route()`) that decides what to
render, driven by the current URL and invoked on every `popstate` as
well as on load. Anything that changes what should be on screen —
creating a room, joining, an explicit "back to home" button — changes
the URL (`pushState`) and calls `route()`, rather than directly
rendering a view inline. A one-off `history.replaceState` call with no
`popstate` listener is how the previous version silently broke the
browser's own back/forward buttons; don't reintroduce that shape.
