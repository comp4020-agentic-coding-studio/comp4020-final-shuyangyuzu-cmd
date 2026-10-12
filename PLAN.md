# Final-project pivot (2026-10-05) — Vegas becomes one table in a shared bar

Documentation update (6 October): at the student's explicit request, an agent
drafted README.md, rewrote PROCESS.md and created reflections/crit-8.md in the
first person from the student's recorded decisions and feedback. The documents
separate agent verification from student acceptance, preserve implementation
attribution and identify ordering/seating as unfinished. Drafting assistance is
disclosed in PROCESS.md. README: 544 words; PROCESS: 946; reflection: 285.
pnpm check passed 88 tests; pnpm check:evidence passed, including 12 commit
references. No ship/publication action is included in this documentation work.

The student is changing the final project's direction: the existing Las
Vegas dice game becomes one game table inside a shared virtual bar,
inspired by Red Dead Redemption 2's saloon — friends walk in, order at
the counter, sit at tables, and go play a game at one of several tables.
Texas hold'em, dominoes, and blackjack are reserved table slots this
week, clearly marked "not yet open," built out in later crit weeks (9–11,
same repo, cutoffs Oct 12/19). Crit 8 itself (cutoff Wed 7 Oct 13:30, ~2
days out at the time of this pivot) has its technical proof-of-life foundation
in the deployed Vegas game (alive, persists, deployed). Submission additionally
requires the README, process overview, reflection and publication; the deployed
game alone does not satisfy every Crit 8 requirement.

A full proposal (layout sketch, identity/table/room/seat relationships,
invite-link handling, data model, phased priorities, open questions) was
written and approved before any code changed — see the personal plan
scratch copy for the full write-up; what matters for the repo's own
record is the **decisions** below, since those are what the build is held
to.

## Decisions (confirmed with the student)

- **Scope, additive not a rewrite.** `rooms`/`sessions`/`presence`/
  `events` and all 52 existing tests are untouched. The existing
  `/?room=CODE` direct entry to a Vegas game keeps working throughout —
  there is always a demoable, already-verified path even mid-build.
- **Two separate identity layers, never merged.** A *bar* identity
  (nickname/color/position, scoped to the bar) is new and distinct from a
  *game room's* player record. A patron can be bar-present without being
  seated at any table; being seated at a table's game still goes through
  the existing, unmodified room/session/ready/leave/disband logic.
- **Physical table vs. game room.** A table (`VEGAS #1/#2/#3`, plus 3
  reserved slots for Texas/dominoes/blackjack) is a fixed fixture that's
  never created or destroyed — it just points at whichever game room is
  *currently* open there, or none. Closing a room clears that pointer;
  the old room row is never deleted or overwritten, and a new game at the
  same table is a new row.
- **One active table at a time**, enforced server-side on the bar
  identity: starting or joining a different table while already seated
  somewhere open is refused until the player explicitly leaves first
  (reusing the existing `/leave` endpoint, unchanged).
- **Movement: grid-tile steps**, 8-directional, one tile at a time,
  identical interaction on desktop and phone (tap/click a walkable tile;
  clicking an interactive tile — counter, table, seat — acts instead of
  walking). The server only ever validates "is this tile adjacent and
  walkable" — no pathfinding, no continuous-collision math.
- **Visual direction: a warm, recognisable pixel-art tavern from week
  one** — dark wood floor, a wooden bar counter, round tables, chairs;
  patrons as simple but recognisable small figures carrying their
  nickname and colour. Spatial language from Stardew/Gather, atmosphere
  inspired by RDR2's saloon, **no assets copied from either** — original
  tiles/sprites, drawn in code or hand-authored and committed, not an
  imported tileset (keeps provenance unambiguous; an external asset would
  need a stated, checked licence and recorded source — none supplied).
  Kept simple: no complex lighting, no large asset volume, no fine
  animation this week — just clearly readable and tappable at phone
  width.
- **Bar-identity colour palette is separate and larger than the Vegas
  table's 4** — the bar isn't capped at 4 patrons just because a Vegas
  table is capped at 4 players.
