# Las Vegas

[Enter the tavern](https://comp4020-final-shuyangyuzu-cmd.fly.dev/) · [Player handbook](https://comp4020-final-shuyangyuzu-cmd.fly.dev/guide.html)

Las Vegas is a small multiplayer tavern for friends who want something to do together, rather than another scrolling feed. People arrive as recognisable characters, choose a game, take a food break, and exchange recipes they can actually make at home. My definition of good is a welcoming shared place where joining, leaving and returning are understandable, and where another person’s actions have visible consequences.

## Why a tavern?

[Gather](https://www.gather.town/) informed the spatial idea: other people are visible in a place instead of reduced to a participant count. Stardew Valley interiors and Red Dead Redemption 2 saloons informed the atmosphere. These are design references, not evidence that my interface is already usable. The wooden furniture and book presentation give familiar objects useful roles: a chair joins a table, the counter book opens food and recipes. My own screenshot feedback repeatedly changed these details when an agent’s technically functioning interface felt wrong.

The alternative was a simpler list of rooms. That would be easier to build and navigate, but would lose the small decisions about where to sit and what friends are doing. The spatial approach costs more: furniture must agree with collision geometry, and a decorative chair must really be clickable. I accept that cost only where it supports shared activity.

## Try it together

Choose Sign up, Log in, or Continue as guest. Accounts use unique usernames; character nicknames can repeat. Save the recovery codes shown at registration. No email recovery is provided. A second-device login replaces the earlier session. Guests remain tied to their browser.

Walk with WASD, arrows, touch controls or a floor click. Vegas requires host approval; Hold’em, Blackjack and facing domino partners use open seating. Card-game arrivals wait until the current hand ends. Leave table gives up membership; Back to the bar marks a reserved seat Away while the character returns to the tavern. The handbook explains grace periods, rules and return controls. Offline tables mean computer opponents; internet is still required.

The counter offers meals and drinks, consumed at dining seats. The Recipe Book supports food and drink publishing, photographs, ingredient search, saved recipes and shopping plans. Accounts retain these across visits. Public recipes are separate from the fixed game menu. Recipe and image credits are in [the source notes](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/blob/main/docs/mixology-sources.md) and [menu image record](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/blob/main/docs/menu-image-sources.md).

## Promises and their limits

Fairness belongs on the server: turns, membership, legal moves and payouts cannot depend on a browser’s claim. The [Las Vegas rulebook](https://www.ravensburger.org/spielanleitungen/ecm/Spielanleitungen/26938_Vegas_EN.pdf) anchors the four-round game; I deliberately randomise the first starter instead of choosing the oldest player. There is no real-money gambling.

SQLite preserves durable state on the deployed volume. SSE and short polling target shared updates within about a second; neither guarantees every network. Tests protect access, game rules, migrations and duplicate actions. [CLAUDE.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/blob/main/CLAUDE.md) records constraints; [ACCEPTANCE.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shuyangyuzu-cmd/blob/main/ACCEPTANCE.md) distinguishes automated checks from human judgement. Readability, atmosphere and animation quality require actual viewing at desktop and phone sizes.

Voice calling was attempted and withdrawn after unreliable real-device results. AI-generated recipes remain outside the delivered scope. More features do not compensate for unclear controls. The final priority is checking these promises, not claiming that passing tests prove a pleasant evening.
