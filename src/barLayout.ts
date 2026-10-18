// The bar's fixed floor plan — furniture is seeded once from this and
// never created or deleted at runtime (CLAUDE.md). This single module is
// the shared source of truth for server-side movement validation *and*
// what the client renders and seeds `tables`/`bar_seats` from, reached by
// the client via GET /api/bar/layout rather than duplicated in app.js.
//
// Grid-tile movement, not free-pixel (PLAN.md decision): a move is one
// step to an adjacent, walkable tile. Walkable = not covered by any
// furniture rectangle, and inside the grid.

export const GRID_COLS = 40;
export const GRID_ROWS = 24;
export const TILE_SIZE = 32;

export type FurnitureKind = "counter" | "stool" | "dining_table" | "game_table" | "restroom";
export type GameType = "vegas" | "texas" | "dominoes" | "blackjack";
/** "online" — a shared table other patrons can request to join, host-
 * approved (Crit 9 phase 8). "npc" — a solo kiosk: every visitor who
 * starts one gets their own private game against 3 computer-controlled
 * opponents, never a table other patrons see as "join-able" (PLAN.md's
 * product-direction-update). */
export type TableMode = "online" | "npc";

export interface Furniture {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Only set for kind === "game_table". */
  gameType?: GameType;
  /** Only set for kind === "game_table" — false for every reserved
   * ("not yet open") slot, true for the ones actually playable this
   * round (the two online Vegas tables and the one Vegas NPC table). */
  available?: boolean;
  /** Only set for kind === "game_table" — which of the two rows this
   * slot belongs to, independent of `available` (a reserved slot still
   * has a row/mode, it's just not playable yet). */
  tableMode?: TableMode;
  /** Defaults to true (every existing kind blocks movement, unchanged)
   * — set false for a fixture that's a walkable zone marker rather than
   * an obstacle (the restroom: a sign/entrance the player can walk
   * through, not a table they walk around). Read by both isWalkable
   * below and the client's own mirror of the same rule (public/tavern.js
   * fetches this same FURNITURE list via GET /api/bar/layout), so the
   * two can't drift into "client says walkable, server says no". */
  blocksMovement?: boolean;
}

