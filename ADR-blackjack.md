# Blackjack at the saloon table

2026-11-06 — implemented by Codex following the user's acceptance of the Offline UI.

## Rules and presentation

The user requested RDR2-style Blackjack, clarified that this is 21 rather than five-card stud, and accepted the half-round felt: dealer at the straight upper rail, four seats along the lower arc. Two opening player cards are visible; the dealer has one upcard and one hidden card. Players act in seat order, then the dealer reveals and draws. Reference: [RDR2 Blackjack guide](https://www.gtabase.com/red-dead-redemption-2/activities/blackjack). This is an adaptation, not a claim to reproduce RDR2's AI or artwork.

House decisions: 500 play chips, no real stakes; natural 3:2, ordinary wins 1:1, pushes return the wager; dealer stands on all 17s. Equal-value cards may split once, doubling is available on two cards, split aces get one additional card each, split 21 pays ordinary winnings. Insurance is half the opening wager and pays 2:1 on dealer blackjack. Online wagers are even integers so half-wagers and 3:2 payments remain exact whole-chip amounts. NPC styles are deterministic risk thresholds using only their cards and the visible dealer card, not an optimal-strategy claim.

## Authority and privacy

Online uses a crypto-shuffled server shoe and SQLite room state. Transactions serialize joins, readiness, actions and settlement; a room version rejects stale chip-spending requests. Ready/Unready is an independent, non-spending per-player operation guarded by the current phase, so two friends can ready simultaneously. Only the host deals when every active player is ready. Snapshots never include the shoe or hidden dealer card. Every endpoint validates the existing bar session; account credential rotation consequently revokes the old client's game access. No separate account or secret is invented for this game.

Offline retains its accepted browser-local sitting, separate from server chips. Online permits up to four humans and no NPC autofill. Anyone with a free character may join an empty Online chair or a shared room link. A mid-hand arrival waits until the next deal. The single physical fixture holds one Online group at a time.

## Lifecycle and synchronization

Client polling is 750ms; dealer actions are server-paced at 1.1 seconds. A 45-second action timeout stands, or declines unanswered insurance. Back to the bar stops game presence updates and reserves the seat for three minutes; explicit leave releases it immediately, standing committed hands. The host role passes to a remaining player. Settlement removes players with fewer than two chips and displays a notice with a Return to the bar button. The last departure closes the table. State survives restart/redeploy and refresh. Cross-game/dining exclusion is enforced by the server in both directions.

## Evidence and limits

Rule/service tests cover authorization, masking, duplicate/stale actions, simultaneous readiness, seat capacity/exclusion, reconnect persistence, departure expiry, dealer pacing, insurance, split/double, settlement and bankruptcy. Two isolated real Edge browsers exercised the actual UI at desktop/mobile viewports, including synchronized settlement and seat release. This automated evidence is separate from the user's pending Online playtest. Voice remains the existing Vegas feature; Blackjack does not silently acquire microphones or extend voice scope.
