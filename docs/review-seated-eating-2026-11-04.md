# Codex review of Claude seated eating

**Status (2026-11-05): fixed.** The P2 finding below was fixed by Claude in commit `25e8ddc` ("Fix rooms.startGame missing eating-lock guard") — `rooms.startGame` now calls the same `refuseIfEating` guard `roll`/`place`/`nextRound`/`resumeGame` already used, with a regression test reproducing the exact scenario below confirmed failing before the fix and passing after. See PLAN.md's "Claude: fixed the startGame eating-lock gap, merged dominoes + eating on integration/dominoes-eating" entry for the full fix writeup. This file is kept as-is below as the original historical record of what Codex found and reported — not edited to look pre-fixed.

Reviewed commit: 1334a07. Deployed domino baseline: 7fb090e.

## Finding: P2 — an eating host can start a prepared Vegas lobby

Location: src/rooms.ts, startGame (line 1169 in reviewed commit).

Reproduced with a disposable in-memory database using real service functions:
1. Create two bar identities; create/join an Online Vegas room; approve the second player.
2. Set both players ready.
3. Move the host adjacent to a BAR_SEATS fixture, sitAtSeat, order soda, startEating.
4. Call startGame with the host's existing room credentials, as a second tab could.

Observed: `{eating:true,before:"lobby",startResult:"accepted",after:"awaiting_roll"}`.
Expected: eating_active rejection and unchanged lobby state until the eating lock expires.
Recommended fix: apply the same authenticated refuseIfEating guard to startGame and cover this actual lifecycle with a regression. Audit other lobby mutation entry points against the intended no-actions-during-eating rule; do not block disconnect recovery or emergency exit indiscriminately.

## What passed independently
- TypeScript typecheck.
- 37 tests across spec/eating.test.ts, spec/eatingAnimation.test.ts, spec/ordersHttp.test.ts, spec/db-migration.test.ts, maxWorkers=1, fresh DATA_DIR.
- Code review confirmed old consume route removal, durable per-player request results, guards on roll/place/nextRound/resume and continuous plate/glass interpolation.

Not independently repeated: Claude's full 418-test suite or browser pixel/video checks. The animation unit tests cover timing math, not visual quality. No claim of student acceptance.

## Integration status
Read-only merge-tree between 7fb090e and 1334a07 reports documentation conflicts in PLAN.md and PROCESS.md. Source files merge textually; an integrated test run is still required, particularly eating versus domino entry and resumption. No merge or deployment of seated eating was performed by this review.
