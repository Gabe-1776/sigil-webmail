// The Proton web SDK persists its wallet session under `proton-storage*` /
// `proton-link*` keys in localStorage. Several flows need to drop it, and each
// had grown its own copy of this loop (login, confirm, grants) — which is how
// LOGOUT ended up not doing it at all.
//
// Leaving it behind after logout is user-visible: the next sign-in silently
// restores that session and goes straight to a signature request, so the user
// never sees the wallet picker and gets a signing prompt pushed at them
// without asking for one (Gabriel 2026-07-28: "i log out and try logging in
// and it pushes a transaction nonce"). Logging out should mean logged out.
export function purgeProtonSdkStorage(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("proton-storage") || key.startsWith("proton-link"))) {
        stale.push(key);
      }
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage unavailable — a fresh connect will just re-prompt anyway */
  }
}

/** True for the SDK's "the user cancelled" error (`code: 'E_CANCEL'`), which
 *  must never be mistaken for a dead/stale session: retrying a cancellation
 *  re-prompts the wallet, so the user cannot actually back out. */
export function isWalletCancel(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "E_CANCEL") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /cancell?ed/i.test(msg);
}
