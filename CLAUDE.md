# Your harness

## Eating-animation contact geometry — manual-acceptance rejection and fix, 2026-11-05 (Claude)

The user's own real-browser manual playtest rejected the eating-animation round above outright, with specific, concrete failures: the glass's rim reached up near the eyes rather than the mouth; the plate's own CENTRE (not its near rim) was what the previous round's code drove toward the mouth; a grey, vertically-standing utensil was left floating beside the character with nothing holding it once the plate was picked up; and the empty plate/glass could be left visibly suspended at chest height rather than genuinely resting on the table at the end.

**Root cause, read before changing anything.** Every prop in the previous round's `drawEatingScene` computed its own independent, ad hoc "approximately near the mouth/table" offset rather than every prop reaching toward one single shared anchor via its own real geometry. The plate's contact math drove its ellipse CENTRE toward the mouth, which is wrong — a flat-to-tilted ellipse's own near EDGE is what actually touches something, and as `plateRy`'s own vertical squish shrinks with tilt, a centre-driven target visibly drifts the rim away from where it's supposed to land. The glass had the identical shape of bug, worse: its own rim position after `ctx.rotate` was never actually computed, only guessed at with a fixed offset, which is why it drifted up toward the eyes as the tilt angle increased.

**The fix: one shared coordinate system, two exported pure geometry functions.** `mouthAnchor(headY, headH)` is the single mouth anchor every prop now reaches toward — exported so it can be tested once and shared, not independently re-derived per prop. `plateCenterForRim(rimX, rimY, ry)` returns the ellipse CENTRE a flat-or-tilted plate must be drawn at so its own near RIM — not its centre — lands exactly on the given point; this is pure algebra (`centre = rim + (0, ry)`), verified directly by re-applying the ellipse's own geometry to the returned centre and confirming it reproduces the original target, at every tilt. `glassOriginForRim(contactX, contactY, bowlH, theta)` is the exact algebraic inverse of what `ctx.translate` + `ctx.rotate` actually does to the glass's own local rim point `(0, -bowlH)` — compute the rim's real position from the rotation angle FIRST, then derive the translation FROM that, rather than guessing a translation and hoping the rotated rim lands close by. `rotatePoint` mirrors canvas's own rotation convention exactly, so the two are provably consistent with what the browser will actually render, not merely self-consistent with each other.

**Verified by re-applying the forward transform, not by re-asserting the formula.** Per the user's own explicit instruction, `spec/eatingAnimation.test.ts`'s new tests never call `plateCenterForRim`/`glassOriginForRim` and then assert their own output — each test independently reconstructs the ellipse/rotation geometry a different way (an ellipse's own rim position; `ctx.rotate`'s own rotation matrix, written out by hand) and confirms it reproduces the original contact point, so a test can't pass merely by sharing a bug with the implementation. A further test confirms the plate's and the glass's own contact points, at full lift, both independently converge on the exact same `mouthAnchor` value — one shared system, not two independently-tuned targets that happen to look similar.

**The floating utensil, fixed by giving a resting prop exactly one pose.** `drawRestingFork`/`drawRestingKnife` draw a knife/fork lying flat on the table, oriented along the X axis, at a fixed, clear position — never standing on end, which is what the previous round's grey floating shape actually was (a bug in which call site passed which argument, now eliminated by giving resting utensils their own dedicated, geometry-correct drawing functions instead of reusing a box-primitive incorrectly). The fork's own food end — not just "the hand" — is what travels to the mouth, carrying a visible morsel partway through its own arc; the knife always rests, flat, on its own clear table position, never left standing once the plate is lifted.

**A second real bug found while re-verifying the fix with burst screenshots at the true end of the window:** the lowering phase previously finished landing EXACTLY at `local=1.0` — the identical instant the server's own lock naturally expires, with zero buffer. Measured directly (not assumed): ordinary SSE/poll round-trip latency typically clears the canvas 100-600ms after the true `local=1.0`, meaning the viewer's own actual last-seen frame was reliably still mid-descent — the empty plate/glass genuinely hanging in the air, exactly the "空盘不悬在胸前" complaint. Fixed with `MEAL_PLATE_LANDED_BY`/`DRINK_LANDED_BY`, each well before `1.0`, so the prop is provably resting (`lift=0`) for a real, visible span before the window — and any realistic network jitter on top of it — ever ends; re-confirmed by rerunning the identical burst-screenshot timing check that found the bug.

**A false alarm this round also caught in itself, before reporting it as a bug.** A resting plate's own rim, in this scene's existing tight close-up framing (unchanged from the already-accepted earlier round), visually sits only a modest distance below the mouth — close enough that an unverified visual read of a screenshot initially looked like "the plate is floating near the chin," which would have been a second bug report. Directly sampling the canvas's own pixel data (not a visual impression) confirmed the plate's rim position exactly matched the mathematically-expected resting position (`TABLE.y - plateRy(width, 0)`) to within antialiasing tolerance — this was the existing, already-accepted framing behaving correctly, not a new defect, and was not reported as one.

**Full suite**: `tsc --noEmit` clean. One final `vitest run`: **495/495** (490 + 5 new geometry tests), confirmed once, not rerun repeatedly.

## Password UX, recovery codes, and the eating-animation redo — 2026-11-05 (Claude)

Three changes on `integration/dominoes-eating`, continuing straight from the account-registration round above with no deploy and no crit tag moved.

**Password show/hide.** Every password input (login, register, confirm, and the new reset-password form below) is built from one shared helper, `public/tavern.js`'s `passwordField(el, {...})`, instead of a bare `<input type=password>` repeated per call site — each instance closes over its own `visible` flag, so toggling one field's eye icon never touches another's content or focus, and the toggle itself is `type="button"` so it can never submit the enclosing form. The toggle re-focuses the input after flipping, carries `aria-label`/`aria-pressed` that flip with the actual state, and changes only the input's own `type` attribute — nothing about a password value is ever logged or written to `localStorage` by this helper. Separately, the chat-bubble-over-login-form bug from the user's own screenshots was a missing guard: `speechToggle.onclick` now checks `overlay.childElementCount` first, the same pattern every other interactive control in this file already uses, and a CSS rule (`:has(>.world-overlay>*)`) hides the bubble/speech bar and the d-pad entirely while any world dialog is open.

**Recovery codes, the user's own explicit choice over email+link** (asked once via a direct question, since this app has no email system and the user wanted zero external configuration either way). Registration now generates and returns 8 unique `XXXX-XXXX` codes (`src/accounts.ts`'s `generateRecoveryCodes`, SHA-256 digests only — these are high-entropy server-generated randomness, not a human-chosen password, so a fast digest is the correct trade-off here, unlike `scrypt` for the password itself), shown exactly once in a dedicated acknowledgment screen before the player ever reaches the character chooser. `POST /api/accounts/reset-password` (username + one unused code + new password) verifies the code against `account_recovery_codes` with the identical generic failure message/code for a wrong code and a nonexistent username — no enumeration, matching every other account-layer error in this file. A successful reset is one transaction: marks the used code first, updates the password hash, calls the same `issueSession` revocation every fresh login already performs (every other `account_sessions` row dies), and issues a brand-new 8-code batch replacing the old one outright — a reused old code, even one from the batch that didn't get spent, is rejected. `POST /api/accounts/recovery-codes/regenerate` (current-password-gated, for a logged-in user who wants a fresh batch without having forgotten anything) replaces the whole batch the same way. Neither route can ever create a second character or touch stamina/held items/position — confirmed directly by a regression test that decays stamina, resets the password, and asserts the exact same value survives.

