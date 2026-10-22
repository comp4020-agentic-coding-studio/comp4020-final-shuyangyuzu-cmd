# Your harness

Rules the agent holds itself to while building this app. See `PLAN.md` for
what's being built and why; this file is the how.

## Mixology book

The counter's recipe assistant is browser-local planning, separate from games and the paused food-ordering module. Never send pantry/party lists over public SSE or change chips, room state or orders when a recipe is selected. Keep source links and adaptation notes with each recipe. Unmeasured top-ups need visible estimate labels; do not present house quantities as official IBA values. Scale from each recipe's source yield (Cornhusker Crush serves two), sum only compatible units, and exclude optional garnish/ice from required-ingredient matching. Pantry availability must never imply stock quantities. Clipboard/storage failures need honest feedback. The module must participate in the deployed asset hash; modal opening stops held movement and route disposal closes it.

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

## A terminal-facing log line is held to the same transaction honesty as the DB event it accompanies

Crit 10's own server-side action log (`src/actionLog.ts`, `flyctl logs`)
sits beside the SQLite `events` table this section already governs, and
is held to the identical rule: a "success" line reaches stdout if and
only if the write it describes actually committed. `console.log` itself
has no rollback — once called, the line is out — so this can never be
achieved by placing the log call inside a `db.transaction()` callback and
reasoning "a throw rolls the whole callback back together." That
reasoning is incomplete the moment one transaction is nested inside
another (`src/tables.ts`'s `createTableRoom` calling `rooms.createRoom`,
which has its own transaction — real production nesting, not a
hypothetical): better-sqlite3 commits a nested call's own SAVEPOINT
immediately on its own successful return, before the outer transaction
has decided anything — a log call made at that point has already printed
by the time an unrelated failure later rolls the *outer* transaction
back. This was a real bug, caught by an independent review and
reproduced directly (`spec/actionLog.test.ts`): a deliberately-failing
outer transaction around `createRoom` left zero room rows but one
`"outcome":"ok"` log line.

The fix is not "move the log call later" — any call-site-local fix
reintroduces the same bug the next time a function gets called from
inside someone else's transaction, which is exactly the shape nobody
can fully audit for by reading each call site in isolation. The actual
fix patches `db.transaction` itself, once, in `src/db.ts`'s `openDb`
(`installTransactionLogging`): every transaction on that connection,
however it's invoked — through the `transact()` convenience wrapper or a
raw `db.transaction(fn)()` — gets this handled automatically, regardless
of which function happens to call which other function inside a
transaction, rather than depending on every call site remembering to
opt in.

**A single flat buffer per database connection is not enough, and was
itself a second real bug** (also caught by independent review, also
reproduced directly before being fixed): an inner transaction's own
SAVEPOINT can roll back while the *outer* transaction catches that
failure and recovers, going on to commit something else for real. With
one flat buffer, the inner call's own "ok" entry and the outer call's
own later, genuinely-successful entry have nothing distinguishing
them — the outer commit flushes both, even though the inner
transaction's own row never existed once its own SAVEPOINT rolled back.
The actual mechanism is a **stack** of buffers, one per currently-open
transaction level: entering a transaction (at any depth) pushes a fresh
buffer onto the stack for that level specifically; that level's own
rollback pops and discards *only its own* buffer, leaving every
enclosing level's own, already-buffered entries untouched; that level's
own commit pops its buffer and merges it into whichever buffer is now on
top of the stack (the next level out) — rising with that enclosing
transaction's own fate from here on, exactly mirroring how the level's
own SAVEPOINT/RELEASE just became part of the enclosing transaction's
still-open unit of work in SQLite itself. Only the truly outermost
level's own commit — when the stack for that db becomes empty — actually
prints anything to stdout.

