// A short, deterministic version token for cache-busting the client's
// static assets. Deliberately not derived from git (the Docker image
// doesn't carry .git — see .dockerignore) and not a build-time argument
// (the course's CI runs the exact same `flyctl deploy` command on every
// push to main; a required --build-arg would break that). Instead it's
// a content hash of the actual deployed app.js + styles.css, computed
// once at server startup — the same bytes always produce the same
// token, and different bytes (any real change) always produce a
// different one, which is exactly the property a cache-busting query
// string needs.
//
// This exists because a Cache-Control header alone wasn't enough: a
// browser that already cached app.js/styles.css *before* this app ever
// started sending Cache-Control (an earlier deploy) can keep serving
// that cached copy on an ordinary reload — no header on a new response
// changes what the browser already decided about an old one. Putting
// the version in the asset's own URL (?v=<hash>) forces a genuinely new
// request regardless of what the browser cached before.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function computeVersion(): string {
  const hash = createHash("sha256");
  hash.update(readFileSync("public/app.js"));
  hash.update(readFileSync("public/styles.css"));
  hash.update(readFileSync("public/tavern.js"));
  hash.update(readFileSync("public/liveSync.js"));
  hash.update(readFileSync("public/voiceCall.js"));
  hash.update(readFileSync("public/favicon.svg"));
  return hash.digest("hex").slice(0, 10);
}

export const BUILD_VERSION = computeVersion();

export function renderIndexHtml(templatePath = "public/index.html"): string {
  const template = readFileSync(templatePath, "utf8");
  return template.replaceAll("@VERSION@", BUILD_VERSION);
}
