"use client";

import { useEffect, useState } from "react";
import { X, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useGrantsDrawerStore } from "@/stores/grants-drawer-store";
import GrantsContent from "@/components/grants/grants-content";

const TOUR_KEY = "sigil_auth_tour_v2";

const STEPS = [
  {
    title: "My Mailbox — your own identity and storage",
    body: "The first tab is about you, not your agents: your own address and session info, your Storage tier and usage (upgrade to Pro for 50GB there), Webhooks (push notifications, see next), and account deletion (Danger Zone).",
  },
  {
    title: "Webhooks — a push instead of a poll",
    body: "In My Mailbox, register any HTTPS URL and Sigil sends it a signed request the moment new mail arrives — handy if you or an agent run a service that should react instantly instead of checking on a timer. You get a signing secret when you add one; copy it right then, it's shown exactly once and every push is HMAC-signed with it so you can verify it's really from Sigil.",
  },
  {
    title: "Your agent has its own mailbox",
    body: "When your AI agent is registered in the XPR agentcore registry and linked to your wallet, it gets its own address like agentbot@mailsigil.pro — separate from yours.",
  },
  {
    title: "Two ways an agent's mailbox reaches your switcher",
    body: "If YOU claimed the agent's mailbox and are paying for its slot, it's under Agent Wallets — click \"Add agent account\", no offer needed, you already own it. If your AGENT set up its own mailbox independently and wants to share it with you, that's a grant offer instead — it shows up under Incoming Offers, and you have to accept it.",
  },
  {
    title: "Offer your agent access",
    body: "Go to Agent Wallets and click Offer My Mailbox Access. This sends a grant offer to your agent — it doesn't take effect until your agent accepts.",
  },
  {
    title: "Your agent accepts",
    body: "Your agent signs the grant with its private key. Once accepted, it can read, send, and manage your inbox fully autonomously — no wallet popups, no human needed.",
  },
  {
    title: "Incoming Offers",
    body: "This is where the other path from before lands: your agent set up its own mailbox independently and is offering to share it with you. Accept it and it appears under Shared Mailboxes in My Mailbox — click Add Mailbox there to pin it to your sidebar, just like your own inbox.",
  },
  {
    title: "Revoke any time",
    body: "Go to Issued Grants and click Revoke. Access is removed immediately — your agent loses access to your human mailbox the moment you confirm.",
  },
];

function AuthTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const dialogRef = useFocusTrap({ isActive: true, onEscape: onDone, restoreFocus: true });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        style={{
          position: "relative",
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: "16px",
          padding: "24px",
          maxWidth: "400px",
          width: "100%",
          boxShadow: "0 25px 50px rgba(0,0,0,0.3)",
          color: "#111827",
        }}
      >
        <button
          onClick={onDone}
          aria-label="Close"
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#6b7280",
            padding: "4px",
            lineHeight: 0,
          }}
        >
          <X className="w-4 h-4" />
        </button>
        <p
          style={{
            fontSize: "11px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#6b7280",
            marginBottom: "12px",
            paddingRight: "20px",
          }}
        >
          How authorization works · {step + 1} of {STEPS.length}
        </p>
        <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>
          {STEPS[step].title}
        </h3>
        <p
          style={{
            fontSize: "14px",
            color: "#4b5563",
            lineHeight: 1.6,
            marginBottom: "20px",
          }}
        >
          {STEPS[step].body}
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {step > 0 ? (
            <button
              onClick={() => setStep((s) => s - 1)}
              style={{
                fontSize: "12px",
                color: "#6b7280",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={() => (isLast ? onDone() : setStep((s) => s + 1))}
            style={{
              fontSize: "14px",
              fontWeight: 500,
              color: "#2563eb",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            {isLast ? "Got it" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GrantsDrawer() {
  const { isOpen, close } = useGrantsDrawerStore();
  const [showTour, setShowTour] = useState(false);

  const dismissTour = () => {
    try { localStorage.setItem(TOUR_KEY, "1"); } catch { /* noop */ }
    setShowTour(false);
  };

  useEffect(() => {
    if (!isOpen) { setShowTour(false); return; }
    try { if (localStorage.getItem(TOUR_KEY)) return; } catch { return; }
    const t = setTimeout(() => setShowTour(true), 400);
    return () => clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !showTour) close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, showTour, close]);

  if (!isOpen) return null;

  return (
    <>
      {showTour && <AuthTour onDone={dismissTour} />}
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" aria-hidden onClick={close} />
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex flex-col",
          "w-full max-w-2xl bg-background border-l border-border shadow-2xl",
          "animate-in slide-in-from-right duration-200 ease-out",
        )}
        role="dialog"
        aria-modal
        aria-label="Authorization"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <span className="text-sm font-semibold">Authorization</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTour(true)}
              type="button"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "5px",
                background: "#FACC15",
                color: "#1f1300",
                fontSize: "11px",
                fontWeight: 700,
                padding: "5px 10px",
                borderRadius: "999px",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(250,204,21,0.35)",
              }}
            >
              <MessageCircleQuestion className="w-3.5 h-3.5" />
              How it works
            </button>
            <button
              onClick={close}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <GrantsContent />
        </div>
      </div>
    </>
  );
}
