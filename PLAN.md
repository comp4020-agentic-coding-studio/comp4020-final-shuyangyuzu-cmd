# Playtest round 1 (2026-10-04) — lobby/identity/navigation fixes

The student played the deployed app themselves (not the agent) and reported
a substantial list of real problems, in their own words, grouped here as
they gave them. This section is that feedback plus what was actually found
when reproducing it, kept separate from the agent's own earlier QA pass
(see the phase log further down) because it's a different kind of
evidence — a real person using the real thing, not an automated script.

## Feedback, as given

**Invite link and navigation**
- The copied invite link doesn't let a new player join properly.
- Join mode still showed "Start a table / Create room" — should read "Join
  a table / Join room".
- Home, join, and room pages need distinct URLs and correct browser-history
  navigation.
- Needs an explicit "back to home" button, not dependent on refresh.
- An invite link opened in a separate browser should prefill the room
  code, let the new player fill in a nickname and pick an *available*
  color, then join.
- The same browser, already holding an identity for that room, should
  restore that seat rather than show the join form again.
- The invite link must never carry player credentials.

**Identity recovery and room lifecycle**
- Host identity can currently be lost after a refresh, back navigation, or
  reopening — leaving everyone waiting on a host who can't start the game.
- Fix persistent identity recovery; host authority is whatever the server
  has on record, not inferred client-side.
- The lobby needs a "Leave room" action; the host additionally gets
  "Disband room", which needs confirmation.
- Leaving voluntarily releases the seat immediately; if the host leaves,
  host authority passes to the next player by join order.
- When the last player leaves, the room closes; an old invite link should
  say so, not look broken.
- "Back to home" only navigates — it must not implicitly leave the room;
  home should offer a way back into the current room.

**Closing the page**
- Use a heartbeat and server-side offline detection — don't leave the room
  directly off the browser's unload event.
- In the lobby, a disconnect should hold the seat and identity for a 60
  second grace period before anything happens.
- Returning within the grace period restores the original identity;
  past it, auto-leave fires, with host transfer per the rule above.
- Multiple tabs: as long as *one* stays connected, it must never look like
  a leave.
- A game already in progress keeps its existing disconnect-tolerant
  policy — no auto-removal, no auto-skip, that part doesn't change.

**Ready mechanism**
- The lobby needs a Ready / Cancel-ready control per player, with
  everyone's status visible.
- The host can only start once there are at least 2 players and *everyone
  currently present, host included,* is ready.
- A newly-joined player defaults to not ready; start-eligibility is
  recalculated after a host transfer, not cached.
- The server enforces readiness and start-eligibility itself — disabling
  the button client-side isn't enough.
- A disconnected player must never count as an online, ready player for
  the purpose of starting.
- The lobby should name who isn't ready yet (or show the count), not just
  say "waiting for host".

**Verification asked for**
Reproduce each problem before fixing it. Then, using independent browser
contexts: (1) copy the invite link and have a new player join directly;
(2) the join page's title/buttons/back-to-home are correct; (3) the host
recovers identity and authority after a refresh, a back navigation, and a
reopen-within-grace-period; (4) a voluntary leave, a host leaving (and
transfer), and a host disband all work; (5) closing past the grace period
releases the seat, while a plain refresh never does; (6) the game can't
start until everyone's ready, and can once they are; (7) two tabs don't
produce a false leave; (8) check all of this at both desktop and phone
widths.

Also asked: add tests that protect this behavior, record the feedback and
fixes in this file and in CLAUDE.md, and — explicitly — don't write the
student's reflection, and don't claim on the student's behalf that they've
personally verified the fix.

## Reproducing before fixing

Two of the reported problems were reproduced directly, with evidence,
before any fix was made:

1. **The invite-link copy control lies about succeeding.** The handler
   called `navigator.clipboard.writeText(shareLink)` with no `.catch`, and
   unconditionally set the link's text to "copied!" regardless of outcome,
   while also `preventDefault()`-ing the anchor so there was no fallback
   way to reach the link at all. Reproduced in a fresh browser context
   with clipboard permission denied (the realistic default, not an edge
   case): the UI showed "copied!" while `navigator.clipboard.readText()`
   immediately after returned `NotAllowedError: Read permission denied` —
   i.e. nothing was actually on the clipboard, and the UI had no way of
   knowing or saying so. A player pasting "the invite link" in this state
   is pasting whatever was already in their clipboard, not the room. This
   is almost certainly the direct cause of "the copied invite link doesn't
   let a new player join".
