# Las Vegas

I am making a small multiplayer tavern where friends can arrive, recognise one another, and choose a table to play together. I started with a browser version of Las Vegas, then realised I wanted the experience around the game as well: entering a warm room, seeing who is there, and deciding where to join. The tavern is the shared meeting place; the game gives people something to do together.

[Enter the tavern](https://comp4020-final-shuyangyuzu-cmd.fly.dev/).

## What good means here

For me, good means that a newly invited friend can understand the space and join a game without someone explaining the interface. They should choose a nickname and character, enter the map, recognise a playable table, and see whether it has room. Returning to the bar should clearly differ from giving up a game seat. Refreshing should preserve their identity rather than turn them into another player.

I also want the room to feel welcoming. Dark wood, warm lighting, recognisable furniture and small characters should make it somewhere to spend time, rather than a form with a decorative picture. My reference is [Gather](https://www.gather.town/): making other people's presence visible through a shared space. I take that spatial idea into a casual game setting. Stardew Valley's interiors and Red Dead Redemption 2's saloons are visual and atmosphere references, not sources of copied assets. The current artwork is drawn in code.

Fairness matters as much as atmosphere. The server must decide turns, rolls, legal placements and payouts. One person's duplicate click must not change the game twice, and two tables must not share a game accidentally. I use the [official Las Vegas rulebook](https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf) as the rules reference. Online and Offline now play four rounds. I deliberately chose a random first starter instead of the rulebook's oldest-player rule; the starting marker then moves one seat clockwise each round. Optional neutral dice and Royale modules remain outside scope.

## Try the current version

Choose clothing colour, skin tone and a nickname, then enter. Walk using WASD, arrow keys, clicking the floor, or the on-screen directions; holding a direction continues movement. Click a dining chair or bar stool to walk over and sit; use Stand up to leave. Four dining tables are evenly spaced, and a walkable restroom is at the map edge. Online patrons cannot occupy the same tile.

The nine game tables include two playable online Vegas tables and one playable solo Vegas table; the six other game slots are reserved. Click a game chair to choose its colour, now five per table (a purple fifth joined the original four) to match the official rulebook's own base-game player count. The first player at an empty online table becomes host; later players request admission and the host approves or declines. Pending requests do not occupy seats. Invite a friend through the room link. With two to five seated players, everyone must be ready before the host starts. The solo table lets its starter choose a total player count from two to five (default five: one human and four NPCs) before it starts immediately. Roll your remaining dice, choose one face, and place all dice showing it. Equal dice counts cancel at settlement; the remaining players receive bills in descending order.

After rounds 1–3, the host clicks Start round 2, 3 or 4 on the settlement screen. Dice reset to eight and winnings carry over. Unawarded notes return to the bottom of the same deck; each casino receives at least $50,000 again. You can see your own cumulative bank, while everyone else's stays hidden until the end. Individual round payouts remain visible. After round 4, the screen announces the winner and final standings: most money wins, then most banknotes; an exact tie shares the win.

Use the Say something input and Send to speak publicly. Other people in the tavern see your text in a wrapping bubble over your character for about eight seconds. These new messages are public, not private conversation; previous private-chat records are not broadcast.

Use separate browsers, profiles or devices to try different players. Identity is stored in that browser; clearing its storage or switching devices does not recover the same player.

## What I can check, and what I must judge

The tests cover game actions, readiness, identity checks, table membership, migrations, exclusive tile occupancy, speech validation and expiry, persistence-related behaviour, and server-side action logging. Direction-control tests cover release and cancellation. The current local check passed 245 tests, including complete four-round games for every player count, NPC continuation, private winnings and simultaneous next-round requests. `CLAUDE.md` turns these promises into agent constraints. Whether the room is inviting and its controls understandable needs actual use: I rejected the earlier form-led interface despite passing tests, and later found that painted chairs did not match their clickable tiles. My feedback and the agent's automated checks are separate evidence. A physical-phone long-press check remains outstanding.

For Crit 9, shared positions, presence, table status and game progress travel through server-sent events, targeting updates within about a second without reload. Earlier agent measurements recorded roughly 50–220 ms propagation; these are measurements from the documented runs, not a guarantee for every connection. Restart epochs and per-channel revisions prevent old responses from replacing newer state. I chose host-approved admission so friends can control their table, with transaction-validated capacity rather than optimistic client reservations; [the decision record](ADR-last-seat.md) explains alternatives and costs.

For Crit 10, every player and tavern action a person can take — joining, moving, sitting, speaking, creating or joining a table, approving a request, rolling, placing, leaving, being handed to an NPC — now writes one structured line to the server's own log output, not only to its database, so a presenter can narrate who did what by reading `flyctl logs` alone, without clicking through their own browser. A rejected attempt (a forged session, acting out of turn, a non-host trying to approve or disband) is logged too, tagged separately from a genuine success, and a session secret never appears in any logged line. [`ADR-access-control.md`](ADR-access-control.md) explains how an anonymous browser identity is recognised and recovered, how a tavern character and a game player correlate, and what each player may see or change and why.

## Limits and next steps

Ordering remains unfinished and is not connected to the app. Texas hold'em, dominoes and blackjack remain reserved, and an online host cannot yet add or remove NPC seats before starting. The NPC engine advances while its room has a live subscriber; an unwatched game pauses. There is no real-money play. I prefer a usable gathering place with one reliable game over several unfinished games.

The current online and solo Vegas board presents six connected casino
sectors around a hexagonal dice tray on a wooden tabletop, with actual
bills outside each casino and coloured dice/counts inside. Vegas tables
in the tavern are round with five evenly spaced chairs. Solo NPC rooms
omit invitations; online rooms retain them. Both use the four-round
base-game flow described above.

## Exit and return

Both Online and Offline games offer Exit game during play and after settlement. Offline means a personal game against computer opponents; this website still needs internet access. Exiting ends an Offline game immediately. In an Online game, the departing seat passes to computer control without losing its dice or winnings, and the next human becomes host if needed. The last human's exit closes the room.

Back to the bar reserves the seat for three minutes, including invitations opened without a tavern identity. An explicit return before the deadline cancels the departure; passive heartbeats do not. After three minutes, the same exit policy applies. Expiry is checked on live ticks and on the first request after an idle/restart period. Repeated departure signals do not restart the clock. A scroll beside the game title opens the rules, including the four-round flow, random first starter and the difference from Royale modules.

## Room voice calls

An Online table's lobby and game screen now have a small phone icon in the header. Clicking it when nobody's on a call starts one, asking for microphone access only at that moment; every other currently seated human player then sees a compact "X started a voice call" prompt with Accept and Decline, and only Accept asks that player for their own microphone access. Declining only skips this particular call — anyone can still click the header's own phone icon at any time afterward to join whatever call is currently running. The icon shows how many people are genuinely connected, which includes a muted participant; it never counts someone who's only been invited, and two people starting a call at the same instant land in one shared call, not two. Clicking the icon again while already in a call opens a small panel listing who's there with a mute toggle and a hang-up button; hanging up only removes you, and the call itself only ends once the last person leaves. Leaving the table, exiting, the table closing, or a seat passing to computer control all release the microphone and close the connection automatically. This is Offline-only exclusion in reverse: solo computer games never show the call icon at all. Audio uses a direct peer-to-peer connection between browsers (WebRTC); the server only introduces players to each other and never carries or records the audio itself. A public relay server is configured for ordinary network conditions; without one specifically tuned for stricter networks, a call between two very restrictive networks (e.g. certain mobile carriers or workplace firewalls) may not connect — see PLAN.md for exactly what was and wasn't verified, and the two-device check that's still mine to run myself.
