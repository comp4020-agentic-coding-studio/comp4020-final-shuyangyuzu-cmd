// The 54-banknote deck, per the official rulebook (see PLAN.md for the
// citation): five each of $90k/$80k/$70k/$60k, six each of
// $50k/$40k/$10k, eight each of $30k/$20k.

const COUNTS: Array<[value: number, count: number]> = [
  [90000, 5],
  [80000, 5],
  [70000, 5],
  [60000, 5],
  [50000, 6],
  [40000, 6],
  [10000, 6],
  [30000, 8],
  [20000, 8],
];

export function freshDeck(): number[] {
  const bills: number[] = [];
  for (const [value, count] of COUNTS) {
    for (let i = 0; i < count; i++) bills.push(value);
  }
  if (bills.length !== 54) throw new Error(`deck composition is wrong: ${bills.length} bills, expected 54`);
  return bills;
}

/** Fisher-Yates, using the supplied RNG so it's reproducible in tests. */
export function shuffle<T>(items: T[], randomInt: (maxExclusive: number) => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Draw from the top of the deck until the casino holds at least
 * $50,000, per setup/restock. Mutates neither argument; returns the
 * drawn bills and the remaining deck. Throws if the deck runs out —
 * with 54 bills and 6 casinos needing >=$50k each (achievable with a
 * single $50k+ bill), this should never happen in practice, but a
 * silent short-deal would be a worse failure than a loud one. */
export function dealToMinimum(
  deck: readonly number[],
  minimum = 50000,
): { drawn: number[]; remaining: number[] } {
  const remaining = deck.slice();
  const drawn: number[] = [];
  let total = 0;
  while (total < minimum) {
    const next = remaining.shift();
    if (next === undefined) {
      throw new Error("deck ran out while dealing a casino to its minimum");
    }
    drawn.push(next);
    total += next;
  }
  return { drawn, remaining };
}
