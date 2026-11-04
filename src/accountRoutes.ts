// Account login/registration HTTP surface (2026-11-04). Registered
// separately from server.ts's own inline bar/room routes, the same
// module-per-feature pattern src/pokerRoutes.ts/dominoRoutes.ts already
// use for poker/dominoes.
//
// CSRF: every OTHER auth mechanism in this app (bar/room/poker/domino
// session_secret) travels as an explicit field in a JSON request body —
// immune to CSRF by construction, since a cross-site form/script can
// trigger a request but can't read or forge a value it was never given.
// The account session cookie is the first credential in this codebase
// that the BROWSER attaches automatically, which is exactly the shape
// CSRF exploits — so these routes, and only these routes, need an
// explicit Origin check the rest of the app has never needed.
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type Database from "better-sqlite3";
import * as accounts from "./accounts.ts";
import { AccountError } from "./accounts.ts";
import * as bar from "./bar.ts";
import * as tables from "./tables.ts";
import * as rooms from "./rooms.ts";

const COOKIE_NAME = "vegas_account";

function cookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    // Secure requires HTTPS; Fly's proxy terminates TLS in front of this
    // app (fly.toml's own comment), so the app itself only ever sees
    // plain http even in production — gating on NODE_ENV instead of
    // c.req.url's own scheme, which would always read http: here.
    secure: production,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days; a revoked/replaced token still stops working immediately server-side regardless of this expiry
  };
}

/** Same-origin check for the handful of routes that rely on the account
 * cookie being sent automatically. A same-site navigation/fetch has no
 * Origin header needing to be checked against anything (there's nothing
 * cross-site happening), so a missing Origin — which also covers a
 * direct curl/Node fetch with no browser's Origin header at all — is
 * accepted, matching how a legitimate same-origin request actually
 * behaves; only a PRESENT, MISMATCHED Origin is refused. */
