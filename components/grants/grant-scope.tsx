"use client";

// Scope metadata + small presentational pieces shared across every place a
// grant is rendered in the drawer (Agent Wallets, Incoming Offers, Issued
// Grants, Shared Mailboxes). Kept in its own file (separate from the ~2000
// line grants-content.tsx monolith) so it's cheap to unit test in isolation
// without pulling in the wallet/proton/JMAP machinery that file drags in.
//
// Scope values come straight from the auth service (auth/src/server.ts's
// VALID_SCOPES = ["full", "read", "send"], FLAG #6 2026-07-20). This module
// treats any other string defensively (fail open to a generic "custom scope"
// chip, never throw) since the DB column is a plain TEXT and legacy/future
// values shouldn't crash the drawer.

import { Bot, User, Eye, Send, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type KnownScope = "full" | "read" | "send";

export interface ScopeMeta {
  label: string;
  /** One-line, human explanation of what the grantee can actually do — shown
   *  as a tooltip/title and inline caption, per the dual-ended-observability
   *  rule (humans must be able to tell what an agent-held grant can do). */
  explain: string;
  icon: typeof ShieldCheck;
  chipClass: string;
}

const SCOPE_META: Record<KnownScope, ScopeMeta> = {
  full: {
    label: "Full access",
    explain: "Complete control of this mailbox — read, send, delete, manage folders. Equivalent to logging in directly.",
    icon: ShieldCheck,
    chipClass: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  send: {
    label: "Read + Send",
    explain: "Can read every message and send new mail from this address. Cannot delete, move, or change anything.",
    icon: Send,
    chipClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  read: {
    label: "Read only",
    explain: "Can view messages in this mailbox. Cannot send, delete, or change anything.",
    icon: Eye,
    chipClass: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
};

const FALLBACK_META: ScopeMeta = {
  label: "Custom scope",
  explain: "This grant uses a scope this webmail version doesn't recognize yet — treat it as at least as powerful as read access.",
  icon: ShieldCheck,
  chipClass: "bg-muted text-muted-foreground",
};

export function isKnownScope(scope: string): scope is KnownScope {
  return scope === "full" || scope === "read" || scope === "send";
}

export function getScopeMeta(scope: string): ScopeMeta {
  return isKnownScope(scope) ? SCOPE_META[scope] : FALLBACK_META;
}

/** Labeled chip: scope name + icon, with the one-line explanation as a
 *  native tooltip (`title`) so it's discoverable without extra chrome. */
export function GrantScopeChip({ scope, className }: { scope: string; className?: string }) {
  const meta = getScopeMeta(scope);
  const Icon = meta.icon;
  return (
    <span
      title={meta.explain}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide",
        // Uniform blue for every known scope indicator (Gabriel 2026-07-21), so a
        // selected/assigned scope matches the blue selected-picker button instead
        // of showing send=amber / full=red. Scope stays differentiated by icon +
        // label. Unknown/custom scopes keep the neutral fallback so they don't
        // masquerade as a recognized one.
        isKnownScope(scope) ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : meta.chipClass,
        className,
      )}
    >
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </span>
  );
}

/** The one-liner on its own, for places that want the explanation as body
 *  text rather than a tooltip (e.g. under a scope picker). */
export function GrantScopeExplain({ scope, className }: { scope: string; className?: string }) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{getScopeMeta(scope).explain}</p>;
}

// ── Who's on the other end of a grant ───────────────────────────────────
// Every grant this webmail can create or receive is between an
// agentcore-linked owner<->agent pair (server.ts's checkLinkAuthority is the
// only path that can create one) — so the counterparty is always either one
// of the current actor's own linked agents, or the current actor's own
// human owner. That's exactly the `linked` shape already fetched by
// GrantsContent (`GET /api/agentcore/linked`), so no new backend call is
// needed to label a grant as agent-held vs human-held.
export type HolderKind = "agent" | "owner" | "unknown";

export interface LinkedAccountsLite {
  ownedBy: string | null;
  ownedAgentsDetailed: { actor: string; hasMailbox: boolean }[];
}

export function getHolderKind(counterpartActor: string, linked: LinkedAccountsLite | null): HolderKind {
  if (!linked) return "unknown";
  if (linked.ownedAgentsDetailed.some((a) => a.actor === counterpartActor)) return "agent";
  if (linked.ownedBy && linked.ownedBy === counterpartActor) return "owner";
  return "unknown";
}

/** Small badge making it obvious at a glance whether a grant row is held by
 *  an AI agent or a human owner — the standing Sigil-family "humans must see
 *  agent activity" rule applied to the grants list itself. */
export function GrantHolderBadge({ kind, className }: { kind: HolderKind; className?: string }) {
  if (kind === "unknown") return null;
  const isAgent = kind === "agent";
  const Icon = isAgent ? Bot : User;
  return (
    <span
      title={isAgent ? "This grant is held by one of your AI agents" : "This grant is held by your human owner"}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full",
        isAgent
          ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
          : "bg-blue-500/15 text-blue-600 dark:text-blue-400",
        className,
      )}
    >
      <Icon className="w-2.5 h-2.5" />
      {isAgent ? "Agent" : "Owner"}
    </span>
  );
}

// ── Scope picker for the offer flow ─────────────────────────────────────
// Webmail's offer endpoint (`POST /api/grants/offer`) defaults to scope
// "full" when the caller sends none — which, before this component existed,
// was the ONLY scope webmail could ever offer (no UI surfaced the `scope`
// field at all). This picker is what makes read/send-scoped grants reachable
// from webmail in the first place; it defaults to "full" so anyone who
// doesn't touch it gets byte-for-byte the old behavior.
const OFFERABLE_SCOPES: KnownScope[] = ["full", "send", "read"];

export function GrantScopePicker({
  value,
  onChange,
  className,
}: {
  value: KnownScope;
  onChange: (scope: KnownScope) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-1 flex-wrap", className)} role="radiogroup" aria-label="Grant scope">
      {OFFERABLE_SCOPES.map((s) => {
        const meta = SCOPE_META[s];
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            title={meta.explain}
            onClick={() => onChange(s)}
            className={cn(
              "text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors uppercase tracking-wide",
              // Selected scope uses one consistent blue (the "read only" sky
              // color), per Gabriel 2026-07-21 — the picker reads as one control
              // instead of a red/amber/blue traffic light. The per-scope colors
              // still live on GrantScopeChip where a grant's scope is displayed.
              active ? "bg-sky-500/25 text-sky-700 dark:text-sky-300 border-transparent" : "border-border text-muted-foreground hover:border-foreground/30",
            )}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
