// HTTP-level regression coverage for the front-of-house menu's own public
// entry points (src/server.ts) — spec/orders.test.ts/spec/eating.test.ts
// already pin down the internal src/orders.ts primitives directly; this
// file exists specifically because the BUG this round fixes lived in the
// route wiring itself (a public endpoint reachable over real HTTP that
// bypassed a rule the internal primitive was never meant to enforce on
// its own), so it has to be reproduced and then verified fixed over a
// real HTTP request, not just a direct function call.

import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  // A removed route 404s with Hono's own plain-text default handler, not
  // JSON — tolerate that here rather than letting res.json() throw, since
  // "this route no longer exists at all" is itself a valid, expected
  // outcome this file's own regression test checks for.
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, baseUrl));
  return { status: res.status, body: await res.json() };
}

// ---- Regression: Codex found this directly (2026-11 review) ----
//
// POST /api/orders/consume called src/orders.ts's consumeHeldItem, which
// has never had a seat or eating-lock check of its own (by design — it's
// startEating's own internal primitive, re-used for each held item inside
// one transaction). The route that exposed it publicly, though, had no
// such check either, so a standing patron who still held an ordered item
// could hit this endpoint directly and restore stamina instantly, with no
// 8-second animation, no seat requirement, and no eating-lock at all —
// completely bypassing the entire seated-eating feature CLAUDE.md
// specifies. This must be fixed at the public surface: either the route
// enforces the exact same rule startEating does, or the route is gone
// entirely and there is no public way to reach the bypass.
it("a standing patron cannot restore stamina through the old /api/orders/consume entry point (Codex-found bypass)", async () => {
  const joined = await postJson("/api/bar/join", { nickname: "Consume Bypass", color: "red" });
  const session = { playerId: joined.body.playerId, sessionSecret: joined.body.sessionSecret };

  const order = await postJson("/api/orders/place", { ...session, itemId: "soda", variant: null, idempotencyKey: `bypass-${joined.body.playerId}` });
  expect(order.status).toBe(201);
  const heldItemId = order.body.id;

  const before = await getJson(`/api/orders/held?playerId=${session.playerId}&sessionSecret=${session.sessionSecret}`);
  expect(before.body.items.find((i: { id: string }) => i.id === heldItemId)?.state).toBe("held");

  // Standing (never sat down at all) — the old route must not let this
  // succeed and silently restore stamina/consume the item without ever
  // requiring a seat or playing the ~8s animation. The fix removes the
  // route outright (404), rather than patching a second copy of
  // startEating's own seat/lock check onto it — either way, 200 (a
  // successful bypass) must never happen.
  const bypassAttempt = await postJson("/api/orders/consume", { ...session, heldItemId });
  expect(bypassAttempt.status).not.toBe(200);
  expect(bypassAttempt.status).toBe(404);

  const after = await getJson(`/api/orders/held?playerId=${session.playerId}&sessionSecret=${session.sessionSecret}`);
  expect(after.body.items.find((i: { id: string }) => i.id === heldItemId)?.state).toBe("held");
});
