"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useConfig } from "@/hooks/use-config";
import { ShieldCheck, Mail, Loader2, RefreshCw, Check, X, AlertCircle } from "lucide-react";
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

type Quota = {
  owner: string;
  agentMailboxes: { used: number; limit: number; purchasedSlots: number };
  nextSlot: { priceUsd: number; purchaseEndpoint: string };
};

type QuotaInvoice = {
  invoiceId: string;
  payTo: string;
  memo: string;
  payOptions: { symbol: string; contract: string; quantity: string }[];
  expiresAt: string;
};

type Section = "inbox" | "grants" | "incoming" | "issued";

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

export default function GrantsPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
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
  // Per-agent buy-a-slot state — each unclaimed agent row runs its own
  // independent invoice/payment lifecycle, keyed by agent actor. Replaces
  // the old single global invoice/payState (which powered one standalone
  // "Agent slots" card disconnected from any specific agent — the exact
  // disconnect that let a $1 signing request fire with no real demand
  // behind it, found live 2026-07-02).
  type SlotPay = {
    invoice: QuotaInvoice | null;
    payToken: string;
    payState: "idle" | "invoicing" | "paying" | "confirming" | "claiming" | "done" | "error";
    payError: string;
  };
  const [slotPay, setSlotPay] = useState<Record<string, SlotPay>>({});
  const getSlotPay = (agentActor: string): SlotPay =>
    slotPay[agentActor] ?? { invoice: null, payToken: "XMD", payState: "idle", payError: "" };
  const patchSlotPay = (agentActor: string, patch: Partial<SlotPay>) =>
    setSlotPay((s) => ({ ...s, [agentActor]: { ...getSlotPay(agentActor), ...patch } }));
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
      localStorage.removeItem("sigil_auth_token");
      localStorage.removeItem("sigil_actor");
      router.push("/login");
      throw new Error("Session expired");
    }
    return res.json();
  }, [token, router]);

  const loadAll = useCallback(async (background = false) => {
    if (!token) return;
    if (!background) setLoading(true);
    try {
      const [linkedRes, incomingRes, issuedRes, acceptedRes, incomingPmRes, sentPmRes, quotaRes] = await Promise.all([
        authFetch("/api/agentcore/linked"),
        authFetch("/api/grants/incoming"),
        authFetch("/api/grants/issued"),
        authFetch("/api/grants/accepted"),
        authFetch("/api/mailboxes/pending/incoming"),
        authFetch("/api/mailboxes/pending/sent"),
        authFetch("/api/quota").catch(() => null),
      ]);
      if (linkedRes.ownedAgents) setLinked(linkedRes);
      if (quotaRes?.ok) setQuota(quotaRes);
      setIncoming(incomingRes.grants ?? []);
      setIssued(issuedRes.grants ?? []);
      setAccepted(acceptedRes.grants ?? []);
      setIncomingPm(incomingPmRes.pendingMailboxes ?? incomingPmRes.pending ?? []);
      setSentPm(sentPmRes.pendingMailboxes ?? sentPmRes.sent ?? []);
    } catch { /* non-fatal */ }
    setLoading(false);
  }, [token, authFetch]);

  useEffect(() => {
    const t = localStorage.getItem("sigil_auth_token");
    const a = localStorage.getItem("sigil_actor");
    if (!t || !a) { setLoading(false); return; }
    setToken(t);
    setActor(a);
    try {
      const payload = JSON.parse(atob(t.split(".")[1]));
      if (payload.exp) setTokenExpiresAt(new Date(payload.exp * 1000));
    } catch { /* non-fatal */ }
  }, []);

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
  //    ($1, on-chain) when it isn't. Both paths end at the same place:
  //    claim-agent-mailbox, which does the real quota check server-side —
  //    this is UI convenience, not the enforcement boundary.
  const XPR_CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
  const XPR_ENDPOINTS = ["https://proton.eosusa.io", "https://proton.protonuk.io"];
  const [claimedCreds, setClaimedCreds] = useState<Record<string, { username: string; password: string }>>({});

  const claimAgentMailbox = async (agentActor: string): Promise<boolean> => {
    const res = await authFetch("/api/grants/claim-agent-mailbox", {
      method: "POST",
      body: JSON.stringify({ agentActor }),
    });
    if (!res.ok) throw new Error(res.error || "failed to claim mailbox");
    setClaimedCreds((c) => ({ ...c, [agentActor]: res.credential }));
    return true;
  };

  // Free path — room already exists in quota.
  const handleClaimAgentMailbox = async (agentActor: string) => {
    const key = `claim-${agentActor}`;
    setActionStatus((s) => ({ ...s, [key]: "Provisioning…" }));
    try {
      await claimAgentMailbox(agentActor);
      setActionStatus((s) => ({ ...s, [key]: "Done" }));
      loadAll(true); // refresh quota + linked list so the row moves to "has mailbox"
    } catch (err: any) {
      setActionStatus((s) => ({ ...s, [key]: err?.message ?? "failed" }));
    }
  };

  // Paid path — buy the specific slot THIS agent needs, then auto-claim its
  // mailbox the instant payment confirms (no separate second click — we
  // already know exactly which agent the $1 was for). Row moves up to the
  // "has mailbox" group once loadAll() re-partitions the list.
  const handleBuySlotForAgent = async (agentActor: string) => {
    patchSlotPay(agentActor, { payError: "" });
    try {
      let { invoice: inv, payToken } = getSlotPay(agentActor);
      patchSlotPay(agentActor, { payState: "invoicing" });
      if (!inv || new Date(inv.expiresAt) < new Date()) {
        const res = await authFetch("/api/quota/invoice", { method: "POST" });
        if (!res.ok) throw new Error(res.error || "invoice creation failed");
        inv = res as QuotaInvoice;
        patchSlotPay(agentActor, { invoice: inv });
      }
      const option = inv.payOptions.find((o) => o.symbol === payToken) ?? inv.payOptions[0];
      if (!option) throw new Error("no payable token options available right now");

      patchSlotPay(agentActor, { payState: "paying" });
      const ProtonWebSDK = (await import("@proton/web-sdk")).default;
      await import("@proton/link");
      const sdkOpts = {
        linkOptions: { chainId: XPR_CHAIN_ID, endpoints: XPR_ENDPOINTS },
        transportOptions: { requestAccount: "mailsigil" },
        selectorOptions: { appName: "Sigil Mail", enabledWalletTypes: ["webauth", "anchor", "proton"] as any },
      };
      let session = (await ProtonWebSDK({ ...sdkOpts, linkOptions: { ...sdkOpts.linkOptions, restoreSession: true } })).session;
      if (!session) session = (await ProtonWebSDK(sdkOpts)).session;
      if (!session) throw new Error("Wallet connection was cancelled");

      await session.transact(
        {
          actions: [
            {
              account: option.contract,
              name: "transfer",
              authorization: [{ actor: session.auth.actor, permission: session.auth.permission }],
              data: { from: session.auth.actor, to: inv.payTo, quantity: option.quantity, memo: inv.memo },
            },
          ],
        },
        { broadcast: true },
      );

      patchSlotPay(agentActor, { payState: "confirming" });
      let paid = false;
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = await authFetch(`/api/quota/invoice/${inv.invoiceId}`);
        if (st.status === "paid") { paid = true; break; }
      }
      if (!paid) throw new Error("payment broadcast, but confirmation is taking longer than usual — refresh in a minute");

      patchSlotPay(agentActor, { payState: "claiming", invoice: null });
      await claimAgentMailbox(agentActor);
      patchSlotPay(agentActor, { payState: "done" });
      loadAll(true);
    } catch (err: any) {
      patchSlotPay(agentActor, { payError: err?.message ?? String(err), payState: "error" });
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
          <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "#34D6C2" }} />
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
          <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "#34D6C2" }} />
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
                <div>
                  <p className="font-medium">{actor}@mailsigil.pro</p>
                  {tokenExpiresAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Auth session valid until {tokenExpiresAt.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      {" · "}sign out from the main menu to refresh
                    </p>
                  )}
                </div>
              </div>
            </div>

            {accepted.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-muted-foreground mb-2">Shared Mailboxes</h2>
                <div className="space-y-2">
                  {accepted.map((g) => {
                    const key = `open-${g.grantId}`;
                    return (
                      <div key={g.grantId} className="rounded-lg border border-border bg-card p-4 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{g.ownerActor}@mailsigil.pro</p>
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
                    Permanently delete <strong>{actor}@mailsigil.pro</strong> and all its email?
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Type <strong>DELETE</strong> to confirm — this cannot be undone.
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
                  style={{ color: "#34D6C2" }}
                >
                  How agent wallets works
                </a>
              </div>
              {quota && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {quota.agentMailboxes.used} of {quota.agentMailboxes.limit} agent slots used
                  {quota.agentMailboxes.purchasedSlots > 0 && ` (${quota.agentMailboxes.purchasedSlots} purchased)`}.
                </p>
              )}
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

              return (
              <div className="space-y-2">
                {withMailbox.map(({ actor: agentActor }) => {
                  const offerKey = `offer-${agentActor}`;
                  const liveGrant = issued.find(g => g.grantee_actor === agentActor && (g.status === "pending" || g.status === "accepted"));
                  const isSending = actionStatus[offerKey] === "Sending…";
                  return (
                    <div key={agentActor} className="rounded-lg border border-border bg-card p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{agentActor}@mailsigil.pro</p>
                          <p className="text-xs text-muted-foreground">Your agent</p>
                        </div>
                        {liveGrant?.status === "accepted" ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                            <Check className="w-3 h-3" /> Grant accepted
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => handleOfferGrant(agentActor)} disabled={isSending || liveGrant?.status === "pending"} className="text-xs">
                            {isSending ? "Sending…" : liveGrant?.status === "pending" ? "Offer sent" : "Offer My Mailbox Access"}
                          </Button>
                        )}
                      </div>
                      {liveGrant?.status === "pending" && (
                        <div className="rounded-md bg-primary/8 border border-primary/20 px-3 py-2 flex items-start gap-2">
                          <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                          <p className="text-xs text-muted-foreground">
                            Grant sent — tell <span className="font-medium text-foreground">{agentActor}</span> to accept it. This page will update automatically for 2 minutes, or hit Refresh if the status hasn&apos;t changed.
                          </p>
                        </div>
                      )}
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

                  const sp = getSlotPay(agentActor);
                  const paying = sp.payState === "invoicing" || sp.payState === "paying" || sp.payState === "confirming" || sp.payState === "claiming";

                  return (
                    <div key={agentActor} className="rounded-lg border border-border bg-card p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{agentActor}</p>
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
                            className="text-xs bg-[#34D6C2] hover:bg-[#2bc0ae] text-black shrink-0"
                          >
                            {isClaiming ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Provisioning…</>) : "Claim"}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleBuySlotForAgent(agentActor)}
                            disabled={paying}
                            className="text-xs bg-[#34D6C2] hover:bg-[#2bc0ae] text-black shrink-0"
                          >
                            {sp.payState === "invoicing" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Quoting…</>)
                              : sp.payState === "paying" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Sign in wallet…</>)
                              : sp.payState === "confirming" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Confirming on-chain…</>)
                              : sp.payState === "claiming" ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Provisioning…</>)
                              : `Add a slot — $1 · Pay with XPR Network`}
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

                      {!cred && !canClaimFree && (
                        <>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Pay in</span>
                            {["XMD", "XUSDC", "XPR", "LOAN"].map((sym) => (
                              <button
                                key={sym}
                                onClick={() => patchSlotPay(agentActor, { payToken: sym })}
                                className={cn(
                                  "text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors",
                                  sp.payToken === sym
                                    ? "border-[#34D6C2] bg-[#34D6C2]/15 text-[#0e8f80] dark:text-[#34D6C2]"
                                    : "border-border text-muted-foreground hover:border-[#34D6C2]/50",
                                )}
                              >
                                {sym}
                              </button>
                            ))}
                          </div>
                          {sp.invoice && (
                            <p className="text-[11px] text-muted-foreground">
                              Or pay manually from any wallet: send{" "}
                              <span className="font-mono text-foreground">
                                {(sp.invoice.payOptions.find((o) => o.symbol === sp.payToken) ?? sp.invoice.payOptions[0])?.quantity}
                              </span>{" "}
                              to <span className="font-mono text-foreground">{sp.invoice.payTo}</span> with memo{" "}
                              <span className="font-mono text-foreground">{sp.invoice.memo}</span>
                            </p>
                          )}
                          {sp.payState === "error" && sp.payError && (
                            <p className="text-xs text-destructive">{sp.payError}</p>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {linked.ownedBy && (
                  <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{linked.ownedBy}@mailsigil.pro</p>
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
            <h1 className="text-lg font-semibold">Incoming Offers</h1>

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
                        <div>
                          <p className="text-sm font-medium">{g.from}</p>
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
                        <div>
                          <p className="text-sm font-medium">{pm.initiated_by}</p>
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
                      <div>
                        <p className="text-sm font-medium">{g.grantee_actor}</p>
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
