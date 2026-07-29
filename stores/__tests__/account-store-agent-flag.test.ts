import { beforeEach, describe, expect, it } from 'vitest';
import { useAccountStore } from '../account-store';

// Regression coverage for the account-switcher "Agent" badge work (2026-07-21,
// product feedback: agent-vs-own-mailbox rows were indistinguishable). The
// switcher renders a badge off AccountEntry.isAgent, which is set by the
// agent-specific webmail paths (grants-content.tsx: openAgentInWebmail /
// claim-agent-mailbox) via login()'s new isAgent param, NOT by the ambiguous
// accept-a-grant paths (the grantor there could be another human).

describe('account-store isAgent flag', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });
  });

  it('defaults to false/falsy when not passed (ordinary human login)', () => {
    const store = useAccountStore.getState();
    const id = store.addAccount({
      label: 'felixpaw', serverUrl: 'https://mail.example.com', username: 'felixpaw',
      authMode: 'basic', rememberMe: true, displayName: 'felixpaw', email: 'felixpaw',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });
    expect(useAccountStore.getState().getAccountById(id)?.isAgent).toBeFalsy();
  });

  it('is set true when the entry explicitly passes isAgent: true (agent mailbox add)', () => {
    const store = useAccountStore.getState();
    const id = store.addAccount({
      label: 'my-agent', serverUrl: 'https://mail.example.com', username: 'my-agent@mailsigil.pro',
      authMode: 'basic', rememberMe: true, displayName: 'my-agent', email: 'my-agent@mailsigil.pro',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true, isAgent: true,
    });
    expect(useAccountStore.getState().getAccountById(id)?.isAgent).toBe(true);
  });

  it('re-adding an existing agent account without isAgent does not demote it back to false', () => {
    const store = useAccountStore.getState();
    const id = store.addAccount({
      label: 'my-agent', serverUrl: 'https://mail.example.com', username: 'my-agent@mailsigil.pro',
      authMode: 'basic', rememberMe: true, displayName: 'my-agent', email: 'my-agent@mailsigil.pro',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true, isAgent: true,
    });

    // Simulates a plain re-login/no-op addAccount call site that doesn't know
    // or care about isAgent (most of auth-store.ts's addAccount call sites).
    store.addAccount({
      label: 'my-agent', serverUrl: 'https://mail.example.com', username: 'my-agent@mailsigil.pro',
      authMode: 'basic', rememberMe: true, displayName: 'my-agent', email: 'my-agent@mailsigil.pro',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });

    expect(useAccountStore.getState().getAccountById(id)?.isAgent).toBe(true);
  });

  it('updateAccount can backfill isAgent on an account added before the field existed', () => {
    const store = useAccountStore.getState();
    const id = store.addAccount({
      label: 'my-agent', serverUrl: 'https://mail.example.com', username: 'my-agent@mailsigil.pro',
      authMode: 'basic', rememberMe: true, displayName: 'my-agent', email: 'my-agent@mailsigil.pro',
      lastLoginAt: Date.now(), isConnected: true, hasError: false, isDefault: true,
    });
    expect(useAccountStore.getState().getAccountById(id)?.isAgent).toBeFalsy();

    store.updateAccount(id, { isAgent: true });
    expect(useAccountStore.getState().getAccountById(id)?.isAgent).toBe(true);
  });
});
