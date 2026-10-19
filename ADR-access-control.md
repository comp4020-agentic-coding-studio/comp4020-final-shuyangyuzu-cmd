# ADR: anonymous browser identity, and who may see or change what

Status: Accepted, written for Crit 10.

## Context and what good means

Crit 10 asks the project to be multi-user by its own definition — two or
more people, each in their own browser, acting on shared state, with the
app telling them apart — and asks me to write down, in the repo, what each
person may see and change and why. The mechanism already existed before
this week: this record is me checking it against the actual code while
writing it, not inventing new rules from scratch. I corrected one gap
found while writing this (server-side action logging reached only
SQLite, never the terminal) rather than leave the ADR describing a
stronger guarantee than the code gave.

I want a friend to be able to open a link and just be a different,
recognisably different person from whoever else is in the room, with no
signup. I do not want that convenience to mean anyone can act as anyone
else, see another player's private proof of identity, or peek at cards
nobody has drawn yet.

## Decision

**An anonymous browser identity, not an account.** A player is a random
id plus a `session_secret`, generated server-side and handed back once,
at join/create time. The browser keeps the secret in its own storage and
sends it back on every later request. There is no password, no email, no
recovery path: a cleared browser or a different device is a different
person as far as the server is concerned, and the UI says this plainly. I
chose this because the brief explicitly leaves "what counts as a person"
to me, and an anonymous session is adequate for a one-evening crit
rehearsal — the cost (no recovery, no cross-device continuity) is real
and I'm naming it here rather than glossing over it.

