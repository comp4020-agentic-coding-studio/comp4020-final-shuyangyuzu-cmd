// Server-authoritative randomness (CLAUDE.md: the client never generates a
// result and sends it up to be recorded). Swappable for a seeded RNG in
// tests that need reproducible rolls/shuffles.

import { randomInt as cryptoRandomInt } from "node:crypto";

export interface Rng {
  /** A uniform integer in [0, maxExclusive). */
  randomInt(maxExclusive: number): number;
}

export const systemRng: Rng = {
  randomInt: (maxExclusive: number) => cryptoRandomInt(maxExclusive),
};

export function rollDice(count: number, rng: Rng): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(rng.randomInt(6) + 1);
  return values;
}

/** A small deterministic RNG (mulberry32) for tests that need the same
 * "random" sequence every run — never used outside spec/. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    randomInt(maxExclusive: number): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const frac = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(frac * maxExclusive);
    },
  };
}
