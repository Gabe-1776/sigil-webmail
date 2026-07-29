"use client";

import { usePathname } from "next/navigation";
import { DEFAULT_NETWORK } from "@/lib/xpr-network";

// TESTNET marker for the LOGIN SCREEN ONLY, and only on ≥sm viewports
// (2026-07-28, Gabriel: the bottom-right pill covered content on mobile —
// hidden below the sm breakpoint). Once you're signed in, the mail app
// stays visually clean on both networks — a tester already knows which site they
// logged into, and the badge just clutters every route. Public safety (nobody
// mistakes test mail for the real thing) is served at the door.
//
// Gated on DEFAULT_NETWORK — this deployment's build-time network — NOT on the
// session's stored network. Each site serves exactly ONE mail server, so the
// deployment is the truth; reading localStorage `sigil_network` here meant a
// stale "testnet" value could paint the TESTNET badge on the MAINNET site.
// Build-time also means no post-hydration flicker. Mainnet builds compile this
// to a constant false and never render.
export function NetworkBadge() {
  const pathname = usePathname();

  if (DEFAULT_NETWORK !== "testnet") return null;
  // Locale-prefixed route (/en/login, /de/login, …) and the unprefixed form.
  if (!/(^|\/)login\/?$/.test(pathname ?? "")) return null;

  return (
    <div
      title="You are on the XPR testnet — mail, accounts, and payments here are for testing only and are not real."
      className="hidden sm:block fixed bottom-3 right-3 z-[100] select-none rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-600 shadow-sm backdrop-blur dark:text-amber-300"
    >
      Testnet
    </div>
  );
}
