# Hold’em tables, identity and admission

Date: 2026-10-22. Implemented by Codex at my request.

## Decision and references

I wanted the drop-in saloon poker experience of Red Dead Redemption 2, with a personal NPC table and a private table for friends. [Rockstar's description](https://www.rockstargames.com/reddeadonline/features/posses-and-free-roam) confirms invitation-only Hold’em tables, but does not specify our stakes. I chose 500 initial play chips. Blinds 1/2, five seats, no ante or rake, optional free 500-chip rebuy when empty, a 45-second turn clock and three-minute disconnect grace are this app's house rules, not claims about Rockstar's exact settings. Offline still needs internet.

The [Hold’em reference](https://www.pokerstars.com/poker/games/texas-holdem/) grounds the streets, blinds and best-five evaluation. The [betting reference](https://www.pokerstars.com/help/articles/poker-rules-master/217444/) grounds heads-up order, side pots, split pots and short-all-in restrictions. Suits do not break equal hands. No original artwork or game code was copied.

## Architecture

Poker is separate from Vegas room JSON, using the existing bar identity and its real secret. Its tables, membership, wallets, invitations, presence and event history live in SQLite on the same volume. Every mutating action and its event are committed together using the existing transaction/logging mechanism. The server shuffles, deals, checks turn/raise rights and settles; expected versions reject duplicate or stale actions. NPCs consider only their own cards and public state.

An authenticated personal POST snapshot, polled about once per second, contains only the caller's hole cards until showdown. It never includes future deck order. No pocket cards travel over public tavern SSE. Poker responses use `private, no-store`. This avoids treating a private poker hand as an ordinary shared room broadcast, at the cost of periodic HTTP requests. The shared tavern's existing diff/SSE loop still carries physical chair occupancy.

An online fixture has one private table. The first occupant hosts it. A seated player can search online nicknames, disambiguate duplicate names by a short identity suffix, and invite a specific identity. The recipient alone can accept/decline within 60 seconds. Invitations do not reserve seats; capacity is checked atomically at acceptance. Mid-hand arrivals wait for the next deal. An occupied table cannot be entered merely by guessing its id. Only the host deals; host authority transfers on exit.

Offline is a personal table with four NPCs. Explicit exit is immediate; a departed non-all-in folds, while an already all-in hand retains its eligibility. Refresh preserves identity, stack and cards rather than quitting. Disconnected membership expires after three minutes. Won/lost chips survive leave/rejoin of the same Online table; a new table starts at 500. Table sessions are not a global currency account. Busted NPCs refill between hands; a human explicitly chooses a play-chip rebuy. There are no payments or redeemable prizes.

## Tradeoffs and limits

This is a cash-table flow, not a tournament or an exact reproduction of RDR2 stakes. The host explicitly deals the next hand so people can inspect results. There is one shared Online Hold’em fixture; multiple private groups cannot use that fixture simultaneously. NPC strategy is deliberately basic. Voice remains the existing Vegas-room feature; this change does not claim to attach that transport to poker's separate identities.

I could have reused the Vegas room/session model, but its fixed roster, dice phases and public snapshots would couple hidden-card security and drop-in membership to unrelated rules. I could also have built another private SSE transport; small authenticated snapshots keep the first implementation simpler but cost polling and may arrive roughly a poll interval after a friend's action. The tests and browser checks in PLAN.md are agent evidence; real friend acceptance remains mine.
