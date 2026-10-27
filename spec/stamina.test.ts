// src/stamina.ts's decay/restore math, tested directly against a real
// (temp-file) database rather than over HTTP — the contract itself is
// "does bar_stamina end up holding the right number," which synthetic
// timestamps can check far more precisely than waiting out real
// wall-clock hours, the same tradeoff spec/presence.test.ts already
// makes for its own time-based decisions.
//
// Two things are tested separately, matching the module's own split:
//  - recomputeStamina's pure decay math over an interval the caller
//    already knows was continuously online (its own documented
//    contract) — called directly with a single elapsed interval, not
//    simulated through hundreds of individual heartbeats.
//  - recordHeartbeat's gap-vs-continuous branching (src/bar.ts's
//    recordBarHeartbeat's own choke point) — exercised with explicit
//    short (clearly within PRESENCE_STALE_MS) and long (clearly past it)
//    gaps between calls, which is the actual behavior under test here.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { joinBar, barHeartbeat, getPublicBarState } from "../src/bar.ts";
import {
  currentStamina,
  recomputeStamina,
  recordHeartbeat,
  restoreStamina,
  STAMINA_DECAY_PER_HOUR,
  STAMINA_INITIAL,
  STAMINA_MEAL_RESTORE,
  STAMINA_DRINK_RESTORE,
} from "../src/stamina.ts";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-stamina-"));
  db = openDb(join(dir, "app.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// joinBar/initStamina stamp bar_presence/bar_stamina with the real
// wall-clock time internally, so every synthetic "now" used below is
// relative to the real moment each test runs (T0), never a fixed
// historical date.
const T0 = () => new Date();
const hoursAfter = (base: Date, h: number) => new Date(base.getTime() + h * 60 * 60 * 1000);

function rawValue(playerId: string): number {
  return (db.prepare(`SELECT value FROM bar_stamina WHERE player_id = ?`).get(playerId) as { value: number }).value;
}

describe("stamina: initial value", () => {
  it("starts a new identity at 80%", () => {
    const p = joinBar(db, "A", "red", "warm");
    // toBeCloseTo, not toBe: a few real milliseconds elapse between
    // joinBar's own internal `new Date()` and this test's T0() call,
    // which is a real (negligible) decay interval, not a bug.
    expect(currentStamina(db, p.playerId, T0())).toBeCloseTo(STAMINA_INITIAL, 2);
  });
});

describe("recomputeStamina: pure decay math over a known-continuous interval", () => {
  it("decays by STAMINA_DECAY_PER_HOUR per hour, landing just under 20% after 3 hours", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");
    const value = recomputeStamina(db, p.playerId, hoursAfter(start, 3));
    // toBeCloseTo precision 2 (not 5): joinBar's own internal `new
    // Date()` runs a few real milliseconds before `start` above is read,
    // which is itself a real (negligible) decay interval at this rate —
    // precision 5 demands sub-millisecond exactness and was flaky for
    // exactly that reason (same real-jitter cause as the precision-2
    // check already used two tests up).
    expect(value).toBeCloseTo(STAMINA_INITIAL - STAMINA_DECAY_PER_HOUR * 3, 2);
    expect(value).toBeLessThan(20);
    expect(value).toBeGreaterThan(15);
  });

  it("clamps at 0 rather than going negative over a very long interval", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");
    expect(recomputeStamina(db, p.playerId, hoursAfter(start, 10))).toBe(0);
  });

  it("repeated recomputes across the same short interval never multiply decay (one identity, many tabs)", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");
    const target = hoursAfter(start, 1);
    const r1 = recomputeStamina(db, p.playerId, target);
    const r2 = recomputeStamina(db, p.playerId, target); // second "tab" reading/heartbeating at the same instant
    const r3 = recomputeStamina(db, p.playerId, target);
    // r1 vs the nominal hour-of-decay figure: precision 2, same real
    // join-jitter reasoning as above. r2/r3 vs r1 stay at precision 5
    // (really exact) — both are recomputeStamina called again at the
    // identical `target` instant already stored as r1's own
    // last_computed_at, so their own elapsed interval is exactly zero,
    // with no further real-clock reading involved.
    expect(r1).toBeCloseTo(STAMINA_INITIAL - STAMINA_DECAY_PER_HOUR, 2);
    expect(r2).toBeCloseTo(r1, 5); // no further decay — zero elapsed time between r1 and r2
    expect(r3).toBeCloseTo(r1, 5);
  });
});

