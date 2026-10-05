# Process overview

A factual record of what happened and who did it, kept separate from the
student's own account of decisions and what they learned — that belongs
in the reflection, not here. `PLAN.md` carries the full detail behind
each entry below; this is the index a marker can follow by commit.

## Final-project pivot: Vegas → a shared bar (5–6 October 2026)

**User feedback and plan adjustment.** The student redirected the final
project: the existing Vegas dice game becomes one table inside a shared
virtual bar (Red Dead Redemption 2 saloon atmosphere, a Stardew Valley/
Gather-style spatial interface). A full written proposal — lobby layout,
how identity/physical-table/game-room/seat relate, how an invite link
reaches the right table, a minimal additive data model, and a phased
priority order — was reviewed and approved before any code changed:
[`f981f28`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/commit/f981f28).

**Claude's Phase 1** — bar shell: server-validated grid-tile movement,
a separate bar identity layer, heartbeat presence, an embedded-canvas
scene drawn procedurally (no imported assets). Built, tested (`pnpm
check`), deployed, and re-verified against the live production URL:
[`f428d6a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/commit/f428d6a),
live verification in
[`1edefae`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/commit/1edefae).

**User feedback, round 2.** The student rejected Phase 1's embedded-
canvas, form-led presentation and asked for a full-screen, Gather-like
interface instead: a floating character editor with independently
chosen clothing color and skin tone, a larger map, and a camera that
follows the character.

**Codex's interface rework**, done directly against this repository
(outside this agent session): a full-screen 40×24-tile world with a
following camera; a floating character editor (nickname, clothing
color, skin tone, live sprite preview) gating entry; client-side path
planning for click-to-walk, with every individual tile along that path
still submitted as its own server-validated move (the per-step
adjacency check itself is unchanged from Phase 1); the classic
create/join-by-code form moved to a secondary "Game rooms" overlay
rather than stacked under the map; skin tone persisted through an
additive migration. Reviewed by Claude before committing — re-ran the
full test suite independently (clean `rm -rf data`, 78/78, matching
Codex's own count), read the new client module and test file in full
rather than trusting the count alone, and drove the editor and movement
in a real (automated) browser. No corrections were needed.
[`27713dc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/commit/27713dc)
(its own message records this authorship split in detail).

**User feedback, round 3.** The student asked for continuous movement
while holding a direction button, rather than one step per tap.

**Codex's long-press implementation** — the direction-pad buttons start
stepping on press and repeat until release; pointer-up anywhere,
pointer-cancel, pointer-leave, window blur, and the document going
hidden (tab/app switch) all stop it; a plain tap still takes one step.
Verified with automated event-simulation tests
(`spec/direction-hold.test.ts`) and, separately, an automated-browser
drive that held the button for about a second and watched the character
move several tiles before releasing. **Neither of those is a physical
touchscreen test, and neither is reported as one** — that check is still
outstanding. Part of the same
[`27713dc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/commit/27713dc).

**What's next**, continuing in this same repository: binding each
physical Vegas table to its own independent game room (Phase 2), a
counter menu with persisted, duplicate-proof ordering (Phase 3), and
seating with server-arbitrated occupancy (Phase 4) — see `PLAN.md` for
what's actually built and verified as each one lands, and this file for
further entries as they do.
