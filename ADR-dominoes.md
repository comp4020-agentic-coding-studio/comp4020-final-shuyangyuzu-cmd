# All Fives — rule and integration decisions

Codex implementation, 2026-11-03. The student selected two-player All Fives and then requested four chairs per physical table, with two independent facing pairs. This work is isolated on `codex/dominoes`, based on main `bd8a289`; Claude's seated-eating branch is not merged or modified.

## Rules

Reference: [MobilityWare's published domino rules](https://mobilityware.helpshift.com/hc/en/58-dominoes/faq/3806-basic-rules/) for double-six setup, turn order, spinner and draw/pass behaviour. This is a documented All Fives variant, not a claim to reproduce every Red Dead Redemption 2 variation.

28 tiles; seven per player; fourteen in the stock. Highest double opens the first round (highest tile otherwise); subsequent opening players alternate. First double is the only spinner. Its extra arms unlock after both main sides are connected. Unused extra arms contribute zero; an exposed double contributes both halves. A positive multiple of five at the open ends is scored immediately. Draw only without a legal move, one tile per action; pass only with empty stock. Two passes block the round. Target: 150. House choices: round bonuses rounded to nearest five; a blocked round awards the difference to the lower hand, ties award zero. The host explicitly starts/deals the next round. Cumulative scores persist.

## Two games per physical table

Red faces blue (pair 1); green faces yellow (pair 2). A partial unique SQLite index allows one live Online room per pair, not one per whole fixture. The host approves the opposite player's request before starting. Pending requests expire after two minutes. Leaving ends only that pair's match; a disconnected/away player has three minutes to return. Reads expire overdue membership before refreshing its heartbeat. Offline games are private player-versus-NPC instances and do not occupy shared public seats.

Private authenticated POST snapshots poll every 600 ms with one in-flight request per client. Game mutations require actual membership and matching persisted version. This avoids leaking hand data through the public bar SSE. Public table state contains only names, chair occupancy and presence. The NPC picks from its own tiles using public end scoring, without consulting opponent tiles or stock order. No voice integration is added this round.

## Merge contract with Claude

Shared integration files are app.js, tavern.js, styles.css, bar.ts, tables.ts, db.ts, server.ts, position.ts and version.ts. Merge deliberately; do not overwrite either branch. New domino schema/engine/service/routes/client/tests are separate files. Entry refuses occupied dining seats and, when the eating schema is present, active eating actions. Existing domino membership blocks movement, sitting elsewhere, Vegas and poker entry. When merging, rerun eating lock tests including domino entry; neither branch is a substitute for the other's verification. Keep menu motion code unchanged.
