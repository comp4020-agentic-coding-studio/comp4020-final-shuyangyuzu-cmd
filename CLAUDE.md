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
