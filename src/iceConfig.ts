// WebRTC ICE server configuration for room voice calls. Public STUN by
// default (free, no credentials, enough to establish a direct peer
// connection whenever both sides' NATs allow it); TURN is genuinely
// optional and only appears when real credentials are supplied via env
// vars — this app never purchases, provisions, or defaults to an
// unauthenticated TURN relay on its own (CLAUDE.md's voice-call section).
//
// A long-lived TURN credential is never hardcoded into the client bundle:
// this endpoint reads from the server's own environment at request time
// (Fly secrets, not a committed file), so the only place a real
// credential would ever live is exactly where every other secret in this
// app already lives.
//
// Limitation, stated plainly rather than assumed away: without a TURN
// server configured, two peers behind a symmetric NAT or restrictive
// corporate/mobile-carrier firewall cannot establish a direct connection
// at all — STUN alone only helps the (common, but not universal) case of
// a standard NAT that reveals a stable public port. See PLAN.md/README.md
// for how this was actually tested and what was and wasn't verified
// across real separate networks.

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function getIceServers(): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrls = process.env.TURN_URLS;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;
  if (turnUrls && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrls.split(",").map((u) => u.trim()).filter(Boolean),
      username: turnUsername,
      credential: turnCredential,
    });
  }
  return servers;
}
