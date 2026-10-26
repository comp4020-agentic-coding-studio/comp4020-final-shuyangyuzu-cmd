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

**A real CI flake, caught by CI itself, fixed in a follow-up commit.**
The verification-record push above (a PLAN.md-only diff, no code change)
failed CI's own test run — not a deploy regression, since `deploy` never
runs when `check` fails, so production stayed on the prior, already-
verified build throughout. `spec/live.test.ts`'s own SSE-push test tried
all 4 cardinal neighbours of one fixed spawn tile and asserted at least
one move succeeded, same defensive pattern as `spec/bar.test.ts`'s own
adjacent-step test — but under tile occupancy (product-direction-update,
the three-improvements entry above), it's possible, if rare, for *all 4*
immediate neighbours of one spawn tile to be legitimately held by other
patrons this same parallel CI run spawned nearby; trying harder from the
same unlucky tile was never going to fix that. Both tests now retry with
a **fresh join** (a new, independently jittered spawn) up to 5 times
rather than giving up after one spawn's own 4 neighbours, and
`spec/live.test.ts`'s own event-count assertion was loosened from
"exactly 2" to "at least 2, and the last one's seq exceeds the first's"
to tolerate each retry's own join also producing a push on the already-
open stream. 201/201 green across 4 consecutive local runs after the
fix, `pnpm check:evidence` green; pushed as its own commit.

## Crit 10 prep ("Fly by instruments") — setup and baseline only, 2026-10-14

No functional code was changed for this entry. Everything under "From
code inspection" was read directly from `src/*.ts` at HEAD
(`a1b8242`). Everything under "From running something" was actually
executed this session, scoped as stated. Crit 10's cutoff is **Monday
2026-10-19 13:30, Australia/Sydney** (same local time as
Australia/Canberra), session 15:30–17:30, confirmed against the live
course schedule via the `next-deadline` check, not assumed from the
pasted brief — Bādà group.

### Baseline check (from running something)

- Branch `main`, HEAD `a1b8242`, in sync with `origin/main` (`git
  fetch` + `git status` clean except the one pre-existing untracked
  file below). No local commits ahead or behind.
- Tags `crit-8` → `a7064086` and `crit-9` → `5fc04b02` (tagging commits
  `a1b8242`/`a706408` resolved via `git for-each-ref`) are both
  ancestors of `main` in the right order (`crit-8` before `crit-9`
  before current HEAD, verified with `git merge-base --is-ancestor`).
  Neither was moved or touched.
- `src/orders.ts` is untracked and was left alone, per instruction —
  not read for content, not staged, not committed.
- Repo visibility: `PUBLIC` (`gh repo view`). Latest CI run (`checks`
  on push `38195379716`, commit `a1b8242`) is green.
- Fly app `comp4020-final-shuyangyuzu-cmd`: one `syd` machine, state
  `stopped` (auto_stop_machines, expected when idle) at status-check
  time; `mise exec -- flyctl status` used throughout, token never read
  or printed directly. Live `/version` returns `740908f3f0`, which
  matches a from-scratch local hash of
  `public/{app.js,styles.css,tavern.js,liveSync.js}` at HEAD exactly —
  **the deployed app is current with HEAD**, not stale.
- Live `/` returns 200 with `Cache-Control: no-cache`; live `/readme/`
  returns 200. No production room was created, no production action
  taken beyond these three read-only GETs plus the existing bar-speech
  verification already recorded above (not repeated this session).
- Local run: started the server pointed at an isolated temp
  `DATA_DIR` (never the real `./data`), confirmed `/`, `/version`,
  `/readme/` all 200, ran `pnpm check` (201/201 tests, typecheck
  clean) and `pnpm check:evidence` (reflections present, all 23
  PROCESS.md-cited commits resolve) against it, then stopped that
  process. The real local/production databases were never opened by
  this session.
- `pnpm install` reports `11.9.0 → 12.11.2` available for pnpm itself;
  not upgraded (out of scope this session, reporting only). Course
  plugin versions (`comp4020` 0.14.27, `comp4020-statusline` 0.3.5)
  both report current via `plugin-version.sh`.

### What Crit 10 actually asks for, read from the live spec page

Fetched `/crits/10-fly-by-instruments/` directly (not reused from the
pasted brief) to check it hadn't drifted. Six checkable lines: (1)
multi-user by the brief's own definition, deployed by cutoff; (2)
see/change permissions checked server-side and the decision **written
down in the repo with why**; (3) server-side action logging that
**outlives the crit**; (4) at the crit, two pod members use the app
from its URL alone in separate Chrome profiles while the presenter
narrates purely from `mise exec -- flyctl logs`, no clicking the
presenter's own UI; (5) process evidence (commits, PROCESS.md,
`reflections/crit-10.md`); (6) can account for direction/grounding/
correction. Items 2 and 3 are new asks this week — 1 is very likely
already true of the existing bar+room architecture (see below), but
unverified end-to-end with two real separate browser identities this
session, per the "don't create test players" constraint.

### Identity and authority (from code inspection — file:line cited)

- **Two identity layers, two secrets, confirmed separate**: bar
  identity in `bar_sessions(player_id, session_secret)`, created
  `src/bar.ts:151-184`, checked by `requireBarSession`
  (`src/bar.ts:190-197`); game-room identity in
  `sessions(player_id, room_id, session_secret)`, created
  `src/rooms.ts:220-252`/`351-399`/`423-459`, checked by
  `requireSession` (`src/rooms.ts:188-195`). Neither secret is ever
  joined into a public-response query (`src/db.ts:55-57` comment,
  confirmed against `toPublicState`, `src/rooms.ts:995-1030`: no
  `session_secret` field, deck order excluded, only `deckSize`
  exposed).
- **The two layers are linked, but only for routing, never for
  logging**: `bar_players.current_table_id`/`current_game_player_id`
  (written `src/tables.ts:375,429,475`) let `resolveActiveSeat`
  (`src/tables.ts:251-282`) find "which room is this bar patron's
  active game" by following that pointer into `sessions.room_id`.
  Nothing currently logs this link anywhere — an operator watching
  only `flyctl logs` has no way today to say "this bar patron is that
  room player."
- **Server-side authority checks are real, not UI-only** (this is the
  part of items 1/2 that's load-bearing and already correct): every
  room mutation requires a matching session before anything else
  (`rooms.ts:920-922` roll, `:862-864` startGame, `:953-957` place);
  turn/phase are re-checked server-side regardless of client state
  (`src/game.ts:88-91`, `:107-110`, surfaced as 409 at
  `rooms.ts:935`); host-only actions (approve/decline/disband/start)
  throw `403 not_host` when the caller isn't the room's host
  (`rooms.ts:478,541,702,866` — approve's own check read in full at
  `rooms.ts:470-523`); an NPC-controlled seat refuses its original
  human's still-valid session (`rooms.ts:911`, called at `:929`). This
  is genuine server authority, not a disabled button — satisfies the
  *mechanism* half of spec item 2 already.
- **Private chat's old access control is untouched and still correct**:
  `requireThreadAccess` (`src/chat.ts:224-232`) still calls
  `requireBarSession` then a participant check before any thread read,
  exactly as CLAUDE.md's "already-saved private records keep their
  original access control" states — confirmed by reading the function,
  not assumed from the doc.
- **Minor, noted not fixed**: `sessionSecret` travels as a URL query
  parameter for the SSE/GET paths (`server.ts:651`, `:747`). Fine
  within the app's own code (CLAUDE.md's "never in a public response"
  rule is about response *bodies*, and this isn't one), but worth
  knowing before pointing any proxy- or access-log tooling at this app
  later, since a URL can end up in such logs upstream of the
  application itself.

### The actual gap: server-side logging does not reach `flyctl logs` at all

This is the one finding that changes what's buildable before Crit 10,
confirmed two independent ways this session: (a) reading
`src/rooms.ts:70-77`'s `logEvent` — it only ever does `INSERT INTO
events ...`, no stdout write, called for `rolled`, `placed`,
`join_approved`, `game_started`, `npc_takeover` and others, entirely
inside SQLite; and (b) actually running `mise exec -- flyctl logs -a
comp4020-final-shuyangyuzu-cmd --no-tail` against the live app this
session — the real output is machine boot/stop/restart lines only
(Firecracker start, mount, "listening on", autostop), **zero
application-level lines of any kind**, which is exactly what (a)
predicts. A full repo-wide grep found exactly two `console.*` calls in
all of `src/`: `server.ts:231` (`console.error(err)`, generic 500
catch-all) and `server.ts:827` (the one-time "listening on..." startup
line). There is no request logger and no per-action logging of any
kind reaching stdout.

Consequences for Crit 10 item 3/4 specifically:
- **Rejections are currently silent to a log-only observer.** Every
  typed error (`RoomError`/`BarError`/`TableError`/`ChatError` —
  wrong-session 403, `not_host`, `not_your_turn`, `wrong_phase`, 410
  `room_closed`, etc.) is turned into a JSON response by
  `app.onError` (`server.ts:227-232`) with **no log line at all**; only
  genuinely unexpected 500s hit `console.error`. The crit's own
  critical-finding condition — "one player alters the other's data" —
  is already prevented server-side (previous section), but a
  *presenter watching only `flyctl logs`* currently has no way to
  **show** a rejection happened, which is exactly what item 4 asks
  for.
- **Bar-world actions have no event at all, in any sink.** `move`,
  `sit`, `say`, `appearance`, table create/join/depart write nothing
  to `events` and nothing to stdout — only game-room actions
  (`roll`/`place`/`approve`/etc.) reach the SQLite `events` table, and
  even those never reach stdout.
- **Same-name disambiguation is currently impossible from logs**,
  because there's nothing in logs to disambiguate at all; even the DB
  `events` rows that do exist carry a room `playerId` and sometimes a
  nickname, never the bar identity id, so correlating "tavern
  character" to "game player" isn't possible even by querying the DB
  directly today.
- **No secret/token leak found.** No `console.*` call references
  `session_secret` or any token; the one `console.error(err)` call
  logs an error object, not request fields, so nothing today prints a
  secret. Worth re-checking once real logging is added, since a naive
  "log the request" helper could easily start including the
  `sessionSecret` query parameter noted above.
- **Item 2's "written down in the repo with why" is not yet
  satisfied as a single artifact.** The mechanism is correct and
  CLAUDE.md documents the *rules*, but there is no one place in the
  repo that states, as a design decision, who may see/change what and
  why — this is a documentation gap, not a code gap.

### Suggested implementation order (not started, for the student's own decision)

1. One structured stdout line per request/mutation from a single choke
   point (e.g. inside the existing `app.use("*", ...)` middleware at
   `server.ts:222-225`, or alongside `app.onError`), carrying: a
   timestamp, the route/action, outcome (ok/rejected + error code),
   bar identity id (short, non-secret) and nickname where known, room
   code and room `playerId` where known. Never the secret itself.
2. Make `app.onError` (`server.ts:227-232`) log the four typed-error
   rejections too, not just the 500 fallback — this is what makes "one
   player can't touch the other's data" demonstrable purely from
   `flyctl logs` at the crit.
3. Mirror `logEvent` (`rooms.ts:70-77`) to the same structured stdout
   line in the same call, so DB `events` and `flyctl logs` never
   disagree, and extend equivalent logging to the currently-silent bar
   / table actions (`move`, `sit`, `say`, join/approve/create/depart).
4. Add the short, stable, non-secret per-identity tag (e.g. a prefix
   of the player id) to every such line, specifically so two
   same-nickname classmates are distinguishable live at the crit, and
   so a bar identity and its active room player can be read as the
   same actor across both log lines.
5. Write the "who may see/change what, and why" decision down as its
   own section (likely in README.md or a new short doc — the
   student's call, given README.md/PROCESS.md are both off-limits to
   this session) rather than leaving it implicit across CLAUDE.md's
   rules.
6. Add a couple of targeted tests once logging exists: a rejection
   produces a log line; no log line ever contains the literal
   `sessionSecret` value; two same-nickname identities log with
   different identity tags. (Out of scope this session — no code was
   written.)

This entry is a baseline record only. No implementation choice above
has been made; the student decides scope and order next.

## Crit 10 implementation (2026-10-16) — structured action logging, ADR, verification

Acting on the prep baseline above, the student asked for the full
implementation: structured server-side action logging reaching
`flyctl logs`, the access-control decision record the spec asks for,
and live verification with two separate Chrome-profile identities.

**What was built, by commit:**

- `31b605e` — `src/actionLog.ts` (the new single-line JSON logger,
  `formatActionLogLine` exported separately from the `console.log`
  side-effect for unit testing) plus every existing `logEvent` call
  site in `src/rooms.ts` gaining a sibling `logAction` call, inside
  the same transaction, after the same write, before any later throw.
  **This commit's own claim that this made a rolled-back write
  "structurally incapable of being logged as a success" was wrong — see
  the correction entry below, dated 2026-10-17, for the real bug this
  turned out to have and the actual fix.**
- `481fc5c` — bar and table-binding actions that previously wrote no
  event anywhere (`move`, `sit`, `stand`, `say`, `join_bar`,
  `rejoin_bar`, `update_appearance`, `create_table`, `join_table`,
  `start_npc_game`, `depart_table`, `resume_table`, and both branches
  of `enforceExpiredDepartures`) gained their first logging. A bar
  move is debounced to at most once per `BAR_MOVE_LOG_WINDOW_MS`
  (default 3s) per player — logging every tile step would flood
  `flyctl logs` and actively hurt the crit's own "narrate from logs"
  readability. `createTableRoom`/`joinTableRoom`/`startNpcGame` log
  the bar identity and the room player it just became together in one
  line, which is what lets a presenter correlate a tavern character to
  a game player purely from the terminal, since `rooms.ts` itself
  deliberately never imports bar internals (CLAUDE.md's bar/game
  separation).
- `aad21d2` — rejection logging at the one choke point every typed
  error already passes through (`app.onError`, `src/server.ts`),
  reading a claimed identity best-effort from the already-parsed JSON
  body (Hono's `HonoRequest.json()` caches its parsed result, so a
  second call here after a handler already consumed it is free) or,
  for the chat GET/SSE routes, from query params. **This commit's own
  `verified: err.code !== "unauthorized"` heuristic was wrong — see the
  correction entry below for the real bug and the actual fix
  (real evidence via `wasIdentityVerified()`, not an inference from the
  error code).** `spec/actionLog.test.ts` (12 new tests, direct-DB style
  since the HTTP-level spec files run against a separate process and
  can't spy on its stdout) added in the same commit.
- `87f423b` — `ADR-access-control.md`, written against the actually-
  running code (every file:line citation re-checked while writing it;
  no mismatch found between the document's claims and the code).
- `0e2cc90` — README.md's checks section and a new first-person
  PROCESS.md section describing the above, citing the real commits.

**Local verification (code-level, from actually running the suite):**
`pnpm check` against an isolated temp `DATA_DIR` (same method as the
prep baseline): 213/213 tests pass (201 original + 12 new), typecheck
clean. `pnpm check:evidence` green (27 cited commits in PROCESS.md, all
resolve). Captured log output from a local run showed no `sessionSecret`
string anywhere and `create_table`/`join_table` lines correctly pairing a
bar id with the room player id it became — both of those claims held up.
**The claim that rejection lines' `verified` field was "set correctly"
did not hold up**: it was computed from the error's own code
(`err.code !== "unauthorized"`), not from any actual record of whether a
session check had run — see the correction entry below for the bug this
was (confirmed, not hypothetical) and the fix.

**CI and deploy:** pushed as 5 commits (`31b605e`..`0e2cc90`). CI run
`38893718915` completed `success` on `0e2cc90` (both its `check` and
`deploy` jobs). Live `/version` returns `f98a82fb63`, which matches a
from-scratch local hash of `public/{app.js,styles.css,tavern.js,
liveSync.js,favicon.svg}` at the same HEAD exactly (the version hash
now also covers `favicon.svg`, added in the unrelated `dc6e680`
rename commit, carried forward unchanged here) — the live deployment
is confirmed current with this work.

**Live production rehearsal — an honest account of what this actually
was.** Two real Chrome browser profiles were not available to this
session; what was actually done instead was issuing the exact same
public HTTP requests a browser would make (the identical endpoints,
bodies, and session-secret handling `public/app.js`/`tavern.js` use),
from this session's own shell, against the real, live, deployed app —
while watching `mise exec -- flyctl logs -a
comp4020-final-shuyangyuzu-cmd` live in a separate process the entire
time. This exercises the exact same server code path two real browser
tabs would hit (nothing about the server can tell the difference
between "a fetch() call from app.js" and "a fetch() call from this
shell" — that's the whole point of a stateless HTTP API), but it is
not the same as an actual two-person, two-profile demonstration, and
is recorded here as what it was, not inflated into more than that. The
real two-profile rehearsal, with the student narrating purely from the
same `flyctl logs` command, remains for the actual crit session.

Two throwaway identities, `Crit10-RehearsalA` and `Crit10-RehearsalB`,
joined the live bar, and the following sequence was run end to end,
with every line below actually observed arriving live through `flyctl
logs` within about a second of the request that caused it (confirmed
by this session watching the monitor fire in real time, not
reconstructed afterward):

1. A and B join — `join_bar` lines, correctly distinct short ids
   (`34853d7b` vs `9fbfc7d5`) despite similar chosen nicknames.
2. A speaks publicly — `say` logs sender, `clientMsgId`, and message
   *length* only (`"length":26`), never the text itself.
3. **B attempts to speak as A**, submitting A's `playerId` with B's own
   `sessionSecret` — rejected `unauthorized`, logged with
   `"verified":false` and `"actor":{"kind":"bar","id":"34853d7b"}` (the
   *claimed* id, correctly carrying no nickname, since nothing about
   this attempt was ever confirmed as genuinely A). This is the crit's
   own critical-finding condition, demonstrated failing to succeed, and
   visible from the log line alone without reading either player's
   screen.
4. A creates a Vegas table — `room_created` then `create_table`, the
   second line pairing the bar id (`34853d7b`) with the room player id
   it just became (`8e693c37`) in one line, exactly the correlation
   this week's design added.
5. B requests to join that table — `join_requested` then `join_table`,
   `"pending":true`, correctly not yet a seat.
6. **B tries to approve their own pending request** (self-admission,
   never the host) — rejected `not_host`, attributed to B's own room
   id (`0a87628a`).
7. A, the real host, approves B — `join_approved`, attributed to A's
   room id (`8e693c37`), naming the approved player.
8. **B tries to roll before the game has started** — rejected
   `wrong_phase`, attributed to B's own room id.
9. A disbands the rehearsal room — `room_disbanded`, cleanup confirmed
   logged.

No line in this entire sequence contained `sessionSecret` or any
generated secret value — checked directly against the captured monitor
output, not just asserted. Every rejection (steps 3, 6, 8) was visible
and attributable purely from the log line, with no need to inspect
either identity's own response body — which is the actual thing the
crit's own "narrate from logs" requirement asks for. This production
run used only the two clearly-named throwaway identities above; no
other room or the student's own data was touched.

**Residual gap, found by doing this rehearsal rather than assumed
away:** this session has no real two-Chrome-profile capability, so the
"two separate browsers, two separate cookie jars" half of the brief's
own rehearsal is still unverified in the strictest sense — the HTTP
layer being identical either way is a reasonable inference, not a
substitute for actually doing it. The student should run the real
two-profile version once before the crit itself, which this session
could not perform.

## Crit 10 correction (2026-10-17) — real bugs the student's own agent found in the logging fix above, across two review passes

The student had their own agent review the logging implementation above
and report back concrete, reproducible defects — not stylistic concerns,
genuine correctness bugs in what earlier entries claimed was already
correct. Each is documented here with what the bug actually was, how it
was reproduced (a failing test *before* any fix, not just asserted), and
what the real fix turned out to need. Bug 1 took **two** attempts to
actually fix — the first attempt itself turned out to be incomplete, and
is kept in this record rather than silently replaced, because it's a
genuinely useful example of why "buffer the log call and flush on
commit" is not, by itself, a complete description of the fix needed
here.

### Bug 1: a rolled-back outer transaction could still log success

**The claim that turned out to be false:** the 2026-10-16 entry above
said every `logAction` call sat "inside the same transaction, after the
same write, before any later throw," making a rolled-back write
"structurally incapable of being logged as a success." This reasoning
holds for a single, non-nested `db.transaction()` call, but
`src/tables.ts`'s `createTableRoom` wraps a call to `rooms.createRoom`,
which has its own `db.transaction()` — real nesting that already existed
in production code, not a contrived scenario. better-sqlite3 implements
nesting as a SAVEPOINT/RELEASE pair: when `createRoom`'s own inner
transaction finishes successfully, its SAVEPOINT is RELEASEd immediately
— committed, as far as SQLite is concerned — even though the *outer*
transaction (`createTableRoom`'s own) hasn't decided anything yet.
`console.log` has no rollback semantics at all: a log call made during
that inner, successfully-released transaction has already printed by the
time an unrelated failure later rolls the *outer* transaction back.

**Reproduction, confirmed failing before any fix:** `spec/actionLog.test.ts`'s
`"a rolled-back OUTER transaction around createRoom leaves no room row
AND no success log line"` wraps a call to `rooms.createRoom` in a raw
`db.transaction()` that deliberately throws immediately afterward. Run
against the original code, this failed exactly as predicted: `SELECT
COUNT(*) FROM rooms` correctly showed 0 (the write did roll back), but
the captured `console.log` spy still showed one `"room_created"`,
`"outcome":"ok"` line.

**The first fix attempt was itself incomplete.** The obvious fix —
introduce a `transact(db, fn)` helper that checks `db.inTransaction` to
decide whether it's the outermost call, and buffers logging accordingly,
with every call site migrated from raw `db.transaction()` to this helper
— passed the reproduction test above on the first attempt, because that
test happens to nest two calls that *both* go through the new helper
(`createTableRoom`'s own `transact()` wrapping `createRoom`'s own
`transact()`). But the regression test as originally written used a raw
`db.transaction()` for the *outer* call specifically to mirror the
user's own bug report, and against the helper-only fix, it still failed
identically — a raw outer `db.transaction()` wrapping an inner
`transact()`-using call has no way to know the helper's own
`pendingByDb` buffer exists at all, so nothing ever flushed or discarded
it when the outer raw transaction committed or rolled back. This is
recorded here specifically because it's the kind of fix that looks
complete (it passes `pnpm check`, it passes the one test written to
describe the original bug) while still depending on every call site
remembering to use the new helper instead of calling `db.transaction()`
directly — exactly the discipline-dependent shape that let the original
bug exist in the first place.

**The second fix attempt:** `src/actionLog.ts`'s `installTransactionLogging`
patches `Database.prototype.transaction` itself — not a new wrapper
function callers have to remember to use, but the method every call site
(old or new, migrated or not) already calls. `src/db.ts`'s `openDb`
installs this patch once, immediately after opening the connection,
before any other code can call `db.transaction`. Every transaction on
that connection — invoked via the `transact()` convenience export or a
raw `db.transaction(fn)()` — now gets buffering handled automatically.
Because this is keyed off the identical `db.inTransaction` flag
better-sqlite3 itself uses to decide SAVEPOINT-vs-BEGIN, the two can
never disagree about what counts as "outermost." Re-run against this
fix, the original regression test (raw outer `db.transaction()`,
`transact()`-using inner `createRoom` call) passed, and a live local
server run reproduced the same nested shape for real HTTP traffic
(`createTableRoom` → `createRoom` → `startGameLogic` for the solo-NPC
path): the full chain of `solo_npc_room_created`/`game_started`/
`start_npc_game` log lines all appeared together, correctly. **This
attempt used a single flat buffer per database connection — still
pushed one more bug, documented next, that this specific test shape
didn't exercise.**

### Bug 1b: a single flat buffer couldn't tell an inner rollback from an outer commit

**The claim that turned out to be false:** the previous paragraph's "now
buffers what it logs and flushes that buffer to stdout only when the
actually-outermost transaction commits" described a **single buffer per
db connection**, shared across every nesting level. This is correct for
"outer commits, outer rolls back" and for "outer rolls back after an
inner transaction already committed" (the two shapes the first
regression test actually exercises) — but wrong for a third shape a
second review pass specifically constructed: an **inner** transaction's
own SAVEPOINT rolling back, **caught by the outer transaction**, which
then recovers and goes on to commit something else entirely for real.
With one flat buffer, the inner call's own `"outcome":"ok"` entry and the
outer call's own later, genuinely-successful entry have nothing
distinguishing them from each other — both just sit in the same array,
and the outer transaction's real commit flushes both, even though the
inner transaction's own database row never existed once its own
SAVEPOINT rolled back.