function requireSameOrigin(c: Context): void {
  const origin = c.req.header("origin");
  if (!origin) return;
  const host = c.req.header("host");
  try {
    if (new URL(origin).host !== host) {
      throw new AccountError("cross-site request refused", "bad_origin", 403);
    }
  } catch (e) {
    if (e instanceof AccountError) throw e;
    throw new AccountError("cross-site request refused", "bad_origin", 403);
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Everything one freshly-authenticated device needs to act as its
 * account's character immediately — a fresh bar session_secret always
 * (rotated on every login/register, per the multi-device takeover
 * design below), plus a freshly-rotated Vegas room secret ONLY when that
 * character is actually, currently bound to an in-progress Vegas room
 * (poker/dominoes need no equivalent: both authenticate purely via the
 * bar session_secret already being rotated here, with no separate
 * room-level credential of their own — confirmed by reading src/poker.ts
 * and src/domino.ts directly rather than assumed, since the three game
 * types do NOT all share one credential shape). */
function takeOverCharacter(db: Database.Database, barPlayerId: string): {
  barSessionSecret: string;
  vegasRoom: { code: string; sessionSecret: string } | null;
} {
  // Rotating the bar secret FIRST is what makes the old device's cached
  // secret stop working for every bar-gated action (move, order, sit,
  // domino/poker's own requireBarSession calls) the instant this
  // function returns — before any game-specific rotation even happens.
  const barSessionSecret = bar.rotateBarSession(db, barPlayerId);
  const activeVegas = tables.activeVegasRoomPlayerId(db, barPlayerId);
  let vegasRoom: { code: string; sessionSecret: string } | null = null;
  if (activeVegas) {
    const newRoomSecret = rooms.rotateSession(db, activeVegas.playerId);
    if (newRoomSecret) vegasRoom = { code: activeVegas.code, sessionSecret: newRoomSecret };
  }
  return { barSessionSecret, vegasRoom };
}

export function registerAccounts(app: Hono, db: Database.Database): void {
  app.post("/api/accounts/register", async (c) => {
    requireSameOrigin(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: unknown;
      password?: unknown;
      confirmPassword?: unknown;
      migrateGuest?: unknown;
    };
    const username = asString(body.username);
    const password = asString(body.password);
    const confirmPassword = asString(body.confirmPassword);
    if (password !== confirmPassword) {
      throw new AccountError("passwords do not match", "password_mismatch", 400);
    }
    let migrateGuest: { playerId: string; sessionSecret: string } | null = null;
    if (body.migrateGuest && typeof body.migrateGuest === "object") {
      const g = body.migrateGuest as { playerId?: unknown; sessionSecret?: unknown };
      const playerId = asString(g.playerId);
      const sessionSecret = asString(g.sessionSecret);
      if (playerId && sessionSecret) migrateGuest = { playerId, sessionSecret };
    }
    const result = accounts.register(db, username, password, migrateGuest);
    setCookie(c, COOKIE_NAME, result.token, cookieOptions());
    // A migrated guest already holds its own real bar session_secret
    // locally (nothing to rotate — this IS that same device); only a
    // brand-new character needs its freshly-minted secret reported back.
    const barSessionSecret = result.freshBarSecret ?? undefined;
    return c.json(
      { accountId: result.accountId, username: result.username, barPlayerId: result.barPlayerId, barSessionSecret },
      201,
    );
  });

  app.post("/api/accounts/login", async (c) => {
    requireSameOrigin(c);
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const result = accounts.login(db, asString(body.username), asString(body.password));
    setCookie(c, COOKIE_NAME, result.token, cookieOptions());
    if (!result.barPlayerId) {
      // Should not normally happen (every account gets a character at
      // registration) but handled honestly rather than assumed away.
      return c.json({ accountId: result.accountId, username: result.username, barPlayerId: null });
    }
    const takeover = takeOverCharacter(db, result.barPlayerId);
    // The bar snapshot/version bump makes the takeover (a brand-new
    // secret now controls this identity) visible to anyone watching the
    // public bar stream the same way any other bar action already is —
    // nothing about WHO controls an identity is itself public, only the
    // identity's own already-public fields (position, nickname, etc.),
    // unchanged by this.
    return c.json({
      accountId: result.accountId,
      username: result.username,
      barPlayerId: result.barPlayerId,
      barSessionSecret: takeover.barSessionSecret,
      vegasRoom: takeover.vegasRoom,
    });
  });

  app.post("/api/accounts/logout", async (c) => {
    requireSameOrigin(c);
    const token = getCookie(c, COOKIE_NAME);
    // Real proof of which account is logging out, read BEFORE the
    // session row is deleted below — never trusted from the request body
    // (there isn't one), and never skipped just because the token looks
    // already-invalid (an already-logged-out/expired token still clears
    // the cookie harmlessly below).
    let barPlayerId: string | null = null;
    if (token) {
      try {
        barPlayerId = accounts.characterFor(db, accounts.verifyAccountSession(db, token).accountId)?.barPlayerId ?? null;
      } catch {
        // stale/expired token — nothing to rotate, logout still proceeds
      }
    }
    accounts.logout(db, token);
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    // "旧的 bar/game session 路径也要检查，不能让退出后残留的旧凭证绕过新
    // 会话机制" — an explicit logout must do more than drop the account
    // cookie: whatever bar session_secret (and, if actively bound, Vegas
    // room session_secret) this browser was holding must stop working
    // too, the same rotation takeOverCharacter already performs for a
    // new-device login, just with the freshly-minted secret reported to
    // nobody (there is no "new device" here to hand it to — the next
    // login mints its own). This is what keeps a cached/leaked copy of
    // this browser's own old bar secret from continuing to act as this
    // character after the user explicitly signed out.
    if (barPlayerId) {
      bar.rotateBarSession(db, barPlayerId);
      const activeVegas = tables.activeVegasRoomPlayerId(db, barPlayerId);
      if (activeVegas) rooms.rotateSession(db, activeVegas.playerId);
    }
    return c.json({ ok: true });
  });

  /** Lightweight "am I logged in, and as whom" check — called once on
   * page load so the client knows whether to show the logged-in header
   * state or the guest entry overlay, without requiring a full
   * login/register round-trip just to check. Returns 200 with
   * `account: null` for a guest/no-cookie visitor rather than an error —
   * "not logged in" is an ordinary, expected state here, not a failure. */
  app.get("/api/accounts/me", async (c) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) return c.json({ account: null });
    try {
      const info = accounts.verifyAccountSession(db, token);
      const character = accounts.characterFor(db, info.accountId);
      return c.json({ account: { id: info.accountId, username: info.username }, barPlayerId: character?.barPlayerId ?? null });
    } catch {
      // A stale/revoked cookie (replaced by a login elsewhere, or
      // explicitly logged out from another tab) is reported the same
      // way as never having logged in — the client's own stale-response
      // guard (below) is what tells a REPLACED session apart from one
      // that was simply never there, via the dedicated check endpoint.
      deleteCookie(c, COOKIE_NAME, { path: "/" });
      return c.json({ account: null });
    }
  });
}
