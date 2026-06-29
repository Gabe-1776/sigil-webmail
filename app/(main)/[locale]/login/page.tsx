"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "@/i18n/navigation";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useThemeStore } from "@/stores/theme-store";
import { useShallow } from "zustand/react/shallow";
import { useConfig } from "@/hooks/use-config";
import { apiFetch, getPathPrefix, toRouterPath, withBasePath } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2, X, Info, LogIn, Sun, Moon, Monitor, Check, Shield, Play, Copy } from "lucide-react";
import { type OAuthMetadata } from "@/lib/oauth/discovery";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/oauth/pkce";
import { useUpdateStore, selectBanner } from "@/stores/update-store";
import type { PublicJmapServerEntry } from "@/lib/admin/jmap-servers";

function findServerByDomain(servers: PublicJmapServerEntry[], email: string | undefined): PublicJmapServerEntry | undefined {
  if (!email || !email.includes("@")) return undefined;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return undefined;
  return servers.find((s) => (s.domains ?? []).some((d) => d.toLowerCase() === domain));
}

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
const GIT_COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";

function SigilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={className} aria-hidden="true">
      <rect x="22" y="38" width="76" height="52" rx="6" fill="#FACC15" />
      <path
        d="M 22 44 L 60 70 L 98 44 Q 98 38 92 38 L 28 38 Q 22 38 22 44 Z"
        fill="#D8A510"
      />
      <path
        d="M 22 44 L 60 70 L 98 44"
        fill="none"
        stroke="#9C7608"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const THEME_OPTIONS = [
  { value: "light" as const, icon: Sun, label: "Light" },
  { value: "dark" as const, icon: Moon, label: "Dark" },
  { value: "system" as const, icon: Monitor, label: "System" },
  { value: "sigil" as const, icon: SigilIcon, label: "Sigil" },
];

