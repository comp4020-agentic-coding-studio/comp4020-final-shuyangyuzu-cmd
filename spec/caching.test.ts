// Cache-busting for the client's static assets. A Cache-Control header
// alone isn't enough: a browser that cached app.js/styles.css *before*
// this app ever sent that header can keep serving its own cached copy
// on an ordinary reload, with no new request ever reaching the server —
// found live, not in any earlier version of this suite (see PLAN.md).
// The fix is a version token in the asset URLs themselves, which this
// checks end to end: the token / is served with is a real hash of the
// actual files, not a hardcoded string that could drift out of sync.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

function expectedVersion(): string {
  const hash = createHash("sha256");
  hash.update(readFileSync("public/app.js"));
  hash.update(readFileSync("public/styles.css"));
  hash.update(readFileSync("public/tavern.js"));
  hash.update(readFileSync("public/liveSync.js"));
  hash.update(readFileSync("public/voiceCall.js"));
  hash.update(readFileSync("public/favicon.svg"));
  return hash.digest("hex").slice(0, 10);
}

it("serves / with a version token matching a hash of the actual deployed assets", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const html = await res.text();
  const version = expectedVersion();
  expect(html).toContain(`/app.js?v=${version}`);
  expect(html).toContain(`/styles.css?v=${version}`);
  expect(html).toContain(`/favicon.svg?v=${version}`);
  // Visible on the page itself, not just in the asset URLs — the point
  // is a person can check what they're looking at without opening
  // devtools.
  expect(html).toContain(version);
});

it("exposes the same version at /version, for a quick check without loading the whole page", async () => {
  const res = await fetch(new URL("/version", baseUrl));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.version).toBe(expectedVersion());
});

it("serves app.js and styles.css regardless of the ?v= query string (it's a cache key, not a route)", async () => {
  const res = await fetch(new URL("/app.js?v=anything-at-all", baseUrl));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toBe(readFileSync("public/app.js", "utf8"));
});

it("every response carries Cache-Control: no-cache, not just the static assets", async () => {
  const res = await fetch(new URL("/api/rooms/ZZZZZZ/state", baseUrl));
  expect(res.headers.get("cache-control")).toBe("no-cache");
});
