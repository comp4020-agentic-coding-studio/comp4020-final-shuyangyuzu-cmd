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
player, no neutral white-dice variant, no more than one round. These
remain explicitly deferred (see `PLAN.md`) — do not build ahead of what
the current crit asks for.

Sub-second real-time sync — listed here as deferred all the way through
Crit 8 — is Crit 9's own explicit requirement instead: a change one
person makes must reach every other open session in about a second, with
no reload. See `PLAN.md`'s Crit 9 section for what was actually built
(the transport decision, the architecture, what was measured) and the
section immediately below for the authority rule that transport has to
follow. This is the one deferred item in this file ever superseded by a
later crit's own spec; it's recorded here as a deliberate edit, not left
as a silent contradiction with the paragraph above.

## Real-time push is a transport, not a new authority

SSE (`src/live.ts`, `GET /api/rooms/:code/events`, `GET /api/bar/events`)
only ever carries server-computed public state *outward*. No client ever
writes anything over it, and no server-authority rule above is relaxed
for it — every state-changing request still arrives as its own
authenticated POST, checked exactly as it was before this transport
existed; the push channel just broadcasts what that request's own
transaction already committed, to everyone else who's watching.

Staleness is resolved by a monotonic sequence number, not arrival order —
but **not** the game room's `rooms.version` column. An earlier version of
this file said a room channel reused `version` directly; an independent
review (Crit 9 phase 7) corrected that: `version` is also idempotency's
own optimistic-concurrency counter, and a presence-only change (a
`connected` flag flipping, a lobby seat finally swept — see the next
section) must never bump it, or it would make an unrelated roll/place
race against a heartbeat. Each channel instead has its own push-revision,
scoped separately from any DB column, both living in `src/live.ts`: a
room gets its own in-memory `rev` per room code (`currentRoomRev`/
`bumpRoomRev`); the bar — which has no single versioned row at all, since
its state is many independently-updated player rows — gets a single
`seq` the same way it always has. `version` is still present in a room's
public payload (game actions still use it internally for their own
optimistic-concurrency write), but a client's own staleness gate reads
`rev`, never `version`.

Every receiver (a stream push, a mutating action's own response, a
fallback poll, a post-reconnect fetch) goes through the same rule: apply
a payload only if it's strictly newer than the last one actually
applied, otherwise discard it — see `shouldApplyLiveUpdate` in
`src/live.ts` for the exact, unit-tested contract both clients implement
identically. This is what keeps a late-arriving stale response, or two
near-simultaneous updates racing each other, from ever regressing what's
on screen, **within one server generation**.

**Across a restart, a sequence number alone is not enough — this was a
real bug, not a hypothetical.** Every counter above is in-memory and
resets to 0 when the process restarts; a browser tab that kept a page
open across that restart still holds whatever high-water `rev`/`seq` it
last saw. A bare "incoming <= last-seen, discard" rule then rejects
*every* payload the restarted process ever sends — a fresh fetch forced
by reconnecting doesn't help, because that fresh fetch still carries the
new process's own low number and still goes through the exact same
filter. (An earlier version of this file claimed the reconnect-forced
fetch alone made recovery work; an independent review reproduced the
rejection directly and found that claim false — see PLAN.md's Crit 9
phase 7 entry for the repro.) The fix: `src/live.ts` exports a
`SERVER_EPOCH`, set once when the process starts, carried in every
payload alongside its `rev`/`seq`. A client tracks `(epoch, rev)` as one
cursor: a strictly newer epoch always wins and resets the `rev` baseline
unconditionally (a restarted process's rev legitimately restarts at 0);
a strictly older epoch never wins, even arriving after a newer one was
already applied (a late response from, or a queued frame on a connection
to, a process that's since died); within the same epoch, the original
strictly-newer-wins rule applies unchanged.

A dropped connection is never trusted to have delivered everything that
happened while it was down. `EventSource`'s own `onopen` (which fires on
the initial connect *and* every automatic reconnect) and a
`visibilitychange`/`focus` handler both force one unconditional fresh
fetch of the current state — this resyncs anything missed *within* a
server generation; surviving an actual restart is the epoch mechanism
above, not this fetch on its own.

There is no separate "connection id" or "request generation" concept
beyond `(epoch, rev/seq)` — a follow-up review asked this directly, since
`incoming.epoch !== current.epoch` alone says nothing about *direction*
and a careless implementation of that shape would wrongly accept a late,
*older*-epoch arrival as if it were newer. The actual rule compares
`incoming.epoch > current.epoch` explicitly, never a bare inequality; see
`shouldApplyLiveUpdate`'s doc comment in `src/live.ts` (and the identical
`public/liveSync.js`, the one client-side copy both `app.js` and
`tavern.js` call — not two independently hand-written gates, after a
review pointed out that two copies individually matching the same test
suite isn't the same guarantee as one shared implementation). Within one
epoch, the server's own `rev`/`seq` is already a total order over every
mutation and presence tick in that generation, independent of which
specific `EventSource` connection or HTTP request happened to deliver a
given payload — there is nothing an extra per-connection identifier would
catch that the plain sequence comparison doesn't already catch on its
own.

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

**A lazily-evaluated condition still needs something to push it to an
already-open viewer.** The grace period's condition itself stays exactly
as described above — "now minus last heartbeat", recomputed fresh on
every read, never cached, never swept by a background mutation timer.
But Crit 9's SSE push (see the section above) meant a viewer could be
sitting on an already-open connection with nobody ever calling an
endpoint again: nobody heartbeats, nobody acts, so nothing was left to
*notice* the condition had become true and broadcast it — an independent
review caught this directly (reproducing both a `connected` flag never
flipping to false on an open page, and a swept lobby seat never reaching
one, with `PRESENCE_STALE_MS` turned down for the repro). The fix is a
short interval in `src/server.ts` that, only for a room or the bar
channel someone currently has open (`live.subscribedRoomCodes()` /
`live.hasBarSubscribers()` — never an unwatched one), re-runs the exact
same `rooms.getPublicState` read a GET already makes, diffs the
presence-derived slice of it against the last thing actually broadcast,
and republishes only on an actual change. This is not a new background
*mutation* sweep: it never does anything a direct read wouldn't already
have decided to do on its own, it touches the DB only for a channel with
a live viewer, and it does nothing at all while nobody's connected —
which is what keeps it compatible with Fly's `auto_stop_machines` (an
asleep machine has no open SSE connections, so the interval's own check
is a no-op until a real request wakes it the normal way). The same
heartbeat endpoint that refreshes someone's own presence also triggers
one immediate recheck, so "they're back" reaches everyone else right
away rather than waiting for the next tick.

