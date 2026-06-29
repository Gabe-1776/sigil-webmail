"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGrantsDrawerStore } from "@/stores/grants-drawer-store";
import GrantsPage from "@/app/(main)/[locale]/grants/page";

export function GrantsDrawer() {
  const { isOpen, close } = useGrantsDrawerStore();

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
        aria-hidden
        onClick={close}
      />
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
        <div className="flex items-center justify-end px-3 py-2 border-b border-border shrink-0">
          <button
            onClick={close}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close authorization panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <GrantsPage />
        </div>
      </div>
    </>
  );
}