**Reproduction, confirmed failing before any fix:** a new
`spec/actionLog.test.ts` case constructs exactly this shape directly: an
outer `db.transaction()` that runs an inner `db.transaction()` calling
`rooms.createRoom("DoomedNested", ...)` and then throws, catches that
throw immediately, then calls `rooms.createRoom("SurvivingNested", ...)`
a second time and lets the outer transaction commit for real. Run
against the flat-buffer fix, this failed exactly as predicted: only one
room (`SurvivingNested`) actually existed in the database afterward, but
**two** `"room_created"` lines were captured — one for the surviving
room and one for the doomed, rolled-back `DoomedNested` attempt that was
caught and recovered from.

**The actual fix:** a **stack** of buffers per database connection, one
per currently-open transaction level, rather than one flat buffer for
the whole connection. Entering a transaction (`installTransactionLogging`'s
patched `db.transaction`, at any nesting depth) pushes a fresh, empty
buffer onto that db's own stack — this is "recording the buffer's
starting point for this specific level," the precise fix this
correction's own review asked for. That level's own rollback (its ROLLBACK
TO, or the real ROLLBACK if outermost) pops and discards **only that
level's own buffer** — every enclosing level's own, already-buffered
entries are left completely untouched on the stack beneath it, which is
exactly what lets the outer transaction's later, independent success
still log correctly even though an inner attempt failed and was
discarded first. That level's own commit (RELEASE, or the real COMMIT if
outermost) pops its buffer and, if there is still an enclosing level,
merges those entries into whichever buffer is now on top of the stack —
rising with that enclosing transaction's own fate from here on, exactly
mirroring how the level's own SAVEPOINT/RELEASE just became part of the
enclosing transaction's still-open unit of work in SQLite itself. Only
when the outermost level's own commit empties the stack for that db does
anything actually print to stdout.

Re-run against this stack-based fix, all three shapes now hold correctly
in the same test file: the original outer-rollback case (zero rooms,
zero log lines), the new inner-rollback-caught-by-outer case (one room,
one log line naming the surviving room, never the doomed one), and every
pre-existing nested-success case (e.g. `createTableRoom` → `createRoom`)
continues to merge and print exactly as before. 218/218 tests pass;
`pnpm check:evidence` green. A live production spot-check after deploy
confirmed the fix holds for real server traffic, not just the test
suite.

### Bug 2: `verified` was inferred from the error code, not from real proof

**The claim that turned out to be false:** the 2026-10-16 entry said
`app.onError` tags `verified: false` "specifically when the rejection
was a failed identity check," implemented as `err.code !== "unauthorized"`.
This is wrong on inspection of `src/rooms.ts` itself: `loadOpenRoom`/
`loadRoomAfterSweep` — called at the start of nearly every mutating
function, before `requireSession` — can throw `room_not_found` or
`room_closed`. Neither of those codes is `"unauthorized"`, so the old
heuristic logged `verified: true` for a request whose claimed identity
was never checked at all, falsely implying a session check had passed.

**Reproduction:** `spec/actionLog.test.ts`'s
`"wasIdentityVerified is false when no session check ever ran during the
tracked scope"` calls `rooms.roll` against a nonexistent room code
(reaching `loadOpenRoom`'s own throw before `requireSession` is ever
called) and confirms no verification was ever recorded for that attempt.
Live `flyctl logs`/local-server output from before this fix is not
separately preserved, but the code path is unambiguous: `roll`
(`src/rooms.ts`) calls `loadOpenRoom` as its first line, `requireSession`
as its second — a thrown `room_not_found` from the first line never
reaches the second at all.

**The fix:** `src/actionLog.ts`'s `runWithVerificationTracking`/
`markIdentityVerified`/`wasIdentityVerified`, backed by
`AsyncLocalStorage` (not a plain shared variable — Hono's handlers are
async, and two concurrent requests' handlers can genuinely interleave at
an `await` boundary, which a shared mutable flag would race). A new
outermost middleware in `src/server.ts` establishes a fresh, unverified
context for every incoming request; `requireSession` (`src/rooms.ts`) and
`requireBarSession` (`src/bar.ts`) — and only these two — call
`markIdentityVerified()` the instant their own check actually succeeds,
never speculatively, never from a catch block. `app.onError` reads
`wasIdentityVerified()` instead of inspecting the error code. Verified
directly: a non-existent-room rejection now logs `verified: false`; a
`not_host` rejection (where `requireSession` genuinely passed before the
host check failed) still correctly logs `verified: true` — the two cases
the old heuristic could not actually tell apart from each other with any
real evidence. `spec/actionLog.test.ts` also confirms a tracked scope
never leaks verification state into the next one (two sequential
`runWithVerificationTracking` calls, the second starting fresh).

**Verification performed for the first review round (bugs 1 and 2):**
`pnpm check` (217/217 tests — 213 prior + 4 new regression tests directly
exercising both bugs) and `pnpm check:evidence`, both green, against an
isolated local `DATA_DIR`, same method as every prior entry.

**Verification performed for the second review round (bug 1b):**
`pnpm check` (218/218 tests — 217 prior + 1 new regression test directly
exercising the flat-buffer defect) and `pnpm check:evidence`, both green,
same method. A live production spot-check after that fix's own deploy
confirmed real server traffic (bar join, a rejected nonexistent-room
request) logged correctly post-fix.

CI and deploy confirmation for every commit containing these fixes is
recorded immediately below, for each review round separately.
No game rule changed; `src/orders.ts` untouched; `crit-8`/`crit-9` tags
unmoved; no `crit-10` tag created; no visual/UI change made (the second
review round's own explicit instruction).

# 2–5 players, a fifth chair, and a hexagonal board (2026-10-18)

A separate feature request, after Crit 10's logging work above was
already done, committed, and deploy-confirmed: expand the Vegas dice
game from a 4-player cap to 2–5 players (both host-approved online
tables and solo NPC tables), give each game table a real fifth chair,
redesign the in-room board into the hexagonal six-casinos-around-a-
central-dice-bowl layout from two reference photos of Vegas Royale's
physical components, and let an NPC game's starter choose a 2–5 total
player count before it starts. The student's own follow-up message
fixed the rules themselves to the official base Las Vegas rulebook,
not Royale's — the two photos are a layout reference only.

## A real rules discrepancy, found and reported before building anything

Fetched and extracted (`pdftotext`) the actual rulebook PDF
(`ravensburger.org/.../26938_Vegas_EN.pdf` — the same source already
cited in this file and in README.md). Its own "GAME COMPONENTS" line
reads **"40 dice (8 in each player colour)"** — five colours' worth
ship in the box. Its "Variant (2 to 4 players)" section is explicitly
for playing with *fewer* than 5: it hands out extra *neutral white*
dice to compensate for an "imaginary" missing player, not a way to
exceed a 4-player base game. **5 is the real base-game maximum.** This
app's existing "2–4 players" decision (recorded earlier in this file
without re-checking this specific rulebook detail) was itself the
divergence from the official rules, not a deliberate simplification —
this entry corrects it rather than layering a new house rule on top.
The neutral white-dice variant remains explicitly out of scope
(CLAUDE.md's scope-discipline section already excluded it, unchanged by
this correction), and no round/scoring/chip/skill rule from Royale was
introduced — only Royale's physical *layout* (six casinos ringed around
a dice bowl) was borrowed, purely as a way to arrange the same data this
app already computed.

## What changed, server-side

