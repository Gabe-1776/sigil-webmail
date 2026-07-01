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
      const [linkedRes, incomingRes, issuedRes, acceptedRes, incomingPmRes, sentPmRes] = await Promise.all([
        authFetch("/api/agentcore/linked"),
        authFetch("/api/grants/incoming"),
        authFetch("/api/grants/issued"),
        authFetch("/api/grants/accepted"),
        authFetch("/api/mailboxes/pending/incoming"),
        authFetch("/api/mailboxes/pending/sent"),
      ]);
      if (linkedRes.ownedAgents) setLinked(linkedRes);
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
    <div className="flex h-full overflow-hidden bg-background">
      <aside className="w-52 shrink-0 border-r border-border flex flex-col py-4 gap-1">
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

        {/* ── Agent Wallets ── */}
        {activeSection === "grants" && (
          <div className="max-w-xl space-y-4">
            <h1 className="text-lg font-semibold">Agent Wallets</h1>
            {!linked || (linked.ownedAgents.length === 0 && !linked.ownedBy) ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground text-sm">
                <AlertCircle className="w-5 h-5 mx-auto mb-2 opacity-40" />
                No agentcore-linked wallets found for <strong>{actor}</strong>
              </div>
            ) : (
              <div className="space-y-2">
                {linked.ownedAgents.map((agentActor) => {
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
            )}
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
