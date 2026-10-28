// The counter's front-of-house menu, reimagined as a physical,
// page-turning book sitting on the bar counter — replacing the old
// "Mixology book" + "Meals/Drinks" HUD buttons with a single in-scene
// entry point (CLAUDE.md). This module owns the book's own shell: the
// cover/table-of-contents, the paginated Meals/Drinks spreads, each
// item's detail page (recipe vs. order, kept clearly separate), and
// "What you're holding". The existing Mixology book tool is folded in
// as one of the book's own pages via `mixologyModule.createMixology(...)
// .embed(...)` — its pantry/party-list logic is untouched, just given a
// new home inside this book's chrome instead of its own standalone
// dialog (the standalone dialog still exists and still passes its own
// tests; this is an additional, non-destructive way to reach the same
// instance's content).
//
// Every cross-module reference here arrives as a constructor parameter
// (`mixologyModule`, `ordersApi`) rather than a nested static import —
// the same discipline public/tavern.js already follows for
// createMixology/createOrders, so every real reference still flows
// through app.js's own single, versioned dynamic import per module
// (CLAUDE.md: every client module participates in the deployed asset
// hash via a cache-busted fetch, not a second, unversioned path to the
// same file).
export function createMenuBook({ el, mixologyModule, ordersApi }) {
  const { createMixology, RECIPES, INGREDIENTS, scaleRecipe, quantity } = mixologyModule;
  const mixology = createMixology({ el });

  let dialog = null, previousFocus = null, session = null;
  let menu = null, held = [];
  // stage: 'cover' | 'list' | 'detail' | 'held' | 'mixology'
  let stage = 'cover';
  let listKind = 'meal';
  let listIndex = 0; // index of the left-hand page within listKind's items
  let detailItem = null;
  let detailTab = 'recipe'; // 'recipe' | 'order'
  let selectedVariant = null;
  let root = null, header = null, pageIndicator = null, content = null, pager = null;
  let mixologyMount = null;
  const reduceMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener(){}, removeEventListener(){} };
  const spreadQuery = typeof matchMedia === 'function' ? matchMedia('(min-width: 821px)') : { matches: true, addEventListener(){}, removeEventListener(){} };
  const onSpreadChange = () => render();
  spreadQuery.addEventListener?.('change', onSpreadChange);

  function itemsOfKind(kind) { return (menu || []).filter((m) => m.kind === kind); }
  function heldOfKind(kind) { return held.find((h) => h.kind === kind && h.state === 'held'); }

  // The recipe actually shown for an item — the Mixology book's own
  // entry for a drink that already exists there (so the two never
  // disagree about the same cocktail), or this item's own ingredients/
  // steps for everything else.
  function recipeFor(item) {
    if (item.mixologyRecipeId) {
      const r = RECIPES.find((x) => x.id === item.mixologyRecipeId);
      if (r) {
        const scaled = scaleRecipe(r, 1);
        return {
          ingredients: scaled.map((i) => ({ item: INGREDIENTS[i.id][0], amount: quantity(i.amount, i.unit, i.estimated) })),
          steps: r.steps,
          garnish: r.garnish,
          source: r.source,
        };
      }
    }
    return { ingredients: item.ingredients || [], steps: item.steps || [], garnish: null, source: null };
  }

  function ingredientSummary(item) {
    const r = recipeFor(item);
    return r.ingredients.slice(0, 3).map((i) => i.item).join(', ');
  }

  function imageWithFallback(item) {
    const fallback = el('div', { class: 'menu-img-fallback', role: 'img', 'aria-label': item.imageAlt }, item.name);
    const img = el('img', {
      class: 'menu-img', src: item.image, alt: item.imageAlt, loading: 'lazy',
      onerror: () => { img.replaceWith(fallback); },
    });
    return img;
  }

  function newIdempotencyKey() {
    return `${session.playerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  async function refreshHeld() {
    try { held = await ordersApi.fetchHeld(session); } catch { /* best-effort */ }
  }

  async function doOrder(item, variant, status) {
    try {
      const idempotencyKey = newIdempotencyKey();
      await ordersApi.placeOrder(session, { itemId: item.id, variant, idempotencyKey });
      await refreshHeld();
      status.textContent = `Ordered ${item.name}${variant ? `, ${variant.toLowerCase()}` : ''}.`;
      render();
    } catch (e) {
      status.textContent = e.message || 'Could not place that order.';
    }
  }

  async function doConsume(heldItem, status) {
    try {
      await ordersApi.consumeHeld(session, heldItem.id);
      await refreshHeld();
      status.textContent = `${heldItem.kind === 'meal' ? 'Ate' : 'Drank'} ${heldItem.itemName}. Stamina restored.`;
      render();
    } catch (e) {
      status.textContent = e.message || 'Could not finish that.';
    }
  }

  // ---- Page renderers ----

  function renderCover() {
    content.replaceChildren(el('div', { class: 'menu-cover' }, [
      el('p', { class: 'mix-subtitle' }, 'Three things live in this book.'),
      el('div', { class: 'menu-cover-entries' }, [
        el('button', { class: 'menu-cover-entry', onclick: () => openMixologyPage() }, [
          el('strong', {}, 'The Mixology Book'), el('span', {}, 'Plan real drinks from what’s in your own kitchen.'),
        ]),
        el('button', { class: 'menu-cover-entry', onclick: () => openList('meal', 0) }, [
          el('strong', {}, 'Meals'), el('span', {}, 'Order something to eat.'),
        ]),
        el('button', { class: 'menu-cover-entry', onclick: () => openList('drink', 0) }, [
          el('strong', {}, 'Drinks'), el('span', {}, 'Order something to drink.'),
        ]),
      ]),
    ]));
    pager.replaceChildren();
  }

  function itemPage(item) {
    const activeHeld = heldOfKind(item.kind);
    return el('article', { class: 'menu-item-page' }, [
      imageWithFallback(item),
      el('div', { class: 'menu-item-copy' }, [
        el('h2', {}, item.name),
        el('p', { class: 'menu-item-desc' }, item.description),
        el('p', { class: 'menu-item-ingredients' }, `Main ingredients: ${ingredientSummary(item)}`),
        el('p', { class: 'menu-item-kcal' }, `≈ ${item.kcalEstimate} kcal / serving`),
        el('div', { class: 'menu-item-actions' }, [
          el('button', { onclick: () => openDetail(item, 'recipe') }, 'View recipe'),
          el('button', {
            class: 'mix-primary', disabled: !!activeHeld,
            onclick: () => openDetail(item, 'order'),
          }, activeHeld ? `Already holding a ${item.kind}` : 'Order'),
        ]),
      ]),
    ]);
  }

  function renderList() {
    const items = itemsOfKind(listKind);
    const spread = spreadQuery.matches;
    const perPage = spread ? 2 : 1;
    if (listIndex >= items.length) listIndex = Math.max(0, items.length - perPage);
    const shown = items.slice(listIndex, listIndex + perPage);
    content.replaceChildren(el('div', { class: `menu-spread${spread ? ' two-page' : ''}` }, shown.map(itemPage)));
    const lastPage = Math.max(0, Math.ceil(items.length / perPage) - 1);
    const currentPage = Math.floor(listIndex / perPage);
    pager.replaceChildren(
      el('button', { onclick: () => turnPage(-perPage), disabled: listIndex <= 0 }, '◀ Prev'),
      el('span', { class: 'menu-page-number' }, `Page ${currentPage + 1} of ${lastPage + 1}`),
      el('button', { onclick: () => turnPage(perPage), disabled: listIndex + perPage >= items.length }, 'Next ▶'),
    );
  }

  function turnPage(delta) {
    const items = itemsOfKind(listKind);
    const next = Math.max(0, Math.min(items.length - 1, listIndex + delta));
    if (next === listIndex) return;
    const finish = () => { listIndex = next; stage = 'list'; render(); };
    if (reduceMotion.matches) { finish(); return; }
    const dir = delta > 0 ? 'next' : 'prev';
    content.classList.add(`page-turn-${dir}`);
    setTimeout(() => { content.classList.remove(`page-turn-${dir}`); finish(); }, 220);
  }

  function renderDetail() {
    const item = detailItem;
    const recipe = recipeFor(item);
    const tabs = el('nav', { class: 'menu-detail-tabs', 'aria-label': 'Recipe or order' }, [
      el('button', { 'aria-pressed': String(detailTab === 'recipe'), class: detailTab === 'recipe' ? 'selected' : '', onclick: () => { detailTab = 'recipe'; render(); } }, 'How it’s made'),
      el('button', { 'aria-pressed': String(detailTab === 'order'), class: detailTab === 'order' ? 'selected' : '', onclick: () => { detailTab = 'order'; render(); } }, 'Order'),
    ]);
    const body = [
      el('button', { class: 'mix-back', onclick: () => { stage = 'list'; render(); } }, '← Back to list'),
      el('div', { class: 'menu-detail-hero' }, [imageWithFallback(item), el('div', {}, [
        el('p', { class: 'mix-eyebrow' }, item.kind === 'meal' ? 'MEAL' : 'DRINK'),
        el('h2', {}, item.name),
        el('p', {}, item.description),
        el('p', { class: 'menu-item-kcal' }, [
          `≈ ${item.kcalEstimate} kcal / serving`,
          item.variantNote ? el('small', {}, item.variantNote) : null,
        ].filter(Boolean)),
      ])]),
      tabs,
    ];
    if (detailTab === 'recipe') {
      body.push(el('div', { class: 'menu-recipe' }, [
        el('h3', {}, 'Ingredients'),
        el('ul', { class: 'mix-measures' }, recipe.ingredients.map((i) => el('li', {}, [el('span', {}, i.item), el('strong', {}, i.amount)]))),
        el('h3', {}, 'Steps'),
        el('ol', {}, recipe.steps.map((s) => el('li', {}, s))),
        recipe.garnish ? el('p', {}, `Garnish: ${recipe.garnish}.`) : null,
        el('div', { class: 'mix-source' }, [
          el('p', {}, (recipe.source || item.kcalSource).note),
          el('a', { href: (recipe.source || item.kcalSource).url, target: '_blank', rel: 'noopener' }, `Source · ${(recipe.source || item.kcalSource).name}`),
        ]),
        el('p', { class: 'mix-small' }, 'Viewing this recipe never places an order — use the Order tab above to actually order.'),
      ].filter(Boolean)));
    } else {
      const status = el('p', { class: 'mix-storage', role: 'status' });
      const error = el('p', { class: 'error', role: 'alert' });
      const activeHeld = heldOfKind(item.kind);
      if (activeHeld) {
        body.push(el('p', {}, `You're already holding a ${item.kind} (${activeHeld.itemName}) — finish it from "What you're holding" before ordering another.`));
      } else {
        if (item.variants?.length && !item.variants.some((v) => v.label === selectedVariant)) selectedVariant = item.variants[0].label;
        if (item.variants?.length) {
          body.push(el('div', { class: 'order-variants' }, item.variants.map((v) => el('label', {}, [
            el('input', { type: 'radio', name: 'variant', checked: selectedVariant === v.label, onchange: () => { selectedVariant = v.label; } }),
            ` ${v.label}`,
          ]))));
        } else {
          selectedVariant = null;
        }
        const confirmLabel = () => item.name + (selectedVariant ? `, ${selectedVariant.toLowerCase()}` : '');
        body.push(el('button', {
          class: 'mix-primary',
          onclick: async () => { error.textContent = ''; await doOrder(item, selectedVariant, status); },
        }, `Confirm order — ${confirmLabel()}`));
      }
      body.push(error, status);
    }
    content.replaceChildren(el('div', { class: 'menu-detail' }, body.filter(Boolean)));
    pager.replaceChildren();
  }

  function renderHeld() {
    const status = el('p', { class: 'mix-storage', role: 'status' });
    const list = !held.length
      ? el('p', { class: 'mix-small' }, "You aren't holding anything yet.")
      : el('ul', { class: 'order-held' }, held.map((h) => el('li', {}, [
          el('span', {}, `${h.itemName}${h.variant ? `, ${h.variant.toLowerCase()}` : ''}`),
          h.state === 'consumed'
            ? el('small', {}, 'Already eaten/drunk')
            : el('button', { class: 'mix-primary', onclick: () => doConsume(h, status) }, h.kind === 'meal' ? 'Eat' : 'Drink'),
        ])));
    content.replaceChildren(el('h2', {}, "What you're holding"),
      el('p', { class: 'mix-subtitle' }, 'One meal and one drink at a time — eat or drink before ordering another of the same kind.'),
      list, status);
    pager.replaceChildren();
  }

  function renderMixology() {
    content.replaceChildren();
    if (!mixologyMount) mixologyMount = mixology.embed(content);
    else content.append(mixologyMount.root);
    pager.replaceChildren();
  }

  function updateHeader() {
    const title = stage === 'cover' ? 'The Counter’s Book'
      : stage === 'mixology' ? 'The Mixology Book'
      : stage === 'held' ? "What you're holding"
      : stage === 'detail' ? detailItem.name
      : listKind === 'meal' ? 'Meals' : 'Drinks';
    header.querySelector('h1').textContent = title;
    header.querySelector('.menu-cover-nav').replaceChildren(
      stage !== 'cover' ? el('button', { onclick: () => { stage = 'cover'; render(); } }, '← Cover') : null,
      stage !== 'held' ? el('button', { onclick: () => { stage = 'held'; render(); } }, "What you're holding") : null,
    );
  }

  function render() {
    updateHeader();
    if (stage === 'cover') renderCover();
    else if (stage === 'list') renderList();
    else if (stage === 'detail') renderDetail();
    else if (stage === 'held') renderHeld();
    else if (stage === 'mixology') renderMixology();
  }

  function openList(kind, index) { stage = 'list'; listKind = kind; listIndex = index; render(); }
  function openDetail(item, tab) { stage = 'detail'; detailItem = item; detailTab = tab; selectedVariant = item.variants?.[0]?.label ?? null; render(); }
  function openMixologyPage() { stage = 'mixology'; render(); }

  function close() {
    if (!dialog) return;
    const old = dialog; dialog = null;
    old.close(); old.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }

  async function open(container, activeSession) {
    if (dialog) return;
    session = activeSession ?? null;
    previousFocus = document.activeElement;
    stage = 'cover';
    try {
      if (!menu) menu = await ordersApi.fetchMenu();
      await refreshHeld();
    } catch { /* menu/held best-effort; book still opens */ }

    header = el('header', { class: 'mix-header menu-book-header' }, [
      el('div', {}, [el('p', { class: 'mix-eyebrow' }, 'LAS VEGAS · THE COUNTER'), el('h1', { id: 'menu-book-title' }, 'The Counter’s Book')]),
      el('div', { class: 'menu-cover-nav' }),
      el('button', { class: 'mix-close', 'aria-label': 'Close the book', onclick: close }, '×'),
    ]);
    content = el('div', { class: 'mix-main menu-book-content' });
    pager = el('div', { class: 'menu-pager' });
    root = el('div', { class: 'menu-book-shell' }, [content, pager]);
    dialog = el('dialog', { class: 'mixology-book menu-book', 'aria-labelledby': 'menu-book-title' }, [header, root]);
    const book = dialog;
    book.addEventListener('close', () => { if (dialog === book) close(); });
    container.append(dialog);
    render();
    dialog.showModal();
    if (!reduceMotion.matches) {
      dialog.classList.add('menu-book-opening');
      setTimeout(() => dialog?.classList.remove('menu-book-opening'), 260);
    }
  }

  return { open, close };
}