`src/types.ts`'s `Color`/`COLORS` gained a fifth colour, purple,
appended after the original four — existing identities, saved rooms,
and turn orders that only ever used the first four are untouched, since
`Color` was always a plain string column (`src/db.ts`), never an enum
constraint. `src/rooms.ts`'s `MAX_PLAYERS` is now 5, with the three
`room_full` error messages interpolating the constant instead of a
hardcoded "4" so the text and the limit can never drift apart again.
`createSoloNpcGame` now takes an explicit `npcCount` (1–4) instead of
always filling every remaining colour, picking NPC colours
deterministically in `COLORS` order after skipping the human's own
colour. `src/tables.ts`'s `emptySeats()` derives its length from
`COLORS.length` rather than a second hardcoded 4-entry array, and
`startNpcGame` gained a validated `playerCount` (2–5) parameter,
`src/server.ts`'s `start-npc` route defaulting it to 5 — one human plus
four NPCs — per the student's own "默认五人" instruction. The minimum
of 2 (`src/game.ts`'s existing `startGame` check) was already correct
and needed no change.

## The fifth chair's geometry

`src/barLayout.ts`'s `GAME_CHAIRS` gained one new literal entry per
table: `{ color: "purple", x: f.x, y: f.y - 1 }` — the tile directly
north of each table's own first column. Verified collision-free by
direct coordinate computation across all nine tables (three playable,
six reserved): clear of every dining-table fixture (a full row further
north), clear of the other four chairs (which only ever occupy the
table's own row and the row below), and already `isWalkable`. This
follows the exact same "fixed per-table offset" shape the original four
chairs already used, just on a side (north) none of them occupied —
zero client-side geometry code needed, since chair rendering,
hit-testing, click-priority, `effectivePosition`, and speech-bubble
positioning in `public/tavern.js` already iterate `GAME_CHAIRS`
generically. The client picks the new chair up automatically through
the existing `GET /api/bar/layout` fetch. A new test
(`spec/barLayout.test.ts`) iterates every table confirming exactly
`COLORS.length` chairs, one per colour, mutually exclusive tiles, all
walkable.

## Client-side color lists and the NPC count selector

Three independent hardcoded colour arrays — `public/app.js`'s `COLORS`,
`public/tavern.js`'s `GAME_COLORS`, plus two literal `/4` capacity
strings in `tavern.js` — all needed the same fifth entry in lockstep
(no shared module links them; this was pre-existing drift risk, not
something this round introduced). `tavern.js` gained a `MAX_SEATS`
constant derived once from `GAME_COLORS.length` rather than restating
5 a third time. `openNpcTableDialog` gained a player-count selector
(buttons for 2/3/4/5, default 5) that narrows the colour swatches shown
below it to the first `count` entries — so a 2-player game only offers
the colours that could actually be the human's own seat — and updates
the start button's own label live (`Play vs. N NPCs`) before sending
`playerCount` in the request body.

## The hexagonal board — Royale's layout, this app's own rules and data

`public/app.js`'s `casinoTable()`/`turnControls()` were replaced by one
`hexBoard()` function: a central `.dice-bowl` showing the current
roll and, only on your own turn, the existing roll/place controls
(same `api()` calls, same accessible button text — "Roll", "Place all
N×V" — per the student's own explicit instruction not to rename them),
surrounded by six `.hex-casino` cards positioned by simple trigonometry
(`-90° + (value-1)*60°`, clockwise: 1 top, 2 upper-right, 3 lower-right,
4 bottom, 5 lower-left, 6 upper-left, matching the two reference
photos). Each casino shows its own real `bills` and `placements` from
`PublicState` — never a fixed "two bills" count invented to match a
photo's own appearance. Player info (nickname, colour, dice remaining,
winnings, NPC/online tag, current-turn highlight) wraps around the
board as a flex row below it, reusing the same per-player data the
original list already rendered, just repositioned. No big weighted
die, no chips, no bonus-sorted payout tiers, no expansion skills, no
multi-round scoring were introduced — only the component photos'
spatial arrangement, confirmed against the actual reference images
before writing any CSS. Visual language reuses the tavern's own
existing tokens (dark wood, green felt, warm gold, the same
`--panel`/`--border`/`--accent` palette) rather than inventing a new
design language; no canvas, no SVG library, no animation library, no
new dependency.

## Two real visual bugs found during manual browser verification, fixed before reporting done

Per this round's own instruction to actually check the result in a
real browser rather than relying on the passing suite alone
(Playwright, driven against the locally running isolated server, not
added to the repo's own dependencies):

1. **Duplicate "(NPC)" tag.** `hexBoard`'s player strip added its own
   `"NPC"` tag for `controller === "npc"` players, but the server
   already bakes `" (NPC)"` into the generated nickname itself
   (`createSoloNpcGame`), producing a visible "Blue (NPC) (NPC)".
   Fixed by removing the redundant client-side tag, matching how the
   original player list never added a second one either.
2. **Dice-bowl overflow.** The circular `.dice-bowl` had no overflow
   handling; a roll yielding several distinct values produced more
   "Place all N×V" buttons than the circle could show, spilling past
   its own rim into the neighbouring casino card. Fixed with
   `overflow-y: auto` and a `max-height` on the bowl itself, plus
   capping `.value-buttons`' own width to the circle's inscribed square
   (≈71% of the diameter, `1/√2`) so a button's own rounded corners
   stay clear of the circle's curve even while scrolled. Verified at
   the actual worst case — a roll producing all 6 distinct values, the
   maximum this dice game allows in one roll — via a retry loop that
   re-rolled fresh rooms until that exact case appeared, confirmed by
   screenshot rather than assumed fixed from reading the CSS alone.

## Verification

`pnpm check` (222/222 tests — the prior 218 plus 4 new: all-5-chairs
geometry, 5-seat capacity plus 6th-seat refusal, `playerCount`
validation for solo NPC games, and a full 5-player NPC round settling
with the existing settlement contract intact) and `pnpm check:evidence`,
both green, run once after every change including the two visual
fixes above, against an isolated local `DATA_DIR`, same method as every
prior entry in this file. Manual browser verification (Playwright
against the locally running server) covered: the classic join form's
5 colour swatches; filling all 5 seats of an online table end to end
through ready/start; the hex board at a desktop width and at a 375px
mobile width, confirming every casino number/bill/dice count stayed
legible and the bowl's controls stayed reachable; the NPC dialog's
count selector narrowing colour choices and updating its own button
text live across 2/3/4/5; a started 5-player NPC game landing in the
same hex board with four correctly-labelled NPC opponents. Desktop and
mobile screenshots were captured and shown to the student directly, not
committed to the repo (verification artifacts, not source).

`src/orders.ts` untouched; `crit-8`/`crit-9` tags unmoved; no
`crit-10` tag created; `/ship` not run. CI and deploy confirmation
recorded immediately below.

## Tabletop visual correction and round Vegas tables — 2026-10-19

The user rejected the earlier blue card layout and asked for a wooden
background and the physical reference's connected casino ring. They
also requested no invitation links in solo NPC games, the same visual
update for online games, and round Vegas furniture with evenly spaced
chairs, leaving other game tables unchanged.

The shared online/solo board now uses an original SVG six-sector ring,
a central hexagonal green dice tray, paper-style notes outside their
casinos, pip-rendered coloured dice/counts inside, and a separate turn
control strip. Values always come from server state. The background and
player panels use the tavern's wood/green/gold palette. This is still the
explicitly documented single-round base-game adaptation: no Royale big
die, skills, chips or payout-rule changes. The existing lobby capacity
text incorrectly still said /4 after the five-player change; corrected
to /5. Settlement now keeps the board visible alongside final results.

Solo status is derived server-side from the existing
solo_npc_room_created event, including old rooms, and exposed as a public
boolean. Only solo headers omit the invitation controls; online rooms
retain them. All three Vegas fixtures are painted round. Their five
chairs have 72-degree spacing and continuous display centres; integer
occupancy tiles remain server-authoritative. Art, seat hit targets and
seated figures use the same display centres. Reserved tables retain
both their original art and chair arrangement.

Verification: the isolated-server full suite passed 222 tests before
adding a geometry regression. The subsequent focused layout/table suite
passed 49 tests, including the new equal-angle/non-overlapping hit-area
check and the solo-room flag assertion. Browser checks exercised entry,
clicking the round NPC table's chair, a five-player solo start without
Copy/invite controls, real roll/place, all four NPCs playing and yielding
back to the human, and another roll. A 390px mobile check showed no
horizontal overflow; desktop and phone screenshots were saved outside
the repo. The classic online lobby was also opened through its actual
UI: it uses the wood theme, shows /5 and retains Copy. Active online and
solo play share the same board component. These are agent checks, not
student acceptance. CI and production verification follow publication.

# Back-bar art, table spacing, English renaming, favicon (2026-10-19)

Four small presentation fixes, requested by the student after seeing the
round-table layout live: two of the four (the back wall and the table
aisle) were real play-testing findings, not cosmetic nitpicks.

**Back-bar cabinet instead of windows.** Both decorative wall strips
behind the serving counter — the outer brick wall at the map's far north
edge, and a second, closer "room" wall directly above the counter's own
row — had four windows each. A window directly behind a bar counter made
no architectural sense; the student's own screenshot flagged it
specifically (`public/tavern.js`'s two separate wall-painting blocks, one
near the top of `createTavern`'s floor-rendering code, one further down
in "the original room is dressed as a room"). Both are replaced with a
back-bar liquor-cabinet motif: a dark wood frame, interior shelves, and
rows of small bottles in the same colour palette the counter's own
bottle silhouettes already use — reusing an existing visual language
rather than inventing a new one, still original code-drawn `box()`
primitives, no copied asset.

**A real walkway between online Vegas tables.** The online row's five
columns (`src/barLayout.ts`) were spaced at the same gap (2 tiles between
table rectangles) the row used before the 5th chair existed. Once each
table grew a 5-chair ring extending ~1.5 tiles past its own rectangle,
that gap put adjacent tables' outermost chairs on directly-adjacent
tiles — a patron walking the row would step through an occupied chair
rather than around it. This was found by the student's own play-testing,
not by any existing test: a walkable tile next to another walkable tile
isn't a collision, it's just an uncomfortably tight aisle, and nothing in
`spec/barLayout.test.ts` was checking aisle width specifically. Re-spaced
to the same 3/4/3 gap pattern the NPC row already used for the same
reason (confirmed via direct coordinate computation across every
round/square table-shape pairing before changing anything), which runs
past the dining row's own right edge — a deliberate width increase, not
a layout bug. `spec/barLayout.test.ts`'s old boundary test, which
asserted both rows end on the dining row's exact right edge, is split
into two: a left-edge check (still true for both rows) and a new,
explicit per-pair walkway check for the online row (`GAME_CHAIRS`-based,
asserting at least 1 clear tile between every adjacent table's chairs).

**English branding throughout.** Every user-visible "拉斯维加斯" —
`public/index.html`'s `<title>`, `src/markdown.ts`'s `/readme/` page
title, `public/app.js`'s nine in-game `<h1>`s, `public/tavern.js`'s HUD
brand mark, the character-creation dialog's eyebrow text, and the
canvas-drawn sign above the bar counter — is now "Las Vegas". The
favicon's own internal `<title>` (not user-visible, but kept consistent)
and README.md's own H1 are updated the same way. No rule, route, or test
depended on the Chinese text appearing literally (confirmed by grep
before changing it) — this is a pure branding pass.

**A clinking-glasses favicon.** `public/favicon.svg`'s old dice motif is
replaced with two tilted cocktail/martini glasses (a simple triangular
V-cup silhouette, chosen specifically because it stays legible at an
actual 16-32px favicon size — a first attempt with a more detailed
tapered-flute shape was checked by rendering the SVG in a real browser at
both 128px and 16/32px and found to blur into an unreadable smudge at
tab size, which is why the simpler silhouette was kept). Original
SVG, drawn in code, not copied from any external icon set.

Verification: `pnpm check` (224/224 tests — 222 prior plus the two
replacing the old boundary assertion) and `pnpm check:evidence`, both
green, run once after all four changes, against an isolated local
`DATA_DIR`. Manual browser verification (Playwright against the locally
running server, restarted after each code change to avoid checking a
stale build) confirmed: no window art remains anywhere behind the
counter at either wall strip; a visible walkway now separates every pair
of adjacent online tables; "Las Vegas" renders correctly in the HUD
brand mark, the join dialog, and the in-game header; and the favicon
renders as two recognisable clinking glasses at both preview size and
actual browser-tab size (16px/32px).

`src/orders.ts` untouched; `crit-8`/`crit-9` tags unmoved; no `crit-10`
tag created; `/ship` not run.

## 2026-10-19 — cabinet/chair collision correction and collapsible speech composer

I found in my own play-test that the middle back-bar cabinets could be walked through, empty chairs were still treated as floor, and the always-visible speech input obstructed the map. I asked the agent to correct these and place one window between each adjacent pair of cabinets on the far back wall.

The root causes were separate: the two painted cabinet walls existed only on canvas, and routing only excluded furniture rectangles, not BAR_SEATS/GAME_CHAIRS. The agent added matching blocking wall fixtures to the shared layout and introduced isWalkingFloor for movement, pathfinding, spawn and recovery. All chairs now block normal walking, including diagonal corner-cutting. Chairs remain occupiable through the explicit sit/table interaction, rather than becoming transit shortcuts. Clicking a dining chair or stool paths to adjacent reachable floor; the server checks adjacency and occupancy, then seats the patron atomically. Standing first reserves adjacent free floor. Recovery/migration preserves genuinely seated patrons while relocating obstructed floor patrons. Room links, game rules and reserved game-table art are unchanged.

The speech composer starts hidden. A small three-dot speech bubble above the right-hand d-pad toggles it, exposes its expanded state to accessibility tools and supports Escape to close. The public head bubbles and authenticated speech endpoint are unchanged. Phone layout keeps the expanded input above both controls.

Verification so far: real local browser click-to-sit on a dining chair and bar stool, Stand up, chat expand/send/collapse. The first check encountered the suite's own temporary connected probe players blocking the route; after their normal presence expiry the same real gesture succeeded. A screenshot also exposed wide-font middle dots overflowing the icon; the agent replaced them with compact bullets. Geometry and real move-action regressions cover empty-chair/cabinet rejection, corner-cutting, adjacent sitting/standing, and reachability without routing through seats. An initial full run exposed one old assertion assuming the north edge above the restroom was open floor; it is now correctly a wall. A later run caught the startup-computed version hash being stale after edits to static files: the preview was restarted before the final run, rather than weakening the cache test. Final test/deploy results are reported after these checks; none of these agent checks is my own final acceptance.

Final local checks: pnpm check passed 227/227 tests across 26 files, with typecheck included, against the freshly restarted isolated DATA_DIR instance. pnpm check:evidence passed. No real production data was used in the test suite. CI and deployment follow this commit.

## 2026-10-19 — plant/chair overlap and a unified dining rug, the final visual correction before Crit 10

The student flagged two remaining visual issues from a real play-test
screenshot (blackjack-1's left-hand chair visibly overlapped by a
decorative plant's canopy, annotated with a red box; a red rug stranded
between two game-table rows, annotated with a blue box).

**The plant overlap had the same root cause the prior round's cabinet-
wall fix already diagnosed and fixed for walls, just not yet applied to
plants:** a plant was pure canvas art (`public/tavern.js`'s `plant()`
helper) with *zero* shared collision footprint anywhere, client or
server. Four of the six plants (the two "row" sets, at tile `(31,17)`
specifically — one Chebyshev tile from `blackjack-1`'s own green chair)
sat close enough that their drawn canopy, which extends well past the
plant's own centre tile in pixel space, visually read as overlapping a
chair even though nothing in the shared layout model would have caught
it: a walkable tile beside another walkable tile has never been a
collision. Following the exact `cabinet_wall` precedent from the prior
round (a real `FurnitureKind`, not a second parallel collision concept),
`src/barLayout.ts` gained a `"plant"` kind and four real `FURNITURE`
entries (`plant-nw/ne/sw/se`), each placed on open floor checked by
direct coordinate computation to sit at least 3 tiles (Chebyshev) from
every chair and dining seat — picked up for free by the existing
`isWalkable`/`isWalkingFloor`/reachability machinery with no new code
path. The two original "corner" plants (far from any furniture, never
implicated in the bug) stay pure decoration. `public/tavern.js` now
draws the four relocated plants from the shared `fixtures` list (via the
same loop `cabinet_wall` already uses) instead of four hand-typed pixel
literals, so the drawn position can never again drift from the real
collision tile.

**The rug was hand-typed guesswork, not computed from the room it was
meant to dress:** two separate `rug(...)` calls with literal pixel
coordinates — one landed between the two game-table rows (the stray one
the student's screenshot flagged), the other only partly covered one
dining table rather than the group. Replaced with one rug, computed at
render time from the four dining tables' own real bounding box
(`fixtures.filter(f=>f.kind==='dining_table')` plus their `BAR_SEATS`),
centred with an even 0.6-tile margin on every side, drawn in the same
pre-fixtures static floor layer as before (a rug has never been checked
by `isWalkable` — it's pure decoration, confirmed unchanged by this fix).

A new test (`spec/barLayout.test.ts`, "every decorative plant fixture
has a real blocking footprint, and none sits near a chair or seat")
guards both halves: each plant fixture actually blocks `isWalkingFloor`,
and every plant stays at least 3 tiles from every `BAR_SEATS`/
`GAME_CHAIRS` entry — the exact distance check that would have caught
the original bug.

CLAUDE.md gained one paragraph extending the already-stated cabinet-wall
collision rule explicitly to plants, so a future plant addition follows
the same pattern rather than reintroducing canvas-only decoration with
no shared collision.

**Verification:** `pnpm check` (228/228 — the prior 227 plus the one new
plant-collision test) and `pnpm check:evidence`, both green, against an
isolated local `DATA_DIR`. Manual browser verification (Playwright
against the locally running server): desktop and mobile (390px)
screenshots confirm the unified rug sits correctly centred under all
four dining tables with even margins and no longer appears between game
tables; a screenshot walking to the relocated north-east plant confirms
it sits clearly separated from the blackjack row with no visual overlap
with any chair; dining-chair sit/stand-up, the speech composer's
collapse/expand toggle, and a game-table chair click (opening the
join/choose-colour flow) were all re-exercised after the fix and
confirmed still working, with no console errors.

## Crit 10 closeout rehearsal (2026-10-19) — two genuinely isolated browser identities, against the real live deployment

The prior Crit 10 rehearsal entry (above, 2026-10-16) was explicit that
"two real Chrome browser profiles were not available to this session,"
and substituted plain HTTP requests from one shell instead — an honest
limitation, not a substitute for the real thing. This entry supersedes
that gap, not by claiming a human two-profile demonstration happened
(it did not — that is still the student's own job at the actual crit),
but by using a mechanism this session genuinely does have: two separate
Playwright `BrowserContext`s. Each context has its own cookie jar and
its own `localStorage` partition — exactly the isolation property "a
new Chrome profile" provides, confirmed directly against this app's own
code (`public/app.js`'s `saveSession`/`localStorage.getItem` is the
entire identity mechanism; nothing about it distinguishes "a different
Chrome profile" from "a different Playwright context" at the browser-API
level). This is a real improvement on the prior entry's pure-HTTP
substitute — a genuine browser renders the page, runs the client's own
JS, and stores the session the same way a human's browser would — but
it is still not two human presenters each driving their own physical
machine/window, and this record says so plainly rather than overstating
it. The actual two-person rehearsal the crit itself requires remains the
student's own job at the session.

Run against the real, live, deployed app
(`https://comp4020-final-shuyangyuzu-cmd.fly.dev`, build `c9ed8de8a9`,
confirmed matching the pushed commit's own content hash before this
rehearsal started), with `mise exec -- flyctl logs` tailed live in a
separate monitor the entire time. Two clearly-named throwaway identities,
`Crit10RehearsalAapp` and `Crit10RehearsalBapp` (earlier attempts in the
same session used similarly-named throwaway identities — `Crit10RehearsalA9`,
`...B9`, etc. — each abandoned room from a failed script attempt expired
and closed on its own via the existing lazy lobby-grace sweep, confirmed
by `player_timed_out`/`room_closed` lines actually appearing in the log
for those abandoned attempts, which is itself a second piece of evidence
the sweep works under real conditions, not just in tests). A real
patron, nickname `fsy`, was also active in the live bar throughout this
session's work today — their own moves/sits are visible in the same log
stream and were left completely untouched; nothing in this rehearsal
created, joined, or disbanded anything of theirs.

The actual sequence, every line below confirmed arriving live in the
tailed log, not reconstructed afterward:

1. A and B join the bar — distinct `join_bar` lines, correctly
   distinguishable short ids (`a7127904` vs `ff908184`) despite similarly
   patterned nicknames.
2. A walks to Vegas Online #1 and starts a game (becomes host) —
   `room_created` then `create_table`, the second line pairing A's bar
   id with the room player id it just became, the exact correlation
   `ADR-access-control.md` describes.
3. B walks to the same table and requests to join as blue (the bar
   world's own table-join flow, not a direct room-URL navigation, which
   is a different, legacy direct-join path) — `join_requested` then
   `join_table`, `"pending":true`, correctly not yet a seat.
4. **B attempts to approve their own pending request** (self-admission,
   never the host) — rejected `not_host`, attributed to B's own room id
   (`4d39a594`), the exact critical-finding condition the crit's brief
   asks to be demonstrated failing.
5. **B attempts to roll before the game has even started** (wrong
   phase) — rejected `wrong_phase`, attributed to B's own room id,
   visible from an earlier run in the same session (`70971515`).
6. **B attempts to impersonate A**, submitting A's own `playerId` with
   B's own `sessionSecret` — rejected `unauthorized` with `"verified":false`,
   attributed to the *claimed* id (A's), carrying no nickname since
   nothing about the attempt was ever confirmed as genuinely A — visible
   from the same earlier run.
7. A, the real host, approves B — `join_approved`, attributed to A's own
   room id, naming the approved player and colour.
8. A disbands the rehearsal room — `room_disbanded`, cleanup confirmed
   logged, same tick.

No line in this entire sequence contained `sessionSecret` or any
generated secret value. Every rejection (steps 4-6) was attributable
purely from the log line, with no need to inspect either identity's own
response body or screen — the actual thing the crit's "narrate from
logs" requirement asks for. The `say` action (exercised in an earlier
run this session, `Crit10RehearsalA2` speaking in the bar) logged only
message `length`, never its text — re-confirmed, not newly found.

**What this rehearsal does and doesn't establish, stated plainly:** it
proves the server-side logic and logging are correct under genuinely
separate browser storage/identity, driven by real client-side JS in a
real rendered page — a stronger check than the prior entry's bare HTTP
requests. It does not prove a human presenter can narrate this smoothly
live, under the actual crit's time pressure, watching two real
classmates on two real machines — that is a presentation skill this
automated rehearsal cannot exercise or substitute for, and remains the
student's own job. The shortest real pre-crit check, if time allows: two
people (or one person with a second device/an incognito window) open
the live URL, one creates a table, the other requests to join, the first
approves, both ready up and start — while a third terminal tails
`mise exec -- flyctl logs -a comp4020-final-shuyangyuzu-cmd` and the
presenter practises reading the actor/action/outcome fields aloud
without looking at either screen.

## 2026-10-19 — playable exits, three-minute grace and a rules scroll

I reported that I could not leave the NPC game and asked for a three-minute return window plus a deliberate exit action in both modes. I also asked for an in-game rules scroll and checked whether personal choice panels belong to the base game or Royale. The agent checked the official base-game and Royale PDFs; the special tiles are shared casino modules from Royale, not individual player boards. I kept the existing one-round base-game adaptation and colour selection rather than introducing those modules.

The agent found two concrete old implementation gaps: the only Leave control was lobby-only, and enforceExpiredDepartures looked up tables.current_room_id, which is intentionally empty for individual NPC kiosk games. The default was also still 120000 ms. The correction resolves rooms from the actual player's session, uses a 180000 ms default, preserves the first departure timestamp, and uses one authenticated exit operation for manual and timed exits. An Offline game closes when its human exits; an Online seat transfers to computer control, retaining its dice, money and turn order, with host transfer to another human and closure only after the last human exits. Bindings and departure records clear transactionally; exited human seats cannot be reclaimed through an old session.

A separate persisted room_departures table covers invitation/direct-code entry without a bar identity. Explicit departure protects a lobby seat from the shorter disconnected-client grace. Explicit return before expiry refreshes presence and clears both room and table departure records; passive heartbeat/rejoin does not. The first request after idle/restart enforces expiry before a late resume can cancel it. Automatic enforcement is deliberately outside the incoming request's verification context, so expiry's stored session cannot falsely verify an unrelated HTTP caller. Private heartbeat replies refresh the Return button after expiry.

The NPC table mode labels now read Offline (computer-controlled opponents, still a networked website). A small scroll beside the game title opens accessible gameplay instructions, including tie cancellation, prize distribution, colour selection, the website's one-round scope versus the physical base game's four rounds, Online/Offline entry, and exit timing. Source links: https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf and https://product-files.ravensburger.cloud/manuals/664467.pdf.

Verification: pnpm check passed 234/234 tests across 27 files, including new regression coverage for manual Offline exit/re-entry, forged sessions, Online takeover/host transfer/final-human closure, Offline personal-room expiry without affecting another kiosk user, repeated departures, cancelled departure, and invitation-only lobby return after the ordinary presence grace. A real HTTP rehearsal against a dedicated six-second-threshold local instance confirmed Offline expiry, Online continuation with one human remaining, final-human closure, and private binding cleanup. The production default remains three minutes. These real-timer checks used HTTP requests, not two human browser profiles.

Browser verification opened the Offline colour picker (all five choices), the initial Exit game control and rules modal. The browser automation then became blocked by its handling of the old native confirmation dialog. The agent replaced the new exit confirmation with an accessible in-page dialog; subsequent browser snapshots confirm the updated controls, but do not constitute a completed click-through verification of that final confirmation. This limitation is recorded rather than describing it as a successful manual test. No rule changes, real-player room actions, /ship, or tag movement are part of this follow-up. src/orders.ts stays untracked and untouched.

## 2026-10-19, later — completing the exit-confirmation verification Codex's own browser automation could not finish

I handed this repository to Claude to pick up exactly where Codex's entry above left off: the one specific gap it named plainly rather than claim past — the new accessible `<dialog>` exit confirmation had never actually been clicked through end to end by a real browser, only reached and screenshotted.

Claude independently re-ran `pnpm check` against a freshly started isolated server first, rather than trusting the 234/234 figure at face value — it reproduced 234/234 once, after first catching that a stale server process left over from an earlier port conflict had silently served an old build and produced two spurious `caching.test.ts` failures (a local Windows CRLF/stale-process artifact, not a real regression — confirmed by diffing the live-served and locally-read bytes and by CI's own Linux run of the identical suite already passing).

Claude then drove the actual click-through Codex's own automation could not complete, using Playwright against a locally running instance (not production): **Offline** — opened the solo table, clicked Exit game, clicked "Keep playing" and confirmed the game was still running and the Exit control still present, then clicked Exit game again and "Confirm exit" and confirmed the browser actually returned to the tavern with the old game closed; separately confirmed walking back into the NPC table afterward starts a genuinely new room code, not the closed one. **Online** — two isolated Playwright browser contexts (separate storage, matching this app's own identity mechanism), one became host, the other requested and was approved; the host clicked Exit game mid-round, saw the Online-specific confirmation copy ("A computer will take your seat while other human players continue..."), confirmed, and the room stayed open with the exiting player correctly shown as `controller: "npc"`; the remaining human then clicked Exit game themselves and the room closed only at that point, not before. **The three-minute window, for real** — against a dedicated instance with `AWAY_FROM_TABLE_MS=6000`, clicked "Back to the bar" (a real departure), confirmed the "Return to your game" button appears, waited past the threshold, and confirmed the button disappears on its own (via the heartbeat's own response, no page reload) and that the room closes from this Offline game having no human left; a second run clicked "Return to your game" itself within the window and confirmed the clock had genuinely been cancelled, not just paused, since the game was still ours even after the original deadline passed. **The rules scroll** — opened and closed by a real click at both a desktop width and a 390px mobile width, text legible and the close control reachable at both. **No regressions** — dining-chair sit/stand, the speech composer's collapse/expand/send, and a game-table chair click opening the join dialog were all re-exercised and still work, with zero console errors throughout every run above.

This closes the one specific, honestly-stated gap in Codex's own record — the prior HTTP-only real-timer rehearsal and the automated-but-incomplete browser pass are both superseded by this real click-through, not duplicated. Nothing about the rules, permissions, or exit logic itself was changed to make this pass; this was verification only. No production data touched; every room used here was created by a disposable, clearly-named test identity against a locally running instance, never the live deployment. `src/orders.ts` stays untracked and untouched; no tag was moved as part of this entry.

## 2026-10-22 — complete four-round base-game flow (Codex)

I played with friends and found that the game stopped after one settlement, with no clear winner or next round. I asked Codex to check the official base-game rules and complete the game flow for both Online and Offline. I explicitly chose a random first starter rather than using the selected seat, and chose to hide other players' cumulative winnings while keeping my own bank visible. These are my product choices; implementation and verification below are Codex's work, not my personal acceptance.

Rules source: https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf . The base game has four rounds. The physical rule chooses the oldest first starter; my random-first preference deliberately differs. The fixed clockwise seat order stays intact, and the starter advances one seat each round. Optional neutral dice and Royale modules are not added.

Codex implemented separate round and game endings, a host-only next-round action, fresh eight-dice hands and casino deals with winnings carried forward, and a final ranking by total money followed by banknote count, allowing shared winners. Unawarded notes still return to the existing deck's bottom rather than triggering a reshuffle. The next-round action checks the expected round and phase inside the transaction, so duplicate or delayed clicks cannot skip rounds. New round-start and game-finished events use the existing transaction-buffered logging.

Public HTTP/SSE snapshots now redact every cumulative bank until game end. A separate authenticated read supplies only the current human player's bank; UI callbacks are guarded against old routes/state versions. Round payouts stay visible, as they are during physical settlement. The scroll help, round counter, starter label and explicit Start round 2/3/4 buttons explain progression. Tables remain in progress between rounds. Legacy persisted rooms gain missing metadata without resetting winnings, deck order or identity; a legacy settlement can continue as round 1.

Verification completed before deployment:
- `pnpm check`: 245/245 tests and typecheck passed against an isolated local DATA_DIR, not production data. Eleven new tests exercise 2/3/4/5-player full games, note conservation, random first selection and marker rotation, ranking ties, private bank access, real legacy-JSON migration, NPC play across DB reopens, and HTTP/SSE privacy plus concurrent next-round requests.
- Earlier fixed-first-player tests failed after the intended random-start change; Codex updated their actor selection instead of removing turn checks. A legacy test expecting public winnings now checks redaction separately from preservation in SQLite.
- An intermediate asset-cache check saw the pre-CSS-edit local process's startup hash. Restarting that isolated process resolved it; the invariant itself was not weakened. The final full suite ran against the fresh process.
- Real local browser clicks: Codex entered an Offline two-player game, observed the NPC randomly start round 1, played every human roll/placement through all four rounds, and clicked each next-round button. Round 2 preserved the human's $160,000 and moved the starter to that human. The fourth-round screen announced Blue (NPC) as winner with $590,000 / 9 notes versus the human's $450,000 / 10 notes. Opponent totals were hidden before that final result. Screenshots were saved outside the repository under the workspace tmp directory.

Deployment and production verification are recorded in the follow-up below when complete. Existing crit tags and reflections are retained; unfinished `src/orders.ts` is not part of this change.

### Deployment verification — 2026-10-22 (Codex)

Implementation commit `1e92cea` passed GitHub Actions run `39619193684` (check and deploy). Production `/version` returned `21df6c29f8`, matching a SHA-256 hash computed from the committed Git asset blobs, avoiding Windows working-tree newline differences. Codex then created two disposable Online identities and drove all four rounds over the production HTTPS API. Each inter-round settlement kept public banks null; the own-bank request succeeded and a forged other-player request returned 403. A non-host next-round request returned 403, valid host continuation returned 200, and repeating the old round returned 409. Final state was `game_end` with winner IDs and both final standings, and starting a fifth round returned 409. Both probes explicitly exited their own room afterward. These were HTTP checks, distinct from the actual local browser Offline four-round play-through above. No existing production room was used. Crit 8/9/10 tags and reflections remain unchanged; `src/orders.ts` is still untracked and excluded.

# Room voice calls — implementation (2026-10-22, Claude)

## Receiving Codex's handoff (recorded before any new code)

Read CLAUDE.md, PLAN.md and PROCESS.md, then independently re-ran
`pnpm check` and `pnpm check:evidence` against a freshly started,
isolated local server (not production) before touching anything:
245/245 tests passed, matching Codex's own count exactly; `check:evidence`
confirmed all three reflections present and all 27 cited commits in
`PROCESS.md` resolve. Confirmed directly: commit `1e92cea` ("Complete
four-round Vegas games...") and `3be36d3` ("Record production
verification...") both exist in this branch's history exactly where
PLAN.md says. `gh run list` confirmed both commits' CI runs completed
successfully (`checks` workflow, `success`). Production
`https://comp4020-final-shuyangyuzu-cmd.fly.dev/version` returned
`21df6c29f8`, matching PLAN.md's own recorded figure exactly. Nothing in
the handoff needed correcting — the record matches the real repository
state.

## Plan (written before implementation, per the student's instruction)

1. Server: new additive tables (`room_voice_calls`,
   `room_voice_participants`), a new `src/voice.ts` module layered above
   `rooms.ts` the same one-directional way `tables.ts`/`chat.ts` already
   are, new routes in `src/server.ts`, a new private per-(room,player)
   signaling channel in `src/live.ts`.
2. Tests: `spec/voice.test.ts`, black-box over HTTP like the rest of
   `spec/`.
3. Client: `public/voiceCall.js` (WebRTC mesh + call state, kept outside
   `app.js`'s full-DOM-replace render cycle), wired into `app.js`'s header
   and route/enter/leave lifecycle.
4. Browser verification with Chromium's fake-media-device flags (real
   getUserMedia/RTCPeerConnection code path, synthetic audio — proves the
   mesh negotiates correctly, not that a human heard sound).
5. Deploy, verify production, update docs.

## What was built

**Data model** (`src/db.ts`): two new tables, `room_voice_calls` (one row
per room with an active call — `room_code` is `UNIQUE`, which is the
entire mechanism behind "two simultaneous initiates merge into one call":
both INSERTs race the same unique constraint, the loser's insert is a
no-op and that caller simply becomes a second joiner of the winner's row)
and `room_voice_participants` (one row per call per player, `status`
`'invited'` or `'joined'` — a decline or hangup just `DELETE`s the row
rather than keeping a third status, which is what makes "a past decliner
can join later with no special-casing" fall out for free: nothing
distinguishes a past decliner from someone never invited, once the row is
gone).

**Server module** (`src/voice.ts`, ~340 lines): every mutation goes
through `rooms.requireSeatedHumanPlayer` (a new export added to
`rooms.ts` for this — real session, currently seated, `controller ===
"human"`, same `RoomError` shapes every other authenticated room action
already throws). Membership is reconciled lazily on every read
(`getPublicCallSummary`), the same "evaluated fresh, no background
sweep" principle CLAUDE.md already establishes for the lobby grace and
the away-from-table clock — a participant who left, got NPC-handed-off,
or went presence-stale is dropped the next time anyone reads the call's
state, which in practice is within about a second since the existing
presence ticker (`src/server.ts`) already calls this on every actively-
watched room. A call that loses its last joined participant ends
entirely and pushes `call_ended` to anyone still invited, so a pending
ringer's screen closes with an honest reason rather than hanging forever.

**Signaling** (`src/live.ts`'s `subscribeRoomVoice`/`publishToRoomVoice`,
a new private channel keyed by `(roomCode, playerId)`, deliberately
separate from the existing chat-inbox map since a game-room player id and
a bar player id are different identity spaces per CLAUDE.md): SDP
offers/answers and ICE candidates are relayed only between two
participants the server has just re-confirmed are both `status ===
'joined'` in the same call — never broadcast on the room's public SSE
channel, and never reaching a declined/not-yet-accepted invitee. A
deterministic initiator-per-pair rule (lexicographically smaller
`playerId` always offers) avoids any coordinator or glare without extra
state. Payloads are size-capped (16,000 chars) and rate-limited
separately from the start/respond/leave/mute actions (which have their
own, tighter limit) — both backstops against a hostile/malformed client,
not UX-facing limits a real session could hit by normal use.

**Public state**: `voiceCall: {active, callId, startedBy, participants}`
rides the room's *existing* public payload (`GET /state`, every
mutation's own response, every SSE push) — no new public transport.
`participants` only ever lists `status === 'joined'` rows; an invited-
but-undecided player's identity never appears there (verified directly
in `spec/voice.test.ts`). The personal side — "you've been invited",
"removed from the call", the authenticated own-view fallback fetch — is
a separate route (`POST /rooms/:code/voice/state`) and the private SSE
channel above, never folded into the public payload.

**ICE/TURN** (`src/iceConfig.ts`): STUN (`stun.l.google.com:19302`,
public, free, no credentials) always offered; TURN only appears if
`TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` are set as real Fly
secrets — this app never defaults to, purchases, or stands up an
unauthenticated TURN relay on its own. The `/voice/ice-servers` endpoint
is gated behind the same seated-human check as everything else, since a
configured TURN credential is exactly the kind of secret CLAUDE.md says
must never reach an unauthenticated caller.

**Client** (`public/voiceCall.js`, new module, ~400 lines, kept outside
`app.js`'s render cycle since `RTCPeerConnection`s/the mic stream/hidden
`<audio>` elements can't survive a full DOM replace): a small closure
exposing `enterRoom`/`leaveRoom`/`onStateUpdate`/`widget`/
`incomingInviteModal` to `app.js`. Mic permission (`getUserMedia`) is
requested only from the person's own deliberate click (start, or accept)
— never on receiving an invite, never on decline, never on page
load/refresh (a stale `'joined'` row found on reconnect is corrected by
leaving that call again, since this fresh tab genuinely has no real
connections for it — refresh never auto-opens the mic or auto-rejoins,
per CLAUDE.md). A failed permission request tears down anything
partially started and shows a retry affordance, never leaving a fake
"in progress" state. The header's phone icon shows "📞 N" once a call is
active; a click when not yet in the call starts/joins it, a click while
already in it toggles the compact expand panel (participants, mute,
hang up) — this two-step distinction is exactly what the real browser
verification below caught needed covering explicitly. The incoming-call
prompt is a small fixed corner toast (`.voice-invite-toast`), never a
full-screen overlay, confirmed not to cover the board/rules/exit button
in either desktop or the existing 650px mobile breakpoint.

**Lifecycle**: `route()` (the single dispatcher every navigation already
goes through) calls `voiceCall.leaveRoom()` on every route change — this
is what tears down media/connections uniformly on "back to the bar",
"exit game", disband, and a plain navigate-away, since every one of those
already ends by calling `navigate('/')` or an equivalent route change,
with no separate per-button wiring needed. Server-side reconciliation
(not a client signal) is what actually removes a seat handed off to NPC
control or genuinely disconnected past the presence-stale threshold —
the client's own teardown on route change is only for *this* tab's own
deliberate departure.

## Tests (`spec/voice.test.ts`, 15 new, black-box over HTTP)

Covers: invite-then-accept adds a real participant; decline doesn't join
and the decliner can later join from the header's own start-or-join
route; two simultaneous initiates merge into one call (never two) —
verified via the final read-back state rather than either racing
response, since which response reports what depends on commit order, not
on the merge guarantee itself; repeated/stale accept doesn't duplicate
membership; accurate participant count with mute not decreasing it,
hangup only removing self, and the true last leaver ending the call;
a late-joining room player can see and join an already-running call;
solo/Offline games refuse voice entirely (`voice_not_available`); a
forged session, a cross-room session, a pending (not-yet-approved) join
request, and a seat already handed off to NPC control are all refused
the same way every other authenticated room action already refuses them;
signaling is relayed only between two joined participants and rejects a
stale/ended call id and an oversized payload; the public payload never
names an invited-but-undecided player; mute requires being an actual
joined participant, not merely invited.

**Two real test-authoring mistakes caught and fixed before trusting the
suite, not server bugs**: the simultaneous-initiate test originally
asserted on one racing response's own participant list, which is an
ordering artifact (whichever write committed first may legitimately
report only itself at that instant) — fixed to assert on the final
read-back state instead, which is the actual "did they both really end
up merged" guarantee. The NPC-handoff test originally readied up only 2
of 3 players in a 3-player room, which `startGame` correctly refused
(requires everyone present ready) — fixed to use a clean 2-player room.

`pnpm check`: 260/260 (245 prior + 15 new), run against a freshly
restarted isolated `DATA_DIR`, confirmed stable across two full runs.
`pnpm check:evidence`: green.

## Browser verification (Playwright, local, not production)

A throwaway Playwright install (outside the repo, matching this
project's own established pattern for browser checks with no committed
test-runner dependency) launched Chromium with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` —
this makes `getUserMedia` succeed deterministically with a synthetic
audio track and no OS-level permission dialog blocking automation, while
still exercising the real client code path: real permission grant
timing, real `RTCPeerConnection` negotiation, real ICE, real `<audio>`
element wiring. **This proves the code path runs correctly end to end,
not that a human actually heard audio** — that distinction is kept
explicit throughout this entry and is not overstated anywhere below.

Three real browser contexts (Alice/host, Bob, Carol — each its own
character + room identity, going through the real bar-world entry flow
then the classic join-by-code overlay) drove, in order: room creation and
two joins; A starting a call (mic requested only then, panel count shows
1); B and C both receiving the corner invite toast naming "VoiceAlice";
B accepting (count becomes 2, mic requested only on this click); C
declining (no panel appears, C never joined); C later joining via the
header's own icon rather than a fresh invite (count becomes 3); muting B
(count stays 3, A's own participant list shows Bob's 🔇 tag); A — the
original initiator — hanging up (B and C's call continues, count drops
to 2, confirming "hangup only removes self" and "initiator isn't a call
admin"); B hanging up (C's call continues alone, count 1); C hanging up
last (the call fully ends, the header's count disappears); A starting a
genuinely new call afterward (proving the old call's end didn't leave
stale state blocking a fresh one); A clicking "Back to the bar" and
confirming every voice-call DOM element (icon, panel) is gone from that
tab afterward, matching the lifecycle teardown design above.

**20/20 checks passed.** No console errors were logged during the run
(listened for directly on every page, not assumed absent). Two real
test-script bugs were found and fixed while building this driver, not
server bugs: the script initially assumed a single icon click both
starts a call and opens its panel; the real (and intentional) design is
two separate actions — a first click while not yet in the call starts
it, a second click while already in it toggles the expand panel — the
driver's assertions were corrected to match the actual, deliberate UX
rather than the panel-auto-opens assumption being treated as a bug to
fix in the app.

## What is, and isn't, verified — stated plainly

**Verified by this session**: the server-side membership/signaling logic
(automated HTTP tests); the real client code path for permission timing,
invite/accept/decline/join-from-header, accurate participant counting,
mute-doesn't-decrease-count, hangup-only-removes-self, last-leaver-ends-
the-call, and full teardown on "back to the bar" — all via a real
Chromium browser with fake media devices, which is a genuine automated
link test, not a synthetic claim of "it works."

**Not verified by this session, and not claimed as such anywhere above**:
that two real humans on two separate physical devices, on two separate
real networks (e.g. one on home broadband, one on mobile data), can
actually hear each other's real voice. Fake-device audio proves the
signaling/negotiation path is correct; it does not exercise a real NAT
traversal across genuinely different networks, nor does it prove a human
ear hears anything. TURN is implemented and will activate automatically
if real credentials are ever configured via `TURN_URLS`/`TURN_USERNAME`/
`TURN_CREDENTIAL` Fly secrets, but **no TURN server is configured for
this deployment** — without one, two peers behind symmetric NATs or
restrictive firewalls (common on some mobile carriers and corporate
networks) may fail to connect directly at all. This is a genuine,
unresolved limitation of the current deployment, not a design oversight:
CLAUDE.md explicitly forbids standing up an unauthenticated or
self-purchased TURN relay without the student's own decision to pay for
and configure one.

**The student's own two-device, two-network acceptance steps** (what
this session cannot do on its own):
1. Open the deployed URL on two different physical devices, ideally on
   two different networks (e.g. one on home Wi-Fi, one on mobile data
   with Wi-Fi off) — the scenario that actually exercises real NAT
   traversal, which this session's single-machine Playwright run cannot.
2. Both characters join the same Online table (host + join-by-code or
   table dialog), ready up.
3. One device clicks the phone icon to start a call; confirm the other
   device shows the incoming-call toast naming the first player.
4. Accept on the second device; confirm audio is actually heard in both
   directions (speak on one device, listen on the other, and vice
   versa) — this is the one step only a real human can confirm.
5. Try muting on one side and confirm the other side's participant list
   shows the 🔇 tag while the header count stays the same.
6. Hang up on one device and confirm the other's call continues; then
   hang up on the second device and confirm the header's count
   disappears for both.
7. If step 4 fails specifically when the two devices are on genuinely
   different networks (but works fine on the same Wi-Fi), that is the
   expected signature of the missing-TURN limitation above, not a new
   bug — report it, but it does not necessarily mean the feature is
   broken.

## Deployment and production verification

`pnpm check` (260/260) and `pnpm check:evidence` both green against a
freshly started isolated `DATA_DIR`, immediately before pushing.
Committed as `6f411e7` ("Add phone-style room voice calls for Online
tables"), pushed to `main` as a fast-forward (confirmed
`git merge-base --is-ancestor origin/main HEAD` first — no divergence to
reconcile). GitHub Actions run `39636811453` (`check` and `deploy` jobs)
both passed. Production `/version` returned `9f85d551e2`, a new hash
confirming the deploy actually updated (distinct from the prior
`21df6c29f8`).

Live HTTP smoke check against production (two disposable identities,
`ProdVoiceA`/`ProdVoiceB`, room created and disbanded within this same
check — no existing production room touched): `voice/start` correctly
created a call and invited B; B's own authenticated view correctly
showed `status: "invited"` with `invitedBy: "ProdVoiceA"`; B's accept
correctly added them as a real participant; a forged session on A's
playerId with a wrong secret was correctly rejected 403 `unauthorized`;
the authenticated `voice/ice-servers` endpoint returned the public STUN
server only (`stun:stun.l.google.com:19302`) — confirming no TURN
credentials are configured on this deployment, matching the stated
limitation above exactly, not silently different from what's documented;
both leaving ended the call (`active: false`); the test room was then
disbanded via the host's own confirmed disband. This is a server-side
HTTP smoke check against production, not the real two-device audio
check — that remains the student's own step, listed above.

Crit 8/9/10 tags were not moved; `/ship` was not run; the repository's
existing public visibility is unchanged by this work.

## 2026-10-22 — Codex correction of voice lifecycle and departure permissions

I asked Codex to independently check Claude's voice implementation, then asked it to fix the reproduced problems. The earlier 20/20 browser interaction run covered the ordinary path; its broad claim of full teardown did not cover delayed microphone permission, signaling reconnects or server-side departure membership. Passing 15 HTTP tests did not cover those frontend lifecycle cases either. This entry narrows those earlier claims rather than treating the first implementation as already accepted.

Codex reproduced three defects before editing: private SSE reconnection removed local joined status/Hang up while retaining a live mic; delayed permission after navigating away still opened a call; and room/depart left both call membership and signaling permission intact. The reproduction used the actual client module with controlled browser/media adapters for the first two and real HTTP against an isolated local service for the third, not a claim of audible speech.

Fixes: separate room/media generations invalidate async permission, join, signaling and peer callbacks; late streams are stopped and raced server joins are cleaned up using captured room credentials. Reconnect keeps existing media only when it belongs to this page's same call; a fresh page releases stale membership without requesting a mic. Own-state fetch revisions prevent a delayed response from undoing a later join, and public cursor ordering prevents an old redraw from undoing a newer call response. Current-call checks reject stale private events; authorized offers arriving before the join response are briefly queued instead of dropped. Media teardown clears peers, candidates, retries and tracks.

On the server, direct room_departures and bar-bound table_departures immediately remove voice eligibility, including the dining-seat path. Returning to the bar pushes reconciled membership immediately; both signal sender and recipient must still be present humans. The game seat remains reserved for the existing three-minute period, and explicit return enables a fresh manual voice join. The client also sends a best-effort captured-room voice leave on navigation.

Verification: 14 new regression cases (11 client component cases, two isolated in-memory DB bar/dining cases, one HTTP departure case). Initial regression run reproduced eight failing cases; one intentionally minimal RTC adapter also lacked close(), which Codex corrected so adapter cleanup did not obscure the actual failures. Final `pnpm check`: typecheck plus 274/274 tests, 31 files, passed against a freshly restarted isolated local DATA_DIR. This covers start/accept permission races, late join cleanup, reconnect controls, stale own/public responses, old signaling/events, forced media removal, a fresh-page stale membership, early offer handling, and departure/return permissions. No real microphone, physical audio or cross-network call was claimed verified. No TURN service was added. Existing crit tags, reflections and src/orders.ts are untouched.

Final-review correction: Codex caught an invitation ordering issue in its own added public-state cleanup before accepting the deployment. The private invite is published before the public room snapshot, so clearing invites on an older inactive redraw could dismiss a newly received call. That cleanup was removed; current-call private end events and authenticated reconnect reconciliation remain authoritative. A twelfth client case reproduces this order and passes (12/12 targeted client tests); typecheck also passed. The prior complete local run remains 274/274; the final CI run includes this additional case. This is a separate correction, not a claim that the earlier full run already covered it.

## 2026-10-22 — Hold’em tables and online nickname invitations (Codex)

I asked Codex to add poker in the style of RDR2's saloon tables: drop-in/out NPC play and an Online table that invites friends by their current online nickname. I specified 500 initial chips. Codex used Rockstar's invitation-table description and primary poker rules references, recorded in ADR-poker.md. The exact RDR2 stakes are not claimed reproduced. Code inspection found five physical chairs even at the reserved fixtures, so the initial four-seat assumption was corrected to five without moving furniture.

Implementation: independent server-authoritative Hold’em engine (blinds, dealer rotation, four betting streets, legal actions, minimum raises, short-all-in reopening, burn cards, five-of-seven evaluation, side pots, split/odd chips and uncalled returns). Initial chips are 500; blinds 1/2 and five seats are explicit house settings. Both Hold’em fixtures are now playable. Offline starts four NPCs using only their own cards/public board; Online has human invitation admission. Search uses authenticated online identities, with short ids for same-name disambiguation. Recipient-bound invitations expire in 60 seconds and acceptance atomically checks capacity and other-game membership. Mid-hand joins wait for the next deal. Existing stacks persist on rejoin of the same table; host transfers, explicit exit folds except all-ins, and disconnects get three minutes. The 45-second turn timer checks/folds. A broke human can explicitly rebuy 500 free play chips; NPCs refill between hands.

Persistence and privacy: poker has separate room/membership/wallet/presence/invitation/event tables. No Vegas room is converted or reset. State writes and events share existing transactions/rollback-safe logs. Authenticated one-second personal snapshots supply only the current player's hole cards until showdown, never the future deck, and use private/no-store headers. Public tavern SSE sees only safe table status and chair figures. The bar and both game types enforce one physical/table membership. This version does not attach Vegas's voice transport to the new poker identity model.

Verification completed locally by Codex, not my own acceptance:
- Full check: 304/304 tests plus typecheck, 33 files. The 29 added cases include all hand categories and kickers, wheel straights and suit ties, main/side/uncalled pots, odd chips, short/cumulative all-ins, heads-up blinds, invalid/stale actions, 160 complete randomized hands with chip conservation and a unique 52-card deck, NPC operation, five-seat capacity, cross-game/floor exclusion, outer rollback, real SQLite backup/reopen, online search/invitation authorization/expiry, private HTTP snapshots and refresh stability.
- Real browser Offline: entered from a physical chair, verified own cards/opponent backs, played a five-player hand through flop/turn/river and showdown. Morgan's straight received the 20-chip pot; stacks totalled 2,500. Deal next hand kept the human's 496 chips and rotated the button. Leaving returned to the tavern; choosing the fifth chair started a valid five-seat table. A separate reload preserved the older hand's exact cards and winnings.
- Real browser Online: two separate origins (localhost and 127.0.0.1) provided isolated browser storage against the same local service. Searched Poker Friend, sent a toast, declined, reinvited and accepted. Each player saw only their own two pocket cards. Actual All in/Call clicks ran out the board, produced a 1,000-chip payout, then a free rebuy enabled another hand. A host click before the other player's rebuy had propagated correctly got stale_state; retry after the fresh snapshot worked. Both test seats were explicitly exited.
- In a mobile layout check, the active friend tab's 390px viewport reported 375px document width (scrollbar excluded), equal scroll width; screenshot inspected with no horizontal overflow. The first viewport attempt affected the active friend tab rather than the host, so its desktop screenshot is not claimed as mobile evidence.
- No console errors in either browser. A first automated browser wait was shorter than several sequential NPC turns; the bounded driver was corrected to re-observe the actual UI rather than call it a game failure. An early constructed all-in test omitted its deck; it was fixed to begin from a properly dealt hand. These are test-driver corrections, not silently weakened rules.

Screenshots are saved outside the repo under workspace tmp: poker-offline-showdown.png and poker-friend-mobile.png. These are agent-driven checks, not two friends on physical devices. Ordering remains untouched; no crit tag/reflection or /ship change is part of this follow-up.

## 2026-10-23 — Round poker table and unavailable Vegas-seat recovery (Codex)

I asked Codex to put five characters around a round poker table, with cards directly on the felt. While that work was underway, I reported that an Offline Vegas entry showed an invalid saved-seat message and would not let me exit. Codex initially inferred a localhost problem from ambient browser context; I corrected that I was testing the deployed site. Codex then inspected production directly. Its own production identity entered and exited an existing Offline game, and created a fresh five-player Offline game successfully on build 448b62d861. This does not reproduce the exact original failure on my browser, and cache/local-server causes are not established.

Confirmed recovery defects: enterRoom caught every failure (including closed rooms, transient HTTP errors and rendering errors) as an unrecoverable identity failure. The error page reused the normal departure-saving Back button, so it could send the same invalid credentials again and block navigation. The fix classifies terminal room/session errors, retains credentials and offers retry on transient errors, and gives the error page an unconditional Back to the bar path plus Exit game. The regular Back path also tolerates terminal seat errors while preserving genuine transient departure failures. Entry continuations check the current route before rendering.

A new authenticated bar/exit-game endpoint lets the genuine bar owner exit only the currently linked Vegas room, without exposing or requiring the browser's lost room credential. The supplied room code must match the current binding; a stale error tab cannot exit a newer game or another player's room. Existing room exit logic still owns Offline closure, Online NPC handoff, host transfer and last-human closure. No user database/session was edited to diagnose this.

Browser reproduction was on isolated local data: Codex created a real Offline game through its UI, navigated away without clearing storage, changed only that disposable test room's server-side test secret, then reopened the saved room URL. The corrected authentication-error page appeared with Exit game and Back to the bar. A real click on Exit game returned to the tavern; a separate server read confirmed closed=true and the local owner's table binding was null. An earlier controlled closed-room check confirmed that a closed room is displayable. The exact underlying cause of my original production failure remains unconfirmed.

Poker presentation: both modes share one round green-felt table with wooden rim, five original CSS pixel figures/chairs, table-top hole cards, community cards, wagers and stacks. The viewer sits at the bottom through display rotation only; authoritative seat numbers/turn order are unchanged. Online vacancies remain visible. Opponents retain card backs unless the private server snapshot explicitly authorizes a reveal. Waiting mid-hand arrivals have no dealt-card display. Actual desktop and 390px browser screenshots revealed label/card overlap during implementation; spacing and the north-seat labels were corrected. The phone view had no horizontal overflow and no card/label/community overlap after that correction. These are Codex browser checks, not my personal acceptance.

Verification: three new renderer contract tests and one owner-exit authorization regression, including wrong secret, another room and stale room-code protection. Typecheck and check:evidence passed. Unrestricted full-suite attempts hit existing long HTTP test timeouts; the two long files passed independently (12 tests, 9.69s). Reusing that database then exposed occupied shared test tables. The final full suite used a fresh isolated DATA_DIR and maxWorkers=4: 34 files, 308/308 passed in 33.08s; no timeout/assertion was relaxed. Implementation commit: c122451. CI/deploy verification is recorded separately after it completes. Orders, crit tags and reflections are untouched.

## 2026-10-23 — Poker bankruptcy acknowledgement (Codex)

I asked for bankrupt players to leave the game, then clarified that a popup must tell them what happened and let them click Return to the bar. Codex applied this to human Hold’em chip stacks, not Vegas winnings (which start at zero). All-in zero is still eligible; bankruptcy is evaluated only after the hand's side pots, splits and uncalled refunds have settled.

Implementation: settlement atomically releases zero-stack human memberships, marks their seat departed, transfers host or closes the last-human room, and writes a private poker_notices row with a unique notice id and the hand result. An older settled zero-stack game is reconciled on authenticated reads/ticks/actions. The popup survives refresh/restart and stays until its owner acknowledges it; navigation happens on that click, not before. Authentication plus notice-id matching makes acknowledgement owner-only and safe against stale/repeated clicks. There is no in-place rebuy. A deliberate later re-entry after acknowledgement can receive a fresh free 500-chip buy-in if the old wallet was zero. This is an explicit new seating action, not automatic replenishment during the lost game. NPC refill remains the previous house setting.

Verification: six server regressions and two client component cases cover all-in before/after losing settlement, winning the all-in, Online host transfer, Offline closure, owner-only notice acknowledgement, wrong/stale ids, repeat reads, migration/reopen persistence, settlement rollback, deliberate re-entry and acknowledgement failure/retry. The existing HTTP test now follows a remaining seated player after showdown, since its former fixed viewer can legitimately be eliminated. An older leave/rejoin assertion also had a genuine random-dealer assumption: folding the big blind can return an uncalled blind, so it incorrectly compared the post-refund bankroll with the pre-fold number. Codex corrected the assertion to preserve the actual post-settlement amount; the engine was not changed for that test.

Real browser: Codex created a disposable Offline room on an isolated local service, prepared a deterministic river fixture in that local database only, then used an actual All in 10 button. The UI first showed 0 chips / All in while the hand continued, then the normal NPC response and settlement triggered Out of chips with Morgan +20. Reloading kept the popup. Clicking Return to the bar navigated to the tavern. A separate DB check confirmed closed=1, activeSeats=0 and pendingNotice=0. This was Codex verification with controlled local data, not my own natural-game acceptance or a production game modified to force a loss. Screenshot: ../tmp/poker-bankruptcy-popup.png.

Final local checks: pnpm check --maxWorkers=4 passed typecheck and all 316 tests across 36 files (24.89s); check:evidence passed. README, ADR-poker and CLAUDE reflect the new rule. Other games, src/orders.ts, existing crit tags and reflections are untouched. At this checkpoint the real-life tavern features were proposals; I subsequently chose mixology in the next entry.

## 2026-10-23 — Counter-side mixology assistant (Codex)

I chose the cocktail assistant as a practical addition to the tavern. Codex implemented public/mixology.js, opened by the actual counter or a Mixology book HUD button. The modal uses dark wood, parchment, brass and original CSS glass illustrations. Opening clears movement/held directions; Escape/close releases the modal and route disposal removes it. This is additive to games and does not wire up src/orders.ts.

Scope: 8 IBA classics and 3 university-sourced mocktails; recipe/name/ingredient search, alcohol-free and pantry-match filters; grouped pantry ticks; source-linked instructions, equipment and optional garnishes; quantities for 1–20 glasses per recipe; a multi-recipe list with bought ticks, missing-only view and copy. Clipboard rejection exposes selectable text rather than false success. localStorage persists pantry, plan and bought ticks in this browser only; unavailable storage is reported honestly. No new dependency, API, account, server write or shared pantry. The module is included in the deployed content hash and loaded with that hash.

Recipe decisions are in docs/mixology-sources.md. Codex opened all eight IBA primary recipe pages and the university source. Soda splashes/top-ups and the unmeasured Husker Mule use explicitly marked house planning estimates. Cornhusker Crush's source yield is two glasses, so scale divides by two before multiplying. Different units remain separate, estimated components keep their estimate flag after aggregation, and optional garnish/ice do not affect required matching. The tool does not claim to measure pantry stocks.

Checks: eight new recipe/component cases cover source references, yield-aware scaling, range checks, matching, compatible-unit aggregation, estimate propagation, malformed saved data, list persistence, copy denial and a late native close event after reopening. A ninth HTTP case checks the versioned module bytes; the existing cache hash assertion includes it. The complete isolated suite passed typecheck and 325/325 tests in 37 files (26.75s, maxWorkers=4), plus check:evidence. Initial typecheck caught missing inferred JS parameter types in test callbacks; explicit JSDoc fixed the inference. Final visual cleanup was followed by 13/13 targeted component/cache tests and typecheck.

Actual browser checks on an isolated local service: selected rum/lime/sugar/mint/soda; ready filter returned Daiquiri and Mojito. Four Mojitos plus two Cuba Libres gave rum 280 ml and lime 100 ml. Copy succeeded, and reload/re-enter restored the five pantry ticks and both recipes. Alcohol-free filter returned three. Cornhusker scaled to three glasses gave coconut 180 ml, strawberries 1.5 cups, mint 18 leaves, lime 45 ml, honey 22.5 ml and soda 360 ml. At 390×844, document width was 390 and main scroll width equalled client width (355); screenshot inspected. Escape closed the native modal, no console errors. Screenshots caught an orphan stem decoration on stemless glasses and section scroll retention; both were corrected. Screenshots are outside git under ../tmp/mixology-*.png. These are Codex-operated checks, not my personal acceptance or real drink preparation.

Additional real UI check: Codex walked through the local tavern and clicked the rendered counter itself; the book opened. Clicking a bar stool still auto-walked and sat down, the book opened while seated, Escape closed it, and Stand up worked afterward. Final screenshot inspection confirmed the stemless-glass artifact was gone. No console errors were recorded.

## 2026-10-23 — AI custom-cocktail idea, investigated only, paused (Codex)

I proposed a follow-on to the mixology book: let a player enter the ingredients they actually have at home plus a taste preference, and have an AI suggest a custom drink. I chose the Claude API as the provider. Codex's work here was investigation only — reading the official Anthropic Messages API documentation (request/response shape, structured output, and authentication via an API key passed as a server-side secret, never in client code) — and no application code was written or changed for this feature: no new route, no client UI, no schema change, no dependency added.

Codex checked the deployed Fly app's own secret configuration the read-only way, via `flyctl secrets list`, which names configured secrets without exposing any value. That list is currently empty: no `ANTHROPIC_API_KEY` or equivalent is configured for this app. No secret value was read, printed, or otherwise accessed, here or anywhere in this investigation.

I decided to pause this feature until I configure the key myself, rather than have an agent proceed without it. Nothing about the existing mixology book changes because of this: today's recipe assistant is a fixed, pre-written recipe list with local ingredient matching and unit conversion, not an AI-generated feature, and it does not call any external model. This entry exists so the pause and the investigation's actual scope are on record; it is not a claim that generation exists, that a key has been configured, or that I have accepted a design for it.

Implementation commit: 8e2f6d1. CI run 39819210847 completed successfully (check and deploy). Production /version is fe1c035dd6, matching the hash of committed LF asset bytes; app.js, styles.css, tavern.js and mixology.js were individually fetched over HTTPS and compared byte-for-byte with git show HEAD. A real production browser using Codex's existing Agent review identity opened the book, searched Mojito and changed the quantity to two glasses: rum 90 ml, lime 40 ml, mint 12 sprigs, sugar 4 tsp and estimated soda 120 ml, with the IBA source link visible and no console errors. It did not create or alter a game. Production screenshot: ../tmp/mixology-production.png. Orders, crit tags and reflections remain untouched.

## 2026-10-27 — Final Project requirements and final review checklist (read, recorded; no closeout started)

I asked Claude to read the official COMP8020/COMP4020 Final Project assessment page and the linked assessment-criteria page directly (not from memory) and record the actual requirements against this repo's current documentation, so later closeout work has a real reference rather than a half-remembered brief. This entry is a sync of requirements and a checklist for later use — it does not itself claim any item below is done, and no functionality, README, PROCESS.md, or research-note.md was changed to produce it.

### Sources actually read this session

- `https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/` — the Final Project (A3) brief itself.
- `https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/` — band descriptors and the general "what you submit" page it links to.

### Deadline

The final-project page states the deadline as "noon, Monday 9 November 2026 (the first Monday of the exam period)" without itself naming a timezone. This repo's own Crit 10 entry above recorded that course cutoffs are consistently given in Australia/Sydney local time (stated there as "same local time as Australia/Canberra"); I am recording the A3 cutoff the same way, as the user described it: **noon, Monday 9 November 2026, Canberra time**, but flagging that the word "Canberra" is my own addition for consistency with how this course has stated every other deadline so far, not a phrase the Final Project page itself uses — worth re-confirming against the live page close to the date rather than assuming it can't change.

### Weighting (I am a COMP8020 student)

Per the assessment-criteria page, COMP8020's final project splits as: Process 35%, Deployed application 20%, Response to the brief 20%, Critical research note 25% (of the project total; stated elsewhere as "10% of the course" overall). This differs from COMP4020's own split (Process 50%, Application 25%, Response to brief 25%, no research note) — I am COMP8020, so the four-way COMP8020 split is the one that applies to this repo.

### Fixed technical requirements (unchanged from what this repo already targets, now sourced to the actual brief)

- **Multi-user, distinguishable:** "two or more people, each in their own browser, act on shared state, and the app tells them apart." This repo's existing server-authority/identity rules above already target this; nothing new is implied.
- **Near-real-time:** changes must reach other open sessions "within about a second, with no reload or other action by the viewer" — this is the same ~1-second bar Crit 9's SSE work above already targets, not a new number.
- **Durable across sessions, restarts, redeploys:** "it persists: what someone does in your app is still there when they, or anyone else, come back... across sessions, restarts and redeploys." This repo's SQLite-on-Fly-volume design already targets this; closeout needs to actually re-check it (see checklist below), not assume it from the architecture alone.
- **Marking viewports:** the assessment-criteria page states two fixed marking viewports, **1920×1080** (desktop) and **390×844** (phone, "the iPhone preset in Chrome DevTools' device toolbar"), both in the latest stable Chrome, both treated as "full marking environments." Two simultaneous markers are described as using "separate Chrome profiles (an incognito window counts), so they share no cookies."

### Required final materials (from the brief, matched to what this repo already has or still needs)

- The deployed `*.fly.dev` application (exists: `https://comp4020-final-shuyangyuzu-cmd.fly.dev`).
- The public source repository, including the checks it runs (`spec/`, `pnpm check`, `pnpm check:evidence`).
- `README.md`, published in full at the live `/readme/` route.
- `CLAUDE.md` and anything it references.
- `PROCESS.md`.
- The three existing crit reflections (`reflections/crit-8.md`, `crit-9.md`, `crit-10.md` — all already present).
- "The commit history behind them" — an ongoing, incremental history, not one late bulk commit.
- COMP8020 only: a `research-note.md` **in the repo root**, at the same commit as everything else. This file does not exist yet in this repo as of this session — see "known gaps" below.

### Indicative word counts (brief states no mechanical word-count penalty; focus and concision are themselves part of what's assessed)

- `README.md`: 400–600 words.
- `PROCESS.md`: 900–1100 words for the final project (rewritten/reorganised at each stage, per the brief's own framing — not an ever-growing append-log).
- `research-note.md`: 600–800 words.

### What each document is actually supposed to argue, per the brief

- **README.md** is "the argument" for the project: what "good" means for *this* app, what sources were consulted, what was deliberately not built. The brief states the strongest READMEs "say which claims are enforced, which are judged, and how the judged ones were judged" — a README that defines good only in terms of what's mechanically testable "misses the point."
- **CLAUDE.md** is "the rules": the standards the agent's work must meet, *derived from* the README's argument — what the app must never do, what every page must hold to, what a change must not break. This is exactly this file's own existing role and self-description at the top.
- **`spec/`** is "the checks": only the parts of README's definition of good that can actually be tested mechanically (a message expiring, a room's capacity limit, and so on) — not a replacement for README's fuller argument, and not expected to cover everything README claims.
- **PROCESS.md** explains the stack, the agent workflow, and the trade-offs, and is expected to cite real commits as evidence for its claims about process (checked by `pnpm check:evidence`) — not asserted without support.
- **research-note.md** (COMP8020 only) must take "a position on what good agentic software-development practice is," argued from both scholarly and practitioner literature (the brief explicitly allows practitioner posts/talks/framework docs as sources, since "practitioner writing moves faster than peer review in this field"), and must directly meet the counter-case rather than ignore it. It is explicitly **not** a project summary: "an argument that doesn't reach beyond your own project belongs in README.md or PROCESS.md instead," and running "to summary in places" is itself marked down.
- **Feature count is not itself rewarded.** The brief states plainly: "There's no feature checklist, and features that aren't part of your definition of 'good' don't earn extra marks," and warns that "features with no reason to exist" count *against* the response-to-brief mark, as does a README that promises a version of good "the rules and checks never mention." Any feature added between now and closeout should be checked against this — does it serve this app's own stated definition of good, or is it an unexplained add-on — rather than assumed to help by existing.

### Why this matters for how this repo is currently organised

This repo's CLAUDE.md already functions as "the rules," and `spec/` already functions as "the checks" in roughly the shape the brief describes; PROCESS.md already cites real commit links, checked by the existing `pnpm check:evidence`. The one concrete gap this reading surfaced is `research-note.md`, which does not exist yet and is COMP8020-specific — noted below as a known gap, not something to draft this session.

## Closeout review checklist (for later use — nothing below is checked off yet, and this entry does not claim any item has passed)

This is a checklist to actually run through once I say "begin closeout," not a record of verification already done. Recording it now, ahead of time, is itself part of taking the brief's own distinction between asserted and shown process seriously — an HD-band process is described as diagnosis made visible, not an assertion added at the last minute.

1. **Two independent browser identities, full multiplayer flow, simultaneous action, slow network and disconnect recovery.** Re-run the core multiplayer paths (room join/approval, a full game, voice if applicable, tavern presence/speech) with two genuinely separate Chrome profiles acting at the same time, including a deliberate slow-network/disconnect scenario and recovery — not just two sequential solo passes.
2. **Both exact marking viewports, core interactions.** 1920×1080 and 390×844 in actual Chrome (DevTools device toolbar for the phone size), checking the core interactions specifically — not just that nothing visually overflows.
3. **What survives a restart, a redeploy, and a return the next day.** Confirm concretely, against the real deployed app, what's still visible/usable after each of these three — not assumed from "it's SQLite on a persistent volume" alone.
4. **Presence/grace-period boundaries are coherent end-to-end.** Transient-connection grace, the three-minute seat-holding grace, game-end state, and genuinely long-term persisted data (winnings, wallets, mixology pantry) — confirm the boundaries between these are both individually correct and consistent with each other and with what CLAUDE.md and README currently claim.
5. **Every feature added has its constraints/tests/docs/process evidence in sync.** For each feature shipped since the last full review, confirm CLAUDE.md's rules, `spec/`'s tests, README's claims, and PROCESS.md's process evidence all actually match current behaviour — not just that the feature works in isolation.
6. **README/PROCESS reorganised and trimmed at closeout, not just appended to again.** Per the brief's own framing of PROCESS.md as rewritten at each stage rather than an ever-growing log, and README's 400–600-word target: closeout should restructure and cut, not add one more paragraph on top of an already-long document. (Known already-too-long state recorded below.)
7. **research-note.md, its sources, commit citations, and the three reflections are complete and accurate.** Confirm the research note exists, meets its own brief (a position, not a summary, meeting the counter-case, citing real literature), that PROCESS.md's commit citations actually resolve, that all three crit reflections are present, and that the live `/readme/` route actually serves the final README content.
8. **`pnpm check`, `pnpm check:evidence`, CI, actual deployed version, and secrets.** Full local check suite, evidence check, a green CI run, the live app's `/version` matched byte-for-byte against the committed source the way prior entries in this file already did, and a secrets-name-only check (never values) if anything new needs one.
9. **Separate agent-automated verification from my own manual acceptance; no fabricated PASS.** Every verification claim in the final documentation must say plainly who performed it (Claude, Codex, or me) and how (HTTP/unit test, automated browser, or a real human click) — consistent with how PLAN.md has recorded this distinction throughout this repo's history, and never upgraded to "I verified" or "PASS" without an actual human session behind it.

## Known gaps, explicitly deferred past this session (not actioned now)

- **README.md and PROCESS.md are already long** (longer than their indicative final-project word counts) and are explicitly left as-is until closeout, when they'll be reorganised and trimmed per the brief's own "rewritten, not appended" framing above — not touched this session.
- **`research-note.md` does not exist yet.** It needs its own reading and argument-building time ahead of closeout (the brief itself suggests starting "early, week 10 at the latest," since no crit session covers it) — not drafted by an agent on my behalf, and not started this session.
- **The AI custom-cocktail feature remains paused, unimplemented, with no Fly secret configured** — unchanged from the entry immediately above; this session did not touch it, investigate it further, or configure anything.

## 2026-10-27 — Clock, stamina, front-of-house menu, eating/drinking, and temporary NPC standby (design, before implementation)

I asked Claude to resume feature development (not closeout) with five connected additions: a real Canberra clock on the tavern map, a server-authoritative stamina stat for bar identities, a Meals/Drinks ordering menu at the counter, actually eating/drinking to restore stamina, and — added in a follow-up message — a per-Online-game "temporary NPC standby vs self control" away choice (distinct from the existing permanent handoff) plus moving the stamina readout into the top HUD beside "Your character." I explicitly authorized modifying and wiring up `src/orders.ts` this round, rather than leaving it permanently untracked — its existing design (a single fixed-price, single-"active-order" menu with a fictional currency) conflicts with the new requirements (two consumable kinds held at once, recovery-not-price as the core stat, preparation-method variants) and will not simply be reused as-is.

Before writing any code, Claude read `src/db.ts`, `src/actionLog.ts`, `src/presence.ts`, `src/bar.ts`, `src/live.ts`, `src/version.ts`, `src/barLayout.ts`, `src/position.ts`, `src/types.ts`, `src/pokerSchema.ts`, `src/pokerRoutes.ts`, `src/poker.ts`, `src/pokerEngine.ts`, relevant slices of `src/rooms.ts`/`src/tables.ts`/`src/server.ts`, `spec/exitGame.test.ts`, `spec/helpers.ts`, `scripts/check-evidence.ts`, and `public/mixology.js` directly, and ran two background investigations (one into the existing away-from-table/NPC-handoff machinery in both game modes, one into the client's modal/HUD/canvas patterns) so this design is grounded in what the code actually does today, not assumed from CLAUDE.md's prose summary of it. Both investigations' findings are folded into the decisions below; nothing here second-guesses them without re-reading the cited lines myself.

### Key finding that reshapes the away-mode request: Vegas and poker have genuinely different disconnect architectures, confirmed by direct reading

Vegas rooms carry a persistent, versioned `controller: "human" | "npc"` field per player inside `state_json` (`src/types.ts`'s `Player` interface), flipped one-way and forever by `handoffToNpc` (`src/rooms.ts:945`) after the existing 3-minute `table_departures`/`room_departures` grace expires, enforced by `refuseIfNpcControlled` (`rooms.ts:1152`) inside `roll`/`place`, and acted for by a scheduler (`src/server.ts`'s `scheduleNpcTurnIfNeeded`) that calls `rooms.npcRoll`/`npcPlace` — both idempotent, both re-checking `controller === "npc"` fresh against the database at execution time, not trusting an in-memory guard alone.

Poker has **no such field at all**. An NPC poker seat is identified only by its id's `npc:` string prefix, set once at table creation and never applied to a formerly-human seat. A departed human is never "handed off to NPC control" — `leavePokerHand` (`src/pokerEngine.ts:144`) simply folds them (or leaves an existing all-in un-folded, preserving pot eligibility) and `poker_members.active` flips to 0, removing them from the table outright. Separately, poker already has a 45-second per-action timeout (inside `tickPoker`, `src/poker.ts:176`) that auto-checks-or-folds a human who hasn't acted in time — this is a **pre-existing, unrelated legitimate-timeout rule** that fires for every seated human every hand regardless of connection status, not a form of NPC control, and must not be confused with the new standby toggle.

This means "temporary NPC standby vs self control" cannot be one shared mechanism across both games. For **Vegas**, the existing `controller`/scheduler machinery already knows how to act for any npc-controlled seat regardless of how it got that way — adding temporary standby is primarily a matter of a new, separate, reversible field alongside `controller` (never reusing `controller` itself, which CLAUDE.md and the existing code treat as deliberately one-way) plus a scheduler gate. For **poker**, there is no existing "a human seat plays itself with computer logic" capability to repurpose — building real temporary standby play for poker would mean teaching the existing NPC action heuristic (currently gated on `npc:`-prefixed ids) to also act for a real human seat under the new flag, which is new plumbing, not a toggle.

### Decision: implement temporary standby for Vegas now; poker gets the "self-control, marked away" half only, this round

Given that gap, and because the user's own spec explicitly asked me to check each game's actual rules rather than copy one button everywhere: Vegas gets the full two-way choice (NPC standby / self control) as the two live options when leaving an Online table mid-game, implemented via a new `awayMode: "npc" | "self" | null` field on `RoomState.players[id]`, alongside (never replacing) `controller`. Poker, this round, gets the away/self-control *state* (a visible "away" badge, the existing 45-second-timeout and fold-on-leave behaviour unchanged, no new NPC-decision plumbing) rather than a working temporary-NPC-standby mode — attempting real standby play for poker without the underlying capability would mean either quietly building a second, under-tested decision heuristic under time pressure or silently reusing the real `npc:` NPC logic for a human seat in a way nothing in poker's architecture currently supports cleanly. This is recorded here as a real scope decision, not a silent omission: poker's own `ADR-poker.md` and `CLAUDE.md`'s poker section will be updated to say exactly this once implemented, and `PROCESS.md`/README will not claim "NPC standby" for poker.

### Stamina: single source of truth, exact formula, and where it lives

A new persistent per-bar-identity row, **not** inside `bar_players` (whose columns are all permanent profile/position fields) and **not** inside `rooms.state_json` (a frequently-changing numeric stat has no more business in the versioned game blob than a heartbeat does, per the same reasoning `presence`/`table_departures` already established) — a new table, `bar_stamina`:

```sql
CREATE TABLE IF NOT EXISTS bar_stamina (
  player_id TEXT PRIMARY KEY REFERENCES bar_players(id),
  value REAL NOT NULL,
  last_computed_at TEXT NOT NULL,
  online_since TEXT
);
```

`value` is the stamina level as of `last_computed_at`, lazily recomputed (the same "evaluated fresh on every read" principle as the lobby disconnect grace and bar speech expiry — no sweep, no background timer) whenever a read or a consuming action needs a current number: elapsed *online* seconds since `last_computed_at` are subtracted at the configured rate, clamped to [0, 100], and the row is updated in the same transaction as whatever triggered the read. `online_since` is null while this identity has no currently-open bar session (no heartbeat within `PRESENCE_STALE_MS`) and is set to "now" the moment a heartbeat/join/rejoin re-establishes it — consumption only accrues for the portion of elapsed wall-clock time that was actually spent online, never for a gap while `online_since` was null. This directly satisfies "same person in multiple tabs consumes one stamina" (there is exactly one row per `bar_players.id`, and every tab's heartbeat just refreshes the same `bar_presence`/`online_since` pair, never multiplies consumption) and "offline doesn't consume" (the lazy recompute only ever charges for online intervals, read off `bar_presence`/`online_since`, never off raw wall-clock time since last read).

Centralised, named constants (new file `src/stamina.ts`, same env-overridable-for-tests pattern as `PRESENCE_STALE_MS`/`SPEECH_DISPLAY_MS`):

```ts
export const STAMINA_INITIAL = 80;
export const STAMINA_DECAY_PER_HOUR = Number(process.env.STAMINA_DECAY_PER_HOUR ?? 21); // ≈17% after 3h online
export const STAMINA_MEAL_RESTORE = 70;
export const STAMINA_DRINK_RESTORE = 30;
export const STAMINA_LOW_THRESHOLD = 20;
```

A brand-new bar identity gets `value: STAMINA_INITIAL` at `joinBar` time (never later, never on first read) — this is a persistence fact (CLAUDE.md: "survives restarts/redeploys"), not something a lazy-read default could quietly substitute for one, since a default would be indistinguishable from "never computed yet" if `joinBar` didn't actually write it. Refresh, returning to the bar, switching games, and reconnecting all re-run the same lazy recompute against the same persistent row — none of them reset `value` or `online_since`, because none of them is "a brand new identity."

A consuming action (eating a meal, drinking a drink) adds its fixed restore amount to the *current, freshly recomputed* value, inside the same transaction as the recompute and the clamp to 100 — "full stamina still allows ordering/eating, but doesn't store extra" is satisfied structurally: `min(100, recomputed + restore)` cannot exceed 100 no matter how high the pre-restore value already was, and there is no separate "banked" quantity anywhere for extra restore to accumulate into.

### Menu and consumption: redesigning `src/orders.ts`, not preserving its old shape

The existing untracked `src/orders.ts` (a fixed six-item menu, one fictional price per item, exactly one "active order" at a time, no stamina concept, no preparation choice) is being replaced in place — same filename, same "virtual consumption only, no real payment, no poker/Vegas balance touched" framing from its own header comment, but a genuinely different schema and API shape, because its single-active-order design is incompatible with "hold a meal and a drink at once" and it has no restore-amount or preparation-variant concept to extend. Concretely:

- **Menu data** (`MenuItem`): `id`, `name`, `description`, `kind: "meal" | "drink"`, `restoreAmount` (70 for every meal, 30 for every drink, per the user's own instruction that cooking method/garnish doesn't change recovery this phase), an optional `variants: { group: string; label: string }[]` for a real choice (only items that genuinely have one — e.g. a steak's doneness, a burger's sauce — ship a `variants` array; every other item ships none, so the client never offers a meaningless identical dropdown on every dish), and a `recipeNote` (a short in-fiction description of how it's prepared — *not* a Mixology-book recipe; this is game-menu flavour text, not a real-world recipe needing a cited source, since CLAUDE.md's citation requirement for real recipes applies to the Mixology book's real cocktails, not a fictional in-game "Grilled Trout, pan-seared with lemon butter" menu description).
- **A small, complete first set**: 4–5 meals, 3–4 drinks (not padded with placeholders), at least one meal with a genuine variant choice (e.g. doneness) and at least one with a sauce choice, so the variant-selection UI has real cases to prove out, per the user's explicit "don't fake the same options on every dish."
- **Held/consumable state**: a new table replacing the old single-row `orders` concept —

```sql
CREATE TABLE IF NOT EXISTS held_items (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES bar_players(id),
  kind TEXT NOT NULL,           -- 'meal' | 'drink'
  item_id TEXT NOT NULL,
  variant TEXT,                 -- the chosen option label, or NULL
  state TEXT NOT NULL,          -- 'held' | 'consumed'
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
```

  A player can hold **one meal and one drink at once** (checked as "at most one `held`-state row per (player, kind)", not "at most one row total" — this directly replaces the old single-active-order constraint that the user explicitly said must not persist), ordering a second item of a kind already held is refused with a clear message rather than silently replacing it. `idempotency_key` is the same pattern the old file already used for place-order dedup, extended to the consume action too (see below) — a UNIQUE constraint backstop behind an explicit pre-check, same as `chat_messages_dedup`.

### Ordering, with real variant selection, never restoring stamina on its own

`POST /api/orders/place` (new routes, registered the same way `pokerRoutes.ts` registers poker's): `requireBarSession`, validates `itemId` is on the menu and (if the item has `variants`) that the submitted `variant` is one of that item's own real option labels for the correct group — never accepting an arbitrary string, and never accepting a variant for an item that has none. Confirms by returning the resolved item + chosen variant in the response (so the client can show "Grilled Trout, medium-well" before the player commits) — this requires the client to do a "preview" step with no server mutation (pure menu-data lookup, same as browsing/filtering the Mixology book doesn't touch any server state), then a separate confirm POST that actually creates the `held_items` row. Ordering, browsing the recipe note, and switching categories never touch stamina — only `consume` (below) does, directly satisfying "menu browsing never pre-restores."

### Eating and drinking: the only thing that restores stamina, exactly once per held item

`POST /api/orders/consume`: `requireBarSession`, loads the caller's `held` row by id, requires `state = 'held'` (a second consume attempt against an already-`consumed` row is a no-op returning the same result, not an error — the same idempotency shape `placeOrder`'s old `idempotency_key` check already used, now also keyed by the held item's own row so a double-click, a retried fetch, or two tabs racing the same consume can't double-restore). The one transaction: re-read current stamina via the lazy recompute, add `restoreAmount`, clamp to 100, write `bar_stamina`, flip the `held_items` row to `consumed`, log the result. This is the single place in the whole feature that ever increases `bar_stamina.value` — ordering doesn't, browsing doesn't, variant selection doesn't.

Per the user's own scope: eating happens while holding a *held* meal (any dining-table seat or a stool, consistent with "food can be brought to a table"), drinking while holding a *held* drink at a stool or other seated spot — this is a **product-level placement rule for where the consume button is offered**, not a new server-side seat-type check beyond "this bar identity has a held item of the right kind" (CLAUDE.md's existing "pantry availability must never imply stock quantities" spirit extends here: the server doesn't referee *where* someone eats, only *that* they genuinely hold the item and haven't already consumed it — matching how sitting/standing is already its own separate, already-authenticated action).

### Three-minute away-from-table grace is unaffected by eating

Eating/drinking at a dining table or stool is an ordinary bar-world action, authenticated the same way `sitAtSeat`/`say` already are — it does not touch `table_departures`/`room_departures` at all (no new trigger, no new clearing condition), so a player who sits down to eat while away from a running game is governed by exactly the same existing 3-minute clock as sitting down for any other reason already is (`sitAtSeat`'s existing `table_departures` insert, unchanged). The UI will surface the existing remaining-grace information (already computable from the existing `table_departures.left_at` the same way "Return to your game" already is) rather than inventing a second clock — nothing new is added to the departure/grace model for this feature.

### Low-stamina nudge: a toast, never a game rule

Below `STAMINA_LOW_THRESHOLD` (20), the client shows a gentle, dismissable suggestion (toast-style, same non-blocking pattern CLAUDE.md's voice-invite toast already establishes, not a modal) to go eat or drink. Nothing server-side changes behaviour at any stamina level — no roll/place/bet is refused, no forced fold, no table ejection, no being blocked from walking to the counter. Stamina is purely a read-only status signal to the player; it has zero effect on dice, chips, odds, or turn legality, and `spec/` will include a regression that playing a full game at 0 stamina produces identical game outcomes to playing at 100.

### Clock: server time, DST-correct, drawn in the per-frame loop, not baked into the static floor

Per the client-UI investigation's finding, the static `floor` canvas is baked once at load and never updates — a live clock must be drawn in the per-frame `animate()` loop, in screen space (`worldX - camera.x`), reading `fixtures.find(f => f.kind === 'counter')`'s world position for placement above it (the existing "Las Vegas" sign text already occupies the space directly above the counter at a small offset, so the clock face is placed at a distinct offset clear of it, checked by direct coordinate computation the same way the plant/rug placements were, before being added). Canberra/Sydney local time with correct DST handling is `Intl.DateTimeFormat` with `timeZone: 'Australia/Sydney'` — the runtime's own IANA tzdata resolves AEST/AEDT and the transition dates correctly without this app hand-coding any UTC offset or DST rule itself (matching the user's own explicit "don't hard-code a UTC offset"). The clock face is pure client-side `new Date()` plus that formatter — no new server endpoint, since wall-clock time needs no authority or persistence and every open browser already has a correct system clock for this purpose (unlike dice rolls, which must be server-authoritative). A small digital readout (e.g. "14:32") is drawn beside or below the analog face specifically for legibility at the 390px breakpoint, per the user's own instruction.

### Top HUD placement for stamina, reusing the existing "Your character" entry point

Per the client-UI investigation: `.world-hud`'s `.hud-actions` row already holds the "Your character" button (`tavern.js`'s `chooseCharacter()` trigger). A new compact stamina readout (a small bar + percentage) is added as a sibling element in that same row, and clicking either it or "Your character" opens the same character panel — the existing `chooseCharacter()` dialog gains a read-only stamina section (a full bar plus a one-line "eating restores +70%, drinking +30%" note) below the existing clothing-colour/skin-tone pickers, without altering that dialog's existing save/cancel behaviour for appearance fields. Stamina is never a form field in that dialog — it's rendered from the same public bar-state payload every other HUD element already reads, with no input element at all, so there's no path through the existing `/api/bar/appearance` request (or any new one) that could set it; the dialog's existing submit handler is untouched and continues to only ever send nickname/color/skin. At the 390px breakpoint, the stamina readout is sized to fit inside the existing `max-width:155px` wrapped `.hud-actions` cluster (the investigation's exact finding), rather than claiming new fixed screen space that could cover the dpad, voice controls, or game chairs.

Poker's own compact per-seat status line (`.poker-seat-label`'s existing `<small>` join-string, per the investigation) gets the viewer's own stamina appended as one more conditional segment in that same line for *their own* seat only — not for opponents' (stamina is this identity's own status, not public information about other players, consistent with how winnings/hole cards are already kept private per-viewer).

### Stamina delivery: rides the existing public bar snapshot, no new transport

Per the architecture investigation, `PublicBarPlayer` (`src/bar.ts`) and `barSnapshot()` (`src/server.ts`) already carry every other per-player public field (position, color, skin, seatId, speech) over the one existing bar SSE channel. A new `stamina: number` field is added to `PublicBarPlayer`/`getPublicBarState` the same way `speech` was added when public tavern speech shipped — computed via the same lazy recompute described above, folded into the existing read, requiring no new endpoint, no new subscription, and automatically riding the existing `rev`/`seq`/`SERVER_EPOCH` staleness-gated push every other bar field already uses. Each player only ever needs to *see* their own exact number precisely (others' stamina isn't shown at all in the tavern view, matching "this is this identity's own status") — the public payload still only includes the viewer's own numeric value meaningfully from the client's perspective (the server does compute and could technically report every online player's stamina the same way it already reports everyone's position; the client simply never renders anyone else's, keeping the UI promise even though the wire payload, like position, is public-channel shaped). This mirrors exactly how `connected`/`seatId` already work: computed for everyone, rendered selectively.

### Online away-choice: implementation shape (Vegas)

New endpoint `POST /api/rooms/:code/depart-choice` (alongside the existing `/depart`/`/resume`/`/exit`): `requireSession`, body carries `{ mode: "npc" | "self" }`. Sets `state.players[playerId].awayMode = mode` inside the same `state_json` transaction every other room mutation already uses (optimistic-concurrency version check included), and — critically — **also** performs the existing `departActiveTable`/`departGame` departure-clock insert in the same transaction, since this endpoint *is* the "I'm stepping away" action, not a separate one the player must also remember to trigger. `awayMode` is `null` while a player is actively at the table; set only at the moment they choose to leave temporarily, and explicitly cleared back to `null` by `resumeActiveTable`/`resumeGame` the same way the departure row itself is already cleared there — both must clear together in the same transaction, since a resumed, actively-present seat has no meaningful "away mode" at all.

`scheduleNpcTurnIfNeeded`'s existing gate (`current.controller !== "npc"`, confirmed from the investigation) gains an additional condition: a player whose `controller` is still `"human"` but whose `awayMode === "npc"` must also have their turn taken by the scheduler — this means `npcRoll`/`npcPlace` need a second entry condition alongside their existing `player.controller !== 'npc'` check (which must remain, for the genuine permanent-handoff case), not a replacement of it: the scheduler and the roll/place engine both treat "player.controller === 'npc' OR player.awayMode === 'npc'" as "this seat's turn is taken automatically," while `refuseIfNpcControlled` similarly refuses the *original human's own session* from acting while `awayMode === 'npc'`, exactly mirroring the existing permanent-handoff refusal, but reversibly: the one thing this new check does differently from the permanent one is that a successful `resumeActiveTable`/explicit "resume control" action clears it, where the permanent handoff's `controller` flip famously never clears.

**The in-flight, not-yet-executed edge case the user explicitly called out** ("already-submitted legitimate NPC actions are kept; a timer-pending-but-not-yet-executed action must recheck control before acting"): `scheduleNpcTurnIfNeeded`'s existing `setTimeout`-delayed call already re-reads fresh state inside `npcRoll`/`npcPlace`'s own transaction at execution time (confirmed by the investigation) rather than trusting the state captured when the timer was scheduled — this existing design already gives the new check what it needs for free: if a player calls "resume control" during the `NPC_TURN_DELAY_MS` window, by the time the delayed call actually executes and re-checks `awayMode`, it will see `null` (already cleared by the resume) and decline to act, exactly as a permanent handoff's own re-check already declines to double-act against a state that's moved on. No new guard is needed beyond ensuring the awayMode re-check happens at the same point in `npcRoll`/`npcPlace` where the `controller` re-check already happens — both read the identical freshly-fetched `state`.

**Self-control mode explicitly does not call any NPC decision path** — this is enforced structurally, not by a separate flag check sprinkled through the engine: the scheduler's gate (above) simply never schedules a call to `npcRoll`/`npcPlace` for a seat whose `awayMode` is `"self"` (or `null`), and the ordinary `roll`/`place` HTTP endpoints continue to accept the original human's own session for that seat exactly as before (since `controller` is still `"human"` and `refuseIfNpcControlled` only ever checks `controller`, not `awayMode`, for *that* direction) — meaning "self control" really is just "nothing changes, the seat is marked away for display, the original player can still act normally, nobody automated touches it." The only thing `awayMode: "self"` does is drive the public display label (see below) and the three-minute clock continuing to run identically to today.

**The three-minute clock is unaffected.** Both away modes reuse the exact same `table_departures`/`room_departures` row and the exact same `enforceExpiredDepartures`/`expireGameDepartures` three-minute sweep already in production — choosing "NPC standby" does not pause, extend, or otherwise special-case that timer; an NPC-standby seat that's still away past three minutes is handed off exactly as a self-control seat would be, via the existing, permanent `handoffToNpc` path, which also now clears the now-moot `awayMode` field (it becomes meaningless once `controller` itself has permanently flipped). The away-choice UI states this plainly ("Your seat reserves for up to three minutes either way — after that, a computer takes over for good") rather than implying NPC standby is a longer-term arrangement.

**Authorization**: only the seat's own already-authenticated session (`requireSession`, the existing check) may choose or later reverse its own away mode — never the host, never another player's session, exactly mirroring how `resumeActiveTable` and the existing departure actions already work. **A genuine disconnect** (heartbeat simply stops, no explicit choice made) cannot show this dialog at all — there's no client connection left to show it to — so the *existing default* (today: no awayMode set, the seat just sits idle until grace runs out, then gets handed to NPC exactly as today) is preserved explicitly as the fallback, recorded here as the answer to the user's own instruction to document what happens when a true disconnect can't present the choice.

**Toward the user's explicit regression list**: `spec/awayMode.test.ts` (new) will cover: choosing standby → scheduler takes the seat's turns → choosing to resume clears `awayMode` and hands control back; choosing self-control → no scheduler action occurs for that seat across multiple ticks; a resume racing an already-scheduled-but-undelivered NPC turn (confirmed above, re-check wins); a forged/wrong-session resume attempt is refused; the three-minute clock still expires into permanent handoff regardless of which away mode was chosen, and a fresh page cannot "take back" an already-permanently-handed-off seat via the old depart-choice endpoint (must check `controller !== 'npc'` the same way every other mutating room action already does via `refuseIfNpcControlled`, applied here too since depart-choice is itself a mutation on `state.players[playerId]`).

### Poker's away-state half, this round

`poker_members` gains one additive column (`addColumnIfMissing`, since the table already exists in deployed DBs — CLAUDE.md's migration rule applies here exactly as it did for `rooms.closed_at`): `away INTEGER NOT NULL DEFAULT 0`. A new `POST /api/poker/away` action sets it for the caller's own active membership row (`requireBarSession` + the existing `membership()`/`seated()` ownership check `poker.ts` already uses elsewhere), and a resume (returning to the table, the existing poker reconnection path) clears it. This is purely a *display* flag this round — `tickPoker`'s existing 45-second-timeout and `leavePoker`'s existing disconnect-triggered fold/removal are completely unchanged by it; a player marked "away" who is dealt into a hand is still bound by the same real timeout as anyone else, and the existing fold-on-leave at the 3-minute disconnect grace (`DISCONNECT_GRACE_MS`) is unaffected. The poker UI shows an "Away" badge next to that seat's label (the `.poker-seat-label`'s existing conditional-string slot, per the investigation) so other players understand why a seat might be slower to act, without pretending any automated standby play exists underneath it.

### What changes in CLAUDE.md, spec/, README, and PROCESS once each phase lands

Each implementation phase below will, in the same commit as its code: add the relevant CLAUDE.md constraint (stamina is server-only and read-only on the client; the menu is virtual/no real payment; `awayMode` is reversible and distinct from `controller`; poker's away flag is display-only this round), add its own `spec/*.test.ts` regressions (listed per-phase below), and add one PROCESS.md paragraph citing the real commit — never batched into one undocumented drop at the end. README gets the player-facing description of each shipped feature (clock, stamina bar/HUD, menu, eating/drinking, the away-choice dialog) in the same style as the existing Mixology book paragraph.

### Implementation phases (in order; each is check-green and committed before the next starts)

1. **`src/stamina.ts` + `bar_stamina` migration + wiring into `getPublicBarState`/`PublicBarPlayer`.** No UI yet — a spec-level regression proves the decay/clamp/multi-tab/offline-doesn't-decay math before anything is visible.
2. **Clock widget** (client-only, no server change) — drawn above the counter, DST-correct, legible at 390px.
3. **Stamina HUD + character-panel display** (client-only, consuming phase 1's new public field) — placed beside "Your character," read-only.
4. **`src/orders.ts` redesign + `held_items` table + menu/consume routes + spec regressions** (idempotent consume, two-kinds-held-at-once, variant validation, stamina-never-changes-at-order-time).
5. **Meals/Drinks client menu**, cloning the Mixology book's `createX({el}) → {open, close}` modal shape, plus the held/eat/drink UI at tables and stools.
6. **Vegas `awayMode`** (server: field, depart-choice endpoint, scheduler gate, resume-clears, three-minute-unaffected, spec regressions) **then** its client dialog (cloning `exitGameButton`'s confirm-dialog shape).
7. **Poker's `away` display column + badge**, last, since it depends on nothing from phases 1–6 and is the smallest, clearest-scoped piece.

Verification at each phase follows the user's own stated priorities (decay/offline/multi-tab math; 80%/70/30/cap/full-stamina-still-usable; order-variant/duplicate-consume/concurrency/rollback/restart; a real browser order→variant→collect→sit→eat→stamina-change run, then the same for drink; Mixology book regression-free; tavern movement/seating/game entry/live sync unaffected; both 1920×1080 and 390×844) — stated here as the plan, not yet claimed as done. No phase will be reported as verified without stating plainly whether the check was Claude's own automated run (unit/HTTP/Playwright) or an actual human session, per the user's own explicit instruction not to fabricate personal acceptance.

Nothing above touches `/ship`, crit tags, or existing reflections; these remain exactly as the final-project-requirements entry above described them.
