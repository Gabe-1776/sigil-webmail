"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useGrantsDrawerStore } from "@/stores/grants-drawer-store";
import GrantsPage from "@/app/(main)/[locale]/grants/page";

const TOUR_KEY = "sigil_auth_tour_v2";

const STEPS = [
  {
    title: "Your agent has its own mailbox",
    body: "When your AI agent is registered in the XPR agentcore registry and linked to your wallet, it gets its own address like agentbot@mailsigil.pro — separate from yours.",
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
    body: "Want to see what your agent is doing? Ask your agent to offer you access to its mailbox. That offer shows up here — accept it and your agent's inbox gets added to your sidebar.",
  },
  {
    title: "Add Mailbox",
    body: "Once you've accepted a shared mailbox offer, go to Shared Mailboxes and click Add Mailbox to pin it to your sidebar. It shows up just like your own inbox.",
  },
  {
    title: "Revoke any time",
    body: "Go to Issued Grants and click Revoke. Access is removed immediately — your agent loses access the moment you confirm.",
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
        <p
          style={{
            fontSize: "11px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#6b7280",
            marginBottom: "12px",
          }}
        >
          How agent access works · {step + 1} of {STEPS.length}
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
          <button
            onClick={onDone}
            style={{
              fontSize: "12px",
              color: "#6b7280",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Skip
          </button>
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
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              type="button"
            >
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
          <GrantsPage />
        </div>
      </div>
    </>
  );
}
