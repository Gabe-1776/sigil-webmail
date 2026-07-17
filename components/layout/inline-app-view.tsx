'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';

interface InlineAppViewProps {
  apps: InlineAppState[];
  activeAppId: string;
  onClose: () => void;
  className?: string;
}

export function InlineAppView({ apps, activeAppId, onClose, className }: InlineAppViewProps) {
  const activeApp = apps.find((a) => a.id === activeAppId);

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-secondary/50 flex-shrink-0">
        <h3 className="text-sm font-medium truncate">{activeApp?.name}</h3>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* Iframes - active one visible, rest hidden but alive */}
      <div className="flex-1 relative">
        {apps.map((app) => (
          <iframe
            key={app.id}
            src={app.url}
            title={app.name}
            className={cn(
              'absolute inset-0 w-full h-full border-0',
              app.id !== activeAppId && 'hidden'
            )}
            // No allow-same-origin: an inline app's URL is arbitrary
            // (user-supplied, see sidebar-apps-settings.tsx's addSidebarApp
            // validation), so this iframe must stay a genuinely opaque
            // origin. allow-scripts + allow-same-origin together is the
            // classic sandbox-escape combo — if a user ever added a URL
            // that resolves same-origin as this app (our own domain, or a
            // redirect back to it), that combination would let the framed
            // page reach window.parent and read the real session's
            // localStorage/DOM. No allow-popups-to-escape-sandbox either:
            // a popup opened from inside an inline app must stay just as
            // sandboxed as the app itself, so it can't run a fully
            // unrestricted phishing tab next to the real Sigil Mail chrome.
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ))}
      </div>
    </div>
  );
}
