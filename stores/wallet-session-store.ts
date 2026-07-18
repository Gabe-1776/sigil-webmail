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

// TEMP DEBUG: a random id stamped once when this module first loads. If
// login/page.tsx and grants-content.tsx ever log DIFFERENT values for
// this, it proves Next.js bundled this module twice (two separate
// singletons that don't actually share state) rather than a logic bug in
// how the cache is read/written. Remove once the still-2-signs report is
// resolved.
export const WALLET_SESSION_STORE_INSTANCE_ID = Math.random().toString(36).slice(2, 8);

export const useWalletSessionStore = create<WalletSessionState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  clearSession: () => set({ session: null }),
}));
