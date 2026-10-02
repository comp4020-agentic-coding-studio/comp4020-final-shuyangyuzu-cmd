# Plan — crit 8 (It's alive!)

A multiplayer browser dice game based on the **base game of *Las Vegas*** (Rüdiger
Dorn, alea/Ravensburger, 2012/2011), for a group of friends sitting around one
table, each joining from their own phone. No accounts, no matchmaking, no chat,
no AI opponent — just one room, one shared table, a handful of players.

Rules source: the official English rulebook,
`https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf`
(read directly, via `pdftotext`, not a secondary summary).

## What crit 8 ships

One complete round of the base game: create a room, join by link or room
code, 2–4 players, take turns rolling and placing dice, settle all six
casinos, persist the result. The final project (weeks 10–11) extends this to
the full four-round game with running totals and sub-second cross-device
sync; neither is in scope this week.

## Rules, as confirmed against the official PDF

- 6 casinos, numbered 1–6 (original names "Golden Nugget" etc. are flavor
  text in the rules, not implemented as UI chrome here — we use plain
  numbers with our own visuals, see product decision 5).
- 8 dice per player. On your turn: roll every die you still have, choose
  **exactly one** rolled value, place **all** dice showing it on the
  matching casino. No voluntary pass — you stop only when your hand is
  empty.
- Settlement, per casino, once all players are out of dice:
  1. Any two or more players tied on dice count are cancelled out entirely
     — they win nothing at that casino (dice returned to hand, not money).
  2. Among the untied, rank by dice count descending; highest gets the
     casino's highest-value banknote, next gets the next, and so on.
  3. If there are more ranked players than banknotes, the lowest-ranked
     miss out.
  4. **Any banknote left unclaimed goes to the bottom of the draw pile**,
     not discarded. (Corrects an earlier misreading of a secondary source.)
- 54 banknotes: five each of $90k/$80k/$70k/$60k, six each of
  $50k/$40k/$10k, eight each of $30k/$20k. Each casino is restocked to at
  least $50,000 at the start of every round.
- Four rounds in the full game; round 1's turn order is the start
  player and clockwise from them. **This week is round 1 only.**
- The 2–4 player "neutral white dice" variant exists in the official rules
  but is an optional variant, not the base game — **not implemented**, this
  week or in the final project, per product decision.
- In the physical game, each player's winnings are face-down and hidden
  from the other players until the game ends. **This web version shows
  everyone's cumulative winnings publicly, continuously** — a deliberate
  readability choice for a shared-screen/multi-phone context, and an
  explicit divergence from the original to call out in README.

## Product decisions (confirmed)

1. 2–4 players. The real UI refuses to start with fewer than 2; any
   solo/one-player exercising of the engine happens only through the test
   suite, with its own fixtures, never through the product's own start
   action.
2. The room's creator is its host. Only the host can start the game.
   Once started, no further joins are accepted (seats are closed), but any
   already-joined player may rejoin.
3. Turn order in round 1 is join order. (Later rounds, in the final
   project, rotate the starting player by one seat each round, per the
   official rule — not relevant to a single-round week.)
4. A disconnected player's seat is held; the game waits for them
   indefinitely rather than auto-skipping. The product explicitly presents
   itself as a same-table, play-with-friends version, not a matchmaking or
   timed competitive one.
5. Casinos are shown as plain numbers 1–6, with original hand-made visuals
   — not the original board's casino names, card design or table layout.
6. Room codes are 6 characters, case-insensitive, drawn from an alphabet
   that excludes easily-confused characters (e.g. no `0`/`O`, `1`/`I`/`l`),
   checked for collision against existing rooms at creation time.

## Stack (confirmed)

Node 24 (already pinned) + TypeScript, Hono for HTTP, better-sqlite3 for
persistence to a single file under `/data`, vanilla TS/CSS for the client.
Polling (1–2s) for this week's state refresh; SSE is the planned upgrade
for the final project's faster sync, not built now.

## Engineering constraints

See `CLAUDE.md` — server-side authority over RNG/turn/phase, one DB
transaction per state-changing action (state + event log together),
idempotency against duplicate/retried requests, no leaking `session_secret`
or future draw-pile order to any public response, and the explicit limit
that identity recovery is browser-local (clearing site data loses the seat,
stated plainly in the UI, not silently papered over).

## Phases

- [ ] 1. Scaffold: dependencies, real Dockerfile (replacing the busybox
      placeholder), `src/` layout, `/readme/` rendering `README.md` as real
      HTML (not HTML-escaped `<pre>`).
- [ ] 2. Red spec tests for room lifecycle, turn engine, and settlement —
      including the two official worked tie-break examples from the PDF as
      fixtures — written before the implementation exists.
- [ ] 3. Room lifecycle: create, join (code/link, nickname+color, capacity,
      unique colors), host-only start (closes seats), rejoin.
- [ ] 4. Turn engine: server-rolled dice, choose-and-place validation,
      turn/phase enforcement, idempotent against duplicate requests.
- [ ] 5. Settlement: tie cancellation, descending bill distribution,
      unclaimed bills to bottom of deck, won-bills list tracked per player
      (not just a total) so the final project can judge same-amount ties.
- [ ] 6. Public API sanitization: no `session_secret`, no future deck
      order, in any state/event response.
- [ ] 7. Minimal client UI: lobby, table view, roll/place controls,
      explicit copy on the public-winnings deviation and the
      browser-storage recovery limit.
- [ ] 8. Verification: wrong-secret rejection, duplicate-request safety
      (no double roll/place/settle), state survives a local process
      restart and a real `flyctl deploy`.
- [ ] 9. Deploy, verify live spec (`/`, `/readme/`, a full room lifecycle
      against the deployed app).

## Explicitly out of scope this week

Chat, matchmaking/lobbies beyond one room's own link, any AI player, the
neutral white-dice variant, more than one round, sub-second sync (polling
is enough for "refresh and your trace is still there").

## Progress log

(Real events as they happen — commits, checks going green, anything that
broke and how it was fixed. Not a narrative; that's what `PROCESS.md` and
the reflection are for, and they're the student's own writing.)

- 2026-10-03: plan agreed, rules re-verified against the official PDF via
  `pdftotext` (resolved two ambiguities from secondary sources: bills
  return to the bottom of the pile rather than being discarded; exact
  tie-cancellation wording). Scope and constraints written into this file
  and `CLAUDE.md`.
