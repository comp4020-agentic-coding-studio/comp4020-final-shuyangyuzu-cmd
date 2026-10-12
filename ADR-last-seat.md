# ADR: host-approved admission and the last seat

Status: Accepted, updated for the final Crit 9 implementation.

## Context and what good means

I want friends to recognise a table's status and join without confusing an application to join with a confirmed seat. README also values a welcoming shared room and fair, server-authoritative outcomes. My initial decision record described first-committed joins. I subsequently asked for host approval so people can play with friends and decline strangers. This record supersedes the earlier description for online tavern tables; direct code-based classic rooms retain their separate join flow.

## Decision

The first person to create a room at an empty online table becomes host. Later patrons submit requests with a chosen colour. A request is not a seat, does not increase the seated count, and does not enter turn order. Only the host can approve or decline it while the room is in its lobby.

Approval re-checks capacity and colour availability inside the SQLite transaction that writes the player and event. If two approvals contend for the last seat, the first successful transaction obtains it; the other is rejected. A pending request never guarantees admission. The four-player limit and unique colours remain server rules. Starting requires the seated players to be ready; pending applicants cannot force a start. SSE distributes the resulting state to open sessions without a reload.

Solo NPC tables are a different mode: each visitor starts a private game against three NPCs, with no admission requests. Their private games are not displayed as shared online rooms.

## Alternatives and costs

- Immediate first-come joining is simpler and needs fewer interactions, but lets an uninvited visitor occupy a friend's intended seat.
- An automatic FIFO admission queue makes order explicit, but cannot express the host's preference to play with invited friends. It also requires expiry and offer rules.
- Optimistic client seating feels quick but can falsely show two people owning the same final seat before the server corrects it.

I chose host control with transactional approval. It costs an extra interaction, leaves applicants waiting for the host, and permits arbitrary rejection. It does not establish equal treatment or fairness based on who arrived first. If the host becomes unavailable, recovery and lobby host-transfer rules matter. These are real disadvantages; a public matchmaking app could reasonably choose a queue instead.

## Related choices

Patrons' occupied tiles are also server-validated, so simultaneous movement cannot place two connected people on one tile. Clicking an occupied tile seeks a free neighbouring tile. I replaced proximity private chat with public head-top speech after checking the interface: visible speech better fits the shared space. Its cost is loss of privacy for new utterances and possible visual clutter. Existing private transcripts stay protected; they are never republished.

## Evidence and limits

The approval workflow is recorded in `62a2bbd`; exclusive occupancy in `6b3b71f`; public speech in `73b312f`. Tests exercise approval-time capacity, pending requests, occupancy, speech authentication, idempotency and expiry. PLAN.md separates my feedback from agent browser checks and measurements. The original direct-join latency measurements are historical evidence, not measurements of the newer approval workflow; I do not reuse them as an approval latency claim. The latest CI passed 201 tests, but tests cannot decide whether host control feels welcoming or whether visible speech fits the room.
