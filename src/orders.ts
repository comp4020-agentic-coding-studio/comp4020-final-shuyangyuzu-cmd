// The counter's front-of-house menu: Meals and Drinks, held and then
// consumed to restore stamina. Virtual only — no balance, no payment, no
// way to run short (CLAUDE.md), and no interaction with chips, Vegas
// winnings, or room state of any kind.
//
// Replaces the earlier single-active-order design entirely (fixed-price
// items, exactly one active order at a time, no stamina concept) rather
// than extending it: that shape could not represent "hold a meal and a
// drink at once," had no notion of a restore amount, and had no concept
// of a preparation-method choice. The new `held_items` table (src/db.ts)
// lets a patron hold at most one meal and one drink simultaneously, each
// consumed independently and exactly once.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { logAction, markIdentityVerified, transact } from "./actionLog.ts";
import { requireBarSession } from "./bar.ts";
import { restoreStamina, STAMINA_MEAL_RESTORE, STAMINA_DRINK_RESTORE } from "./stamina.ts";

export class OrderError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type MenuKind = "meal" | "drink";

export interface MenuVariant {
  group: string;
  label: string;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  kind: MenuKind;
  restoreAmount: number;
  /** Only present for an item that genuinely has a real choice (e.g. a
   * steak's doneness, a burger's sauce) — most items have none, and the
   * client must never offer a meaningless identical dropdown on every
   * dish (the user's own explicit instruction). */
  variants?: readonly MenuVariant[];
  /** Short in-fiction flavour text for "how this is prepared" — menu
   * copy, not a real-world recipe. This is a fictional in-game dish
   * description; it does not need the Mixology book's real-recipe
   * citation requirement, which governs actual cocktails elsewhere in
   * this app, not a game menu's invented food descriptions. */
  recipeNote: string;
}

// A small, complete first set — not padded with placeholders. At least
// one meal has a genuine doneness choice and one has a genuine sauce
// choice, so the variant-selection UI has real cases to prove out.
export const MENU: readonly MenuItem[] = [
  {
    id: "grilled-trout",
    name: "Grilled Trout",
    description: "Pan-seared with lemon butter, a saloon classic.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Whole trout, pan-seared in butter with lemon and herbs, served with roasted potatoes.",
  },
  {
    id: "house-steak",
    name: "House Steak",
    description: "Choose how you'd like it cooked.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    variants: [
      { group: "doneness", label: "Rare" },
      { group: "doneness", label: "Medium" },
      { group: "doneness", label: "Well done" },
    ],
    recipeNote: "A thick-cut sirloin, seared to order over the counter's own wood-fired grill.",
  },
  {
    id: "saloon-burger",
    name: "Saloon Burger",
    description: "Pick your sauce.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    variants: [
      { group: "sauce", label: "House BBQ" },
      { group: "sauce", label: "Spicy mustard" },
      { group: "sauce", label: "Plain" },
    ],
    recipeNote: "Beef patty, melted cheddar, pickles, on a toasted bun.",
  },
  {
    id: "bean-chili",
    name: "Bean Chili",
    description: "A hearty bowl, served hot.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Slow-simmered beans and beef in a smoky chili broth, cornbread on the side.",
  },
  {
    id: "soda",
    name: "Soda",
    description: "Cold and fizzy.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Poured straight from the fountain, over ice.",
  },
  {
    id: "coffee",
    name: "Black Coffee",
    description: "Hot off the stove.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Fresh-brewed, served black — cream and sugar on the side.",
  },
  {
    id: "house-lager",
    name: "House Lager",
    description: "On tap.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "A crisp lager, drawn fresh from the counter's own tap.",
  },
  {
    id: "whiskey-sour",
    name: "Whiskey Sour",
    description: "A saloon standard.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Whiskey, lemon, a touch of sugar, shaken over ice.",
  },
];

function menuItem(itemId: string): MenuItem {
  const item = MENU.find((m) => m.id === itemId);
  if (!item) throw new OrderError("not on the menu", "bad_item", 400);
  return item;
}

/** Validates a submitted variant against the item's own real option
 * labels for the correct group — never an arbitrary string, and never
 * accepted for an item that has no variants at all. */
function resolveVariant(item: MenuItem, variant: string | null): string | null {
  if (!item.variants || item.variants.length === 0) {
    if (variant) throw new OrderError("this item has no preparation choice", "bad_variant", 400);
    return null;
  }
  const match = item.variants.find((v) => v.label === variant);
  if (!match) throw new OrderError("choose a real preparation option", "bad_variant", 400);
  return match.label;
}

export interface MenuPreview {
  item: MenuItem;
  variant: string | null;
}

/** Pure menu-data lookup — no server mutation, no stamina change, same
 * as browsing/filtering the Mixology book doesn't touch any server
 * state. Lets the client show "Grilled Trout" or "House Steak, medium"
 * before the player actually commits to ordering it. */
export function previewOrder(itemId: string, variant: string | null): MenuPreview {
  const item = menuItem(itemId);
  return { item, variant: resolveVariant(item, variant) };
}

export interface HeldItem {
  id: string;
  kind: MenuKind;
  itemId: string;
  itemName: string;
  variant: string | null;
  restoreAmount: number;
  state: "held" | "consumed";
}

