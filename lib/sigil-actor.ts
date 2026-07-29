// The XPR actor for the signed-in session.
//
// This exists because "the actor" and "the mailbox local part" are NOT the
// same string on every network, and conflating them silently broke a paid
// feature. A Sigil mailbox is `mailboxLocalPart(actor)@<domain>`, and on
// testnet that adds a `.testnet` suffix (auth/src/provisioning.ts). So
// `username.split("@")[0]` yields the actor on mainnet and `<actor>.testnet`
// on testnet — and the testnet value matches nothing actor-keyed, which is
// how a paid Pro upgrade ended up filed against a nonexistent mailbox while
// the UI kept offering "Upgrade to Pro" (2026-07-28).
//
// The access token is the authority: the auth service sets `sub` to the actor
// (and `preferred_username` to the full mailbox address).

/** Decode a JWT payload. Base64URL, and not every runtime's atob tolerates
 *  missing padding — normalise before decoding. Returns null on anything
 *  malformed; callers must have a fallback. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The XPR actor a Sigil access token was issued for, or "" if unreadable. */
export function actorFromAccessToken(token: string | null | undefined): string {
  if (!token) return "";
  const sub = decodeJwtPayload(token)?.sub;
  return typeof sub === "string" ? sub : "";
}
