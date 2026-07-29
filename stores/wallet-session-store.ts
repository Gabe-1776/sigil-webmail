import { create } from 'zustand';

// Caches an already-connected @proton/web-sdk session IN MEMORY ONLY (never
// localStorage) so a second crypto payment in the same visit can skip the
// wallet-connect handshake and go straight to signing the transfer — the
// "log in once, scan-to-sign after that" UX other XPR sites have, requested
// by Gabriel 2026-07-17 after noticing every slot purchase demanded two
// signatures (connect + transfer) even back-to-back.
//
// Deliberately NOT the same mechanism @proton/link's own storage-based
// session restore uses. That path is exactly what caused a real production
// incident (auth/NOTES.md, 2026-07-10): a stale localStorage session made
// `session.transact()` hang forever with zero feedback — "dead air," a
// countdown on screen, nothing on the phone. This store never touches
// localStorage; it just keeps the live SDK session OBJECT returned by a
// successful connect alive in JS memory for the rest of the tab's life, and
// grants-content.tsx's handlePayWithWallet always falls back to a fresh
// wipe-and-reconnect (the pre-existing, proven-safe path) the instant a
// reused session's transact() fails or times out — so the failure mode
// stays "one extra sign," never "hang forever again."
//
// Cleared explicitly on logout (auth-store.ts) so a connected wallet
// doesn't outlive the human session that authorized it.
type WalletSessionState = {
  session: unknown | null;
  setSession: (session: unknown) => void;
  clearSession: () => void;
};

function createWalletSessionStore() {
  return create<WalletSessionState>((set) => ({
    session: null,
    setSession: (session) => set({ session }),
    clearSession: () => set({ session: null }),
  }));
}

// CONFIRMED LIVE 2026-07-18: login/page.tsx and grants-content.tsx logged
// DIFFERENT instance ids (e.g. "upryq3" vs "tbur97") with the cache reading
// EMPTY at payment time, right after a fresh wallet login. Next.js (this app
// runs on Turbopack) evaluated this module more than once per tab — once for
// whatever chunk contains the login route, again for whatever chunk contains
// the grants drawer — and a plain module-scope `create(...)` gives each
// evaluation its own closure-scoped store that doesn't share state with the
// other. A bare module-level singleton doesn't survive that.
//
// Fix: anchor the store on `globalThis`. globalThis is one shared object
// across every chunk in the same JS realm (tab) no matter how many times the
// module itself re-runs, so the first evaluation wins and every later
// evaluation just reuses it — same pattern Next.js recommends for a Prisma
// Client singleton surviving HMR. (The debug instance-id scaffolding that
// proved this diagnosis was removed 2026-07-21 after Gabriel confirmed the
// deployed fix behaves; the fix itself is this globalThis anchor.)
declare global {
  var __sigilWalletSessionStore: ReturnType<typeof createWalletSessionStore> | undefined;
}

export const useWalletSessionStore =
  globalThis.__sigilWalletSessionStore ?? (globalThis.__sigilWalletSessionStore = createWalletSessionStore());
