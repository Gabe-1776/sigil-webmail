"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useWalletSessionStore, WALLET_SESSION_STORE_INSTANCE_ID } from "@/stores/wallet-session-store";
import { generateAccountId, getAccountScopedKey } from "@/lib/account-utils";
import { useConfig } from "@/hooks/use-config";
import { ShieldCheck, Mail, Loader2, RefreshCw, Check, X, AlertCircle, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const AUTH_URL = process.env.NEXT_PUBLIC_XPR_AUTH_SERVICE_URL || "https://auth.mailsigil.pro";

// Shapes matching the actual API responses
type IncomingGrant = {
  grantId: string;
  from: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
};

type IssuedGrant = {
  id: string;
  owner_actor: string;
  grantee_actor: string;
  scope: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
};

type AcceptedGrant = {
  grantId: string;
  ownerActor: string;
  mailbox: string;
  jmapUrl: string;
  scope: string;
  acceptedAt: string | null;
};

type PendingMailbox = {
  id: string;
  for_actor: string;
  initiated_by: string;
  created_at: string;
};

type LinkedAccounts = {
  ownedBy: string | null;
  ownedAgents: string[];
  ownedAgentsDetailed: { actor: string; hasMailbox: boolean }[];
};

type WebhookSub = {
  id: string;
  url: string;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastStatus: string | null;
};

type Quota = {
  owner: string;
  agentMailboxes: { used: number; limit: number; max: number; purchasedSlots: number };
  nextSlot: { priceUsd: number; periodDays: number; purchaseEndpoint: string | null };
};

// 30-day slot leases renewed by plain transfer + memo — the primary
// "Add a slot" / "Renew" path. Pivoted 2026-07-11 (BLUEPRINT-slot-
// renewals.md) off the earlier updateauth-based monthly subscription:
// WebAuth silently drops any signing request that changes account
// permissions unless the connecting wallet type is 'webauth' specifically
// (proven live 2026-07-10 with a real phone), which blocks the majority
// of humans — mobile/QR users. A plain transfer has no such restriction,
// so this is back to exactly the mechanism the original one-time slot
// purchase used, just renewable. The updateauth/subscription machinery
// stays live server-side as an AGENT-ONLY option (agents sign updateauth
// programmatically, no wallet app to refuse it) — this page never shows
// it to a human.
type SlotLease = { id: string; paidUntil: string; graceEndsAt: string; agentActor: string | null };
type SuspendedMailbox = { agentActor: string; suspendedAt: string; autoDeleteAt: string };
type LeaseInfo = {
  owner: string;
  leases: SlotLease[];
  suspendedMailboxes: SuspendedMailbox[];
  gracePeriodDays: number;
  autoDeleteAfterSuspendedDays: number;
  priceUsdPerSlot: number;
  periodDays: number;
  // Account-level, not attributable to one agent — a human directly holding
  // a subscription that covers `quantity` slots in aggregate.
  autoPaySubscription: { quantity: number; status: "active" | "past_due"; nextDueAt: string } | null;
  // Per-agent — an agent that signed its OWN on-chain subscribe tx pays for
  // itself, so this one genuinely is attributable to a specific slot.
  agentAutoPay: Record<string, { status: "active" | "past_due"; nextDueAt: string }>;
};
type Invoice = {
  invoiceId: string;
  priceUsd: number;
  leaseIds?: string[]; // slot invoices only — storage-upgrade invoices omit this
  renewing?: boolean; // slot invoices only
  payTo: string;
  memo: string;
  payOptions: { symbol: string; contract: string; quantity: string }[];
  expiresAt: string;
};
type StoragePlanStatus = {
  mailboxActor: string;
  tier: "base" | "pro";
  source?: "paid";
  quotaBytes: number;
  usedBytes: number | null;
  paidUntil: string | null;
  graceEndsAt: string | null;
};
type StorageStatus = {
  owner: string;
  baseQuotaBytes: number;
  proQuotaBytes: number;
  priceUsd: number;
  periodDays: number;
  gracePeriodDays: number;
  plans: StoragePlanStatus[];
};
// leaseIds omitted = renew everything (the top-level "Renew all" bundle);
// set = renew just this one lease (Feature A: the Renew button on a
// specific agent's own card). cardAgentActor is set ONLY for the
// per-agent case, purely so the invoice card renders on the right card —
// it plays no role in what actually gets renewed (leaseIds already says
// that).
type PayContext =
  | { kind: "new"; agentActor: string }
  | { kind: "renew"; leaseIds?: string[]; cardAgentActor?: string }
  | { kind: "storage-upgrade"; mailboxActor: string };
type PayFlow = {
  context: PayContext;
  phase: "creating" | "waiting" | "claiming" | "done" | "error";
  invoice: Invoice | null;
  error: string;
  payToken: string;
  showManual: boolean;
};

type Section = "inbox" | "grants" | "incoming" | "issued";

// Overspend guard (task #148) — UX consistency only, the backend is the
// real boundary (auth/src/grant-store.ts's isEligibleForRenewal /
// RENEW_ELIGIBILITY_DAYS, kept in sync by hand since this is a separate
// deployable). Mirrors the same rule: renewable once within 7 days of
// paidUntil, or already past it (grace/suspended stays renewable — a
// negative diff naturally passes `<=`). Showing a "Renew" button that the
// backend would just 400 is worse than not showing one.
const RENEW_ELIGIBILITY_DAYS = 7;
function isEligibleForRenewal(paidUntil: string): boolean {
  return new Date(paidUntil).getTime() - Date.now() <= RENEW_ELIGIBILITY_DAYS * 86_400_000;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    accepted: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    revoked: "bg-red-500/15 text-red-500",
    declined: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide", colors[status] ?? "bg-muted text-muted-foreground")}>
      {status}
    </span>
  );
}