**The eating-animation redo, replacing the faceless figure / flat-rectangle plate / plain-box glass from the prior round.** `drawFace` draws eyebrows, eyes, a nose, and a mouth that opens while chewing; `drawPlate` is a real disc (rim, inner well, a soft shadow) that continuously flattens into a near-edge-on sliver as `tilt` rises, which is what "the plate turns to show its underside" actually looks like — a geometry change, never a canvas-wide zoom standing in for rotation; `drawGlass` is a stemmed glass (base, stem, bowl, a liquid level that visibly drains) rotated toward the mouth as it lifts. The full 7-beat sequence (`mealBeats`/`drinkBeats`, pure functions of `eatingPhaseAt`'s own `localProgress`, which keeps the existing pure-function contract `spec/eatingAnimation.test.ts` already pins down untouched): plate+glass down, knife in the character's own left hand and fork in their own right (mirrored on screen, matching a front-facing camera/mirror) → fork lifts one bite to the mouth with visible chewing → utensils set down, the plate itself rises and tilts continuously → held up, food/liquid visibly draining → continuously un-tilts and lowers, empty. A solo meal or solo drink plays only its own half; a combined action plays the meal's full cycle then the drink's. Verified with real Playwright screenshots and raw `getImageData` pixel probes (not just "the canvas is visible") at both 1280×800 and 390×844 — the flat plate with food, the fork-to-mouth reach, the plate mid-tilt showing its edge, the emptied plate lowering back to the table, the tilted glass with draining liquid, and the final upright glass all confirmed as actual rendered geometry at the expected screen coordinates, not assumed from the code.

**The cutscene-doesn't-clear investigation — corrected from an earlier overclaim.** An earlier draft of this entry stated as settled fact that the "stuck" symptom was caused by one reused dev server and was "not a reproducible defect." That conclusion was too strong for the evidence actually in hand: confirming the *server's own* `eating` field flips to `null` exactly at `endsAt` (via a direct `/api/bar/state` probe, no browser involved) proves the server side is correct, but it does **not** by itself prove the client-rendered canvas was never stuck — those are two different claims, and conflating them was the error. What is actually verified, stated separately:
- **Observed symptom** (from the prior session, reported secondhand in that session's own notes, not independently reproduced by a fresh pair of eyes before this correction): the `.eating-cutscene` canvas's `display` style remained `block` after the server's own lock window had passed, across multiple attempts against one dev server that had been reused for roughly 40 minutes of scratch verification.
- **What was actually verified this round**: the server-side lock expiry is correct (confirmed directly, repeatedly). Several clean real-browser runs against *freshly isolated* servers all correctly cleared the canvas. This is consistent with — but does not prove — the "stale reused server" explanation; an equally consistent alternative never ruled out is that the original symptom was itself a one-off artifact of that specific session's test harness (e.g. a stale page left open across a server restart, or a since-superseded version of the drawing code), which this round has no way to re-examine now that the original server and page are gone.
- **The real, independently-confirmed weakness**: regardless of what caused the original symptom, the design had a genuine latent fragility. The lock's expiry writes nothing to the database and bumps no sequence number of its own, so a client only ever learns "it's over" from an opportunistic SSE push or the 10-second fallback poll happening to carry a strictly-newer `seq` — if that transition is ever missed for any reason, nothing else would notice it. This is real and was proven, not assumed: with `EventSource` fully disabled (neutered so it can never deliver a message), the un-patched client would have had no path left to notice expiry at all before the next unrelated mutation.
- **The fix, and exactly what it does and doesn't prove.** `animate()` in `public/tavern.js` now also compares the server's own `eatingUI.endsAt` against a server-clock-corrected local estimate (`serverNow()`, see the clock-skew entry below) each frame; the instant it passes, the client hides the cutscene and fires one deduplicated `fetchAndApply()` to re-confirm with the server — gameplay gating still only ever comes from the server's own `mine.eating`/`isEating`, confirmed directly: a real move attempt during the window right after the client-side hide still correctly returns 409 `eating_active`, so the client never grants itself permission early. With SSE fully disabled, the canvas now correctly clears within ~2 seconds of `endsAt`. This closes the *mechanism* that could cause the originally-reported symptom (a missed push with nothing to fall back on) — it does not retroactively prove what specifically caused that one prior report, which remains unconfirmed.
- **Verified correct, specifically**: the client-side hide never releases the server's own lock early (checked directly against a live move attempt); the one `fetchAndApply()` catch-up fires exactly once per action (deduped by `endsAt`, confirmed by counting actual `/api/bar/state` requests in a real browser — one extra request observed, not a flood); the pre-existing `shouldApplyLiveUpdate` staleness gate (same-epoch lower-seq and older-epoch payloads) still rejects a stale/late snapshot exactly as before, so a late-arriving old payload cannot reopen an already-ended animation; a refresh mid-window still resumes at the correct point and still ends correctly afterward; a second full eat/drink cycle after the first's natural expiry starts and restores stamina correctly (new regression test, `spec/eating.test.ts`).
- **A second, genuinely new bug found by testing the clock-skew angle specifically** (raised as a concern, not assumed harmless): the original fix compared the server's `endsAt` against a bare, unconditional `Date.now()`. A simulated browser clock running 6 seconds fast made the cutscene hide roughly 5 seconds *before* the real server lock ended — confirmed directly, and confirmed that the server's own gating was unaffected throughout (a move attempt during that exact window still correctly returned 409). Fixed with `serverNow()`: a rolling clock-skew estimate taken from the standard HTTP `Date` response header every ordinary bar request already receives (no new endpoint). A **second** issue surfaced while verifying the fix itself: the `Date` header is only second-precision (RFC 7231), which on its own introduced up to roughly 1 second of noise into the estimate even on a correctly-synced clock — measured directly as the cutscene lingering ~130ms past the true end in one real run (1.6% of an 8-second window, cosmetic, but a real, measured regression from the skew fix's first version). Fixed with a 1500ms deadband: an estimated skew smaller than the header's own noise floor is ignored entirely (kept at 0, the original behavior), so the common well-synced-clock case is exactly as tight as before, while a genuinely large skew (the actual bug) is still corrected. Both the 6-second-skew case and the normal-clock case were re-verified after this second fix, directly, with real timestamps compared against real captured canvas states — not assumed from the code.
- **What remains unconfirmed, stated plainly rather than folded into a tidy narrative**: the original report's own root cause. It is plausible it was the reused-server artifact theorized above; it is also plausible it was a version of the client code from earlier in that session that no longer exists to re-test. Both the SSE-missed-push mechanism and (separately) the clock-skew mechanism are now real, closed gaps regardless of which one — if either — actually explains the original report.

**Test-suite resource contention — found, diagnosed, and fixed at the root, not described as someone else's pre-existing noise.** A single `vitest run` reported 466/490 passing, all 24 failures inside the project's own documented "2 shared online Vegas tables across concurrently-run spec files" cluster. Rather than accept that framing on its own precedent, each implicated file was actually read: `spec/tables.test.ts`, `spec/accountGameTakeover.test.ts`, and `spec/accountsHttp.test.ts` all correctly look up a free table dynamically and disband it afterward — but `spec/voice.test.ts`'s one online-table test hardcoded `"vegas-2"` and never disbanded, permanently consuming one of only 2 shared slots for the rest of that process's life, a genuine leak distinct from the "fixed, scarce resource" framing that had covered for it before. Fixed: the test now looks up a free table the same way `spec/tables.test.ts` already does, and disbands at the end. Separately, `spec/settlement.test.ts`/`spec/turn-engine.test.ts`/`spec/fullGame.test.ts` (which use the unbound `/api/rooms` path, not the physical table pool at all) were confirmed to pass 100% in isolation — their occasional timeouts are a different root cause, ordinary HTTP-round-trip wall-clock contention from many spec files' concurrent workers all hitting one single-threaded dev server at once. The real fix for both causes together: `vitest.config.ts` now sets `fileParallelism: false` (see that file's own comment for the full reasoning and the measured cost, ~150s vs ~30-35s) — this removes the cross-file race at its actual root (separate worker processes can no longer contend for the same physical resource at the same wall-clock moment, and the CPU-contention timeouts disappear with it) rather than requiring every current and future spec file to independently coordinate around a resource it may not even know exists. The production table count was never widened, no test was skipped or weakened, and no timeout was loosened to paper over a real problem.

**Full suite, corrected.** `tsc --noEmit` clean throughout. With both fixes above in place, a single, final `vitest run` (plain, no special flags — `fileParallelism: false` is now the project default) against a freshly isolated, PID/`StartTime`-verified server: **490/490 passing**, confirmed not rerun repeatedly afterward hoping for a cleaner number. `pnpm check:evidence` passes.

**Browser acceptance, at both 1920×1080 and 390×844, test accounts only.** Real Playwright sessions confirmed, at both viewports: every password field's eye toggle starts hidden, reveals on click, preserves content and focus, is independent per field, never submits the form, and has a real tappable target (44×42px); the chat bubble and d-pad are both hidden (not merely inert) while the auth dialog is open; registration shows exactly 8 recovery codes in a dedicated one-time screen. A separate, HTTP-level pass (precise, no browser-rendering ambiguity) confirmed the complete reset flow end to end: a wrong code is refused with the identical generic error a nonexistent username gets (no enumeration); a valid code resets the password; the used code and the rest of its original batch are both dead; the old password stops working and the new one logs in; the device that performed the reset gets its own fresh session (itself then correctly revoked by a later login elsewhere, per this app's own existing multi-device policy — not a bug, confirmed by reading `CLAUDE.md`'s own account section before treating it as one); the old device's account cookie **and** its separately-cached bar `session_secret` are both revoked (the "game credentials too," not just the cookie); and the same character (`barPlayerId`) controls the account throughout. The eating-lock-vs-other-games regression (`spec/eating.test.ts`, `spec/domino.test.ts`, `spec/poker.test.ts`, 67 tests) was re-run against this same server and passes. This is Claude's own automated/scripted verification, not the user's own manual acceptance — the user has not yet personally played any of this.

**A compliance slip, disclosed rather than quietly fixed.** While debugging the registration-flow verification script, one intermediate run printed a test account's real 8 recovery codes to this session's own tool output, and one screenshot was taken of the screen displaying them — both violate this round's own explicit "never in logs, reports, or screenshots" instruction. The screenshot was deleted immediately without being viewed; the logging line that caused it was removed before any further run. The account was a disposable test account (`accept...`, this verification run only), not a real player, and nothing leaked into any committed file, the git history, or anything shared with the user beyond that one tool-output message — but the handling itself was wrong, and is recorded here rather than left out of this file's own account of what happened this round.

## Seated-eating corrections — 2026-11 (Codex found/reproduced, Claude fixed)

Codex reviewed the 2026-10-29/30 seated-eating round below and found, then reproduced directly, two real bugs; Claude fixed both and closed a third gap the same review named. All three are now covered by regression tests written before the fix (`spec/ordersHttp.test.ts`, `spec/eating.test.ts`, `spec/db-migration.test.ts`), confirmed to fail against the pre-fix code and pass after.

**1. `POST /api/orders/consume` was a public bypass of the entire feature.** The route handed `src/orders.ts`'s `consumeHeldItem` straight to the internet with no seat or eating-lock check in front of it — `consumeHeldItem` itself was always meant to be gated one level up (by `startEating`), but nothing stopped a standing patron from calling this route directly and restoring stamina instantly, with no seat, no lock, no ~8s animation. Fixed by removing the route outright rather than bolting a second copy of `startEating`'s own check onto it: `POST /api/orders/eat` is now the one and only public way to ever consume a held item. `consumeHeldItem` is unchanged and still exactly what `spec/orders.test.ts` pins down — it's an internal primitive now, with exactly one caller.

**2. A retried `startEating` request, arriving after its own lock naturally expired, could consume a newly-ordered item instead of returning its own original result.** `startEating`'s idempotency check only ever compared a retried key against the LOCK row's own `idempotency_key` column (`bar_eating_actions`, one row per player, overwritten on every new start) — which stops saying anything useful the instant that lock expires. A late or duplicated retry of the FIRST "eat" request, arriving after the 8 seconds had already passed and the player had ordered something new, fell through to the "start a new action" branch and consumed whatever was held *right then*, restarting the clock and misattributing a fresh restore to a stale request. Fixed with a second, durable table (`bar_eating_requests`, one permanent row per `(player_id, idempotency_key)` that ever actually started a real action) checked first and unconditionally, before the lock's own active/expired state is even considered — a key found there always returns its own original `{kinds, startedAt, endsAt}`, regardless of the lock's current state or a process restart in between. See `src/eating.ts`'s own header for the full reasoning.

**3. The eating lock gated new entry points into a game but not an already-bound one.** `createTableRoom`/`joinTableRoom`/`startNpcGame` already refused to *start* a new game while eating, but a second open tab holding a room session for a game this same bar identity was *already* bound to had no eating check of its own — `rooms.roll`/`rooms.place`/`rooms.nextRound`/`rooms.resumeGame` could all still act straight through an active eating lock. Fixed with `rooms.ts`'s own `refuseIfEating` (resolves the acting room `playerId`'s bound bar identity via `bar_players.current_game_player_id`, the same link `src/position.ts` already uses, and checks `isEating`), called from all four. Poker needed no equivalent fix: `bar.ts`'s `sitAtSeat` already refuses to sit down at all while any `poker_members` row is active, so a poker seat and an eating lock can never coexist for the same identity in the first place.

**Animation, separately corrected the same round.** The eating/drinking cutscene (`drawEatingScene`, `public/tavern.js`) used to hold the plate/glass fixed in one screen position for the whole ~8s window, with only the arm pose, a bite-count, and a liquid height snapping between a few discrete values — never an actual pick-up/consume/put-down motion. `eatingPhaseAt` now also returns a continuous `localProgress` (0..1) within each kind's own share, which `drawEatingScene`'s new `liftFactor`/`consumedFactor` helpers use to continuously raise the plate/glass to mouth height, shrink the food/liquid while it's held there, and lower it back down empty — real, continuous motion, not a snap between poses. Verified with real Playwright screenshots and canvas pixel sampling across the window, at both 1920×1080 and 390×844, confirming the plate/glass visibly rises, the food/liquid visibly shrinks, and the scene correctly clears once the server's own lock window ends. `spec/eatingAnimation.test.ts` pins down `eatingPhaseAt`'s own timing contract directly.

**Test-count correction.** The 2026-10-29/30 entry below and PLAN.md's own matching entry state `spec/eating.test.ts` had "16 direct-database tests" and "**405/405 passing**." Re-checked directly against that round's own commit (`7392698`): `spec/eating.test.ts` actually had 14 tests then, not 16 — the "16" was simply wrong, though the arithmetic it fed (391 existing + 14 new = 405) was still correct despite the wrong label. This round adds 13 new tests (7 in `spec/eating.test.ts`, 1 in the new `spec/ordersHttp.test.ts`, 4 in the new `spec/eatingAnimation.test.ts`, 1 in `spec/db-migration.test.ts`): 405 + 13 = **418**, confirmed by an actual `vitest run` against a fresh, isolated database, not computed from memory.

## Book motion correction — 2026-10-29 (Codex)

Opening the closed menu and turning an internal page are distinct operations. Only open() may scale/translate the book from its counter hotspot and unfold the two slots. Navigation must keep the frame fixed and turn one unframed leaf, never clone/rotate the full bordered spread. Do not restore the invisible warm-up flip: it was removed following the student's visible zoom/stop feedback. Position absolute leaves relative to the padding edge (subtract clientLeft/clientTop), preserve page padding on both faces, and reveal the new underlying page at the start of mobile turns. spec/menuBookMotion.test.ts covers motion separation, geometry, reduced motion and closing during a pending open. Earlier warm-up/performance claims remain historical, not current guarantees of smoothness.

## Voice and order review corrections — 2026-10-27

Voice membership is not evidence of working audio. Check real RTCPeerConnections and incoming packet/energy statistics separately from membership tests. Handle play() rejection with a user-gesture Enable sound control and support streamless tracks. Private signals can beat the public roster: refresh and revalidate rather than silently drop them. Serialize signaling, announce receiver readiness, and resend lost offers even when readiness races a pending send. Retry while joined must reuse the microphone, not acquire a second stream. Generated test audio must remain muted unless the user requests an audible test.

SSE cleanup must be idempotent and remove only its own set: abort cleanup can run again after a replacement stream subscribes. spec/subscriptionCleanup.test.ts protects voice, room and private inbox channels. Order keys must bind to the authenticated owner and original item/variant; conflicting reuse must not expose another player's result. See spec/orders.test.ts.

Do not claim complete delivery while requested recipes, seated consumption, in-game stamina or poker NPC standby are absent; docs/review-2026-10-27.md records the current gaps.

## Correction — 2026-10-29: the counter is one physical book, not two HUD buttons

The "Mixology book" and "Front-of-house menu" sections below still describe the pre-2026-10-29 shape (two separate HUD buttons, no link between a menu drink and its real cocktail recipe). That shape is superseded: `public/menuBook.js` is now the counter's single in-scene entry point — a physical, paginated book with three pages (The Mixology Book, Meals, Drinks) opened from one hotspot on the counter, with no "Mixology book" or "Meals/Drinks" HUD button remaining anywhere in `tavern.js`/`app.js`. The standalone `mixology.js` dialog/tests are untouched (`createMixology({el})` still returns `{open, close}` exactly as before); the book adds a non-destructive `embed(container)` that mounts the same instance's pantry/discover/party-list chrome into the book's own page frame instead of a second dialog. `public/orders.js` is no longer a dialog module — it's now a pure server-communication client (`fetchMenu`/`fetchHeld`/`placeOrder`/`consumeHeld`); `menuBook.js` owns all of the Meals/Drinks DOM.

A `MenuItem` whose drink already has a real entry in the Mixology book's own `RECIPES` (currently only Whiskey Sour) declares `mixologyRecipeId` instead of its own `ingredients`/`steps` — the book's `recipeFor()` reads that shared recipe directly, so the two can never disagree about the same cocktail's ratios. Every other item now carries a genuine, referenceable recipe (real ingredients/steps, not one invented sentence) plus a `kcalEstimate` sourced from real USDA FoodData Central per-ingredient figures (`kcalSource`), explicitly separate from and with zero effect on the stamina-restore mechanic below. Every item also carries a real, licensed photo (`image`/`imageAlt`, from `public/assets/menu/`) — provenance for each in `docs/menu-image-sources.md`, including two honestly disclosed imperfect matches rather than silently accepted ones.

This closes the "requested recipes" gap named in the line above. Seated consumption, an overhead held-item indicator, an eating animation, and poker NPC standby remain open — see PLAN.md's 2026-10-29 entry for exactly what was and wasn't done this round.

Rules the agent holds itself to while building this app. See `PLAN.md` for
what's being built and why; this file is the how.

## Mixology book

The counter's recipe assistant is browser-local planning, separate from games and (functionally, not visually — see the 2026-10-29 correction above) the front-of-house ordering module below. Never send pantry/party lists over public SSE or change chips, room state or orders when a recipe is selected. Keep source links and adaptation notes with each recipe. Unmeasured top-ups need visible estimate labels; do not present house quantities as official IBA values. Scale from each recipe's source yield (Cornhusker Crush serves two), sum only compatible units, and exclude optional garnish/ice from required-ingredient matching. Pantry availability must never imply stock quantities. Clipboard/storage failures need honest feedback. The module must participate in the deployed asset hash; modal opening stops held movement and route disposal closes it.

## Stamina

A bar identity's stamina (`src/stamina.ts`, `bar_stamina` table) is server-computed, server-persisted, and read-only to every client — no request body field of any kind, including the appearance-update request, may ever set it directly; only the consume action below and the decay math itself ever change the stored value. It starts at 80% at join, persists across refresh/restart/redeploy/game-switch exactly like every other `bar_players`-linked fact, and decays only for time this specific identity was actually online (presence-derived, via `bar_presence`, never a bare wall-clock diff) — a disconnected stretch, however long, must cost nothing, and a reconnect after a gap must not be charged for the gap itself. One row per bar identity means several open tabs for the same person consume one shared stamina, never a multiple. Clamped to [0, 100] always; a meal adds 70 and a drink adds 30 to the current value, both capped at 100 with nothing banked for later. Stamina has zero effect on any game's rules, rolls, chips, odds, turn legality, or ability to walk anywhere, at any level including zero — a low reading (below 20%) is only ever a dismissable client-side suggestion to eat or drink, never a forced action of any kind.

A compact stamina chip sits in the top HUD beside "Your character," and clicking either opens the same character panel — one combined entry point, never a second place to look. Both the HUD chip and the panel's own larger bar read straight from the public bar-state payload's `stamina` field with no input element of any kind; the character-edit form's existing submit handler is untouched and still only ever sends nickname/colour/skin, so there is no path through that form that could set stamina. The panel's own restore-amount note is informational text, never a control. The low-stamina toast nudge fires once per dip below 20% (tracked client-side, reset once stamina rises back above threshold) and must never recur every tick nor block any action.

## Front-of-house menu: Meals and Drinks

`src/orders.ts` is a virtual, game-internal menu — no balance, no payment, no fictional currency, nothing that could run short. `MENU` is a small, fixed set of meals and drinks; every meal restores +70% stamina and every drink +30%, regardless of its optional preparation `variant` (a steak's doneness, a burger's sauce) — only items that genuinely have a real choice carry a `variants` list, never a meaningless identical dropdown on every dish. A `recipeNote` is in-fiction menu flavour text for a fictional dish, not a real-world recipe — it does not need the Mixology book's real-recipe source-citation requirement above, which governs actual cocktails, not this game menu.

`held_items` lets a bar identity hold **one meal and one drink at once** (checked as "at most one `held`-state row per (player, kind)", never "at most one row total"), each independently ordered and consumed; ordering a second item of a kind already held is refused (`order_active`), not silently replaced. Placing an order (`POST /api/orders/place`) validates the item and, if it has variants, that the submitted one is a real option label for that item — never an arbitrary string, never accepted for an item with no variants — and is idempotent on a client-supplied key, so a doubled click or retried fetch returns the same held row rather than minting a second one. Ordering, previewing a variant, and browsing the menu never touch stamina.

Eating or drinking (`POST /api/orders/consume`) is the *only* place in this entire feature that ever changes `bar_stamina` — it re-reads current stamina, adds the item's restore amount, clamps to 100, and flips the held row to `consumed`, all in one transaction. A second consume attempt against an already-`consumed` row is a no-op returning the same result, not an error — the same idempotency shape as `placeOrder`'s own key check, keyed here by the held item's own row, so a double-click or two tabs racing the same consume can never double-restore. Consuming someone else's held item, or an item that was never held, is refused (404 `not_held`) scoped by the caller's own bar identity.

**Superseded by the 2026-10-29 correction above**: the client menu is no longer its own dialog opened from a separate HUD button. `public/orders.js` is now a pure server-communication module (menu/held fetch, place, consume — no DOM); `public/menuBook.js` renders the Meals/Drinks pages as part of the counter's single physical book, alongside an embedded Mixology book page. Both modules still participate in the deployed asset hash (`src/version.ts`); opening the book still stops held movement the same way every other overlay dialog in `tavern.js` already does.

## Menu expansion: 10 drinks, 6 meals (2026-11-06/07, Claude)

`MENU` grew from 8 to 24 items (+10 drinks: Old Fashioned, Mojito, Margarita, Negroni, Martini, Manhattan, Daiquiri, Gin & Tonic, Moscow Mule, Piña Colada; +6 meals: Fish & Chips, Chicken Parmigiana, Mushroom Risotto, Spaghetti Bolognese, Caesar Salad, Loaded Nachos), checked against both `MENU` and the Mixology book's own `RECIPES` first for duplicates — none existed, so all 16 are net-new. Every `MenuItem` (old and new) now also carries `allergens: readonly string[]` (plain-English common-allergen labels, empty rather than omitted when none apply) and `alcoholic: boolean` — both purely informational, shown on the book's detail page, with zero effect on `restoreAmount` or any stamina math, same as `kcalEstimate` already was.

Nine of the ten new drinks are real IBA-codified cocktails reusing the Mixology book's own `RECIPES` via `mixologyRecipeId` (the same shared-recipe discipline `whiskey-sour` already established) — four of those nine (`old-fashioned`, `dry-martini`, `manhattan`, `pina-colada`) were newly added to `public/mixology.js`'s own `RECIPES` this round, sourced from the same IBA page the menu item cites, so the two can never disagree. The tenth, Gin & Tonic, has no IBA entry (no single body codifies an exact ratio) and keeps its own `ingredients`/`steps`, using the commonly-cited 1:1–1:3 gin:tonic range's own middle (1:2), disclosed as such rather than presented as an official proportion. Caesar Salad and Loaded Nachos each carry a real, order-affecting `variants` list (protein/no-protein; bean/beef), reusing the existing `resolveVariant` validation — not a decorative dropdown.

All 16 new photos are real, licensed Wikimedia Commons images (provenance in `docs/menu-image-sources.md`), fetched via the MediaWiki `imageinfo` API's own pre-sized thumbnail URL (`iiurlwidth`) after an initial full-resolution-pull attempt was rate-limited (HTTP 429) by Wikimedia's own servers — the fix was switching to the thumbnail size Wikimedia's own error message asked for, not a workaround.

See PLAN.md's matching 2026-11-06/07 entry for full verification detail (536/536 tests, two-viewport real-browser Playwright pass covering ordering, variant selection, and seated eat/drink of new items) and a separately-flagged, pre-existing seat-lifecycle finding (a `bar_seats` row left occupied by an abandoned test identity) that this round did not fix, being outside its own stated scope.

## Seated eating and drinking (2026-10-29/30, Claude)

Eating or drinking now requires a real dining/stool seat (`bar_seats` — a
game table's own chair is never one, by construction, so sitting at a
Vegas/poker chair never satisfies this). Standing, a patron may order and
carry a held item around, but `POST /api/orders/eat` refuses with
`not_seated` (409) the instant `bar_seats.occupied_by` for that identity
is empty — checked server-side every time, never only hidden behind a
disabled client button. **Superseded by the 2026-11 correction above:**
`POST /api/orders/consume` is no longer a route at all — it was a public
bypass of this entire seat/lock requirement, found and fixed that round.
`src/orders.ts`'s `consumeHeldItem` function itself is unchanged and
still exactly what `spec/orders.test.ts` pins down; it's an internal
primitive now, not a public entry point. The old standalone "Holding"
page and its own Eat/Drink buttons are removed from `public/menuBook.js`
entirely.

**One server action starts everything held, atomically.** `startEating`
(`src/orders.ts`) consumes every currently-`held` item for that identity
in one transaction (meal first, then drink, if both are held — the
combined sequence), restores stamina for each exactly as `consumeHeldItem`
already did, and writes one lock row (`bar_eating_actions`, `src/eating.ts`)
with `started_at`/`ends_at` (`EATING_DURATION_MS`, 8000ms by default).
Idempotent on a client-supplied key the same shape as `placeOrder`'s own:
a retried start with the same key is a no-op returning the existing
action; a different key while the lock is still active is refused
(`eating_active`, 409). Because the reward is applied the moment the lock
is written — not when the 8 seconds end — there is nothing "pending" for
a crash, a refresh, or a restart to ever lose. **Superseded by the 2026-11
correction above**: that idempotency check originally compared only
against the lock row's own, overwritten-per-start `idempotency_key`
column, which stopped being a meaningful comparison the instant the lock
naturally expired — a real bug, fixed with a second, durable
`bar_eating_requests` table checked first, unconditionally, ahead of the
lock's own active/expired state.

**The lock itself is evaluated lazily, like every other grace period in
this file** — `ends_at > now`, recomputed fresh on every read
(`isEating`/`currentEatingAction`), no sweep, no timer, nothing that can
get stuck. This is what makes a refresh, a dropped connection, or a
server restart mid-animation recover correctly for free: the client's own
`reconcile()` re-derives the cutscene's elapsed progress purely from the
server's `startedAt`/`endsAt` on every snapshot, so a mid-window reload
resumes the correct frame rather than restarting or losing the lock, and
completion never depends on the client reliably sending an "I'm done"
request (there is no such request). `isEating` is the one gate
`bar.ts`'s `moveBar`/`sitAtSeat`/`standFromSeat`, `orders.ts`'s own
`placeOrder`, `tables.ts`'s `createTableRoom`/`joinTableRoom`/
`startNpcGame`/`resumeActiveTable` (checked once, inside the shared
`checkExistingSeat`'s caller, not on the "already have this same seat"
early-return path), and (2026-11 correction) `rooms.ts`'s own
`roll`/`place`/`nextRound`/`resumeGame` all share — none of them
re-derive their own notion of "still eating." That last group closes a
real gap the earlier version of this round missed: the four
join/create/start checks above only ever gated *starting* something new,
never acting on a game this same bar identity was *already* bound to
through a second, still-open room session/tab — `rooms.ts`'s own
`refuseIfEating` resolves the acting room player's bar identity via
`bar_players.current_game_player_id` and checks `isEating` directly.

**Public visibility, kind-only.** `PublicBarPlayer.holding` (`{meal,
drink}` booleans) and `.eating` (`{kinds, startedAt, endsAt} | null`) ride
the existing bar snapshot, computed directly off `held_items`/
`bar_eating_actions` in `src/bar.ts` (not imported from `orders.ts`,
which already imports `bar.ts` for `requireBarSession` — the reverse
import would cycle). Every bystander sees that someone is holding or
eating/drinking something and can render the same overhead prompt/
bystander tag, but never which specific dish — matching the existing
no-private-order-detail rule. The overhead prompt itself
(`public/tavern.js`'s `eat-prompt-target`) is a single DOM button
following this patron's own head position every frame, shown and
clickable only for `mine`; a bystander gets a plain, non-interactive
canvas-drawn tag instead ("Holding" / "Eating" / "Drinking" / "Eating &
drinking"), never a second player's clickable control.

**The ~8-second cutscene is pure client presentation, timed from server
truth.** `drawEatingScene` (`public/tavern.js`) draws a third-person
close-up — the viewer's own clothing colour/skin tone, a dining-table or
counter/back-bar background depending on `seatKind`, a plate/fork or a
glass with a visibly dropping liquid level depending on which kind is
currently playing — on a dedicated full-screen canvas layered above the
whole scene, never baked into or fighting the live map canvas's own
transform/fillStyle state. `eatingPhaseAt(kinds, progress)` is a pure
function splitting the server's own window evenly across one or two
kinds and three sub-stages (lift/active/down) — independently testable,
and the only place "how far through the animation are we" is computed.
`prefers-reduced-motion` keeps the same poses but drops the per-frame
wobble; the server's own duration and restore rules are identical either
way. While `eatingUI` is set, every movement/sit/order/game-join/menu-
book entry point in `tavern.js` is gated the same way the server already
refuses the underlying request — not a global keyboard lock (browser
shortcuts and leaving/closing the page remain unaffected) — and an
existing voice call's microphone/peer state is untouched (this feature
never calls `getUserMedia` or touches `voiceCall.js`).

**A real bug this round caught in its own verification, not assumed
correct from the code alone.** `drawEatingScene`'s own `box()` helper
closes over its `ctx` and takes `(x, y, w, h, colour)` — but it was first
written with the module's *other* `box(c, x, y, w, h, colour)` helper (the
one used for the live map canvas, which does take a context) as the
copied pattern, so every call site passed an extra leading `ctx` argument.
That silently shifted every parameter one slot over: the real x became
the fill colour (coerced to a stray number, defaulting to black), and the
real height argument was dropped entirely — the cutscene displayed
(`display:block`, correct canvas size) but drew nothing recognisable,
confirmed only by instrumenting `fillRect` directly and reading back
actual pixel data, not by trusting that "the overlay appeared" meant the
art was correct. Fixed by dropping the stray argument from every call
site; re-verified by the same pixel-level instrumentation (a real
background colour at a real coordinate) and a real screenshot showing the
seated figure, plate, and glass rendering as designed. **Superseded by
the 2026-11 correction above**: drawing something recognisable at each of
three discrete poses still wasn't the same as the plate/glass actually
moving — that correction made the whole gesture continuous.

## Tavern clock

A real-time Canberra/Sydney wall clock is mounted on the tavern map, drawn per-frame (never baked into the static floor layer, which paints once at load) using `Intl.DateTimeFormat` with an explicit `timeZone: 'Australia/Sydney'` — AEST/AEDT and the real transition dates come from the runtime's own IANA tzdata, never a hand-coded UTC offset. Purely client-side display: no server endpoint, no persistence, since a browser's own system clock is already correct for this and — unlike a dice roll — needs no authority. Its placement must be computed from the real, live furniture layout (`GET /api/bar/layout`'s actual returned coordinates, which apply `CORE_FURNITURE`'s own `+10,+6` export offset) rather than `src/barLayout.ts`'s pre-offset `CORE_FURNITURE` literals read in isolation — conflating the two previously placed the clock far from the counter entirely, caught only by querying the live layout directly and checking real pixel ranges against it, not by eyeballing a screenshot. A digital readout accompanies the analog face specifically for legibility at the 390px breakpoint.

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

**Superseded in part, 2026-11-04**: this is now only true for a *guest*.
A logged-in account (see "Account registration and login" above) recovers
its character on any device via username+password — explicitly with no
email-based recovery of a *forgotten password* itself, which is a real,
stated limitation of this first version, not an oversight. The guest
path above is completely unchanged for anyone who never creates an
account.

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

### The stuck-forever connection bug, and a takeover-detection gap (Claude, 2026-11-05)

`RTCPeerConnection.connectionState` has no guarantee of ever reaching
`"failed"` — reproduced directly with a forced `iceTransportPolicy:
"relay"` + no TURN servers repro that sat at `"new"` for 60+ real
seconds. The prior round's own error-surfacing/bounded-ICE-restart code
only ever reacted to the `"failed"` transition, so a genuinely
unreachable peer (two symmetric NATs, AP-isolated Wi-Fi, no TURN
configured — exactly the shape this app ships with today, since no TURN
secrets exist on production) showed "Connecting audio…" forever with no
error and no retry. Fixed with a bounded connect-timeout watchdog
(`CONNECT_TIMEOUT_MS`, 15s) inside the existing 2-second health-check
loop in `public/voiceCall.js` — a peer stuck off `"connected"` this long
is now treated exactly like a `"failed"` one already was, reusing the
same error text and the same bounded `attemptIceRestart`. This closes
the actual "我们俩互相听不见, 一直 Connecting" failure mode; it does not
and cannot make a connection succeed where no TURN relay exists and both
peers are genuinely unreachable by direct UDP — that's a real,
stated limitation, not something this fix papers over.

Separately: a login-elsewhere takeover (CLAUDE.md's own account section)
already correctly rotates the old tab's room `session_secret`
server-side, but the client's own room heartbeat (`public/app.js`'s
`startHeartbeat`) silently swallowed every error, so the old tab never
*noticed* — its own voice call's mic only stopped as an incidental side
effect of the ~15s presence-staleness window, with no message shown.
Fixed to match `public/tavern.js`'s own bar-heartbeat 403 handling
exactly: a 403 on the room heartbeat now immediately tears down the
voice call and shows a clear "signed in on another device" screen,
cutting detection from ~15s to one heartbeat tick. Fixing this surfaced
a second, narrower bug: a fetch/SSE response already in flight when the
takeover is detected can still resolve directly into the room view's own
`apply()` closure afterward (captured once at `enterRoom`, not reached
through the generation-gated shared pointers `stopLive()` clears) and
silently redraw the normal table over the just-shown terminal screen —
fixed by checking the closure's own captured generation inside `apply()`
itself, the same guard every other stale-response path here already
relies on.

### The real production fault: stale signaling after a fast reconnect (Claude, 2026-11-06)

The prior entry's own stuck-forever fix deployed and was retested on two
real computers; audio still never connected either way, with the
*identical* asymmetric pattern reported before (one side's own mic
working, the other stuck on "Connecting audio…"). The actual root cause
was narrower and different from a missing TURN relay: nothing previously
distinguished a signal belonging to the CURRENT peer-connection
negotiation attempt for a given remote from one belonging to a PREVIOUS,
already-superseded attempt — reproduced directly by forcing two rapid
reconnects where the first negotiation's answer arrives late, after the
second has already started. `signalingState` alone can't tell these
apart (a fresh offer also leaves it at `have-local-offer`), so the stale
answer got applied to the new peer connection anyway: `signalingState`
reaches `stable` (nothing *looks* wrong) but the actual SDP/ICE
credentials now mismatch what was really offered, and media can never
establish — silent, with no error until the previous entry's own 15s
watchdog eventually notices.

Fixed with a per-remote-peer monotonic `attempt` number carried inside
every outgoing offer/answer/ICE-candidate's own `data` payload (never a
sibling field — `src/voice.ts`'s `relaySignal` forwards `data` opaquely
and never reads anything beside it, so no server change was needed or
made). The offerer draws the next number only when it actually sends a
genuinely new offer (not when resending an already-pending one); the
answerer adopts that same number from the offer it's answering, which is
what lets both sides agree on "which round is this" with no coordinator.
A received answer or ICE candidate whose `attempt` doesn't match the
current one for that peer is dropped as stale, never applied — closing
exactly the race this found. `public/voiceCall.js`'s own `peerAttempt`
map comment has the full reasoning; `spec/voiceClient.test.ts` pins the
exact scenario down directly (a stale answer dropped, the real one
applied; a stale ICE candidate dropped after `remoteDescription` has
already landed for a newer attempt). **Superseded in part, 2026-11-06**:
this entry's own "any mismatch is dropped as stale" was itself
incomplete — see the entry below for the real bug that left in, found
from an actual production diagnostics trace.

