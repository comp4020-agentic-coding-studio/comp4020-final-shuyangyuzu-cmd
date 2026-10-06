# The Amber Room

I am making a small multiplayer tavern where friends can arrive, recognise one another, and choose a table to play together. I started with a browser version of Las Vegas, then realised I wanted the experience around the game as well: entering a warm room, seeing who is there, and deciding where to join. The tavern is the shared meeting place; the game gives people something to do together.

[Enter the tavern](https://comp4020-final-shuyangyuzu-cmd.fly.dev/).

## What good means here

For me, good means that a newly invited friend can understand the space and join a game without someone explaining the interface. They should choose a nickname and character, enter the map, recognise a playable table, and see whether it has room. Returning to the bar should clearly differ from giving up a game seat. Refreshing should preserve their identity rather than turn them into another player.

I also want the room to feel welcoming. Dark wood, warm lighting, recognisable furniture and small characters should make it somewhere to spend time, rather than a form with a decorative picture. My reference is [Gather](https://www.gather.town/): making other people's presence visible through a shared space. I take that spatial idea into a casual game setting. Stardew Valley's interiors and Red Dead Redemption 2's saloons are visual and atmosphere references, not sources of copied assets. The current artwork is drawn in code.

Fairness matters as much as atmosphere. The server must decide turns, rolls, legal placements and payouts. One person's duplicate click must not change the game twice, and two tables must not share a game accidentally. I use the [official Las Vegas rulebook](https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf) as the rules reference. This adaptation currently plays one round, omits the optional neutral dice and displays winnings publicly, unlike the physical game's hidden winnings.

## Try the current version

Choose clothing colour, skin tone and a nickname, then enter. Walk using WASD, arrow keys, clicking the floor, or the on-screen directions; holding a direction continues movement. Click a Vegas table to create or join its room. Invite a friend through the room link. With two to four players, everyone must be ready before the host starts. Roll your remaining dice, choose one face, and place all dice showing it. Equal dice counts cancel at settlement; the remaining players receive bills in descending order.

Use separate browsers, profiles or devices to try different players. Identity is stored in that browser; clearing its storage or switching devices does not recover the same player.

## What I can check, and what I must judge

The HTTP tests cover game actions, readiness, identity checks, table membership, migrations and persistence-related behaviour. Direction-control tests cover release and cancellation. `CLAUDE.md` turns these promises into agent constraints. Whether the room is inviting and its controls understandable needs actual use: I rejected the earlier form-led interface despite passing tests. A physical-phone long-press check remains outstanding.

## Limits and next steps

The Crit 8 version has three Vegas tables and persistent server state. Other named game tables are reserved. Ordering, dining seats and NPC opponents are unfinished. There is no real-money play. Cross-player updates use roughly 1.5-second polling; meeting the final project's approximately one-second requirement is later work. I prefer a usable gathering place with one reliable game over several unfinished games.
