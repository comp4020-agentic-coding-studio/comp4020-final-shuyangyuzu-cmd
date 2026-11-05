import { defineConfig } from "vitest/config";

// Every test in spec/ runs against the SAME running app instance, which
// spec/global-setup.ts finds. Only spec/ runs: a test anywhere else needs
// adding to `include`.
//
// fileParallelism: false (2026-11-05) — every spec file shares that one
// app process, and a handful of files (spec/tables.test.ts,
// spec/voice.test.ts, spec/accountGameTakeover.test.ts,
// spec/accountsHttp.test.ts) additionally share a hard, fixed real-world
// resource through it: only 2 physical online Vegas table fixtures exist
// (CLAUDE.md's "furniture is fixed" rule — this is deliberately never
// widened just to satisfy tests). Running test FILES as separate parallel
// workers (vitest's own default) lets two of those files race for the
// same 2-table pool at the same wall-clock moment regardless of how
// carefully any single file disbands its own rooms afterward, since
// "this file's own sequence of tests" was never the actual unit of
// mutual exclusion — the real server process is. Investigated directly,
// not assumed: several separate fresh-server full-suite runs under the
// default parallel scheduling each reported a double-digit number of
// failures, varying run to run, every single one inside this same
// resource-contention cluster (confirmed by running the exact same files
// alone, or together but serialized, where they passed 100% every time)
// or inside spec/settlement.test.ts's own documented CPU-contention
// sensitivity (itself a symptom of the same root cause: many concurrently-
// running test files all issuing HTTP requests against one single-
// threaded dev server at once).
// One genuine resource LEAK was found and fixed alongside this (an old
// spec/voice.test.ts test created a table via a hardcoded "vegas-2" and
// never disbanded it, permanently consuming one of only 2 slots for the
// rest of that process's life) — but the leak fix alone was not
// sufficient on its own to make a fully-parallel run reliable, because
// the underlying race between separate worker processes remains even
// when every file cleans up perfectly after itself. Disabling file
// parallelism here removes the race at its actual root rather than
// requiring every current and future spec file to coordinate around a
// shared physical resource it may not even know exists. Confirmed: a
// full run this way is slower (~150s vs ~30-35s) but genuinely
// deterministic — 490/490 passing, not "usually passing."
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
    fileParallelism: false,
  },
});