- **Position sync stays at ~1.5s polling** — same architecture as the
  existing game-state poll, no change. (~1s and real-time sync are later,
  explicitly deferred upgrades, not this week's work.)
- **Final priority order for this week (the student's call, in this exact
  order):**
  1. Bar shell: visuals, movement, shared positions, identity recovery.
  2. At least 2 independently-playable Vegas tables, aiming for 3 —
     select/join/return-to-bar, live player count and status per table.
  3. Simple menu and ordering.
  4. Dining/bar seats and eat/drink status.
  5. Extra decoration and animation.
- **Cut order if the deadline bites (confirmed): decoration → animation/
  eat-drink presentation → defer ordering/seating (3–4) entirely if
  needed. Never reduce the table count below 2 for the sake of visual
  polish** — table count explicitly outranks decoration and ordering.

## Minimal data model (additive — new tables only)

```sql
CREATE TABLE bar_players (
  id TEXT PRIMARY KEY, nickname TEXT NOT NULL, color TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  current_table_id TEXT,      -- which table's game they're in, NULL if free
  current_seat_id TEXT,       -- which bar/dining seat, NULL if standing
  created_at TEXT NOT NULL
);
CREATE TABLE bar_sessions (player_id TEXT PRIMARY KEY, session_secret TEXT NOT NULL);
CREATE TABLE bar_presence (player_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL);

-- Fixed furniture, seeded once, never created/deleted at runtime.
CREATE TABLE tables (
  id TEXT PRIMARY KEY, game_type TEXT NOT NULL, available INTEGER NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  current_room_id TEXT         -- FK into existing rooms.id; NULL = free
);
CREATE TABLE bar_seats (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
  occupied_by TEXT             -- bar_players.id; NULL = free
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, item TEXT NOT NULL,
  price INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE  -- a duplicate request can't double-order
);
```

These are brand-new tables, so `CREATE TABLE IF NOT EXISTS` is actually
sufficient (unlike the `closed_at`-column bug earlier — that was a column
added to a table that already existed in production). Still adding a
regression test built against today's real production schema, mirroring
`spec/db-migration.test.ts`, rather than assuming safety from the pattern
alone.

## Execution discipline for this pivot

Phased, verify-before-continuing, never batching multiple phases into one
undemonstrated deploy: implement a phase → `pnpm check` green → Playwright
verification of that phase → deploy → live re-verification against
*production* (not just localhost) with the visible version number and
screenshots → only then start the next phase. Every verification report
states actual pass/fail per item and is marked **"等待用户验收"** (awaiting
the student's own check) until they confirm it themselves.

## Phase 1 — built: bar shell (visuals, movement, identity, sync)

New, additive-only (`src/barLayout.ts`, `src/bar.ts`; `tables`,
`bar_players`, `bar_sessions`, `bar_presence` in `src/db.ts`) — none of
`rooms`/`sessions`/`presence`/`events` touched. `src/barLayout.ts` is the
single source of truth for the floor plan (20×10 grid, 32px tiles): the
bar counter, 5 stools, 3 dining tables, and the 6 game-table slots (3
Vegas, playable; Texas/dominoes/blackjack, reserved and labelled "not yet
open"), seeded once into `tables` and never touched again except by
Phase 2's `current_room_id` updates. Movement is grid-tile, server-
validated (`isValidStep`: adjacent and walkable only, no pathfinding).
A stale heartbeat removes a patron's avatar from `GET /api/bar/state`
without ever deleting their `bar_players` row — identity, any future
table membership, and any future order all survive exactly as PLAN.md's
decisions specify.

Client (`public/app.js`): a procedurally-drawn warm wood-tavern scene on
`<canvas>` — no imported tileset, no copied assets, drawn entirely in
code (CLAUDE.md). Bare `/` is now the bar; the classic create/join-by-
code panel (exactly the old Home screen's content) sits directly below
the canvas, unmodified in behavior, so direct access to the current game
never regressed during this phase. `/?room=CODE` is completely
untouched — still the old full-takeover flow, bypassing the bar
entirely, deliberately deferred to Phase 2's overlay design.

**Two real bugs found before trusting this, neither caught by the first
pass of automated tests:**
1. `bar.ts`'s `joinBar` validated colors against the *game's* 4-color
   `COLORS`, not a bar-specific palette — joining with any of the 4
   extra bar colours (purple/teal/orange/pink) silently 400'd at the
   join step, which only surfaced as a confusing downstream 403 on the
   next request (since the client never got a real session). Fixed with
   a proper `BAR_COLORS` (8 colours) in `src/bar.ts`, matching
   `public/app.js`'s own list — there's no shared module between server
   and this plain-JS client to enforce that automatically, so
   `spec/bar.test.ts` exercises several of the non-game colours against
   the real endpoint specifically to catch drift.
2. Clicking a far-away or non-game-furniture tile fired a request the
   server correctly rejected (409) — but logged as a failed network
   request regardless of the app handling it gracefully, caught by a
   Playwright console-error check. Fixed properly rather than loosening
   the check: added a client-side pre-check (`STATIC_FURNITURE_RECTS` +
   an adjacency test against the player's last-known position) so an
   obviously-invalid click is just a local status message, never a
   round trip — the server's own validation is unchanged and still the
   actual authority, this just avoids asking it something already known
   to be invalid.

9 new tests (`spec/bar.test.ts`, `spec/barLayout.test.ts`, 4 more in
`spec/db-migration.test.ts` built against today's real production
schema) — 71/71 passing. Playwright verification: canvas renders,
identity setup → enter → canvas (no re-setup needed), refresh recovers
identity, two separate patrons both appear in the shared state, clicking
a reserved table shows its label, clicking a Vegas table correctly says
"Phase 2", classic panel still fully functional, no console errors, no
horizontal overflow and a correctly-sized canvas at 390px phone width.

**Deployed and re-verified live**, not just locally: Fly release v8,
image `deployment-01M4615FJ1GYV4PETDKM85XZN6`, visible version
`46172aa693` (matches `/version` and the on-page `build …` corner label
in every screenshot from this run, so any screenshot's build is
independently checkable). The exact same 11-check Playwright run above,
re-pointed at `https://comp4020-final-shuyangyuzu-cmd.fly.dev`: all 11
passed against production. Repo stayed private; no `/ship`.

**This is the agent's own automated re-verification, immediately after
deploying — not the student's own check.** Status: 等待用户验收.

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

## What was built

Server: `ready` + `joinedAt` on `Player`; `startGame` now requires every
*currently connected* player ready, host included (`src/game.ts`). New
`src/presence.ts` (heartbeat table, separate from the versioned state
blob on purpose — see above), with `isConnected`/`isPastGrace`/
`pickNextHost` as pure, directly unit-tested functions
(`spec/presence.test.ts`). A lazy sweep in `src/rooms.ts` applies the
60-second lobby disconnect grace on every read or action, never on a
started game. New endpoints: `heartbeat`, `ready`, `leave`, `disband`
(host-only, requires an explicit `confirm`, lobby-only). Closed rooms
are a first-class state (`rooms.closed_at`): `GET /state` still answers
200 with `closed: true` rather than erroring, every mutating endpoint
refuses with 410 `room_closed` (distinct from 404 `room_not_found`).
22 new tests; 45/45 passing (`spec/presence.test.ts`,
`spec/lobby.test.ts`, existing tests updated to ready-up before
starting since start now requires it).

Client (`public/app.js`, full rewrite): a single `route()` dispatcher on
the URL + `popstate`, so back/forward and an explicit "back to home"
button (navigates only, never leaves the room) behave correctly. Home
offers "return to that room" when a session for one still exists.
Invite-link copy tries the Clipboard API and falls back to a visible,
selectable field on any failure, rather than lying "copied!" (the
reproduced root cause). Join form hides/disables taken colors and shows
a distinct "room closed" / "already started" message instead of a
join form where neither would make sense. Lobby adds Ready/
Cancel-ready (names of who isn't ready, not just "waiting for host"),
Leave, and host-only Disband with a confirm dialog. A 5-second
heartbeat loop runs while the page is open; nothing is wired to
`unload`/`beforeunload`.

**Bug found during verification, not anticipated in the design above:**
clicking Ready, Start, Roll, or Place only updated the view on the
*next* poll tick (up to 1.5s later) rather than immediately — fixed by
having each action's handler force an immediate state refresh
(`refreshNow()`) right after its own request succeeds, in addition to
the regular poll.

## Verification

Playwright, driving two real browser contexts (plus a third for the
two-tab scenario and a fourth at a 390px phone viewport), against a
second local server instance started with short presence/grace windows
(`PRESENCE_STALE_MS`/`LOBBY_GRACE_MS`, both env-overridable — see
`src/presence.ts`) so the time-dependent behavior could be checked for
real rather than argued from reading the code. All 8 scenarios from the
feedback, 24 individual checks, all passed:

1. Copy invite link (clipboard permission granted this time) → a second
   browser opens it and joins directly; the join page read "Join room
   CODE" / "Join", not "Start a table" / "Create room".
2. "Back to home" from the join page actually navigates to `/` and
   renders the home view.
3. Host: kept Start-game authority across a refresh; the home page
   offered, and correctly used, "return to that room" after landing on
   the bare `/`; a real browser Back-button press both changed the URL
   and re-rendered the table view (confirming `popstate` is wired up,
   not just that `pushState` was called somewhere).
4. A non-host leaving dropped them from the host's view immediately; a
   host leaving transferred Start-game authority to the next player by
   join order; a confirmed disband closed the room (checked against the
   API directly, not just the UI).
5. Three back-to-back refreshes never cost the host's own seat.
   Actually closing a second player's tab (no unload handler fires —
   the heartbeat loop just stops) and waiting past the grace period did
   release their seat.
6. Start stayed disabled with nobody ready, stayed disabled with only
   one of two players ready, and enabled only once both (host included)
   were — then actually started the game.
7. A second tab for the same browser/identity recognized the existing
   seat instead of re-joining; closing one of the two tabs while the
   other stayed open did not cost the seat.
8. At 390px width: no horizontal overflow, no console errors.

This is the agent's own verification, over an automated browser, not a
claim that the student has personally retested the deployed app — see
"Retest steps" below for that.

## One more bug, found deploying — not caught by any of the above

The first deploy of these fixes 500'd on `start`, `join` (on a closed
room), and silently dropped the new `closed` field from every state
response, despite every local test and the entire Playwright run above
passing cleanly first. Cause: `CREATE TABLE IF NOT EXISTS rooms (...,
closed_at TEXT, ...)` in `src/db.ts` is a no-op against a `rooms` table
that **already exists on disk** — it does not retroactively add a
column a later version introduces. Every local test run always started
from `rm -rf data` (a fresh database every time), and even the tuned-env
Playwright server in the section above used a fresh `./data` — so this
specific failure mode, "a column added after the table already existed
in production", was never actually exercised until it hit the real,
already-deployed Fly volume (live since the crit 8 placeholder deploy).

The live 500s against the deployed app were the reproduction. Fixed with
`addColumnIfMissing` (checks `PRAGMA table_info` before an `ALTER
TABLE`, rather than relying on `CREATE TABLE IF NOT EXISTS` to cover a
schema change to a table that already exists), then verified the fix
properly before redeploying: built a local database by hand in the
exact pre-`closed_at` shape the first deploy would have left, and
confirmed opening it with the fixed `openDb` adds the missing column
and the `presence` table rather than erroring. Added as a permanent
regression test (`spec/db-migration.test.ts`) rather than a one-off
manual check, since this is exactly the kind of bug that only a test
against a *pre-existing* database — not a fresh one — can catch, and
every other test in this repo starts from a fresh one.

Redeployed with the fix and re-ran the same live checks directly
against the deployed API: ready-gating, host transfer, room closing,
and the distinct 410 on a closed room all now behave correctly in
production, not just locally. `/` and `/readme/` still serve; the repo
is still private.

## A third bug — found by the student, not by any of the agent's own checks

The student personally checked the deployed app and still saw the old
behavior (the old "Join instead" wording, no Ready/Leave/Disband, no
"return to room" on home) *after* the redeploy above had gone out.
Investigated properly rather than re-running local tests, since local
tests and a fresh-browser-context Playwright run are structurally blind
to this exact failure mode:

1. Confirmed the right directory, the right commit, and the right Fly
   app (`flyctl status`/`flyctl releases` showed the latest release,
   matching image tag, deployed minutes earlier).
2. Checked the Dockerfile and `.dockerignore`: `public/` isn't excluded,
   there's no build step to go stale, nothing suspicious.
3. Fetched the **live** `/app.js`, `/`, and `/styles.css` directly
   (`curl`) and diffed them byte-for-byte against the repo's source —
   identical. The deployed server was serving the correct, current
   files the whole time.
4. So the gap wasn't the deploy — it was that **no response carried any
   `Cache-Control` header at all**. A browser that had visited the app
   before this round's changes could serve `app.js`/`index.html` from
   its own disk cache on an ordinary reload, with no request ever
   reaching the server to reveal anything had changed. The agent's own
   verification never catches this because every Playwright check (and
   every fresh `curl`) starts from an empty cache; a real returning
   visitor's browser does not.

Fixed with a blanket `Cache-Control: no-cache` middleware
(`src/server.ts`) — cheap for an app this size, and it forces a
revalidation request on every load rather than letting a browser reuse
a cached copy silently. `no-cache`, not `no-store`: the browser can
still keep the bytes, it just has to ask first.

Live verification this time was done directly against the production
HTTPS URL, not localhost: a fresh browser context created a real room,
a second fresh context opened the invite link and joined, checked the
lobby's Ready/Leave/Disband buttons and the home page's "return to that
room" banner, left, and disbanded — 12/12 checks passed, confirmed via
screenshots and by reading the room's `closed` state back from the live
API after disbanding, not just the UI. Deployed version: Fly release
v6, image `deployment-01M41767MQMFKHSTQ7D959ZW9K` (`flyctl releases`).

One of the first screenshots in that run looked wrong on a quick look —
captured what seemed to be the pre-submit entry form right after
"creating" a room. Checked before reporting it as a bug: the test
script's own wait condition (`waitForSelector("text=Room ")`) matched
home's own "Have a room code?" text (a case-insensitive substring match
— "Room " is literally inside "Room code"), so it resolved instantly
and raced ahead of the real navigation; a corrected wait
(`button:has-text('Ready')`, which only exists in the lobby) showed the
lobby rendering correctly all along. Noted here rather than silently
dropped, since almost reporting a false bug is itself worth a record.

## The student's own retest still failed — caching, more precisely this time

The student retested personally and still saw the old join interface;
an ordinary refresh didn't fix it. Reasonable, and right to push back:
"deployed + my own checks pass" is not the same claim as "fixed", and
the previous report shouldn't have left room to read it that way.

Re-checked the live headers directly before changing anything (not
assumed): `Cache-Control: no-cache` **was** present on `/`, `/app.js`,
and `/styles.css` in production at that moment, and the files were
still byte-identical to source. So the no-cache middleware itself
wasn't broken — it just isn't sufficient on its own. `no-cache` governs
what a browser does with a *future* response; it does nothing to a
response the browser already has sitting in its cache from before this
app ever sent that header. A browser that cached `app.js` on an earlier
visit (while the student was testing across several of today's
deploys) can keep reusing that cached copy on an ordinary reload
indefinitely, with no new request ever reaching the server to reveal
anything changed — exactly matching "ordinary refresh didn't resolve
it".

Fixed properly this time with cache-busting, not another header:
`src/version.ts` computes a short hash of the actual deployed
`app.js`+`styles.css` bytes at startup; `/` is now server-rendered
(templating `public/index.html`) so that hash lands in the script/link
URLs (`?v=<hash>`) and is shown visibly on the page itself. A different
URL is a different cache entry to every HTTP cache — this sidesteps the
whole question of whether a given browser honors `no-cache` correctly
for an old entry, rather than depending on it.

**Verified the actual before/after transition this time, not just that
the new code works in a fresh browser** — the gap in the previous
round's evidence: built a persistent Playwright browser profile,
pointed it at the *live* production site *before* deploying this fix,
and let it cache `/`, `/app.js`, `/styles.css` exactly as a real
returning visitor would. Deployed the fix. Reloaded **that same
profile** — ordinary `goto`, no cache clearing, no hard refresh — and
confirmed via the actual network requests made (not just the rendered
page) that it fetched `/app.js?v=d9c58e7de2` and
`/styles.css?v=d9c58e7de2` as fresh requests, and that this previously-
stale browser profile now sees Ready/Leave/Disband and the correct join
page.

Then ran the student's full 6-item acceptance list again, against
production, with screenshots for each:

1. Home → entering a room code (current source's equivalent of "Join
   instead" — see the terminology note below) → title "Join room
   CODE", button "Join", not "Create room". **PASS.**
2. Invite-link field's URL, opened in a separate browser, seats the
   new player. **PASS.**
3. Host authority recovers after a refresh, after "Back to home" then
   "Return to that room", and after closing the page and reopening at
   the room URL directly. **PASS** on all three.
4. A non-host can leave voluntarily (host's view updates); the host
   leaving transfers authority to the next player by join order.
   **PASS.**
5. Host disband closes the room, confirmed against the live API's
   `closed` field, not just the UI. **PASS.**
6. Start stays disabled with nobody ready, stays disabled with only
   one of two ready, enables once both (host included) are, re-disables
   on "Cancel ready", and the game actually starts once satisfied.
   **PASS** on all five sub-checks.

16/16 checks passed. The visible version (`build d9c58e7de2`) appears
in every screenshot from this run, so it's independently checkable
which build each screenshot is actually showing — not just taken on my
word. Deployed as Fly release v7, image
`deployment-01M418DGN8XER5W8ABWX73R2YH`.

**Terminology note, asked about directly**: the student's acceptance
item 1 says "点击 Join instead" — current source has no control with
that literal text. The original "Join instead" toggle-link was replaced
during the client rewrite with a separate "Have a room code?" text
field + "Go" button on Home (same underlying behavior: enter a code,
land on the join form). If what was seen and tested was literally a
"Join instead" link, that was a stale cached build showing pre-rewrite
UI, not a different, unfixed code path in the current source — the
screenshots above show the current, equivalent flow instead.

**This is the agent's own automated re-verification, immediately after
deploying — not the student's own retest.** Status: awaiting the
student's own check in their own (already-cached) browser before this
is called resolved.

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
# Interface correction — 6 October 2026 (Codex implementation)

The user rejected the Phase 1 form-led homepage and requested a Gather-like
spatial interface: a floating nickname/character editor, independently chosen
clothes and skin tone, direct entry into a larger map, and a camera following
the character. This replaces the earlier whole-map-in-a-webpage presentation.

Implemented in the existing repository: original code-drawn pixel characters
and tavern fixtures; full-screen viewport; 40×24 world definition served to the
client; following camera; keyboard/touch steps and client-side path planning
for click-to-walk; existing server adjacency checks; persisted skin tones with
an old-schema regression check; classic game entry moved to a secondary overlay.
Fixture coordinate updates preserve existing room pointers. New client module
bytes are included in the asset hash and module URL versioning.

This is a visual/navigation correction. Physical table-to-room binding,
ordering and seating remain the previously planned subsequent phases. Clicking
a Vegas fixture currently opens the existing game entry overlay, rather than
claiming each fixture already has an independent room. No research narrative or
reflection is authored here. User visual acceptance is still pending.

Verification: Codex ran pnpm check (73 tests passing), checked the avatar editor, appearance changes, entry, click-to-walk, camera movement and desktop/mobile layouts in the browser. Deployed build feb2afbb5b and verified its editor and movement on the production HTTPS page. The original random-roll test assumed eight dice cannot show all six faces; corrected its setup to advance legal turns until a missing face is guaranteed, without changing game rules. No claim of user acceptance is made.

The user subsequently confirmed the visual improvement and requested continuous
movement while holding a direction button. Direction controls now start on
pointerdown and reuse the existing animation-driven, server-confirmed stepping
loop. Release, pointer cancellation, leaving the button, window blur and hidden
document stop the hold; a normal tap retains one step. Touch controls suppress
browser gestures and selection. Event listeners are removed on navigation.
Verification: pnpm check passed 78 tests; the five new direction-control event
tests also passed after refining cancellation cleanup. These are automated event
tests, not a claim of a physical touchscreen long-press test.
Deployed build 7da04fb5c3; production /version and /tavern.js confirmed the
new version and hold handler. Fly machine health checks passed.

## Claude's independent review of the above (6 October 2026)

Picked this session back up on the student's instruction to read the
workspace properly before touching anything — `git status`/`git diff`
(including the two untracked files), this file, and `CLAUDE.md` — rather
than assume or reset. Nothing above was altered; this is a second set of
eyes on work already done, recorded separately so it's clear whose
verification is whose.

Independently re-ran `pnpm check` from a clean `rm -rf data`: 78/78,
matching Codex's count exactly. Read `public/tavern.js` and
`spec/direction-hold.test.ts` in full rather than taking the passing
count on trust: the pathfinding is a real client-side BFS, but every
tile along a found path is still submitted and awaited as its own
`/api/bar/move` call — the server's per-step adjacency check (unchanged
since Phase 1) is still what actually allows or refuses movement, not
the client's path. The direction-hold cleanup (`bindDirectionHold`)
covers pointerup anywhere, pointercancel, pointerleave, window blur, and
document visibilitychange — matching CLAUDE.md's new constraint on this.

Also drove it in a real (automated) browser, not just read the source:
character editor renders correctly, "Step inside" enters the world,
holding a d-pad arrow for ~1s visibly moved the character several tiles
before release — confirming the hold mechanism produces real continuous
movement, not just that its event listeners are wired correctly in
isolation. **This is still an automated pointer-event simulation, the
same caveat as above — not a physical touchscreen test**, and is not
reported as one.

No corrections needed to Codex's work or to the entry above — moving on
to Phase 2 (per-table room binding) on this foundation.

## Phase 2 — built: each Vegas table bound to its own independent room

New `src/tables.ts`, additive only — no change to `rooms`/`sessions`/
`presence`/`events`, or to any of `src/rooms.ts`'s own logic. A new
`bar_players.current_game_player_id` column (migration) is the only
link between a bar identity and which game-room player row they became
when seated — the two identity spaces stay separate (CLAUDE.md), but
"one table at a time" needs *some* way to check "is this patron still
genuinely in that room," and this is it.

A physical table's `tables.current_room_id` pointer is cleared lazily,
at the next status read, once the room behind it closes — the same
lazy-not-background-swept pattern `src/rooms.ts` already uses for its
lobby grace period, and for the same reason (correct regardless of
whether anything was running to notice in between, under Fly's
`auto_stop_machines`). Re-clicking the table you're already seated at
returns your existing seat rather than minting a second player row for
yourself — caught and fixed before it shipped (see below).

Client (`public/tavern.js`): clicking an available Vegas table now reads
that table's live status fresh (empty / waiting / in-progress / round
over) and offers exactly the one legal action — create or join — rather
than the generic classic form. The bar nickname is reused automatically,
never re-asked; a separate, smaller colour picker (the 4 game colours,
not the bar's 8) is shown, with already-taken colours disabled rather
than left to fail server-side. On success it reuses the exact same
`saveSession`/`navigate` path the classic form already used, landing in
the same, completely unmodified lobby/ready/host/invite/leave/disband
UI. The HUD's "Game rooms" button is relabelled "Join by code" now that
it's no longer the only way in. The game-room lobby's own copy was
tightened too: "Back to home" → "Back to the bar" (keeps your seat,
explicit now), "Leave room" → "Leave table" with a confirm dialog and an
explicit note distinguishing the two, directly per the student's ask
that returning to the bar and leaving the table read as different
things.

**One real bug caught before it shipped, by writing the test before
assuming the design was right**: the first version of the "one table at
a time" check treated re-clicking your own already-active table as an
error case indistinguishable from clicking a *different* occupied
table, which would have made `joinTableRoom` call `rooms.joinRoom`
again for someone already seated — minting a second, duplicate player
row for the same patron in the same room. Caught by actually writing out
the "re-click your own table" test case before trusting the function,
not by running it and getting lucky. Fixed with a three-way
`checkExistingSeat` (seated here → hand back the existing seat; seated
elsewhere → refuse; free → proceed) rather than a two-way check.

12 new tests (`spec/tables.test.ts`), each cleaning up its own room via
disband so the file's 3 shared real Vegas tables don't get exhausted by
earlier tests — 88/88 total passing. Manually smoke-tested every
transition by hand over curl first (create, second player join,
one-seat enforcement, idempotent re-join, disband freeing the table)
before trusting the automated tests to re-confirm it. Playwright,
end to end: clicking an empty table shows "is empty", creating lands in
the real lobby with the bar nickname carried over, going back to the
bar surfaces "Return to your game", a second patron sees "1/4 waiting"
with the first colour correctly disabled, and both end up in the same
real room — 7/7 checks passed. Also checked at 390px: no console errors,
no horizontal overflow, the world itself renders correctly (the
table-dialog's own click-target math at that exact viewport wasn't
independently confirmed this round — the dialog shares the character
editor's already-verified responsive markup and CSS, which is why this
wasn't treated as a gap worth blocking on, but it's not the same as
having clicked a table specifically on a small screen).

**Deployed and re-verified live**: Fly release v12, version `58cee56238`
(matches `/version` and the on-page corner label). The same 7-check
Playwright run re-pointed at `https://comp4020-final-shuyangyuzu-cmd.fly.dev`:
all 7 passed. Repo stayed private; no `/ship`. This is the agent's own
re-verification, not the student's own check — 等待用户验收.

# Crit 9 prep ("All at once") — 2026-10-09

Setup only, no implementation. Confirmed via `/comp4020:start`: next
deliverable is Crit 9, week 10, repo stays `comp4020-final-shuyangyuzu-cmd`
(no new clone), cutoff **Mon 2026-10-12 13:30**, crit session **Mon
15:30–17:00**, group **bada** — matches the student's own figures.

## Official requirements (crit page spec)

- Real-time, graded live: "a change one person makes reaches everyone else
  within about a second, without a reload" — pods open the app on separate
  devices simultaneously at the crit itself.
- Exactly one multi-user-behavior decision, picked by the pod, resolved
  against their own README's definition of "good," written down with
  alternatives considered and tradeoffs — an ADR is the suggested format,
  and the pod is expected to argue *against* the choice they made.
  Example decision points offered: what's live vs. reload-only, presence
  visibility, conflicting-edit resolution, what a returning user sees.
- Process evidence: commits that "grew with the work," `PROCESS.md`,
  `reflections/crit-9.md`.
- Must be able to account for how the AI-assisted work was directed,
  grounded and corrected.

## Current baseline, as read this session (nothing changed)

- Branch `main`, clean except untracked `src/orders.ts` — left exactly as
  found. It's a self-contained, unconnected ordering module
  (`placeOrder`/`getActiveOrder`/`MENU`): not imported by `src/server.ts`
  or `src/db.ts`, and the `orders` table from this file's own earlier data
  model section doesn't exist in `src/db.ts` yet either. Matches
  `PROCESS.md`'s own note that it's "an unconnected local `src/orders.ts`".
  Not touched, not wired in, not committed this session.
- `crit-8` tag: annotated, still resolves to `a706408` (confirmed via
  `git log --oneline --decorate`), untouched.
- Repo visibility: already **public** (`gh repo view` → `isPrivate:false`),
  carried over from the crit 8 ship.
- Fly: app `comp4020-final-shuyangyuzu-cmd`, one machine `started` in
  `syd`. Production `/`, `/version` (`58cee56238`, matching this file's
  last recorded deploy, Fly release v12), `/readme/` all answer 200.
  `Cache-Control: no-cache` present on `/`, `/app.js`, `/tavern.js`, per
  `CLAUDE.md`.
- `pnpm check` against an isolated temp `DATA_DIR`: 88/88. One
  24-random-round settlement test hit vitest's default 5s timeout on this
  machine on the first run; an isolated rerun of just that file passed in
  5.5s — a timeout flake, not a regression, confirmed before writing it
  down here rather than assumed.
- `pnpm check:evidence`: PASS — `reflections/crit-8.md` present, all 12
  commit references in `PROCESS.md` resolve.
- `comp4020:doctor`: 21 pass / 2 warn / 1 fail. Real fail:
  `core.hooksPath` unset (the committed-key guard is off — `pnpm install`
  restores it). Warns: plugin `comp4020` 0.14.22 installed vs. 0.14.27
  available; Git Bash platform warning (expected on this machine). Not
  fixed this session — setup only.

## Sync-path reality, read from the actual code (not yet changed)

- **Game view** (`public/app.js`): flat `setInterval(tick, 1500)`
  (`POLL_MS = 1500`), plus an immediate `refreshNow()` fired only after
  *the local player's own* ready/start/roll/place request succeeds.
  Another player's action is invisible to everyone else until the next
  ~1.5s tick — already short of "~1 second" for anyone but the actor.
- **Bar movement** (`public/tavern.js`): `poll()` explicitly returns early
  whenever `moving` is true
  (`if(!session||busyPoll||moving)return;`) — a patron's own in-flight
  step suppresses *all* state polling for its duration, so another
  patron's move, arrival, or (once wired up) order can be delayed well
  past 1.5s specifically while anyone is mid-animation. The heartbeat
  loop (5s, separate table per `CLAUDE.md`'s presence design) is
  unaffected — presence isn't the gap, state propagation is.
- **Last-seat race** (`joinRoom` in `src/rooms.ts`, and
  `checkExistingSeat`/`joinTableRoom` in `src/tables.ts`): better-sqlite3
  transactions run synchronously inside Node's single-threaded event
  loop, so two concurrent join requests for the last seat are not
  actually racy at the DB layer — whichever request's transaction runs
  first (effectively arrival order) commits the version bump and the
  seat; the second re-reads fresh state inside its *own* transaction and
  gets a deterministic 409 (`room_full`, `seats_closed`, or
  `color_taken` for a game room; the table's own occupied-elsewhere case
  for a Vegas table). The loser's client already surfaces that exact
  server message via the existing generic
  `catch { errorBox.textContent = err.message }` / `alert(err.message)`
  path (e.g. "this room already has its 4 players") — truthful, but not
  phrased as "you lost a race," and it only reaches the loser on their
  own join attempt's response or the next ~1.5s poll of a stale
  almost-full room, not pushed to them proactively.

## What ~1-second propagation would need, at minimum

- Shrinking both poll intervals (game and bar) well below 1500ms, and/or
- Changing the bar's "skip poll while moving" behavior so other players'
  updates still arrive during a local step — only the player's *own*
  locally-predicted tile needs protecting from being overwritten
  mid-step, not the whole poll, and/or
- A push transport (SSE), which `PLAN.md`'s own crit-8 stack section
  already names as "the planned upgrade for the final project's faster
  sync."
- Whichever path is chosen, `CLAUDE.md`'s "Scope discipline" line — "no
  sub-second real-time sync" listed there as explicitly deferred to the
  final project — is the one sentence in the harness file that this
  week's brief directly supersedes. It needs a deliberate edit once
  implementation starts, not a silent contradiction.

## The suggested decision question, checked against current code (not decided)

"Two people simultaneously going for the last game seat": already
resolved, deterministically, server-side — confirmed above, not assumed.
The open question for Crit 9 is not "is it safe" (it is); it's whether
~1.5–3s (poll interval, plus the bar's mid-move skip) before the loser
*finds out* is acceptable against this README's own "good," and whether
the existing message is sufficient or needs rewriting to name the race
plainly. Nothing decided or written up this session — this is prep, not
the decision record itself.

## Suggested implementation order (not started)

1. The transport change (shrink poll interval and/or move to SSE) first —
   "~1 second, no reload" is tested live at the crit and gates everything
   else.
2. Fix the bar's poll-skip-while-moving in the same pass — it's the one
   piece of code already confirmed to work against the ~1s goal.
3. Pick and write the one multi-user decision. The seat-race question
   above is a strong candidate precisely because it's already resolved in
   code — the work is an ADR (alternatives, tradeoffs, the required
   argument against the chosen path), not new logic.
4. `PROCESS.md` update and `reflections/crit-9.md`, citing only commits
   that exist once the above actually happens.
5. Deploy, then live re-verification with two real sessions open at once
   (matching how the brief says the crit itself will test it).
6. Tag `crit-9` only at the very end, after the student's own acceptance.
7. `src/orders.ts` stays untouched and disconnected unless the student
   decides otherwise — it isn't part of this crit's spec.

## Crit 9 implementation — phase 1: prep fixes (2026-10-09)

Before touching sync: the three problems the prep pass above surfaced,
investigated rather than papered over.

- **Pre-commit key guard.** `git config core.hooksPath` was unset despite
  `pnpm install` having just been run. Root cause: `pnpm install` reported
  "Already up to date" (nothing to install) and, on this pnpm version,
  skipped the `prepare` lifecycle script entirely when it has nothing to
  do — so the guard was never actually restored by the step the FAIL
  message implies. Running the `prepare` script directly
  (`pnpm run prepare`) then failed too, with "the system cannot find the
  path specified": pnpm runs `package.json` scripts through `cmd.exe` on
  Windows regardless of which shell invoked `pnpm`, and the script's
  POSIX syntax (`git rev-parse --git-dir >/dev/null 2>&1 && ... || true`)
  isn't valid there. Fixed directly with `git config core.hooksPath
  .githooks`, then verified for real — not just by reading the script —
  by staging a fake key and confirming the hook actually blocked the
  commit (`commit blocked: something staged looks like an API key`). Not
  proposing a fix to the template's own `prepare` script: it's shared
  course infrastructure, not this repo's code, and out of this week's
  scope.
- **`spec/settlement.test.ts` timing out at 5s.** Measured before
  changing anything: a dedicated timing probe against the running app
  showed the 24-round loop makes ~300+ real sequential HTTP round-trips
  (every roll/place turn of every player, until every hand is empty,
  repeated across 24 full games), and that running the 24 rounds
  concurrently (they're independent — each plays in its own room) cuts
  wall-clock by roughly half. The remaining variance came from
  contention: this test shares one single-threaded dev server with every
  *other* spec file's traffic in the same `pnpm test`/`pnpm check`
  invocation (vitest runs test files in parallel by default) — a real
  environment cost, not randomness in the test's own pass/fail logic
  (its assertions are deterministic; the only probabilistic part, "did 24
  rounds produce at least one tie," is a near-certainty and was never
  what was timing out). Fixed by parallelizing the 24 rounds with
  `Promise.all` and giving just this one test an explicit, commented 15s
  timeout sized for the realistic contended case — not a blind global
  bump. Verified stable at ~3.7–4.0s across three repeated full-`pnpm
  test` runs (12/12 files, 88/88 tests passing each time), down from
  timing out at the 5s default.
- **`comp4020` plugin.** Updated 0.14.22 → 0.14.27
  (`claude plugin update comp4020@comp4020`); the CLI reports this
  requires a session restart to take effect. Not restarted mid-task —
  nothing in the work below depends on the newer plugin version, and
  restarting would lose this session's context. Recorded here as the
  explicit handoff note the student asked for, in case a restart happens
  before this work is finished: prep fixes (this section) are done and
  committed; real-time sync, the spatial additions, and the decision
  record are not yet started as of this entry.

## Crit 9 implementation — phase 2 onward

Transport decision: **SSE** (`hono/streaming`'s `streamSSE`, already
available in the pinned `hono@4.13.12` — no new dependency), chosen over
WebSocket (bidirectional capability this app doesn't need, since every
write already goes through existing authenticated POST endpoints; would
need a new dependency and a hand-rolled reconnect) and over faster
polling alone (can't guarantee the "~1 second" worst case, and doesn't by
itself fix the bar's poll-skip-while-moving problem). Full comparison,
architecture (`src/live.ts` pub-sub, version/seq staleness rule, SSE
endpoints, client rewrites), the restroom/seat-visual spatial additions,
and the last-seat decision-record approach are recorded in the approved
implementation plan for this work; this section will be filled in with
what was actually built, measured, and found as each phase lands —
matching how every earlier phase in this file was recorded only after
being verified, not before.

## Crit 9 implementation — phase 2: built: SSE transport, additive

New `src/live.ts` (in-process pub-sub only — one Fly machine, no HA, no
broker needed): `subscribeRoom`/`publishRoom` keyed by room code,
`subscribeBar`/`publishBar` for the bar's single channel, plus a
module-level `barSeq` counter (`currentBarSeq`/`bumpBarSeq`) since the
bar has no single versioned row the way a game room's `rooms.version`
column already is. `rooms.ts`/`bar.ts`/`tables.ts` are untouched — every
`publish*` call lives in `src/server.ts`'s route handlers, right next to
the `return c.json(...)` of the state each route already computes.

Two new SSE endpoints (`hono/streaming`'s `streamSSE`, already inside the
pinned `hono@4.13.12` — no new dependency): `GET /api/rooms/:code/events`
and `GET /api/bar/events`. Each pushes a snapshot immediately on connect,
then on every relevant mutation, with a 20s keep-alive ping comment.
`GET /api/rooms/:code/events` on an unknown code synchronously throws the
same `RoomError` every other room route already does, caught by the
existing `app.onError` — 404, not a silently-open empty stream (verified
directly). Every bar response (`/state`, `join`, `rejoin`, `appearance`,
`move`) now carries `{seq, players, tables}` instead of just `{players}`
— additive, not breaking: the existing polling clients (unchanged this
phase) only ever read `.players`, so this is a safe, backward-compatible
step before either client is rewired in phases 3-4. Room mutations
(`join`, `start`, `leave`, `disband`, a `place` that ends the round) also
bump and broadcast the bar channel, since those are exactly the moments a
bound table's displayed status can change; `roll`, `ready`, and a `place`
that doesn't end the round deliberately don't, since they're the only
room mutations confirmed never to change what `tables.getTablesStatus()`
reports (checked directly, not assumed).

Manually verified before writing the automated test: `curl -N` against
both new endpoints, confirming the initial snapshot arrives immediately
on connect and a second, correctly-updated push arrives immediately after
a separate request mutates state (same `version`/`seq` the mutating
request's own response carries) — real streaming, not a buffered single
response. New `spec/live.test.ts` (4 tests) codifies this: a room push
after `ready`, a 404 on an unknown room's event stream, a bar push after
`move`, and that an unrelated bar join still advances the bar's own `seq`
monotonically. `pnpm check` (13 files, 92/92 tests) and `pnpm
check:evidence` both green.

**A real mistake, caught before committing, not after**: the first three
runs of `pnpm test` after writing `spec/live.test.ts` failed with 404s on
both new endpoints — not because the endpoints were broken, but because a
stale server process from earlier manual testing this session (started
*before* `src/live.ts`/the `server.ts` SSE changes existed) was still
listening on port 8080, and vitest's `global-setup.ts` happily reused
whatever was already there rather than noticing it was stale. Every
`pnpm test`/`pnpm check` run reported as passing earlier in this
session's Crit 9 work (including the settlement-test fix verification)
was therefore actually run against that same pre-SSE process the whole
time — it never saw any of the code written since. Found by checking
`netstat`/`tasklist` directly rather than assuming the 404s meant a bug
in the new code; killed every stray server process from this session
(several, at different ports, from earlier manual smoke tests), started
a genuinely fresh instance, and re-ran the full suite three times
(92/92, stable) to re-confirm everything claimed above against real
current code, not a stale process.

**Deployed and verified live**: pushed, CI's `check` and `deploy` jobs
both passed (`gh run watch`). Then checked the actual transport against
production directly — not inferred from CI being green — since Fly's
proxy sits in front of this app and a reverse proxy can buffer or
mishandle a streaming response even when the app itself streams
correctly: joined the live bar, opened `GET /api/bar/events` against
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` with `curl -N`, and
confirmed both the immediate on-connect snapshot (`seq:1`) and a second,
correctly-updated push (`seq:2`, matching position) arriving in real time
after a separate `move` request — streaming genuinely works through
Fly's proxy, not just on localhost. (Also incidentally confirmed, from
the snapshot's own `tables` field, that real rooms already exist on
production from the student's own prior use — this phase's probe
patron is harmless and will simply drop out of the live view once its
heartbeat goes stale, the same as any other disconnected patron.)

## Crit 9 implementation — phase 3: built: public/app.js is SSE-driven

`public/app.js`'s room/lobby view swapped its flat 1.5s `setInterval`
poll for `EventSource('/api/rooms/:code/events')` as the primary update
path. A single staleness rule (`state.version <= lastVersion` → discard)
is now the one gate every source of state goes through: the stream's
pushes, a mutating action's own response (now applied directly via a new
`applyIncoming`, rather than discarded in favor of a separate `getState`
call the old `refreshNow()` made — removing a redundant request on every
Ready/Start/Roll/Place click), and a slow 10s fallback poll kept as cheap
insurance against a silently-stalled connection. `EventSource.onopen`
(fires on the initial connect *and* every automatic reconnect) and a new
`visibilitychange`/`focus` handler both trigger one unconditional fresh
fetch, so a backgrounded tab resuming — or a dropped connection coming
back — resyncs to the server's actual current state rather than trusting
whatever the stream happens to deliver next. `stopPolling`/`pollHandle`
are gone, replaced by `stopLive`/`startLive`, which also tears down the
visibility listener on route change (no listener left bound after
navigating away). The heartbeat loop is untouched — still a separate
5s interval, still unrelated to this transport, per CLAUDE.md's existing
presence/state separation.

**Verified, not just asserted**: a throwaway Playwright driver (outside
the repo, matching the pattern already used earlier in this project)
drove two real browser contexts against the locally-running app — host A
creates a room, guest B joins, A clicks Ready, and B's page is watched
(no reload, no action on B's part) until its own DOM shows A as ready.
Three runs: B's view reflected A's change **51-71ms** after A's own click
started, of which only **5-8ms** was propagation *beyond* A's own
click-to-response round trip — the rest is A's own request latency, not
sync lag. Comfortably under the "~1 second" requirement, measured with
real timestamps (`Date.now()` before/after, logged), not inferred from
the fact that SSE pushes exist in the code. `pnpm check` (13 files,
92/92) stayed green throughout, re-run against a freshly-started server
after the Playwright pass.

**A real tooling gap found and fixed along the way**: no Playwright
install existed in this environment yet (only a cached, mismatched
browser binary version from some earlier, unrelated install) — `npx
playwright install chromium` pulled the matching one (~120MB) before the
driver could actually launch a browser. Noted since it's a real step
anyone reproducing this verification would also hit, not a given.

**Deployed and verified live**: pushed, CI's `check` and `deploy` jobs
both passed. Re-ran the exact same Playwright driver against
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` (not just localhost):
three runs, **58-121ms** total, **6ms** propagation delta each time —
consistent with the local numbers, confirming the stream survives Fly's
proxy in front of it under real conditions, not just in a local dev
process.

## Crit 9 implementation — phase 4: built: public/tavern.js is SSE-driven

`public/tavern.js`'s `poll()`/`setInterval(poll,1500)` is replaced by
`EventSource('/api/bar/events')`, gated by the same kind of staleness
rule as the room view — a `seq`-based `applyIncoming`, since the bar has
no single versioned row the way a game room's `version` column already
is (`src/live.ts`'s `bumpBarSeq`/`currentBarSeq`).

The old `moving` flag's full poll-skip is **removed outright** — this was
the specific, named problem (continuous walking silently blocking receipt
of everyone else's updates). In its place: a narrow `pendingMoveTarget`,
set only while *this* patron's own step request is in flight. `reconcile`
still applies every incoming payload immediately — every other player's
position, every table's live status — but while `pendingMoveTarget` is
set, it overrides just the local avatar's displayed x/y to the pending
destination, so an update that predates this patron's own in-flight move
doesn't visually snap their own sprite back to its pre-move tile. `moving`
itself is kept, narrowed to its original, separate purpose: preventing a
second step request from starting before the first one resolves — never
again used to gate what's received or rendered.

Table occupancy, previously fetched only on-click (`openTableDialog`'s own
`read('/tables')`), is now part of the continuously-streamed bar payload
and drawn every frame: up to 4 small seat markers per playable table,
filled with the occupying player's actual color as `state.tables` updates
live, empty otherwise — a bystander can now see a table fill up from
across the room, not just by walking over and clicking (the dialog still
re-fetches `/tables` fresh at click time as the authoritative check before
acting — unchanged, defense in depth). This doesn't change the 4-player
cap itself (`MAX_PLAYERS` in `src/rooms.ts`, untouched) — it makes the
existing rule visible.

`onopen`/`visibilitychange`/`focus` handling mirrors phase 3's app.js:
one unconditional fresh fetch on connect, reconnect, or a backgrounded
tab resuming. `dispose()` now also closes the EventSource and removes the
visibility/focus listeners — nothing left bound after leaving the bar.

**Verified, not asserted**: a second throwaway Playwright driver, using
only real app code paths (a real patron's real `EventSource`, real
`reconcile()`, and a plain, observable signal — the HUD's own
`.online-count` text) rather than reaching into internal JS state. Three
runs each:
- **Stationary** (patron A idle, a second real patron joins via a direct
  API call): A's online count updated in **57-61ms**.
- **Continuous movement** (A holding a direction key the *entire* time,
  via real keyboard events driving the real walk loop, while a third
  patron joins mid-walk): A's online count still updated, in
  **10-14ms** — if anything faster than stationary, since each of A's
  own in-flight steps already carries a fresh snapshot independent of
  the push. This is the direct, measured answer to "does continuous
  walking block receiving other updates": no.

`pnpm check` (13 files, 92/92) stayed green throughout, re-run against a
freshly-started server after both Playwright passes. No console errors
observed during either run (listened for directly, not assumed absent).

## Crit 9 implementation — phase 5: built: 4-seat visuals + a restroom

Both supplementary requirements, kept clearly separate from each other
and from the real-time work above.

**4-seat capacity**: already true in the rules (`MAX_PLAYERS = 4` in
`src/rooms.ts`, confirmed unchanged — this phase adds no new rule). What
landed in phase 4 already draws it: 4 seat markers per playable table,
live from the streamed `state.tables`. One real gap found in that
drawing, from an actual screenshot, not just reading the code: an empty
seat's fill (`#00000030`) was nearly invisible against the floor's own
dark wood tones. Fixed to a clearly visible hollow ring (light stroke,
translucent dark fill) — re-screenshotted against a table with a real
2/4 and 1/4 occupancy to confirm the fix reads correctly at a glance, not
just that the color value changed.

**Restroom**: `src/barLayout.ts` gets a new `blocksMovement?: boolean`
field on `Furniture` (every existing entry leaves it unset, so nothing
that exists today changes behavior) and one new `"restroom"` fixture,
3x3 tiles, placed in the empty space top-right of the grid — clear of
both the furniture cluster (`x11-28/y7-15`) and the main south
walkway/rug area patrons actually use (`y15-23`), confirmed by an
automated overlap check against every other fixture
(`spec/barLayout.test.ts`), not just eyeballing the coordinates.
`isWalkable` (server) and `tavern.js`'s own `walkable()` (client) both
changed in the same one-line way, from the same underlying rule and the
same shared `FURNITURE` data served by `GET /api/bar/layout` — a fixture
with `blocksMovement: false` is a walkable zone marker, not an obstacle,
so client and server can't disagree about which tiles are walkable. The
canvas click handler's existing "clicking a fixture intercepts the click
for its own dialog" behavior is narrowed to only fixtures that actually
are both non-walkable *and* interactive (a table, the counter) — a
restroom-tile click now falls through to ordinary walk/pathfinding, same
as any other floor tile. Drawn with the same `box()`-primitive pixel
style as every other fixture (a floor patch, a door frame, a hanging
"RESTROOM" sign) — no new assets, no occupancy, no queueing, no server
route of its own, exactly as asked: a walkable space this round, nothing
more.

New `spec/barLayout.test.ts` cases (4 added, 1 existing one adjusted to
exclude the restroom from "every fixture blocks movement" since that's
no longer universally true): the restroom exists, doesn't overlap any
other fixture, every one of its tiles is walkable, and a single-step
sequence into and back out of it is legal.

**Verified by actually walking there, not just unit-testing the
geometry**: a throwaway Playwright driver computed a real BFS path (the
same 4-directional, one-tile-at-a-time shape `tavern.js`'s own
`findPath` uses) from the spawn point into the restroom's interior and
back out, submitting each step through the real `POST /api/bar/move`
endpoint — 29 real, individually-server-confirmed steps in, and a
matching path back out, zero console/page errors. Screenshots confirm
the door/sign render legibly and the 4-seat rings are now clearly
visible against a table with real occupancy (2/4 at one Vegas table,
1/4 at another, both from genuine earlier test games, not staged).
`pnpm check` (13 files, 96/96) green throughout, against a freshly-
restarted server (an asset change needs a restart for `BUILD_VERSION`'s
content hash to pick it up — caught this directly, from a real
`caching.test.ts` failure against a stale process, not assumed).

**Deployed and verified live**: pushed, CI's `check` and `deploy` jobs
both passed. Re-ran the same 29-step BFS walk-in/walk-out driver against
`https://comp4020-final-shuyangyuzu-cmd.fly.dev`: identical result, real
server-confirmed steps the whole way in and back out, zero errors.

## Crit 9 implementation — phase 6: decision record, reconnect, CLAUDE.md

**The decision record**: `ADR-last-seat.md` (repo root). Investigated the
last-seat race properly before writing anything, per the explicit
instruction not to conflate two different latencies: a dedicated script
fires two real, simultaneous `POST /join` requests at a room already at
3/4 players with exactly one color left (a genuine single-slot race, not
a test artifact), while a third, idle session watches the room's SSE
channel. Three local runs, two production runs:

| | Local | Production |
|---|---|---|
| Loser's own `409 room_full` | 8-10ms | 86-230ms |
| Winner's own `201` | 6-7ms | 80-224ms |
| Idle bystander's SSE push showing the room full | ~0ms after the winning commit | ~0ms (sub-ms) after the winning commit |

Confirms what reading the code already suggested (but didn't assume
without measuring): the loser's own latency was never poll-bound — it's
plain network RTT, same before and after this week's work. The
bystander's number is what actually changed: ~1.5s-bound before, now
effectively instant via the same SSE push as everything else. The ADR
documents the existing (unchanged) server-side resolution, the
alternatives considered (client-side optimistic reservation — rejected,
violates server authority; a waitlist/queue — rejected as more than this
week needs, not as a bad idea), the required argument *against* the
chosen path (a queue would arguably be more socially fair than "whoever's
request wins," which is a genuine, named cost — not a strawman), and how
it ties to README's own "good."

**Reconnect, measured**: a Playwright driver has guest B's tab go
"hidden" (simulating a dropped/backgrounded connection), has host A ready
up and start the game while B is away (including readying B server-side,
since a real disconnect wouldn't stop the room from moving on), confirms
the server's actual current state directly over the API, then has B's
tab become visible again and measures convergence. Three runs (2 local,
1 production): B's view reached the correct, current game-started state
in **10-47ms** after resuming — via the `visibilitychange`/`focus`
handler's forced fresh fetch (CLAUDE.md), not by trusting any event that
might have been missed while B's stream was down.

**`CLAUDE.md`**: the "Scope discipline" section's "no sub-second
real-time sync" clause (listed there as deferred through Crit 8) is
replaced with a note that Crit 9 supersedes it, pointing at this file's
own record above. A new "Real-time push is a transport, not a new
authority" section states the rule actually built: SSE carries
server-computed state outward only, every write still goes through the
existing authenticated POST path unchanged, staleness is resolved by the
version/seq rule (same principle as the existing optimistic-concurrency
check), and a reconnect is never trusted to have delivered everything
missed — only a fresh fetch is.

**README/PROCESS**: not edited this round, per the explicit instruction
to propose facts and arguments for the student's own review rather than
rewrite these in their voice, and not to draft `reflections/crit-9.md` on
their behalf. The specific proposed facts/arguments were given directly
in this session's final report rather than written into the repo.

## Crit 9 implementation — phase 7: an independent review found two real bugs in phase 2-6's own design

A second agent was asked to independently re-verify phases 2-6 before the
crit. The 96-test suite, the ~3-6ms production propagation numbers, the
last-seat race result, and production/local `tavern.js` parity all held
up — but the review went further than re-running what was already
measured, and found two real gaps in the *design*, not the measurements,
neither caught by the original verification because neither needs a
real restart or presence expiry to show up, and the original work never
produced either.

### Problem 1: a server restart makes the bar (and, less obviously, any
### SSE-watching room) permanently reject every subsequent update

**Reproduction, done before any fix existed**: with a client holding
`lastSeq = 202` from before a restart, a freshly-restarted process
reporting `seq = 0, 1, 2, ...`, running the *original* `applyIncoming`
(`next.seq <= lastSeq` discard) against those post-restart payloads
rejects every one of them. Not a one-off race — permanent, until ~203
more real mutations happened to accumulate on the new process, which in
practice never happens while a page sits open after a quiet restart. The
file's own prior claim that "`onopen` forces a fresh fetch, so reconnect
recovers" does not fix this: the fresh fetch still returns the new
process's own low seq, and still goes through the identical filter.

**Root cause**: `src/live.ts`'s `barSeq` (and, after this phase, every
room's `rev`) is an in-memory counter with no concept of "which process
generation produced this number." A bare high-water-mark filter can't
tell "this is older than what I've seen" apart from "this is from a
different counter that started over."

**Fix**: `src/live.ts` now exports `SERVER_EPOCH` (`Date.now()` at module
load — process-wide, constant for the process's lifetime) and a pure,
unit-tested `shouldApplyLiveUpdate(current, incoming)`:
- no baseline yet → apply;
- a strictly newer epoch → apply unconditionally, and reset the rev/seq
  baseline to match (a restarted process's own numbering starts over,
  legitimately, and must not be read as "behind");
- a strictly older epoch → never apply, even arriving after a newer one
  already landed (a late response from, or a queued SSE frame on a
  connection to, a process that's since died must not regress a view
  that already moved on to its replacement);
- same epoch → the original strictly-greater-rev/seq rule, unchanged.

Every room and bar payload now carries `epoch` alongside its `rev`/`seq`
(`src/server.ts`'s `withLiveCursor`/`barSnapshot`). `public/app.js` and
`public/tavern.js`'s own `apply`/`applyIncoming` implement the identical
two-tier check client-side (both point back at `shouldApplyLiveUpdate`'s
doc comment as the canonical contract, so the three copies can't quietly
drift apart unnoticed).

This also required separating a room's *push-revision* from
`rooms.version` outright (not just renaming it) — see problem 2's fix
below for why; `src/live.ts`'s own header comment and `CLAUDE.md`'s
"Real-time push" section record the reasoning in full, including the
correction to this file's own prior, now-false claim about reconnect
being sufficient on its own.

**Automated regression test**: `spec/liveSync.test.ts` — six cases
against `shouldApplyLiveUpdate` directly, including the exact repro
numbers above (`rev 202` pre-restart, `rev 0` post-restart, under a newer
epoch, must apply) and the "late response from a superseded epoch must
never regress" case. A true kill-and-restart-mid-session check (what the
bug actually looks like end-to-end) can't run inside the shared,
always-up `pnpm test` server — see this file's "real, manual" entry
further down for that.

### Problem 2: presence changes (connected/online flipping) never reached an already-open viewer

**Reproduction, done before any fix existed**: with `PRESENCE_STALE_MS`
turned down to 300ms on an isolated instance, (a) a bar patron who
stopped heartbeating disappeared from a plain `GET /api/bar/state` read,
but an already-open `GET /api/bar/events` connection kept showing them
indefinitely — nothing had bumped `seq` or broadcast anything, because
no mutating action had happened; (b) the same gap for a game room's
`connected` flag against `GET /api/rooms/:code/state` vs. an open
`/events` connection, and for the lobby's own disconnect-grace sweep
(which, before this phase, only ever ran as a side effect of some read —
and with no poll left calling that read, nothing triggered it either).
The existing 10s client-side fallback poll doesn't rescue this: it calls
the exact same endpoint, gated by the exact same filter, so it only
helps once *something else* has already bumped the sequence number for
an unrelated reason.

**Root cause**: `connected` (and the lobby sweep's own
removal/host-transfer/close) are computed fresh on every *read*
(`rooms.getPublicState`, `bar.getPublicBarState`) — correct and
unchanged — but nothing was watching for *time itself* changing that
computed result and broadcasting the difference. A heartbeat simply
stopping isn't a request to any endpoint; there's nothing to hook a
publish onto.

**Fix, deliberately not a version/seq bump on every heartbeat**: writing
every heartbeat into `rooms.version` would reintroduce exactly the
problem CLAUDE.md's presence design already rules out — a heartbeat
racing a real roll/place over the same optimistic-concurrency counter.
Instead:
- A room's push-revision (`rev`, `src/live.ts`'s `roomViewSeq`) is its
  *own* counter, independent of `rooms.version` entirely — see problem
  1's fix above. Bumping it for a presence-only change costs nothing a
  real game action depends on.
- `src/server.ts` computes a `roomPresenceSignature`/`barPresenceSignature`
  (the parts of the public view that presence alone can change: `closed`,
  `hostPlayerId`, and each player's `id`+`connected` for a room; the
  visible player list and tables for the bar) and keeps the last one
  actually broadcast per channel. `tickRoomPresence`/`tickBarPresence`
  recompute it and republish only on an actual diff — never a blind bump.
- A short interval (`LIVE_PRESENCE_TICK_MS`, default 1000ms,
  env-overridable like `PRESENCE_STALE_MS`/`LOBBY_GRACE_MS` already are)
  calls these for every room/bar channel with a live SSE subscriber right
  now (`live.subscribedRoomCodes()`/`live.hasBarSubscribers()`) — never
  an unwatched one. The same heartbeat endpoints also call the tick
  immediately, so reappearing is instant rather than waiting for the next
  interval.
- This is **not** a new background-mutation sweep of the kind CLAUDE.md
  rules out for the lobby grace period: the grace condition is still
  evaluated lazily, by the same read a GET already makes; this loop is
  only an additional caller of that read, scoped to channels someone is
  actually watching, and does nothing (no DB access at all) while nobody
  is connected — consistent with `auto_stop_machines` (see CLAUDE.md's
  updated "lobby disconnect grace" section for the full reasoning).

**Automated regression test**: two real, slow (`pnpm test` already makes
this trade-off for `spec/settlement.test.ts`'s own 24-round timing) tests
in `spec/live.test.ts`, run concurrently (`it.concurrent`) against the
real, unmodified production `PRESENCE_STALE_MS` default — no shortened
threshold, no mocked time. Each opens a real SSE connection, takes no
further action at all, and waits past the real staleness threshold:
- a room with two players: the initial push shows both `connected: true`;
  a later push (no action from anyone) shows at least one `connected: false`.
- a bar patron: present in the initial push; absent from a later one.

Both passed. Also added: every room/bar payload now carries a numeric
`epoch`, identical across a plain read and the SSE channel in the same
process; a heartbeat that changes nobody's state doesn't bump a room's
`rev` (checked for rooms, which get an isolated per-code counter; not
meaningfully checkable for the bar's single global `seq` under this
suite's own cross-file concurrency — see the comment left in its place in
`spec/live.test.ts`).

### A follow-up review of this phase's own fix: epoch comparison needed to be checked, not just asserted

Before any of the above was trusted, the follow-up review asked a sharp
question directly: does `shouldApplyLiveUpdate` only accept a newer epoch
because it compares `incoming.epoch > current.epoch`, or could a careless
reading of "different epoch" (`!==`) have slipped in, which would wrongly
accept a **late, older**-epoch response as if it were new? And separately:
passing `spec/liveSync.test.ts` (a pure function) was never, on its own,
proof that `public/app.js` and `public/tavern.js` — two independently
hand-written copies of the same logic — actually agreed with it or with
each other.

**Checked, not assumed**: `src/live.ts`'s actual comparison was already
`incoming.epoch > current.epoch`, not a bare `!==` — correct on inspection.
But the second point was real: the two client files *did* each carry
their own separately-typed-out version of the same two-tier check, with
no test ever importing either one directly. Fixed by removing the
duplication rather than re-arguing it was fine by hand: **`public/
liveSync.js`** is now the one client-side implementation of
`shouldApplyLiveUpdate`, imported once by `app.js` (dynamically, with the
same `?v=` cache-busting convention already used for `tavern.js`) and
threaded into `tavern.js` through `createTavern`'s existing options-object
pattern (alongside `el`/`render`/`navigate`/etc.) — `tavern.js` no longer
defines its own copy at all. `src/version.ts`'s content hash now includes
this file too (`spec/caching.test.ts`'s own independent hash computation
needed the same update — caught immediately by that test failing when it
wasn't, which is exactly what that test is for). `tsconfig.json` gained
`allowJs: true` so `spec/clientLiveSync.test.ts` can import the real
`public/liveSync.js` file directly (no DOM needed — it's a pure function)
rather than a `.d.ts` stand-in; this also let `spec/direction-hold.test.ts`
drop a now-redundant `@ts-expect-error` it had carried since Crit 9 phase
4 for the same reason.

**New regression tests, run as one continuous sequence, not as separately
-true facts** (both `spec/liveSync.test.ts`, the server-side pure
function, and `spec/clientLiveSync.test.ts`, importing the actual
`public/liveSync.js` browser file):
1. accept epoch A, rev 202 (the review's own repro numbers);
2. accept epoch B, rev 0 (the restart);
3. a **late** response from epoch A — arriving *after* B was already
   accepted, carrying a rev far higher than anything B has produced —
   must still be rejected, and must leave the cursor at B, unchanged;
4. B's own next legitimate update must keep applying normally (the
   rejection in step 3 must not wedge the gate).

Plus a direct test of the exact wrong-implementation shape named above:
`shouldApplyLiveUpdate({epoch:2000,...}, {epoch:1000,...})` must be
`false` (an older epoch arriving late) while
`shouldApplyLiveUpdate({epoch:2000,...}, {epoch:3000,...})` must be `true`
(a genuinely newer one) — proving the comparison is directional, not a
bare inequality.

112/112 tests green (`pnpm test`, fresh `DATA_DIR`, run twice), `pnpm
typecheck` and `pnpm check:evidence` both clean, after this round of
fixes.

### Real, manual verification (not run inside `pnpm check` — see each
### task's own reasoning above for why)

Run by a second agent, independently, against throwaway `DATA_DIR`s and
ports outside the repo's own `./data` — never the repo's real data,
never a process this agent didn't itself start, nothing left running
afterward (verified free).

**Restart recovery, with a page left open the entire time, never
reloaded.** Server #1 up; a baseline pre-restart cross-browser update
(a second patron joining via direct HTTP, observed on the first patron's
open page) landed in 4ms, confirming the page was genuinely live before
touching anything. Server #1 killed; server #2 started against the
**same** `DATA_DIR` and port, logging "listening" 1257ms later. With the
Playwright page never reloaded or touched during any of this, a third
patron's join (POSTed directly, after server #2 was confirmed up) reached
that still-open page in **2291ms**, measured from the join request
resolving to the page's own DOM first showing the new count (polled every
150ms — a deliberately coarse, conservative measurement, not a tight
timestamp-the-exact-render claim). The same check for a game room (a
second player joining a room whose lobby was left open across the
restart): **2139ms**. Both numbers are dominated by `EventSource`'s own
browser-side reconnect backoff, not application logic — the actual fix
(the epoch check) is what makes the reconnect's own fetch/push *succeed*
once it happens, rather than being silently rejected forever the way the
pre-fix code would have been. This is the direct end-to-end confirmation
of the bug this phase exists to fix: under the original seq-only gate,
neither of these would ever have recovered without a page reload.

**Presence push with no action taken, dedicated short-threshold
instance.** First attempt used `PRESENCE_STALE_MS=1500`, shorter than the
client's own hardcoded 5-second heartbeat loop — the verifying agent
caught this itself (via a raw SSE log showing the viewer's own presence
cycling on its own 5s cadence, confounding the measurement) before
reporting a number, and redid it with `PRESENCE_STALE_MS=7000` (above the
client heartbeat) and `LIVE_PRESENCE_TICK_MS=300`:
- bar patron B disappeared from an open viewer's page **7298ms** after
  B's last heartbeat (model predicts ~7000-7300ms — matches);
- B reappeared **19ms** after one heartbeat POST for B;
- a game room's `connected` flag flipped to disconnected on an open
  lobby page **7116ms** after that player's last heartbeat (matches the
  same model);
- reconnected **11ms** after one heartbeat POST.

All four match `PRESENCE_STALE_MS + LIVE_PRESENCE_TICK_MS`, and
reappearance is near-instant via the heartbeat-triggered immediate
recheck (not waiting for the next ticker pass) — exactly as designed, not
rounded up from something looser.

**Regression smoke** (all pass, kept brief since 112/112 automated tests
already cover the mechanics): a second patron's join during 500ms+ of
continuous simulated movement still reached the moving patron's own page;
a direction-hold button pressed/held 700ms/released produced no console
errors; ready/start gating unchanged (409 with nobody ready, 409 with
only one of two ready, 200 once both are).

**What this still is not**: the direction-hold check above is simulated
pointer events in an automated browser, not a finger on a real
touchscreen — CLAUDE.md's own standing caveat on this, repeated here
rather than silently dropped. No restart check was run against production
(explicitly avoided, per the student's own instruction not to restart the
live server other real players may be using) — the restart evidence above
is entirely from the dedicated local/throwaway instances.

### Deployed and verified live

Pushed (commit `e246cc6`); CI's `check` and `deploy` jobs both passed
(`gh run view` — 1m8s/1m13s). Production verification done directly
against `https://comp4020-final-shuyangyuzu-cmd.fly.dev`, not inferred
from CI alone:
- `/version` reports `7309c89f17`, matching a SHA-256 of the actual local
  `app.js`+`styles.css`+`tavern.js`+`liveSync.js` bytes computed
  independently right before checking — the same cross-check
  `spec/caching.test.ts` already runs locally, repeated here against the
  live deploy specifically.
- `GET /api/bar/state` and `GET /api/bar/events` both carry a real,
  numeric `epoch` (the deployed process's own boot timestamp), confirming
  the new field is actually wired in production, not just locally.
- A throwaway probe room (`ProbeHost`, created and disbanded by this
  verification alone — never touching the two real in-progress tables
  already on production from the student's own prior use, confirmed
  untouched) exercised a real mutation against the live SSE channel: a
  `ready` POST, with an open `GET /api/rooms/:code/events` connection
  already watching, delivered the updated `ready: true` state in **203ms**
  measured end-to-end from this verification script's own process (POST
  request sent → SSE push received) — this number is **not** a clean
  "server commit to client" interval the way the phase 3/4 Playwright
  measurements were; it includes this script's own network RTT to Fly's
  `syd` region and is reported as the one real number actually measured,
  not rounded down to imply something more precise than what was
  measured. The probe room was disbanded immediately after
  (`disband` → 200), leaving no stray state. No restart was performed
  against production.
- Repo stays public (unchanged from Crit 8); no `/ship` run, no `crit-9`
  tag created, `crit-8` tag unchanged at `a706408`.

This is the agent's own (and, for the live verification, a second agent's
own) automated re-verification — not the student's own check. 等待用户验收.

# Product direction update (2026-10-11) — real seating, approval, NPC tables, nine tables

The student redirected scope significantly beyond the Crit 9 sync fix
above: the bar's earlier "four seat-marker dots per table" stand-in is
replaced by actual walk-up-and-sit seating everywhere (dining tables, bar
stools, and game tables alike); online Vegas tables gain a host-approval
join flow instead of "first click wins a seat"; a second, NPC-driven
Vegas mode is added so a lone visitor can play without waiting for real
opponents; the floor plan grows to two labelled rows of five tables each.
This section records what was found in the existing code, the design
decisions made to satisfy the brief, and the data model — implementation
is phased below, each phase verified and deployed before the next, per
the student's own explicit instruction.

## Two real bugs found while reviewing the existing implementation (not new features — fixed in phase 1)

**1. "Return to your game" leaks across bar identities.** Reproduced by
reading the code, not just taking the student's report on faith:
`public/app.js`'s `lastActiveRoom()`/`saveSession()` read and write a
single, flat `localStorage` key, `vegas:lastRoom` — shared by *every*
consumer on this browser: the classic direct-room-code flow's own
"return to that room" offer on Home, **and** `tavern.js`'s bar-identity
"Return to your game" HUD button (fed the exact same global key via the
`lastActiveRoom` option passed into `createTavern`). Creating a brand-new
bar character does nothing to this key — it's keyed to the browser, not
to the bar identity, so a new character's session immediately inherits
whatever room a *previous* character (or the classic flow, independently)
last touched on this device. This is the literal mechanism behind the
report ("以新身份进入,却仍看到 Return to your game,打开的是旧身份留下
的房间"). The classic flow's own narrower "this browser last used this
room" offer is a different, intentional, already-documented feature
(CLAUDE.md's "Identity recovery": browser-scoped, not persona-scoped) and
isn't what's broken — only the bar HUD's button, which *looks*
identity-scoped but isn't, needs to stop trusting this key at all.

**2. A bar table's displayed status can bypass the room's own expiry
check.** `src/tables.ts`'s `lookupOpenRoom` (used by both
`getTablesStatus`, what the bar's live table view renders, and
`checkExistingSeat`, the one-seat-at-a-time guard) reads `rooms` directly
with a raw `SELECT ... WHERE id = ?` — it never calls through
`rooms.ts`'s own `loadRoomAfterSweep`, the function that actually applies
the lazy lobby-disconnect-grace sweep (CLAUDE.md: evaluated fresh on
every read). So a lobby whose players have all gone stale past
`LOBBY_GRACE_MS`, but which nobody has *read* via `rooms.getPublicState`
recently, still reports through `getTablesStatus` as "waiting, N/4" —
stale data nobody has swept yet. The *first* thing that actually reads
through `rooms.ts` properly is the join attempt itself
(`tables.joinTableRoom` → `rooms.joinRoom` → `loadOpenRoom` →
`loadRoomAfterSweep`), which runs the real sweep right then, discovers
everyone's gone, closes the room, and only *then* refuses with
`room_closed` — exactly matching the reported "显示有人,加入却说房间已
关闭". Fix: `tables.ts` stops reading `rooms` directly and goes through
`rooms.getPublicState(db, code)` instead (which already runs the sweep
and returns sanitized, display-ready data) for both `getTablesStatus` and
`checkExistingSeat` — one fewer bespoke read path, not an extra special
case.

## Decisions (resolving ambiguity in the brief; real rule changes still get asked about)

- **Identity recovery fix, mechanism**: the bar's own session-authenticated
  responses (`join`/`rejoin`/`appearance`) report the *current* bar
  identity's own active seat, freshly re-validated every time
  (`activeSeat: {tableId, roomCode} | null`), reusing the exact
  "checkExistingSeat"-style validation already in `tables.ts` — never a
  client-trusted cache. A brand-new character's first `join` response has
  no prior table pointer at all, so `activeSeat` is `null` by
  construction — "new character doesn't inherit old game" falls out of
  the data model, not a special case bolted on. `public/tavern.js`'s
  "Return to your game" button is driven by this field exclusively; the
  global `vegas:lastRoom` key is left alone for the classic flow's own,
  separate, already-correct use, not touched or repurposed.
- **Leave/exit states — four, not one "disconnected" bucket**, each with
  its own server-checked condition, recorded in CLAUDE.md once built:
  1. **Refresh / brief reconnect** — heartbeat resumes within seconds;
     never a leave of any kind, exactly as today.
  2. **Away from table (not away from the bar)** — explicitly returning to
     the bar view, or standing up from a seat, while a game is bound to
     that table. Starts a **2-minute** grace *on that table binding*,
     independent of `LOBBY_GRACE_MS` (which governs the *lobby seat*,
     pre-start) and independent of dice/turn timing (idle-but-present
     during your own turn is not an away-from-table event at all — this
     clock starts on leaving the physical table, not on inactivity).
     Sitting back down within the window resumes the existing binding
     exactly; past it, auto-exit fires per whichever of 3/4 below applies
     to the room's current phase.
  3. **Explicit "Exit game"** — immediate, same tick, no grace: releases a
     lobby seat outright (pre-start; existing `leaveRoom`), or, once
     started, hands the seat to NPC control (4 below) — never silently
     drops dice, skips a settlement, or stalls the turn order.
  4. **True disconnect** — heartbeat itself stops (closed tab, crashed
     device, killed process), detected the same lazy, read-time way as
     always (CLAUDE.md), *not* a new timer. Pre-start, this already means
     the existing `LOBBY_GRACE_MS` sweep. Mid-game, this is new: the
     existing "no auto-removal once started" policy is kept (a game in
     progress still never force-ends on a human's account), but **phase
     4's NPC takeover** is what now runs in its place once a started
     game's seat has been away long enough — the dice/turn/winnings in
     that seat survive, the departed human simply stops being the one
     deciding what it does next. The exact takeover threshold for an
     already-started game reuses the same 2-minute away-from-table clock
     above (standing up from, or never returning to, the game seat), not
     a separate timer.
  A seat's physical table binding is the thing with a lifecycle here —
  the *lobby* seat and the *game* seat remain the same underlying `Player`
  row throughout (per the existing room model); nothing about
  `rooms`/`sessions`/`presence`/`events`' shape changes to express any of
  this (CLAUDE.md's bar/room separation rule) — the away-from-table clock
  lives in a new, bar-side-adjacent table, not inside `rooms.state_json`.
- **NPC capacity and readiness**: an NPC occupies a real seat
  (`Player.controller: "npc"`, counted toward `MAX_PLAYERS = 4` exactly
  like a human), is always `ready: true` by construction (never has a
  `sessions` row, so nothing can toggle it — the same "no session, no
  authenticated action" mechanism every other server check already
  depends on makes this free), and is added/removed only by the host,
  only pre-start. The turn engine (`src/game.ts`) needs **zero** changes
  for this: `applyRoll`/`applyPlacement` already operate on a bare
  `playerId` with no concept of who's driving it — an NPC's turn is the
  exact same function call as a human's, just initiated by a short
  server-side scheduler (phase 4) instead of an authenticated POST,
  choosing among **already-rolled** values only (never reads deck order,
  never bends a rule `applyPlacement` wouldn't already enforce for a
  human).
- **NPC turn scheduling, bounded like the presence ticker, not a global
  cron**: a short interval, scoped to rooms with an open SSE subscriber
  (reusing `live.subscribedRoomCodes()`, the same mechanism Crit 9 phase
  7 built for presence) — an NPC-only game with nobody watching simply
  pauses, exactly like presence detection already does, and resumes the
  moment the room is read again. No new unconditional background timer.
- **Approval model**: a join *request* gets a real `playerId`/
  `sessionSecret` immediately (so a requester can watch the same public
  room stream everyone else does and know their own request's fate by
  id) but is **not** added to `state.players` and **does not** count
  toward `MAX_PLAYERS` until the host approves it — approval re-runs the
  exact capacity/color checks `joinRoom` already runs, inside the same
  version-gated transaction, so approving two requests for the last seat
  (or the same color) races exactly like two simultaneous `join` calls
  already do today (deterministic, one wins) rather than needing new
  conflict-resolution logic. A rejected or cancelled request is simply
  removed from the pending list; its `sessions` row is deleted so a
  stale id can't later be mistaken for anything live.
- **Physical seats are furniture-adjacent, not new furniture**: dining
  chairs and bar stools get their own `bar_seats` rows (id, kind, x, y,
  `occupied_by`), seeded once from `barLayout.ts` exactly like `tables`
  already is (CLAUDE.md: furniture is fixed, seeded once). A game table's
  four chairs are **not** separate `bar_seats` rows — "sitting" at a game
  table *is* already being seat-index 0-3 in that room's own player
  roster; the chairs are a rendering of existing room state, not a new
  occupancy concept, avoiding a second source of truth for "who's at this
  table."
- **Scope held firm**: no ordering/eating/drinking this round (`src/
  orders.ts` stays untouched and disconnected); Texas/Dominoes/Blackjack
  get real fixtures in both the online and NPC rows, clearly "not yet
  open," never a clickable fake game.

## Data model (additive)

```sql
-- Phase 2: real seats, separate from tables.ts's game-table concept —
-- see "Physical seats are furniture-adjacent" above for why a game
-- table's 4 chairs are NOT rows here.
CREATE TABLE bar_seats (
  id TEXT PRIMARY KEY,           -- e.g. "dining-a-1".."dining-a-4", "stool-1"
  furniture_id TEXT NOT NULL,    -- which dining_table/stool fixture this belongs to
  x INTEGER NOT NULL, y INTEGER NOT NULL,  -- the walk-up tile, not the fixture tile
  occupied_by TEXT               -- bar_players.id; NULL = free
);

-- Phase 2: the 2-minute away-from-table clock. One row per bar identity
-- currently bound to a table, separate from bar_presence (heartbeat) and
-- from rooms.state_json (CLAUDE.md: don't blur bar/room, don't put a
-- frequently-changing clock inside the versioned game blob).
CREATE TABLE table_departures (
  bar_player_id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  left_at TEXT NOT NULL          -- when they left the physical table (view/seat), not a heartbeat time
);
```

```ts
// Phase 3, additive field on the existing Player shape (src/types.ts) —
// a pending request is NOT a Player; see RoomState.pendingRequests below.
interface Player {
  // ...existing fields...
  controller: "human" | "npc"; // defaults "human"; npc is add-NPC (phase 4) or post-start takeover (phase 1's lifecycle, enforced once phase 4 exists)
}

// Phase 3, new top-level field on RoomState/PublicState — lobby-only,
// cleared (not carried into) an awaiting_roll/round_end phase.
interface PendingRequest {
  id: string;        // == the request's own playerId once/if approved
  nickname: string;
  color: Color;
  requestedAt: string;
}
```

## Phased implementation order (the student's own, confirmed)

1. Identity-recovery entry point, room-expiry consistency, and the
   leave/exit lifecycle *definitions* (this section's two bug fixes, plus
   an explicit "leave table" action and CLAUDE.md's new state table —
   not yet the 2-minute away-from-table clock or `table_departures`
   itself, which need phase 2's seating concept of "stood up from your
   seat" to even mean anything, and not yet NPC takeover, which needs
   phase 4's engine to hand a seat to).
2. Real seats (dining/stool/game-chair sitting and standing) +
   `table_departures` + the 2-minute away-from-table grace enforced for
   real.
3. Online-table join approval.
4. Vegas NPC tables, server-scheduled legal turns, and (now that an NPC
   engine exists) wiring phase 1's "exit after start → NPC takeover" to
   actually hand the seat to it.
5. Nine-table layout (two labelled rows) and real "not yet open" fixtures
   for the NPC-row's Texas/Dominoes/Blackjack slots and the online row's
   same three.

Each phase: implement → regression tests (new behavior + the two bugs
above) → `pnpm check` green → deploy → live re-verification → only then
the next phase, matching every earlier Crit 9 phase's own discipline.
`crit-8` tag untouched throughout; no `crit-9` tag, no `/ship`.
`reflections/crit-9.md` and the README/PROCESS.md rewrite remain the
student's own, not drafted here.

## Phase 1 — built: identity-recovery fix, table-expiry-sweep fix, leave/exit state definitions

**Bug 1 fix**: `src/tables.ts` gained `getActiveSeat(db, barPlayerId)`
(extracted alongside `checkExistingSeat` from a shared, newly-named
`resolveActiveSeat`, so both go through identical re-validation), returning
`{tableId, roomCode} | null`. Wired into the bar's own
`join`/`rejoin`/`appearance` responses (`src/server.ts`) — never into the
broadcast `barSnapshot` every other subscriber receives, so this stays a
private, self-only field. `public/tavern.js`'s "Return to your game" now
reads a dedicated `activeSeat` variable set from these three responses,
instead of the global `lastActiveRoom()`/`vegas:lastRoom` key — which
`public/app.js`'s classic flow keeps using, untouched, for its own,
separate, intentionally browser-scoped (not persona-scoped) "return to
that room" offer.

**Bug 2 fix**: `src/tables.ts`'s `lookupOpenRoom` now calls
`rooms.getPublicState(db, code)` (which runs the lazy lobby-disconnect-
grace sweep) instead of a raw `SELECT * FROM rooms`. `getTablesStatus`
and `checkExistingSeat`/`resolveActiveSeat` both go through this one
corrected path — removing the second, inconsistent read instead of
patching it with a special case.

**CLAUDE.md**: new "Four leave/exit states" section records the
refresh/away-from-table/explicit-exit/true-disconnect model and the
"departed human's seat goes to NPC control, never deleted" rule that
later phases build on — definitions only this phase; the 2-minute
away-from-table clock and NPC takeover itself need phase 2's seating
concept and phase 4's NPC engine respectively to mean anything yet.

**Regression tests**: `spec/tables.test.ts` gained 4 new cases (a
brand-new identity's `activeSeat: null`; a real binding reflected and
then cleared on disband; a second identity never inheriting the first's
seat; clearing on voluntary leave) — appended to this file rather than a
separate one after an early version raced a standalone file against the
same 3 shared real Vegas tables (vitest's default file-level
parallelism caught this immediately as a flaky 409, not a test design
success — fixed by consolidating, not by adding a lock). New
`spec/tableExpiry.test.ts` reproduces bug 2 directly against hand-built
databases (`src/db.ts`'s `openDb`, like `spec/db-migration.test.ts`
already does) with a presence row back-dated well past `LOBBY_GRACE_MS`
— deterministic and instant, not a real 60-second wait, while still
exercising the exact fixed code path
(`getTablesStatus`/`getActiveSeat`/`createTableRoom`) rather than a
restated copy of its logic.

**Live verification, real browser**: a throwaway Playwright driver
(reusing the install already set up for Crit 9 phase 7's verification)
against a local instance: a genuinely-seated identity, after a hard page
reload (which — by existing, unrelated, pre-phase-1 design — re-shows the
character editor once per page load even for a returning identity, not a
bug this phase introduced) and resubmitting that pre-filled form, sees
"Return to your game" and clicking it lands in the real, correct lobby. A
second, completely separate browser context (a genuinely new identity, no
shared storage) never sees it, even while the first identity's game is
still active — confirmed with both a same-page-reload path and an
entirely fresh context, the exact "new identity incorrectly inherits a
previous identity's game" scenario from the bug report. The first version
of this check used `.world-dpad`'s appearance as its readiness signal and
reported a false bug (`.world-dpad` renders immediately in `mount()`,
before `begin()` — which is what actually appends the button — has
necessarily run); corrected to wait on the online-count text actually
updating before asserting, and re-verified clean. No restart test needed
for this phase (not restart-related); `pnpm check` (16 files, 119/119)
green throughout, run fresh twice.

## Phase 2 — built: real dining/stool seating, the 2-minute away-from-table clock, and real seated figures at game tables

**Data model**: `bar_seats` (one row per real dining/stool seat, seeded
once from `src/barLayout.ts`'s new `BAR_SEATS` — 5 stool seats, 4 per
dining table, computed from the furniture layout rather than hand-typed)
and `table_departures` (the away-from-table clock, keyed by bar identity,
deliberately separate from `bar_presence` and `rooms.state_json` —
CLAUDE.md). Both are brand-new tables, so `CREATE TABLE IF NOT EXISTS` is
genuinely sufficient (unlike the `closed_at`-column bug), still verified
with a regression test against a real pre-existing database
(`spec/db-migration.test.ts`). `Player.controller: "human" | "npc"`
added to `src/types.ts`, defaulted everywhere a `Player` is constructed,
and exposed on `PublicPlayer` and `src/tables.ts`'s new `TableSeatView`
— groundwork phase 4 will actually drive, not used for anything yet
beyond this phase's own NPC-handoff flag.

**A real geometry bug caught before it shipped, by the overlap test, not
by eyeballing coordinates**: the first draft placed `dining-b`'s and
`dining-c`'s seat tiles on the exact same tile as `stool-3`'s and
`stool-5`'s own approach tiles respectively (both furniture happened to
share a grid column). `spec/barLayout.test.ts`'s new "no two seats share
a tile" check failed immediately against the actual computed geometry —
fixed by shifting `dining-b`/`dining-c`'s x-position off the stools'
columns, not by special-casing the collision.

**Server**: `src/bar.ts` gained `sitAtSeat`/`standFromSeat`/
`getSeatLayout`; sitting requires actually standing on the seat's own
(ordinary, already-walkable) tile — no walkability exception needed,
matching the existing movement model exactly. Moving away auto-stands
(`moveBar`'s own transaction clears `occupied_by` for the mover) — a
chair can never show occupied once its occupant has visibly walked off.
`PublicBarPlayer` gained `seatId`. `src/tables.ts` gained
`departActiveTable`, `clearDepartureForGamePlayer`, and
`enforceExpiredDepartures` (reuses `rooms.leaveRoom` pre-start exactly as
a voluntary leave would; calls the new `rooms.handoffToNpc` once a game
has started — both wired into the existing presence-ticker interval in
`src/server.ts`, gated the same "only while something's actually
watching" way, per CLAUDE.md's updated "lobby disconnect grace" + new
away-from-table sections). `GET /api/bar/layout` now also returns
`seats`; `getTablesStatus` now returns a real `seats: (TableSeatView |
null)[4]` per table (color/nickname/connected/controller), additive
alongside the existing `takenColors` the table-dialog's color picker
already depends on.

**Client (`public/tavern.js`)**: clicking a stool or dining table picks
its nearest free seat and either sits immediately (already standing
there) or paths there first and sits automatically on arrival
(`beginSit`/`pendingSitSeat`, mirroring the existing `pendingMoveTarget`
pattern) — every tile of that walk is still its own separately-validated
`/move` call, the sit itself a separate, final `/seats/:id/sit`; nothing
shortcuts either check. A HUD "Stand up" button, shown only while seated.
Game tables draw real small seated figures at each occupied chair (the
same `sprite()` every patron already uses, at a smaller, non-animated
scale — a simplified, honest stand-in, not a claim of distinct seated
artwork) with an "NPC" tag for a non-human-controlled seat, replacing the
previous plain colored dots; an empty chair keeps the existing, already-
legible hollow-ring treatment. A seated bar patron's own sprite skips the
walk-cycle animation. `public/app.js`'s "Back to the bar" button now
fires a best-effort `POST /api/bar/depart` first (reading the bar session
directly from `localStorage`, the same pattern `buildClassicPanel`
already uses for the nickname prefill) — the explicit away-from-table
trigger, independent of sitting-elsewhere's own trigger in `sitAtSeat`.

**What this phase does not yet do** *(update: fixed in the very next
entry below — the student flagged this as a live production risk before
it ever shipped with real traffic, and it was fixed before anything else
proceeded)*: `rooms.handoffToNpc` flips `controller` correctly and is
exercised by a real test, but nothing yet *acts* on a handed-off seat's
turn — a started game with a handed-off seat simply waits there,
turn-stalled. The approval queue (phase 3) doesn't exist yet either, so
every current table seat is still "first click wins," unchanged from
before this phase.

**Regression tests**: `spec/barSeats.test.ts` (8 cases — sit requires
being at the tile, double-occupancy refused, re-sitting the same seat is
a no-op, one-seat-at-a-time, standing frees it, moving auto-stands,
standing-when-not-seated is a no-op), `spec/tableDeparture.test.ts` (7
cases — sitting elsewhere records a departure, explicit depart, clearing
on return, an unexpired departure is left alone, an expired lobby
departure reuses the real leave path, an expired started-game departure
hands off to NPC with dice/winnings/turn-order verified unchanged), 3 new
cases in `spec/barLayout.test.ts` (seat-tile walkability, no seat
collisions, correct seat counts per fixture), 1 new
`spec/db-migration.test.ts` case. All against hand-built or direct-DB
databases (like the Crit 9 phase 1 table-expiry test), not real multi-
minute waits — the 2-minute default is far too slow for an automated
suite, and this exercises the exact enforcement function directly rather
than a restated copy of it.

**Live verification, real browser** (same throwaway Playwright install):
walked a patron step-by-step (server-validated moves, no teleporting) to
a real stool seat, sat via the real endpoint, reloaded the page, and
confirmed the "Stand up" button appears, then clicking it correctly
hides it again. Separately, clicked directly on a stool fixture after
walking adjacent to it and confirmed the click-to-sit gesture resolves to
the correct `seatId` with zero console/page errors. Separately again,
seated two real players at a Vegas table and confirmed the new seated-
sprite rendering produces zero console/page errors over 1.5s of real
animation frames. Not independently isolated in live browser testing:
the specific "click far away from a seat, walk several tiles, sit
automatically on arrival" sub-case (covered by the click-to-sit test
above only in its single-tile-away form) — the underlying mechanism
(`pendingSitSeat` + `step()`'s arrival check) is the same code path
either way, but a longer walk specifically wasn't the one exercised live.

`pnpm check` (18 files, 137/137) green, fresh `DATA_DIR`, run twice;
`pnpm check:evidence` green.

**Deployed and verified live**: pushed (commit `b4728a8`); CI's `check`
and `deploy` jobs both passed. Directly against
`https://comp4020-final-shuyangyuzu-cmd.fly.dev`: `/version` matches a
fresh local hash; `GET /api/bar/layout` reports all 17 real seats (5
stools + 4×3 dining); a real probe patron was refused sitting from the
spawn tile (`409 not_at_seat`), then walked there via real,
individually-server-validated steps, sat successfully
(`seatId: "stool-1-seat"`), and stood back up successfully
(`seatId: null`) — the full real-server round trip, not just a local
check. This is the agent's own re-verification, not the student's own
check — 等待用户验收.

## A follow-up review's two real findings in phase 2's own work — fixed before any other phase proceeded

The student, reviewing phase 2 directly, flagged a genuine production
risk and a genuine correctness bug before either shipped with real
traffic. Both were fixed first, ahead of phases 3/5, per the student's
own explicit priority.

### Finding 1: a handed-off seat was flagged but never actually played — a started game would simply stall

Phase 2's `rooms.handoffToNpc` flips `controller` to `"npc"` correctly,
but nothing read that flag and did anything with it — a real game where
a departed human's seat got handed off would sit there, forever waiting
on a turn nobody could take. Calling this "NPC takeover" at that point
overstated what existed; the student explicitly asked that it not be
described that way again until something actually plays the seat's turns.

**Fix — a minimal, real turn-taking engine**, not a scaffold:

- `src/npc.ts`: a pure `chooseNpcPlacement(values)` — the most-frequent
  rolled value, ties broken low, fully deterministic and directly unit
  tested. Never reads deck order, never bends a rule a human couldn't
  also follow.
- `src/rooms.ts`: `npcRoll`/`npcPlace` — internal, server-triggered
  counterparts to a human's `roll`/`place`, with no session to check
  (the caller already decided the room needs a nudge; these act on
  whoever `currentPlayerId` actually is, re-checking phase and controller
  again inside the same transaction rather than trusting an earlier
  read). Both return whether they actually acted and are idempotent by
  construction — calling either again against state that's already moved
  past the phase it would act on is a silent no-op. This is what makes
  "never double-execute a turn" hold even if the in-memory scheduler
  guard below were ever bypassed (e.g. a restart mid-wait), not just a
  claim resting on the guard alone.
- `src/server.ts`: a scheduler on the same ticker as presence/departure
  enforcement, under the identical "only while something's actually
  watching" gate — an NPC-only game with nobody watching simply pauses
  and resumes the moment it's watched again, no new unconditional
  background timer. On noticing the current player is NPC-controlled, it
  waits a short, configurable `NPC_TURN_DELAY_MS` (a visible pause, not
  an instant resolution) before calling `npcRoll`/`npcPlace` and
  publishing the result over the room's existing SSE channel.
- `src/rooms.ts`'s `roll`/`place` now explicitly refuse any call for a
  seat whose `controller` is `"npc"` — **even from the original human's
  still-valid session**. This was a real gap, not a hypothetical: the
  ordinary "is it your turn" check alone doesn't catch it, because a
  handed-off seat's id can still legitimately be `currentPlayerId` when
  it's genuinely that seat's turn — a departed human's old credentials
  would otherwise still work. The session itself is never deleted
  (nothing about the person's identity or history is erased), it simply
  can no longer act for this seat.

**The two scenarios the student asked to see verified separately** (both
as direct, deterministic tests against `rooms.npcRoll`/`npcPlace`, in
`spec/npcTurn.test.ts` — not a live multi-minute wait):
1. **The current-turn player's departure expires mid-turn.** Handed off
   while `awaiting_roll`: the engine rolls, then places, legally,
   continuing the exact turn order. Handed off while `awaiting_placement`
   with their own roll already pending: the engine places using that
   *exact* roll — verified by checking the roll's values are unchanged
   across the handoff — never re-rolling.
2. **A non-current player's departure expires, and only later does it
   become their turn.** Handed off immediately (the flag flips right
   away, regardless of whose turn it is) but `npcRoll`/`npcPlace` are
   confirmed to no-op the whole time it's someone else's turn; once the
   human ahead of them completes a real turn and the engine's own turn
   order naturally advances to the handed-off seat, the NPC engine picks
   it up correctly from there.

**No duplicate execution**: asserted directly (a second `npcRoll` call
after the phase has moved on returns `false` and leaves state
unchanged) and, separately, defended in depth (idempotent functions, not
just a scheduler guard, per above).

**Survives a restart — verified twice, at two different levels**: (a) a
fast, deterministic test that closes and reopens the same database file
mid-scenario and confirms `npcRoll` still acts correctly against the
reopened connection; (b) a real, live process kill-and-restart: started a
dedicated instance, created and started a 2-player game, sat the host at
a real seat (recording a departure), confirmed the room was still
human-controlled, then **killed the actual OS process** and started a
fresh one against the same `DATA_DIR`. With an SSE connection opened
against the *new* process, the departure enforcement and NPC scheduler
both ran correctly there — flip to `npc`, roll, place, turn advances —
exactly as if nothing had happened. (Note on why the first kill-timing
attempt showed no change at all before the restart: with no SSE
subscriber connected during that window, the "only while watched" gate
correctly did nothing — a real demonstration of that design working as
intended, not a flaw in the test.)

**Live, end-to-end verification against a real running server** (not
just the direct function tests above): a dedicated short-interval
instance, a real 2-player Vegas game created through the bar, the host
seated at a real dining-area seat (the actual user-facing trigger), and
an open SSE connection on the room the entire time. Measured over one
real `collectSseEvents`-style window: the departure expired, `controller`
flipped to `"npc"` (still `awaiting_roll`), the NPC rolled
(`awaiting_placement`), then placed (dice count dropped, turn correctly
advanced to the human guest) — four real, timestamped pushes, zero
manual intervention.

### Finding 2: a room heartbeat or rejoin was wrongly clearing the away-from-table clock

**The exact bug**: phase 2's heartbeat/rejoin handlers cleared a pending
departure on the reasoning "this player is actively engaging with the
game." That reasoning doesn't hold — both fire automatically for as long
as a room view/tab is simply *open*, including one left open in the
background while that same identity's bar avatar is sitting at a
completely different seat or has walked off entirely. A browser staying
connected proves the browser is connected; it proves nothing about where
the *person* is. Left as shipped, a departed player could keep an old
game tab open indefinitely and never actually be timed out, defeating
the clock's entire purpose.

**Fix**: removed both clearing calls. The only thing that clears a
departure now is an explicit, deliberate bar-world action —
`src/tables.ts`'s new `resumeActiveTable`, called from
`public/tavern.js` immediately before navigating back into a table's
room (both the "Return to your game" button and the table dialog's own
join/create success path, which also covers re-clicking into an already-
active seat). A new `POST /api/bar/resume` endpoint carries it.

**Verified, not just reasoned about**: `spec/tableDeparture.test.ts`
gained direct tests that a room heartbeat does *not* clear a pending
departure, that a rejoin doesn't either, and an explicit end-to-end case
matching the student's own described scenario: a patron sits at a real
seat (recording a departure), an old game tab's heartbeat fires
*repeatedly* (five times, simulating a tab left open for a while), the
departure is still there afterward, and once it's actually back-dated
past the threshold, enforcement still exits/hands off the seat exactly
as the rule requires — the old tab's heartbeats never rescued it.

### The identity-recovery fix, re-verified the way the student specifically asked — same browser, same storage, not a fresh context

The earlier Crit 9 phase 8 verification used a second, entirely separate
Playwright browser context for the "new identity" side of the check —
real, but not what the original bug report actually described (the
student's own words: used the site in Edge previously, then "entered
with a new identity" in the *same* browser). A separate context trivially
has no shared storage at all, so it couldn't have caught a bug where
stale keys linger *in the same storage* the new identity is also reading
from. Redone properly: one browser context throughout. Alice binds to a
real table; `vegas:lastRoom` and `vegas:room:<code>` are set, exactly as
the real client does. Only `vegas:bar:session` is then removed —
simulating the exact partial loss the report describes — leaving the
other, stale keys deliberately intact. Reloading (still the same
tab/context/storage) shows the character-creation form fresh; creating
"Bob" there does **not** show "Return to your game," confirmed to be a
genuinely different bar identity, with the stale `vegas:lastRoom` key
independently re-read afterward to confirm it was really still sitting
there unclaimed — not cleared by coincidence. This is the faithful
reproduction of the reported scenario; the earlier separate-context
check remains valid as an *additional* case (a different identity on a
different device should also never see it), not a replacement for this one.

### A small UX polish, from the student's own further clarification on seating

The dining/stool seating flow (walk-then-auto-sit-on-arrival, one click)
already matched the student's follow-up spec exactly as built in phase 2
— confirmed by re-reading it against that message's own itemized list
rather than assumed. One real gap found and fixed: if a seat a patron is
mid-walk toward gets taken by someone else, the client previously kept
walking the rest of the way before finding out (the server's own refusal
at arrival was always correct, just a late signal). `public/tavern.js`'s
`animate()` loop now checks the target seat's live occupancy on every
remaining step of that walk and aborts immediately with a toast the
moment it's taken, rather than walking there for nothing. Game-table
seating (dialog-based, color-to-seat assignment, no walking to a chair
required) was already built exactly this way in phase 2 and is
unchanged; the seat-preview-at-approval-time detail is folded into
phase 3's own design below, not built separately here.

**Verification**: `pnpm check` (20 files, 149/149) green, fresh
`DATA_DIR`, run twice; `pnpm typecheck` and `pnpm check:evidence` green.
New tests: `spec/npc.test.ts` (4 cases, the pure decision function),
`spec/npcTurn.test.ts` (6 cases, the two required scenarios plus no-
double-execution, restart survival, and the old-session-blocked check),
3 new cases in `spec/tableDeparture.test.ts`. Live: the real process-
restart test and the real end-to-end SSE-observed NPC turn sequence
above, plus the same-browser-context identity re-verification.

**Deployed and verified live**: pushed (commit `4f543aa`); CI's `check`
and `deploy` jobs both passed. `/version` on
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` matches a fresh local
hash; `POST /api/bar/resume` is live and correctly rejects an
unauthorized caller, confirming the new endpoint is actually deployed.
The NPC turn-taking and real-restart demonstrations above were run
against dedicated local instances with a shortened `AWAY_FROM_TABLE_MS`,
not production — production's own default is a real 2-minute wait, and
waiting that out against the live server (rather than a throwaway local
one) wasn't a good use of it; the mechanism itself is identical code,
just gated by an env-overridable threshold already established practice
elsewhere in this project. 等待用户验收.

## Phase 3 — built: online-table join approval

**Data model**: `RoomState`/`PublicState` gain `pendingRequests:
PendingRequest[]` (`{id, nickname, color, requestedAt}` — `id` doubles as
the eventual player id if approved). Not a new table: this is lobby-only,
closely tied to a room's own version-gated state exactly like `players`
already is, so it lives in the same JSON blob rather than inventing a
parallel storage layer. No new seat-assignment rule: approval uses the
same join-order seat index every direct join already used (see the
"fixed color-to-seat" note below for why this is a deliberate,
conservative reading of the brief rather than a silent rule change).

**`src/rooms.ts`**: `requestJoin` (creates a real session + a
`PendingRequest`, re-validating capacity/color for early, honest
feedback — not the authoritative check), `approveJoin`/`rejectJoin`
(host-only, re-validate capacity/color again at commit time, inside the
same version-gated transaction every other mutation uses — approving two
requests for the last seat or the same color races exactly like two
simultaneous `join` calls already do: deterministic, one wins),
`cancelJoinRequest` (the requester's own, proven by their own session).
`sweepStaleLobbyPlayers` now also expires a request nobody acted on,
reusing `LOBBY_GRACE_MS` rather than a second threshold. `roll`/`place`
needed no changes — a pending request never becomes `currentPlayerId`
until approved, so there's nothing for the turn engine to even see.

**`src/tables.ts`**: `joinTableRoom` now calls `rooms.requestJoin`
instead of `rooms.joinRoom` — joining a table that already has a host is
a request, full stop; only `createTableRoom` (the first, empty-table
case) still seats immediately, unchanged. `resolveActiveSeat`/
`getActiveSeat`/`checkExistingSeat` now recognize a pending request as
"still associated with this table" (not just an actual seat) — both for
the one-table-at-a-time rule and so `activeSeat` can report `pending:
true`, which is what lets "Return to your game" and "you have a pending
request" be told apart client-side. `getTablesStatus` gains a lightweight
`pendingCount` for the bar's own table dialog.

**Server**: three new room-level endpoints —
`POST /api/rooms/:code/requests/:requestId/approve`,
`.../reject`, and `.../requests/cancel` — all plain room-session actions
(the host already has their own room credentials from being seated;
CLAUDE.md's bar/game separation means none of this needs a bar identity
at all, only the *initial* request does, via the existing
`/api/bar/tables/:id/join`). All three return the fresh state, same
convention every other mutation already follows.

**Client**: `public/app.js`'s room view now recognizes three states for
"where is my own session in this room" — seated (existing), pending
(new: a dedicated waiting screen with a live-updating message and a
Cancel button, never the normal lobby), or neither (removed/declined/
expired, same message either way since the distinction doesn't change
what the person needs to do next). The lobby itself gained a "Waiting to
join" section, visible to everyone (same transparency as the player list
— CLAUDE.md), with Approve/Decline buttons rendered only for the host.
`public/tavern.js`'s table dialog now reads "Request to join" instead of
"Join this table" for a table that already has a host, explains that the
host approves it, shows a pending-request count, and disables acting
entirely on an already-full table rather than inviting a request the
server would just refuse.

**A deliberately conservative reading, not a silent rule change**: the
student's own follow-up message described "四种游戏颜色固定对应四个座位"
(the four game colours fixed to four seats) in the context of a "seat
preview." Changing what `seat` (and therefore turn order, which sorts by
seat) actually means — from join/approval order to a fixed color-to-index
mapping — would be a genuine change to an already-confirmed product rule
(PLAN.md's original product decision 3: "turn order in round 1 is join
order"), which CLAUDE.md's own instruction says to ask about rather than
infer. This build keeps `seat` as approval order, unchanged, and reads
"seat preview" as the dialog's own visual aid (the swatch picker, with
takenColors already disabled) — not a request to silently change turn
order semantics. Flagged here explicitly rather than guessed at silently
either way; happy to rebuild this as a real seat-index-by-color scheme if
that's what was actually meant.

**Regression tests**: `spec/tables.test.ts` gained 7 new cases (decline +
session deletion, requester self-cancel, host-only enforcement, color
re-validation at approval, capacity re-validation at approval, a pending
request never appearing as a seat or blocking ready-up, and
`activeSeat.pending` reflecting request vs. approved seat correctly) plus
an update to the existing "table status reflects a real room" test to
show the request→approve transition explicitly. New
`spec/joinRequestExpiry.test.ts` (3 cases) covers request expiry
directly against a hand-built database (a real grace period is minutes
long — far too slow to wait out automatically), the same trade-off
`spec/tableExpiry.test.ts` already established.

**Live verification, real browser**: a real Playwright page submitted a
request through the actual client UI, correctly showed the "waiting for
approval" screen, and — once a separate action approved it — updated
**live, with no reload**, to the real lobby. Separately, a real host page
showed a submitted request live with Approve/Decline buttons, and
clicking Decline correctly removed it live. Zero console/page errors in
either run.

`pnpm check` (21 files, 159/159) green, fresh `DATA_DIR`, run twice;
`pnpm typecheck` and `pnpm check:evidence` green.

**Deployed and verified live**: pushed (commit `62a2bbd`); CI's `check`
and `deploy` jobs both passed. `/version` on
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` matches a fresh local
hash. A throwaway probe room (created and disbanded by this check alone,
never touching the student's own real tables) exercised the full
request→approve round trip directly against production: a request came
back `pending: true`, and approving it returned a state with both
players genuinely seated. 等待用户验收.

## Phase 5 — built: nine-table two-row layout, labelled by mode, with a real solo Vegas NPC table

**Layout (`src/barLayout.ts`)**: `GAME_TABLES` is now two rows of the same
four game types. Online row (unchanged ids, `tableMode: "online"`):
`vegas-1`/`vegas-2` (playable), `texas-1`/`dominoes-1`/`blackjack-1`
("...Online — not yet open"). NPC row, new fixtures two tiles south
(`tableMode: "npc"`): `vegas-npc-1` (playable), `texas-npc-1`/
`dominoes-npc-1`/`blackjack-npc-1` ("...NPC — not yet open"). The old
third online Vegas slot (`vegas-3`) is dropped from the active layout per
the student's own reduction to two online tables — never deleted from the
`tables` SQL row (`src/db.ts` only seeds ids still in `GAME_TABLES`, never
removes ones that fall out), so a room ever bound to it stays reachable by
its own code exactly as any disbanded room already is. Every pre-existing
table id is kept unchanged (CLAUDE.md: furniture ids a live binding might
reference must survive a layout revision) — only new ids were added or
repositioned.

**A real bug this phase found and fixed in its own new layout**: the NPC
row's `blackjack-npc-1` (abs tiles x20-21, y17-18) landed directly on top
of the hardcoded default spawn tile (`GRID_COLS/2, GRID_ROWS-6` = x20,
y18) and its own adjacent tile — a newly-joined patron would spawn
*inside* a game table, and `spec/bar.test.ts`'s existing "accepts a single
adjacent step" test caught it immediately (409 instead of 200). Fixed by
making `defaultSpawn` relative to the whole furniture cluster's bottom
edge (`GRID_ROWS - 3`, clear of every row) instead of a number picked
before this row existed — exactly the kind of drift CLAUDE.md's furniture
section now calls out explicitly so it isn't repeated by a future layout
edit.

**Solo NPC table architecture (`rooms.createSoloNpcGame`,
`tables.startNpcGame`)**: a genuinely different fixture shape from an
online table, not "an online table nobody else joined" — see CLAUDE.md's
new "Two game modes, two rows, one architecture each" section for the
full reasoning. In short: no shared `current_room_id` pointer, one brand
new private room per visitor (1 human + 3 NPC seats, `startGameLogic` run
in the same creating transaction), `getTablesStatus` always reports it
empty/unoccupied regardless of how many private games are running, and
`resolveActiveSeat` was refactored to resolve a bar identity's active
room via its own `sessions.room_id` row rather than the fixture's pointer
— which now works for both fixture kinds uniformly. `joinTableRoom` and
`createTableRoom` both gained a `tableMode` guard checked *before*
`checkExistingSeat`'s own early return, closing a real bug a new test
caught: a visitor who already had an active NPC-table seat could
otherwise get a `201` (their own NPC game handed back) from the
*online*-table `/join` endpoint called against that same id, instead of
the `404` that endpoint owes any call against the wrong kind of fixture.

**Client (`public/tavern.js`)**: table clicks now branch on `tableMode` —
an online fixture still opens the existing live-status dialog
(`openTableDialog`); an NPC fixture opens a new, simpler
`openNpcTableDialog` (pick a colour, "Play vs. 3 NPCs", starts
immediately, no status to show since nothing is ever shared). Each row
gets a banner (`rowBanner`) painted once onto the static floor layer,
positioned from the actual fixture coordinates the server sent rather
than a hardcoded pixel offset, so a future layout change can't leave the
label pointing at the wrong row.

**Regression tests**: `spec/barLayout.test.ts`/`spec/bar.test.ts` updated
for nine tables (3 playable Vegas, 6 reserved) plus the existing
all-pairs/row overlap checks extended to the new row.
`spec/db-migration.test.ts`'s fixed-table-count assertion updated 6→9 (and
its "second open must not duplicate the seed" check fixed to actually
`.close()` the second connection before asserting, closing the same class
of Windows `EPERM`-on-cleanup leak fixed once before in this file: an
assertion throwing before a later `.close()` line leaves the handle open
for the rest of the test run). `spec/tableExpiry.test.ts`'s stale
`vegas-3` references swapped for `vegas-2` (a real, still-existing
table — it was never about table identity, just needed *a* real bound
table id). `spec/tables.test.ts` gained 5 new cases: two independent
visitors' NPC games never share a room, the shared status view always
reports an NPC table empty, the wrong-endpoint 404 (online `/join`
against an NPC id), starting at a reserved NPC slot refuses (404), and
starting a solo game against an *online* table's id refuses (404). All
166 tests green; `pnpm check` run twice clean against a fresh `DATA_DIR`.

**Live verification, real browser (Playwright, local)**: joined the bar,
read the real `/api/bar/layout` response and confirmed 9 game fixtures
(2 online + 1 NPC playable, 6 reserved) tagged with the right
`tableMode`; computed the actual on-screen click position for
`vegas-npc-1` from the client's own camera-follow formula (not a direct
DOM/API shortcut) and clicked it for real — the correct dialog opened
("Vegas NPC" / "Play vs. 3 NPCs"), and clicking through created a real
room and navigated into it. Screenshot confirms both row banners ("◆
ONLINE — REQUEST TO JOIN", "◆ SOLO VS. 3 NPCS") rendered correctly behind
the dialog. A second script then drove that same solo game through a real
page: the human host rolled and placed once, and the NPC engine then
autonomously rolled *and* placed for all three computer seats in turn
order (blue → green → yellow), each shedding dice exactly once, before
correctly stopping back at the human's own turn (`awaiting_roll`,
unchanged across 10+ seconds of polling) rather than acting for them —
confirming the existing NPC turn engine (built in an earlier phase) works
correctly through this new entry point too, not just the handoff scenario
it was originally proven against.

**Explicitly not built this phase** (recorded as a known gap, not
silently dropped): an online table host's ability to add/remove NPC
seats before starting — section 4 of the original product-direction
spec. Every online table this round starts with only the humans who
joined/were approved; "play vs. NPCs" is only available via the separate
solo NPC row.

`pnpm check:evidence` green. Committed (`8a6ef6f`), pushed, CI's `checks`
job passed (run `38165033646`).

**Deployed and verified live**: `/version` on
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` returns `4c58216b7d`,
matching the local build exactly (the same hash visible in this phase's
own local Playwright screenshots). A throwaway probe identity (created,
never touching the student's own real tables) against production
confirmed: the real layout response carries 9 game tables (2 online + 1
NPC playable, 6 reserved); the online `/join` endpoint called against
`vegas-npc-1` returns `404 table_not_found`, not a success; starting a
solo game there creates a real room with the correct 1 human + 3 NPC
roster; the shared `/api/bar/tables` view reports it `empty`/`roomCode:
null`/`playerCount: 0` throughout. The NPC turn engine was checked twice
against production, once **without** and once **with** a held-open SSE
subscription to the room: unwatched, the engine correctly never acted
(CLAUDE.md's own "only while something's actually watching" rule for the
scheduler ticker — the first run's apparent non-progress was this rule
working as designed, not a bug, since a plain HTTP-polling script is not
a subscriber); watched (a real `EventSource`-equivalent fetch stream held
open exactly as a real client's `connectEvents()` would), the engine
correctly rolled and placed for all three NPC seats in turn order and
 returned control to the human, live against the production server. 等待用户验收.


## Production entry regression — legacy room JSON (2026-10-12)

The user reported being unable to enter. The agent reproduced it in the
production browser: reconnect displayed "Unable to reconnect. Reload to
retry", and submitting the character editor displayed "something went
wrong". Fly logs identified `TypeError: state.pendingRequests is not
iterable` in `rooms.toPublicState`, reached through `getActiveSeat` on
bar rejoin/appearance. Persisted rooms from before approval support had
no `pendingRequests`; players from before NPC support also lacked
`controller`. Column migrations did not migrate these JSON payloads.

`src/db.ts` now transactionally adds missing JSON defaults on startup,
including closed rooms. It preserves existing requests/controllers,
room versions, session proofs, event history, and game progress. This
is a persistence migration, not a reset or an ignored exception.

`spec/room-state-migration.test.ts` reproduces the pre-migration failure,
then verifies returning identity/seat recovery, room rejoin, consistent
table status, closed-room binding cleanup, and repeated startup without
altering started-game progress or existing NPC/request data. Typecheck
and all 169 tests passed against a fresh isolated server on port 8093;
`pnpm check:evidence` passed. Production browser verification follows
publication; the user's own acceptance remains separate.

## Seating and spacing playtest correction (2026-10-12)

The user reported that seats were not visibly usable, game tables still
showed four rings, tables were crowded, and neighbouring chairs appeared
to share click tiles. They clarified that the stool/chair itself should
be the clickable object, with a hover indication, rather than a separate
button elsewhere.

Inspection found a real drawing/input mismatch: dining chairs were
painted left/right while `BAR_SEATS` placed their interaction tiles
north/south; stools were painted on a blocking furniture tile while the
sittable tile was below them. Game occupancy used four rings under the
table rather than the four painted chairs. The previous geometry tests
covered only actual BAR_SEATS, not decorative game chairs.

The layout now spans both game rows across the same left/right table
boundaries as the dining area. Each game table has four independently
addressable chair tiles, with two clear columns between online table
bodies and three clear rows between modes. `GAME_CHAIRS` is returned in
the layout API alongside BAR_SEATS. Canvas chair art and transparent
accessible hit areas both use those exact tiles: the chair itself has
hover/focus highlighting, a hand cursor, and a hint. No separate visible
button strip is added. Dining/stool clicks walk then sit; a game-chair
click preselects that chair's colour and preserves the existing create/
request/host-approval flow. Physical game chairs map to colour while
join-order/turn-order remains unchanged.

Seated sprites now have bent legs and a sitting pose. Game occupants
are drawn on the actual chair, with their nickname and skin; an active
seated bar identity is not also drawn as a standing duplicate. A player
away from their table retains their reserved place but is labelled away.
NPC kiosks remain private games, not shared occupied online tables.
Startup layout migration moves an occupied chair with its patron and
relocates only floor positions obstructed by relocated furniture.

Validation: typecheck and 174 tests passed against a freshly restarted,
isolated server, including all-chair uniqueness/reachability, row-width
alignment, colour-to-chair mapping, departure visibility, and occupied-
chair migration. Actual browser checks locally confirmed a dining chair
click -> automatic walk -> visible Stand up; Stand up -> release; direct
bar-stool click -> sit; blue game-chair click -> blue preselected -> real
lobby entry; a second open bar page showed the player sitting on that
blue chair with no standing duplicate. These two pages shared a browser
identity; this is not a claim of a new independent-player playtest.
Publication and production verification follow these local checks.

# Three further improvements (2026-10-12): a fourth dining table, tile occupancy, proximity chat

Three requests, built on top of the student's own two commits above
(the legacy-JSON migration fix and the seating/spacing correction, both
already live): a fourth dining table evenly spaced with the rest; no two
patrons sharing a tile anywhere in the bar; and a new, genuinely
multiplayer feature — walk up to someone and chat privately. The second
and third items are this round's real engineering weight; see CLAUDE.md's
new "No two patrons occupy the same tile" and "Proximity chat is private,
authenticated, and re-validated at send time" sections for the settled
design, kept here to the concrete decisions, real bugs found, and
verification record.

## Part 1 — a fourth dining table, evenly spaced

`src/barLayout.ts`'s `dining-a..d` are now at relative x = 1, 6, 12, 17
(gaps 3, 4, 3 — the closest an integer-tile grid gets to even spacing for
four width-2 tables across the exact same [1,19) span the two game-table
rows already aligned to, matching `vegas-npc-1`'s own row's already-
accepted asymmetry for the identical reason). The original stool-column
collision constraint that shaped the old 3-table layout no longer applies
at all: the two already-live student commits above changed a stool's own
seat to be the stool's own tile (not a floor tile south of it), so a
dining seat's row (one north, one south of each table) never shares a y
with a stool seat regardless of x. `spec/barLayout.test.ts`'s existing
geometry suite (all-pairs overlap, reachability, row-boundary-alignment)
needed no new assertions, just ran against the new numbers — confirming
no new collision, no stranded chair.

## Part 2 — no two patrons on the same tile

**Server (`src/bar.ts`, new `src/position.ts`).** "Occupied" means one
specific thing everywhere: another *currently connected* identity's
*effective* position is exactly this tile (CLAUDE.md has the full
reasoning — effective position is the real chair tile for a present
game-table occupant, never a frozen pre-game coordinate). Checked and
written inside the same synchronous transaction that already made
idempotency race-free elsewhere in this codebase, so two simultaneous
claims on one tile can never both land. A disconnected patron's old tile
stops blocking the instant their heartbeat goes stale (the bar's own
existing `PRESENCE_STALE_MS`, no second threshold invented) — and
recovery itself can't be broken by this: `rejoinBar` now repairs a
now-invalid stored position (claimed by someone else while away, or no
longer walkable after a layout change) before ever reporting it back,
and `joinBar`'s spawn search finds a free tile near a *jittered* spawn
point rather than assuming the canonical one is free (a real test
flake, caught immediately: a burst of simultaneous joins under
parallel test load packed solid around one fixed point before this).
`db.ts`'s existing migration-time relocation (from the student's own
prior commit, for furniture that moved) now also avoids stacking two
relocated patrons on the same tile, using the identical free-tile search.

**Client (`public/tavern.js`).** `occupiedByOther`/`playerAt` read
directly from `state.players[].x/y` (already effective position from the
server), so pathfinding (`findPath`), the dpad/WASD single-step check,
and every click surface agree with the server's own rule without
re-deriving it: a path is never planned through another patron, and a
destination that becomes occupied mid-walk is caught and abandoned
rather than walked through. `findApproachTile` is the one function
behind "click an occupied tile and walk to the nearest free neighbour,
never into them" — picks whichever free, walkable, in-bounds orthogonal
neighbour of the target is closest to the clicker's own current
position, which simultaneously implements "prefer the side facing the
clicker" and "fall back to nearest reachable" with one sort, and returns
null (a toast, no movement) when every neighbour is blocked. A player
click takes priority over the floor/seat/chair beneath them on every
click surface that can reach that tile — the canvas itself, a dining/
stool seat-target button, and a game-chair button all needed the same
`playerAt`-first check added, since the two button types are separate
DOM elements layered over the canvas and never go through its own click
handler at all.

**A real bug the shared test server's own parallelism caught
immediately**: `spec/bar.test.ts`'s "accepts a single adjacent step"
test assumed a fixed `+1,0` neighbour of spawn was always free — with
real occupancy enforced, a concurrently-running test file's own patron
could legitimately already be standing there. Fixed the same way
`spec/live.test.ts` already handled the identical class of problem (try
all four cardinal neighbours, require at least one to succeed) rather
than asserting a specific direction. A second instance of the same root
cause surfaced in `spec/chat.test.ts`'s own "walked apart" test once the
new spawn-jitter was added (below) — fixed identically.

## Part 3 — proximity-triggered 1:1 chat

**Data model (new, `src/db.ts`)**: `chat_threads` (id = the two player
ids sorted and joined, so a pair has exactly one thread regardless of who
initiates) and `chat_messages` (`UNIQUE(thread_id, sender_id,
client_msg_id)` — the idempotency key for a retried send). Never joined
into, or exposed through, the public bar/room SSE payloads.

**Server (new `src/chat.ts`, `src/live.ts`'s new `chatInboxSubscribers`,
`src/server.ts`'s new routes)**: `openThread` and `sendMessage` each
independently re-validate — real session, both parties online, and
adjacent via effective position — never trusting that an earlier check
(or the client's own walk having just finished) still holds. Delivery is
per-player, not per-thread or broadcast: a sent message reaches exactly
its sender's and recipient's own authenticated inbox channel
(`GET /api/bar/chat/events`, query-param-authenticated since SSE can't
send a body or custom headers), each independently verified before
subscribing. A per-sender sliding-window rate limiter and a 1–500
character plain-text limit round out the direct abuse surface.

**Client (`public/tavern.js`)**: clicking another patron within 3 tiles
(Manhattan) walks them to a free adjacent tile (the same
`findApproachTile` Part 2 built) and opens the dialog on arrival; beyond
3 tiles the same walk happens without auto-opening (click again once
near). The walk-toward-chat gesture (`chatChase`) re-checks the target
every tick it's in flight — re-plans a bounded number of times if they
move, gives up with a clear message if they log off, never chases
unboundedly. Messages render via `textContent`, never `innerHTML`. A
small floating banner (`chatBanner`) surfaces an incoming message for a
thread that isn't currently open, naming the sender, openable by a
click — the chat inbox stream only ever runs while the bar canvas itself
is mounted, so it's structurally impossible for it to interrupt an
ongoing game (a different route/page entirely, per CLAUDE.md's existing
bar/game separation).

## Verification

`spec/occupancy.test.ts` (8 cases) and `spec/chat.test.ts` (10 cases),
both direct-DB (same pattern as `spec/tableExpiry.test.ts`) for exact
control over presence/distance without waiting out real thresholds:
refusing a move onto a connected occupant, accepting one onto a vacated
tile, two joins landing on different tiles, `findFreeTile`'s own
contract, rejoin repairing a stolen tile without failing recovery,
`effectivePosition` reporting a chair tile for a present occupant and
the raw coordinate for a departed one; opening/sending success and every
refusal path (too far, offline, self, not-a-participant, empty, too
long, rate-limited), idempotent retry, and a third identity refused both
`requireThreadAccess` and a forged secret. All 192 tests green, `pnpm
check` run three times straight (the parallel-test-occupancy class of
flake above made a single green run insufficient evidence this time).

**Live verification, two and three real independent browser contexts
(Playwright, local)**: two patrons spawned near each other; one clicked
directly on the other's tile and landed exactly adjacent, never
overlapping, confirmed by both the client's own reported position and a
direct raw `/api/bar/move` call onto the same tile separately refused
(409) at the server — proving the server's own check, not just the
client's approach-tile logic, is what actually holds. Chat: clicking
opened the dialog with the correct nickname; the recipient (who hadn't
opened anything) saw a notification banner, opened it, and saw the
message; replied, and the first patron saw the reply live with no
reload; one patron then genuinely walked away (arrow keys, after closing
her own open dialog so movement wasn't disabled by it — the same rule
every dialog already follows) and the other's next send was refused with
a "too far" message while the existing transcript stayed exactly as it
was. A third identity, several tiles from the first two, was refused
opening a chat with either (`too_far`) and, separately, refused reading
the real pair's own thread by its real (deterministic, guessable) id
directly (`403 unauthorized`) — the access check, not the id's obscurity,
is what's actually protecting it. A dedicated reconnect check dropped one
participant's network entirely (Chromium context offline) mid-
conversation, sent a message from the other side while she was
disconnected, then restored her connection — her already-open dialog
caught up on the missed message within about a second of reconnecting,
with no manual reload, via the inbox stream's own `onopen` catch-up
fetch. A separate real-restart check (the dev server process killed and
restarted, data directory preserved) confirmed a chat thread's messages
and a patron's bar position both survive exactly as a SQLite-backed
feature should — not an in-memory one quietly reset by the restart.

**Regression**: the full existing suite (direction-hold, seating
sit/stand, online-table approval, NPC games, SSE restart recovery) stayed
green throughout — see the "All 192 tests green" note above; nothing in
that suite needed behavior changes, only the two occupancy-fragile tests
already described.

`pnpm check:evidence` green. Committed (`6b3b71f`), pushed, CI's
`checks` job passed (run `38186521920`).

**Deployed and verified live**: `/version` on
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` returns `30318e425b`,
matching the local build exactly. A throwaway probe (three identities,
created and never touching the student's own real tables) against
production confirmed: the real layout response carries all 4 dining
tables at the new positions; a cross-tile jump attempt refuses (409);
walking a second probe adjacent to the first via real single steps
succeeded cleanly (no overlap at any point); a chat thread opened and a
message sent returned 201, and — held open via a real SSE connection to
`/api/bar/chat/events`, not just checked for persistence — the
recipient's stream received it live within under 2 seconds; a third
probe identity was refused opening a chat with the first (`409
too_far`, correctly failing the distance check from across the bar) and
refused reading the real pair's own thread directly by its real,
deterministic id (`403 unauthorized`). One of this probe's own move
calls landed on `invalid_move` rather than the `tile_occupied` code path
specifically (the two probes weren't yet adjacent at that exact step,
an artifact of this probe script's own spacing, not a gap in the
feature) — the `tile_occupied` path itself is covered by
`spec/occupancy.test.ts` and was independently confirmed with two real
adjacent browser contexts in the earlier local verification, and CI ran
that exact suite against this exact commit before it was deployed. 等待用户验收.

# User acceptance feedback (2026-10-12): private chat → public speech bubbles, two map texts removed

The student's own manual acceptance testing of the previous entry
rejected the private 1:1 chat's basic shape outright: "我希望发送的文字直接
显示在发送者头上的气泡里,酒馆里的其他玩家都能看到,不再是一对一私聊" (I
want sent text to show directly in a bubble over the sender's head,
visible to every other patron in the bar — no longer 1:1 private). They
also asked for the two row-banner map texts removed, and, mid-session via
a side message, that the bubble specifically use a semi-transparent gray
background with white text (overriding this plan's own first instinct of
a light-background/dark-text bubble, matching the rest of the world's
existing light-dialog palette).

## Design change: private chat → public speech, and why it's a genuine architecture change, not a reskin

The previous entry's whole design was built around a *recipient*: a
thread between two specific identities, a per-player authenticated
delivery channel, a proximity trigger that walked you up to someone and
opened a dialog once adjacent, server-side adjacency re-validated at
send time. None of that machinery has a recipient to re-validate against
once speech has no addressee at all — so this isn't "put the old
messages in a bubble instead of a dialog," it's a different feature built
on different primitives, landing on top of the *same* already-existing
public bar snapshot/SSE broadcast instead of inventing (or keeping) a
second, private one. See CLAUDE.md's "Public tavern speech superseded
private 1:1 chat" section for the settled design and exactly what was
kept, what was removed, and what never changed in the first place
(tile occupancy, seating, approval, NPC games — none of that was ever
chat-specific, so none of it moved).

**Explicitly preserved, not touched**: `src/chat.ts`, `chat_threads`/
`chat_messages`, the `/api/bar/chat/*` routes, and `src/live.ts`'s
`chatInboxSubscribers` registry are all still there, unchanged, still
passing their own original test suite (`spec/chat.test.ts`, 10/10) — the
student's own instruction was explicit that existing private records
must keep their original access control rather than leaking just because
the *client* stopped using that feature. Only `public/tavern.js`'s use of
them was removed (`beginApproachAndChat`/`chatChase`, the dialog, the
notification banner, the recipient-selection concept).

**New (`bar_speech`, `src/bar.ts::say`, `POST /api/bar/say`)**: one
active utterance per bar identity — not an append-only log, since
there's no history to show, just "what are they saying right now, if
anything." `expires_at` is an absolute timestamp set once at send time;
`getPublicBarState` filters it lazily (the lobby-disconnect-grace
pattern, not a sweep), which is what makes a reconnect report the
*remaining* window rather than restarting it, and what lets a bubble's
natural expiry piggyback on the exact same presence-ticker signature-diff
that already notices "someone went offline" — `speech` is just one more
field in the same `players` array that diff already compares, so a
bubble disappearing on its own gets pushed to everyone within about a
second with zero new ticker logic. Idempotency means something specific
here: a retried send with the same `clientMsgId` must NOT restart the
clock (a network retry of the identical utterance), while a genuinely
new one from the same person both replaces the old bubble and does
restart it — these are different code paths precisely because this is a
single-current-value row, not a message history.

**Client (`public/tavern.js`)**: a persistent, always-visible input +
Send button (Enter submits), no dialog, no targeting at all — clicking a
player still walks you up next to them (`approachPlayer`, renamed from
`beginApproachAndChat`, chat side-effect removed), since that was always
part 2's own rule, never chat-specific. The bubble itself
(`drawSpeechBubble`) is drawn directly on the canvas, so it can never
intercept a click underneath it; `wrapBubbleText` handles both space-
delimited wrapping and a character-level fallback for a single "word"
wider than the whole bubble (long CJK, a long no-space token), iterating
by Unicode code point so a surrogate-pair emoji is never split. Follows
whatever screen position a patron's nickname tag already uses — a
present game-chair occupant's real chair tile just as much as a standing
or dining/stool-seated patron's own interpolated position — so movement,
sitting down, and the camera panning all carry it for free.

## The two map texts

`public/tavern.js`'s `rowBanner` function and its two calls ("◆ ONLINE —
REQUEST TO JOIN", "◆ SOLO VS. 3 NPCS") are deleted outright, per the
explicit "只删除这两行地图横幅文字及对应绘制代码" instruction — every
table's own on-table label, the table dialog's own explanatory copy, and
the online/NPC mode logic itself are all unchanged.

## Verification

`spec/speech.test.ts` (9 cases, direct-DB like `spec/chat.test.ts`):
visibility through the ordinary public state read (including a third
identity's own read, proving it's genuinely public, not addressed),
trim/empty/length validation, auth, a genuinely new send replacing the
bubble and advancing its expiry, a retried `clientMsgId` being a true
no-op (identical stored row, not just identical visible text), natural
expiry reported as `null`, a reconnect-equivalent plain re-read reporting
the *same* absolute expiry rather than a freshly-computed one, and the
rate limiter tripping on a real burst. All 201 tests (192 prior + 9 new)
green, `pnpm check` run twice clean, `pnpm check:evidence` green.
`spec/chat.test.ts`'s own 10 cases needed zero changes and still pass,
confirming the old private module's behavior and access control are
genuinely untouched.

**Live verification, real browser contexts (Playwright, local, screenshots
taken of each)**: three independent identities — one spoke, and *both*
others saw the bubble on their own independent read of `/api/bar/state`
with no click, no approach, no proximity at all, confirming this is
actually public broadcast rather than a disguised 1:1. Content variety
checked visually: a short Chinese phrase, a long Chinese sentence
(wraps across 3 lines, no overflow), a long single English word with no
spaces (`Supercalifragilistic...`, wraps mid-word by character), and a
mixed English/emoji/Chinese string (renders correctly, wraps across 2
lines) — all against the bubble's actual rendered max-width, not just
unit-tested wrapping logic in isolation. Sending again replaced the
bubble with only the newest text ever visible. Walking several tiles
south (real arrow-key movement) kept the bubble correctly anchored above
the moving character as the camera panned. Sitting at a real dining chair
(reached via an actual BFS-pathed walk and a real seat-button click, not
a teleport) kept the bubble correctly following the seated position.

A dedicated timing check against a server instance started with
`SPEECH_DISPLAY_MS=2500` (a real, shorter window — not mocked) confirmed
all three expiry/reconnect rules precisely: a bubble vanishes on its own
after the window with no further action; a context dropped (Chromium
`setOffline`) while a bubble is still active and restored partway through
still shows it, then still expires at the *original* time rather than
getting a fresh window from the reconnect; and a context dropped until
well past expiry and restored afterward never replays the vanished
bubble. A separate check confirmed zero requests to `/api/bar/chat/*`
occur during an entire ordinary session (join, speak, move, sit, stand) —
the old private endpoints are reachable only by someone who still has
code calling them directly, never by anything the current client does.

**Regression**: a real BFS-pathed walk to a dining chair, a real click on
the seat button, sitting, and standing back up all worked identically to
before this pivot (`seatId` set then cleared correctly) — tile occupancy,
online-table approval, and NPC games are unchanged code paths, already
covered by the full 201-test suite rerun above, not retested by hand
beyond this one live touch.

Committed (`73b312f`), pushed, CI's `checks` job passed (run
`38193682181`).

**Deployed and verified live**: `/version` on
`https://comp4020-final-shuyangyuzu-cmd.fly.dev` returns `740908f3f0`,
matching the local build exactly (the same hash visible in every local
screenshot above). Two throwaway probe identities, created in the real
production tavern alongside the student's own two actual patrons at the
time (visible in the screenshots, never interacted with) — one spoke
("Hello from production! 你好 🎉"), and the other's own independent read of
`/api/bar/state`, from its own separate camera view, saw the bubble with
no approach or click at all, confirmed by a screenshot from each
patron's own page showing the identical bubble and the real build number
in the corner. A second message during the same session confirmed, via
request logging, zero calls to any `/api/bar/chat/*` endpoint — the old
private module is live and intact (unused) in production too, never
reached by normal use. 等待用户验收.