interface HeldItemRow {
  id: string;
  kind: string;
  item_id: string;
  variant: string | null;
  state: string;
}

function toHeldItem(row: HeldItemRow): HeldItem {
  const item = MENU.find((m) => m.id === row.item_id);
  return {
    id: row.id,
    kind: row.kind as MenuKind,
    itemId: row.item_id,
    itemName: item?.name ?? row.item_id,
    variant: row.variant,
    restoreAmount: item?.restoreAmount ?? 0,
    state: row.state as "held" | "consumed",
  };
}

/** Everything this identity currently holds (held or already consumed,
 * so the client can show "you already ate this" rather than it simply
 * vanishing) — scoped to this single bar identity's own rows only. */
export function getHeldItems(db: Database.Database, barPlayerId: string): HeldItem[] {
  const rows = db
    .prepare(`SELECT id, kind, item_id, variant, state FROM held_items WHERE player_id = ? ORDER BY created_at DESC`)
    .all(barPlayerId) as HeldItemRow[];
  return rows.map(toHeldItem);
}

/** Places an order: one meal and one drink can be held at once (checked
 * as "at most one `held`-state row per (player, kind)," never "at most
 * one row total" — this directly replaces the old single-active-order
 * constraint). A duplicate confirm click — the same idempotency key
 * arriving twice — returns the item already placed rather than erroring
 * or minting a second one, same shape as the old file's own dedup, now
 * also protecting the consume action below. Never touches stamina:
 * ordering, browsing the recipe note, and switching categories are all
 * read-only with respect to stamina — only consume (below) restores it. */
export function placeOrder(
  db: Database.Database,
  barPlayerId: string,
  barSessionSecret: string,
  itemId: string,
  variant: string | null,
  idempotencyKey: string,
): HeldItem {
  requireBarSession(db, barPlayerId, barSessionSecret);
  const item = menuItem(itemId);
  const resolvedVariant = resolveVariant(item, variant);
  if (!idempotencyKey) throw new OrderError("missing idempotency key", "bad_request", 400);

  return transact(db, () => {
    const existingByKey = db
      .prepare(`SELECT id, player_id, kind, item_id, variant, state FROM held_items WHERE idempotency_key = ?`)
      .get(idempotencyKey) as (HeldItemRow & {player_id:string}) | undefined;
    if (existingByKey) {
      if(existingByKey.player_id!==barPlayerId||existingByKey.item_id!==item.id||existingByKey.variant!==resolvedVariant){
        throw new OrderError('That order key is already in use. Please make a new order.','idempotency_conflict',409);
      }
      return toHeldItem(existingByKey);
    }

    const active = db
      .prepare(`SELECT 1 FROM held_items WHERE player_id = ? AND kind = ? AND state = 'held'`)
      .get(barPlayerId, item.kind);
    if (active) {
      throw new OrderError(
        `you're already holding a ${item.kind} — finish it first`,
        "order_active",
        409,
      );
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO held_items (id, player_id, kind, item_id, variant, state, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'held', ?, ?)`,
    ).run(id, barPlayerId, item.kind, item.id, resolvedVariant, idempotencyKey, new Date().toISOString());

    logAction(db, {
      action: "place_order",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId },
      detail: { item: item.id, kind: item.kind, variant: resolvedVariant ?? "" },
    });

    return { id, kind: item.kind, itemId: item.id, itemName: item.name, variant: resolvedVariant, restoreAmount: item.restoreAmount, state: "held" };
  });
}

/** Eats or drinks a held item — the only action in this entire module
 * that ever restores stamina, and the only place "held" flips to
 * "consumed." A second consume attempt against an already-consumed row
 * is a no-op returning the same result, not an error: this is what
 * makes a double-click, a retried fetch, or two tabs racing the same
 * consume unable to double-restore, the same idempotency shape
 * `placeOrder`'s own key check already uses, keyed here by the held
 * item's own row instead. */
export function consumeHeldItem(
  db: Database.Database,
  barPlayerId: string,
  barSessionSecret: string,
  heldItemId: string,
): HeldItem {
  requireBarSession(db, barPlayerId, barSessionSecret);

  return transact(db, () => {
    const row = db
      .prepare(`SELECT id, kind, item_id, variant, state FROM held_items WHERE id = ? AND player_id = ?`)
      .get(heldItemId, barPlayerId) as HeldItemRow | undefined;
    if (!row) throw new OrderError("you aren't holding that item", "not_held", 404);

    if (row.state === "consumed") {
      // Already consumed — a harmless re-send of the same request,
      // never a second restore. markIdentityVerified already ran via
      // requireBarSession above, so this is logged as a genuine,
      // verified no-op rather than a rejection.
      return toHeldItem(row);
    }

    const item = MENU.find((m) => m.id === row.item_id);
    const restoreAmount = item?.restoreAmount ?? 0;
    restoreStamina(db, barPlayerId, restoreAmount);
    db.prepare(`UPDATE held_items SET state = 'consumed', consumed_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      heldItemId,
    );

    logAction(db, {
      action: "consume_item",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId },
      detail: { item: row.item_id, kind: row.kind, restored: restoreAmount },
    });

    return { ...toHeldItem(row), state: "consumed" };
  });
}
