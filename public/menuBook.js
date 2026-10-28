// The counter's front-of-house menu, as an actual physical book: two
// pages lie open side by side with a spine gutter between them, bound in
// a dark leather cover, and turning a page rotates a hinged leaf in 3D
// (a front face and a back face, each hidden from view when turned away
// via backface-visibility) rather than crossfading or sliding content.
// Replaces the old "Mixology book" + "Meals/Drinks" HUD buttons with one
// in-scene entry point (CLAUDE.md). The existing Mixology book tool is
// folded in as one of the book's own chapters via
// `mixologyModule.createMixology(...).embed(...)` — its pantry/party-list
// logic is untouched, just given a new home inside this book's pages
// instead of its own standalone dialog (the standalone dialog still
// exists and still passes its own tests).
//
// Two distinct turning gestures, both real 3D hinge flips, never a
// crossfade:
//  - Sequential Prev/Next (within one chapter's flat page list) turns
//    exactly one leaf. The leaf starts sized/positioned over whichever
//    slot it's leaving (hinged at that slot's spine-side edge) and, by
//    rotating a full 180°, ends up occupying the *other* slot's exact
//    rectangle (a flat page swept end-to-end around a vertical axis maps
//    onto its own mirror position — no translation needed). Its front
//    face is a snapshot of the slot it starts on; its back face is the
//    new content for the slot it lands on. The real DOM underneath the
//    starting slot is swapped the instant the turn begins (already
//    hidden under the leaf); the real DOM underneath the landing slot is
//    swapped right before the leaf is removed at the end (already
//    matching the leaf's own back face by then) — so the swap is never
//    visible either time.
//  - A bookmark/chapter jump (cover <-> a chapter, opening an item's
//    detail spread, "Back") turns the *entire* two-page spread at once,
//    as one wide leaf sized to the whole book — still a real hinge-and-
//    faces turn, just sized to the whole spread rather than one page.
//
// Every cross-module reference here arrives as a constructor parameter
// (`mixologyModule`, `ordersApi`) rather than a nested static import —
// the same discipline public/tavern.js already follows, so every real
// reference still flows through app.js's own single, versioned dynamic
// import per module (CLAUDE.md: every client module participates in the
// deployed asset hash via a cache-busted fetch).
export function createMenuBook({ el, mixologyModule, ordersApi }) {
  const { createMixology, RECIPES, INGREDIENTS, scaleRecipe, quantity } = mixologyModule;
  const mixology = createMixology({ el });

  let dialog = null, previousFocus = null, session = null;
  let menu = null, held = [];
  // stage: 'cover' | 'mixology' | 'list' | 'detail' | 'held'
  let stage = 'cover';
  let listKind = 'meal';
  let cursor = 0; // index of the first page shown, within the current stage's flat page list
  let detailItem = null;
  let detailReturn = { listKind: 'meal', cursor: 0 }; // where "Back" returns to
  let selectedVariant = null;
  let isFlipping = false;
  let mixologyMount = null;

  let book = null, pagesEl = null, bookmarksEl = null, navEl = null, srTitle = null;
  let cornerPrev = null, cornerNext = null;

  const reduceMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener(){}, removeEventListener(){} };
  const spreadQuery = typeof matchMedia === 'function' ? matchMedia('(min-width: 821px)') : { matches: true, addEventListener(){}, removeEventListener(){} };
  const onLayoutChange = () => { if (dialog && !isFlipping) setSlotsInstant(buildPagesContent()); };
  spreadQuery.addEventListener?.('change', onLayoutChange);

  const FLIP_MS = 600;

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

  async function doOrder(item, variant, statusEl) {
    try {
      const idempotencyKey = newIdempotencyKey();
      await ordersApi.placeOrder(session, { itemId: item.id, variant, idempotencyKey });
      await refreshHeld();
      statusEl.textContent = `Ordered ${item.name}${variant ? `, ${variant.toLowerCase()}` : ''}.`;
      if (!isFlipping) setSlotsInstant(buildPagesContent());
    } catch (e) {
      statusEl.textContent = e.message || 'Could not place that order.';
    }
  }

  async function doConsume(heldItem, statusEl) {
    try {
      await ordersApi.consumeHeld(session, heldItem.id);
      await refreshHeld();
      statusEl.textContent = `${heldItem.kind === 'meal' ? 'Ate' : 'Drank'} ${heldItem.itemName}. Stamina restored.`;
      if (!isFlipping) setSlotsInstant(buildPagesContent());
    } catch (e) {
      statusEl.textContent = e.message || 'Could not finish that.';
    }
  }

  function backLink() {
    return el('button', { class: 'book-backlink', onclick: () => goBackFromDetail() }, '← Back to the list');
  }

  // ---- Page builders — each returns a Node for one physical page. ----

  function coverLeftPage() {
    return el('div', { class: 'book-page book-cover-face' }, [
      el('p', { class: 'book-eyebrow' }, 'LAS VEGAS · THE COUNTER'),
      el('h1', { class: 'book-title' }, 'The Counter’s Book'),
      el('p', { class: 'book-cover-note' }, 'A recipe book, a meal menu and a drinks menu, bound as one.'),
      el('div', { class: 'book-cover-mark', 'aria-hidden': 'true' }, '🍸'),
    ]);
  }

  function coverRightPage() {
    return el('div', { class: 'book-page' }, [
      el('p', { class: 'book-running-head' }, 'Contents'),
      el('ul', { class: 'book-toc' }, [
        ['mixology', 'The Mixology Book', 'Plan real drinks from what’s in your own kitchen.'],
        ['meal', 'Meals', 'Order something to eat.'],
        ['drink', 'Drinks', 'Order something to drink.'],
      ].map(([key, label, desc]) => el('li', {}, [
        el('button', { class: 'book-toc-entry', onclick: () => goToChapter(key) }, [
          el('strong', {}, label), el('span', {}, desc),
        ]),
      ]))),
    ]);
  }

  function blankPage() {
    return el('div', { class: 'book-page book-blank' }, el('span', { class: 'book-blank-mark', 'aria-hidden': 'true' }, '❧'));
  }

  function itemPage(item) {
    const activeHeld = heldOfKind(item.kind);
    return el('div', { class: 'book-page' }, [
      el('p', { class: 'book-running-head' }, listKind === 'meal' ? 'Meals' : 'Drinks'),
      imageWithFallback(item),
      el('h2', {}, item.name),
      el('p', { class: 'menu-item-desc' }, item.description),
      el('p', { class: 'menu-item-kcal' }, `≈ ${item.kcalEstimate} kcal / serving`),
      el('button', {
        class: 'mix-primary book-details-btn',
        onclick: () => openDetail(item),
      }, activeHeld ? 'Details (already holding one) →' : 'Details →'),
    ]);
  }

  function detailLeftPage(item) {
    return el('div', { class: 'book-page' }, [
      el('p', { class: 'book-running-head' }, item.kind === 'meal' ? 'Meals' : 'Drinks'),
      imageWithFallback(item),
      el('h2', {}, item.name),
      el('p', { class: 'menu-item-desc' }, item.description),
      el('p', { class: 'menu-item-kcal' }, [
        `≈ ${item.kcalEstimate} kcal / serving`,
        item.variantNote ? el('small', {}, item.variantNote) : null,
      ].filter(Boolean)),
    ]);
  }

  function detailRightPage(item) {
    const recipe = recipeFor(item);
    const status = el('p', { class: 'mix-storage', role: 'status' });
    const error = el('p', { class: 'error', role: 'alert' });
    const activeHeld = heldOfKind(item.kind);
    const body = [
      backLink(),
      el('h3', {}, 'Ingredients'),
      el('ul', { class: 'mix-measures' }, recipe.ingredients.map((i) => el('li', {}, [el('span', {}, i.item), el('strong', {}, i.amount)]))),
      el('h3', {}, 'Steps'),
      el('ol', {}, recipe.steps.map((s) => el('li', {}, s))),
      recipe.garnish ? el('p', {}, `Garnish: ${recipe.garnish}.`) : null,
      el('div', { class: 'mix-source' }, [
        el('p', {}, (recipe.source || item.kcalSource).note),
        el('a', { href: (recipe.source || item.kcalSource).url, target: '_blank', rel: 'noopener' }, `Source · ${(recipe.source || item.kcalSource).name}`),
      ]),
      el('h3', {}, item.kind === 'meal' ? 'Order this meal' : 'Order this drink'),
    ];
    if (activeHeld) {
      body.push(el('p', {}, `You're already holding a ${item.kind} (${activeHeld.itemName}) — finish it from the "Holding" bookmark before ordering another.`));
    } else {
      if (item.variants?.length && !item.variants.some((v) => v.label === selectedVariant)) selectedVariant = item.variants[0].label;
      const confirmLabel = () => item.name + (selectedVariant ? `, ${selectedVariant.toLowerCase()}` : '');
      const confirmBtn = el('button', {
        class: 'mix-primary',
        onclick: async () => { error.textContent = ''; await doOrder(item, selectedVariant, status); },
      }, `Confirm order — ${confirmLabel()}`);
      if (item.variants?.length) {
        body.push(el('div', { class: 'order-variants' }, item.variants.map((v) => el('label', {}, [
          el('input', {
            type: 'radio', name: 'variant', checked: selectedVariant === v.label,
            // Updates the already-built confirm button's own label in
            // place — a variant pick must never re-render the whole page
            // (which would restart the detail spread's own flip-in
            // transition for no reason), just reflect the new choice.
            onchange: () => { selectedVariant = v.label; confirmBtn.textContent = `Confirm order — ${confirmLabel()}`; },
          }),
          ` ${v.label}`,
        ]))));
      } else {
        selectedVariant = null;
      }
      body.push(confirmBtn);
    }
    body.push(error, status);
    return el('div', { class: 'book-page' }, body.filter(Boolean));
  }

  function heldPage() {
    const status = el('p', { class: 'mix-storage', role: 'status' });
    const list = !held.length
      ? el('p', { class: 'mix-small' }, "You aren't holding anything yet.")
      : el('ul', { class: 'order-held' }, held.map((h) => el('li', {}, [
          el('span', {}, `${h.itemName}${h.variant ? `, ${h.variant.toLowerCase()}` : ''}`),
          h.state === 'consumed'
            ? el('small', {}, 'Already eaten/drunk')
            : el('button', { class: 'mix-primary', onclick: () => doConsume(h, status) }, h.kind === 'meal' ? 'Eat' : 'Drink'),
        ])));
    return el('div', { class: 'book-page' }, [
      el('p', { class: 'book-running-head' }, 'Holding'),
      el('h2', {}, "What you're holding"),
      el('p', { class: 'mix-subtitle' }, 'One meal and one drink at a time — eat or drink before ordering another of the same kind.'),
      list, status,
    ]);
  }

  // ---- Flat page lists per stage, and the two-slot spread they fill ----

  function flatPages() {
    if (stage === 'cover') return [coverLeftPage, coverRightPage];
    if (stage === 'list') return itemsOfKind(listKind).map((item) => () => itemPage(item));
    if (stage === 'detail') return [() => detailLeftPage(detailItem), () => detailRightPage(detailItem)];
    if (stage === 'held') return [heldPage];
    return []; // 'mixology' doesn't paginate — see buildPagesContent
  }

  function perPage() { return stage === 'cover' ? 2 : (spreadQuery.matches ? 2 : 1); }

  function pagerInfo() {
    const pages = flatPages();
    const per = perPage();
    const total = Math.max(1, Math.ceil(pages.length / per));
    const current = Math.floor(cursor / per);
    return { total, current, hasPrev: cursor > 0, hasNext: cursor + per < pages.length, pages, per };
  }

  function buildTwoSlotNodes(pages, idx, per) {
    const left = pages[idx] ? pages[idx]() : blankPage();
    const right = per === 2 ? (pages[idx + 1] ? pages[idx + 1]() : blankPage()) : null;
    return [left, right];
  }

  function buildPagesContent() {
    if (stage === 'mixology') {
      if (!mixologyMount) mixologyMount = mixology.embed(document.createElement('div'));
      const wide = el('div', { class: 'book-page book-wide' });
      wide.append(mixologyMount.root);
      return { kind: 'wide', nodes: [wide] };
    }
    const { pages, per } = pagerInfo();
    const [left, right] = buildTwoSlotNodes(pages, cursor, per);
    return { kind: 'spread', nodes: [left, right] };
  }

  function setSlotsInstant(content) {
    if (content.kind === 'wide') {
      pagesEl.classList.add('book-pages--wide');
      pagesEl.replaceChildren(content.nodes[0]);
      updateChrome();
      return;
    }
    pagesEl.classList.remove('book-pages--wide');
    const left = el('div', { class: 'book-slot book-slot--left' }, content.nodes[0] ? [content.nodes[0]] : []);
    const hasRight = content.nodes[1] != null;
    const parts = [left];
    if (hasRight) {
      parts.push(el('div', { class: 'book-spine', 'aria-hidden': 'true' }));
      parts.push(el('div', { class: 'book-slot book-slot--right' }, [content.nodes[1]]));
    }
    pagesEl.replaceChildren(...parts);
    updateChrome();
  }

  // ---- The two real turning gestures ----

  // One leaf, hinged at the spine-side edge of whichever slot it starts
  // on, covering exactly that slot. See the file header comment for the
  // full geometric reasoning (a flat rectangle rotated 180° around its
  // own edge lands on its own mirror position — which is exactly the
  // other slot's rectangle when both slots are equal width).
  function sequentialFlip(direction) {
    const { pages, per, hasPrev, hasNext } = pagerInfo();
    if (direction === 'next' && !hasNext) return;
    if (direction === 'prev' && !hasPrev) return;
    if (isFlipping || reduceMotion.matches) {
      if (!isFlipping) { cursor = direction === 'next' ? cursor + per : cursor - per; setSlotsInstant(buildPagesContent()); }
      return;
    }
    const nextCursor = direction === 'next' ? cursor + per : cursor - per;
    const [newLeft, newRight] = buildTwoSlotNodes(pages, nextCursor, per);

    // Single-slot (mobile) mode: only one slot exists, so the leaf both
    // starts and visually lands on it — no separate "other" slot to swap.
    const singleSlot = per === 1;
    const fromSide = singleSlot ? 'left' : (direction === 'next' ? 'right' : 'left');
    const toSide = singleSlot ? 'left' : (direction === 'next' ? 'left' : 'right');
    const fromSlot = pagesEl.querySelector(`.book-slot--${fromSide}`);
    const toSlot = singleSlot ? fromSlot : pagesEl.querySelector(`.book-slot--${toSide}`);
    if (!fromSlot || !toSlot) { cursor = nextCursor; setSlotsInstant(buildPagesContent()); return; }

    const frontClone = fromSlot.cloneNode(true);
    const backContent = toSide === 'left' ? (newLeft || blankPage()) : (newRight || blankPage());
    const hingeDir = direction === 'next' ? 'forward' : 'backward';
    const leaf = buildLeaf(fromSlot, frontClone, backContent, hingeDir);

    isFlipping = true;
    book.classList.add('is-flipping');
    pagesEl.appendChild(leaf);
    // The slot the leaf starts on is fully hidden underneath it from the
    // very first frame, so its real content can change right away.
    if (!singleSlot) {
      fromSlot.replaceChildren(direction === 'next' ? (newRight || blankPage()) : (newLeft || blankPage()));
    }
    leaf.addEventListener('animationend', () => {
      // The slot the leaf lands on only needs to be correct by the
      // moment the leaf (now showing this exact content on its back
      // face) is removed — doing it here, just before removal, means
      // the two are already identical and nothing visibly changes.
      toSlot.replaceChildren(backContent);
      leaf.remove();
      cursor = nextCursor;
      isFlipping = false;
      book.classList.remove('is-flipping');
      updateChrome();
    }, { once: true });
  }

  // A whole-spread turn: one leaf sized to cover the entire open book,
  // used for chapter/bookmark jumps, opening an item's detail spread,
  // and "Back" — a bigger turn than a single page, but still a real
  // hinge-and-faces rotation, never a crossfade.
  function chapterFlip(mutate, direction) {
    if (isFlipping) return;
    if (reduceMotion.matches) { mutate(); setSlotsInstant(buildPagesContent()); return; }
    const frontClone = pagesEl.cloneNode(true);
    frontClone.classList.remove('book-pages--wide');
    mutate();
    const newContent = buildPagesContent();
    const backWrap = el('div', { class: 'book-leaf-spread' });
    if (newContent.kind === 'wide') {
      backWrap.append(newContent.nodes[0]);
    } else {
      const leftNode = el('div', { class: 'book-slot book-slot--left' }, newContent.nodes[0] ? [newContent.nodes[0]] : []);
      backWrap.append(leftNode);
      if (newContent.nodes[1] != null) backWrap.append(el('div', { class: 'book-slot book-slot--right' }, [newContent.nodes[1]]));
    }

    const leaf = buildLeaf(pagesEl, frontClone, backWrap, direction, true);
    isFlipping = true;
    book.classList.add('is-flipping');
    setSlotsInstant(newContent); // hidden under the leaf's matching front face
    pagesEl.appendChild(leaf);
    leaf.addEventListener('animationend', () => {
      leaf.remove();
      isFlipping = false;
      book.classList.remove('is-flipping');
    }, { once: true });
  }

  function buildLeaf(sizeRefEl, frontNode, backNode, direction, fullSpread = false) {
    const rect = sizeRefEl.getBoundingClientRect();
    const parentRect = pagesEl.getBoundingClientRect();
    const front = el('div', { class: 'book-leaf-face book-leaf-front' }, [frontNode]);
    const back = el('div', { class: 'book-leaf-face book-leaf-back' }, [backNode]);
    const leaf = el('div', {
      class: `book-leaf book-leaf--${direction}${fullSpread ? ' book-leaf--full' : ''}`,
    }, [front, back]);
    leaf.style.position = 'absolute';
    leaf.style.top = `${rect.top - parentRect.top}px`;
    leaf.style.left = `${rect.left - parentRect.left}px`;
    leaf.style.width = `${rect.width}px`;
    leaf.style.height = `${rect.height}px`;
    leaf.style.setProperty('--flip-ms', `${FLIP_MS}ms`);
    return leaf;
  }

  // ---- Navigation actions ----

  function goToChapter(key) {
    if (isFlipping) return;
    const already = (key === 'mixology' && stage === 'mixology') || (stage === 'list' && listKind === key && cursor === 0);
    if (already) return;
    chapterFlip(() => {
      if (key === 'mixology') { stage = 'mixology'; }
      else { stage = 'list'; listKind = key; cursor = 0; }
    }, 'forward');
  }

  function openDetail(item) {
    if (isFlipping) return;
    detailReturn = { listKind, cursor };
    chapterFlip(() => {
      stage = 'detail'; detailItem = item; cursor = 0;
      selectedVariant = item.variants?.[0]?.label ?? null;
    }, 'forward');
  }

  function goBackFromDetail() {
    if (isFlipping) return;
    chapterFlip(() => { stage = 'list'; listKind = detailReturn.listKind; cursor = detailReturn.cursor; }, 'backward');
  }

  function goHome() {
    if (isFlipping || stage === 'cover') return;
    chapterFlip(() => { stage = 'cover'; cursor = 0; }, 'backward');
  }

  function goHeld() {
    if (isFlipping || stage === 'held') return;
    chapterFlip(() => { stage = 'held'; cursor = 0; }, 'forward');
  }

  // ---- Chrome: bookmarks, bottom nav cluster, corners, SR title ----

  function updateChrome() {
    const title = stage === 'cover' ? 'The Counter’s Book'
      : stage === 'mixology' ? 'The Mixology Book'
      : stage === 'held' ? "What you're holding"
      : stage === 'detail' ? detailItem.name
      : listKind === 'meal' ? 'Meals' : 'Drinks';
    srTitle.textContent = title;

    for (const btn of bookmarksEl.querySelectorAll('[data-bookmark]')) {
      const key = btn.getAttribute('data-bookmark');
      const active = (key === 'mixology' && stage === 'mixology') || (key === 'held' && stage === 'held') || (stage === 'list' && listKind === key);
      btn.classList.toggle('is-active', active);
    }
    const holdingCount = held.filter((h) => h.state === 'held').length;
    const holdingBtn = bookmarksEl.querySelector('[data-bookmark="held"]');
    if (holdingBtn) holdingBtn.textContent = holdingCount ? `Holding (${holdingCount})` : 'Holding';

    const paginated = stage === 'list' || stage === 'detail';
    if (!paginated) {
      navEl.replaceChildren();
      navEl.hidden = true;
      cornerPrev.hidden = true;
      cornerNext.hidden = true;
      return;
    }
    const { total, current, hasPrev, hasNext } = pagerInfo();
    if (total <= 1) {
      navEl.replaceChildren();
      navEl.hidden = true;
    } else {
      navEl.hidden = false;
      navEl.replaceChildren(
        el('button', { onclick: () => sequentialFlip('prev'), disabled: !hasPrev, 'aria-label': 'Previous page' }, '◀ Prev'),
        el('span', { class: 'menu-page-number' }, `Page ${current + 1} of ${total}`),
        el('button', { onclick: () => sequentialFlip('next'), disabled: !hasNext, 'aria-label': 'Next page' }, 'Next ▶'),
      );
    }
    cornerPrev.hidden = !hasPrev;
    cornerNext.hidden = !hasNext;
  }

  function onKeydown(e) {
    if (!dialog) return;
    const active = document.activeElement;
    if (active && /^(input|textarea|select)$/i.test(active.tagName)) return;
    if (e.key === 'ArrowRight') sequentialFlip('next');
    else if (e.key === 'ArrowLeft') sequentialFlip('prev');
  }

  function close() {
    if (!dialog) return;
    const old = dialog; dialog = null;
    document.removeEventListener('keydown', onKeydown);
    old.close(); old.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }

  async function open(container, activeSession) {
    if (dialog) return;
    session = activeSession ?? null;
    previousFocus = document.activeElement;
    stage = 'cover'; cursor = 0; isFlipping = false;
    try {
      if (!menu) menu = await ordersApi.fetchMenu();
      await refreshHeld();
    } catch { /* menu/held best-effort; book still opens */ }

    srTitle = el('h1', { id: 'menu-book-title', class: 'sr-only' }, 'The Counter’s Book');
    const closeBtn = el('button', { class: 'book-close', 'aria-label': 'Close the book', onclick: close }, '×');
    const coverLink = el('button', { class: 'book-cover-link', 'aria-label': 'Back to cover', onclick: () => goHome() }, '📖');
    bookmarksEl = el('div', { class: 'book-bookmarks' }, [
      el('button', { class: 'book-bookmark', 'data-bookmark': 'mixology', onclick: () => goToChapter('mixology') }, 'The Mixology Book'),
      el('button', { class: 'book-bookmark', 'data-bookmark': 'meal', onclick: () => goToChapter('meal') }, 'Meals'),
      el('button', { class: 'book-bookmark', 'data-bookmark': 'drink', onclick: () => goToChapter('drink') }, 'Drinks'),
      el('button', { class: 'book-bookmark book-bookmark--holding', 'data-bookmark': 'held', onclick: () => goHeld() }, 'Holding'),
    ]);
    pagesEl = el('div', { class: 'book-pages' });
    cornerPrev = el('button', { class: 'book-corner book-corner--prev', 'aria-label': 'Previous page', onclick: () => sequentialFlip('prev') });
    cornerNext = el('button', { class: 'book-corner book-corner--next', 'aria-label': 'Next page', onclick: () => sequentialFlip('next') });
    navEl = el('div', { class: 'book-nav' });
    const pagesWrap = el('div', { class: 'book-pages-wrap' }, [pagesEl, cornerPrev, cornerNext, bookmarksEl]);
    book = el('div', { class: 'book' }, [closeBtn, coverLink, pagesWrap, navEl]);
    dialog = el('dialog', { class: 'book-dialog', 'aria-labelledby': 'menu-book-title' }, [srTitle, book]);
    const openedDialog = dialog;
    dialog.addEventListener('close', () => { if (dialog === openedDialog) close(); });
    container.append(dialog);
    setSlotsInstant(buildPagesContent());
    dialog.showModal();
    document.addEventListener('keydown', onKeydown);
    if (!reduceMotion.matches) {
      dialog.classList.add('menu-book-opening');
      setTimeout(() => dialog?.classList.remove('menu-book-opening'), 260);
    }
  }

  return { open, close };
}