A "Copy call diagnostics" button (same expanded call panel) was added
alongside this fix — a bounded, privacy-safe per-call negotiation log
(every offer/answer/candidate sent/received/dropped-as-stale, each
tagged with its own `attempt` number and an 8-char truncated peer id,
never raw SDP/IP/a session secret/a full player id) that two people can
paste to compare notes on a real failed call, rather than guessing from
the UI's own summary text alone. Confirmed via two dedicated tests that
the copied text never contains an SDP marker, a bare IPv4 address, or an
un-truncated id.

### An early ICE candidate wrongly treated as stale, found from a real production diagnostics trace (Claude, 2026-11-06)

The prior entry's own "attempt" tagging correctly rejected an answer or
candidate from an OLDER, already-superseded round, but its
`data.attempt !== pc.__attempt` check also rejected a candidate for a
NEWER round whose own offer simply hadn't arrived or been applied yet —
treating "not yet active" the same as "already superseded." This matters
because `onicecandidate` fires its own independent signaling POST as
candidates are gathered, entirely unordered with respect to the offer's
own POST; a candidate for a brand-new round can genuinely reach the
other side first. Reproduced directly (delayed only the offer by 3s
while letting its own candidates go out immediately) and confirmed: the
answerer received four real candidates for the new round, all
permanently discarded as "stale" before that round's own offer ever
landed — exactly the shape of a real pasted production diagnostics trace
from the user's own failed call (`iceConnectionState: checking` forever,
zero candidate pair ever nominated, zero audio packets either
direction). Fixed by distinguishing the two cases in `handleSignal`'s
`ice-candidate` branch and `flushPendingCandidates`: strictly OLDER than
the current attempt is genuinely stale (dropped); anything else (pc not
yet created, its `remoteDescription` not yet set, or a NEWER attempt) is
queued and flushed once that round's own offer actually lands.

