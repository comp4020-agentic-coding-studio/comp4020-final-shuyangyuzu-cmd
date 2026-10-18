// Renders README.md as real HTML at /readme/ — spec/invariants.test.ts
// checks the README's headings appear, in order, in what this serves.
// (The placeholder it replaces just HTML-escaped the file into a <pre>.)

import { marked } from "marked";
import { readFileSync } from "node:fs";
import { BUILD_VERSION } from "./version.ts";

export function renderReadme(readmePath = "README.md"): string {
  const source = readFileSync(readmePath, "utf8");
  const body = marked.parse(source, { async: false });
  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Las Vegas · About</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${BUILD_VERSION}" />
    <link rel="stylesheet" href="/styles.css?v=${BUILD_VERSION}" />
  </head>
  <body>
    <main class="readme">
      ${body}
    </main>
  </body>
</html>`;
}