describe("recordHeartbeat: gap detection charges decay only up to the last known-online instant", () => {
  it("a heartbeat following shortly after the previous one (within PRESENCE_STALE_MS) is treated as continuous online time", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");
    // Within the default 15s PRESENCE_STALE_MS window — reads as still
    // connected, so the elapsed time (1 hour, simulated) is charged as
    // online decay, not skipped as a gap.
    const next = hoursAfter(start, 1);
    db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(
      new Date(next.getTime() - 5000).toISOString(), // 5s before `next`, well within the 15s window
      p.playerId,
    );
    recordHeartbeat(db, p.playerId, next);
    // Precision 2, same real join-jitter reasoning as above: this is a
    // decay interval measured from joinBar's own internal timestamp.
    expect(rawValue(p.playerId)).toBeCloseTo(STAMINA_INITIAL - STAMINA_DECAY_PER_HOUR, 2);
  });

  it("a heartbeat arriving long after the previous one (past PRESENCE_STALE_MS) charges decay only up to the stale last-seen instant, never through the gap", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");

    // Establish "online for 1 hour" first: last_seen_at set right at the
    // 1-hour mark, recordHeartbeat called at that same instant (reads as
    // continuous from join).
    const afterOneHour = hoursAfter(start, 1);
    db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(
      new Date(afterOneHour.getTime() - 1000).toISOString(),
      p.playerId,
    );
    recordHeartbeat(db, p.playerId, afterOneHour);
    const afterOneHourOnline = rawValue(p.playerId);
    // Precision 2 here too (same join-jitter reasoning); afterGap below
    // compares against this already-stored value, not against a fresh
    // real-time computation, so it correctly stays at precision 5.
    expect(afterOneHourOnline).toBeCloseTo(STAMINA_INITIAL - STAMINA_DECAY_PER_HOUR, 2);

    // bar_presence.last_seen_at is left at afterOneHour (stale) — a
    // reconnect heartbeat finally arrives 49 hours later. The gap
    // detector must see the stale last_seen_at relative to `now` and
    // charge nothing for the 49-hour gap.
    const reconnectAt = hoursAfter(start, 50);
    recordHeartbeat(db, p.playerId, reconnectAt);
    const afterGap = rawValue(p.playerId);
    expect(afterGap).toBeCloseTo(afterOneHourOnline, 5);
  });

  it("after a gap, a subsequent continuous online hour decays normally from the post-gap value", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");

    const afterOneHour = hoursAfter(start, 1);
    db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(
      new Date(afterOneHour.getTime() - 1000).toISOString(),
      p.playerId,
    );
    recordHeartbeat(db, p.playerId, afterOneHour);
    const beforeGap = rawValue(p.playerId);

    // Gap, then reconnect at +10h (last_seen_at still stale from +1h).
    const reconnectAt = hoursAfter(start, 10);
    recordHeartbeat(db, p.playerId, reconnectAt);
    expect(rawValue(p.playerId)).toBeCloseTo(beforeGap, 5); // gap cost nothing
    db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(reconnectAt.toISOString(), p.playerId);

    // One more continuous online hour from the reconnect.
    const oneHourLater = hoursAfter(reconnectAt, 1);
    db.prepare(`UPDATE bar_presence SET last_seen_at = ? WHERE player_id = ?`).run(
      new Date(oneHourLater.getTime() - 1000).toISOString(),
      p.playerId,
    );
    recordHeartbeat(db, p.playerId, oneHourLater);
    expect(rawValue(p.playerId)).toBeCloseTo(beforeGap - STAMINA_DECAY_PER_HOUR, 5);
  });
});

describe("stamina: real heartbeats in quick succession (multi-tab) never multiply decay", () => {
  it("several barHeartbeat calls at effectively the same real moment leave stamina essentially unchanged from join", () => {
    const p = joinBar(db, "A", "red", "warm");
    barHeartbeat(db, p.playerId, p.sessionSecret);
    barHeartbeat(db, p.playerId, p.sessionSecret);
    barHeartbeat(db, p.playerId, p.sessionSecret);
    expect(rawValue(p.playerId)).toBeCloseTo(STAMINA_INITIAL, 1);
  });
});

describe("stamina: restore via eating/drinking", () => {
  it("a meal adds +70 to the current value, clamped at 100", () => {
    const p = joinBar(db, "A", "red", "warm");
    const now = T0();
    const before = currentStamina(db, p.playerId, now);
    const after = restoreStamina(db, p.playerId, STAMINA_MEAL_RESTORE, now);
    expect(after).toBeCloseTo(Math.min(100, before + STAMINA_MEAL_RESTORE), 1);
  });

  it("a drink adds +30; stacking a meal and a drink still clamps at 100, never storing extra", () => {
    const p = joinBar(db, "A", "red", "warm");
    const now = T0();
    const afterMeal = restoreStamina(db, p.playerId, STAMINA_MEAL_RESTORE, now); // 80 + 70 -> clamp 100
    expect(afterMeal).toBe(100);
    const afterDrinkToo = restoreStamina(db, p.playerId, STAMINA_DRINK_RESTORE, now); // 100 + 30 -> still 100
    expect(afterDrinkToo).toBe(100);
  });

  it("restoring at full stamina does not bank anything for later — a subsequent continuous online hour decays from 100, not higher", () => {
    const start = T0();
    const p = joinBar(db, "A", "red", "warm");
    restoreStamina(db, p.playerId, STAMINA_MEAL_RESTORE, start);
    restoreStamina(db, p.playerId, STAMINA_DRINK_RESTORE, start);
    expect(rawValue(p.playerId)).toBe(100);

    const oneHourLater = hoursAfter(start, 1);
    const value = recomputeStamina(db, p.playerId, oneHourLater);
    expect(value).toBeCloseTo(100 - STAMINA_DECAY_PER_HOUR, 5);
  });
});

describe("stamina: wired into the existing public bar state", () => {
  it("getPublicBarState reports a connected player's stamina as part of the existing public payload", () => {
    const p = joinBar(db, "A", "red", "warm");
    const state = getPublicBarState(db);
    const me = state.players.find((pl) => pl.id === p.playerId);
    expect(me).toBeDefined();
    expect(typeof me!.stamina).toBe("number");
    expect(me!.stamina).toBeGreaterThanOrEqual(0);
    expect(me!.stamina).toBeLessThanOrEqual(100);
  });
});
