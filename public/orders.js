// Server communication for the counter's front-of-house menu
// (src/orders.ts) — menu lookup, held-item listing, placing an order and
// consuming a held item. No DOM here: public/menuBook.js owns the
// paginated book presentation and calls these functions directly, the
// same way it's handed the Mixology book instance rather than importing
// mixology.js itself — this is what keeps every cross-module reference
// flowing through app.js's own versioned dynamic imports (CLAUDE.md:
// every client module participates in the deployed asset hash), instead
// of a nested, unversioned `import ... from './orders.js'` that could
// silently serve a stale cached copy independent of the entry point's
// own cache-busted fetch.
async function post(path, body) {
  const r = await fetch('/api/orders' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.message || 'Request failed'), { status: r.status, code: data.code });
  return data;
}
async function get(path) {
  const r = await fetch('/api/orders' + path);
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.message || 'Request failed'), { status: r.status, code: data.code });
  return data;
}

export async function fetchMenu() {
  return (await get('/menu')).menu;
}

export async function fetchHeld(session) {
  if (!session) return [];
  const qs = new URLSearchParams({ playerId: session.playerId, sessionSecret: session.sessionSecret });
  return (await get('/held?' + qs.toString())).items;
}

export async function placeOrder(session, { itemId, variant, idempotencyKey }) {
  return post('/place', { ...session, itemId, variant, idempotencyKey });
}

export async function consumeHeld(session, heldItemId) {
  return post('/consume', { ...session, heldItemId });
}
