# Crit 9 reflection

## What was the breakthrough that moved the work forward?

The breakthrough was treating synchronisation as shared behaviour, rather than only faster updates. I wanted a tavern where people could see one another, sit down and choose a game together. My checks exposed misleading table occupancy, characters sharing a tile, and chairs whose clickable positions did not match their appearance. I described those situations to Claude and the agent, including screenshots, instead of accepting passing tests as proof that the experience was right.

I also made the social rules more specific. The first person at an online table is the host and decides who joins; requests do not count as occupied seats. Movement now respects other patrons' positions. After checking the private-chat version, I asked for public speech bubbles above characters because that better fits a shared tavern. These decisions gave the real-time transport something meaningful to communicate.

## What did this work change about who I want to be as a software developer?

I want to be a developer who can make interaction rules explicit and revise them after use. Faster delivery does not resolve who owns a seat, what a returning player should recover, or whether a message is private. I need to decide those things and understand their costs.

I also learned to ask for evidence that survives existing data and interrupted connections. The agent found a legacy-room migration error, restart ordering problems and test assumptions about empty spawn tiles. I distinguish those technical checks from my own observations. I used an agent to help draft this reflection from my feedback and the repository record; I remain responsible for the account and final acceptance.
