// Structured, identity-correlated server-side action logging — the thing
// Crit 10 asks for and the existing `events` table (src/rooms.ts's
// logEvent) never provided: logEvent is SQLite-only and never reaches
// `flyctl logs`, so an operator watching only the live log stream (the
// crit's own "narrate from logs, don't click your own UI" rehearsal) had
// nothing to read. This module is the one thing every mutating action and
// every rejection funnels a single JSON line through, to stdout, so
// `flyctl logs -a <app> | grep '\[action\]'` is the whole story.
//
// Deliberately NOT a replacement for logEvent: logEvent's own DB table,
// contract and tests are untouched — this is a sibling call at the same
// sites, carrying a different shape for a different audience (an
// operator's terminal, not a queryable table).
//
// What this must never carry (CLAUDE.md's "what a public response may
// never contain", extended to this file's own output): session_secret, a
// full request body, or a full URL/query string. ActionLogEntry's shape
// has no field wide enough to hold any of those by construction — detail
// is capped to small scalar values, never a nested object a secret could
// hide inside.
//
// Several real bugs an independent review caught across iterations of
// this module, each fixed here with its own regression test in
// spec/actionLog.test.ts — recorded in the order they were actually
// found, because each one taught something the next fix needed:
//
// 1. "Success" logging was not actually rollback-safe. The first version
//    put each logAction call inside the same db.transaction() callback as
//    its write, reasoning that a thrown error inside that callback rolls
//    the whole thing back together. That's true for a single, non-nested
//    transaction — but better-sqlite3 nests via SAVEPOINT/RELEASE when
//    db.transaction() is called while already inside another transaction
//    (src/tables.ts's createTableRoom calls rooms.createRoom, which has
//    its own db.transaction() — this nesting already existed in
//    production code, not just in a test). A nested call's own RELEASE
//    commits its savepoint immediately; console.log has no rollback
//    semantics at all — once called, the line is out.
//
// 2. A single flat buffer per db (the first fix for #1) was ITSELF wrong
//    for a shape that specific test didn't cover: an inner transaction's
//    own SAVEPOINT rolling back, caught by the OUTER transaction, which
//    then recovers and commits something else entirely for real. With
//    one flat buffer, the inner call's "ok" entry and the outer call's
//    own later, genuinely-successful entry sat in the same array with
//    nothing distinguishing them — the outer commit flushed both, even
//    though the inner transaction's own row never existed once its own
//    SAVEPOINT rolled back. The actual fix (installTransactionLogging
//    below) is a STACK of buffers, one per currently-open transaction
//    level: a level's own rollback discards only that level's own
//    buffer, never the levels beneath it; a level's own commit merges
//    its buffer into the next level down, rising with it exactly as
//    that level's own SAVEPOINT/RELEASE just became part of the
//    enclosing transaction's still-open unit of work; only the
//    outermost level's own commit actually prints anything.
//
// 3. `verified` in a rejection's log line was inferred from the error's
//    own code (`code !== "unauthorized"`), not from any actual proof a
//    session check had run and passed. Nearly every rooms.ts mutation
//    calls loadOpenRoom/loadRoomAfterSweep (which can throw
//    room_not_found/room_closed) BEFORE calling requireSession at all —
//    for those rejections, no identity check of any kind ever ran, yet
//    the old heuristic reported verified: true, falsely implying the
//    claimed session had been confirmed. markIdentityVerified/
//    wasIdentityVerified below fix this with real evidence: requireSession
//    (src/rooms.ts), requireBarSession (src/bar.ts), and nothing else,
//    call markIdentityVerified() immediately after their own check
//    actually succeeds — never speculatively. app.onError reads
//    wasIdentityVerified() for a rejection's own verified field instead of
//    pattern-matching the error code, so "no check ever ran" and "a check
//    ran and failed" are both honestly false, and only "a check ran and
//    passed, then something else was refused afterward" is true.

import type Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";