2. **Landing on the bare `/` with an existing room session in
   localStorage offers no way back to it.** Reproduced: create a room as
   host, then navigate to the plain origin (no `?room=`) — the home screen
   shows only "Start a table / Create room", with no mention of the room
   that still exists and is still waiting on this exact browser as its
   host. Confirmed by inspecting `public/app.js`: the only history call in
   the whole file was a single `history.replaceState` on room creation,
   with no `pushState` anywhere and no `popstate` listener at all — so
   there was never a code path that could offer "back to your room" or
   react to the browser's own back/forward buttons. A host who ends up
   back at this screen for any reason (typed the bare URL, an old
   bookmark, a link shared without the `?room=` parameter) has no
   indication their room still exists, and could easily create a second
   room by mistake — leaving the first room's host seat unreachable from
   that device, matching "everyone waits on a host who can't start"
   exactly.

The remaining reported problems (ready gating, disconnect/grace handling,
leave/disband/host-transfer, distinct URLs) don't yet exist in the app at
all — there's nothing to "reproduce" there beyond confirming the gap by
reading the code, which the above already does for the navigation half.
They're designed and built fresh below, not patched.

## Fix plan

- **Presence**: a heartbeat endpoint, written to a small table kept
  separate from the versioned room-state blob — a heartbeat every few
  seconds per player would otherwise contend with the optimistic-
  concurrency version check every other action already relies on (see
  CLAUDE.md). "Connected" is computed at read time from how recently a
  player's heartbeat landed, never stored as a stale boolean.
- **Lobby disconnect grace (60s)**: evaluated lazily — on every read or
  action for a room, not via a background timer — as a function of
  "now minus last heartbeat". This matches how the app already behaves
  under Fly's `auto_stop_machines`: there's no process running to miss a
  timer in when the machine is asleep, so a purely time-based, read-time
  check is the only version that's correct regardless of whether anyone
  was watching.
- **Ready + leave + disband + host transfer**: new endpoints, all
  lobby-only, all re-validated server-side (never just a disabled
  button). Host transfer picks the remaining player with the lowest seat
  number (join order). Last player leaving closes the room
  (`rooms.closed_at`), checked by every endpoint afterwards.
- **Router**: a single `route()` function driven by the URL and a
  `popstate` listener, so the browser's own back/forward buttons and an
  explicit "back to home" button go through the same code path instead of
  the ad hoc `replaceState`-once approach that caused the bug above.

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

- [x] 1. Scaffold: dependencies, real Dockerfile (replacing the busybox
      placeholder), `src/` layout, `/readme/` rendering `README.md` as real
      HTML (not HTML-escaped `<pre>`).
- [x] 2. Spec tests for room lifecycle, turn engine, and settlement
      (`spec/rooms.test.ts`, `spec/turn-engine.test.ts`,
      `spec/settlement.test.ts`). **Not written red-first** — see the
      progress log; the engine was built and hand-verified (manual curl,
      then a scripted full-round driver) before these were formalized, so
      they passed on first run rather than red-to-green.
- [x] 3. Room lifecycle: create, join (code/link, nickname+color, capacity,
      unique colors), host-only start (closes seats), rejoin.
- [x] 4. Turn engine: server-rolled dice, choose-and-place validation,
      turn/phase enforcement, idempotent against duplicate requests.
- [x] 5. Settlement: tie cancellation, descending bill distribution,
      unclaimed bills to bottom of deck, won-bills list tracked per player
      (not just a total) so the final project can judge same-amount ties.
      Verified against the official rulebook's own worked examples (see
      spec/settlement.test.ts's contract check, not a copy of the
      examples' exact numbers).
- [x] 6. Public API sanitization: no `session_secret` (never in
      `RoomState` at all, not just stripped at the boundary), no future
      deck order (only `deckSize` is exposed).