## Four leave/exit states, not one "disconnected" bucket

A patron's relationship to a table they're bound to is one of four
states, each with its own server-checked condition — found necessary
after a reported bug where "Return to your game" and a stale table status
both blurred these together (see PLAN.md's product-direction-update
entry for the two concrete bugs this caused and their fixes):

1. **Refresh / brief reconnect.** The heartbeat resumes within seconds.
   Never treated as a leave of any kind — unchanged from the original
   presence design above.
2. **Away from the table (not away from the bar).** Explicitly returning
   to the bar view, or standing up from a physical seat, while a game is
   still bound to that table. Starts a **2-minute** grace scoped to that
   *table binding* specifically — independent of `LOBBY_GRACE_MS` (which
   governs the lobby *seat*, pre-start) and independent of how long a
   player takes on their own turn (idle-but-present during your own turn
   is not an away-from-table event — this clock starts on physically
   leaving the table, not on inactivity). Returning within the window
   resumes the exact same binding; past it, the departure is treated as
   state 3 or 4 below, whichever the room's current phase calls for.
3. **Explicit "Exit game."** Immediate, same tick, no grace. Pre-start,
   this releases the lobby seat outright (the existing `leaveRoom`).
   Once a game has started, it must never silently drop dice, skip a
   settlement, or stall the turn order — the seat is hard-exited by the
   human but kept alive under NPC control instead (see "A departed
   human's started-game seat...” below).
4. **True disconnect.** The heartbeat itself stops (closed tab, crashed
   device, killed process) — detected the same lazy, read-time way as
   always, never a new background timer. Pre-start, this is the existing
   `LOBBY_GRACE_MS` sweep. Once a game has started, the existing policy
   stands: a game in progress never force-ends on a human's account. What
   happens to that seat once it's been away long enough is the *same*
   2-minute away-from-table clock from state 2 — there is no separate,
   second timer for "truly gone" versus "walked away and never came
   back"; both end up at the identical threshold and the identical
   outcome.

**A departed human's started-game seat is handed to NPC control, never
deleted.** Once a seat crosses into state 3 (post-start) or state 4's
2-minute threshold, its existing dice, winnings, and position in the turn
order are kept exactly as they were; the seat's `controller` flips from
`"human"` to `"npc"` and the original player's session simply stops being
consulted for it from then on — there is no path back. This is what makes
state 3/4 safe to apply to a game already in progress without violating
"never deletes dice, skips a settlement, or stalls a turn": the seat
keeps playing, just not under that person's control anymore.

**How the 2-minute clock is actually implemented**: a new `table_departures`
table (one row per bar identity currently away from a table binding it
still holds), deliberately separate from both `bar_presence` (a heartbeat
timestamp, a different signal) and `rooms.state_json` (a frequently-
changing clock has no business inside the versioned game blob any more
than a heartbeat does — the same reasoning presence already established).
Two triggers start or refresh it: sitting at a real seat (`src/bar.ts`'s
`sitAtSeat`) while still bound to a table, and an explicit "back to the
bar" navigation (`public/app.js`'s `backToHomeButton`, a best-effort
fire-and-forget POST to `/api/bar/depart`).