export interface ActionLogActor {
  /** Which identity layer this actor belongs to — "bar" (tavern identity)
   * or "room" (a game room's own player record). CLAUDE.md: these are
   * always two separate identity spaces, never merged. */
  kind: "bar" | "room";
  /** The real id, truncated to 8 characters — enough to tell two
   * same-nickname identities apart on screen, never the whole UUID (no
   * operational reason to print the rest, and shorter is easier to read
   * off a terminal during a live narration). */
  id: string;
  /** Only ever set from a verified DB row (a session that actually
   * checked out) — never from an unverified request body, which is what
   * keeps "someone tried to act as X and failed" honestly distinguishable
   * from "X actually did this." */
  nickname?: string;
}

export interface ActionLogEntry {
  action: string;
  outcome: "ok" | "rejected";
  /** null when no identity could be determined at all (e.g. a 404 on a
   * nonexistent room code, where there's no session to even attempt to
   * read). */
  actor?: ActionLogActor | null;
  /** false when the claimed identity in the request failed
   * requireSession/requireBarSession — the claimed id still appears in
   * `actor`, but must never be read as "this really was them." true for
   * every successful action and for every rejection that isn't itself an
   * identity failure (wrong turn, not host, etc. — those callers really
   * were who they claimed, the action was just refused for another
   * reason). */
  verified: boolean;
  room?: { code: string } | null;
  table?: { id: string } | null;
  error?: { code: string; message: string } | null;
  /** Small, scalar-only extra context (a rolled value, a seat id, a
   * color) — never a container wide enough to smuggle a secret or a full
   * body through. */
  detail?: Record<string, string | number | boolean | null>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Pure formatter — exported separately from the console.log side-effect
 * below so a test can assert on the exact string without spying on
 * stdout (src/actionLog.ts's own unit tests do exactly this for the
 * "never contains a secret" check). One single-line JSON object: `flyctl
 * logs`/Docker's line-based capture never splits one event across two
 * lines, and single-line JSON is trivially grep-able and parseable from a
 * terminal mid-presentation. */
export function formatActionLogLine(entry: ActionLogEntry): string {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    action: entry.action,
    outcome: entry.outcome,
    verified: entry.verified,
  };
  if (entry.actor) {
    line.actor = { kind: entry.actor.kind, id: shortId(entry.actor.id), ...(entry.actor.nickname ? { nickname: entry.actor.nickname } : {}) };
  } else {
    line.actor = null;
  }
  if (entry.room) line.room = entry.room;
  if (entry.table) line.table = entry.table;
  if (entry.error) line.error = entry.error;
  if (entry.detail) line.detail = entry.detail;
  return `[action] ${JSON.stringify(line)}`;
}

// ---- Fix for bug 1: logging that is actually rollback-safe, including
// across nested transactions ----
//
// A follow-up review of the first version of this fix caught that it was
// still incomplete: `transact()` below only buffered correctly for calls
// that went *through* it — a raw `db.transaction(fn)()` wrapped around a
// call to a function that itself used `transact()` (exactly
// src/tables.ts's createTableRoom calling rooms.createRoom's shape, and
// exactly what spec/actionLog.test.ts's own regression test constructs
// directly) still let the inner call's `isOutermost` check see
// `db.inTransaction` as already true... which actually made the ORIGINAL
// bug worse to reproduce accidentally, but did nothing to protect a
// scenario where the OUTER wrapper is the raw, un-migrated form and the
// INNER call is the one using `transact()` — in that shape `transact()`
// correctly declines to treat itself as outermost (good), but nothing
// then arranges for the outer raw transaction's own rollback to discard
// the inner call's buffered entries, because nothing ever flushes or
// discards a buffer that an inner, non-outermost `transact()` call
// chose not to own.
//
// The robust fix does not depend on every call site remembering to use
// `transact()` instead of `db.transaction()` at all: `Database.prototype
// .transaction` itself is patched, once, here, so EVERY transaction on
// EVERY database this process ever opens — however it's invoked, through
// `transact()`, through a raw `db.transaction(fn)()`, in old code, in new
// code, in a test — gets this buffering automatically. This is possible
// because better-sqlite3's own nesting (SAVEPOINT/RELEASE when already
// `db.inTransaction`, BEGIN/COMMIT otherwise — confirmed by reading
// better-sqlite3's transaction.js) is itself keyed off the exact same
// `db.inTransaction` flag this patch reads, so the two can never disagree
// about what's outermost.
const realTransactionMethod = Symbol("realTransactionMethod");
interface PatchableDatabase extends Database.Database {
  [realTransactionMethod]?: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
}