- [x] 7. Minimal client UI: lobby, table view, roll/place controls,
      explicit copy on the public-winnings deviation and the
      browser-storage recovery limit. Plain JS/HTML/CSS, no build step,
      no framework — functional, visual identity intentionally left
      unfinished (product decision 5, and the crit's own "polish can
      wait"). Verified in a real headless-Chromium run, not just by
      reading the code — see the progress log for the two real bugs
      that caught.
- [x] 8. Verification: state survives a local process restart. (Wrong-secret
      rejection and duplicate-request safety are already covered by
      spec/turn-engine.test.ts and spec/rooms.test.ts.) A real
      `flyctl deploy` restart check is part of phase 9.
- [x] 9. Deploy, verify live spec (`/`, `/readme/`, a full room lifecycle
      against the deployed app, including a redeploy persistence check).

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
- 2026-10-03: stack scaffolded (Hono, better-sqlite3, marked). Hit
  pnpm's native-build gate for `better-sqlite3`
  (`ERR_PNPM_IGNORED_BUILDS`) — the template's `pnpm-workspace.yaml`
  already had a placeholder for exactly this (`allowBuilds:
  better-sqlite3: set this to true or false`), set to `true`.
- 2026-10-03: room lifecycle, turn engine and settlement written and
  hand-verified first (manual curl round-trip, then a scripted full-round
  driver over HTTP) *before* the formal spec tests — process note, since
  this isn't the red-first order the course asks for by default. Caught
  one real bug this way: the room's deck was never seeded with the 54
  banknotes at creation (`emptyState()` initialised `deck: []`), so the
  very first `start` call failed trying to deal from an empty pile —
  fixed by seeding `freshDeck()` at room creation.
- 2026-10-03: added `spec/rooms.test.ts`, `spec/turn-engine.test.ts`,
  `spec/settlement.test.ts` (23 tests total). All passed on first run
  against the already-working implementation above — not a red-to-green
  story for this phase. The settlement test drives 24 full random rounds
  and asserts the tie-cancellation/descending-bill contract per-casino
  (via a `payout` field added to the public API specifically so this is
  checkable black-box rather than needing to import internal game
  logic); it also asserts at least one real tie was observed across
  those 24 rounds, which held on the first run.
- 2026-10-03: `pnpm check` green (typecheck + 23/23 tests) against the
  real app, replacing the placeholder's trivially-green baseline.
- 2026-10-03: manually verified restart recovery, since vitest's
  global-setup only waits for an app to be running once, not across a
  mid-suite restart — created a room, started it, had the host roll (a
  mid-turn, not-yet-placed state, the trickiest point to recover), then
  force-killed the process and started a fresh one against the same
  `DATA_DIR`. The room came back byte-for-byte identical (same
  `version`, same pending roll); Bob rejoined with his original
  `session_secret`; the host's pre-crash pending roll could still be
  placed afterwards, correctly advancing the turn. (Hit a Windows/Git
  Bash wrinkle doing this: `kill -9 <bash PID>` doesn't reach the
  underlying `node.exe` process — had to find and `taskkill //F` the
  real PID via `netstat`/`tasklist`.)
- 2026-10-03: built the client UI (plain JS, no framework/build step) and
  verified it by actually driving it in headless Chromium (no
  project-level run skill existed yet; no `chromium-cli` on this
  machine either, so set up a throwaway Playwright install outside the
  repo and wrote a small driver script) — two browser contexts, host +
  a second player, through create -> join -> start -> several real
  roll/place turns. Caught two real bugs this way that reading the code
  hadn't:
  1. Clicking a color swatch called a full `build()` re-render, which
     created a brand-new (empty) nickname `<input>` — selecting a color
     after typing a nickname silently wiped it. Fixed by updating the
     swatch's `selected` class in place instead of rebuilding the form.
  2. The "Start game" button was disabled with 1 player but **stayed
     disabled with 2** — `el()`'s generic attribute setter did
     `setAttribute("disabled", null)` for the "should be enabled" case,
     which stringifies to the literal attribute `disabled="null"`,
     still present and still disabling the button. Fixed `el()` to omit
     an attribute entirely for `null`/`undefined`/`false` rather than
     stringify it — a general fix, not a one-off patch, since every
     other boolean attribute in the app had the same latent bug.
  `pnpm check` stayed green (23/23) throughout.
- 2026-10-03: deployed the real app to `comp4020-final-shuyangyuzu-cmd.fly.dev`
  (replacing the placeholder, same Fly app/volume from before), then
  drove a full room lifecycle against the *live* URL: create, join,
  start, a complete round of real turns, rejoin, and a wrong-secret
  rejection — all over HTTPS, not localhost. Then redeployed a second
  time (no code change) specifically to check the volume survives a
  real deploy, not just a process restart: the redeploy log said
  "Updating existing machines" (not "Creating a... volume"), same
  machine id both times, and the room created before the second deploy
  was still there, byte-for-byte, afterwards — including a tie at
  casino 1 (two players placed 2 dice each) correctly paying out
  nothing, independently reconfirming the settlement rule on the live
  deployment, not just in the test suite. Repo stayed private; no
  `/ship` run.
