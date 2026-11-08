# Final acceptance — review candidate, 8 November 2026

Historical detail is preserved in [the pre-review record](docs/archive/ACCEPTANCE-before-final-review.md). That record contains overstatements corrected here. The student has played with friends and repeatedly inspected screenshots/animations; lack of final-version acceptance does **not** mean nobody ever played. edd791f was this feature branch's release, not the project's first authorised deployment.

## Evidence boundaries

Unit/HTTP checks exercise specified mechanisms, not all possible behaviour. Scripted browsers establish the interactions actually observed, not universal usability. Human feedback includes earlier positive judgements and rejections; a repaired defect still requires confirmation on the current build. Passing in isolation does not establish why a full-suite timeout occurred.

## Current baseline

Claude reported successful CI and deployment of edd791f. The recipe extension, image composition, independent page scrolling, away/leave changes and Blackjack header placement are included in its ancestry. Codex's present handbook/documentation candidate has not been deployed. No new human acceptance is claimed here.

| Area | Existing evidence | Remaining final-candidate check |
| --- | --- | --- |
| Four games | Historical friend playtests and Claude's separate-browser scripted checks; user subsequently found leave/away defects | Two independent players: join, act, away, resume, exit; observe the other screen and seat release; test each game's waiting/substitution rules |
| Eating | Human rejection of contact geometry and food returning; regression fixes in 2e5f10a | Watch meal, drink and combined endings; confirm empty plate and restored controls |
| Recipe Book | Scripted upload/save/publish/reopen, units, permissions and mobile composition; human visual feedback | Confirm final drag/zoom, separate scrolling, Food/Drink publish, save, plans and deletion |
| Accounts | Automated signup, recovery, session replacement and ownership checks | Confirm recovery-code handling and takeover on two real devices without recording secrets |
| Persistence | SQLite/migration and restart-related automated checks | Create identifiable test data, return after actual restart/redeploy and verify same data; do not claim this happened from unit tests alone |
| Desktop/mobile | Prior scripted 1920×1080 and 390×844 checks | Final candidate at both sizes; physical phone keyboard/drag/pinch remains separate |
| Voice | Real friend tests failed to achieve reliable audio | Withdrawn; no repair or successful-call acceptance required; entry points stay hidden |
| Handbook | New text-only guide; validation recorded in PLAN | Student review for accuracy and newcomer clarity; video deferred |
| Writing | README/PROCESS condensed; research draft sourced | Student checks first-person claims, reads research sources, revises/approves argument |

## Release gate

- [ ] Student approves current functionality and written claims.
- [ ] Final pnpm check and check:evidence results recorded for the actual release candidate.
- [ ] Main/CI/deployed build agree; /, /readme/ and /guide.html work publicly.
- [ ] No test identities, passwords or recovery codes in tutorial/evidence.
- [ ] Submission sources and links render on GitHub; research note is student-reviewed.
- [ ] Deployment and course /ship authorised and completed separately, without moving historical crit tags accidentally.
