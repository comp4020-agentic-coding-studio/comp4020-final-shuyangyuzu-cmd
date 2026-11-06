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
import {
  activeEatingRow,
  eatingRequestResult,
  isEating,
  recordEatingRequest,
  writeEatingLock,
  type EatingAction,
  type EatingKind,
} from "./eating.ts";
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

export interface MenuIngredient {
  item: string;
  amount: string;
}

export interface MenuSource {
  name: string;
  url: string;
  note: string;
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
  /** Served path to a real, licensed photo of the dish (public/assets/
   * menu/*.jpg) — see docs/menu-image-sources.md for each file's source
   * and licence. Never a duplicate placeholder standing in for a missing
   * photo: every item below has a real, matched image. */
  image: string;
  imageAlt: string;
  /** A real, referenceable recipe — genuine ingredient quantities and
   * cooking steps, not a single invented sentence. For the one drink
   * that is an actual mixed cocktail (whiskey-sour), this is omitted in
   * favour of `mixologyRecipeId`, which points at the Mixology book's own
   * recipe so the two never disagree (CLAUDE.md: "Drinks with a matching
   * cocktail recipe reuse the same recipe data"). */
  ingredients?: readonly MenuIngredient[];
  steps?: readonly string[];
  /** Only set for a drink that is also a real mixed cocktail already in
   * the Mixology book's own RECIPES list (public/mixology.js) — the
   * client's recipe view reads that shared data directly rather than
   * keeping a second, independently-written copy. */
  mixologyRecipeId?: string;
  /** An approximate calorie estimate for one serving of the recipe shown
   * above, worked out from real USDA FoodData Central per-100g/100ml
   * figures for each ingredient at the stated quantity — never an exact,
   * lab-measured number, and always labelled "≈" for that reason. This
   * is a real-world nutrition estimate, entirely separate from this
   * game's own stamina-restore mechanic (which the Stamina section of
   * CLAUDE.md governs on its own terms). */
  kcalEstimate: number;
  kcalSource: MenuSource;
  /** Only present when a variant could plausibly change the estimate —
   * explains why the figure above is still used for every variant (a
   * doneness choice changes cook time, not the raw cut's mass; a sauce
   * choice adds at most a small garnish-sized amount) rather than silently
   * presenting one number as if it covered every choice without comment. */
  variantNote?: string;
  /** Common allergens genuinely present in the recipe above (a plain
   * English label per common allergen — "Gluten," "Dairy," "Egg," "Fish,"
   * "Shellfish," "Tree nuts," "Peanuts," "Soy," "Sesame," or the
   * real-but-non-"tree-nut" "Coconut") — not a fictional or invented list,
   * worked out directly from the stated ingredients. Empty when nothing on
   * this list genuinely applies, never omitted outright, so a client can
   * render "no common allergens" with confidence rather than guessing
   * whether the field was simply never filled in. */
  allergens: readonly string[];
  /** True only for a drink that genuinely contains alcohol — every meal is
   * `false`. Drawn directly from the recipe's own real ingredients (a
   * mixology-book-linked cocktail's own spirit, an item's own beer/liquor
   * ingredient), never inferred from the item's name alone. */
  alcoholic: boolean;
}

// A small, complete first set — not padded with placeholders. At least
// one meal has a genuine doneness choice and one has a genuine sauce
// choice, so the variant-selection UI has real cases to prove out.
const usda = (food: string): MenuSource => ({
  name: "USDA FoodData Central",
  url: `https://fdc.nal.usda.gov/food-search?query=${encodeURIComponent(food)}`,
  note: `Estimated from USDA FoodData Central's per-100g/100ml figures for "${food}" at the quantities shown, not a lab-measured value for this exact dish.`,
});

