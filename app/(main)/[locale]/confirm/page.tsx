"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, CheckCircle, AlertCircle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const AUTH_URL = process.env.NEXT_PUBLIC_XPR_AUTH_SERVICE_URL || "https://auth.mailsigil.pro";
const XPR_CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
const XPR_ENDPOINTS = ["https://proton.eosusa.io", "https://proton.protonuk.io"];

type PendingInfo = {
  pendingId: string;
  initiatedBy: string;
  forActor: string;
  confirmerActor: string;
  mailbox: string;
  expiresAt: string;
};

type Stage =
  | { type: "loading" }
  | { type: "not-found" }
  | { type: "expired" }
  | { type: "gone"; status: string }
  | { type: "ready"; info: PendingInfo }
  | { type: "connecting" }
  | { type: "signing"; actor: string }
  | { type: "confirming" }
  | { type: "logging-in" }
  | { type: "success"; mailbox: string; loggedIn: boolean }
  | { type: "error"; message: string };

function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export default function ConfirmPage() {
  const searchParams = useSearchParams();
  const pendingId = searchParams.get("pending") ?? "";
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const serverUrl = useAuthStore((s) => s.serverUrl);

  const [stage, setStage] = useState<Stage>({ type: "loading" });
  const handleApproveRef = useRef<(() => void) | null>(null);

  // Auto-start on mobile when the request details are loaded — saves the extra tap.
  useEffect(() => {
    if (stage.type === "ready" && isMobileDevice()) {
      handleApproveRef.current?.();
    }
  }, [stage.type]);

  // Load the public request info
  useEffect(() => {
    if (!pendingId) { setStage({ type: "not-found" }); return; }
    fetch(`${AUTH_URL}/api/mailboxes/pending/${encodeURIComponent(pendingId)}/info`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          if (data.status === "confirmed") setStage({ type: "gone", status: "confirmed" });
          else if (data.status === "cancelled") setStage({ type: "gone", status: "cancelled" });
          else setStage({ type: "expired" });
        } else {
          setStage({ type: "ready", info: data });
        }
      })
      .catch(() => setStage({ type: "error", message: "Could not load request details. Check your connection." }));
  }, [pendingId]);

  const handleApprove = useCallback(async () => {
    handleApproveRef.current = null; // clear so auto-start only fires once
    if (stage.type !== "ready") return;

    setStage({ type: "connecting" });
    try {
      const ProtonWebSDK = (await import("@proton/web-sdk")).default;
      await import("@proton/link");

      const { session, loginResult } = await ProtonWebSDK({
        linkOptions: { chainId: XPR_CHAIN_ID, endpoints: XPR_ENDPOINTS },
        transportOptions: { requestAccount: "mailsigil" },
        selectorOptions: { appName: "Sigil Mail", enabledWalletTypes: ["webauth", "anchor", "proton"] },
      });
      if (!session) throw new Error("Wallet connection was cancelled");

      const actor = session.auth.actor.toString();
      const permission = session.auth.permission.toString();

      // Verify login proof → get access token (no mailbox provisioned yet)
      let accessToken: string;
      if (loginResult?.proof) {
        setStage({ type: "signing", actor });
        const res = await fetch(`${AUTH_URL}/api/auth/verify-proof`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proof: loginResult.proof.toString() }),
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.error || "Identity verification failed");
        accessToken = res.accessToken;
      } else {
        setStage({ type: "signing", actor });
        const { challengeId, message } = await fetch(`${AUTH_URL}/api/auth/nonce`, {
          method: "POST",
        }).then((r) => r.json());
        const { Serializer } = await import("@greymass/eosio");
        const nonce = message.match(/Nonce: (\S+)/)?.[1];
        const result = await session.transact(
          {
            actions: [{
              account: "eosio.token",
              name: "transfer",
              authorization: [{ actor, permission }],
              data: { from: actor, to: "eosio", quantity: "0.0001 XPR", memo: nonce },
            }],
          },
          { broadcast: false },
        );
        const serializedTransaction = Serializer.encode({ object: result.transaction }).hexString;
        const res = await fetch(`${AUTH_URL}/api/auth/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, actor, permission, signatures: result.signatures, serializedTransaction }),
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.error || "Signature verification failed");
        accessToken = res.accessToken;
      }

      // Upload the wallet's serialized channel session (fire-and-forget) so
      // future approvals can arrive as native WebAuth prompts — see login page.
      try {
        const serialized = (session as any).serialize?.();
        if (serialized?.type === "channel") {
          fetch(`${AUTH_URL}/api/session-channel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ session: serialized }),
          }).catch(() => { /* non-fatal */ });
        }
      } catch { /* non-fatal */ }

      // Confirm the pending request — provisions mailbox + issues initiator credential
      setStage({ type: "confirming" });
      const confirmRes = await fetch(`${AUTH_URL}/api/mailboxes/pending/${encodeURIComponent(pendingId)}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then((r) => r.json());

      if (!confirmRes.ok) throw new Error(confirmRes.error || "Confirmation failed");

      // Sibling-agent flow: the confirmer isn't the mailbox's owner (they
      // approved a mailbox for a linked agent, not themselves), so there's
      // no access token to log in with — the confirm endpoint intentionally
      // omits it. Just show the approval as done; the initiator retrieves
      // the new mailbox's credential from their own "sent requests" list.
      if (!confirmRes.accessToken) {
        setStage({ type: "success", mailbox: confirmRes.mailbox, loggedIn: false });
        return;
      }

      // Mint app-password using the access token from confirm (already provisioned)
      setStage({ type: "logging-in" });
      const appPwRes = await fetch(`${AUTH_URL}/api/auth/app-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${confirmRes.accessToken}` },
        body: JSON.stringify({ description: "Bulwark webmail session" }),
      }).then((r) => r.json());

      if (!appPwRes.username || !appPwRes.password) {
        // Success even if auto-login fails — user can login manually
        setStage({ type: "success", mailbox: confirmRes.mailbox, loggedIn: false });
        return;
      }

      const effectiveServer = serverUrl || "https://mail.mailsigil.pro/jmap";
      const loggedIn = await login(effectiveServer, appPwRes.username, appPwRes.password, undefined, true);
      if (loggedIn) {
        localStorage.setItem("sigil_auth_token", confirmRes.accessToken);
        localStorage.setItem("sigil_actor", actor);
        router.push("/");
      } else {
        setStage({ type: "success", mailbox: confirmRes.mailbox, loggedIn: false });
      }
    } catch (err) {
      const prev = stage;
      setStage({ type: "error", message: err instanceof Error ? err.message : String(err) });
      // Allow retry
      setTimeout(() => setStage(prev), 5000);
    }
  }, [stage, pendingId, login, serverUrl, router]);

  // Keep ref in sync so the auto-start effect can call the latest version
  handleApproveRef.current = stage.type === "ready" ? handleApprove : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border bg-card shadow-sm p-8 flex flex-col items-center gap-6 text-center">
          <ConfirmContent stage={stage} onApprove={handleApprove} router={router} />
        </div>
      </div>
    </div>
  );
}

function ConfirmContent({
  stage,
  onApprove,
  router,
}: {
  stage: Stage;
  onApprove: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  if (stage.type === "loading") {
    return (
      <>
        <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
        <p className="text-muted-foreground text-sm">Loading request…</p>
      </>
    );
  }

  if (stage.type === "not-found") {
    return (
      <>
        <AlertCircle className="h-10 w-10 text-destructive" />
        <h2 className="text-lg font-semibold">Request not found</h2>
        <p className="text-sm text-muted-foreground">This link is invalid or has already been used.</p>
        <Button variant="outline" onClick={() => router.push("/login")}>Back to login</Button>
      </>
    );
  }

  if (stage.type === "expired") {
    return (
      <>
        <AlertCircle className="h-10 w-10 text-amber-500" />
        <h2 className="text-lg font-semibold">Request expired</h2>
        <p className="text-sm text-muted-foreground">This account creation request has expired. Ask the sender to create a new one.</p>
        <Button variant="outline" onClick={() => router.push("/login")}>Back to login</Button>
      </>
    );
  }

  if (stage.type === "gone") {
    return (
      <>
        <CheckCircle className="h-10 w-10 text-emerald-500" />
        <h2 className="text-lg font-semibold">
          {stage.status === "confirmed" ? "Already confirmed" : "Request cancelled"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {stage.status === "confirmed"
            ? "Your account was already created. Sign in to access it."
            : "This request was cancelled."}
        </p>
        <Button onClick={() => router.push("/login")}>
          {stage.status === "confirmed" ? "Sign in" : "Back to login"}
        </Button>
      </>
    );
  }

  if (stage.type === "success") {
    return (
      <>
        <CheckCircle className="h-10 w-10 text-emerald-500" />
        <h2 className="text-xl font-semibold">{stage.loggedIn === false ? "Approved" : "Your account is ready"}</h2>
        <p className="font-mono text-sm bg-muted px-3 py-1.5 rounded-md">{stage.mailbox}</p>
        {stage.loggedIn === false ? (
          <p className="text-sm text-muted-foreground">This mailbox is ready — the agent that requested it will pick up its credential automatically.</p>
        ) : null}
        <Button onClick={() => router.push("/login")} className="w-full">
          {stage.loggedIn === false ? "Back to Sigil Mail" : "Open Sigil Mail"}
        </Button>
      </>
    );
  }

  if (stage.type === "error") {
    return (
      <>
        <AlertCircle className="h-10 w-10 text-destructive" />
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">{stage.message}</p>
        <p className="text-xs text-muted-foreground">Retrying in a moment…</p>
      </>
    );
  }

  if (stage.type === "connecting" || stage.type === "signing" || stage.type === "confirming" || stage.type === "logging-in") {
    const label =
      stage.type === "connecting" ? "Connecting wallet…" :
      stage.type === "signing" ? `Sign in your wallet${stage.actor ? ` as ${stage.actor}` : ""}…` :
      stage.type === "confirming" ? "Confirming on Sigil…" :
      "Signing you in…";

    return (
      <>
        <Loader2 className="h-10 w-10 text-primary animate-spin" />
        <p className="text-sm font-medium">{label}</p>
      </>
    );
  }

  // stage.type === "ready"
  const { info } = stage;
  const mobile = isMobileDevice();
  // Sibling-agent flow: the confirmer approves a mailbox for a DIFFERENT
  // agent, not themselves — the copy and the wallet being connected differ.
  const approvingForSomeoneElse = info.confirmerActor !== info.forActor;
  return (
    <>
      <div className="rounded-full bg-primary/10 p-3">
        <Mail className="h-8 w-8 text-primary" />
      </div>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">
          {approvingForSomeoneElse ? "Approval needed" : "Account creation request"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {approvingForSomeoneElse ? (
            <>
              <span className="font-medium text-foreground">{info.initiatedBy}</span> wants to create a Sigil Mail account
              for your linked agent <span className="font-medium text-foreground">{info.forActor}</span> — approve as its owner
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{info.initiatedBy}</span> wants to create a Sigil Mail account for you
            </>
          )}
        </p>
      </div>
      <div className="w-full rounded-lg border bg-muted/40 px-4 py-3 text-left space-y-2">
        <Row label={approvingForSomeoneElse ? "Mailbox for" : "Your address"} value={info.mailbox} mono />
        <Row label="Requested by" value={info.initiatedBy} />
        <Row label="Expires" value={new Date(info.expiresAt).toLocaleDateString()} />
      </div>
      <div className="w-full space-y-3">
        {mobile ? (
          <>
            <Loader2 className="h-5 w-5 text-primary animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Opening WebAuth…</p>
            <Button variant="outline" onClick={onApprove} className="w-full gap-2 text-xs">
              <ShieldCheck className="h-3 w-3" />
              Tap if WebAuth didn&apos;t open
            </Button>
          </>
        ) : (
          <Button onClick={onApprove} className="w-full gap-2">
            <ShieldCheck className="h-4 w-4" />
            Approve in WebAuth
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          You'll be asked to connect your <span className="font-medium">{info.confirmerActor}</span> wallet to approve this request.
          No XPR will be spent.
        </p>
      </div>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-right truncate", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}