export default function GrantsContent() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const hasAccount = useAccountStore((s) => s.hasAccount);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const getAccountById = useAccountStore((s) => s.getAccountById);
  const { jmapServerUrl, devMode } = useConfig();

  const [token, setToken] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [tokenExpiresAt, setTokenExpiresAt] = useState<Date | null>(null);
  const [linked, setLinked] = useState<LinkedAccounts | null>(null);
  const [incoming, setIncoming] = useState<IncomingGrant[]>([]);
  const [issued, setIssued] = useState<IssuedGrant[]>([]);
  const [accepted, setAccepted] = useState<AcceptedGrant[]>([]);
  const [incomingPm, setIncomingPm] = useState<PendingMailbox[]>([]);
  const [sentPm, setSentPm] = useState<PendingMailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState<Section>("inbox");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [leaseInfo, setLeaseInfo] = useState<LeaseInfo | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  // Single in-flight payment flow at a time (buying a new slot for one
  // agent, or renewing every current lease in one bundled invoice) — a
  // plain transfer+memo has none of the per-row wallet-session concerns
  // the old subscription flow had, so there's no need for independent
  // per-agent state machines here.
  const [payFlow, setPayFlow] = useState<PayFlow | null>(null);
  const [signing, setSigning] = useState(false);
  // TEMP DEBUG (remove once the reused-session report is resolved): shows
  // directly on the Pay button whether a cached session was actually
  // reused, since getting console output from a live test has been slow
  // going back and forth.
  const [signingDebug, setSigningDebug] = useState<string | null>(null);
  const [releaseFlow, setReleaseFlow] = useState<{ leaseId: string; phase: "confirm" | "releasing" | "error"; error: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [removingAgent, setRemovingAgent] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<Record<string, string>>({});
  const [webhooks, setWebhooks] = useState<WebhookSub[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookAdding, setWebhookAdding] = useState(false);
  const [webhookError, setWebhookError] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState<{ id: string; secret: string } | null>(null);
  const [deletingWebhookId, setDeletingWebhookId] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
  }, []);

  const startPolling = useCallback((loadFn: (background?: boolean) => Promise<void>) => {
    stopPolling();
    pollIntervalRef.current = setInterval(() => loadFn(true), 5000);
    pollTimeoutRef.current = setTimeout(stopPolling, 2 * 60 * 1000);
  }, [stopPolling]);

  const authFetch = useCallback(async (path: string, opts?: RequestInit) => {
    if (!token) throw new Error("Not authenticated");
    const res = await fetch(`${AUTH_URL}${path}`, {
      ...opts,
      headers: { ...opts?.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (res.status === 401) {
      if (activeAccountId) {
        localStorage.removeItem(getAccountScopedKey("sigil_auth_token", activeAccountId));
        localStorage.removeItem(getAccountScopedKey("sigil_actor", activeAccountId));
      }
      router.push("/login");
      throw new Error("Session expired");
    }
    return res.json();
  }, [token, router, activeAccountId]);

  const loadAll = useCallback(async (background = false) => {
    if (!token) return;
    if (!background) setLoading(true);
    try {
      const [linkedRes, incomingRes, issuedRes, acceptedRes, incomingPmRes, sentPmRes, quotaRes, leaseInfoRes, storageStatusRes, webhooksRes] = await Promise.all([
        authFetch("/api/agentcore/linked"),
        authFetch("/api/grants/incoming"),
        authFetch("/api/grants/issued"),
        authFetch("/api/grants/accepted"),
        authFetch("/api/mailboxes/pending/incoming"),
        authFetch("/api/mailboxes/pending/sent"),
        authFetch("/api/quota").catch(() => null),
        authFetch("/api/slots/leases").catch(() => null),
        authFetch("/api/storage/status").catch(() => null),
        authFetch("/api/webhooks").catch(() => null),
      ]);
      if (linkedRes.ownedAgents) setLinked(linkedRes);
      if (quotaRes?.ok) setQuota(quotaRes);
      if (leaseInfoRes?.ok) setLeaseInfo(leaseInfoRes);
      if (storageStatusRes?.ok) setStorageStatus(storageStatusRes);
      if (webhooksRes?.ok) setWebhooks(webhooksRes.webhooks ?? []);
      setIncoming(incomingRes.grants ?? []);
      setIssued(issuedRes.grants ?? []);
      setAccepted(acceptedRes.grants ?? []);
      setIncomingPm(incomingPmRes.pendingMailboxes ?? incomingPmRes.pending ?? []);
      setSentPm(sentPmRes.pendingMailboxes ?? sentPmRes.sent ?? []);
    } catch { /* non-fatal */ }
    setLoading(false);
  }, [token, authFetch]);

  // Re-reads whenever the account switcher changes activeAccountId — the
  // sigil session (grants/storage auth, separate from the JMAP mail
  // session) is stored per-account (see login/page.tsx + confirm/page.tsx),
  // so switching accounts, or logging out of the active one and falling
  // back to a remaining account, both correctly update this page instead
  // of leaving it pinned to whichever account last completed wallet-connect.
  useEffect(() => {
    // Clear the previous account's data immediately so switching never
    // flashes the old account's grants/agents/storage before the fresh
    // fetch (triggered below via loadAll's own token dependency) lands.
    setLinked(null);
    setIncoming([]);
    setIssued([]);
    setAccepted([]);
    setIncomingPm([]);
    setSentPm([]);
    setQuota(null);
    setLeaseInfo(null);
    setStorageStatus(null);
    setTokenExpiresAt(null);
    setWebhooks([]);
    setNewWebhookSecret(null);
    setWebhookError("");

    if (!activeAccountId) { setToken(null); setActor(null); setLoading(false); return; }
    let t = localStorage.getItem(getAccountScopedKey("sigil_auth_token", activeAccountId));
    let a = localStorage.getItem(getAccountScopedKey("sigil_actor", activeAccountId));

    // One-time migration: a session established before per-account scoping
    // shipped (2026-07-14) left its token/actor under the old flat keys.
    // Only adopt them if the flat sigil_actor actually matches THIS
    // account's own actor — otherwise it belongs to a different account
    // that happened to wallet-connect last, and applying it here would
    // silently show the wrong person's grants.
    if (!t || !a) {
      const flatT = localStorage.getItem("sigil_auth_token");
      const flatA = localStorage.getItem("sigil_actor");
      const ownUsername = getAccountById(activeAccountId)?.username ?? "";
      const ownActor = ownUsername.split("@")[0];
      if (flatT && flatA && ownActor && flatA === ownActor) {
        localStorage.setItem(getAccountScopedKey("sigil_auth_token", activeAccountId), flatT);
        localStorage.setItem(getAccountScopedKey("sigil_actor", activeAccountId), flatA);
        localStorage.removeItem("sigil_auth_token");
        localStorage.removeItem("sigil_actor");
        t = flatT;
        a = flatA;
      }
    }

    if (!t || !a) { setToken(null); setActor(null); setLoading(false); return; }
    setToken(t);
    setActor(a);
    try {
      const payload = JSON.parse(atob(t.split(".")[1]));
      if (payload.exp) setTokenExpiresAt(new Date(payload.exp * 1000));
    } catch { /* non-fatal */ }
  }, [activeAccountId, getAccountById]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Stop polling once no pending outgoing grants remain (all accepted/revoked)
  useEffect(() => {
    const hasPending = issued.some(g => g.status === "pending");
    if (!hasPending) stopPolling();
  }, [issued, stopPolling]);

  // Clean up on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const setStatus = (id: string, msg: string) =>
    setActionStatus((s) => ({ ...s, [id]: msg }));

  const clearStatus = (id: string) =>
    setActionStatus((s) => { const next = { ...s }; delete next[id]; return next; });

  const addGrantedAccount = async (username: string, password: string): Promise<boolean> => {
    if (!jmapServerUrl) return false;
    try {
      return await login(jmapServerUrl, username, password, undefined, true);
    } catch {
      return false;
    }
  };

  // Owner -> agent mailbox access is IMPLICIT: you created the agent, you pay
  // for its slot, you already get its credential in plaintext at claim time
  // (the box below). No consent ceremony needed here, unlike accepting a
  // grant — that asymmetry (agent -> human access stays EXPLICIT, via grants
  // only) is deliberate, not an oversight.
  const openAgentInWebmail = async (agentActor: string) => {
    const key = `openwebmail-${agentActor}`;
    setActionStatus((s) => ({ ...s, [key]: "Adding…" }));
    try {
      const username = `${agentActor}@mailsigil.pro`;
      if (jmapServerUrl && hasAccount(username, jmapServerUrl)) {
        await switchAccount(generateAccountId(username, jmapServerUrl));
        clearStatus(key);
        router.push("/");
        return;
      }
      const cred = await claimAgentMailbox(agentActor);
      const added = await addGrantedAccount(cred.username, cred.password);
      if (!added) throw new Error("mailbox is ready, but adding it to your account switcher failed — try again");
      clearStatus(key);
      router.push("/");
    } catch (err: any) {
      setActionStatus((s) => ({ ...s, [key]: err?.message ?? "failed" }));
    }
  };

  const handleAccept = async (grantId: string) => {
    setStatus(grantId, "Accepting…");
    try {
      const res = await authFetch(`/api/grants/${grantId}/accept`, { method: "POST" });
      if (res.ok) {
        await loadAll();
        const credRes = await authFetch(`/api/grants/${grantId}/credential`);
        if (credRes.ok && credRes.username) {
          setStatus(grantId, "Adding to account switcher…");
          const added = await addGrantedAccount(credRes.username, credRes.password);
          if (added) { router.push("/"); return; }
        }
        setStatus(grantId, "Accepted");
        setTimeout(() => clearStatus(grantId), 3000);
      } else {
        setStatus(grantId, res.error || "Failed");
        setTimeout(() => clearStatus(grantId), 3000);
      }
    } catch { setStatus(grantId, "Error"); setTimeout(() => clearStatus(grantId), 3000); }
  };

  const handleDecline = async (grantId: string) => {
    setStatus(grantId, "Declining…");
    try {
      await authFetch(`/api/grants/${grantId}`, { method: "DELETE" });
      await loadAll();
      clearStatus(grantId);
    } catch { setStatus(grantId, "Error"); setTimeout(() => clearStatus(grantId), 3000); }
  };

  const handleRevoke = async (grantId: string) => {
    setStatus(grantId, "Revoking…");
    try {
      await authFetch(`/api/grants/${grantId}`, { method: "DELETE" });
      await loadAll();
      clearStatus(grantId);
    } catch { setStatus(grantId, "Error"); setTimeout(() => clearStatus(grantId), 3000); }
  };

  // ── Give a linked agent a Sigil mailbox — free (room in quota) or paid
  //    ($1 per 30-day lease, plain transfer) when it isn't. Both paths end
  //    at the same place: claim-agent-mailbox, which does the real quota
  //    check server-side — this is UI convenience, not the enforcement
  //    boundary.
  const [claimedCreds, setClaimedCreds] = useState<Record<string, { username: string; password: string }>>({});
  const XPR_CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
  const XPR_ENDPOINTS = ["https://proton.eosusa.io", "https://proton.protonuk.io"];

  const claimAgentMailbox = async (agentActor: string): Promise<{ username: string; password: string }> => {
    const res = await authFetch("/api/grants/claim-agent-mailbox", {
      method: "POST",
      body: JSON.stringify({ agentActor }),
    });
    if (!res.ok) throw new Error(res.error || "failed to claim mailbox");
    setClaimedCreds((c) => ({ ...c, [agentActor]: res.credential }));
    return res.credential;
  };

  // Free path — room already exists in quota. Also adds the mailbox straight
  // to the account switcher (best-effort — the credential box below is the
  // fallback if this fails, so a switcher-add error doesn't block the claim
  // itself from being reported as done).
  const handleClaimAgentMailbox = async (agentActor: string) => {
    const key = `claim-${agentActor}`;
    setActionStatus((s) => ({ ...s, [key]: "Provisioning…" }));
    try {
      const cred = await claimAgentMailbox(agentActor);
      await addGrantedAccount(cred.username, cred.password);
      setActionStatus((s) => ({ ...s, [key]: "Done" }));
      loadAll(true); // refresh quota + linked list so the row moves to "has mailbox"
    } catch (err: any) {
      setActionStatus((s) => ({ ...s, [key]: err?.message ?? "failed" }));
    }
  };

  // Wallet connect for slot payments — scan-to-pay via the 3-option
  // selector (Mobile/Browser/Desktop), same as every other wallet action
  // on this page. Safe to use for slot payments specifically because a
  // plain transfer never had the WebAuth problem in the first place — that
  // bug (2026-07-10) was about updateauth/linkauth (permission changes)
  // silently getting dropped over a background push, NOT about ordinary
  // transfers, which every wallet type (including QR/'Mobile') handles
  // fine. Leases are pay-by-transfer only, never permission-changing, so
  // there's no need for the eosio-detection routing the old subscription
  // flow needed — just connect and sign.
  //
  // Always wipes storage and does a genuinely fresh connect — the proven-
  // safe path (auth/NOTES.md 2026-07-10: a stale @proton/link session made
  // transact() hang forever with zero feedback). Caches the resulting
  // session in wallet-session-store so the NEXT purchase in this visit can
  // skip straight to a transfer signature instead of reconnecting — see
  // getWalletSession below, which is what callers should actually use.
  async function freshWalletSession(): Promise<any> {
    try {
      const stale: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith("proton-storage") || key.startsWith("proton-link"))) stale.push(key);
      }
      stale.forEach((k) => localStorage.removeItem(k));
    } catch { /* storage unavailable — proceed, worst case is the old behavior */ }

    const ProtonWebSDK = (await import("@proton/web-sdk")).default;
    await import("@proton/link");
    const { session } = await ProtonWebSDK({
      linkOptions: { chainId: XPR_CHAIN_ID, endpoints: XPR_ENDPOINTS },
      transportOptions: { requestAccount: "mailsigil" },
      selectorOptions: { appName: "Sigil Mail", enabledWalletTypes: ["webauth", "anchor", "proton"] as any },
    });
    if (!session) throw new Error("Wallet connection was cancelled");
    const connected = session.auth.actor.toString();
    if (actor && connected !== actor) {
      throw new Error(`Connected wallet (${connected}) doesn't match your logged-in account (${actor}) — connect the same wallet you signed in with.`);
    }
    useWalletSessionStore.getState().setSession(session);
    return session;
  }

  // Reuses the in-memory session cached by a previous successful connect
  // (see wallet-session-store.ts for why this is safe where the SDK's own
  // storage-based restore wasn't) unless forceFresh is set. Returns
  // whether the session came from cache, so the caller knows whether a
  // transact failure means "genuinely broken" or just "cache went stale,
  // worth one silent retry."
  async function getWalletSession(forceFresh = false): Promise<{ session: any; reused: boolean }> {
    if (!forceFresh) {
      const cached: any = useWalletSessionStore.getState().session;
      // TEMP DEBUG (remove once the reuse-not-kicking-in report is
      // resolved) — logs exactly why a cache hit/miss happened, since
      // this can only be observed live in a real browser.
      console.log("[wallet-session] getWalletSession: cached=", !!cached, "cachedActor=", cached?.auth?.actor?.toString(), "currentActor=", actor);
      // Re-verify actor match on every reuse, not just at connect time —
      // the cache is a global singleton, so it could be holding a session
      // from a DIFFERENT logged-in account if the human switched accounts
      // (see components/layout account-switcher) between purchases.
      // Stale-for-this-actor is treated as a plain cache miss, not an error.
      if (cached && actor && cached.auth?.actor?.toString() === actor) {
        console.log("[wallet-session] reusing cached session — should be 1 sign only");
        return { session: cached, reused: true };
      }
      if (cached) useWalletSessionStore.getState().clearSession();
    }
    console.log("[wallet-session] no usable cache — doing a fresh connect (forceFresh=" + forceFresh + ")");
    return { session: await freshWalletSession(), reused: false };
  }

  async function transactWithTimeout(session: any, payload: any, opts: any, ms = 90_000): Promise<any> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Wallet didn't respond in time — check your WebAuth app, or try again")), ms);
    });
    try {
      return await Promise.race([session.transact(payload, opts), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  // Signs+broadcasts the transfer for one of the invoice's payOptions
  // directly, instead of making the human copy fields into a separate app.
  // Tries a cached wallet session first (1 signature — just the transfer);
  // if that fails, assumes the cache went stale, clears it, and transparently
  // retries once with a genuinely fresh connect (2 signatures, same as the
  // old always-fresh behavior) rather than surfacing a confusing error for
  // what's really just an expired cache.
  const handlePayWithWallet = async (invoice: Invoice, symbol: string) => {
    const opt = invoice.payOptions.find((o) => o.symbol === symbol);
    if (!opt || !actor) return;
    setPayFlow((pf) => (pf ? { ...pf, phase: "waiting", error: "" } : pf));
    setSigning(true);
    const cachedAtStart: any = useWalletSessionStore.getState().session;
    let loginInstance = "n/a";
    try { loginInstance = localStorage.getItem("wallet_session_debug_login_instance") ?? "none-recorded"; } catch { /* noop */ }
    setSigningDebug(
      `debug: cache ${cachedAtStart ? "present" : "EMPTY"}` +
      (cachedAtStart ? `, cachedActor="${cachedAtStart.auth?.actor?.toString()}" vs currentActor="${actor}"` : "") +
      ` | storeInstance(here)=${WALLET_SESSION_STORE_INSTANCE_ID} storeInstance(atLogin)=${loginInstance}`
    );
    const action = {
      account: opt.contract,
      name: "transfer",
      authorization: [{ actor, permission: "active" }],
      data: { from: actor, to: invoice.payTo, quantity: opt.quantity, memo: invoice.memo },
    };
    try {
      const { session, reused } = await getWalletSession();
      setSigningDebug((d) => `${d} → ${reused ? "REUSING cached session (should be 1 sign)" : "fresh connect (2 signs expected)"}`);
      try {
        await transactWithTimeout(session, { actions: [action] }, { broadcast: true });
      } catch (err: any) {
        if (!reused) throw err; // already a fresh session — this is a real failure
        setSigningDebug((d) => `${d} → reused session's transact FAILED (${err?.message ?? err}), falling back to fresh connect`);
        useWalletSessionStore.getState().clearSession();
        const { session: fresh } = await getWalletSession(true);
        await transactWithTimeout(fresh, { actions: [action] }, { broadcast: true });
      }
      // Polling effect below picks up the paid status once it confirms on-chain.
    } catch (err: any) {
      setPayFlow((pf) => (pf ? { ...pf, phase: "waiting", error: err?.message ?? String(err) } : pf));
    } finally {
      setSigning(false);
    }
  };

  // Paid path — creates a pay-by-transfer invoice ($1 × 1 new slot, or
  // $1 × N for a bundled renewal of every current lease) and polls until
  // paid. Primary action is signing the transfer directly in your wallet
  // (native QR-scan/popup, same as any other wallet action here); the
  // account/amount/memo are also shown so you can pay manually from any
  // app if you'd rather (redundant-paths rule) — see
  // BLUEPRINT-slot-renewals.md.
  const handleStartPurchase = async (context: PayContext) => {
    setPayFlow({ context, phase: "creating", invoice: null, error: "", payToken: "XMD", showManual: false });
    try {
      // Same invoice card, different endpoint: storage-upgrade invoices
      // hit /api/storage/upgrade instead of /api/quota/invoice, but the
      // response shape (invoiceId/payTo/memo/payOptions/expiresAt) matches
      // exactly — renderInvoiceCard doesn't know or care which it's paying.
      const [endpoint, body] = context.kind === "storage-upgrade"
        ? ["/api/storage/upgrade", { mailboxActor: context.mailboxActor }]
        : context.kind === "renew"
        ? ["/api/quota/invoice", { leaseIds: context.leaseIds ?? leaseInfo?.leases.map((l) => l.id) ?? [] }]
        : ["/api/quota/invoice", {}];
      const res = await authFetch(endpoint as string, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(res.error || "could not create invoice");
      setPayFlow({ context, phase: "waiting", invoice: res, error: "", payToken: "XMD", showManual: false });
    } catch (err: any) {
      setPayFlow({ context, phase: "error", invoice: null, error: err?.message ?? String(err), payToken: "XMD", showManual: false });
    }
  };

  // Polls the invoice while a payment flow is waiting. On a "new slot"
  // purchase, paid → auto-claim the agent's mailbox (matches the old
  // subscription flow's behavior); on a renewal, paid is the end state —
  // the leases already extended server-side the instant the transfer
  // confirmed on-chain (hyperion.ts's handleTransfer).
  useEffect(() => {
    if (!payFlow || payFlow.phase !== "waiting" || !payFlow.invoice) return;
    const invoiceId = payFlow.invoice.invoiceId;
    const context = payFlow.context;
    const interval = setInterval(async () => {
      try {
        const res = await authFetch(`/api/quota/invoice/${invoiceId}`);
        if (res.status === "paid") {
          clearInterval(interval);
          if (context.kind === "new") {
            setPayFlow((pf) => (pf ? { ...pf, phase: "claiming" } : pf));
            try {
              const cred = await claimAgentMailbox(context.agentActor);
              await addGrantedAccount(cred.username, cred.password); // best-effort, see handleClaimAgentMailbox
              setPayFlow((pf) => (pf ? { ...pf, phase: "done" } : pf));
            } catch (err: any) {
              setPayFlow((pf) => (pf ? { ...pf, phase: "error", error: err?.message ?? "paid, but mailbox provisioning failed — contact support" } : pf));
            }
          } else {
            setPayFlow((pf) => (pf ? { ...pf, phase: "done" } : pf));
          }
          loadAll(true);
        } else if (res.status === "expired") {
          clearInterval(interval);
          setPayFlow((pf) => (pf ? { ...pf, phase: "error", error: "This invoice expired. If you haven't paid, dismiss this and click the button again. If you already sent a payment, don't send another — it's still recognized for up to 24 hours and will be credited automatically; contact support if it hasn't landed by then." } : pf));
        }
      } catch { /* transient network error — keep polling */ }
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payFlow?.phase, payFlow?.invoice?.invoiceId]);

  const copyToClipboard = (field: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1500);
    });
  };

  // Stops paying for one lease going forward — no refund for the current
  // period. Doesn't touch any already-claimed mailbox (see
  // handleRemoveAgentMailbox below for that, a separate action).
  const handleReleaseLease = async (leaseId: string) => {
    setReleaseFlow({ leaseId, phase: "releasing", error: "" });
    try {
      const res = await authFetch("/api/slots/release", { method: "POST", body: JSON.stringify({ leaseId }) });
      if (!res.ok) throw new Error(res.error || "could not release slot");
      setReleaseFlow(null);
      loadAll(true);
    } catch (err: any) {
      setReleaseFlow({ leaseId, phase: "error", error: err?.message ?? String(err) });
    }
  };

  // Push notifications for new mail — the register call returns the HMAC
  // signing secret exactly once (never stored server-side in retrievable
  // form, same pattern as an app-password), so it's held in newWebhookSecret
  // just long enough for the human to copy it, then discarded on dismiss.
  const handleAddWebhook = async () => {
    const url = webhookUrl.trim();
    if (!url) return;
    setWebhookAdding(true);
    setWebhookError("");
    try {
      const res = await authFetch("/api/webhooks", { method: "POST", body: JSON.stringify({ url }) });
      if (!res.ok) throw new Error(res.error || "could not register webhook");
      setWebhooks((w) => [...w, { id: res.id, url: res.url, createdAt: res.createdAt, lastDeliveredAt: null, lastStatus: null }]);
      setNewWebhookSecret({ id: res.id, secret: res.secret });
      setWebhookUrl("");
    } catch (err: any) {
      setWebhookError(err?.message ?? String(err));
    } finally {
      setWebhookAdding(false);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    setDeletingWebhookId(id);
    try {
      const res = await authFetch(`/api/webhooks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error || "could not remove webhook");
      setWebhooks((w) => w.filter((wh) => wh.id !== id));
      if (newWebhookSecret?.id === id) setNewWebhookSecret(null);
    } catch (err: any) {
      setWebhookError(err?.message ?? String(err));
    } finally {
      setDeletingWebhookId(null);
    }
  };

  // Shared render for the in-progress payFlow, whichever context triggered
  // it (buying a new slot inline in that agent's row, or renewing all
  // leases in the manage-slots section above). Primary action is signing
  // the transfer directly in your wallet (native QR-scan for 'Mobile',
  // popup for 'Browser'/'Desktop' — same 3-option connect as everywhere
  // else on this page); manual account/amount/memo fields stay available
  // behind a toggle as the redundant-paths fallback, not the default.
  // Gabriel, 2026-07-11: "we used to have scan to pay... just use what we
  // had before we added subscriptions" — restored after over-correcting
  // to copy-paste-only earlier the same night.
  const renderInvoiceCard = () => {
    if (!payFlow) return null;
    const { phase, invoice, error, context } = payFlow;

    if (phase === "creating") {
      return (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Creating invoice…
        </div>
      );
    }
    if (phase === "claiming") {
      return (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Paid — provisioning mailbox…
        </div>
      );
    }
    if (phase === "done") {
      return (
        <div className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 mt-2 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
          <Check className="w-3 h-3 shrink-0" /> {context.kind === "renew" ? "Renewed." : context.kind === "storage-upgrade" ? "Pro tier active." : "Paid."}
          <button onClick={() => setPayFlow(null)} className="ml-auto text-muted-foreground underline underline-offset-2">Close</button>
        </div>
      );
    }
    if (phase === "error") {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 mt-2 space-y-1">
          <p className="text-xs text-destructive">{error}</p>
          <button onClick={() => setPayFlow(null)} className="text-xs text-muted-foreground underline underline-offset-2">Dismiss</button>
        </div>
      );
    }
    if (phase === "waiting" && invoice) {
      // Restated right before an irreversible transfer — the button that
      // started this flow may be several seconds (or a scroll) away by
      // the time someone actually signs. Uses the invoice's own priceUsd
      // (the price actually locked in) rather than any live quota state.
      const days = context.kind === "storage-upgrade" ? (storageStatus?.periodDays ?? 30) : (leaseInfo?.periodDays ?? 30);
      const purchaseSummary =
        context.kind === "new" ? `New mailbox slot for ${context.agentActor} — $${invoice.priceUsd}, ${days}-day lease`
        : context.kind === "storage-upgrade" ? `Sigil Mail Pro for ${context.mailboxActor} — $${invoice.priceUsd}, ${days} days`
        : (() => {
            const n = invoice.leaseIds?.length;
            return n ? `Renewing ${n} slot${n > 1 ? "s" : ""} — $${invoice.priceUsd}, ${days} more days each` : `Renewing your slots — $${invoice.priceUsd}, ${days} more days`;
          })();
      return (
        <div className="rounded-md border border-border bg-card px-3 py-3 mt-2 space-y-2">
          <p className="text-xs font-medium">{purchaseSummary}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Pay in</span>
            {invoice.payOptions.map((opt) => (
              <button
                key={opt.symbol}
                onClick={() => setPayFlow((pf) => (pf ? { ...pf, payToken: opt.symbol } : pf))}
                className={cn(
                  "text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors",
                  payFlow?.payToken === opt.symbol
                    ? "border-[#FACC15] bg-[#FACC15]/15 text-[#854d0e] dark:text-[#FACC15]"
                    : "border-border text-muted-foreground hover:border-[#FACC15]/50",
                )}
              >
                {opt.symbol}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            onClick={() => handlePayWithWallet(invoice, payFlow?.payToken ?? "XMD")}
            disabled={signing}
            className="w-full text-xs bg-[#FACC15] hover:bg-[#EAB308] text-black"
          >
            {signing ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Opening wallet…</>) : "Pay"}
          </Button>
          {signingDebug && <p className="text-[10px] font-mono text-muted-foreground break-all">{signingDebug}</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> Waiting for payment… (expires {new Date(invoice.expiresAt).toLocaleTimeString()})
          </p>
          <button
            onClick={() => setPayFlow((pf) => (pf ? { ...pf, showManual: !pf.showManual } : pf))}
            className="text-xs text-muted-foreground underline underline-offset-2"
          >
            {payFlow?.showManual ? "Hide manual payment details" : "Or pay manually from any wallet app"}
          </button>
          {payFlow?.showManual && (
            <div className="space-y-2 pt-1 border-t border-border">
              <p className="text-xs text-muted-foreground">
                Send ANY ONE of these amounts to <span className="font-mono">{invoice.payTo}</span>{" "}with memo{" "}
                <span className="font-mono">{invoice.memo}</span>.
              </p>
              <div className="space-y-1">
                {invoice.payOptions.map((opt) => (
                  <div key={opt.symbol} className="flex items-center justify-between gap-2 text-xs font-mono bg-muted px-2 py-1 rounded">
                    <span>{opt.quantity}</span>
                    <button
                      onClick={() => copyToClipboard(`amt-${opt.symbol}`, opt.quantity.split(" ")[0])}
                      className="text-muted-foreground hover:text-foreground shrink-0 font-sans"
                    >
                      {copiedField === `amt-${opt.symbol}` ? "Copied" : "Copy"}
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 text-xs">
                <button onClick={() => copyToClipboard("payTo", invoice.payTo)} className="underline underline-offset-2 text-muted-foreground hover:text-foreground">
                  {copiedField === "payTo" ? "Copied account" : "Copy account"}
                </button>
                <button onClick={() => copyToClipboard("memo", invoice.memo)} className="underline underline-offset-2 text-muted-foreground hover:text-foreground">
                  {copiedField === "memo" ? "Copied memo" : "Copy memo"}
                </button>
              </div>
            </div>
          )}
          <div className="pt-1">
            <button
              onClick={() => setPayFlow(null)}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return null;
  };

  // Deletes ONE linked agent's Sigil mailbox to free the slot it occupies —
  // real mail data, permanent. Distinct from the subscription cancel above:
  // this changes how many slots are USED, not how many are PAID for.
  const handleRemoveAgentMailbox = async (agentActor: string) => {
    setRemovingAgent(agentActor);
    setRemoveError((e) => ({ ...e, [agentActor]: "" }));
    try {
      const res = await authFetch("/api/grants/remove-agent-mailbox", {
        method: "POST",
        body: JSON.stringify({ agentActor }),
      });
      if (!res.ok) throw new Error(res.error || "failed to remove mailbox");
      loadAll(true);
    } catch (err: any) {
      setRemoveError((e) => ({ ...e, [agentActor]: err?.message ?? String(err) }));
    } finally {
      setRemovingAgent(null);
    }
  };

  const handleOfferGrant = async (toActor: string) => {
    const key = `offer-${toActor}`;
    setStatus(key, "Sending…");
    try {
      const res = await authFetch("/api/grants/offer", {
        method: "POST",
        body: JSON.stringify({ granteeActor: toActor }),
      });
      if (res.id || res.ok) {
        await loadAll();
        clearStatus(key);
        startPolling(loadAll);
      } else {
        setStatus(key, res.error || "Failed");
        setTimeout(() => clearStatus(key), 4000);
      }
    } catch { setStatus(key, "Error"); setTimeout(() => clearStatus(key), 3000); }
  };

  const handleOpenGrantedMailbox = async (grant: AcceptedGrant) => {
    const key = `open-${grant.grantId}`;
    setStatus(key, "Opening…");
    try {
      const credRes = await authFetch(`/api/grants/${grant.grantId}/credential`);
      if (credRes.ok && credRes.username) {
        const added = await addGrantedAccount(credRes.username, credRes.password);
        if (added) { router.push("/"); return; }
      }
      setStatus(key, credRes.error || "Failed");
      setTimeout(() => clearStatus(key), 3000);
    } catch { setStatus(key, "Error"); setTimeout(() => clearStatus(key), 3000); }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== "DELETE") return;
    setDeleting(true);
    try {
      const res = await authFetch("/api/account", { method: "DELETE" });
      if (res.ok) {
        localStorage.removeItem("sigil_auth_token");
        localStorage.removeItem("sigil_actor");
        router.push("/login");
      } else {
        setDeleting(false);
        setDeleteConfirmText("");
        setStatus("delete-account", res.error || "Deletion failed");
        setTimeout(() => clearStatus("delete-account"), 4000);
      }
    } catch {
      setDeleting(false);
      setDeleteConfirmText("");
      setStatus("delete-account", "Deletion failed");
      setTimeout(() => clearStatus("delete-account"), 4000);
    }
  };

  const confirmPendingMailbox = async (pmId: string) => {
    const key = `pm-${pmId}`;
    setStatus(key, "Confirming…");
    try {
      const res = await authFetch(`/api/mailboxes/pending/${pmId}/confirm`, { method: "POST" });
      if (res.ok) {
        setStatus(key, "Confirmed");
        await loadAll();
      } else {
        setStatus(key, res.error || "Failed");
        setTimeout(() => clearStatus(key), 3000);
      }
    } catch { setStatus(key, "Error"); setTimeout(() => clearStatus(key), 3000); }
  };

  const incomingCount = incoming.length + incomingPm.length;

  if (!actor && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
        <ShieldCheck className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm font-medium">Agent grants</p>
        <p className="text-xs text-muted-foreground">
          {devMode
            ? "Not available in dev mode — sign in with your XPR wallet on production to manage agent access."
            : "Your session expired. Sign out and sign back in with your XPR wallet to continue."}
        </p>
      </div>
    );
  }

  if (!actor) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const navItems: { id: Section; label: string; badge?: number }[] = [
    { id: "inbox", label: "My Mailbox" },
    { id: "grants", label: "Agent Wallets", badge: (linked?.ownedAgents.length ?? 0) + (linked?.ownedBy ? 1 : 0) || undefined },
    { id: "incoming", label: "Incoming Offers", badge: incomingCount > 0 ? incomingCount : undefined },
    { id: "issued", label: "Issued Grants" },
  ];

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden bg-background">
      {/* Mobile: horizontal tab bar at top */}
      <nav className="md:hidden flex overflow-x-auto border-b border-border bg-background shrink-0">
        <div className="flex items-center gap-1 px-2 py-2 shrink-0">
          <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "#FACC15" }} />
          <span className="font-semibold text-sm whitespace-nowrap">Authorization</span>
        </div>
        <div className="flex items-stretch">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors",
                activeSection === item.id
                  ? "border-primary text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{item.label}</span>
              {item.badge !== undefined && (
                <span className="text-[10px] bg-primary text-primary-foreground rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => loadAll()}
            className="flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:text-foreground border-b-2 border-transparent"
          >
            <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </nav>

      {/* Desktop: left sidebar */}
      <aside className="hidden md:flex w-52 shrink-0 border-r border-border flex-col py-4 gap-1">
        <div className="px-4 pb-3 flex items-center gap-2 border-b border-border mb-1">
          <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "#FACC15" }} />
          <span className="font-semibold text-sm">Authorization</span>
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveSection(item.id)}
            className={cn(
              "flex items-center justify-between px-4 py-2 text-sm rounded-md mx-2 transition-colors",
              activeSection === item.id
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
            )}
          >
            <span>{item.label}</span>
            {item.badge !== undefined && (
              <span className="text-xs bg-primary text-primary-foreground rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                {item.badge}
              </span>
            )}
          </button>
        ))}
        <div className="mt-auto px-4 pt-3 border-t border-border">
          <button
            onClick={() => loadAll()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        {loading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {/* ── My Mailbox ── */}
        {activeSection === "inbox" && (
          <div className="max-w-xl space-y-4">
            <h1 className="text-lg font-semibold">My Mailbox</h1>
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Mail className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium break-words">{actor}@mailsigil.pro</p>
                  {tokenExpiresAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Auth session valid until {tokenExpiresAt.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      {" · "}sign out from the main menu to refresh
                    </p>
                  )}
                </div>
              </div>
            </div>

            {actor && storageStatus && (() => {
              const ownPlan = storageStatus.plans.find((p) => p.mailboxActor === actor);
              const isPro = ownPlan?.tier === "pro";
              const now = Date.now();
              const isInGrace = isPro && ownPlan!.paidUntil !== null && new Date(ownPlan!.paidUntil).getTime() <= now;
              const daysUntilBlocked = isInGrace
                ? Math.max(0, Math.ceil((new Date(ownPlan!.graceEndsAt!).getTime() - now) / 86_400_000))
                : 0;
              const ownPayFlow = payFlow?.context.kind === "storage-upgrade" && payFlow.context.mailboxActor === actor ? payFlow : null;
              const quotaBytes = ownPlan?.quotaBytes ?? storageStatus.baseQuotaBytes;
              const usedPct = ownPlan?.usedBytes != null ? Math.min(100, (ownPlan.usedBytes / quotaBytes) * 100) : null;

              return (
                <div className="rounded-lg border border-border bg-card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Storage</p>
                      <p className={cn("text-xs", isInGrace ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                        {isInGrace
                          ? `Past due since ${new Date(ownPlan!.paidUntil!).toLocaleDateString()} — grace period, drops to ${storageStatus.baseQuotaBytes / 1024 ** 3}GB in ${daysUntilBlocked} day${daysUntilBlocked === 1 ? "" : "s"} if not renewed`
                          : isPro
                          ? `Pro ${storageStatus.proQuotaBytes / 1024 ** 3}GB — renews ${new Date(ownPlan!.paidUntil!).toLocaleDateString()}`
                          : `${storageStatus.baseQuotaBytes / 1024 ** 3}GB base`}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      {/* Overspend guard (task #148): once Pro and comfortably
                          active (not in grace, not near expiry), there's
                          nothing to renew yet — the backend would 400 this. */}
                      {(!isPro || isInGrace || isEligibleForRenewal(ownPlan!.paidUntil!)) && (
                        <Button
                          size="sm"
                          variant={isPro && !isInGrace ? "outline" : "default"}
                          onClick={() => handleStartPurchase({ kind: "storage-upgrade", mailboxActor: actor })}
                          disabled={!!payFlow}
                          className={cn("text-xs h-7", (!isPro || isInGrace) && "bg-[#FACC15] hover:bg-[#EAB308] text-black")}
                        >
                          {isPro ? `Renew — $${storageStatus.priceUsd}` : `Upgrade to Pro — $${storageStatus.priceUsd}/mo`}
                        </Button>
                      )}
                      <span className="text-[10px] text-muted-foreground">({storageStatus.proQuotaBytes / 1024 ** 3}GB)</span>
                    </div>
                  </div>
                  {usedPct !== null && (
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden" title={`${(ownPlan!.usedBytes! / 1024 / 1024).toFixed(1)}MB of ${quotaBytes / 1024 ** 3}GB used`}>
                      <div className="h-full bg-[#FACC15]" style={{ width: `${usedPct}%` }} />
                    </div>
                  )}
                  {ownPayFlow && renderInvoiceCard()}
                </div>
              );
            })()}

            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Webhooks</p>
                  <p className="text-xs text-muted-foreground">
                    Get a push notification when new mail arrives here — no polling needed. Useful if you or an agent run a service that reacts to mail. Up to 5.
                  </p>
                </div>
                <Webhook className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              </div>

              {webhooks.length > 0 && (
                <div className="space-y-1.5">
                  {webhooks.map((wh) => (
                    <div key={wh.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5">
                      <div className="min-w-0">
                        <p className="text-xs font-mono break-all">{wh.url}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {wh.lastDeliveredAt ? `last delivered ${timeAgo(wh.lastDeliveredAt)}${wh.lastStatus ? ` · ${wh.lastStatus}` : ""}` : "no deliveries yet"}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteWebhook(wh.id)}
                        disabled={deletingWebhookId === wh.id}
                        className="text-muted-foreground hover:text-destructive shrink-0 p-1"
                        aria-label="Remove webhook"
                      >
                        {deletingWebhookId === wh.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {newWebhookSecret && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-1.5">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    Signing secret — copy it now, it won&apos;t be shown again
                  </p>
                  <div className="flex items-center justify-between gap-2 bg-background rounded px-2 py-1">
                    <span className="text-xs font-mono break-all">{newWebhookSecret.secret}</span>
                    <button
                      onClick={() => copyToClipboard("webhook-secret", newWebhookSecret.secret)}
                      className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                    >
                      {copiedField === "webhook-secret" ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Every delivery is HMAC-SHA256 signed with this secret so you can verify it really came from Sigil.
                  </p>
                  <button onClick={() => setNewWebhookSecret(null)} className="text-[10px] text-muted-foreground underline underline-offset-2">
                    Done
                  </button>
                </div>
              )}

              {webhooks.length < 5 ? (
                <div className="space-y-1.5 pt-1 border-t border-border">
                  <div className="flex gap-1.5">
                    <input
                      type="url"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://your-endpoint.example.com/hook"
                      disabled={webhookAdding}
                      className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <Button size="sm" onClick={handleAddWebhook} disabled={webhookAdding || !webhookUrl.trim()} className="text-xs h-7 shrink-0">
                      {webhookAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : "Add"}
                    </Button>
                  </div>
                  {webhookError && <p className="text-xs text-destructive">{webhookError}</p>}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground pt-1 border-t border-border">
                  Limit of 5 webhooks reached — remove one to add another.
                </p>
              )}
            </div>

            {accepted.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-muted-foreground mb-2">Shared Mailboxes</h2>
                <div className="space-y-2">
                  {accepted.map((g) => {
                    const key = `open-${g.grantId}`;
                    return (
                      <div key={g.grantId} className="rounded-lg border border-border bg-card p-4 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-words">{g.ownerActor}@mailsigil.pro</p>
                          <p className="text-xs text-muted-foreground">
                            {g.scope} access{g.acceptedAt ? ` · accepted ${timeAgo(g.acceptedAt)}` : ""}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleOpenGrantedMailbox(g)}
                          disabled={!!actionStatus[key]}
                          className="shrink-0 text-xs"
                        >
                          {actionStatus[key] ?? "Add Mailbox"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-6 pt-5 border-t border-border">
              <h2 className="text-sm font-medium text-destructive mb-3">Danger Zone</h2>
              {!showDeleteConfirm ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm text-muted-foreground mb-3">
                    Permanently delete your mailbox and all its email data. This cannot be undone.
                  </p>
                  {actionStatus["delete-account"] && (
                    <p className="text-xs text-destructive mb-2">{actionStatus["delete-account"]}</p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="text-xs text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                  >
                    Delete Account
                  </Button>
                </div>
              ) : (
                <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 space-y-3">
                  <p className="text-sm font-medium text-destructive">
                    Permanently delete <strong className="break-all">{actor}@mailsigil.pro</strong>{" "}and all its email?
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Type <strong>DELETE</strong>{" "}to confirm — this cannot be undone.
                  </p>
                  <input
                    type="text"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="DELETE"
                    disabled={deleting}
                    className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-destructive"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={deleteConfirmText !== "DELETE" || deleting}
                      onClick={handleDeleteAccount}
                      className="text-xs"
                    >
                      {deleting ? (
                        <><Loader2 className="w-3 h-3 animate-spin mr-1" />Deleting…</>
                      ) : "Delete Forever"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={deleting}
                      onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(""); }}
                      className="text-xs"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Agent Wallets ──
            Redesigned 2026-07-02: no more standalone "Agent slots" card.
            Every agentcore-linked agent gets its own row; unclaimed rows
            carry their OWN claim-or-buy action, so a $1 signing request is
            never disconnected from a specific agent that needs it (the bug
            that let a real payment prompt fire with zero actual demand —
            found live). Rows are grouped has-mailbox (top) then unclaimed
            (below); a row moves to the top group the moment its mailbox is
            claimed, free or paid. */}
        {activeSection === "grants" && (
          <div className="max-w-xl space-y-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">Agent Wallets</h1>
                <a
                  href={`${AUTH_URL}/agent-wallets-guide.md`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline underline-offset-2 hover:opacity-80"
                  style={{ color: "#FACC15" }}
                >
                  How agent wallets works
                </a>
              </div>
              {quota && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {quota.agentMailboxes.used} of {quota.agentMailboxes.limit} agent slots used ({quota.agentMailboxes.max} max)
                  {quota.agentMailboxes.purchasedSlots > 0 && ` (${quota.agentMailboxes.purchasedSlots} lifetime)`}
                  {leaseInfo && leaseInfo.leases.length > 0 && ` (${leaseInfo.leases.length} on manual renewal)`}
                  {leaseInfo?.autoPaySubscription && ` (${leaseInfo.autoPaySubscription.quantity} on agent auto-pay${leaseInfo.autoPaySubscription.status === "past_due" ? " — past due" : ""})`}.
                </p>
              )}
              {leaseInfo && (() => {
                const now = Date.now();
                const inGrace = leaseInfo.leases.filter(
                  (l) => new Date(l.paidUntil).getTime() <= now && new Date(l.graceEndsAt).getTime() > now,
                );
                const suspended = leaseInfo.suspendedMailboxes;
                if (inGrace.length === 0 && suspended.length === 0) return null;
                const soonestBlocked = inGrace.reduce(
                  (earliest, l) => (l.graceEndsAt < earliest ? l.graceEndsAt : earliest),
                  inGrace[0]?.graceEndsAt ?? "",
                );
                const daysUntilBlocked = inGrace.length > 0
                  ? Math.max(0, Math.ceil((new Date(soonestBlocked).getTime() - now) / 86_400_000))
                  : 0;
                return (
                  <div className="mt-2 space-y-2">
                    {inGrace.length > 0 && (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 space-y-1">
                        <p className="font-medium">
                          {inGrace.length} slot{inGrace.length > 1 ? "s" : ""} past due — still working, blocked in {daysUntilBlocked} day{daysUntilBlocked === 1 ? "" : "s"} if not renewed.
                        </p>
                        <p className="text-amber-700/80 dark:text-amber-400/80">
                          Sigil gives a {leaseInfo.gracePeriodDays}-day grace period after a slot's due date — the mailbox keeps working normally. After that it's blocked (no send/receive, data untouched) until renewed, and permanently deleted if still unpaid {leaseInfo.autoDeleteAfterSuspendedDays} days after being blocked.
                        </p>
                      </div>
                    )}
                    {suspended.length > 0 && (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive space-y-1">
                        <p className="font-medium">{suspended.length} mailbox{suspended.length > 1 ? "es" : ""} blocked for non-payment:</p>
                        <ul className="space-y-0.5">
                          {suspended.map((m) => (
                            <li key={m.agentActor}>
                              {m.agentActor} — permanently deleted {new Date(m.autoDeleteAt).toLocaleDateString()} unless renewed
                            </li>
                          ))}
                        </ul>
                        <p className="text-destructive/80">Renew any slot below to reactivate instantly — a fresh access credential will be emailed to you.</p>
                      </div>
                    )}
                  </div>
                );
              })()}
              {leaseInfo && leaseInfo.leases.length > 0 && (() => {
                // Feature A: an attached lease manages from its own agent's
                // card now (renews/Stop renewing live there) — this dropdown is
                // only for leases nothing claimed yet (spare/unassigned).
                const unattached = leaseInfo.leases.filter((l) => !l.agentActor);
                // Overspend guard (task #148): only bundle leases the backend
                // will actually accept (near-expiry or past due) — a fresh
                // lease with weeks left just gets left out of the count/price
                // rather than causing the whole "Renew all" to 400.
                const dueLeases = leaseInfo.leases.filter((l) => isEligibleForRenewal(l.paidUntil));
                return (
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">
                      Renews by {new Date(leaseInfo.leases.reduce((earliest, l) => (l.paidUntil < earliest ? l.paidUntil : earliest), leaseInfo.leases[0].paidUntil)).toLocaleDateString()}
                    </span>
                    {dueLeases.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleStartPurchase({ kind: "renew", leaseIds: dueLeases.map((l) => l.id) })}
                        disabled={!!payFlow}
                        className="text-xs h-6"
                      >
                        Renew {dueLeases.length < leaseInfo.leases.length ? `${dueLeases.length} due` : "all"} (${dueLeases.length * leaseInfo.priceUsdPerSlot})
                      </Button>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      Have an agent? It can renew this automatically —{" "}
                      <a href={`${AUTH_URL}/agent-wallets-guide.md`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: "#FACC15" }}>
                        see how
                      </a>
                    </span>
                  </div>
                  {unattached.length > 0 && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer underline underline-offset-2 hover:text-foreground">
                        Manage {unattached.length} unassigned slot{unattached.length > 1 ? "s" : ""}
                      </summary>
                      <ul className="mt-1.5 space-y-1">
                        {unattached.map((l) => (
                          <li key={l.id} className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span>slot {l.id.slice(0, 8)} — manual, renews {new Date(l.paidUntil).toLocaleDateString()}</span>
                              {!(releaseFlow?.leaseId === l.id && releaseFlow.phase === "confirm") && (
                                releaseFlow?.leaseId === l.id ? (
                                  releaseFlow.phase === "releasing" ? (
                                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                                  ) : (
                                    <span className="text-destructive shrink-0">{releaseFlow.error}</span>
                                  )
                                ) : (
                                  <button
                                    onClick={() => setReleaseFlow({ leaseId: l.id, phase: "confirm", error: "" })}
                                    className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-destructive/40 text-destructive/80 hover:border-destructive hover:text-destructive transition-colors shrink-0"
                                  >
                                    Stop renewing
                                  </button>
                                )
                              )}
                            </div>
                            {releaseFlow?.leaseId === l.id && releaseFlow.phase === "confirm" && (
                              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 space-y-1.5">
                                <p className="text-[11px] text-muted-foreground">
                                  Stops renewing — no refund for now. Keeps working until {new Date(l.paidUntil).toLocaleDateString()}, then blocks after a {leaseInfo?.gracePeriodDays}-day grace, deleted if still unpaid {leaseInfo?.autoDeleteAfterSuspendedDays} days after that.
                                </p>
                                <span className="flex items-center gap-3">
                                  <button onClick={() => handleReleaseLease(l.id)} className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-destructive text-destructive hover:bg-destructive/10 transition-colors">Confirm</button>
                                  <button onClick={() => setReleaseFlow(null)} className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:border-foreground/30 transition-colors">Keep it</button>
                                </span>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {payFlow && payFlow.context.kind === "renew" && !payFlow.context.cardAgentActor && renderInvoiceCard()}
                </div>
                );
              })()}
            </div>
            {!linked || (linked.ownedAgents.length === 0 && !linked.ownedBy) ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground text-sm space-y-1">
                <AlertCircle className="w-5 h-5 mx-auto mb-2 opacity-40" />
                <p>No agentcore-linked wallets found for <strong>{actor}</strong></p>
                <p className="text-xs">
                  Link an AI agent to your wallet via agentcore first — once one's linked, you can give it a
                  Sigil mailbox (your first is free; paid slots unlock more).
                </p>
              </div>
            ) : (() => {
              const withMailbox = linked.ownedAgentsDetailed.filter((a) => a.hasMailbox);
              const unclaimed = linked.ownedAgentsDetailed.filter((a) => !a.hasMailbox);
              // Allocate remaining free capacity across unclaimed rows in
              // order — only that many rows get "Claim (free)"; the rest
              // get "Buy a slot" attached to that exact row.
              let remainingCapacity = quota ? quota.agentMailboxes.limit - quota.agentMailboxes.used : 0;
              const atHardCap = quota ? quota.agentMailboxes.limit >= quota.agentMailboxes.max : false;

              return (
              <div className="space-y-2">
                {withMailbox.map(({ actor: agentActor }) => {
                  const offerKey = `offer-${agentActor}`;
                  const openKey = `openwebmail-${agentActor}`;
                  const liveGrant = issued.find(g => g.grantee_actor === agentActor && (g.status === "pending" || g.status === "accepted"));
                  const isSending = actionStatus[offerKey] === "Sending…";
                  const isOpening = actionStatus[openKey] === "Adding…";
                  const openError = actionStatus[openKey] && actionStatus[openKey] !== "Adding…" ? actionStatus[openKey] : null;
                  const confirmingRemove = removingAgent === `confirm-${agentActor}`;
                  const isRemoving = removingAgent === agentActor;
                  return (
                    <div key={agentActor} className="rounded-lg border border-border bg-card p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-words">{agentActor}@mailsigil.pro</p>
                          <p className="text-xs text-muted-foreground">Your agent</p>
                        </div>
                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            onClick={() => openAgentInWebmail(agentActor)}
                            disabled={isOpening}
                            className="text-xs bg-[#FACC15] hover:bg-[#EAB308] text-black"
                          >
                            {isOpening ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Adding…</>) : "Add agent account"}
                          </Button>
                          {liveGrant?.status === "accepted" ? (
                            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                              <Check className="w-3 h-3" /> Grant accepted
                            </span>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => handleOfferGrant(agentActor)} disabled={isSending || liveGrant?.status === "pending"} className="text-xs">
                              {isSending ? "Sending…" : liveGrant?.status === "pending" ? "Offer sent" : "Offer My Mailbox Access"}
                            </Button>
                          )}
                          {!confirmingRemove && (
                            <button
                              onClick={() => setRemovingAgent(`confirm-${agentActor}`)}
                              disabled={isRemoving}
                              className="text-[11px] text-destructive/70 hover:text-destructive underline underline-offset-2"
                            >
                              Remove from slot
                            </button>
                          )}
                        </div>
                      </div>
                      {liveGrant?.status === "pending" && (
                        <div className="rounded-md bg-primary/8 border border-primary/20 px-3 py-2 flex items-start gap-2">
                          <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                          <p className="text-xs text-muted-foreground">
                            Grant sent — tell <span className="font-medium text-foreground">{agentActor}</span>{" "}to accept it. This page will update automatically for 2 minutes, or hit Refresh if the status hasn&apos;t changed.
                          </p>
                        </div>
                      )}
                      {confirmingRemove && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 space-y-2">
                          <p className="text-xs text-muted-foreground">
                            Permanently delete <strong className="text-foreground break-all">{agentActor}@mailsigil.pro</strong>{" "}and all its email? This frees the slot but can&apos;t be undone.
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" variant="destructive" onClick={() => handleRemoveAgentMailbox(agentActor)} disabled={isRemoving} className="text-xs">
                              {isRemoving ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Removing…</>) : "Remove forever"}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setRemovingAgent(null)} disabled={isRemoving} className="text-xs">
                              Keep it
                            </Button>
                          </div>
                        </div>
                      )}
                      {removeError[agentActor] && (
                        <p className="text-xs text-destructive">{removeError[agentActor]}</p>
                      )}
                      {openError && (
                        <p className="text-xs text-destructive">{openError}</p>
                      )}
                      {(() => {
                        // Feature A: an attached lease or suspension shows
                        // right on the agent that paid for it, no UUID list
                        // to cross-reference — this IS the slot, live here.
                        const suspension = leaseInfo?.suspendedMailboxes.find((m) => m.agentActor === agentActor);
                        const lease = leaseInfo?.leases.find((l) => l.agentActor === agentActor);
                        const autoPay = leaseInfo?.agentAutoPay[agentActor];
                        const cardPayFlow = payFlow?.context.kind === "renew" && payFlow.context.cardAgentActor === agentActor ? payFlow : null;

                        if (suspension) {
                          return (
                            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 space-y-1.5">
                              <p className="text-xs text-destructive">
                                Blocked for non-payment — permanently deleted {new Date(suspension.autoDeleteAt).toLocaleDateString()} unless renewed.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleStartPurchase({ kind: "renew", leaseIds: lease ? [lease.id] : undefined, cardAgentActor: agentActor })}
                                disabled={!!payFlow || !lease}
                                className="text-xs h-6"
                              >
                                Renew to reactivate
                              </Button>
                              {cardPayFlow && renderInvoiceCard()}
                            </div>
                          );
                        }
                        if (lease) {
                          // Suspension is checked above and returns early, so
                          // reaching here with a past paidUntil unambiguously
                          // means "in the grace window, not yet blocked" —
                          // graceEndsAt hasn't passed either, or the
                          // suspend-lapsed-leases cron would already have
                          // moved it into suspendedMailboxes.
                          const isInGrace = new Date(lease.paidUntil).getTime() <= Date.now();
                          const daysUntilBlocked = isInGrace
                            ? Math.max(0, Math.ceil((new Date(lease.graceEndsAt).getTime() - Date.now()) / 86_400_000))
                            : 0;
                          return (
                            <div className={cn(
                              "flex items-center gap-2 flex-wrap text-xs",
                              isInGrace ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                            )}>
                              <span>
                                {isInGrace
                                  ? `Past due since ${new Date(lease.paidUntil).toLocaleDateString()} — grace period, blocks in ${daysUntilBlocked} day${daysUntilBlocked === 1 ? "" : "s"} if not renewed`
                                  : `Manual renewal — renews ${new Date(lease.paidUntil).toLocaleDateString()}`}
                              </span>
                              {isEligibleForRenewal(lease.paidUntil) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleStartPurchase({ kind: "renew", leaseIds: [lease.id], cardAgentActor: agentActor })}
                                  disabled={!!payFlow}
                                  className="text-xs h-6"
                                >
                                  Renew (${leaseInfo?.priceUsdPerSlot})
                                </Button>
                              )}
                              {releaseFlow?.leaseId === lease.id ? (
                                releaseFlow.phase === "confirm" ? (
                                  <div className="basis-full w-full rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 space-y-1.5">
                                    <p className="text-[11px] text-muted-foreground">
                                      Stops renewing — no refund for now. {agentActor} keeps working normally until {new Date(lease.paidUntil).toLocaleDateString()}, then blocks (no send/receive, mail kept) after a {leaseInfo?.gracePeriodDays}-day grace, and is permanently deleted if still unpaid {leaseInfo?.autoDeleteAfterSuspendedDays} days after that.
                                    </p>
                                    <span className="flex items-center gap-3">
                                      <button onClick={() => handleReleaseLease(lease.id)} className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-destructive text-destructive hover:bg-destructive/10 transition-colors">Confirm</button>
                                      <button onClick={() => setReleaseFlow(null)} className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:border-foreground/30 transition-colors">Keep it</button>
                                    </span>
                                  </div>
                                ) : releaseFlow.phase === "releasing" ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <span className="text-destructive">{releaseFlow.error}</span>
                                )
                              ) : (
                                <button
                                  onClick={() => setReleaseFlow({ leaseId: lease.id, phase: "confirm", error: "" })}
                                  className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-destructive/40 text-destructive/80 hover:border-destructive hover:text-destructive transition-colors"
                                >
                                  Stop renewing
                                </button>
                              )}
                              {cardPayFlow && renderInvoiceCard()}
                            </div>
                          );
                        }
                        // An agent that signed its own on-chain subscription pays for
                        // itself — genuinely attributable, so it gets its own label.
                        if (autoPay) {
                          return (
                            <p className="text-xs text-muted-foreground">
                              Agent auto-pay{autoPay.status === "past_due" ? " — past due" : ""}
                            </p>
                          );
                        }
                        // Free base-quota slot or a lifetime-purchased slot — neither is
                        // attributable to a SPECIFIC agent in the data (quota/purchased-
                        // count are owner-level totals, not per-agent flags), so rather
                        // than guess which of the two it is, show the one thing that's
                        // true of both: no action needed.
                        return (
                          <p className="text-xs text-muted-foreground">No renewal needed</p>
                        );
                      })()}
                      {(() => {
                        // Storage tier is orthogonal to the agent-mailbox
                        // slot lease above — a mailbox can be on Pro storage
                        // regardless of how its slot itself is paid for
                        // (free base slot, manual lease, or agent auto-pay).
                        const plan = storageStatus?.plans?.find((p) => p.mailboxActor === agentActor);
                        if (!plan) return null;
                        const isPro = plan.tier === "pro";
                        const now = Date.now();
                        const isInGrace = isPro && plan.paidUntil !== null && new Date(plan.paidUntil).getTime() <= now;
                        const daysUntilBlocked = isInGrace
                          ? Math.max(0, Math.ceil((new Date(plan.graceEndsAt!).getTime() - now) / 86_400_000))
                          : 0;
                        const agentStoragePayFlow = payFlow?.context.kind === "storage-upgrade" && payFlow.context.mailboxActor === agentActor ? payFlow : null;
                        return (
                          <div className="flex items-center gap-2 flex-wrap text-xs">
                            <span className={isInGrace ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>
                              {isInGrace
                                ? `Storage past due since ${new Date(plan.paidUntil!).toLocaleDateString()} — drops to ${storageStatus!.baseQuotaBytes / 1024 ** 3}GB in ${daysUntilBlocked} day${daysUntilBlocked === 1 ? "" : "s"}`
                                : isPro
                                ? `Pro storage ${storageStatus!.proQuotaBytes / 1024 ** 3}GB — renews ${new Date(plan.paidUntil!).toLocaleDateString()}`
                                : `${storageStatus!.baseQuotaBytes / 1024 ** 3}GB base storage`}
                            </span>
                            {/* Overspend guard (task #148): hide once Pro and
                                comfortably active — nothing due, backend
                                would 400 this. */}
                            {(!isPro || isInGrace || (plan.paidUntil && isEligibleForRenewal(plan.paidUntil))) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleStartPurchase({ kind: "storage-upgrade", mailboxActor: agentActor })}
                                disabled={!!payFlow}
                                className="text-xs h-6"
                              >
                                {isPro ? `Renew — $${storageStatus!.priceUsd}` : `Upgrade — $${storageStatus!.priceUsd}/mo`}
                              </Button>
                            )}
                            {!isPro && <span className="text-[10px] text-muted-foreground">({storageStatus!.proQuotaBytes / 1024 ** 3}GB)</span>}
                            {agentStoragePayFlow && renderInvoiceCard()}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}

                {unclaimed.map(({ actor: agentActor }) => {
                  const claimKey = `claim-${agentActor}`;
                  const isClaiming = actionStatus[claimKey] === "Provisioning…";
                  const claimStatus = actionStatus[claimKey];
                  const cred = claimedCreds[agentActor];
                  const canClaimFree = remainingCapacity > 0;
                  if (canClaimFree) remainingCapacity -= 1; // this row consumes one slot of capacity

                  const rowPayFlow = payFlow?.context.kind === "new" && payFlow.context.agentActor === agentActor ? payFlow : null;

                  return (
                    <div key={agentActor} className="rounded-lg border border-border bg-card p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-words">{agentActor}</p>
                          <p className="text-xs text-muted-foreground">Linked agent — no Sigil mailbox yet</p>
                        </div>
                        {cred ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                            <Check className="w-3 h-3" /> Mailbox created
                          </span>
                        ) : canClaimFree ? (
                          <Button
                            size="sm"
                            onClick={() => handleClaimAgentMailbox(agentActor)}
                            disabled={isClaiming}
                            className="text-xs bg-[#FACC15] hover:bg-[#EAB308] text-black shrink-0"
                          >
                            {isClaiming ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Provisioning…</>) : "Claim"}
                          </Button>
                        ) : atHardCap ? (
                          <span className="text-xs text-muted-foreground shrink-0" title={`Sigil Mail supports a maximum of ${quota?.agentMailboxes.max} agent mailboxes per account`}>
                            {quota?.agentMailboxes.max} slot max reached
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleStartPurchase({ kind: "new", agentActor })}
                            disabled={!!payFlow}
                            className="text-xs bg-[#FACC15] hover:bg-[#EAB308] text-black shrink-0"
                          >
                            {rowPayFlow?.phase === "creating" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Creating invoice…</>)
                              : rowPayFlow?.phase === "waiting" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Awaiting payment…</>)
                              : rowPayFlow?.phase === "claiming" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Provisioning…</>)
                              : `Add a slot — $${quota?.nextSlot.priceUsd ?? 1}/${quota?.nextSlot.periodDays ?? 30}d · Pay with XPR Network`}
                          </Button>
                        )}
                      </div>

                      {cred && (
                        <div className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 space-y-1">
                          <p className="text-xs text-muted-foreground">{agentActor}@mailsigil.pro is ready. Share this credential with the agent:</p>
                          <p className="font-mono text-xs bg-muted px-2 py-1 rounded break-all">{cred.username} / {cred.password}</p>
                        </div>
                      )}
                      {claimStatus && claimStatus !== "Provisioning…" && claimStatus !== "Done" && (
                        <p className="text-xs text-destructive">{claimStatus}</p>
                      )}

                      {rowPayFlow && renderInvoiceCard()}
                    </div>
                  );
                })}

                {linked.ownedBy && (
                  <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium break-words">{linked.ownedBy}@mailsigil.pro</p>
                        <p className="text-xs text-muted-foreground">Your owner</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => handleOfferGrant(linked.ownedBy!)} disabled={!!actionStatus[`offer-${linked.ownedBy}`]} className="text-xs">
                        {actionStatus[`offer-${linked.ownedBy}`] ?? "Send Access Offer"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              );
            })()}
          </div>
        )}

        {/* ── Incoming Offers ── */}
        {activeSection === "incoming" && (
          <div className="max-w-xl space-y-4">
            <div>
              <h1 className="text-lg font-semibold">Incoming Offers</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                For agents that set up their own mailbox independently and are offering YOU access to it.
                Different from Agent Wallets — that's for mailboxes you claimed and are paying for; those need no offer.
              </p>
            </div>

            {incoming.length === 0 && incomingPm.length === 0 && !loading && (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground text-sm">
                No pending access offers
              </div>
            )}

            {incoming.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-muted-foreground mb-2">Mailbox Access Offers</h2>
                <div className="space-y-2">
                  {incoming.map((g) => (
                    <div key={g.grantId} className="rounded-lg border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-words">{g.from}</p>
                          <p className="text-xs text-muted-foreground">
                            Offering {g.scope} access · {timeAgo(g.createdAt)}
                          </p>
                          {actionStatus[g.grantId] && (
                            <p className="text-xs text-emerald-500 mt-1">{actionStatus[g.grantId]}</p>
                          )}
                        </div>
                        {!actionStatus[g.grantId] && (
                          <div className="flex gap-1.5 shrink-0">
                            <Button size="sm" onClick={() => handleAccept(g.grantId)} className="gap-1 text-xs">
                              <Check className="w-3 h-3" /> Accept
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => handleDecline(g.grantId)} className="gap-1 text-xs">
                              <X className="w-3 h-3" /> Decline
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {incomingPm.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-muted-foreground mb-2">Mailbox Creation Requests</h2>
                <div className="space-y-2">
                  {incomingPm.map((pm) => (
                    <div key={pm.id} className="rounded-lg border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-words">{pm.initiated_by}</p>
                          <p className="text-xs text-muted-foreground">Wants to create your mailbox · {timeAgo(pm.created_at)}</p>
                          {actionStatus[`pm-${pm.id}`] && (
                            <p className="text-xs text-emerald-500 mt-1">{actionStatus[`pm-${pm.id}`]}</p>
                          )}
                        </div>
                        {!actionStatus[`pm-${pm.id}`] && (
                          <Button size="sm" onClick={() => confirmPendingMailbox(pm.id)} className="gap-1 text-xs shrink-0">
                            <Check className="w-3 h-3" /> Confirm
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Issued Grants ── */}
        {activeSection === "issued" && (
          <div className="max-w-xl space-y-4">
            <h1 className="text-lg font-semibold">Issued Grants</h1>

            {issued.length === 0 && sentPm.length === 0 && !loading && (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground text-sm">
                No grants issued yet
              </div>
            )}

            {issued.length > 0 && (
              <div className="space-y-2">
                {issued.map((g) => (
                  <div key={g.id} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium break-words">{g.grantee_actor}</p>
                        <p className="text-xs text-muted-foreground">{g.scope} access · {timeAgo(g.created_at)}</p>
                        <div className="mt-1"><StatusBadge status={g.status} /></div>
                        {actionStatus[g.id] && (
                          <p className="text-xs text-muted-foreground mt-1">{actionStatus[g.id]}</p>
                        )}
                      </div>
                      {g.status === "accepted" && !actionStatus[g.id] && (
                        <Button size="sm" variant="outline" onClick={() => handleRevoke(g.id)} className="text-xs text-destructive hover:text-destructive shrink-0">
                          Revoke
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {sentPm.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-muted-foreground mb-2">Pending Mailbox Requests</h2>
                <div className="space-y-2">
                  {sentPm.map((pm) => (
                    <div key={pm.id} className="rounded-lg border border-border bg-card p-4">
                      <p className="text-sm font-medium">{pm.for_actor}</p>
                      <p className="text-xs text-muted-foreground">Mailbox creation requested · {timeAgo(pm.created_at)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
