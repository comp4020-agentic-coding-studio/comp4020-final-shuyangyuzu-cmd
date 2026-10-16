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
`app.onError` already sees every typed error through. A rejection caused
by a failed identity check (`code === "unauthorized"`) is logged with
`verified: false` and the *claimed* id, never a nickname (a nickname is
only ever read from a verified DB row) — this is what keeps "someone
tried to act as X and failed" honestly distinguishable from "X actually
did this." A short, non-secret fragment of each real id (8 characters)
makes two same-nickname patrons distinguishable on screen, which matters
specifically because the crit's own rehearsal has two classmates using
the same app, plausibly with similar chosen names.

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
review — no mismatch was found between what this document claims and
what the code does, which is itself worth recording rather than
assuming. The structured logging this document describes is new this
week; its commits, and the live two-Chrome-profile rehearsal that
exercises it, are recorded in `PLAN.md`'s Crit 10 entry. Tests cover:
distinct log lines for same-nickname identities, a rejection never
producing a success line for the same call, an idempotent retry logging
success once rather than per-attempt, and no log line ever containing a
session secret (`spec/actionLog.test.ts`). What this document cannot
establish on its own: that a person watching only `flyctl logs` at a
real crit can, in practice, follow along without confusion — that is
what the live rehearsal is for, and its outcome is recorded separately
rather than assumed from the tests passing.
