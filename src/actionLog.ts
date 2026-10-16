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

export function logAction(entry: ActionLogEntry): void {
  console.log(formatActionLogLine(entry));
}

export function shortIdFor(id: string): string {
  return shortId(id);
}
