"use client";

// Minimal compose affordance for accepted 'send'-scope grants. Send-scope
// grantees have no JMAP submission rights of their own (Stalwart's
// EmailSubmission/set requires true account membership, which an ACL grant
// structurally cannot satisfy — see auth/src/mailbox-sharing.ts's header for
// the source evidence). The only way to send as the owner is the scoped
// server-side proxy auth/src/server.ts adds: POST
// /api/grants/:grantId/mail/send, authenticated with the GRANTEE's own
// Sigil access token (never a credential) and hard-capped server-side to
// "create a draft + submit it" — no delete capability at all, closing the
// send-permits-delete asymmetry at the boundary itself.
//
// Deliberately minimal (to/subject/body, no attachments/CC/rich text) —
// this is a proxy send path for agents, not a replacement for the full
// composer used on the account's own mailbox.

import { useState } from "react";
import { Loader2, Send, Check, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SendResult {
  ok: boolean;
  error?: string;
}

export function SendGrantCompose({
  grantId,
  ownerActor,
  authFetch,
}: {
  grantId: string;
  ownerActor: string;
  authFetch: (path: string, opts?: RequestInit) => Promise<any>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const canSend = to.trim().length > 0 && subject.trim().length > 0 && text.trim().length > 0 && !sending;

  const handleSend = async () => {
    setSending(true);
    setResult(null);
    try {
      const res: SendResult = await authFetch(`/api/grants/${grantId}/mail/send`, {
        method: "POST",
        body: JSON.stringify({ to: to.trim(), subject: subject.trim(), text }),
      });
      if (!res.ok) throw new Error(res.error || "send failed");
      setResult({ ok: true });
      setTo("");
      setSubject("");
      setText("");
    } catch (err: any) {
      setResult({ ok: false, error: err?.message ?? String(err) });
    } finally {
      setSending(false);
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        <Send className="w-3 h-3" /> Compose as {ownerActor}
      </button>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Send as {ownerActor}@mailsigil.pro</p>
        <button
          type="button"
          onClick={() => { setExpanded(false); setResult(null); }}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Collapse compose"
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
      </div>
      <input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="To — recipient@example.com"
        disabled={sending}
        className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        disabled={sending}
        className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message"
        rows={3}
        disabled={sending}
        className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-y"
      />
      {result && !result.ok && <p className="text-xs text-destructive">{result.error}</p>}
      {result?.ok && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
          <Check className="w-3 h-3" /> Sent
        </p>
      )}
      <Button size="sm" onClick={handleSend} disabled={!canSend} className="w-full text-xs">
        {sending ? (<><Loader2 className="w-3 h-3 animate-spin mr-1" />Sending…</>) : (<><Send className="w-3 h-3 mr-1" />Send</>)}
      </Button>
    </div>
  );
}
