"use client";

// Read/send-scope grants (FLAG #6, 2026-07-20) no longer hand out a separate
// credential — the grantee reaches the owner's mailbox through their OWN
// Sigil login via Stalwart-native ACL sharing. Stalwart puts that shared
// account straight into the JMAP session's `accounts` map the moment the ACL
// exists, and this webmail's JMAP client (lib/jmap/client.ts) + sidebar
// (components/layout/sidebar.tsx's `buildMailboxTree`) already render any
// `isShared` mailbox generically — that machinery predates this feature (it
// backs the existing "group inbox" sharing) and needed no changes.
//
// What's missing is refresh: `this.accounts` is only populated at
// `connect()`/`reconnect()`, not on every `getAllMailboxes()` call, so a
// grant accepted mid-session won't show up until the client reconnects. This
// button does exactly that — reconnect (re-fetches the JMAP session,
// including the newly-shared account) then force a mailbox refetch — and
// then drops the user on the inbox where the new "shared-account-*" sidebar
// group will now be present.
//
// This intentionally does NOT try to jump straight to the shared mailbox's
// own folder (no client-side API resolves a fresh accountId → mailbox id
// without an extra round trip, and the sidebar auto-expands new top-level
// groups) — landing on the inbox with the group now visible is the honest,
// unbroken version of this affordance per the "don't half-wire something
// broken" rule.

import { useState } from "react";
import { Loader2, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useGrantsDrawerStore } from "@/stores/grants-drawer-store";
import { useRouter } from "@/i18n/navigation";

export function OpenSharedMailboxButton({ ownerActor }: { ownerActor: string }) {
  const client = useAuthStore((s) => s.client);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);
  const closeDrawer = useGrantsDrawerStore((s) => s.close);
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  const handleOpen = async () => {
    if (!client) {
      setState("error");
      setError("Not connected — reload webmail and try again");
      return;
    }
    setState("loading");
    setError("");
    try {
      // reconnect() re-fetches the JMAP session, which is the only way this
      // client's `accounts` map picks up a share that was granted after the
      // current session started.
      await client.reconnect();
      await fetchMailboxes(client);
      closeDrawer();
      router.push("/");
    } catch (err: any) {
      setState("error");
      setError(err?.message ?? "Could not refresh shared mailboxes");
    }
  };

  if (state === "error") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-xs text-destructive">{error}</span>
        <Button size="sm" variant="outline" onClick={handleOpen} className="text-xs">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleOpen}
      disabled={state === "loading"}
      className="text-xs shrink-0 gap-1"
      title={`Refreshes your mailbox list and shows ${ownerActor}'s shared folders in your sidebar`}
    >
      {state === "loading" ? (
        <><Loader2 className="w-3 h-3 animate-spin" /> Opening…</>
      ) : (
        <><FolderOpen className="w-3 h-3" /> Open shared mailbox</>
      )}
    </Button>
  );
}
