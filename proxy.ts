import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { getEnabledPluginFrameOrigins } from "./lib/admin/csp-frame-origins";
import { configManager } from "./lib/admin/config-manager";
import { detectSetupState } from "./lib/setup/state";

const intlMiddleware = createIntlMiddleware(routing);

// Next 16's Proxy always runs on Node.js runtime and route-segment config
// (e.g. `export const config = { matcher }`) is no longer allowed in the
// proxy file. We replicate the previous matcher inline by short-circuiting
// requests for API routes, Next internals and static assets.
const PROXY_SKIP_PATTERN = /^\/(?:api|_next)(?:\/|$)|\.[^/]+$/;

function isSetupPath(pathname: string): boolean {
  return (
    pathname === "/setup" ||
    pathname.startsWith("/setup/") ||
    pathname.startsWith("/api/setup")
  );
}

const MAINTENANCE_BYPASS_COOKIE = "maintenance_bypass";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Set (not returned-with-early-exit) further down, once the real page
  // response exists — see the note at the maintenance-mode block below for
  // why this can't just return NextResponse.next() immediately.
  let pendingBypassCookieValue: string | null = null;

  // Maintenance mode: MAINTENANCE_MODE=true blocks the whole webmail app
  // for the public while fixes are in progress. Only gates THIS Next.js
  // app (webmail.mailsigil.pro) — JMAP/IMAP/SMTP (Stalwart, a separate
  // container) and the auth service (a separate systemd service, separate
  // domain) are untouched, so mail delivery and any agent pipeline keep
  // working the whole time this is on. Takes precedence over everything
  // else (setup wizard included) — deliberately checked before any other
  // routing decision.
  if (process.env.MAINTENANCE_MODE === "true") {
    const bypassToken = process.env.MAINTENANCE_BYPASS_TOKEN;
    const hasValidCookie = bypassToken && request.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value === bypassToken;
    const queryToken = request.nextUrl.searchParams.get("maintenance_bypass");
    const hasValidQueryToken = bypassToken && queryToken === bypassToken;
    const bypassed = hasValidCookie || hasValidQueryToken;

    if (!bypassed && pathname !== "/api/health") {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(
          JSON.stringify({ error: "maintenance", message: "Down for maintenance — back shortly." }),
          { status: 503, headers: { "content-type": "application/json", "Retry-After": "1800" } },
        );
      }
      return new NextResponse(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Down for maintenance</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;` +
        `justify-content:center;min-height:100vh;margin:0;background:#0D1B5E;color:#fff;text-align:center;padding:24px}` +
        `div{max-width:420px}h1{font-size:1.4rem;margin-bottom:.5rem}p{opacity:.8;line-height:1.5}</style></head>` +
        `<body><div><h1>Down for maintenance</h1><p>Mail Sigil's webmail is temporarily offline while we ship a fix. ` +
        `Mail is still being delivered normally — nothing is lost. Back shortly.</p></div></body></html>`,
        { status: 503, headers: { "content-type": "text/html; charset=utf-8", "Retry-After": "1800" } },
      );
    }

    if (hasValidQueryToken && !hasValidCookie) {
      // Promote a valid one-time query token to a cookie so the rest of the
      // visit (and future visits) don't need the token in every URL. Don't
      // return here — an early NextResponse.next() skips the intl
      // middleware's locale-prefix rewrite below (e.g. "/" -> "/en"),
      // which 404s since nothing else resolves the bare route. Set the
      // cookie later on the SAME response the rest of this function
      // produces, once the normal pipeline has actually run.
      pendingBypassCookieValue = bypassToken!;
    }
  }

  // Resolve setup state before deciding what to skip. The first call after
  // boot triggers the config load; subsequent calls are in-memory.
  await configManager.ensureLoaded();
  const setupState = detectSetupState();

  if (setupState === "bootstrap") {
    // Wizard active. Redirect HTML pages to /setup; let asset/internal
    // requests through so the wizard UI can render. Block non-setup APIs
    // with a 503 so cached SPA code doesn't silently call them.
    const allowed =
      isSetupPath(pathname) ||
      pathname === "/api/health" ||
      pathname.startsWith("/_next/") ||
      pathname.startsWith("/branding/") ||
      // Public read endpoint - serves wizard-uploaded branding assets so
      // image previews work during the wizard. No auth on the GET route.
      pathname.startsWith("/api/admin/branding/") ||
      // Mailbox creation confirm page — publicly accessible (the user may not
      // have a mailbox yet; that's the whole point of the flow).
      /\/confirm$/.test(pathname) ||
      /\.[^/]+$/.test(pathname);

    if (!allowed) {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(
          JSON.stringify({ error: "setup_required", message: "Initial setup has not completed." }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/setup";
      url.search = request.nextUrl.search;
      return NextResponse.redirect(url);
    }
  } else if (isSetupPath(pathname)) {
    // Configured / env-managed: wizard is no longer reachable.
    //  - HTML /setup pages → redirect to admin login so users who reload
    //    the URL after setup don't see a dead "Not Found" page.
    //  - /api/setup/* → 404 (no reason to expose these endpoints).
    if (pathname.startsWith("/api/setup")) {
      return new NextResponse("Not Found", { status: 404 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (PROXY_SKIP_PATTERN.test(pathname)) {
    return NextResponse.next();
  }

  const nonce = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === "development";
  // The plugin-sandbox iframe document needs `'unsafe-eval'` to run plugin
  // bundles via `new Function`. It is null-origin (sandbox="allow-scripts"),
  // so the relaxation is scoped strictly to that document and never reaches
  // the main app, plus it must be embeddable from `'self'`.
  const isSandboxPath = pathname === "/plugin-sandbox" || pathname.startsWith("/plugin-sandbox/");

  const scriptSrc = isSandboxPath
    ? `'self' 'nonce-${nonce}' 'unsafe-eval'`
    : isDev
    ? `'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}'`;

  // Sigil: `wss:` is needed for the XPR wallet's mobile/desktop login relay
  // (cb.anchor.link websocket). Per CSP spec `https:` should cover `wss:`,
  // but browser behavior is inconsistent — be explicit.
  const connectSrc = isDev ? `'self' http: https: ws: wss:` : `'self' https: wss:`;

  const frameAncestors = isSandboxPath
    ? `'self'`
    : process.env.ALLOWED_FRAME_ANCESTORS?.trim() || "'none'";

  // Plugins may declare iframe origins they need (e.g. for embedded video).
  // Each origin is validated at install time and re-validated here.
  const pluginFrameOrigins = await getEnabledPluginFrameOrigins();
  // Sigil: the XPR wallet's mobile/desktop login flow frames the WebAuth
  // wallet UI and the anchor-link relay. Without these, only the
  // browser-extension wallet works (it bypasses the page's network stack,
  // which is why it was the only option that worked before this).
  const walletFrameOrigins = [
    "https://webauth.com",
    "https://*.webauth.com",
    "https://cb.anchor.link",
  ];
  const allFrameOrigins = [...walletFrameOrigins, ...pluginFrameOrigins];
  const frameSrc = `frame-src 'self' blob: ${allFrameOrigins.join(" ")}`;

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self'`,
    `connect-src ${connectSrc}`,
    frameSrc,
    `object-src 'self' blob:`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors ${frameAncestors}`,
    `media-src 'self' blob:`,
  ].join("; ");

  // Skip intl middleware for routes outside the localized app tree.
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
  const isProtocolRoute = pathname === '/protocol' || pathname.startsWith('/protocol/');
  const isSetupRoute = pathname === '/setup' || pathname.startsWith('/setup/');
  // The plugin sandbox lives in its own root layout under app/(sandbox)/ and
  // is not part of the localized tree. Letting next-intl rewrite the path to
  // /en/plugin-sandbox 404s, which kills the iframe and disables every plugin.
  const isSandboxRoute = isSandboxPath;

  // When localePrefix is 'always', paths that already have a locale prefix
  // (e.g. /en/settings) should not be re-processed by the intl middleware -
  // doing so can trigger rewrite loops when combined with a proxy basePath.
  const locales = routing.locales as readonly string[];
  const hasLocalePrefix = locales.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`)
  );

  let intlResponse: ReturnType<typeof intlMiddleware> | null = null;
  if (!isAdminRoute && !isProtocolRoute && !isSetupRoute && !isSandboxRoute && !hasLocalePrefix) {
    try {
      intlResponse = intlMiddleware(request);
    } catch (error) {
      console.error('Locale middleware error:', error);
    }
  }
  const response = intlResponse ?? NextResponse.next();

  const existing = response.headers.get("x-middleware-override-headers");
  // Expose the nonce AND the request pathname to server components as request
  // headers. The root (main)/layout renders <html> ABOVE the [locale] segment,
  // so getLocale() can't resolve the active locale there and falls back to the
  // default - emitting <html lang="en"> on e.g. /de pages, which makes browsers
  // offer to "translate this page". The layout reads x-pathname to recover it.
  const overrides = [existing, "x-nonce", "x-pathname"].filter(Boolean).join(",");
  response.headers.set("x-middleware-override-headers", overrides);
  response.headers.set("x-middleware-request-x-nonce", nonce);
  response.headers.set("x-middleware-request-x-pathname", pathname);

  response.headers.set("X-Content-Type-Options", "nosniff");

  // X-Frame-Options only supports DENY/SAMEORIGIN. When frame-ancestors
  // specifies explicit origins, we rely solely on the CSP header.
  if (frameAncestors === "'none'") {
    response.headers.set("X-Frame-Options", "DENY");
  }

  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "0");
  // Sigil: publickey-credentials-* delegated to webauth.com so its biometric
  // (WebAuthn/passkey) login works when embedded — the rest stay denied.
  response.headers.set(
    "Permissions-Policy",
    'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self "https://webauth.com"), publickey-credentials-create=(self "https://webauth.com")'
  );
  response.headers.set("Content-Security-Policy", csp);

  if (pendingBypassCookieValue) {
    response.cookies.set(MAINTENANCE_BYPASS_COOKIE, pendingBypassCookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
  }

  return response;
}