**Two separate identity layers, two separate secrets, never merged.** A
bar identity (tavern nickname/colour/position) has its own secret in
`bar_sessions`, checked by `requireBarSession` (`src/bar.ts:199-206`). A
game room's player record has its own, unrelated secret in `sessions`,
checked by `requireSession` (`src/rooms.ts:219-226`). Being present in
the tavern never implies being seated at any table's game, and the two
checks never share a code path. The only link between them is
`bar_players.current_table_id`/`current_game_player_id`
(`src/tables.ts:252-282`'s `resolveActiveSeat`), which exists purely to
answer "which room is this bar identity's active game" for routing — it
is read, never trusted as proof of anything on its own; every actual
mutation still goes through that layer's own session check regardless of
what the link table says. This week's logging work reuses the same link
for a second purpose: `createTableRoom`/`joinTableRoom`/`startNpcGame`
(`src/tables.ts`) log the bar id and the room id together in one line at
the moment of binding, which is what lets an operator correlate a tavern
character to a game player from the terminal without the two identity
layers' own checks ever needing to know about each other.

**What the public sees.** `toPublicState` (`src/rooms.ts:1188-1221`)
is the only function that turns a room's internal state into what a
client receives, and it is a strict allowlist: id, nickname, colour,
seat, dice count, winnings, ready flag, a freshly-computed `connected`
flag, and `controller`. It never includes `session_secret` — not even
the requesting player's own — and the deck is reported only as
`deckSize`, never its contents or order, so a drawn/placed/returned bill
is visible but what hasn't been drawn yet never is. The equivalent bar-
side function, `getPublicBarState` (`src/bar.ts`), follows the same
shape: nickname, colour, skin, position, seat, and current speech, never
a secret.

**What a player may change.** Every mutating room action —
`roll`/`place`/`setReady`/`leaveRoom`/`approveJoin`/`rejectJoin`/
`cancelJoinRequest`/`startGame`/`disbandRoom` — calls `requireSession`
first, before anything else; every mutating bar action calls
`requireBarSession` first the same way. A mismatched or missing secret
throws `unauthorized` (403) immediately, before any state is read or
changed. `roll`/`place` additionally re-check whose turn it is and what
phase the room is in (`src/game.ts`'s `applyRoll`/`applyPlacement`),
server-side, regardless of what the client's own UI happened to show or
hide — "the button was only visible to the right player" has never been
the control.

**What only the host may do.** `approveJoin`, `rejectJoin`, `startGame`,
and `disbandRoom` each check `row.host_player_id === playerId` and throw
`not_host` (403) otherwise (`src/rooms.ts:550,621,827,1028`). A pending
join request is never a seat and never counts toward capacity or turn
order until the host explicitly approves it — see `ADR-last-seat.md` for
the full reasoning behind that design; this document only restates the
authority boundary it relies on.

**Who controls a handed-off seat.** Once a started game's seat has been
away from its table for the leave/exit grace period (CLAUDE.md's
leave/exit states), `handoffToNpc` flips that seat's `controller` to
`"npc"` one-way — its dice, winnings, and turn-order position are kept
exactly as they were. From that point, `refuseIfNpcControlled`
(`src/rooms.ts:1080-1088`) refuses the original human's still-valid
session for that seat specifically — the ordinary "is it your turn"
check alone would not catch this, since a handed-off seat's id can still
legitimately be `currentPlayerId` when it is genuinely that seat's turn.
Nobody "controls" an NPC seat in the sense of a session acting for it;
`src/server.ts`'s own scheduler calls `rooms.npcRoll`/`npcPlace`
directly, choosing only among values already rolled, never a rule a
human player couldn't also follow.

**Server-side action logging, and why it had to change this week.**
Every mutating action already wrote an entry to the SQLite `events`
table (`src/rooms.ts`'s `logEvent`), inside the same transaction as the
state change — but that table was never read by anything, and nothing
in the app wrote a single line to the process's own stdout beyond a
generic error handler and a one-time startup message. The result: a
presenter watching only `flyctl logs`, as the crit's own rehearsal
requires, saw nothing but Fly's own machine-boot noise. `src/actionLog.ts`
is the fix — one structured, single-line JSON log emitted alongside
every existing `logEvent` call (and at new call sites bar/table actions
never had before), plus every rejection, from the one choke point
`app.onError` already sees every typed error through.

Real correctness bugs were found in this logging mechanism across two
follow-up review rounds after it first shipped, each fixed and each
recorded in `PLAN.md`'s own 2026-10-17 correction entry — this paragraph
states the corrected design, not any earlier attempt. First: a success
line must only ever reach stdout if the write it describes actually
committed, including when one function's own transaction is called from
inside another function's transaction (`src/tables.ts`'s `createTableRoom`
calling `rooms.createRoom`, which already nests this way in production).
Simply placing the log call inside a `db.transaction()` callback is not
enough — better-sqlite3 commits a nested call's own SAVEPOINT immediately
on success, before the outer transaction has decided anything, so a log
call made there can print even though the outer transaction later rolls
everything back. The fix that actually holds is a **stack** of log
buffers per database connection, one per currently-open transaction
level, installed once by patching `Database.prototype.transaction` itself
(`src/actionLog.ts`'s `installTransactionLogging`, called from `src/db.ts`'s
`openDb`) so every transaction on that connection gets this regardless of
how it's invoked: a level's own rollback discards *only that level's own*
buffered entries, leaving every enclosing level's own entries untouched;
a level's own commit merges its buffer into the next level out, rising
with that enclosing transaction's own eventual fate; only the truly
outermost level's own commit actually prints anything. A single flat
buffer (the first fix attempt) is not equivalent to this — it cannot tell
an inner transaction's own caught-and-recovered-from rollback apart from
the outer transaction's own later, genuinely successful commit, and
logged both as if they'd both committed when only one row actually
existed afterward. Second: a rejection's `verified` field is real
evidence that `requireSession`/`requireBarSession` actually ran and
passed for that request, recorded the instant the check succeeds
(`markIdentityVerified`, read back by `app.onError` as
`wasIdentityVerified`) — never inferred afterward from the rejection's
own error code, which the first version of this logging did and which
was wrong (most of `src/rooms.ts`'s mutations reach `loadOpenRoom`'s own
`room_not_found`/`room_closed` throw *before* `requireSession` is even
called, so that first version logged `verified: true` for requests whose
identity was never checked at all). A short, non-secret fragment of each
real id (8 characters) makes two same-nickname patrons distinguishable on
screen, which matters specifically because the crit's own rehearsal has
two classmates using the same app, plausibly with similar chosen names.

## Alternatives and costs

- An account system (email/password, or an OAuth login) would give real
  cross-device recovery, but is explicitly more than this week's brief
  asks for and adds a dependency (a mail sender, a third-party identity
  provider) this course's single-Fly-machine setup isn't built around.
- A single shared identity layer (merging bar and room sessions) would
  remove the need for a correlation step in logging, but would couple
  two already-independent, already-tested subsystems together — CLAUDE.md
  rules this out explicitly, and I agree with the reasoning: the bar
  shipped without ever touching `rooms`/`sessions`/`presence`/`events`'
  existing shape, which is what kept every pre-existing room test
  meaningful throughout the pivot.
- Logging every room event to stdout *instead of* the SQLite `events`
  table (rather than alongside it) would have been less code, but the DB
  table is the only thing a future feature could ever query
  programmatically; stdout is for a human watching live, not for later
  structured access. Keeping both, written independently, costs a few
  extra lines per call site and buys a transport-appropriate shape for
  each audience.

## Related choices

Tile occupancy, host-approved admission for online tables, and the
superseding of private 1:1 chat by public speech are documented in
`ADR-last-seat.md` and are unaffected by this record — this document is
specifically about identity, authority, and now logging, not about
world/spatial design. Private chat's existing access control
(`requireThreadAccess`, `src/chat.ts`) is deliberately untouched by this
week's logging work: CLAUDE.md's "already-saved private records keep
their original access control" means that data and its checks were never
part of this scope, and adding action logging to a feature the client no
longer uses would have been scope creep against the course's own
deliberate restraint.

## Evidence and limits

Every file:line citation above was checked against the actual code while
writing this document, not recalled from memory or from an earlier
review. The access-control citations themselves held up; the logging
mechanism's own correctness did not, across two separate follow-up
review rounds — the first found a rollback that still logged success
across nested transactions and a `verified` field inferred from an
error code rather than real evidence; the second found that the first
round's own rollback fix (a single flat log buffer per database
connection) could not distinguish an inner transaction's own
caught-and-recovered-from rollback from the outer transaction's own
later, genuinely successful commit. All three are reproduced with
failing tests before being fixed and recorded in `PLAN.md`'s own
2026-10-17 correction entry, in the order they were actually found. This
document's description above is the design as it stands after both
rounds, not any earlier attempt — stating that plainly here rather than
quietly rewriting history is itself part of what this document owes a
reader. The structured logging this document describes is new this
week; its commits, and the live two-Chrome-profile rehearsal that
exercises it, are recorded in `PLAN.md`'s Crit 10 entry. Tests cover:
distinct log lines for same-nickname identities, a rejection never
producing a success line for the same call, an idempotent retry logging
success once rather than per-attempt, no log line ever containing a
session secret, a rolled-back outer transaction (nested or not) never
leaving a success line behind, an inner transaction's own rollback
caught and recovered from by an outer transaction logging only the
outer's own real commit — never the doomed inner attempt — and
`verified` reflecting real session-check evidence rather than an
inference from the rejection's own error code (`spec/actionLog.test.ts`).
What this document cannot establish on its own: that a person watching
only `flyctl logs` at a real crit can, in practice, follow along without
confusion — that is what the live rehearsal is for, and its outcome is
recorded separately rather than assumed from the tests passing.

### Follow-up: leaving a game

POST /api/rooms/:code/exit, /depart and /resume require the caller's room session. A player can release only their own seat. Offline closure follows from no human remaining; an Online departure cannot terminate a game other humans still occupy. Expiry uses persisted timestamps and the same exit operation, resolved by player session even for personal Offline rooms. Automatic expiry runs before the fresh request verification context so its authenticated stored session cannot contaminate a rejected caller's verified field. Offline is a UI mode name for computer opposition, not a claim of disconnected/browser-local execution.
