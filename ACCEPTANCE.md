# Final acceptance checklist — 2026-11-08

This records, for each area the user asked to review before acceptance, what has actually been verified and by what means — and states plainly where that verification stops short of a real human playtest. "Tests passed" and "a scripted browser agent clicked through it" are not the same thing as "a person played this and accepted it"; this document does not conflate them. Dates and round names reference the matching entries in `CLAUDE.md` and `PLAN.md`, which carry the full detail — this is the summary, not a replacement.

## How to read the verification column

- **Unit/HTTP suite** — `vitest run`, exercises server logic and HTTP routes directly. Proves the underlying mechanism is correct; proves nothing about what a browser actually renders or whether a human finds it usable.
- **Scripted browser (agent)** — a Playwright session driven by Claude, including real pointer/click/drag events where noted. Proves the UI actually renders and responds as coded, at the specific scenarios scripted. Still not a human's own judgement, and only as thorough as the script — three rounds in this project have each found real bugs that an earlier round's own more superficial check (e.g. HTTP-only, or a bare `.click()` instead of a real pointer event) had missed.
- **Human acceptance** — the user personally played or reviewed it and said so. This is the only category that counts as "accepted."

## 1. The four online games (Vegas, Texas Hold'em, Blackjack, Dominoes)

**Built:** open seating for Blackjack/Dominoes/Hold'em (Vegas keeps host-approval, unchanged); an explicit, reversible away-toggle plus a waitlist-notify mechanism for all four; Dominoes' "substitute scenario" (a seat survives an opponent leaving, a new partner can sit down); exit vs. away made genuinely distinct for all four games, each independently confirmed.

**Last touched:** 2026-11-08, three consecutive rounds on the same day (open-seating → exit-vs-away correction → two-browser click-through verification).

**Verified:** Scripted browser (agent) — the final round of the three was explicitly driven by **real UI clicks in two separate Playwright browser contexts per game** (not API calls standing in for clicks), 34/34 checks passed across all four games. Full suite 559/559 at that point, `tsc`/`check:evidence` clean.

