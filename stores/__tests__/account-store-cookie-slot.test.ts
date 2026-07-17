import { beforeEach, describe, expect, it } from 'vitest';
import { useAccountStore } from '../account-store';

// Regression test for task #149: a human reported the account switcher
// showing one account's mail under a DIFFERENT account's label after a
// login/logout/re-add sequence. Root cause: login() computes a cookieSlot
// and writes session credentials to it, then calls addAccount() — which
// independently recomputes its OWN "next free slot" via getNextCookieSlot(),
// with no coordination between the two. If the account registry changes in
// the async gap between those two calls (e.g. another account logging out
// mid-flow, freeing a slot), the two computations can diverge: credentials
// get written to slot A, but the account's STORED cookieSlot ends up as
// slot B — and every future session restore reads from slot B, returning
// whatever account is actually sitting in that slot.
//
// The fix (mirroring an existing pattern already used in loginWithOAuth/
// loginWithServerSso): after addAccount(), force-set cookieSlot back to the
// slot credentials were ACTUALLY written to via accountStore.updateAccount().
// These tests prove the underlying primitive is genuinely racy, and that the
// force-set pattern restores the invariant regardless.

describe('account-store cookie slot consistency (task #149)', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });
  });

  it('getNextCookieSlot can diverge across two calls if the registry changes in between (proves the race is real)', () => {
    const store = useAccountStore.getState();

    // Seed one account occupying slot 0 — mirrors "felixpaw" already being
    // logged in when a login() flow for a second account begins.
    store.addAccount({
      label: 'felixpaw', serverUrl: 'https://mail.example.com', username: 'felixpaw',
      authMode: 'basic', rememberMe: true, displayName: 'felixpaw', email: 'felixpaw',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });

    // login() for a new account snapshots "next free slot" up front, before
    // its async work (client connect, identity fetch, session write) begins.
    const slotComputedByLogin = useAccountStore.getState().getNextCookieSlot();
    expect(slotComputedByLogin).toBe(1); // slot 0 is taken by felixpaw

    // Concurrently, felixpaw logs out mid-flow (a real sequence: logout,
    // then quickly add a different/same account back) — freeing slot 0.
    const felixpawId = useAccountStore.getState().accounts[0].id;
    useAccountStore.getState().removeAccount(felixpawId);

    // addAccount() now runs (this is what login() calls AFTER its own
    // cookieSlot snapshot above) — it recomputes independently.
    const beforeAdd = useAccountStore.getState().getNextCookieSlot();
    expect(beforeAdd).toBe(0); // diverged from slotComputedByLogin (1) — the bug

    // Simulate addAccount actually being called (as login() does at
    // stores/auth-store.ts:491) — it will assign slot 0 internally, NOT the
    // slot 1 that login() already wrote credentials to.
    const newAccountId = useAccountStore.getState().addAccount({
      label: 'modelfit', serverUrl: 'https://mail.example.com', username: 'modelfit',
      authMode: 'basic', rememberMe: true, displayName: 'modelfit', email: 'modelfit',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: false,
    });
    const storedSlot = useAccountStore.getState().getAccountById(newAccountId)?.cookieSlot;

    // Without the fix, storedSlot (0) != slotComputedByLogin (1) — the
    // account's switcher entry would read from the WRONG cookie slot.
    expect(storedSlot).not.toBe(slotComputedByLogin);
  });

  it('force-setting cookieSlot after addAccount (the fix) restores the invariant', () => {
    const store = useAccountStore.getState();

    store.addAccount({
      label: 'felixpaw', serverUrl: 'https://mail.example.com', username: 'felixpaw',
      authMode: 'basic', rememberMe: true, displayName: 'felixpaw', email: 'felixpaw',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });

    const slotComputedByLogin = useAccountStore.getState().getNextCookieSlot();
    const felixpawId = useAccountStore.getState().accounts[0].id;
    useAccountStore.getState().removeAccount(felixpawId);

    const newAccountId = useAccountStore.getState().addAccount({
      label: 'modelfit', serverUrl: 'https://mail.example.com', username: 'modelfit',
      authMode: 'basic', rememberMe: true, displayName: 'modelfit', email: 'modelfit',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: false,
    });

    // The fix: login() forces the stored slot to match what it actually
    // wrote credentials to, regardless of what addAccount picked.
    useAccountStore.getState().updateAccount(newAccountId, { cookieSlot: slotComputedByLogin });

    const storedSlot = useAccountStore.getState().getAccountById(newAccountId)?.cookieSlot;
    expect(storedSlot).toBe(slotComputedByLogin);
  });

  it('re-adding an existing account preserves its original slot (the non-diverging case, unaffected by the fix)', () => {
    const store = useAccountStore.getState();
    const id = store.addAccount({
      label: 'felixpaw', serverUrl: 'https://mail.example.com', username: 'felixpaw',
      authMode: 'basic', rememberMe: true, displayName: 'felixpaw', email: 'felixpaw',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });
    const originalSlot = useAccountStore.getState().getAccountById(id)?.cookieSlot;

    // addAccount is a no-op for an existing id — re-adding must not reassign.
    const sameId = useAccountStore.getState().addAccount({
      label: 'felixpaw', serverUrl: 'https://mail.example.com', username: 'felixpaw',
      authMode: 'basic', rememberMe: true, displayName: 'felixpaw', email: 'felixpaw',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });

    expect(sameId).toBe(id);
    expect(useAccountStore.getState().getAccountById(id)?.cookieSlot).toBe(originalSlot);
  });
});