A rejection's own `verified` field carries the identical "real evidence,
not inference" standard: it is set `true` only when `requireSession`
(`src/rooms.ts`) or `requireBarSession` (`src/bar.ts`) actually ran and
passed for the request being logged — never inferred afterward from
whatever error code the eventual rejection happens to carry. An earlier
version of this inferred `verified` from `error.code !== "unauthorized"`,
which was wrong: most mutations in `src/rooms.ts` reach `loadOpenRoom`
(which can throw `room_not_found`/`room_closed`) *before* calling
`requireSession` at all, so a request that never got anywhere near a
session check was still logged as `verified: true`. The actual
mechanism (`src/actionLog.ts`'s `runWithVerificationTracking`/
`markIdentityVerified`/`wasIdentityVerified`, backed by
`AsyncLocalStorage` so it survives the `await` boundaries Hono's own
handlers already have, without racing a concurrent request) records the
real fact the instant a check actually passes, and reads that fact back
— never a guess — when a rejection needs logging.

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
- The draw pile's future order, including notes returned to its bottom.
  Casino bills and round payouts are public. Cumulative winnings and
  won-banknote lists are private until `game_end`: public HTTP/SSE state
  must return null for every player's bank, including the requester.
  The authenticated own-winnings endpoint returns only that seated
  human's bank; the client merges it into its own view, never a broadcast.

## Identity recovery

A returning player is recognized by a `session_secret` held in their own
browser's storage. There is no account, no email, no recovery path if
that storage is cleared or the game is opened on a different device — the
UI says this plainly rather than implying a recovery option that doesn't
exist.

## Scope discipline

The original Crit 8 scope deferred chat, NPCs and multiple rounds.
Later user requests explicitly superseded those deferrals: tavern speech,
NPC games and four-round base games are now implemented. Optional neutral
white dice, Royale modules and matchmaking remain deferred. Do not infer
new game variants from reference images.

Sub-second real-time sync — listed here as deferred all the way through
Crit 8 — is Crit 9's own explicit requirement instead: a change one
person makes must reach every other open session in about a second, with
no reload. See `PLAN.md`'s Crit 9 section for what was actually built
(the transport decision, the architecture, what was measured) and the
section immediately below for the authority rule that transport has to
follow. Later user-directed scope changes are recorded in `PLAN.md` too.

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
an occupiable seat, not ordinary walking floor. The client paths beside
the chair; an authenticated `sit` checks adjacency and occupancy and
moves the patron into the seat atomically. Standing chooses adjacent
unoccupied floor before releasing the seat. Game chairs are **not**
`bar_seats` rows — sitting there is already a seat in that
room's own player roster, a different, pre-existing occupancy concept
that a second one would only duplicate.

## Two game modes, two rows, one architecture each