Also found and fixed, from the same pasted trace: `onicecandidate`'s own
signaling POST was fire-and-forget (`.catch(() => {})`), so a real
delivery failure (a 409 from `src/voice.ts`'s own `not_in_call` check, a
rate limit, a network error) was indistinguishable from a successful
send — raised directly by an independent review that correctly pointed
out the existing evidence couldn't prove a candidate had actually
reached the other side. Every candidate send is now tracked by its own
`.then`/`.catch`, recording real HTTP status on failure, never assumed
delivered. `public/voiceCall.js`'s new `candidateStats` map keeps a
compact per-(remote, attempt) summary — generated/sent-ok/sent-failed
locally, received/queued/applied/dropped-stale/apply-failed from the
remote — printed as one line per round in "Copy call diagnostics"
instead of a line per candidate, which a real trace across several
reconnect rounds would otherwise bury in noise. `closePeer` now also
carries an explicit reason (`teardown` / `manual-reconnect` /
`reconnect-attempts-exhausted` / `not-in-call-roster`), closing a
related gap the same trace exposed: a peer closing mid-`connecting` with
no prior `failed` event previously gave no way to tell "ICE itself gave
up" from "the server's own call membership no longer lists this
remote."

**A second real mechanism found in the same trace, reproduced directly,
and left unchanged because it is this app's own documented, deliberate
design, not a new bug.** `src/voice.ts`'s `reconcileParticipants` evicts
a joined call participant using the room's ordinary `PRESENCE_STALE_MS`
(15s) "connected" threshold — the exact same signal the room already
uses everywhere else, with no additional grace specific to an active
voice negotiation (CLAUDE.md's own voice-call section already states
this is intentional: "reusing `connected`... is deliberate: no second,
voice-specific liveness signal to keep in sync with the first").
Reproduced directly: blocking one side's ordinary room heartbeat for 17
seconds while its WebRTC link was fully `connected` and healthy still
tore the peer connection down, tagged `reason=not-in-call-roster` in the
new diagnostics — the underlying media link itself never failed at all.
This is a real, concrete explanation for repeated reconnect churn on any
network with occasional brief hiccups (a phone switching networks, a
backgrounded tab's timer throttled), stated here plainly rather than
silently left unexplained, but not something this round changes — it is
the existing, intentional tradeoff this file's own voice-call section
already documents.

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

## Temporary NPC standby: a reversible away-choice, distinct from permanent handoff (2026-10-27)

Vegas online rooms only — never a solo/offline NPC game (`state.solo`),
and refused outright once a seat has already been permanently handed off
(`controller === "npc"`; a stale page can't use this to "take back" such
a seat). `Player.awayMode: "npc" | "self" | null` (`src/types.ts`) is a
player-chosen, reversible status, entirely separate from `controller`'s
own one-way flip: `POST /api/rooms/:code/depart-choice` sets it and
performs the same `room_departures` insert `/depart` already does, in
one transaction (`src/rooms.ts`'s `departChoice`) — this endpoint *is*
the "I'm stepping away" action, not a second thing a client must
separately remember to call. Only `resumeActiveTable`/`resumeGame`
clears it, in the same transaction as the departure rows, never a
passive heartbeat/rejoin (the same "explicit action only" rule the
three-minute departure clock itself already established).

`awayMode === "npc"` makes the scheduler (`scheduleNpcTurnIfNeeded`) and
the engine (`npcRoll`/`npcPlace`) treat this seat exactly like a
permanently-handed-off one for taking its turns — `controller !== "npc"
&& awayMode !== "npc"` is the actual gate everywhere a permanent-handoff
check used to stand alone — while `controller` itself never changes, so
a `self`/`null` resume hands control straight back with nothing to
reverse. `npcRoll`/`npcPlace` re-check `awayMode` fresh at execution
time, inside their own transaction, the same way they already re-check
`controller` — this is what makes a "resume control" click that races an
already-scheduled, not-yet-delivered NPC turn win: by the time the
delayed call actually runs, it sees the cleared value and declines.
`awayMode === "self"` changes nothing about who may act (the ordinary
`roll`/`place` endpoints only ever check `controller`) — it exists
purely to drive the public away-choice display.

The three-minute away-from-table clock is completely unaffected by which
mode was chosen, or whether one was chosen at all: both reuse the exact
same `table_departures`/`room_departures` row and the exact same
expiry sweep already in production, which still ends in the identical
permanent `handoffToNpc` regardless. A true disconnect (no explicit
choice made) cannot show this dialog at all — there's no client left to
show it to — so the existing default (no `awayMode`, seat idles until
the grace sweep hands it off) is preserved unchanged as that fallback.

**A real bug this phase caught in itself**: `POST /api/rooms/:code/resume`
mutates `rooms.state_json` now (clearing a resumed seat's `awayMode`),
but the route previously returned a plain, non-bumping `currentRoomState`
read — the client's own `shouldApplyLiveUpdate` staleness gate then
correctly discarded the stale-looking `rev`, silently losing the exact
update this endpoint exists to deliver (found via direct browser
verification: the UI never flipped back from "Away" after resuming).
Fixed by routing `/resume`'s response through `publishRoomState`, the
same as every other mutating room action already does.

## Poker's away badge: display-only, never bumps the optimistic-concurrency counter (2026-10-27)

`poker_members.away INTEGER NOT NULL DEFAULT 0` (additive migration —
`addColumnIfMissing`, since `poker_members` already exists on any
deployed volume via its own `CREATE TABLE IF NOT EXISTS`; CLAUDE.md's
migration rule applies here exactly as it did for `rooms.closed_at`) is
set by `POST /api/poker/away` for the caller's own seat only
(`membership`/`seated`'s existing ownership check, same as every other
poker action), surfaced in `pokerView`'s per-player `away` field, and
shown as an "Away" badge in the existing `.poker-seat-label`'s own
join-string (`public/poker.js`). This is a pure display flag, unlike
Vegas's `awayMode` above: nothing about `tickPoker`'s own 45-second
action timeout or the disconnect-triggered fold/removal at
`DISCONNECT_GRACE_MS` changes because a seat is marked away, and no
automated standby play exists underneath it. Shown only for `mode ===
'online'` tables (never offline/solo NPC games, where there's no other
human to show a badge to).

**`setPokerAway` deliberately never bumps `poker_rooms.version`** — a
real bug this phase caught in itself, via direct browser verification
rather than assumed from the unit tests alone. `version` is also
`actPoker`'s own optimistic-concurrency counter (its `stale_state`
check), and a presence/display-only change must never race a real
in-flight action over the same counter — the identical mistake this
file's own Vegas `rev`-vs-`version` section above already documents, now
caught for poker specifically. The first version of this phase bumped
`version` anyway "to make the client redraw," which would have made an
unrelated fold/call/raise spuriously rejected as stale by a bystander's
away toggle. The actual fix: the client's own poll loop (`public/
poker.js`) computes a small `awaySignature` (every seated player's id
plus away flag, joined) as a second, independent redraw trigger
alongside `room.version` — polling, not SSE, is poker's own transport,
so there's no stale-arrival-ordering problem a dedicated server-side
counter would need to solve here, only "did anything change since the
last draw," which the signature answers on its own.

Internal leaf turns use orthographic projection (perspective:none on both book ancestors). Perspective is allowed only under .menu-book-opening; reducing its strength still causes visible paper magnification and does not satisfy the user's acceptance criterion.

Turning faces must preserve the destination .book-slot > .book-page hierarchy; never give the rear face a raw page with separately recreated padding. Compensate the measured spine gap in the leaf landing translation. Verify content geometry, not only the outer frame.

Started Vegas rooms must also expire silent human disconnects after the shared three-minute grace, based on room presence (joinedAt fallback), not only explicit departure rows. Reuse exitGame for NPC takeover/last-human closure and binding cleanup. Never count spectators or bar presence as a seated room heartbeat; retain short reconnect grace and exclude NPCs.

## All Fives integration — Codex, 2026-11-04

A domino fixture has four chairs, paired red/blue and green/yellow. Each pair owns an independent Online match; leaving or expiring one must not close the other. Offline matches are private NPC instances. Domino hands and stock order must never enter public bar snapshots: use the authenticated private view, which returns only the viewer's hand. Mutations require membership and the persisted version. Expire the three-minute grace before accepting a renewed heartbeat. NPC decisions use only their own hand and public ends. See ADR-dominoes.md for rules and the merge checklist with Claude's seated-eating branch. This isolated branch has not been deployed.

**Superseded in part, 2026-11-04**: dominoes (commit `7fb090e`) is now deployed to `main`/production — "has not been deployed" above is historical. Seated eating merged separately on `integration/dominoes-eating` and the two were verified to actually interoperate (not just merge without text conflicts): `rooms.startGame` itself needed the same `isEating` guard `roll`/`place`/`nextRound`/`resumeGame` already had — a Codex-found gap, fixed by Claude, see PLAN.md's 2026-11-04 entries. Going forward, any new game-type module (the eventual Blackjack/Texas slots, or a future account system's own game-identity checks) must assume both `isEating` (seated-eating) and the relevant `*_members`-table check (dominoes/poker's own pattern) can independently be true for the same bar identity at once, and must gate against both — `domino.ts`'s own `assertFree` already does this defensively (checking `sqlite_master` for `bar_eating_actions`' existence first, so it works whether or not that table exists yet), which is the pattern a new module should copy rather than assuming merge order.

## Account registration and login (2026-11-04)

A third identity layer above the bar identity (CLAUDE.md's own bar-vs-room separation, extended once more) — `src/accounts.ts`/`src/accountsSchema.ts`, never merged into `bar_players`/`bar_sessions`'s own shape. The only link is `bar_players.account_id` (NULL for a guest, untouched for every bar identity that predates this feature) and `account_characters` (one row per account, the one bar identity it controls, bound exactly once for that account's whole lifetime — "登录已有账号不得覆盖其角色"). A guest's entire existing behavior (join, play, hold items, eat/drink, speak, sit a game seat) is completely unaffected by any of this; nothing about accounts is required to do anything in this app.

**Nickname vs. username.** A bar nickname is a display label, changeable anytime through the existing character-edit form, allows reuse across identities, and is never authentication or identity recovery. A login username is unique (`accounts.username_normalized`, trimmed+lowercased, a real `UNIQUE` constraint — concurrent registration races are resolved by the database itself, never a check-then-insert race in application code), 3–24 characters, and is a completely separate field from nickname at every layer. Renaming never switches which account/character is controlled; logging back in after a rename still resolves the identical character (`spec/accountLifecycle.test.ts`). A username passed to `bar.joinBar` as a brand-new account's *initial* nickname is truncated to `bar.ts`'s own 20-character nickname limit first — a real bug this round found only through actual browser testing: a 21–24 character username (valid for the username field) used to throw `bar.joinBar`'s own, unrelated nickname-length error and fail the entire registration.

**Passwords.** Node's own built-in `scrypt` (no new dependency), N=16384/r=8/p=1, a 16-byte random salt per password, a self-describing encoded hash string (`scrypt:N:r:p:salt:hash`) so a future parameter change can never break verifying an older stored hash. Never plaintext, never a bare unsalted/fast hash. Login and registration failures share one identical generic message/code regardless of which specific thing was wrong (wrong password vs. no such account; username already taken is phrased the same way login failure is) — never enough information for an attacker to enumerate real usernames.

**Sessions and cookies.** The account session token is server-generated random bytes, delivered via an HttpOnly, `SameSite=Lax` cookie (`Secure` gated on `NODE_ENV === "production"`, since Fly's proxy means the app itself only ever sees plain `http` even when deployed — CLAUDE.md's existing fly.toml note) — never localStorage, never a URL parameter, unlike every *other* session_secret in this app (bar/room/poker/domino), which travel as explicit JSON body fields by design and remain completely unchanged by this feature. This is the first automatically-browser-attached credential in the codebase, which is exactly the shape CSRF exploits — `src/accountRoutes.ts`'s own `requireSameOrigin` check exists only for these routes, nowhere else needed it. A session expires server-side after its own 30-day max age (`ACCOUNT_SESSION_MAX_AGE_MS`), evaluated lazily on every read (recomputed fresh, no sweep — the exact pattern this file's own lobby-disconnect-grace section already established), not just via the cookie's own matching `maxAge`, which a browser could choose not to honor.

**Multi-device policy — the user's own explicit product decision.** A new login (or a brand-new no-migration registration, which is a login in every way that matters here) immediately revokes every *other* `account_sessions` row for that account, in the same transaction that creates the new one. Same-browser multiple tabs share one cookie and are therefore never logged out of each other by this; only a genuinely different device/browser triggers a takeover. Critically, this is a *continuation*, not a reset: the new device must be able to keep playing an already-in-progress game's own legal turn, not merely see-and-exit it. The mechanism (`src/accountRoutes.ts`'s `takeOverCharacter`) is deliberately two-tiered, because Vegas/poker/dominoes do **not** share one credential shape (verified by reading each module directly, never assumed to generalize):
- `bar.rotateBarSession` (new) always mints a fresh `bar_sessions.session_secret` and invalidates the old one. This alone is sufficient for poker and dominoes, which authenticate purely through `requireBarSession` with no room-level credential of their own at all.
- `rooms.rotateSession` (new), additionally, only when `tables.activeVegasRoomPlayerId` finds this bar identity currently bound to a Vegas room (lobby or in-progress — `resolveActiveSeat` doesn't distinguish the two, so even a bare unstarted lobby seat's credential rotates). Vegas rooms have their own separate `sessions` table, one `session_secret` per room player, independent of the bar identity's own secret.

This is **not** a relaxation of the existing "never return the server's room secret" rule (`src/tables.ts`'s `exitActiveGame`'s own header) — that rule is about never re-exposing an *old*, already-issued secret through some fallback path. Issuing a brand-new one to an account that `account_characters` already proves controls that identity is the opposite operation, and the rule is satisfied by construction, not bypassed. Voice calls need no separate handling: `src/voice.ts`'s `requirePresentHuman` calls `rooms.requireSeatedHumanPlayer`, the same `sessions` table `rooms.rotateSession` already rotates.

**Explicit logout revokes the same credentials, not just the account cookie.** An earlier version of this round's own logout route only deleted the `account_sessions` row — the browser's own cached bar (and, if actively bound, Vegas room) `session_secret` remained fully valid server-side, so a cached or leaked copy of either could keep acting as that character after the user believed they'd signed out. Fixed to run the identical `bar.rotateBarSession`/`rooms.rotateSession` rotation at logout time too, resolving the account identity from the token *before* deleting it — the freshly-minted secret is simply reported to nobody (logout has no "new device" to hand it to; a future login mints its own).

**Logging out never calls `exitGame`/fold/disband.** An active game seat is left exactly as the existing disconnect-tolerant policy already handles any other disconnect — the same as closing the tab would be. The client confirms before logging out while a game seat is active, purely as a courtesy (CLAUDE.md's own "server check, not a disabled button" principle for destructive actions extended to a confirmation rather than a hard block here, since logout itself does nothing destructive to the seat).

**Guest migration at signup.** An optional checkbox, shown only when the browser already has a guest character, sends that browser's own real `{playerId, sessionSecret}` — verified with the exact same `bar.requireBarSession` check every other bar action already uses, never trusted from the checkbox alone. A guest character already bound to a different account cannot be claimed again (`account_characters.bar_player_id UNIQUE`, correct even under a concurrent-registration race, not an application-level check-then-insert). A brand-new account with the box unchecked (or no prior guest session at all) gets a genuinely new character via the ordinary `bar.joinBar` path — never silently inherits whatever guest session happens to be sitting in the browser's `localStorage`.

**Client-side takeover detection, two tiers.** A dedicated ~15-second poll while otherwise idle, and the existing ~5-second bar heartbeat's own 403 (found to matter directly through browser testing — this was previously silently swallowed by a bare `.catch(()=>{})`, meaning only the slower poll would ever have noticed). Same-browser multi-tab logout sync rides the native `storage` event, which fires in every *other* tab of the same origin when `localStorage.removeItem` runs in one — no polling needed for that specific case.


## Blackjack Online — 2026-11-06 (Codex)

Online uses src/blackjackEngine.ts and persisted blackjack_rooms/members, never the browser’s Offline engine as authority. Authenticate every request with requireBarSession; never serialize the shoe or dealer hole card before reveal. Version-check chip-spending actions; Ready/Unready may share a prior version because they only change the caller’s readiness, still guarded by the betting phase. Timed Stand/insurance decline/dealer steps and three-minute departure expiry are server-owned. Cross-game and dining-seat exclusion applies in both directions. public/blackjack.js belongs in the deployment hash and caching spec. Preserve the accepted Offline NPC pacing and semicircle table. No extra Fly machine, service, dependency, or voice scope was added.

## Community recipes — 2026-11-07 (Codex)

Read `docs/community-recipes.md` before changing publishing/library/image behavior. Keep private drafts separate from published versions; preserve owner-only atomic batch deletion and optimistic revision checks. Saved Recipes follows public posts; Party Plan retains snapshots unless the owner explicitly refreshes them. No automatic migration of browser-local pantry data. Photo decoding must enforce the input/pixel/format limits, strip metadata, and persist to SQLite; do not replace it with public arbitrary file serving or browser-local URLs. Moderator rights come only from server-configured account UUIDs. Hidden recipes cannot be republished around moderation.

The new community component is injected through app.js; leave the menu book's accepted opening/turning/edge-click animations unchanged. Claude's `dd8e33c` menu additions are integrated. Book close now calls embedded teardown to stop polling and retain unsaved draft recovery. Public discovery polls only while its mounted view is active; account replacement clears private state. No deployment is implied by these local checks.
