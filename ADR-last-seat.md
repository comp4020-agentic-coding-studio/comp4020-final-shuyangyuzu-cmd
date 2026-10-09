# ADR: resolving the last-seat race (Crit 9's multi-user decision)

**Status**: Accepted — this documents and argues an existing, already-shipped
behavior; no server-side logic changed as part of writing this record.

## Context

Crit 9 asks for one deliberate decision about multi-user behavior, with
alternatives considered, costs named, and the chosen path argued *against*.
One of the brief's own example decision points is "how conflicting
simultaneous edits to the same item are resolved." The concrete case here:
two people in the bar click to join or start a game at the same table at
the same moment, when only one seat (and, in this app, often only one
remaining color) is actually available.

Before deciding anything, the actual behavior was investigated, not
assumed — see `PLAN.md`'s Crit 9 prep section and phase 6 for the full
trail. Two separate questions came out of that investigation, and this
record keeps them separate on purpose, per the explicit instruction not
to conflate them:

1. **Is the race itself safe?** Does the server ever let two people both
   "win" the same seat?
2. **How fast does each side find out?** The person who loses finds out
   from their own request; everyone *else* already in the lobby finds out
   from watching the room.

## What was found

`rooms.joinRoom` (and `tables.joinTableRoom`, which calls it) runs inside
a `better-sqlite3` transaction, and `better-sqlite3`'s calls are
synchronous — they block Node's single-threaded event loop for their
duration. Two "simultaneous" join requests are therefore never actually
concurrent at the point that matters: whichever one's handler runs first
reads the room, confirms a seat is free, and commits the version bump;
the second reads the *post-commit* state inside its own transaction and
correctly sees the room full. This was true before any of Crit 9's work
and remains unchanged — the race was never actually a race at the data
layer, only in how long each affected person took to find out about it.

## Decision

Keep the current behavior. Document and argue it, rather than build
something new to solve a problem that was never actually a correctness
problem — the brief allows this ("resolve it... Students may find they
already have a sensible answer").

**The rule, stated plainly**: whichever join request's transaction
commits first gets the seat. The other gets an immediate, specific error.
Everyone else already watching the room sees the room's new player list —
and, if it just filled up, that it's full — pushed to them within the
same real-time channel Crit 9 added, not a separate mechanism.

## Measured, not assumed

Both numbers below come from a script that fires two real, simultaneous
`POST /join` requests for a room already at 3/4 players with only one
color left (so the race is for the one truly contested slot, not an
artifact of the test picking different colors), while a third, idle
session watches the room's SSE channel. Three local runs and two
production runs; a representative run from each:

| | Local | Production (`comp4020-final-shuyangyuzu-cmd.fly.dev`) |
|---|---|---|
| Loser's own `409 room_full` response | 8-10ms | 86-230ms |
| Winner's own `201` response | 6-7ms | 80-224ms |
| Idle bystander's SSE push showing the room full | ~0ms after the winning request committed | ~0ms (sub-ms, within clock jitter) after the winning request committed |

**These are two different numbers, reported separately, exactly because
they measure two different things**: the loser's own latency is bounded
by ordinary network round-trip time to this app — it was never bounded by
polling, not before Crit 9 and not after. It arrives on their own request's
response, the same way any HTTP error would. The bystander's number is
what Crit 9's work actually changed: before, a bystander's view of "the
room just filled up" was bound by the ~1.5s poll interval; now it arrives
over the same SSE push as everything else, which is why it's effectively
instantaneous in both environments.

## Alternatives considered (and why they weren't chosen)

- **Client-side optimistic reservation** — show the clicking player as
  "seated" immediately, before the server confirms. Rejected: this would
  let two clients both display themselves as having gotten the seat for
  the brief window before the server's responses disagree, which is
  exactly the kind of thing CLAUDE.md's server-authority section rules
  out — the server is the only source of truth for anything that must be
  fair across players, and a client showing an unconfirmed outcome as if
  it were final violates that even if it's corrected a moment later.
- **A waitlist/queue for the loser** — instead of a flat rejection, offer
  to hold the loser's spot for the next cancellation. Rejected *for this
  week*: it needs new state (who's waiting, in what order, how long an
  offer stays open) that nothing in the brief asks for, and the app has
  no mechanism today for notifying someone later that a seat opened up
  (no chat, no push notification outside an open tab — see CLAUDE.md's
  scope discipline). Not rejected as a bad idea in general — see below.
- **A richer "you were N milliseconds late" message** — rejected: the
  server doesn't currently record how close a race was (it only knows
  "already full" at the moment it checks), and building that just to
  phrase a friendlier error isn't worth the added state for what's
  already a clear, truthful message.

## Argued against (as the brief explicitly asks)

The strongest case *against* the chosen path: "whoever's HTTP request
wins" is a fundamentally different fairness rule than how a group of
friends would actually resolve this standing around a real table —
physically, the person who got there first *visibly* got there first,
and the others can see it happening and back off gracefully. Here,
two people who both tap "join" within the same 50ms have no way to tell,
in the moment, who's about to win; the loser's first signal is a flat
rejection after the fact, decided by network timing and server scheduling
they have no visibility into and no control over. A queue — even a
simple "you'll get it if the current game ends and no one else is
waiting" — would arguably be *more* true to the social reality this app
is modeling (a shared tavern among friends) than a race that rewards
whoever's phone or connection happened to be faster that second. This is
a genuine cost of the chosen path, not a strawman raised only to be
dismissed: the current behavior optimizes for simplicity and immediate,
unambiguous feedback over social fairness, and a future week could
reasonably revisit that trade-off if it turns out to matter in practice
(e.g., if play-testing surfaces real frustration at the table, not just
the hypothetical case raised here).

## How this ties to README's own "good"

README's definition of good starts with: "a newly invited friend can
understand the space and join a game without someone explaining the
interface." An immediate, specific, plain-language error ("this room
already has its 4 players") — arriving on the loser's own request, not
delayed behind a poll — combined with a view that's already current by
the time they look again (via the same SSE push everyone else gets),
satisfies that bar without needing new UI: there's nothing to explain,
because the result is both fast and self-evidently final. The real
limitation is the one argued above — "self-evidently final" is not the
same as "feels fair when it happens to you," and that's a genuine,
named cost of this decision, not a gap in the explanation.
