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

## Menu expansion (2026-11-06, Claude) — 10 drinks, 6 meals

Sourced the same way as the original eight: a real, matched photograph
found directly on Wikimedia Commons (via its own MediaWiki search/imageinfo
API, never a generic stock-photo search), fetched through the API's own
pre-sized `thumburl` (the size Wikimedia's own servers ask large/automated
callers to use — see "A note on fetching these images" below), then
re-encoded locally to this project's existing JPEG pipeline (quality
65–78, mozjpeg-equivalent via Pillow). Every recipe's own real-world
ingredients/proportions came from the International Bartenders
Association's own per-cocktail pages (`iba-world.com/iba-cocktail/<id>/`)
for the nine IBA-codified drinks, fetched directly at implementation time
— not invented ratios — and from Wikipedia's own "Gin and tonic" article
for the one drink IBA does not codify (no single body owns an exact
gin:tonic ratio; the article states a standard 1:1–1:3 range, and this
menu's own recipe uses 1:2 as the stated middle of that range).

| File | Menu item | Source | License | Author |
|---|---|---|---|---|
| `old-fashioned.jpg` | Old Fashioned | [Whiskey Old Fashioned1.jpg](https://commons.wikimedia.org/wiki/File:Whiskey_Old_Fashioned1.jpg) | CC BY-SA 4.0 | Erich Wagner |
| `mojito.jpg` | Mojito | [Fresh Mojito Premium.jpg](https://commons.wikimedia.org/wiki/File:Fresh_Mojito_Premium.jpg) | CC BY-SA 4.0 | Rjcastillo |
| `margarita.jpg` | Margarita | [MargaritaReal.jpg](https://commons.wikimedia.org/wiki/File:MargaritaReal.jpg) | CC BY-SA 3.0 | Akke Monasso |
| `negroni.jpg` | Negroni | [Negroni on the Rocks.jpg](https://commons.wikimedia.org/wiki/File:Negroni_on_the_Rocks.jpg) | CC BY-SA 3.0 | Will Shenton |
| `martini.jpg` | Martini | [Classic martini by Ken30684.jpg](https://commons.wikimedia.org/wiki/File:Classic_martini_by_Ken30684.jpg) | CC BY 2.0 | Ken30684 |
| `manhattan.jpg` | Manhattan | [2 Manhattan cocktails, bird's eye view.jpg](https://commons.wikimedia.org/wiki/File:2_Manhattan_cocktails,_bird%27s_eye_view.jpg) | CC BY-SA 4.0 | Evaengler |
| `daiquiri.jpg` | Daiquiri | [Classic Daiquiri in Cocktail Glass.jpg](https://commons.wikimedia.org/wiki/File:Classic_Daiquiri_in_Cocktail_Glass.jpg) | CC BY-SA 3.0 | Will Shenton |
| `gin-tonic.jpg` | Gin & Tonic | [Gin and tonic cocktail with wedge of lime.jpg](https://commons.wikimedia.org/wiki/File:Gin_and_tonic_cocktail_with_wedge_of_lime.jpg) | CC BY-SA 4.0 | Davidnuescheler |
| `moscow-mule.jpg` | Moscow Mule | [Moscow mule Cocktail im Kupferbecher.jpg](https://commons.wikimedia.org/wiki/File:Moscow_mule_Cocktail_im_Kupferbecher.jpg) | CC BY-SA 4.0 | Gordito1869 |
| `pina-colada.jpg` | Piña Colada | [Piña Colada.jpg](https://commons.wikimedia.org/wiki/File:Pi%C3%B1a_Colada.jpg) | Public domain | Mario Trefz (uploaded by User:Barmix) |
| `fish-and-chips.jpg` | Fish & Chips | [Fish and chips plate with peas.jpg](https://commons.wikimedia.org/wiki/File:Fish_and_chips_plate_with_peas.jpg) | CC BY-SA 4.0 | Grendelkhan |
| `chicken-parmigiana.jpg` | Chicken Parmigiana | [Chicken parmigiana with a side of rigatoni pasta.jpg](https://commons.wikimedia.org/wiki/File:Chicken_parmigiana_with_a_side_of_rigatoni_pasta.jpg) | CC BY-SA 4.0 | Gatorfan252525 |
| `mushroom-risotto.jpg` | Mushroom Risotto | [Risotto ai funghi porcini.JPG](https://commons.wikimedia.org/wiki/File:Risotto_ai_funghi_porcini.JPG) | CC BY-SA 3.0 | Number55 |
| `spaghetti-bolognese.jpg` | Spaghetti Bolognese | [Spaghetti bolognese.jpg](https://commons.wikimedia.org/wiki/File:Spaghetti_bolognese.jpg) | CC BY-SA 2.5 | Noblige |
| `caesar-salad.jpg` | Caesar Salad | [Caesar salad (2).jpg](https://commons.wikimedia.org/wiki/File:Caesar_salad_(2).jpg) | CC BY 2.0 | Geoff Peters |
| `loaded-nachos.jpg` | Loaded Nachos | [NACHOS - Montagues Tex Mex 2026-06-03.jpg](https://commons.wikimedia.org/wiki/File:NACHOS_-_Montagues_Tex_Mex_2026-06-03.jpg) | CC0 | Andy Li |

### Known limitation: `manhattan.jpg`

This photo shows two Manhattan cocktails shot from directly above, rather
than the more common straight-on single-glass framing the rest of this
set uses — the best-composed, correctly-licensed single-glass candidates
found either lacked the recipe's own cherry garnish (showing an orange
peel instead, which is a different, equally real variation but not what
this menu's own `ingredients`/mixology-book recipe calls for) or carried
a questionable license. This photo was chosen because it's the clearest
unambiguous match for the actual recipe (rye, vermouth, bitters, cherry
garnish) even though the camera angle is unusual, and it's disclosed here
rather than silently presented as a typical shot.

### A note on fetching these images

This round's downloads used Wikimedia's own MediaWiki `imageinfo` API with
`iiurlwidth=900` to request a pre-rendered, CDN-cached thumbnail URL for
each file, rather than repeatedly pulling multi-megabyte full-resolution
originals — the first attempt did the latter and was rate-limited (HTTP
429) by Wikimedia's own upload servers, whose error text explicitly asks
automated callers to "use thumbnail images in sizes listed on
https://w.wiki/GHai" instead; switching to the thumbnail API (plus a
real delay between requests) is that fix, not a workaround around it.

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
