// The counter's front-of-house Meals/Drinks menu — a separate client
// module from mixology.js, same createX({el}) -> {open, close} shape.
// Virtual consumption only: no balance, no payment, nothing that could
// run short (src/orders.ts). Browsing, previewing a preparation choice,
// and placing an order never restore stamina — only an explicit "Eat"/
// "Drink" on an already-held item does, via POST /api/orders/consume.
export function createOrders({ el }) {
  let dialog = null, previousFocus = null, session = null;
  let menu = null, held = [], view = 'meal', selectedVariant = null;
  let main, status, navButtons;

  const post = async (path, body) => {
    const r = await fetch('/api/orders' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw Object.assign(new Error(data.message || 'Request failed'), { status: r.status, code: data.code });
    return data;
  };
  const get = async (path) => {
    const r = await fetch('/api/orders' + path);
    const data = await r.json(); if (!r.ok) throw Object.assign(new Error(data.message || 'Request failed'), { status: r.status, code: data.code });
    return data;
  };

  async function loadMenu() {
    if (!menu) menu = (await get('/menu')).menu;
    return menu;
  }
  async function loadHeld() {
    if (!session) { held = []; return held; }
    const qs = new URLSearchParams({ playerId: session.playerId, sessionSecret: session.sessionSecret });
    held = (await get('/held?' + qs.toString())).items;
    return held;
  }

  function nav() {
    for (const [name, button] of Object.entries(navButtons)) {
      button.setAttribute('aria-pressed', String(view === name));
      button.classList.toggle('selected', view === name);
    }
  }

  function heldOfKind(kind) { return held.find((h) => h.kind === kind && h.state === 'held'); }

  function itemCard(item) {
    const activeKindHeld = heldOfKind(item.kind);
    const disabled = !!activeKindHeld;
    return el('article', { class: 'order-card' }, [
      el('h3', {}, item.name),
      el('p', { class: 'order-desc' }, item.description),
      el('p', { class: 'order-note' }, item.recipeNote),
      el('p', { class: 'order-restore' }, `Restores +${item.restoreAmount}% stamina`),
      el('button', {
        class: 'mix-primary', disabled,
        onclick: () => openOrderPicker(item),
      }, disabled ? `Already holding a ${item.kind}` : 'Order'),
    ]);
  }

  function openOrderPicker(item) {
    selectedVariant = item.variants?.[0]?.label ?? null;
    const error = el('p', { class: 'error', role: 'alert' });
    const confirmLabel = () => item.name + (selectedVariant ? `, ${selectedVariant.toLowerCase()}` : '');
    const confirmBtn = el('button', { class: 'mix-primary', onclick: async () => {
      error.textContent = '';
      try {
        const idempotencyKey = `${session.playerId}:${item.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        await post('/place', { ...session, itemId: item.id, variant: selectedVariant, idempotencyKey });
        await loadHeld();
        switchView(view);
        status.textContent = `Ordered ${confirmLabel()}.`;
      } catch (e) {
        error.textContent = e.message || 'Could not place that order.';
      }
    } }, `Confirm ${item.kind === 'meal' ? 'meal' : 'drink'}`);
    const body = [
      el('p', { class: 'mix-eyebrow' }, item.kind === 'meal' ? 'MEAL' : 'DRINK'),
      el('h2', {}, item.name),
      el('p', {}, item.recipeNote),
    ];
    if (item.variants?.length) {
      body.push(el('div', { class: 'order-variants' }, item.variants.map((v) =>
        el('label', {}, [
          el('input', { type: 'radio', name: 'variant', checked: selectedVariant === v.label, onchange: () => { selectedVariant = v.label; } }),
          ` ${v.label}`,
        ]),
      )));
    }
    body.push(error, el('div', { class: 'mix-copy-actions' }, [confirmBtn, el('button', { onclick: () => switchView(view) }, 'Cancel')]));
    main.replaceChildren(...body);
  }

  function heldSection() {
    if (!session) return el('p', { class: 'mix-small' }, 'Join the tavern to hold and eat/drink items.');
    if (!held.length) return el('p', { class: 'mix-small' }, "You aren't holding anything yet.");
    return el('ul', { class: 'order-held' }, held.map((h) => el('li', {}, [
      el('span', {}, `${h.itemName}${h.variant ? `, ${h.variant.toLowerCase()}` : ''}`),
      h.state === 'consumed'
        ? el('small', {}, 'Already eaten/drunk')
        : el('button', { class: 'mix-primary', onclick: async () => {
            try {
              await post('/consume', { ...session, heldItemId: h.id });
              await loadHeld();
              switchView(view);
              status.textContent = `${h.kind === 'meal' ? 'Ate' : 'Drank'} ${h.itemName}. Stamina restored.`;
            } catch (e) {
              status.textContent = e.message || 'Could not finish that.';
            }
          } }, h.kind === 'meal' ? 'Eat' : 'Drink'),
    ])));
  }

  function switchView(next) {
    view = next; nav();
    if (view === 'held') {
      main.replaceChildren(el('h2', {}, 'What you\'re holding'), el('p', { class: 'mix-subtitle' }, 'One meal and one drink at a time — eat or drink before ordering another of the same kind.'), heldSection());
      return;
    }
    const items = menu.filter((m) => m.kind === view);
    main.replaceChildren(
      el('h2', {}, view === 'meal' ? 'Meals' : 'Drinks'),
      el('p', { class: 'mix-subtitle' }, view === 'meal' ? 'A meal restores +70% stamina.' : 'A drink restores +30% stamina.'),
      el('div', { class: 'order-grid' }, items.map(itemCard)),
    );
  }

  function close() {
    if (dialog) { const old = dialog; dialog = null; old.close(); old.remove(); if (previousFocus?.isConnected) previousFocus.focus(); }
  }

  async function open(container, activeSession) {
    if (dialog) return;
    session = activeSession ?? null;
    previousFocus = document.activeElement;
    try { await loadMenu(); await loadHeld(); } catch { /* menu/held best-effort; dialog still opens */ }
    view = 'meal';
    navButtons = {}; main = el('div', { class: 'mix-main' }); status = el('p', { class: 'mix-storage', role: 'status' });
    const navigation = el('nav', { 'aria-label': 'Menu sections' });
    for (const [id, label] of [['meal', 'Meals'], ['drink', 'Drinks'], ['held', 'What you\'re holding']]) {
      const b = el('button', { onclick: () => switchView(id) }, label);
      navButtons[id] = b; navigation.append(b);
    }
    dialog = el('dialog', { class: 'mixology-book order-menu', 'aria-labelledby': 'order-title' }, [
      el('header', { class: 'mix-header' }, [
        el('div', {}, [el('p', { class: 'mix-eyebrow' }, 'LAS VEGAS · THE COUNTER'), el('h1', { id: 'order-title' }, 'Meals & Drinks')]),
        el('button', { class: 'mix-close', 'aria-label': 'Close menu', onclick: close }, '×'),
      ]),
      navigation, main, status,
    ]);
    const book = dialog;
    book.addEventListener('close', () => { if (dialog === book) close(); });
    container.append(dialog);
    switchView('meal');
    dialog.showModal();
  }

  return { open, close };
}