export const MENU: readonly MenuItem[] = [
  {
    id: "grilled-trout",
    name: "Grilled Trout",
    description: "Pan-seared with lemon butter, a saloon classic.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Whole trout, pan-seared in butter with lemon and herbs, served with roasted potatoes.",
    image: "/assets/menu/grilled-trout.jpg",
    imageAlt: "A whole almond-crusted trout on a plate with lemon, herbs and a side salad",
    ingredients: [
      { item: "Trout fillet", amount: "1 whole (≈200 g)" },
      { item: "Butter", amount: "1 tbsp (≈15 g)" },
      { item: "Lemon", amount: "½, juiced" },
      { item: "Fresh parsley, chopped", amount: "1 tbsp" },
      { item: "Olive oil", amount: "1 tsp" },
      { item: "Salt and pepper", amount: "to taste" },
    ],
    steps: [
      "Pat the trout fillet dry and season both sides with salt and pepper.",
      "Heat the olive oil in a pan over medium-high heat; lay the fillet skin-side down and sear 3–4 minutes.",
      "Flip, add the butter to the pan, and cook 2–3 minutes more until the butter browns slightly.",
      "Squeeze the lemon juice over the fish and spoon the browned butter on top; scatter with parsley.",
      "Serve immediately with roasted potatoes.",
    ],
    kcalEstimate: 440,
    kcalSource: usda("trout rainbow cooked dry heat; butter salted"),
    allergens: ["Fish", "Dairy"],
    alcoholic: false,
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
    image: "/assets/menu/house-steak.jpg",
    imageAlt: "A grilled rib-eye steak on a wooden board with roasted vegetables",
    ingredients: [
      { item: "Sirloin steak", amount: "1 (≈250 g)" },
      { item: "Vegetable oil", amount: "1 tsp" },
      { item: "Salt", amount: "½ tsp" },
      { item: "Black pepper", amount: "¼ tsp" },
    ],
    steps: [
      "Bring the steak to room temperature, pat it dry, and season generously with salt and pepper.",
      "Heat the oil in a heavy pan or on a grill until very hot.",
      "Sear 2–4 minutes per side for rare, 4–5 for medium, 6–7+ for well done (internal guide: rare ≈52°C, medium ≈63°C, well done ≈71°C+).",
      "Rest the steak 5 minutes before serving so the juices redistribute.",
    ],
    kcalEstimate: 590,
    kcalSource: usda("beef top sirloin steak choice cooked broiled"),
    variantNote: "The estimate assumes the steak above (≈250 g raw) — a doneness choice changes cook time, not the cut's mass, so the same figure is shown for all three.",
    allergens: [],
    alcoholic: false,
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
    image: "/assets/menu/saloon-burger.jpg",
    imageAlt: "A sesame-bun cheeseburger with lettuce, served with fries and coleslaw",
    ingredients: [
      { item: "Sesame bun", amount: "1 (≈52 g)" },
      { item: "Ground beef patty", amount: "1 (≈115 g)" },
      { item: "Cheddar or American cheese", amount: "1 slice (≈20 g)" },
      { item: "Lettuce", amount: "1 leaf" },
      { item: "Dill pickle slices", amount: "2" },
      { item: "Sauce of choice", amount: "1 tbsp" },
    ],
    steps: [
      "Form the beef into a patty slightly wider than the bun; season with salt and pepper.",
      "Grill or pan-fry 3–4 minutes per side, adding the cheese slice in the last minute to melt.",
      "Toast the bun cut-side down until golden.",
      "Build: bottom bun, sauce, lettuce, patty with cheese, pickles, top bun.",
    ],
    kcalEstimate: 510,
    kcalSource: usda("ground beef 85% lean patty broiled; hamburger bun; American cheese"),
    variantNote: "The estimate is for the recipe above; a tablespoon of any of the three sauces adds roughly the same small amount (≈15–40 kcal) and isn't broken out separately.",
    allergens: ["Gluten", "Dairy"],
    alcoholic: false,
  },
  {
    id: "bean-chili",
    name: "Bean Chili",
    description: "A hearty bowl, served hot.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Slow-simmered beans and beef in a smoky chili broth, cornbread on the side.",
    image: "/assets/menu/bean-chili.jpg",
    imageAlt: "A bowl of chili topped with sour cream and shredded cheese",
    ingredients: [
      { item: "Ground beef", amount: "150 g" },
      { item: "Kidney or pinto beans, canned", amount: "1 can (≈400 g)" },
      { item: "Crushed tomatoes, canned", amount: "200 g" },
      { item: "Onion, diced", amount: "½" },
      { item: "Chili powder", amount: "1 tsp" },
      { item: "Ground cumin", amount: "½ tsp" },
      { item: "Salt", amount: "to taste" },
    ],
    steps: [
      "Brown the ground beef with the diced onion in a pot over medium heat.",
      "Stir in the chili powder and cumin; cook 1 minute until fragrant.",
      "Add the tomatoes and beans; simmer uncovered 25–30 minutes, stirring occasionally.",
      "Season with salt to taste and serve hot with cornbread.",
    ],
    kcalEstimate: 380,
    kcalSource: usda("chili con carne with beans canned entree"),
    allergens: [],
    alcoholic: false,
  },
  {
    id: "soda",
    name: "Soda",
    description: "Cold and fizzy.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Poured straight from the fountain, over ice.",
    image: "/assets/menu/soda.jpg",
    imageAlt: "A glass of cola over ice",
    ingredients: [
      { item: "Cola", amount: "≈350 ml" },
      { item: "Ice", amount: "to fill" },
    ],
    steps: ["Fill a glass with ice.", "Pour the cola over the ice until full."],
    kcalEstimate: 150,
    kcalSource: usda("carbonated beverage cola regular"),
    allergens: [],
    alcoholic: false,
  },
  {
    id: "coffee",
    name: "Black Coffee",
    description: "Hot off the stove.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Fresh-brewed, served black — cream and sugar on the side.",
    image: "/assets/menu/coffee.jpg",
    imageAlt: "A cup of black coffee on a saucer",
    ingredients: [
      { item: "Ground coffee", amount: "2 tbsp (≈15 g)" },
      { item: "Hot water", amount: "≈240 ml" },
    ],
    steps: ["Brew the grounds with the hot water (drip or French press).", "Serve black; cream and sugar are offered on the side, not mixed in."],
    kcalEstimate: 5,
    kcalSource: usda("coffee brewed prepared with tap water"),
    allergens: [],
    alcoholic: false,
  },
  {
    id: "house-lager",
    name: "House Lager",
    description: "On tap.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "A crisp lager, drawn fresh from the counter's own tap.",
    image: "/assets/menu/house-lager.jpg",
    imageAlt: "A lager with a thick foam head, viewed from above in a cut-glass mug",
    ingredients: [{ item: "Lager beer", amount: "≈500 ml" }],
    steps: ["Pour into a chilled glass, tilted at first to reduce foam.", "Straighten the glass near the top for a natural head."],
    kcalEstimate: 215,
    kcalSource: usda("alcoholic beverage beer regular"),
    allergens: ["Gluten"],
    alcoholic: true,
  },
  {
    id: "whiskey-sour",
    name: "Whiskey Sour",
    description: "A saloon standard.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Bourbon, lemon, and sugar syrup, shaken over ice — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/whiskey-sour.jpg",
    imageAlt: "A whiskey sour cocktail garnished with a lemon wheel and cherries",
    // No ingredients/steps of its own — the client's recipe view reads
    // the Mixology book's own `whiskey-sour` RECIPES entry instead, so
    // the two can never drift into disagreeing about the same drink.
    mixologyRecipeId: "whiskey-sour",
    kcalEstimate: 155,
    kcalSource: usda("whiskey distilled 80 proof; lemon juice raw; sugars granulated"),
    allergens: [],
    alcoholic: true,
  },

  // ---- 10 new alcoholic drinks (2026-11-06, Claude) ----
  // Every one of these is a real IBA-codified cocktail (or, for Gin &
  // Tonic, a globally standard ratio with no single "owning" body — see
  // its own kcalSource/recipe note below) — fetched directly from
  // iba-world.com's own per-cocktail pages at implementation time, not
  // invented proportions. Nine of the ten already exist in the Mixology
  // book's own RECIPES (public/mixology.js) and reuse that exact recipe
  // via mixologyRecipeId, the same pattern whiskey-sour above already
  // established, so the counter's menu and the Mixology book can never
  // quietly disagree about the same cocktail's ratios. Gin & Tonic has no
  // mixology-book entry (it's not IBA-codified — no fixed ratio exists to
  // share) and keeps its own ingredients/steps.
  {
    id: "old-fashioned",
    name: "Old Fashioned",
    description: "Whiskey, sugar and bitters, stirred over ice.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Bourbon or rye, muddled with a sugar cube and bitters — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/old-fashioned.jpg",
    imageAlt: "An Old Fashioned cocktail with an orange twist, served over a large ice cube",
    mixologyRecipeId: "old-fashioned",
    kcalEstimate: 180,
    kcalSource: usda("whiskey distilled 80 proof; sugars granulated"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "mojito",
    name: "Mojito",
    description: "White rum, mint and lime, topped with soda.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Muddled mint, lime and sugar, built over rum and soda — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/mojito.jpg",
    imageAlt: "A Mojito in a tall glass with mint sprigs and a lime wedge",
    mixologyRecipeId: "mojito",
    kcalEstimate: 145,
    kcalSource: usda("rum; lime juice raw; sugars granulated; club soda"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "margarita",
    name: "Margarita",
    description: "Tequila, triple sec and lime, shaken over ice.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Tequila, triple sec and fresh lime juice, shaken — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/margarita.jpg",
    imageAlt: "A Margarita in a salt-rimmed glass with a lime wedge",
    mixologyRecipeId: "margarita",
    kcalEstimate: 200,
    kcalSource: usda("tequila distilled 80 proof; triple sec liqueur; lime juice raw"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "negroni",
    name: "Negroni",
    description: "Equal parts gin, Campari and sweet vermouth.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Gin, Campari and sweet red vermouth in equal measure, stirred over ice — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/negroni.jpg",
    imageAlt: "A Negroni on the rocks with an orange twist",
    mixologyRecipeId: "negroni",
    kcalEstimate: 170,
    kcalSource: usda("gin distilled 80 proof; campari; vermouth sweet"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "martini",
    name: "Martini",
    description: "Gin and dry vermouth, stirred and strained.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Gin and a splash of dry vermouth, stirred with ice and strained — the same proportions as the Mixology book's own \"Dry Martini.\"",
    image: "/assets/menu/martini.jpg",
    imageAlt: "A classic Martini in a cocktail glass with two olives",
    mixologyRecipeId: "dry-martini",
    kcalEstimate: 175,
    kcalSource: usda("gin distilled 80 proof; vermouth dry"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "manhattan",
    name: "Manhattan",
    description: "Rye whiskey, sweet vermouth and a dash of bitters.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Rye whiskey and sweet vermouth, stirred with bitters and strained — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/manhattan.jpg",
    imageAlt: "Two Manhattan cocktails garnished with a maraschino cherry, photographed from above",
    mixologyRecipeId: "manhattan",
    kcalEstimate: 185,
    kcalSource: usda("whiskey distilled 80 proof; vermouth sweet"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "daiquiri",
    name: "Daiquiri",
    description: "White rum, lime and sugar, shaken until cold.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Rum, fresh lime juice and sugar, shaken hard and strained — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/daiquiri.jpg",
    imageAlt: "A classic Daiquiri served up in a cocktail glass",
    mixologyRecipeId: "daiquiri",
    kcalEstimate: 155,
    kcalSource: usda("rum; lime juice raw; sugars granulated"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "gin-tonic",
    name: "Gin & Tonic",
    description: "Gin and tonic water over ice, with a slice of lime.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Gin topped with tonic water over ice, finished with lime — no single body codifies an exact ratio for this one (unlike the IBA cocktails above), so the counter uses the common 1:2 gin-to-tonic middle of the usual 1:1–1:3 range.",
    image: "/assets/menu/gin-tonic.jpg",
    imageAlt: "A Gin and Tonic in a tall glass with a wedge of lime",
    ingredients: [
      { item: "Gin", amount: "45 ml" },
      { item: "Tonic water", amount: "90 ml" },
      { item: "Lime wedge", amount: "1" },
    ],
    steps: [
      "Fill a highball glass with ice.",
      "Pour in the gin.",
      "Top with tonic water and stir gently once.",
      "Squeeze and drop in a wedge of lime.",
    ],
    kcalEstimate: 115,
    kcalSource: usda("gin distilled 80 proof; tonic water"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "moscow-mule",
    name: "Moscow Mule",
    description: "Vodka, ginger beer and lime, served in a copper mug.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Vodka and fresh lime juice, topped with ginger beer and served in a copper mug — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/moscow-mule.jpg",
    imageAlt: "A Moscow Mule in a copper mug with a lime wheel garnish",
    mixologyRecipeId: "moscow-mule",
    kcalEstimate: 180,
    kcalSource: usda("vodka distilled 80 proof; ginger beer; lime juice raw"),
    allergens: [],
    alcoholic: true,
  },
  {
    id: "pina-colada",
    name: "Piña Colada",
    description: "White rum, coconut cream and pineapple, blended with ice.",
    kind: "drink",
    restoreAmount: STAMINA_DRINK_RESTORE,
    recipeNote: "Rum, coconut cream and fresh pineapple juice, blended with ice — the same proportions as the Mixology book's own recipe.",
    image: "/assets/menu/pina-colada.jpg",
    imageAlt: "A Piña Colada garnished with a pineapple wedge and a cocktail cherry",
    mixologyRecipeId: "pina-colada",
    kcalEstimate: 245,
    kcalSource: usda("rum; cream of coconut canned; pineapple juice canned"),
    allergens: ["Coconut"],
    alcoholic: true,
  },

  // ---- 6 new meals (2026-11-06, Claude) ----
  {
    id: "fish-and-chips",
    name: "Fish & Chips",
    description: "Beer-battered fish with thick-cut fries.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "A whole fillet in a crisp beer batter, fried golden, with thick-cut fries and mushy peas.",
    image: "/assets/menu/fish-and-chips.jpg",
    imageAlt: "A plate of beer-battered fish and chips with a side of peas",
    ingredients: [
      { item: "White fish fillet (cod or similar)", amount: "1 (≈180 g)" },
      { item: "Plain flour", amount: "100 g, plus extra for dusting" },
      { item: "Beer, cold", amount: "150 ml" },
      { item: "Baking powder", amount: "½ tsp" },
      { item: "Potatoes, cut into thick chips", amount: "250 g" },
      { item: "Vegetable oil, for frying", amount: "for deep-frying" },
      { item: "Peas", amount: "80 g" },
      { item: "Salt", amount: "to taste" },
    ],
    steps: [
      "Fry the chips at 150°C until soft but pale, drain, then set aside.",
      "Whisk the flour, baking powder and cold beer into a smooth batter.",
      "Heat the frying oil to 180°C. Dust the fish in flour, dip in the batter, and fry 5–6 minutes until golden and cooked through.",
      "Re-fry the chips at 190°C for 2–3 minutes until crisp; drain and salt.",
      "Boil and lightly mash the peas. Serve the fish and chips together with the peas.",
    ],
    kcalEstimate: 650,
    kcalSource: usda("fish battered fried; potato french fried; peas green boiled"),
    allergens: ["Gluten", "Fish"],
    alcoholic: false,
  },
  {
    id: "chicken-parmigiana",
    name: "Chicken Parmigiana",
    description: "Breaded chicken, tomato sauce and melted cheese.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "A breaded chicken breast, baked under tomato sauce and melted mozzarella, served with pasta.",
    image: "/assets/menu/chicken-parmigiana.jpg",
    imageAlt: "A breaded chicken parmigiana with melted cheese, served with a side of pasta",
    ingredients: [
      { item: "Chicken breast", amount: "1 (≈180 g)" },
      { item: "Breadcrumbs", amount: "60 g" },
      { item: "Egg, beaten", amount: "1" },
      { item: "Plain flour", amount: "30 g" },
      { item: "Tomato pasta sauce", amount: "150 g" },
      { item: "Mozzarella, grated", amount: "60 g" },
      { item: "Parmesan, grated", amount: "15 g" },
      { item: "Dried pasta", amount: "80 g" },
    ],
    steps: [
      "Flatten the chicken breast to an even thickness; season.",
      "Dust in flour, dip in egg, then coat in breadcrumbs.",
      "Pan-fry 3–4 minutes per side until golden; transfer to a baking dish.",
      "Spoon over the tomato sauce, top with mozzarella and parmesan, and bake at 200°C for 12–15 minutes until bubbling.",
      "Meanwhile boil the pasta to packet instructions and serve alongside.",
    ],
    kcalEstimate: 720,
    kcalSource: usda("chicken breast breaded fried; cheese mozzarella; tomato sauce canned; pasta cooked"),
    allergens: ["Gluten", "Egg", "Dairy"],
    alcoholic: false,
  },
  {
    id: "mushroom-risotto",
    name: "Mushroom Risotto",
    description: "Creamy arborio rice with mushrooms and parmesan.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Arborio rice, slowly stirred with stock until creamy, folded through with sautéed mushrooms and parmesan.",
    image: "/assets/menu/mushroom-risotto.jpg",
    imageAlt: "A bowl of creamy mushroom risotto topped with grated parmesan",
    ingredients: [
      { item: "Arborio rice", amount: "90 g" },
      { item: "Mixed mushrooms, sliced", amount: "150 g" },
      { item: "Vegetable stock, warm", amount: "500 ml" },
      { item: "Butter", amount: "20 g" },
      { item: "Onion, finely diced", amount: "¼" },
      { item: "Parmesan, grated", amount: "25 g" },
      { item: "Olive oil", amount: "1 tbsp" },
    ],
    steps: [
      "Sauté the mushrooms in olive oil until golden; set aside.",
      "Cook the onion in half the butter until soft, then stir in the rice for 1 minute to coat.",
      "Add the warm stock a ladle at a time, stirring until absorbed before adding more, for 18–20 minutes.",
      "Stir through the mushrooms, remaining butter and parmesan off the heat until creamy.",
    ],
    kcalEstimate: 480,
    kcalSource: usda("rice arborio cooked; mushrooms sauteed; parmesan cheese grated; butter salted"),
    allergens: ["Dairy"],
    alcoholic: false,
  },
  {
    id: "spaghetti-bolognese",
    name: "Spaghetti Bolognese",
    description: "Spaghetti with a slow-simmered beef and tomato ragù.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "A classic beef and tomato ragù, slow-simmered and tossed with spaghetti and parmesan.",
    image: "/assets/menu/spaghetti-bolognese.jpg",
    imageAlt: "A plate of spaghetti bolognese topped with grated parmesan",
    ingredients: [
      { item: "Spaghetti", amount: "100 g" },
      { item: "Ground beef", amount: "150 g" },
      { item: "Crushed tomatoes, canned", amount: "250 g" },
      { item: "Onion, diced", amount: "¼" },
      { item: "Garlic, minced", amount: "1 clove" },
      { item: "Olive oil", amount: "1 tbsp" },
      { item: "Parmesan, grated", amount: "15 g" },
      { item: "Salt and pepper", amount: "to taste" },
    ],
    steps: [
      "Cook the onion and garlic in olive oil until soft.",
      "Brown the ground beef, breaking it up, then stir in the crushed tomatoes.",
      "Simmer uncovered 25–30 minutes, stirring occasionally, and season to taste.",
      "Boil the spaghetti to packet instructions, toss with the sauce, and top with parmesan.",
    ],
    kcalEstimate: 610,
    kcalSource: usda("spaghetti cooked enriched; ground beef 85% lean cooked; tomato sauce canned; parmesan cheese grated"),
    allergens: ["Gluten", "Dairy"],
    alcoholic: false,
  },
  {
    id: "caesar-salad",
    name: "Caesar Salad",
    description: "Crisp romaine, parmesan, croutons and Caesar dressing.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Romaine lettuce tossed in a classic Caesar dressing with croutons and shaved parmesan.",
    image: "/assets/menu/caesar-salad.jpg",
    imageAlt: "A Caesar salad with croutons and shaved parmesan",
    variants: [
      { group: "protein", label: "No added protein" },
      { group: "protein", label: "Grilled chicken" },
    ],
    ingredients: [
      { item: "Romaine lettuce, chopped", amount: "150 g" },
      { item: "Parmesan, shaved", amount: "20 g" },
      { item: "Bread, cubed and toasted (croutons)", amount: "40 g" },
      { item: "Mayonnaise", amount: "2 tbsp" },
      { item: "Anchovy fillets, minced", amount: "2" },
      { item: "Lemon juice", amount: "1 tsp" },
      { item: "Garlic, minced", amount: "½ clove" },
    ],
    steps: [
      "Whisk the mayonnaise, minced anchovy, lemon juice and garlic into a dressing.",
      "Toss the romaine with the dressing until evenly coated.",
      "Top with croutons and shaved parmesan.",
      "Add grilled chicken on top if chosen.",
    ],
    kcalEstimate: 320,
    kcalSource: usda("caesar salad with dressing and croutons; parmesan cheese"),
    allergens: ["Gluten", "Dairy", "Egg", "Fish"],
    alcoholic: false,
    variantNote: "The estimate is for the salad itself; grilled chicken adds roughly 165 kcal for a ≈100 g breast portion, not folded into the base figure above.",
  },
  {
    id: "loaded-nachos",
    name: "Loaded Nachos",
    description: "Corn chips loaded with cheese, beans and all the toppings.",
    kind: "meal",
    restoreAmount: STAMINA_MEAL_RESTORE,
    recipeNote: "Corn tortilla chips layered with melted cheese, beans, jalapeños, salsa, guacamole and sour cream.",
    image: "/assets/menu/loaded-nachos.jpg",
    imageAlt: "A plate of loaded nachos with melted cheese, jalapeños, salsa, guacamole and sour cream",
    variants: [
      { group: "style", label: "Vegetarian (bean, no meat)" },
      { group: "style", label: "With seasoned beef" },
    ],
    ingredients: [
      { item: "Corn tortilla chips", amount: "120 g" },
      { item: "Cheddar cheese, shredded", amount: "80 g" },
      { item: "Black beans, canned", amount: "100 g" },
      { item: "Jalapeños, sliced", amount: "20 g" },
      { item: "Tomato salsa", amount: "60 g" },
      { item: "Guacamole", amount: "40 g" },
      { item: "Sour cream", amount: "30 g" },
    ],
    steps: [
      "Spread the tortilla chips on an oven tray in a single layer.",
      "Scatter over the black beans (or seasoned beef, if chosen), cheese and jalapeños.",
      "Bake at 200°C for 6–8 minutes until the cheese melts.",
      "Top with salsa, guacamole and sour cream just before serving.",
    ],
    kcalEstimate: 590,
    kcalSource: usda("nachos with cheese beans and salsa; sour cream; guacamole"),
    allergens: ["Dairy"],
    alcoholic: false,
    variantNote: "The estimate is for the vegetarian/bean version — swapping in seasoned beef adds roughly 150 kcal for a ≈100 g portion, not folded into the base figure above.",
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
  // Mid eating/drinking animation, no other action may run (CLAUDE.md:
  // "while eating, no moving, standing, re-ordering/consuming, or game
  // actions") — checked fresh here, not just hidden client-side.
  if (isEating(db, barPlayerId)) throw new OrderError("finish eating or drinking first", "eating_active", 409);

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
 * item's own row instead.
 *
 * Deliberately NOT gated on being seated or free of an eating lock —
 * this is the low-level, exactly-once-per-row primitive `startEating`
 * below actually calls for each held item it's starting; its own
 * contract (and the 15 tests in spec/orders.test.ts that already pin it
 * down) is unchanged by the seated-eating feature. The seat check, the
 * eating-lock check, and the ~8-second animation all live one level up,
 * in startEating.
 *
 * NOT reachable over HTTP as of the 2026-11 correction: `POST
 * /api/orders/consume` used to expose this function directly with no
 * seat/lock check in front of it, which let a standing patron bypass the
 * entire seated-eating feature (a real bug Codex found and reproduced —
 * see CLAUDE.md's seated-eating correction and
 * spec/ordersHttp.test.ts). That route is gone; this function now has
 * exactly one caller, startEating, and exists purely as an internal
 * building block. */
export function consumeHeldItem(
  db: Database.Database,
  barPlayerId: string,
  barSessionSecret: string,
  heldItemId: string,
): HeldItem {
  requireBarSession(db, barPlayerId, barSessionSecret);
  return transact(db, () => consumeHeldItemLocked(db, barPlayerId, heldItemId));
}

/** The actual mutation, factored out so startEating (below) can call it
 * for one or two held items inside its own single transaction without
 * re-running requireBarSession for each — the caller already proved
 * identity once. */
function consumeHeldItemLocked(db: Database.Database, barPlayerId: string, heldItemId: string): HeldItem {
  const row = db
    .prepare(`SELECT id, kind, item_id, variant, state FROM held_items WHERE id = ? AND player_id = ?`)
    .get(heldItemId, barPlayerId) as HeldItemRow | undefined;
  if (!row) throw new OrderError("you aren't holding that item", "not_held", 404);

  if (row.state === "consumed") {
    // Already consumed — a harmless re-send of the same request, never
    // a second restore. markIdentityVerified already ran via
    // requireBarSession above, so this is logged as a genuine, verified
    // no-op rather than a rejection.
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
}

// ---- Seated eating/drinking (2026-10-29 round) ----
//
// CLAUDE.md's "Seated eating and drinking" section is the full product
// rule; this is the server-authoritative lifecycle it describes. A
// dining/stool seat (src/barLayout.ts's BAR_SEATS — a game table's own
// chairs are never in that table, by construction, so this check can't
// be satisfied by sitting at a Vegas/poker chair) is required to START
// eating; once started, the 8-second lock (src/eating.ts) is what keeps
// the player from moving, standing, ordering again, or joining a game
// until it naturally expires — not a second, separate "are they still
// seated" check on every tick. Standing up mid-animation is simply one
// more thing bar.ts's standFromSeat refuses while the lock is active,
// the same way it already refuses while poker membership is active.

/** Which held items an eating action should actually consume, and in
 * which order the animation plays (CLAUDE.md: meal then drink, when
 * both are held — "start eating -> finish the plate -> put it down ->
 * pick up the drink -> finish it -> put it down"; only one kind plays if
 * only one is held). Returns an empty array if nothing is actually held
 * to eat/drink right now. */
function heldToStart(db: Database.Database, barPlayerId: string): HeldItemRow[] {
  const rows = db
    .prepare(`SELECT id, kind, item_id, variant, state FROM held_items WHERE player_id = ? AND state = 'held'`)
    .all(barPlayerId) as HeldItemRow[];
  const meal = rows.find((r) => r.kind === "meal");
  const drink = rows.find((r) => r.kind === "drink");
  return [meal, drink].filter((r): r is HeldItemRow => r != null);
}

/** Starts the seated eating/drinking action for every currently-held
 * item (one call starts both the meal and the drink together, if both
 * are held — CLAUDE.md's combined sequence). Consumes each held item
 * and restores stamina for it immediately, atomically, in the same
 * transaction as the lock row itself — the 8-second wait that follows is
 * purely a client-visible animation window with nothing still "owed" by
 * the time it finishes (see src/eating.ts's own header for why this is
 * the design, not a shortcut). Idempotent the same way placeOrder is: a
 * retried start with the same idempotencyKey returns the already-started
 * action rather than re-consuming anything or restarting the clock —
 * including after that action's own lock has long since naturally
 * expired, or the process has restarted, since the check below is
 * against a durable, permanent record (src/eating.ts's
 * eatingRequestResult/recordEatingRequest), never the lock row alone.
 *
 * 2026-11 correction (Codex found and reproduced this as a real bug,
 * fixed here): a retried request carrying an OLD action's own key used to
 * be checked only against the LOCK's own idempotency_key column — which
 * only ever remembers the single most recent request and stops mattering
 * the instant the lock naturally expires. A late or duplicated retry of
 * the FIRST request, arriving after that lock had already expired (and
 * possibly after the player had already ordered something new), would
 * fall through to the "start a new action" branch below and consume
 * whatever happens to be held *now* — a completely different item than
 * the one that request actually meant, restarting the clock and silently
 * misattributing a fresh restore to a stale request. The fix: check the
 * durable per-(player, key) record FIRST, unconditionally, before the
 * lock's own active/expired state is even considered — see
 * spec/eating.test.ts's own regression tests for the exact scenario this
 * closes. */
export function startEating(
  db: Database.Database,
  barPlayerId: string,
  barSessionSecret: string,
  idempotencyKey: string,
): EatingAction {
  requireBarSession(db, barPlayerId, barSessionSecret);
  if (!idempotencyKey) throw new OrderError("missing idempotency key", "bad_request", 400);

  return transact(db, () => {
    // Checked first and unconditionally: a key that already started a
    // real action always returns that exact original result, regardless
    // of whether its own lock is still active, has since expired, or the
    // row behind it no longer exists at all.
    const pastResult = eatingRequestResult(db, barPlayerId, idempotencyKey);
    if (pastResult) return pastResult;

    const existing = activeEatingRow(db, barPlayerId);
    if (existing?.active) {
      // existing.row.idempotency_key can only ever be the CURRENT lock's
      // own key (bar_eating_actions is overwritten per-player on every
      // new start) — the pastResult check above already handles any
      // older key durably, so this branch only needs to refuse a
      // genuinely different, concurrent request while still locked.
      throw new OrderError("you're already eating or drinking", "eating_active", 409);
    }

    const seated = db.prepare(`SELECT 1 FROM bar_seats WHERE occupied_by = ?`).get(barPlayerId);
    if (!seated) {
      throw new OrderError("sit at a dining table or a bar stool first", "not_seated", 409);
    }

    const toConsume = heldToStart(db, barPlayerId);
    if (toConsume.length === 0) {
      throw new OrderError("you aren't holding anything to eat or drink", "nothing_held", 409);
    }

    for (const row of toConsume) consumeHeldItemLocked(db, barPlayerId, row.id);
    const kinds = toConsume.map((r) => r.kind as EatingKind);
    const action = writeEatingLock(db, barPlayerId, kinds, idempotencyKey);
    recordEatingRequest(db, barPlayerId, idempotencyKey, action);

    logAction(db, {
      action: "start_eating",
      outcome: "ok",
      verified: true,
      actor: { kind: "bar", id: barPlayerId },
      detail: { kinds: kinds.join("+") },
    });

    return action;
  });
}

export { currentEatingAction, isEating } from "./eating.ts";
export type { EatingAction, EatingKind } from "./eating.ts";
