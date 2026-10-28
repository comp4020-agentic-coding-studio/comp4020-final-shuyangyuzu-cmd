# Front-of-house menu: image sources

Every photo in `public/assets/menu/` is a real, Creative-Commons-licensed
photograph from Wikimedia Commons, downloaded and then resized (max width
900px, JPEG quality 78, mozjpeg) to keep the deployed bundle small — see
`src/orders.ts`'s own `image`/`imageAlt` fields, which point at these files.
No image here is a stand-in or placeholder: each one was chosen because it
genuinely depicts the dish or drink it illustrates, not merely "a food
photo." No kcal estimate is derived from these photos — see each `MenuItem`'s
own `kcalSource` in `src/orders.ts` for the separate USDA FoodData Central
nutrition sourcing.

| File | Menu item | Source | License | Author |
|---|---|---|---|---|
| `grilled-trout.jpg` | Grilled Trout | [Mandel-Forelle Bad Schandau.jpg](https://commons.wikimedia.org/wiki/File:Mandel-Forelle_Bad_Schandau.jpg) | CC BY-SA 4.0 | Benreis |
| `house-steak.jpg` | House Steak | [US Rib eye with wild vegetables and baked potato.jpg](https://commons.wikimedia.org/wiki/File:US_Rib_eye_with_wild_vegetables_and_baked_potato.jpg) | CC BY-SA 2.0 | Apeach316 |
| `saloon-burger.jpg` | Saloon Burger | [DZ6 2093 Classic burger night...jpg](https://commons.wikimedia.org/wiki/File:DZ6_2093_Classic_burger_night_juicy_sesame_burger_with_crisp_fries_and_creamy_coleslaw_-_comfort_on_a_plate.jpg) | CC BY-SA 4.0 | PattayaPatrol |
| `bean-chili.jpg` | Bean Chili | [Bowl of chili.jpg](https://commons.wikimedia.org/wiki/File:Bowl_of_chili.jpg) | CC BY-SA 2.5 | Carstor |
| `soda.jpg` | Soda | [Glass of Cola.jpg](https://commons.wikimedia.org/wiki/File:Glass_of_Cola.jpg) | CC BY-SA 4.0 | Cocktailmarler |
| `coffee.jpg` | Black Coffee | [Black coffee with saucer and spoon.jpg](https://commons.wikimedia.org/wiki/File:Black_coffee_with_saucer_and_spoon.jpg) | CC BY 2.0 | Dennis Wong |
| `house-lager.jpg` | House Lager | [Mug of beer from above (ubt 2005).jpg](https://commons.wikimedia.org/wiki/File:Mug_of_beer_from_above_(ubt_2005).jpg) | CC BY 2.5 | Tomasz Sienicki |
| `whiskey-sour.jpg` | Whiskey Sour | [Whiskey sour in coupe glass with garnishes.jpg](https://commons.wikimedia.org/wiki/File:Whiskey_sour_in_coupe_glass_with_garnishes.jpg) | CC BY-SA 4.0 | Ilikefood |

## Known limitation: `house-lager.jpg` and `whiskey-sour.jpg`

- **House Lager** is a genuine photo of a lager with a foam head, but shot
  from directly above in a cut-glass mug rather than the more common
  straight-on pint-glass framing — the only unbranded, correctly-licensed
  lager photo found that wasn't a specific real commercial brand (several
  well-composed candidates were real-world branded beers — Chang,
  Pilsner Urquell, Würzburger Hofbräu — and were rejected for that reason,
  since this is a fictional "House Lager," not a real product). The
  `imageAlt` text says "viewed from above" so this isn't presented as a
  normal side view.
- **Whiskey Sour** shows real liquor bottles (including a real "Mellow Corn"
  whiskey label) visible, out of focus, in the background — it was the only
  whiskey-sour photograph on Commons found with a compatible CC license.
  The drink itself (in a coupe glass, egg-white foam, Angostura bitters
  swirl, cherry and lemon-twist garnish) is a correct, clear match for the
  recipe; the backdrop is incidental to a real bar photo, not a staged
  product placement for a specific brand.

Both are disclosed here rather than silently accepted as "good enough" —
per the project's own standard of reporting an honest limitation instead
of treating a photo as perfect because it technically renders.

## CC BY-SA attribution note

Several of these images carry a CC BY-SA license, which requires
attribution and share-alike on redistribution. This table itself serves as
that attribution (author name, file title, and a link to the original
Commons page with full licence terms) for this student project's own
reuse of the images.