/** For a given database connection, a STACK of buffers — one per
 * currently-open transaction level, outermost first. A follow-up review
 * found that a single flat buffer per db (the first version of this fix)
 * was itself wrong for a shape the single-buffer test above didn't
 * cover: an INNER transaction's own SAVEPOINT rolling back, caught by
 * the OUTER transaction, which then recovers and goes on to commit
 * something else entirely for real. With one flat buffer, the inner
 * call's "ok" entry had nothing to distinguish it from the outer call's
 * own later, genuinely-successful entry — both just sat in the same
 * array, and the outer commit flushed both, even though the inner
 * transaction's own row never existed in the database once its own
 * SAVEPOINT rolled back.
 *
 * The fix: each transaction level gets its OWN buffer, pushed onto this
 * stack when that level begins. A level's own rollback pops and
 * discards only that level's own buffer — never the levels below it,
 * which may have already logged real, independently-valid entries of
 * their own before this inner transaction was even started. A level's
 * own commit pops its buffer and, if there is still an enclosing level
 * (this wasn't the outermost), merges those entries into the *next*
 * buffer down the stack — they're now provisionally part of that
 * enclosing transaction's own pending log, rising or falling with IT
 * from here on, exactly mirroring how the inner transaction's own
 * SAVEPOINT/RELEASE just became part of the outer transaction's own
 * still-open unit of work in SQLite itself. Only when the OUTERMOST
 * level's own buffer is popped (the stack becomes empty for this db) is
 * anything actually printed to stdout. */
const pendingStackByDb = new WeakMap<Database.Database, ActionLogEntry[][]>();

function currentBuffer(db: Database.Database): ActionLogEntry[] | undefined {
  const stack = pendingStackByDb.get(db);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/** Installs the patch on `db.transaction` the first time this module
 * sees a given database instance — idempotent per instance (checked via
 * the symbol marker), so calling this more than once for the same `db`
 * (e.g. from multiple modules importing actionLog.ts) is harmless.
 * src/db.ts's `openDb` calls this once, right after opening the
 * connection, before any other module gets a chance to call
 * `db.transaction` itself. */
export function installTransactionLogging(db: Database.Database): void {
  const patchable = db as PatchableDatabase;
  if (patchable[realTransactionMethod]) return; // already patched
  const original = db.transaction.bind(db);
  patchable[realTransactionMethod] = original as never;
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrapped = original(fn);
    return (...args: unknown[]) => {
      const isOutermost = !db.inTransaction;
      let stack = pendingStackByDb.get(db);
      if (!stack) {
        stack = [];
        pendingStackByDb.set(db, stack);
      }
      const myBuffer: ActionLogEntry[] = [];
      stack.push(myBuffer); // this level's own buffer, recorded at entry — its "buffer starting point"
      try {
        const result = wrapped(...args);
        // This level committed (its own SAVEPOINT RELEASEd, or — if
        // isOutermost — the real COMMIT ran). Pop this level's buffer;
        // its entries are no longer "pending at this level," they rise
        // to whatever level is still open beneath it.
        stack.pop();
        if (isOutermost) {
          // Nothing left to rise to — this is the real commit. Print
          // every entry this transaction (and everything nested inside
          // it that also committed) actually logged.
          for (const entry of myBuffer) console.log(formatActionLogLine(entry));
        } else {
          // Merge into the enclosing level's own still-open buffer —
          // provisionally part of ITS fate from here on, exactly as
          // this level's own SAVEPOINT just became part of the
          // enclosing transaction's still-open unit of work.
          const parent = stack[stack.length - 1];
          parent.push(...myBuffer);
        }
        return result;
      } catch (err) {
        // This level rolled back (its own ROLLBACK TO, or — if
        // isOutermost — the real ROLLBACK). Pop and discard ONLY this
        // level's own buffer — never touch whatever's still on the
        // stack beneath it, which belongs to an enclosing transaction
        // that may well recover from this exact failure (catch it) and
        // go on to commit something else for real afterward.
        stack.pop();
        throw err;
      }
    };
  }) as typeof db.transaction;
}

