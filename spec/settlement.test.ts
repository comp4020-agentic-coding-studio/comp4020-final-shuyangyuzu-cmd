// Settlement: tie cancellation and descending bill distribution, per the
// official rulebook (PLAN.md has the citation). Dice are server-rolled
// (CLAUDE.md: the client never supplies a result), so this can't pin an
// exact scripted hand through the public API — instead it drives enough
// full random rounds that ties are virtually certain to occur, and checks
// the exact contract against each casino's own recorded placements and
// payout, which the API exposes for precisely this reason.

import { expect, inject, it } from "vitest";
import { createRoom, joinRoom, playFullRound, readyUpAndStart } from "./helpers.ts";
import type { Session } from "./helpers.ts";
import type { PublicCasino, PublicState } from "../src/types.ts";

const baseUrl = inject("baseUrl");

/** Plays one full random round and returns both the final state and each
 * casino's originally-dealt bills, captured right after start (while
 * casino.bills still holds them — settlement clears it to []). Those
 * dealt amounts are legitimately public: CLAUDE.md only hides the
 * *undrawn* deck, not a bill already sitting face-up on a casino. */
async function playOneRandomRound(
  playerCount: 2 | 3 | 4,
): Promise<{ final: PublicState; dealtBillsByCasino: number[][] }> {
  const colors = ["red", "blue", "green", "yellow"] as const;
  const host = await createRoom(baseUrl, "P0", colors[0]);
  const sessions: Record<string, Session> = { [host.playerId]: host };
  for (let i = 1; i < playerCount; i++) {
    const joined = (await joinRoom(baseUrl, host.code, `P${i}`, colors[i])).body as Session;
    sessions[joined.playerId] = joined;
  }
  const started = await readyUpAndStart(baseUrl, host.code, host, Object.values(sessions));
  const dealtBillsByCasino = (started.body as PublicState).casinos.map((c) => c.bills);

  const final = await playFullRound(baseUrl, host.code, sessions);
  return { final, dealtBillsByCasino };
}

/** The ranking half of the official rule, reimplemented here only to
 * check the server's output against — never imported from src/, so this
 * stays a check of the contract rather than a copy of the implementation
 * it's meant to catch bugs in. */
function expectedRanking(placements: Record<string, number>): string[] {
  const byCount = new Map<number, string[]>();
  for (const [playerId, count] of Object.entries(placements)) {
    if (count <= 0) continue;
    const group = byCount.get(count) ?? [];
    group.push(playerId);
    byCount.set(count, group);
  }
  return [...byCount.entries()]
    .sort((a, b) => b[0] - a[0])
    .flatMap(([, group]) => (group.length === 1 ? group : []));
}

function checkCasinoContract(casino: PublicCasino, dealtBills: readonly number[]): { sawTie: boolean } {
  const counts = Object.values(casino.placements).filter((n) => n > 0);
  const sawTie = new Set(counts).size !== counts.length;

  const ranked = expectedRanking(casino.placements);
  const sortedBills = [...dealtBills].sort((a, b) => b - a);
  const payout = casino.payout ?? {};

  // Every tied-out player (anyone with a repeated count) must appear in
  // neither the ranking nor the payout.
  const tiedPlayers = Object.entries(casino.placements)
    .filter(([, count]) => count > 0)
    .filter(([, count]) => counts.filter((c) => c === count).length > 1)
    .map(([playerId]) => playerId);
  for (const playerId of tiedPlayers) {
    expect(payout[playerId], `tied player ${playerId} should not be paid at casino ${casino.value}`).toBeUndefined();
  }

  // The untied are paid in descending rank order, one bill each, until
  // bills run out.
  for (let i = 0; i < ranked.length; i++) {
    if (i < sortedBills.length) {
      expect(payout[ranked[i]], `rank ${i} at casino ${casino.value} should win ${sortedBills[i]}`).toBe(
        sortedBills[i],
      );
    } else {
      expect(payout[ranked[i]], `rank ${i} at casino ${casino.value} should win nothing (no bills left)`).toBeUndefined();
    }
  }

  // Nobody is paid more than once, and nobody outside the ranking is paid.
  expect(Object.keys(payout).length).toBeLessThanOrEqual(ranked.length);

  // No money is invented: every awarded bill was actually dealt to this
  // casino (checked as a multiset, since a casino can hold two bills of
  // the same value).
  const remainingDealt = [...dealtBills];
  for (const amount of Object.values(payout)) {
    const at = remainingDealt.indexOf(amount);
    expect(at, `casino ${casino.value} paid out ${amount}, which wasn't among its dealt bills`).toBeGreaterThanOrEqual(
      0,
    );
    remainingDealt.splice(at, 1);
  }

  return { sawTie };
}

// 24 full rounds, each hundreds of real sequential HTTP round-trips
// (roll+place per turn until every hand is empty), is the slowest thing in
// this suite by a wide margin — investigated directly (not just raising the
// timeout to make a red test green): each of the 24 rounds plays in its own
// room, so they're mutually independent and were only sequential because
// that was the simplest way to write the loop, not because anything here
// requires it. A timing probe against this same running app measured ~2x
// wall-clock reduction from running them concurrently (vs. one at a time),
// which is where the actual cost was — request/await round-trip overhead
// repeated ~300+ times, not server-side work (each transaction is a fast,
// synchronous better-sqlite3 write). The explicit 15s timeout below is sized
// for the realistic worst case even after that fix: this test still shares
// one single-threaded dev server with every other spec file running
// concurrently in the same `pnpm check`/`pnpm test` invocation (vitest runs
// test files in parallel by default), so its own wall-clock varies with
// how busy that shared server is at the time — a contention cost the
// in-isolation timing probe doesn't see, not test-logic flakiness.
it(
  "pays out every casino per the official tie-cancellation and descending-bill rule",
  async () => {
    const playerCounts = Array.from({ length: 24 }, (_, i) => ((i % 3) + 2) as 2 | 3 | 4);
    const rounds = await Promise.all(playerCounts.map((playerCount) => playOneRandomRound(playerCount)));

    let sawAnyTie = false;
    for (const { final, dealtBillsByCasino } of rounds) {
      expect(final.phase).toBe("round_end");
      final.casinos.forEach((casino, index) => {
        const { sawTie } = checkCasinoContract(casino, dealtBillsByCasino[index]);
        sawAnyTie ||= sawTie;
      });
    }

    expect(sawAnyTie, "24 random rounds never produced a single tie at any casino — suspiciously unlikely").toBe(
      true,
    );
  },
  15000,
);