const CORE_FURNITURE: readonly Furniture[] = [
  { id: "counter", kind: "counter", x: 3, y: 1, w: 14, h: 1, label: "Bar Counter" },
  { id: "stool-1", kind: "stool", x: 3, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-2", kind: "stool", x: 6, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-3", kind: "stool", x: 9, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-4", kind: "stool", x: 12, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  { id: "stool-5", kind: "stool", x: 15, y: 2, w: 1, h: 1, label: "Stool", blocksMovement: false },
  // Dining chairs are north/south of each table. Stool tiles above and
  // all game chairs below are included in the same collision test.
  //
  // Four tables, spaced as evenly as integer tiles allow across the same
  // [1,19) span the two game-table rows already align to (gaps 3,4,3 —
  // the closest a width-2x4 row can get to even spacing while starting
  // and ending exactly on that shared boundary, the same tradeoff the
  // NPC row below already made for the same reason). Stools no longer
  // constrain this (their own seat is now the stool's own walkable tile,
  // not a tile south of it), so unlike an earlier layout revision, these
  // four columns don't need to dodge a stool column.
  { id: "dining-a", kind: "dining_table", x: 1, y: 4, w: 2, h: 2, label: "Table" },
  { id: "dining-b", kind: "dining_table", x: 6, y: 4, w: 2, h: 2, label: "Table" },
  { id: "dining-c", kind: "dining_table", x: 12, y: 4, w: 2, h: 2, label: "Table" },
  { id: "dining-d", kind: "dining_table", x: 17, y: 4, w: 2, h: 2, label: "Table" },
  // Nine tables, two labelled rows (Crit 9 phase 8's product-direction-
  // update): online (shared, host-approved — see src/rooms.ts's
  // pendingRequests) on top, a visitor's own private NPC game below.
  // Only the Vegas slots are actually playable this round; every other
  // game keeps its existing "not yet open" reserved treatment, now in
  // both rows.
  //
  // vegas-1/vegas-2 and texas-1/dominoes-1/blackjack-1 keep their
  // original ids on purpose — CLAUDE.md: furniture is never deleted, and
  // a fixture id a live room binding (tables.current_room_id) might
  // already reference must survive a layout revision unchanged. Only
  // their position/label/tableMode change here; the old third online
  // Vegas slot ("vegas-3") is dropped from this active layout per the
  // student's own explicit reduction to two online Vegas tables — its
  // row in the `tables` SQL table is never deleted (src/db.ts only seeds
  // ids that are still in GAME_TABLES, it doesn't remove ones that
  // aren't), so any room that was ever bound to it keeps existing,
  // reachable by its own code, exactly as a disbanded room already is.
  {
    id: "vegas-1",
    kind: "game_table",
    x: 1,
    y: 9,
    w: 2,
    h: 2,
    label: "Vegas Online #1",
    gameType: "vegas",
    available: true,
    tableMode: "online",
  },
  {
    id: "vegas-2",
    kind: "game_table",
    x: 5,
    y: 9,
    w: 2,
    h: 2,
    label: "Vegas Online #2",
    gameType: "vegas",
    available: true,
    tableMode: "online",
  },
  {
    id: "texas-1",
    kind: "game_table",
    x: 9,
    y: 9,
    w: 2,
    h: 2,
    label: "Texas Hold'em Online — not yet open",
    gameType: "texas",
    available: false,
    tableMode: "online",
  },
  {
    id: "dominoes-1",
    kind: "game_table",
    x: 13,
    y: 9,
    w: 2,
    h: 2,
    label: "Dominoes Online — not yet open",
    gameType: "dominoes",
    available: false,
    tableMode: "online",
  },
  {
    id: "blackjack-1",
    kind: "game_table",
    x: 17,
    y: 9,
    w: 2,
    h: 2,
    label: "Blackjack Online — not yet open",
    gameType: "blackjack",
    available: false,
    tableMode: "online",
  },
  // The NPC row has three clear walkway rows below the online tables.
  {
    id: "vegas-npc-1",
    kind: "game_table",
    x: 1,
    y: 14,
    w: 2,
    h: 2,
    label: "Vegas NPC",
    gameType: "vegas",
    available: true,
    tableMode: "npc",
  },
  {
    id: "texas-npc-1",
    kind: "game_table",
    x: 6,
    y: 14,
    w: 2,
    h: 2,
    label: "Texas Hold'em NPC — not yet open",
    gameType: "texas",
    available: false,
    tableMode: "npc",
  },
  {
    id: "dominoes-npc-1",
    kind: "game_table",
    x: 12,
    y: 14,
    w: 2,
    h: 2,
    label: "Dominoes NPC — not yet open",
    gameType: "dominoes",
    available: false,
    tableMode: "npc",
  },
  {
    id: "blackjack-npc-1",
    kind: "game_table",
    x: 17,
    y: 14,
    w: 2,
    h: 2,
    label: "Blackjack NPC — not yet open",
    gameType: "blackjack",
    available: false,
    tableMode: "npc",
  },
  // A map-edge, walkable-only fixture — clear of the furniture cluster
  // above (roughly x11-28/y7-15 after the +10/+6 offset below) and of
  // the main south walkway/rug area patrons actually use (y15-23), in
  // the empty space to the right of the room's own painted back wall.
  // No queueing, no occupancy, no server route of its own this round —
  // see CLAUDE.md: it's a walkable zone, not a game or a seat.
  // x:23,y:-4 here becomes x:33,y:2 after the +10/+6 offset below — top-
  // right corner of the 40x24 grid, a 3x3 tile zone.
  {
    id: "restroom",
    kind: "restroom",
    x: 23,
    y: -4,
    w: 3,
    h: 3,
    label: "Restroom",
    blocksMovement: false,
  },
];

// World coordinates remain independent of the viewport/camera. Leave room
// around the central tavern fixtures for future rooms and extensions.
export const FURNITURE: readonly Furniture[] = CORE_FURNITURE.map((f) => ({
  ...f, x: f.x + 10, y: f.y + 6,
}));

export const GAME_TABLES: readonly Furniture[] = FURNITURE.filter((f) => f.kind === "game_table");

// The chair's whole tile is its drawing and hit target. Fixed colours
// choose physical chairs independently of join-order/turn-order seats.
//
// A 5th chair (purple, src/types.ts's COLORS) sits on the tile directly
// north of the table's own first column — the official rulebook's own
// "GAME COMPONENTS" line ships 5 player colours' worth of dice (see
// src/rooms.ts's MAX_PLAYERS comment), so 5 seats is the real base-game
// max, not an extension past it. North was chosen because the other four
// chairs already occupy both the west and east sides of both table rows,
// and every table's own north tile is verified clear: dining tables sit a
// full row further north (y - 1 here is still one clear row below the
// nearest dining table's own south-side seat), and no other chair or
// furniture rectangle covers it. Checked against every real table
// (vegas-1/2, vegas-npc-1, and all 6 reserved slots, for layout
// consistency) by direct coordinate computation before adding this.
export const GAME_CHAIRS = GAME_TABLES.flatMap((f) => [
  { tableId: f.id, color: "red", x: f.x - 1, y: f.y },
  { tableId: f.id, color: "blue", x: f.x + f.w, y: f.y },
  { tableId: f.id, color: "green", x: f.x - 1, y: f.y + 1 },
  { tableId: f.id, color: "yellow", x: f.x + f.w, y: f.y + 1 },
  { tableId: f.id, color: "purple", x: f.x, y: f.y - 1 },
]);

/** A real, sittable seat belonging to a dining table or stool — NOT a
 * game table's own chairs (those are a rendering of that room's existing
 * 0-3 seat index, never a new occupancy concept here; PLAN.md's
 * product-direction-update entry). Each seat's (x, y) is an ordinary,
 * already-walkable floor tile next to its furniture — sitting never
 * requires a special walkability exception; a patron just has to
 * actually be standing on that exact tile (reached by the same
 * adjacent-step movement as anywhere else) before the sit action is
 * allowed (src/bar.ts). Computed from FURNITURE rather than hand-typed
 * coordinates so a layout change can't silently drift the two apart. */
export interface Seat {
  id: string;
  furnitureId: string;
  x: number;
  y: number;
}

export const BAR_SEATS: readonly Seat[] = FURNITURE.flatMap((f): Seat[] => {
  if (f.kind === "stool") {
    // The stool itself is walkable and is the seat, not a floor tile
    // beside the visible stool.
    return [{ id: `${f.id}-seat`, furnitureId: f.id, x: f.x, y: f.y }];
  }
  if (f.kind === "dining_table") {
    // Two seats north, two south: the walkable tiles flanking each of
    // the table's 2 columns, one row clear of its own footprint.
    const seats: Seat[] = [];
    for (let dx = 0; dx < f.w; dx++) {
      seats.push({ id: `${f.id}-n${dx}`, furnitureId: f.id, x: f.x + dx, y: f.y - 1 });
      seats.push({ id: `${f.id}-s${dx}`, furnitureId: f.id, x: f.x + dx, y: f.y + f.h });
    }
    return seats;
  }
  return [];
});

function furnitureAt(x: number, y: number): Furniture | undefined {
  return FURNITURE.find((f) => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h);
}

export function inBounds(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < GRID_COLS && y >= 0 && y < GRID_ROWS;
}

export function isWalkable(x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const f = furnitureAt(x, y);
  // No furniture at all, or furniture that's explicitly a walkable zone
  // marker (blocksMovement: false) rather than an obstacle — every
  // existing kind leaves this unset, so f.blocksMovement !== false stays
  // "blocks" for every fixture that already relies on that behavior.
  return f === undefined || f.blocksMovement === false;
}

/** A move is valid if the destination is walkable and at most one tile
 * away in each axis (8-directional single step) — no teleporting, no
 * pathfinding needed since the client only ever asks for one step. */
export function isValidStep(fromX: number, fromY: number, toX: number, toY: number): boolean {
  if (!isWalkable(toX, toY)) return false;
  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);
  return dx <= 1 && dy <= 1 && (dx !== 0 || dy !== 0);
}

/** Which interactive furniture (if any) sits at this tile — used both to
 * decide "clicking here acts, rather than just walks" and to report a
 * table's identity to the click handler. */
export function interactiveAt(x: number, y: number): Furniture | undefined {
  const f = furnitureAt(x, y);
  return f?.kind === "game_table" || f?.kind === "counter" ? f : undefined;
}

/** Spawn on the floor below the game rows, derived from their layout. */
export function defaultSpawn(): { x: number; y: number } {
  const bottom = Math.max(...GAME_TABLES.map((f) => f.y + f.h));
  return { x: Math.floor(GRID_COLS / 2), y: Math.min(GRID_ROWS - 1, bottom + 1) };
}
