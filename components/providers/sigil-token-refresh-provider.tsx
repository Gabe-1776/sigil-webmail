"use client";

import { useEffect } from "react";
import { getSessionNetwork } from "@/lib/xpr-network";

// Sigil sliding token refresh (Gabriel 2026-07-22). The wallet login mints a
// 7-day access token (stored account-scoped as sigil_auth_token::<id>).
// Without refresh, that expiry hits ACTIVE users weekly with a full wallet
// re-verification — punishing exactly the people doing nothing wrong. This
// provider silently swaps every stored, still-valid token for a fresh one via
// POST /api/auth/refresh (auth server, bearer-authenticated, same-actor-only),
// so 7 days becomes an IDLE limit: use webmail at least once a week and you
// never see a wallet prompt again; go quiet for 7+ days and the token expires
// unrefreshable — back to the wallet, as it should be.
//
// Throttled to once per REFRESH_MIN_INTERVAL_MS per account (localStorage
// timestamp), so app boots don't hammer the auth service. Failures are
// silent: an expired/revoked token simply stops refreshing and dies on
// schedule; network blips retry on the next boot past the throttle window.

const REFRESH_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day is plenty
const TOKEN_PREFIX = "sigil_auth_token::";
const REFRESHED_AT_PREFIX = "sigil_token_refreshed_at::";

function decodeJwtExp(token: string): number | null {
  try {
    const part = token.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64));
    return typeof payload?.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

async function refreshStoredTokens(): Promise<void> {
  let keys: string[];
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(TOKEN_PREFIX));
  } catch {
    return; // localStorage unavailable (SSR guard is the caller's job, but be safe)
  }

  for (const key of keys) {
    const accountId = key.slice(TOKEN_PREFIX.length);
    try {
      const token = localStorage.getItem(key);
      if (!token) continue;

      const exp = decodeJwtExp(token);
      if (!exp || exp * 1000 <= Date.now()) continue; // already dead — wallet required, nothing to slide

      const lastRefreshed = Number(localStorage.getItem(REFRESHED_AT_PREFIX + accountId) || 0);
      if (Date.now() - lastRefreshed < REFRESH_MIN_INTERVAL_MS) continue;

      // Session-global network (see lib/xpr-network.ts): all accounts stay on
      // the network they logged in on, so this correctly hits the testnet
      // auth backend on a testnet session instead of always mainnet.
      const res = await fetch(`${getSessionNetwork().authUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        // 401 = expired/revoked server-side; anything else = transient.
        // Either way: leave the stored token alone (it still gates client
        // UI by its own exp) and let the next boot retry.
        continue;
      }
      const data = await res.json();
      if (data?.ok && typeof data.accessToken === "string" && data.accessToken.length > 0) {
        localStorage.setItem(key, data.accessToken);
        localStorage.setItem(REFRESHED_AT_PREFIX + accountId, String(Date.now()));
      }
    } catch {
      // Silent by design — refresh is opportunistic, never user-facing.
    }
  }
}

export function SigilTokenRefreshProvider() {
  useEffect(() => {
    void refreshStoredTokens();
    // Long-lived tabs (webmail left open for days) still slide their window:
    // re-run on the same cadence as the throttle so a tab that never reloads
    // can't quietly expire out from under the user.
    const interval = setInterval(() => void refreshStoredTokens(), REFRESH_MIN_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return null;
}