**Only one thing clears it, and a passive connection is never enough to
be that thing.** A follow-up review caught a real bug in the first
version of this: room `heartbeat`/`rejoin` succeeding were wired to clear
a pending departure, reasoned as "I'm actually back, engaging with the
game again." That's wrong — both fire automatically for as long as a
room view/tab is open, including one left open in the background while
that same identity's bar avatar is sitting at a completely different
seat. A browser being connected proves the browser is connected, nothing
about where the person actually is. The fix: clearing a departure now
requires one explicit, deliberate bar-world action —
`src/tables.ts`'s `resumeActiveTable`, called from `public/tavern.js`
right before navigating back into a table's room (the "Return to your
game" button, and the table dialog's own join/create success path) —
never from a passive signal. Reproduced and verified directly: an old
room tab kept heartbeating for several cycles while the character sat at
a real seat, and the departure was still there, unmoved, confirming the
fix (`spec/tableDeparture.test.ts`).

Enforcement (`src/tables.ts`'s `enforceExpiredDepartures`) runs on the
same short interval as the presence ticker above, gated the same way
(only while something's actually watching bar or room channels) — a
lobby-phase expiry reuses `rooms.leaveRoom` exactly as a voluntary leave
would (host transfer, room close, unchanged); a started game calls
`rooms.handoffToNpc` instead, which flips `controller` to `"npc"`.

**A handed-off seat's turns are actually taken, not just flagged.**
`src/server.ts`'s scheduler (same ticker, same "only while watched" gate)
notices when the room's current player is NPC-controlled and, after a
short display pause (`NPC_TURN_DELAY_MS`), calls `rooms.npcRoll` or
`rooms.npcPlace` — the same `applyRoll`/`applyPlacement` engine a human's
turn already uses, choosing only among values already rolled
(`src/npc.ts`'s `chooseNpcPlacement`, the most-frequent value, ties
broken low — never future deck order, never a rule a human couldn't also
follow). Both functions are idempotent (a second call against state
that's already moved past the phase they'd act on is a silent no-op),
which is what keeps "never double-execute a turn" true even if the
scheduler's own in-memory in-flight guard were ever bypassed by a
restart mid-wait. `rooms.roll`/`rooms.place` separately refuse any call
for a seat whose `controller` has become `"npc"`, even from the original
human's still-valid session — the ordinary "is it your turn" check alone
doesn't catch this, since the handed-off seat's id can still legitimately
be `currentPlayerId` when it's genuinely that seat's turn.

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

**Real dining/stool seats (`bar_seats`, Crit 9 phase 8)** follow the exact
same pattern: seeded once from `src/barLayout.ts`'s `BAR_SEATS` (computed
from the furniture layout, never hand-typed coordinates), never created
or deleted at runtime — only `occupied_by` changes. Each seat's tile is
an ordinary, already-walkable floor tile next to its furniture, so
sitting never needs a walkability exception: the server requires a
patron to actually be standing on that exact tile before accepting
`sit`, the same adjacent-step movement validates getting there as
anywhere else. A game table's own 4 chairs are deliberately **not**
`bar_seats` rows — sitting there is already being seat-index 0-3 in that
room's own player roster, a different, pre-existing occupancy concept
that a second one would only duplicate.

## A patron holds at most one open table at a time

Enforced server-side on the bar identity, the same way every other rule
in this file is: starting or joining a different table while already
seated at an open one is refused outright, not just hidden by the
client's own UI. Switching tables requires the existing `/leave` first.
A pending join request (below) counts as "holding" a table for this rule
exactly the same as an actual seat does — one table at a time means one
table at a time, whether seated or just waiting to be.

## Joining an online table that already has a host is a request, not a seat

Only the first person to open an *empty* table is seated immediately, as
its host (product decision, unchanged). Everyone after that submits a
request (`rooms.requestJoin`) that the host explicitly approves or
declines from the room's own lobby view — never an automatic seat. A
pending request gets a real session the moment it's made (so the
requester can watch the same public room stream everyone else does and
learn their own request's fate by id), but it is **not** a `Player`:
it never counts toward `MAX_PLAYERS`, never appears in `turnOrder`, and
never shows as seated — `rooms.ts` keeps it in its own
`pendingRequests` list, checked separately everywhere a player list is
checked. Approval re-runs the exact same capacity and color checks a
direct join already ran, inside the same version-gated transaction every
other mutation uses — approving two requests for the last seat (or the
same color) races exactly like two simultaneous joins already do today:
deterministic, one wins, the other gets an ordinary refusal. A declined
or cancelled request's session is deleted outright, not left dangling; an
abandoned one (nobody acts on it) expires through the same lazy lobby-
disconnect-grace sweep a stale seat already uses, reusing `LOBBY_GRACE_MS`
rather than inventing a second threshold.

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