Crit 9 phase 8's nine-table layout (`src/barLayout.ts`'s `GAME_TABLES`) is
two labelled rows of the same four game types, not one row with a mode
toggle: an **online** row (shared, host-approved — the section above) and
an **NPC** row (solo, instant, never shown as joinable). Only the Vegas
slot is actually playable in either row this round; every other game type
keeps its existing "not yet open" reserved treatment in both rows — a
reserved slot still carries a real `tableMode`, it's just `available:
false`. (An earlier version of this round drew a text banner above each
row naming its mode; the student's own acceptance testing asked for both
removed as a map-decluttering pass, 2026-10-12 — the mode distinction
itself is unchanged and still readable from each table's own label and
its dialog's own copy, just no longer duplicated as floating map text.)
A real bug this phase hit and fixed along the way: the old hardcoded
default-spawn tile once drifted into furniture when a table row moved —
see `src/barLayout.ts`'s `defaultSpawn` comment for the fix (deriving it
from the actual table layout instead of a fixed number).

**A solo NPC table (`startNpcGame`/`createSoloNpcGame`) is architecturally
a different kind of fixture, not an online table with no opponents.** An
online table fixture points at *one* shared room (`tables.current_room_id`)
that every joiner's request targets; an NPC fixture never sets that
pointer at all, because there is no single "the" room for it — every
visitor who clicks it gets their own brand-new private room (1 human
seat, ready, plus the other 3 colors seeded `controller: "npc"`, ready,
with `startGameLogic` run in the same transaction that creates them), and
two different visitors' games never see each other. `getTablesStatus`
special-cases `tableMode === "npc"` to always report `empty`/no occupancy
regardless of how many private games are concurrently running there — the
shared bar view has nothing truthful to say about "how full" a fixture is
whose games aren't shared. Consequently `resolveActiveSeat`
(`src/tables.ts`) cannot resolve "which room is this bar identity's
active game" via the fixture's own pointer the way an online table can;
it instead looks up the identity's own `sessions.room_id` row directly,
which works identically for both fixture kinds. `joinTableRoom` and
`createTableRoom` both reject a `tableMode` mismatch outright (404)
*before* `checkExistingSeat`'s own early return gets a chance to run —
necessary because a visitor who already has an active seat at their own
NPC table would otherwise have that early return silently hand back their
NPC game in response to a call against the ONLINE-table endpoint, instead
of the 404 that endpoint owes a caller for the wrong kind of fixture.

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

## No two patrons occupy the same tile, and "occupied" has one definition

Product-direction-update: a tile is occupied exactly when some *other*,
*currently connected* bar identity's **effective position**
(`src/position.ts`) is there — never a raw, unconditional "someone's row
says this x/y". Checked and written inside one synchronous transaction
everywhere it matters (`src/bar.ts`'s `moveBar`, `joinBar`'s spawn
search, `rejoinBar`'s repair step, `db.ts`'s migration-time relocation),
the same reasoning idempotency's own version check already relies on:
one Node process, one connection, nothing else can run between the check
and the write, so two simultaneous claims on a tile can never both
succeed. "Connected" reuses the bar's own existing presence threshold
(`PRESENCE_STALE_MS`) — a disconnected patron's old tile is *never* a
permanent obstacle, and this is what keeps that true without a second,
bar-specific definition of "gone" to maintain. A returning identity's own
recovery can never fail or collide over this either: `rejoinBar` repairs
a now-invalid stored position (claimed by someone else while this
identity was away, or no longer walkable after a layout change) before
ever reporting it back, the same way a fresh join finds a free tile near
spawn rather than assuming the canonical spawn point is free. Spawn
search itself starts from a small random jitter around that canonical
point, not the exact same tile every time — a burst of simultaneous
joins spreads out instead of packing into one ever-tightening ring.

**Effective position, not a frozen pre-game coordinate.** A bar identity
actively, *presently* seated at a game table (connected, or an NPC seat —
which has no "away" concept — and not mid an away-from-table departure)
is really *at* its real chair tile (`GAME_CHAIRS`), never wherever it
happened to be standing before the table dialog opened. This is one
function (`src/position.ts::effectivePosition`), deliberately a third
module beneath both `bar.ts` and `tables.ts` rather than making either
depend on the other (`tables.ts` already imports `bar.ts` for
`requireBarSession`; a `bar.ts` → `tables.ts` edge would cycle back). It
governs every place position matters uniformly: `getPublicBarState`'s
reported x/y, tile-occupancy checks, click-targeting, and the proximity-
chat trigger below — never a frozen bar coordinate competing with a real
chair tile for what's "true." A departed (away) occupant falls back to
their raw bar coordinate, matching exactly how the existing chair
rendering already stops drawing a body there and shows "away" instead.

**The client mirrors this, not a separate notion of "occupied."**
`public/tavern.js`'s own `occupiedByOther`/`playerAt` read directly from
`state.players[].x/y` — which the server already reports as effective
position — so pathfinding, the dpad/WASD step check, and every click
surface (the canvas itself, a seat-target button, a game-chair button)
agree with the server's own rule without re-deriving it. A path is never
planned through another patron's tile; a destination that becomes
occupied mid-walk is detected and re-planned or abandoned, never walked
through. Clicking an occupied tile never walks into it: `findApproachTile`
picks whichever free, in-bounds, walkable orthogonal neighbour of the
target is closest (Manhattan) to the clicker's own current position —
naturally the side facing them when one exists, and simply the nearest
reachable fallback otherwise — and a short toast explains it when no
neighbour is free at all, never a teleport, never an overlap. A player
click takes priority over the floor, a seat, or a game chair underneath
them, on every click surface that can reach that tile (checked first,
before any furniture-specific logic) — including a present game occupant,
clicked at their real chair tile, same priority as anyone standing on
the open floor. Clicking your own tile is a deliberate no-op.

## Public tavern speech superseded private 1:1 chat (2026-10-12, after the student's own acceptance testing)

Part 3 was originally built as a private, proximity-triggered 1:1 chat
(walk up to someone, open a dialog only the two of you could read). The
student's own manual acceptance testing rejected that shape outright: the
actual requirement is public speech — anyone says something and it shows
as a bubble over their own head, visible to every patron in the bar, no
targeting, no approval step, no dialog at all. This section documents
what replaced what; the design that follows is the one the client
actually implements today.

**Superseded outright, removed from the client entirely:** the private
chat dialog, the proximity trigger and its "walk up to someone, open on
arrival" gesture (`beginApproachAndChat`/`chatChase`), the incoming-
message notification banner, and the recipient-selection concept (there
is no recipient — speech has no addressee). `src/chat.ts`, its
`chat_threads`/`chat_messages` tables, its server routes, and
`src/live.ts`'s `chatInboxSubscribers` registry are all **still present
and still fully functional, unchanged** — deliberately: "已经保存的私聊
记录继续保持原访问权限" (existing private records keep their original
access control) means the data and the checks that gate it were never
touched, only the client's use of them was removed. `requireBarSession`/
`requireThreadAccess` still refuse anyone who isn't an actual participant
exactly as before; nothing about making chat public retroactively exposed
an old private conversation, because old private conversations are a
completely separate code path that the public-speech feature below never
reads from or writes into.

**What carried over unchanged, because it was never chat-specific to
begin with:** clicking a player still walks you to a free adjacent tile
rather than into them (`findApproachTile`, `approachPlayer` — the
original, pre-chat part 2 rule: see "No two patrons occupy the same
tile" above). Tile occupancy, seating, online-table approval, NPC games,
and the disconnect-recovery rules are all exactly as documented
elsewhere in this file — this pivot touched none of them.

**Public tavern speech, the actual design.** One active utterance per
bar identity at a time (`bar_speech`, a single row per player — not an
append-only log: there is no history to browse, just "what is this
person saying right now, if anything"), sent via `POST /api/bar/say` and
delivered through the *existing* public bar snapshot/SSE broadcast —
deliberately no new transport. A speech bubble is exactly as visible to
everyone watching the bar as a patron moving or sitting down already is,
with zero new plumbing beyond adding a `speech: string | null` field to
`PublicBarPlayer`. `expires_at` is an absolute timestamp set once at send
time (`SPEECH_DISPLAY_MS`, 8s by default) — `getPublicBarState` filters
by it lazily (`expires_at > now`, the same "evaluated fresh on every
read" principle as the lobby disconnect grace), which is what makes a
reconnect or a plain poll report the *remaining* window rather than
restarting it, with no sweep and no client-side countdown. A bubble
naturally expiring with nothing else changing is still pushed to anyone
watching within about a second, for free: `speech` is part of the same
`players` array `tickBarPresence`'s signature-diff already compares every
tick, so "a bubble just disappeared" is detected and republished exactly
like "a patron just went offline" always was.

**Server-side, per the general send-something-public shape:** real
identity via `requireBarSession` (never a client-supplied nickname),
1–500 characters trimmed, a per-sender sliding-window rate limit
(`SPEECH_RATE_LIMIT_COUNT`/`_WINDOW_MS`, the same in-memory shape
`src/chat.ts`'s own limiter used, just not shared code since it's a
different action with its own threshold), and a client-generated
`clientMsgId` as the idempotency key — but idempotency means something
specific here, different from an append-only message log: a retried send
with the *same* id is a pure no-op that must **not** restart the 8-second
clock, while a **genuinely new** utterance from the same person replaces
whatever bubble they already had and *does* restart it. Rendered client-
side as `fillText`, never `innerHTML`, so nothing in a bubble's text can
execute.

**Client-side bubble rendering.** Drawn directly on the canvas
(`drawSpeechBubble`/`wrapBubbleText` in `public/tavern.js`), never a DOM
element — it therefore can never intercept a click on the floor, a
character, or a chair underneath it, since every click is resolved from
grid coordinates alone, independent of anything drawn. Word-wrapped to a
fixed max width, clamped to stay on screen; a single "word" wider than
the whole bubble (a long CJK run, a long no-space token) is broken by
character instead, iterating by Unicode code point (`for...of`, never
`split('')`) so a surrogate-pair emoji is never cut in half. Follows
whatever screen position the nickname tag above a patron's head already
uses — a present game-table occupant's real chair tile
(`src/position.ts`, unchanged by this pivot) just as much as an ordinary
standing or dining/stool-seated patron's interpolated position — so
movement, sitting down, and the camera panning all carry the bubble with
them for free, with no separate position-tracking code of its own.

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

## Seat art and input must share geometry

Draw and hit-test dining/stool seats from BAR_SEATS, and game chairs from
GAME_CHAIRS returned by /api/bar/layout. A chair's own tile is clickable;
no decorative chair may imply a different tile or overlap another chair.
Hover/focus highlights belong to the chair, not a separate visible control.
Stools occupy their own fixture tiles but block ordinary walking. Game chairs are
fixed by colour; room player.seat continues to mean join/turn order and
must not be changed merely to reposition an avatar. Online host approval
still applies. Never draw an active game occupant twice as both a seated
figure and a standing bar patron. Layout migrations preserve room links,
move occupied chairs with their patrons, and relocate obstructed floor
positions without deleting identities or game progress.

## Vegas tabletop presentation

Online and solo games share the physical six-casino ring presentation.
Use real server bills/dice; keep all action and server-authority rules.
Solo room status comes from its creation history, not a guess based on
nicknames or how many NPCs are currently present. Hide invitations only
for solo rooms. Round Vegas chairs expose integer occupancy tiles and
continuous display centres: draw chairs, hit areas, seated figures and
speech at the same display centres, while validating movement using the
integer tiles. Reserved game-table geometry/art stays unchanged.

## Walking floor excludes chairs and cabinet walls

`isWalkingFloor` is the routing/spawn/recovery contract; every dining,
stool and game chair is excluded even when empty. `isWalkable` only
describes furniture-free occupiable space, including seats. Cabinet walls
are real layout fixtures, not canvas-only decorations. Client routes and
server moves reject chair transit and diagonal corner cutting alike.
Preserve actual seated patrons across recovery and migration. A sit is
an explicit, adjacent interaction; never authorize a chair shortcut as a
normal move. The speech composer starts collapsed behind its chat icon.

Decorative plants follow the identical rule: a plant that blocks the
floor is a real `FurnitureKind: "plant"` entry in `src/barLayout.ts`'s
shared `FURNITURE`, never canvas-only art with no collision footprint —
the same reasoning cabinet walls already established. Any such plant
must sit well clear (several tiles) of every chair and dining seat, not
merely not-literally-on-top-of-one, since a chair's own drawn canopy/art
extends past its single tile and a near miss still reads as broken.
A purely decorative plant with no collision role (placed far from any
furniture, like the map's four corner plants) does not need this.

## 2026-10-19 correction — exits and three-minute departures

This supersedes the earlier two-minute table-only description. Default grace is now 180000 ms. A persistent room_departures table covers invitation/direct entry without a bar identity, alongside table_departures for physical table bindings. Both resolve through the actual player's session, never a kiosk's shared-room pointer. Departure upserts preserve the first timestamp. A deliberate room resume clears both departure records; passive heartbeat/rejoin never does. Recorded departures reserve lobby seats against the shorter disconnect grace.

Explicit authenticated Exit game and expired departures share exitGame: lobby leave/cancel; started Online seat becomes NPC without changing dice/turn order, host passes to a remaining human; no remaining human closes the room, including Offline games. Clear both binding and timers in the same transaction. Do not revive an NPC-handed-off seat using an old session. Enforce on live ticks and before incoming requests, including after restart/idle. Request-triggered enforcement runs OUTSIDE that request's AsyncLocalStorage verification context, so a stored session checked for expiry cannot incorrectly verify the incoming HTTP caller. Only authenticated self responses may contain activeSeat; refresh the Return button from the heartbeat response, never broadcast a private binding.

## Four-round games and winnings privacy (2026-10-22)

The user superseded the one-round adaptation for both modes. Keep four
rounds, eight dice per player per round, cumulative won-banknotes, and the
same deck across rounds. Round 1 chooses its starter using server RNG;
subsequent rounds advance that marker through the fixed clockwise order.
This random-first choice intentionally differs from the physical oldest-
player rule. `round_end` is a pause, never a finished table; only
`game_end` reveals ranked banks and winner IDs. Equal money compares note
count; equal count too permits joint winners. Only the authenticated host
may advance a round, using the expected round to reject stale retries.
Never expose cumulative banks through shared SSE, public snapshots or
other players' authenticated requests before game end. Existing legacy
rooms must retain winnings, deck and identity during metadata migration.

## Room voice calls (2026-10-22)

Online rooms only — never Offline/solo NPC games, never a pending
join-request identity, never an NPC-controlled seat. WebRTC mesh audio
(2–5 seated humans); the server handles authentication, signaling relay,
and call-membership state, never audio itself — no media server, nothing
recorded.

**Phone-style, not persistent chat.** A call is started by one seated
human's own deliberate action, which must request microphone permission
only after that action and only for the person who took it — an invited
player, or anyone who merely sees the call exists, must never have
`getUserMedia` called on their behalf before they themselves accept.
Declining is a one-time "not this call," never a standing block: the
same person can join later from the room's own call-status header with
no special-casing, since a decline simply removes that invite row rather
than recording a block.

**One call per room, ever, at a time.** Two simultaneous "start a call"
requests must merge into the same call, never spawn two — enforced by a
database uniqueness constraint on the room, not application-level
locking, so the merge is correct even under a genuine race. The person
who happened to create the call row is not its administrator: hanging up
removes only that person, never forces the call to end for anyone else.
The call ends, and only ends, when its last actually-joined participant
leaves — at that point every still-pending invitee is told the call
ended, not left to ring indefinitely.

**Membership is reconciled lazily, like every other grace period in this
file.** There is no background sweep dedicated to voice calls. A
participant who left the room, was handed off to NPC control, or went
presence-stale past the existing connected-threshold is dropped from the
call the next time anything reads its state — which, via the existing
presence ticker, is within about the same ~1 second as everything else
already pushed live. A call's own public summary (who's joined, who's
muted, a plain count) rides the room's existing public state/SSE
payload; nothing about this introduces a second transport for the public
half. An invited-but-undecided player's identity must never appear on
that public payload — only confirmed, joined participants are public,
matching the existing player-list transparency rule for everything else
in a room.

**Signaling is never public.** SDP offers/answers and ICE candidates are
relayed only between two participants the server re-confirms are both
genuinely joined to the same call, over a channel scoped to exactly one
(room, player) pair — never the room's shared SSE broadcast, and never
reaching a declined or not-yet-accepted invitee. Every signaling and
membership action re-verifies session, current seat, human controller,
same room, and the call's own identity (a stale or ended call id is
refused, not silently accepted) before doing anything.

**STUN always, TURN only if actually configured.** A public STUN server
is always offered so ordinary NAT traversal works without any
credential. TURN only appears when real credentials are present as
server secrets — this app must never default to, purchase, or stand up
an unauthenticated TURN relay on its own initiative, and a TURN
credential must never be hardcoded into the client bundle. Without TURN
configured, two peers behind symmetric NATs or restrictive firewalls may
simply fail to connect — a real, stated limitation, not something to
paper over by testing only on one shared network and reporting success.

**Refresh never silently rejoins a call or reopens the microphone.**
Reconnecting after a dropped connection re-fetches this player's own
authenticated call state as a catch-up, exactly like every other private
channel in this app already does on reconnect — but if that catch-up
finds a stale "joined" row from before this exact page load, the correct
action is to actually leave that call again (this fresh page genuinely
holds no real peer connections for it), never to assume presence and
suppress reconnection. Leaving the room view (back to the bar, exit,
disband, a seat handed to NPC control) must tear down the microphone,
any peer connections, and any audio playback — the same lifecycle
discipline this file already requires for every other resource a
departing player can leave dangling.

**The incoming-call prompt is a toast, not a modal.** It must never cover
the board, dice, rules, or exit controls, on desktop or at the existing
mobile breakpoint; declining or accepting must each be a single,
unambiguous action, and nothing about receiving or declining an invite
may trigger a repeated ring or auto-retry.

### Voice lifecycle correction (Codex, 2026-10-22)

A signaling reconnect on the SAME page must retain its joined status,
media and Hang up controls. A fresh page has no media and must release
stale membership without auto-opening the mic. Guard every async mic,
join, ICE and signaling continuation with the captured room/media
lifecycle; late permission results must stop their tracks and must not
join. A join which already committed while navigation was pending needs
captured-room cleanup. Ignore old call events and stale state responses;
briefly queue authorized early signals during explicit joins so this
protection does not lose the first offer. Public removal also stops
media, independently of private-channel delivery.

Room and table departure records revoke voice immediately, even though
retaining a game seat is legitimate for three minutes. Check BOTH sender
and recipient eligibility for each signal, including bar/dining away
states. Resume allows a new explicit join, never passive auto-join.
Component tests use media adapters; do not describe them as real audio
acceptance. STUN is not a TURN audio relay; TURN remains unconfigured.

## Hold’em scope and authority (Codex, 2026-10-22)

The user now explicitly authorizes Texas Hold’em in both existing Texas
fixtures. It is independent of Vegas room JSON/session secrets. Reuse
real bar-session authentication; one person cannot occupy poker and
Vegas/another chair simultaneously. Five seats, 500 initial play chips,
blinds 1/2, cash-table continuation, no payments. Timings, free rebuys and
NPC refill are declared house rules, not exact RDR2 settings. Keep other
reserved games and src/orders.ts untouched.

Shuffle/deal/evaluate on the server. Preserve uncalled bets, all-in side
pot eligibility, equal-hand splits, clockwise odd chips, minimum raises,
and the distinction between a full raise and a short all-in. Waiting
mid-hand arrivals receive no cards until the next deal. Explicit leave
folds unless already all-in; host transfers. Refresh must not redeal or
leave. Disconnect grace is three minutes, action timeout 45 seconds.

Poker state, membership, wallets and event history persist in SQLite;
state+event+stdout success share the existing transaction contract. An
expected version rejects stale/duplicate actions. NPCs must not inspect
other hole cards or the future deck. Only authenticated personal poker
snapshots may contain the caller's hole cards; reveal non-folded hands
at showdown. Never put a deck or private cards in public tavern SSE.
All poker HTTP responses use private/no-store. Online invitations are
recipient-bound, expiring, capacity-checked and rate limited, not seat
reservations. Nicknames are search labels; actual IDs/session checks
remain authority. The new polling UI must ignore old identity/navigation
responses and preserve invitation retry controls after a rejected join.

Existing voice remains Vegas-only; do not pretend it was wired into
poker. Keep initial rules/decisions in ADR-poker.md and distinguish agent
browser verification from student/friend acceptance.

### Room-entry recovery and round-table presentation (Codex, 2026-10-23)

Room-entry failures must distinguish closed/missing/released seats from
authentication failures and transient errors. Preserve saved sessions on
transient failures; an error page must always allow navigation to the bar.
An authenticated bar owner may exit their own linked Vegas room without
the browser's room secret. Match the requested room code to the current
binding so an old tab cannot exit a newly joined game. Never return the
server's room secret to implement this fallback.

Poker seat rotation is visual only. Keep authoritative seat numbers,
dealer and turn order unchanged. Draw only the cards actually supplied by
the private snapshot; placing cards visibly on felt does not authorize
revealing opponents' hands before showdown.

### Poker bankruptcy (Codex, 2026-10-23)

A human with zero chips after final settlement automatically leaves the
table. All-in zero is not bankruptcy: finish every main/side pot, split
and refund first. Release membership and transfer host/close the room in
the same transaction as settlement and the private persistent notice.
Show Out of chips with the hand result. Only its Return to the bar click
acknowledges the notice and navigates; refresh/restart must not lose it.
Acknowledgement is authenticated and notice-id scoped, so an old click
cannot clear another player's or newer notice. No in-place rebuy. A
deliberate later re-entry can start a fresh free 500-chip buy-in when the
prior stack was zero. NPC refill stays a declared house setting. This
does not apply to Vegas winnings (which legitimately start at zero).