/** Calls `db.transaction(fn)()` — a thin, named convenience, kept for
 * every call site that already reads clearly as "run this in a
 * transaction." The actual rollback-safety guarantee lives in
 * `installTransactionLogging`'s patch above, not here: calling
 * `db.transaction(fn)()` directly (bypassing this helper entirely) is
 * exactly as safe, which is the point — the fix no longer depends on
 * every call site remembering to opt in. */
export function transact<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}

/** Logs one action for `db`. If called while `db` is inside a running
 * transaction (at any nesting depth), the entry is pushed onto the
 * CURRENT (innermost) level's own buffer — see
 * `installTransactionLogging`'s own doc comment for exactly how that
 * buffer's fate then tracks its own transaction level: discarded if
 * that level rolls back, merged upward if it commits, and only ever
 * printed once the outermost level itself commits. Called outside any
 * transaction (e.g. a rejection logged from `app.onError`, after
 * whatever transaction was active has already thrown and rolled back
 * synchronously — better-sqlite3's own transaction wrapper runs its
 * ROLLBACK before rethrowing, so by the time an error reaches here
 * `db.inTransaction` is already false again), this logs immediately. */
export function logAction(db: Database.Database, entry: ActionLogEntry): void {
  const buffer = currentBuffer(db);
  if (buffer) {
    buffer.push(entry);
  } else {
    console.log(formatActionLogLine(entry));
  }
}

export function shortIdFor(id: string): string {
  return shortId(id);
}

// ---- Fix for bug 2: `verified` backed by real proof a session check
// actually ran and passed, never inferred from an error's own code ----
//
// A per-request context, established once per incoming HTTP request
// (src/server.ts's own verification-tracking middleware) and read by
// app.onError when it needs to log a rejection. AsyncLocalStorage, not a
// plain module-level variable, because Hono's handlers are async (every
// one starts with `await c.req.json()`) — a shared mutable flag would be
// a real race under concurrent requests (two requests' handlers can
// genuinely interleave at that await point, even in Node's single-
// threaded event loop), and AsyncLocalStorage is exactly the mechanism
// Node provides for ambient, per-async-call-chain state that survives
// await boundaries without that race and without threading an extra
// parameter through every mutation function that might need to report it
// (requireSession/requireBarSession are called from nearly every
// exported function in rooms.ts/bar.ts; adding an out-parameter to all
// of them to carry this would be far more invasive than reading an
// ambient context the one place that needs it, in app.onError).
interface VerificationContext {
  verified: boolean;
}

const verificationStorage = new AsyncLocalStorage<VerificationContext>();

/** Establishes a fresh, unverified context for the duration of `fn`
 * (including through any `await` inside it) — called once per incoming
 * request, wrapping the entire rest of that request's handling including
 * Hono's own error-handling path (confirmed: Hono's `onError` runs from
 * within the same dispatch continuation that invoked the throwing
 * handler, not as a separate top-level call, so a context established
 * here around `next()` is still active when `onError` reads it). */
export function runWithVerificationTracking<T>(fn: () => T): T {
  return verificationStorage.run({ verified: false }, fn);
}

/** Called by `requireSession` (src/rooms.ts) and `requireBarSession`
 * (src/bar.ts) — and nowhere else — immediately after their own check
 * has actually succeeded for the claimed identity. Never called
 * speculatively, never called before the check, never called from a
 * catch block: it is itself the proof, not a prediction. A no-op outside
 * any tracked request (e.g. a direct unit test that never called
 * `runWithVerificationTracking`) rather than throwing, so every existing
 * direct-DB test that doesn't care about this mechanism keeps working
 * unchanged. */
export function markIdentityVerified(): void {
  const store = verificationStorage.getStore();
  if (store) store.verified = true;
}

/** Read by `app.onError` when logging a rejection: true only if some
 * call during this exact request actually reached and passed a real
 * session check before the eventual rejection happened (e.g. a host-only
 * action refused for not being the host — the caller's own session did
 * check out, just not as the host). False covers both "a session check
 * ran and failed" and "no session check of any kind ever ran before the
 * rejection" (e.g. the room code itself didn't exist) — both are
 * honestly "not verified," never conflated with each other by this
 * function returning only a single boolean; `error.code` in the same log
 * line is what tells those two apart for a reader. */
export function wasIdentityVerified(): boolean {
  return verificationStorage.getStore()?.verified ?? false;
}