**Known gap:** Every one of the three rounds ends with some form of "this is Claude's own scripted verification; the user has not yet personally played this round." **No human multiplayer acceptance is recorded for any of the four games.** Worth noting: the two-browser pass is what *found* a real bug (Blackjack's away flag not reaching a second browser) that an earlier, HTTP-only "23/23 passed" claim had missed — a good argument for why a human's own two-device session is worth doing before calling this done, not just repeating another scripted pass.

**Not yet checked at all:** a genuine two-human playtest (two separate people, two separate real devices/networks) of any of the four games end to end — join, play a few actions, leave, rejoin.

## 2. Accounts — registration, login, logout, multi-device takeover, recovery-code reset

**Built:** scrypt-hashed passwords, dual-layer session takeover (bar identity's own secret *and* an active Vegas room's own secret both rotate on a new login), an 8-code recovery-code reset flow, a live username-availability check, a guest-migration checkbox at signup.

**Last touched:** 2026-11-04 (core build), 2026-11-05 (password show/hide UX + recovery codes), 2026-11-07 (live username check + a distinct duplicate-username message).

**Verified:** Scripted browser (agent) + direct HTTP. The 2026-11-05 round explicitly verified the complete reset flow end to end at HTTP level (wrong code rejected with the same generic message a bad username gets; valid code resets the password; the old password stops working; the old device's cookie *and* its cached bar session secret are both revoked; a new session is issued) plus password-field show/hide and the recovery-code screen via Playwright at both viewports.

**Known gap:** That round's own words: **"This is Claude's own automated/scripted verification, not the user's own manual acceptance — the user has not yet personally played any of this."** No forgotten-*username* recovery exists (a stated, deliberate limitation, not a gap to close). No human acceptance recorded for the account system at any point.

## 3. Eating/drinking animation and stamina

**Built:** server-authoritative stamina (decays only while actually online, +70%/+30% restore, capped at 100, zero effect on any game rule); a continuous plate/glass lift-tilt-drain cutscene; a clock-skew-robust fix so the cutscene's own end-of-window timing can't flicker or replay itself.

**Last touched:** 2026-11-07/08 (clock-skew-monotonicity fix, most recent); the animation's own geometry was last substantively rebuilt 2026-11-05.

**Verified:** Scripted browser (agent), pixel-level canvas probes, plus one documented **human rejection**.

**This is the one area with a real, recorded human-acceptance event — and it was a rejection.** The 2026-11-05 round states directly: *"The user's own real-browser manual playtest rejected the eating-animation round above outright"* — citing specific, concrete complaints (the glass reaching the eyes instead of the mouth, a floating utensil, an empty plate left hanging in the air). The round was then re-fixed and re-verified, but **only by the agent's own scripted Playwright/pixel checks afterward — there is no record of the user re-playing it and confirming the fix actually addressed what they rejected.** This is the single highest-priority item for a real human replay, precisely because it's the one place a human already found something an agent's own checks had missed and signed off as working.

## 4. The Recipe Book — publish → discover/filter → view → save → party-plan → edit/delete, plus this round's own fixes

**Built:** Drink/Food kind expansion (filtering, kind-specific fields, backward-compatible defaulting of old data), a two-page book-style detail redesign, and — this session — a real persisted photo drag/zoom composer (replacing a container-resize-only control) and independent left/right-page scrolling on desktop.

**Last touched:** 2026-11-08, three consecutive rounds today: the Drink/Food expansion, the acceptance-review fixes (photo composer + independent scrolling) on top of it, and a further mobile-specific fix (the photo-adjust button row was covering almost the entire photo at narrow widths, confirmed by browser verification and fixed by moving the controls into their own row below the photo rather than overlaid on it).

**Verified:** Scripted browser (agent), at both 1920×1080 and 390×844, across all three rounds — registration, publishing both kinds, kind/alcohol filtering, the two-page detail view, save/party-plan, edit→preview→publish→Discover, delete, full two-account data isolation, drag/zoom/reset with real pointer events, save→reopen→publish→view composition persistence, independent left/right scrolling with the photo provably stationary while the other page scrolls, zero spurious page-turns from any drag/scroll gesture.

**Known gap, stated plainly:** Two real interaction bugs were found by agent browser verification and fixed *before* this went to the user at all (a pointer-capture bug swallowing clicks on the zoom buttons; the mobile button-row-over-photo layout bug) — a genuinely good sign that the scripted verification is catching real things, but also a reminder that **zero human acceptance is recorded for the Recipe Book at any point in its history**, despite being the single feature with the highest bug-count-per-verification-pass of anything in this project. This is the second-highest-priority item for a real human replay, specifically on a real phone (not just a resized desktop browser window) for the mobile photo-drag fix, since touch-event behavior on simulated viewports doesn't always match a genuine touchscreen.

## 5. Persistence across sessions and a server restart

**Built:** every piece of state (accounts, bar identity, stamina, held items, game rooms, recipes, images) lives in SQLite; schema changes use `addColumnIfMissing` rather than a wider `CREATE TABLE`, specifically because the latter silently does nothing to an already-existing production table; the live-sync transport has an explicit `SERVER_EPOCH` mechanism built specifically so a client survives a server process restart without getting stuck rejecting every payload as "not newer."

**Verified:** Unit suite, and this is the most rigorously covered area in the project. `spec/db-migration.test.ts` builds an **actual pre-existing-schema SQLite database by hand** for every schema change made since the project started, and asserts the new code opens it, migrates it, and preserves every existing row correctly — not just that a *fresh* database works, which would prove nothing about the real deployed volume. The epoch-restart mechanism itself was built in response to an independent review that *found and reproduced* a real bug (a restarted process's own live-sync responses being wrongly rejected as stale) before being fixed.

**Known gap:** All of this verification is against a **locally reopened SQLite file**, proving the migration and epoch logic is correct — it is not the same as an actual `flyctl machines restart` against the live production volume, which has not been recorded as tested. If "survives a restart" needs to mean "survives a real production redeploy," that specific check has not been done.

## 6. Both viewports (1920×1080 and 390×844)

**Verified:** this is the single most consistently covered dimension across every round referenced above — nearly every feature change in the last month has a dedicated Playwright pass at both sizes, and this discipline has genuinely caught real mobile-only bugs before: a Contents page that was built into the DOM but never actually visible below 820px (2026-11-07/08), and this session's own photo-composer button-row bug.

**Known gap:** this is still an agent driving a resized headless browser window, not a human's own physical phone. Touch-specific behavior (real multi-touch pinch, real on-screen keyboard interaction with a form, real network latency on a mobile connection) is approximated, not identical to the real thing.

## Priority order for the user's own acceptance pass

Based on where an agent's own scripted checks have already found real problems humans would likely notice differently (or where a human already rejected something once), in rough priority order:

1. **The eating/drinking animation** — the one area with a recorded human rejection and no recorded human re-acceptance of the fix.
2. **The Recipe Book**, especially the photo drag/zoom on a real phone — the highest bug-count-per-pass feature, and the newest fix (mobile button-row overlap) has only been checked by agent automation so far, never a real touchscreen.
3. **A real two-person, two-device session** of at least one online game (Vegas is the most mature; Dominoes/Blackjack/Hold'em are newer) — no game has ever had a genuine two-human playtest recorded.
4. **Account takeover** on two real separate devices (e.g. a phone and a laptop) — the logic is HTTP/Playwright-verified but a real multi-device session has not been recorded.
5. Everything else, as time allows — the regression suite (562/562 as of this session) and repeated scripted browser passes give reasonable confidence, but every item above is still, honestly, awaiting the one kind of verification that actually counts as acceptance.

## What this document is not

This is not a claim that anything listed above is broken — the scripted verification described for each area is real, specific, and in most cases caught and fixed genuine bugs before reaching this document. It is a plain statement of *what kind* of verification each area has actually received, so that "the tests pass" is never quietly read as "the user accepted it."