function VersionBadge() {
  const [copied, setCopied] = useState(false);
  const banner = useUpdateStore(useShallow(selectBanner));
  const startPolling = useUpdateStore((s) => s.startPolling);

  useEffect(() => { startPolling(); }, [startPolling]);

  const versionInfo = `Version: ${APP_VERSION}\nBuild: ${GIT_COMMIT}${banner?.latest ? `\nLatest: ${banner.latest}` : ""}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(versionInfo).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const isRed = banner?.variant === "red";
  const triggerText = !banner
    ? `v${APP_VERSION}`
    : banner.severity === "security"
      ? "Security update available"
      : banner.severity === "deprecated"
        ? "Version no longer supported"
        : "New version available";

  const triggerColor = !banner
    ? "text-muted-foreground/40"
    : isRed
      ? "text-red-600/80 dark:text-red-400/80 hover:text-red-600 dark:hover:text-red-400"
      : "text-amber-600/80 dark:text-amber-400/80 hover:text-amber-600 dark:hover:text-amber-400";

  const triggerClass = cn(
    "peer text-center text-xs transition-colors",
    triggerColor,
    banner?.url ? "cursor-pointer underline-offset-2 hover:underline" : "cursor-default",
  );

  const trigger = banner?.url ? (
    <a href={banner.url} target="_blank" rel="noopener noreferrer" className={triggerClass}>
      {triggerText}
    </a>
  ) : (
    <p className={triggerClass}>{triggerText}</p>
  );

  return (
    <div className="relative inline-flex justify-center">
      {trigger}
      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-3 py-2 rounded-md bg-popover text-popover-foreground text-xs shadow-md border border-border opacity-0 peer-hover:opacity-100 hover:opacity-100 transition-opacity whitespace-nowrap z-10">
        <div className="flex items-center gap-2">
          <div className="space-y-0.5">
            <p>Version: <span className="font-medium">{APP_VERSION}</span></p>
            <p>Build: <span className="font-medium">{GIT_COMMIT}</span></p>
            {banner?.latest && (
              <p>Latest: <span className="font-medium">{banner.latest}</span></p>
            )}
            {banner?.advisory && (
              <p className="text-red-500 dark:text-red-400">{banner.advisory}</p>
            )}
          </div>
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Copy version info"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// Only redirect targets matching this scheme are honored by the mobile
// handoff path. Without the check the login page becomes an open redirector
// that funnels password and token material to any caller-supplied URL.
const MOBILE_REDIRECT_SCHEME = "bulwarkmobile://";

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations("login");
  const params = useParams();
  const searchParams = useSearchParams();
  const isAddAccountMode = searchParams.get("mode") === "add-account";

  // When the mobile app launches the webmail in a browser tab it tacks on
  // these params. We grab them once at mount and stash them in a ref so any
  // login path that completes (password or OAuth) can hand control back to
  // the app instead of routing into /mail.
  const rawMobileRedirectUri = searchParams.get("mobile_redirect_uri") ?? "";
  const rawMobileState = searchParams.get("mobile_state") ?? "";
  const mobileRedirectUri = rawMobileRedirectUri.startsWith(MOBILE_REDIRECT_SCHEME)
    ? rawMobileRedirectUri
    : "";
  const mobileState = mobileRedirectUri ? rawMobileState : "";
  const isMobileHandoff = Boolean(mobileRedirectUri);
  const { login, loginDemo, isLoading, error, clearError, isAuthenticated } = useAuthStore();
  const { theme, setTheme, initializeTheme } = useThemeStore(useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme, initializeTheme: s.initializeTheme })));
  const { appName, jmapServerUrl: configuredServerUrl, oauthEnabled, oauthOnly, oauthClientId: globalOauthClientId, oauthIssuerUrl: globalOauthIssuerUrl, oauthScopes, rememberMeEnabled, devMode, demoMode, loginLogoLightUrl, loginLogoDarkUrl, loginCompanyName, loginImprintUrl, loginPrivacyPolicyUrl, loginWebsiteUrl, isLoading: configLoading, error: configError, autoSsoEnabled, embeddedMode: _embeddedMode, allowCustomJmapEndpoint, jmapServers, jmapServerAutoPickByDomain } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  const [formData, setFormData] = useState({
    username: "",
    password: "",
  });
  const [jmapEndpoint, setJmapEndpoint] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [domainAutoLocked, setDomainAutoLocked] = useState(false);

  const hasServerList = jmapServers.length > 0;
  const selectedServer = hasServerList
    ? jmapServers.find((s) => s.id === selectedServerId) ?? jmapServers[0]
    : undefined;

  // Effective values: per-server overrides win, then global config.
  const serverUrl = selectedServer?.url || configuredServerUrl;
  const effectiveOauthClientId = selectedServer?.oauth?.clientId || globalOauthClientId;
  const effectiveOauthIssuerUrl = selectedServer?.oauth?.issuerUrl || globalOauthIssuerUrl;
  const [totpCode, setTotpCode] = useState("");
  const [showTotpField, setShowTotpField] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);

  const [savedUsernames, setSavedUsernames] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [oauthMetadata, setOauthMetadata] = useState<OAuthMetadata | null>(null);
  const [oauthDiscoveryDone, setOauthDiscoveryDone] = useState(false);
  const XPR_AUTH_SERVICE_URL =
    process.env.NEXT_PUBLIC_XPR_AUTH_SERVICE_URL || "https://auth.mailsigil.pro";
  const [xprLoading, setXprLoading] = useState(false);
  const [xprStatus, setXprStatus] = useState("");
  const [xprError, setXprError] = useState("");
  const sigilGrantToken = searchParams.get("sigil_grant_token") ?? "";
  const [oauthLoading, setOauthLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  const suggestionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const justSelectedSuggestion = useRef(false);
  const totpInputRef = useRef<HTMLInputElement>(null);
  const prevError = useRef<string | null>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  // Captured by handleSubmit when in mobile handoff mode; consumed by the
  // isAuthenticated effect to build the deep-link fragment.
  const mobileHandoffPayloadRef = useRef<{ server_url: string; username: string; password: string } | null>(null);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  // Sigil grant auto-login: dashboard passes a one-time token so the user
  // never has to handle credentials manually when opening a shared mailbox.
  useEffect(() => {
    if (!sigilGrantToken || !serverUrl || xprLoading) return;
    let cancelled = false;
    (async () => {
      setXprLoading(true);
      setXprStatus("Opening shared mailbox…");
      try {
        const res = await fetch(`${XPR_AUTH_SERVICE_URL}/api/grants/exchange-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: sigilGrantToken }),
        }).then(r => r.json());
        if (cancelled) return;
        if (!res.ok) throw new Error(res.error || "Token exchange failed");
        const success = await login(serverUrl, res.username, res.password);
        if (cancelled) return;
        if (success) {
          router.push("/");
        } else {
          setXprError("Auto-login failed — the grant may have been revoked.");
        }
      } catch (err) {
        if (!cancelled) setXprError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setXprLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigilGrantToken, serverUrl]);

  useEffect(() => {
    if (serverUrl) {
      document.title = appName;
    }
  }, [appName, serverUrl]);

  useEffect(() => {
    if (serverUrl && !jmapEndpoint) {
      setJmapEndpoint(serverUrl);
    }
  }, [serverUrl, jmapEndpoint]);

  // Initialize selected server when the server list arrives. Picks the first
  // entry; the auto-pick effect below may override based on the email domain.
  useEffect(() => {
    if (!hasServerList) return;
    if (selectedServerId && jmapServers.some((s) => s.id === selectedServerId)) return;
    setSelectedServerId(jmapServers[0].id);
  }, [hasServerList, jmapServers, selectedServerId]);

  // Auto-pick by email domain. Locks the dropdown to the matched server until
  // the user clears the email or types a domain we don't recognize.
  useEffect(() => {
    if (!jmapServerAutoPickByDomain || !hasServerList) return;
    const match = findServerByDomain(jmapServers, formData.username);
    if (match) {
      if (selectedServerId !== match.id) setSelectedServerId(match.id);
      setDomainAutoLocked(true);
    } else {
      setDomainAutoLocked(false);
    }
  }, [jmapServerAutoPickByDomain, hasServerList, jmapServers, formData.username, selectedServerId]);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('session_expired') === 'true') {
        setSessionExpired(true);
        sessionStorage.removeItem('session_expired');
      }
    } catch { /* sessionStorage unavailable */ }
  }, []);

  useEffect(() => {
    if (error && error !== prevError.current) {
      setShakeError(true);
      const timer = setTimeout(() => setShakeError(false), 400);
      return () => clearTimeout(timer);
    }
    prevError.current = error;
  }, [error]);

  // Auto-show and focus TOTP field when server requires it
  useEffect(() => {
    if (error === 'totp_required') {
      setShowTotpField(true);
      setTimeout(() => totpInputRef.current?.focus(), 100);
    }
  }, [error]);

  useEffect(() => {
    if (!serverUrl) return;
    const saved = localStorage.getItem("webmail_usernames");
    if (saved) {
      try {
        const usernames = JSON.parse(saved);
        setSavedUsernames(usernames);
      } catch {
        console.error("Failed to parse saved usernames");
      }
    }
  }, [serverUrl]);

  useEffect(() => {
    if (isAuthenticated && !isAddAccountMode) {
      // Mobile handoff: the password path completes here once the auth store
      // flips isAuthenticated. Hand the verified credentials back to the
      // mobile app instead of pushing to /mail. handleSubmit captured the
      // values needed for the fragment.
      if (isMobileHandoff && mobileHandoffPayloadRef.current) {
        const fragment = new URLSearchParams({
          flow: "password",
          ...mobileHandoffPayloadRef.current,
          state: mobileState,
        });
        window.location.replace(`${mobileRedirectUri}#${fragment.toString()}`);
        return;
      }
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(toRouterPath(redirectTo));
    }
  }, [isAuthenticated, router, isAddAccountMode, isMobileHandoff, mobileRedirectUri, mobileState]);

  useEffect(() => {
    clearError();
  }, [formData, clearError]);

  useEffect(() => {
    if (!serverUrl) return;
    if (justSelectedSuggestion.current) {
      justSelectedSuggestion.current = false;
      return;
    }

    if (formData.username && savedUsernames.length > 0) {
      const filtered = savedUsernames.filter(username =>
        username.toLowerCase().includes(formData.username.toLowerCase())
      );
      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else if (formData.username === "" && savedUsernames.length > 0) {
      setFilteredSuggestions(savedUsernames);
      setShowSuggestions(false);
    } else {
      setShowSuggestions(false);
    }
    setSelectedSuggestionIndex(-1);
  }, [formData.username, savedUsernames, serverUrl]);

  useEffect(() => {
    if (!serverUrl) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node) &&
          inputRef.current && !inputRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
      if (themeMenuRef.current && !themeMenuRef.current.contains(event.target as Node)) {
        setShowThemeMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [serverUrl]);

  useEffect(() => {
    if (!oauthEnabled || !serverUrl) return;
    setOauthDiscoveryDone(false);
    setOauthMetadata(null);
    const controller = new AbortController();
    // Discover via our own origin rather than fetching the IdP's /.well-known/*
    // documents directly from the browser. A direct cross-origin discovery
    // fetch is subject to CORS, and providers like Authentik serve those
    // documents without Access-Control-Allow-Origin, so the browser blocks the
    // response and login breaks (issue #382). The proxy runs discovery server
    // side where CORS does not apply.
    const query = selectedServer?.id ? `?server_id=${encodeURIComponent(selectedServer.id)}` : "";
    apiFetch(`/api/auth/oauth/metadata${query}`, { signal: controller.signal })
      .then(async (res) => (res.ok ? ((await res.json()) as OAuthMetadata) : null))
      .then((metadata) => {
        setOauthMetadata(metadata);
        setOauthDiscoveryDone(true);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setOauthMetadata(null);
        setOauthDiscoveryDone(true);
      });
    return () => controller.abort();
  }, [oauthEnabled, serverUrl, effectiveOauthIssuerUrl, selectedServer?.id]);

  // Auto-SSO: when enabled with OAUTH_ONLY, skip the login page entirely
  const ssoError = searchParams.get("sso_error");
  const autoSsoTriggered = useRef(false);

  const startServerSideSso = useCallback(async () => {
    setOauthLoading(true);
    try {
      const prefix = getPathPrefix(params.locale as string);
      const redirectUri = `${window.location.origin}${prefix}/${params.locale}/auth/callback`;
      // In mobile-handoff mode the callback page needs to know it should
      // redirect into the app rather than into /mail. Stash the params in
      // sessionStorage so the same-tab callback can read them - the SSO
      // pending cookie carries the authoritative copy server-side too.
      if (isMobileHandoff) {
        try {
          sessionStorage.setItem("mobile_redirect_uri", mobileRedirectUri);
          sessionStorage.setItem("mobile_state", mobileState);
        } catch { /* sessionStorage unavailable */ }
      }
      const res = await apiFetch('/api/auth/sso/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          redirect_uri: redirectUri,
          locale: params.locale,
          server_id: selectedServer?.id,
          ...(isMobileHandoff
            ? { mobile_redirect_uri: mobileRedirectUri, mobile_state: mobileState }
            : {}),
        }),
      });

      if (!res.ok) {
        setOauthLoading(false);
        return;
      }

      const { authorize_url } = await res.json();

      // Navigate to the authorize URL
      const isIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
      if (isIframe) {
        // In an iframe, try top-level navigation
        try {
          window.top!.location.href = authorize_url;
        } catch {
          // Cross-origin restriction - fall back to current frame
          window.location.href = authorize_url;
        }
      } else {
        window.location.href = authorize_url;
      }
    } catch {
      setOauthLoading(false);
    }
  }, [params.locale, selectedServer?.id, isMobileHandoff, mobileRedirectUri, mobileState]);

  useEffect(() => {
    if (!autoSsoEnabled || !oauthOnly || !oauthDiscoveryDone || !oauthMetadata) return;
    if (ssoError || isAddAccountMode || isAuthenticated) return;
    if (autoSsoTriggered.current) return;

    // Guard against redirect loops
    try {
      if (sessionStorage.getItem("sso_attempted")) return;
      sessionStorage.setItem("sso_attempted", "1");
      // Clear the flag after 30 seconds so retries are possible
      setTimeout(() => { try { sessionStorage.removeItem("sso_attempted"); } catch { /* ignore */ } }, 30000);
    } catch { /* sessionStorage unavailable */ }

    autoSsoTriggered.current = true;
    startServerSideSso();
  }, [autoSsoEnabled, oauthOnly, oauthDiscoveryDone, oauthMetadata, ssoError, isAddAccountMode, isAuthenticated, startServerSideSso]);

  const handleThemeSelect = useCallback((newTheme: "light" | "dark" | "system" | "sigil") => {
    setTheme(newTheme);
    setShowThemeMenu(false);
  }, [setTheme]);

  if (configLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30">
        <div className="w-full max-w-sm mx-auto px-4 text-center" role="status">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          <span className="sr-only">{t("loading")}</span>
        </div>
      </div>
    );
  }

  if (configError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30">
        <div className="w-full max-w-md mx-auto px-4 text-center">
          <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl p-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-5">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-xl font-semibold text-foreground mb-2">{t("config_error.title")}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("config_error.fetch_failed")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!serverUrl && !demoMode && !allowCustomJmapEndpoint) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30">
        <div className="w-full max-w-md mx-auto px-4 text-center">
          <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl p-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-5">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-xl font-semibold text-foreground mb-2">{t("config_error.title")}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("config_error.server_not_configured")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const saveUsername = (username: string) => {
    const saved = localStorage.getItem("webmail_usernames");
    let usernames: string[] = [];

    if (saved) {
      try {
        usernames = JSON.parse(saved);
      } catch {
        console.error("Failed to parse saved usernames");
      }
    }

    if (!usernames.includes(username)) {
      usernames = [username, ...usernames].slice(0, 5);
      localStorage.setItem("webmail_usernames", JSON.stringify(usernames));
      setSavedUsernames(usernames);
    }
  };

  const removeUsername = (username: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = savedUsernames.filter(u => u !== username);
    localStorage.setItem("webmail_usernames", JSON.stringify(updated));
    setSavedUsernames(updated);
    setFilteredSuggestions(updated.filter(u =>
      u.toLowerCase().includes(formData.username.toLowerCase())
    ));
  };

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, username: e.target.value });
  };

  const handleUsernameFocus = () => {
    if (savedUsernames.length > 0 && formData.username === "") {
      setFilteredSuggestions(savedUsernames);
      setShowSuggestions(true);
    } else if (filteredSuggestions.length > 0) {
      setShowSuggestions(true);
    }
  };

  const selectSuggestion = (username: string) => {
    justSelectedSuggestion.current = true;
    setFormData({ ...formData, username });
    setShowSuggestions(false);
    document.getElementById("password")?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || filteredSuggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestionIndex(prev =>
        prev < filteredSuggestions.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestionIndex(prev => prev > 0 ? prev - 1 : -1);
    } else if (e.key === "Enter" && selectedSuggestionIndex >= 0) {
      e.preventDefault();
      selectSuggestion(filteredSuggestions[selectedSuggestionIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);
    }
  };

  const handleOAuthLogin = async () => {
    if (!oauthMetadata || !effectiveOauthClientId) return;
    // In mobile-handoff mode the client-side PKCE flow doesn't help us:
    // tokens would land in sessionStorage on the webmail origin and the
    // mobile app couldn't read them. Route through the server-side SSO
    // path instead, which has the mobile-aware /api/auth/sso/complete
    // branch.
    if (isMobileHandoff) {
      await startServerSideSso();
      return;
    }
    setOauthLoading(true);

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();
    const prefix = getPathPrefix(params.locale as string);
    const redirectUri = `${window.location.origin}${prefix}/${params.locale}/auth/callback`;

    // Resolve the JMAP URL to send to the callback. Server-list entries win
    // over the custom-endpoint input, which wins over the global server URL.
    const oauthServerUrl = selectedServer?.url
      || (allowCustomJmapEndpoint ? jmapEndpoint : configuredServerUrl);

    sessionStorage.setItem("oauth_code_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_server_url", oauthServerUrl!);
    if (selectedServer?.id) {
      sessionStorage.setItem("oauth_server_id", selectedServer.id);
    } else {
      sessionStorage.removeItem("oauth_server_id");
    }
    if (isAddAccountMode) {
      sessionStorage.setItem("oauth_add_account_mode", "true");
    }

    // Persist the next-free cookie slot so loginWithOAuth (in stores/auth-store.ts)
    // writes the refresh token to the correct per-account jmap_rt_<slot> cookie.
    // loginWithOAuth reads this key but it was previously never written, so every
    // OAuth account collapsed onto slot 0 and clobbered earlier accounts' refresh
    // tokens. getNextCookieSlot() returns 0 when no accounts exist (correct for
    // first sign-in) and the lowest unused slot otherwise (correct for "+ Add
    // Account").
    const nextSlot = useAccountStore.getState().getNextCookieSlot();
    sessionStorage.setItem("oauth_cookie_slot", nextSlot.toString());

    const authUrl = new URL(oauthMetadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", effectiveOauthClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", oauthScopes || "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    window.location.href = authUrl.toString();
  };

  // Sigil: XPR wallet login. No password ever exists on this path — the
  // wallet signature itself is the credential. We don't use Bulwark's OAuth
  // flow here deliberately: that would hand Stalwart our own minted token
  // as a bearer credential, which Stalwart's JMAP still rejects (unresolved
  // upstream issue). Instead we mint a Phase-4 app-password (the path that's
  // actually proven working) and feed it into Bulwark's existing basic-auth
  // `login()` — same session/cookie code as the password form, just never
  // typed by a human.
  const XPR_CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
  const XPR_ENDPOINTS = ["https://proton.eosusa.io", "https://proton.protonuk.io"];

  const handleXprLogin = async () => {
    setXprError("");
    setXprLoading(true);
    try {
      setXprStatus(t("xpr_connecting_wallet") || "Connecting wallet…");
      const ProtonWebSDK = (await import("@proton/web-sdk")).default;
      await import("@proton/link");

      const { session, loginResult } = await ProtonWebSDK({
        linkOptions: { chainId: XPR_CHAIN_ID, endpoints: XPR_ENDPOINTS },
        transportOptions: { requestAccount: "mailsigil" },
        selectorOptions: { appName: appName || "Sigil Mail", enabledWalletTypes: ["webauth", "anchor", "proton"] },
      });
      if (!session) throw new Error("Wallet connection was cancelled");

      const actor = session.auth.actor;
      const permission = session.auth.permission;

      // Verify identity and get a backend access token. Preferred path: the
      // identity proof ConnectWallet already produced (Proton mobile / Anchor)
      // — one "Authorize" tap, no transaction prompt. Fallback: the webauth.com
      // desktop popup returns no proof, so sign a never-broadcast transfer.
      let verifyRes: { ok?: boolean; error?: string; accessToken?: string };
      if (loginResult?.proof) {
        setXprStatus(t("xpr_verifying") || "Verifying…");
        verifyRes = await fetch(`${XPR_AUTH_SERVICE_URL}/api/auth/verify-proof`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proof: loginResult.proof.toString() }),
        }).then((r) => r.json());
      } else {
        setXprStatus(t("xpr_requesting_challenge") || "Requesting login challenge…");
        const { challengeId, message } = await fetch(`${XPR_AUTH_SERVICE_URL}/api/auth/nonce`, {
          method: "POST",
        }).then((r) => r.json());
        const { Serializer } = await import("@greymass/eosio");

        setXprStatus(t("xpr_signing") || `Connected as ${actor} — sign in your wallet (this costs nothing)…`);
        const nonce = message.match(/Nonce: (\S+)/)?.[1];
        const result = await session.transact(
          {
            actions: [
              {
                account: "eosio.token",
                name: "transfer",
                authorization: [{ actor, permission }],
                // from===to is rejected client-side even with broadcast:false,
                // so send to the always-present `eosio` system account. Never
                // broadcast; nothing here ever touches the chain.
                data: { from: actor, to: "eosio", quantity: "0.0001 XPR", memo: nonce },
              },
            ],
          },
          { broadcast: false },
        );
        const serializedTransaction = Serializer.encode({ object: result.transaction }).hexString;

        setXprStatus(t("xpr_verifying") || "Verifying signature…");
        verifyRes = await fetch(`${XPR_AUTH_SERVICE_URL}/api/auth/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, actor, permission, signatures: result.signatures, serializedTransaction }),
        }).then((r) => r.json());
      }

      if (!verifyRes.ok) {
        throw new Error(verifyRes.error || "Wallet signature verification failed");
      }

      setXprStatus(t("xpr_minting_credential") || "Setting up your mailbox access…");
      const appPasswordRes = await fetch(`${XPR_AUTH_SERVICE_URL}/api/auth/app-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${verifyRes.accessToken}` },
        body: JSON.stringify({ description: "Bulwark webmail session" }),
      }).then((r) => r.json());

      if (!appPasswordRes.username || !appPasswordRes.password) {
        throw new Error(appPasswordRes.error || "Could not provision mailbox access");
      }

      setXprStatus(t("xpr_signing_in") || "Signing in…");
      const success = await login(serverUrl, appPasswordRes.username, appPasswordRes.password);
      if (success) {
        if (verifyRes.accessToken) {
          localStorage.setItem("sigil_auth_token", verifyRes.accessToken);
          localStorage.setItem("sigil_actor", appPasswordRes.username?.split("@")[0] ?? "");
        }
        router.push("/");
      } else {
        throw new Error("Mailbox login failed after wallet verification");
      }
    } catch (err) {
      setXprError(err instanceof Error ? err.message : String(err));
    } finally {
      setXprLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Server-list entries always win - `allowCustomJmapEndpoint` is only honored
    // when the admin hasn't configured a server list.
    const effectiveServerUrl = selectedServer?.url
      || (allowCustomJmapEndpoint ? jmapEndpoint : serverUrl);
    // Capture before login() so the isAuthenticated effect can build the
    // deep-link fragment with values the user actually typed (formData may
    // be cleared by the auth store on success).
    if (isMobileHandoff) {
      mobileHandoffPayloadRef.current = {
        server_url: effectiveServerUrl,
        username: formData.username,
        password: formData.password,
      };
    }
    const success = await login(
      effectiveServerUrl,
      formData.username,
      formData.password,
      totpCode || undefined,
      rememberMe
    );

    if (success) {
      saveUsername(formData.username);
      if (isMobileHandoff) {
        // The isAuthenticated effect handles the redirect; nothing else to
        // do here. Don't push to / - that would race the deep link.
        return;
      }
      router.push('/');
    } else if (isMobileHandoff) {
      // Stale payload should never feed into a later retry's redirect.
      mobileHandoffPayloadRef.current = null;
    }
  };

  const handleDevLogin = async () => {
    const success = await login(serverUrl, "dev@localhost", "dev");
    if (success) {
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(toRouterPath(redirectTo));
    }
  };

  const handleDemoLogin = async () => {
    setDemoLoading(true);
    const success = await loginDemo();
    if (success) {
      router.push('/');
    }
    setDemoLoading(false);
  };

  const currentThemeOption = THEME_OPTIONS.find(o => o.value === theme) || THEME_OPTIONS[2];
  const CurrentThemeIcon = currentThemeOption.icon;

  // Demo-only mode: show only a large demo login button
  if (demoMode && !isAddAccountMode) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/10 to-muted/30 relative px-4">
        {/* Theme toggle */}
        <div className="absolute top-5 right-5" ref={themeMenuRef} suppressHydrationWarning>
          <button
            type="button"
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all duration-200",
              showThemeMenu
                ? "bg-secondary border-border text-foreground shadow-md"
                : "bg-background/60 backdrop-blur-sm border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/80 hover:border-border"
            )}
            aria-label={`Theme: ${currentThemeOption.label}`}
            aria-expanded={showThemeMenu}
            aria-haspopup="listbox"
          >
            <CurrentThemeIcon className="w-4 h-4" />
            <span className="hidden sm:inline" suppressHydrationWarning>{currentThemeOption.label}</span>
          </button>

          {showThemeMenu && (
            <div
              className="absolute right-0 top-full mt-2 w-40 rounded-xl border border-border bg-background shadow-lg overflow-hidden animate-fade-in z-50"
              role="listbox"
              aria-label="Theme selection"
            >
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isActive = theme === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => handleThemeSelect(option.value)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                      isActive
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="flex-1 text-left">{option.label}</span>
                    {isActive && <Check className="w-3.5 h-3.5 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="w-full max-w-[440px] mx-auto">
          <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl shadow-black/5 dark:shadow-black/20 overflow-hidden">
            {/* Header with logo */}
            <div className="px-8 pt-12 pb-4 text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 mb-6">
                <img
                  src={withBasePath(resolvedTheme === 'dark' ? loginLogoDarkUrl : loginLogoLightUrl)}
                  alt={appName}
                  className="max-w-20 max-h-20 object-contain"
                />
              </div>
              <h1 className="text-3xl font-bold text-foreground tracking-tight">
                {appName}
              </h1>
              <p className="text-base text-muted-foreground mt-2 max-w-xs mx-auto leading-relaxed">
                {t("demo_tagline")}
              </p>
            </div>

            {/* Large demo button */}
            <div className="px-8 pb-10 pt-4">
              {error && (
                <div className={cn(
                  "mb-5 p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3",
                  shakeError && "animate-shake"
                )}>
                  <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
                    <AlertCircle className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0 self-center">
                    <p className="text-sm text-destructive leading-relaxed">
                      {t(`error.${error}`) || t("error.generic")}
                    </p>
                  </div>
                </div>
              )}

              <Button
                type="button"
                className="w-full h-14 font-semibold text-lg bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02] active:scale-[0.98]"
                onClick={handleDemoLogin}
                disabled={demoLoading || isLoading}
              >
                {demoLoading ? (
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {t("demo_launching")}
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Play className="w-5 h-5" />
                    {t("demo_login_button")}
                  </div>
                )}
              </Button>

              <p className="text-center text-sm text-muted-foreground mt-4 leading-relaxed">
                {t("demo_no_signup")}
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-6 flex flex-col items-center gap-2">
            {loginCompanyName && (
              <p className="text-center text-xs text-muted-foreground/60 font-medium">
                {loginCompanyName}
              </p>
            )}
            {(loginImprintUrl || loginPrivacyPolicyUrl || loginWebsiteUrl) && (
              <div className="flex items-center gap-3 flex-wrap justify-center">
                {loginWebsiteUrl && (
                  <a href={loginWebsiteUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                    {t("website")}
                  </a>
                )}
                {loginImprintUrl && (
                  <a href={loginImprintUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                    {t("imprint")}
                  </a>
                )}
                {loginPrivacyPolicyUrl && (
                  <a href={loginPrivacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                    {t("privacy_policy")}
                  </a>
                )}
              </div>
            )}
            <VersionBadge />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/10 to-muted/30 relative px-4">
      {/* Theme toggle - top right, dropdown style */}
      <div className="absolute top-5 right-5" ref={themeMenuRef} suppressHydrationWarning>
        <button
          type="button"
          onClick={() => setShowThemeMenu(!showThemeMenu)}
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all duration-200",
            showThemeMenu
              ? "bg-secondary border-border text-foreground shadow-md"
              : "bg-background/60 backdrop-blur-sm border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/80 hover:border-border"
          )}
          aria-label={`Theme: ${currentThemeOption.label}`}
          aria-expanded={showThemeMenu}
          aria-haspopup="listbox"
        >
          <CurrentThemeIcon className="w-4 h-4" />
          <span className="hidden sm:inline" suppressHydrationWarning>{currentThemeOption.label}</span>
        </button>

        {showThemeMenu && (
          <div
            className="absolute right-0 top-full mt-2 w-40 rounded-xl border border-border bg-background shadow-lg overflow-hidden animate-fade-in z-50"
            role="listbox"
            aria-label="Theme selection"
          >
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isActive = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleThemeSelect(option.value)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                    isActive
                      ? "bg-primary/10 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-left">{option.label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-primary" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="w-full max-w-[400px] mx-auto">
        {/* Card container */}
        <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl shadow-black/5 dark:shadow-black/20 overflow-hidden">
          {/* Header section with logo */}
          <div className="px-8 pt-10 pb-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 mb-5">
              <img
                src={withBasePath(resolvedTheme === 'dark' ? loginLogoDarkUrl : loginLogoLightUrl)}
                alt={appName}
                className="max-w-16 max-h-16 object-contain"
              />
            </div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">
              {isAddAccountMode ? t("add_account_title") : appName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5">
              {isAddAccountMode ? t("add_account_subtitle") : (t("title") !== appName ? t("title") : "Sign in to your account")}
            </p>
          </div>

          {/* Form section */}
          <div className="px-8 pb-8">
            {/* Session Expired Banner */}
            {sessionExpired && (
              <div
                className="mb-5 p-3 rounded-xl border border-info/20 bg-info/5 flex items-start gap-3"
                role="status"
                aria-live="polite"
              >
                <div className="w-10 h-10 rounded-full bg-info/15 text-info flex items-center justify-center flex-shrink-0 shadow-sm">
                  <Info className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0 self-center flex items-center gap-2">
                  <p className="text-sm text-info flex-1 leading-relaxed">
                    {t("session_expired")}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSessionExpired(false)}
                    className="p-1 rounded-md text-info hover:bg-info/10 transition-colors flex-shrink-0"
                    aria-label={t("dismiss")}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div className={cn(
                "mb-5 p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3",
                shakeError && "animate-shake"
              )}>
                <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0 self-center">
                  <p className="text-sm text-destructive leading-relaxed">
                    {error === 'invalid_credentials' && showTotpField && totpCode
                      ? t('error.totp_invalid')
                      : t(`error.${error}`) || t("error.generic")}
                  </p>
                </div>
              </div>
            )}

            {/* Dev Mode: One-click login */}
            {devMode ? (
              <div className="space-y-4">
                <Button
                  type="button"
                  className="w-full h-12 font-medium text-base bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-lg shadow-primary/20"
                  onClick={handleDevLogin}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("signing_in")}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <LogIn className="w-4 h-4" />
                      {t("sign_in")}
                    </div>
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Dev mode - logging in as dev@localhost
                </p>
              </div>
            ) : oauthOnly ? (
              /* OAuth-only mode: show SSO button only */
              <div className="space-y-4">
                {oauthMetadata ? (
                  <Button
                    type="button"
                    className="w-full h-11 font-medium text-[15px] bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
                    onClick={handleOAuthLogin}
                    disabled={oauthLoading}
                  >
                    {oauthLoading ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {t("signing_in")}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <LogIn className="w-4 h-4" />
                        {t("sign_in_sso")}
                      </div>
                    )}
                  </Button>
                ) : oauthDiscoveryDone ? (
                  <div className="p-3 rounded-xl border border-warning/20 bg-warning/5 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
                      <AlertCircle className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0 self-center">
                      <p className="text-sm text-warning leading-relaxed">
                        {t("error.oauth_discovery_failed")}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                )}
              </div>
            ) : (
              /* Login Form */
              <div className="space-y-5">
                {/* Sigil: XPR wallet login — the primary, intended path.
                    No email, no password — your wallet signature is your
                    credential. The form below still works as a fallback
                    (e.g. operator/admin accounts), per the project's
                    "always ship a manual fallback" rule, not because XPR
                    login is optional for normal users. */}
                <div className="space-y-3">
                  <Button
                    type="button"
                    className="w-full h-11 font-medium text-[15px] bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
                    onClick={handleXprLogin}
                    disabled={xprLoading}
                  >
                    {xprLoading ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {xprStatus || "Signing in…"}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        Sign in with XPR Wallet
                      </div>
                    )}
                  </Button>
                  {xprError && (
                    <div className="p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
                      <p className="text-sm text-destructive leading-relaxed">{xprError}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {isAddAccountMode && (
              <div className="mt-4">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full h-10 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => router.push('/')}
                >
                  {t("cancel")}
                </Button>
              </div>
            )}

            {/* Demo Mode Button */}
            {demoMode && !isAddAccountMode && (
              <div className="mt-4 pt-4 border-t border-border/40">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11 font-medium text-[15px] rounded-xl border-border/60 hover:bg-muted/50"
                  onClick={handleDemoLogin}
                  disabled={demoLoading || isLoading}
                >
                  {demoLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("demo_launching")}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Play className="w-4 h-4" />
                      {t("try_demo")}
                    </div>
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground mt-2">
                  {t("demo_description")}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Company name & links - below card */}
        <div className="mt-6 flex flex-col items-center gap-2">
          {loginCompanyName && (
            <p className="text-center text-xs text-muted-foreground/60 font-medium">
              {loginCompanyName}
            </p>
          )}
          {(loginImprintUrl || loginPrivacyPolicyUrl || loginWebsiteUrl) && (
            <div className="flex items-center gap-3 flex-wrap justify-center">
              {loginWebsiteUrl && (
                <a
                  href={loginWebsiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {t("website")}
                </a>
              )}
              {loginImprintUrl && (
                <a
                  href={loginImprintUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {t("imprint")}
                </a>
              )}
              {loginPrivacyPolicyUrl && (
                <a
                  href={loginPrivacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {t("privacy_policy")}
                </a>
              )}
            </div>
          )}
          <VersionBadge />
        </div>
      </div>
    </div>
  );
}
