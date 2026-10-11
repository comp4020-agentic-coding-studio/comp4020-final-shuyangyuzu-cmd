// Pure NPC decision logic — no I/O, no RNG of its own (the roll itself
// is still server-rolled via src/rng.ts's systemRng, exactly like a
// human's; this only ever chooses among values ALREADY rolled). Kept
// separate from src/rooms.ts's npcRoll/npcPlace (the DB-transactional
// wrappers) the same way src/game.ts's pure engine is kept separate from
// src/rooms.ts's own transactions — directly unit-testable, and a
// permanent, visible proof this never reads future deck order or bends a
// rule applyPlacement wouldn't already enforce for a human (CLAUDE.md).

/** Which rolled value should an NPC place? The value rolled most often
 * (clears the most dice from hand in one placement — a simple, legible
 * heuristic, not a claim of optimal play); ties broken by the lowest
 * value, for a fully deterministic, testable decision. */
export function chooseNpcPlacement(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
