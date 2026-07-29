// Client-side network config — the browser analog of auth/src/network-config.ts.
// The webmail BUNDLES BOTH networks and the login page lets the user pick one
// ("Sign in · Mainnet" / "Sign in · Testnet"). The chosen network is stored for
// the session and drives every subsequent chain + auth-service call; switching
// networks requires a full logout (there is no live network switch).
//
// Each network's two backends are completely separate systems — a mainnet auth
// service and a testnet auth service that never connect. The login choice just
// routes to the correct one. See BLUEPRINT-testnet-mainnet-parity.md.
//
// This is the ONLY frontend file allowed to contain raw chain IDs / the mail
// contract account; the parity check greps for those literals everywhere else.

export type XprNetworkName = "mainnet" | "testnet";

export interface XprNetwork {
  name: XprNetworkName;
  label: string;
  chainId: string;
  endpoints: string[];
  /** The `requestAccount` the WebAuth transport connects through / the mailsigil
   *  service+contract account on this network. */
  mailContract: string;
  /** The sigillogin gate-contract account signed against at login. Separate
   *  from mailContract; may be deployed under a different name per network. */
  loginContract: string;
  /** Base URL of THIS network's auth service (the two are separate systems). */
  authUrl: string;
  /** The webmail site that actually serves this network. Each deployment has a
   *  SINGLE mail server (JMAP_SERVER_URL is one per-deployment value, and the
   *  mainnet/testnet Stalwarts are separate boxes), so only this site can open
   *  a mailbox session for this network. The login page's cross-network
   *  handoff redirects here AFTER the wallet verifies — carrying the fresh
   *  access token in the URL fragment — and this site finishes the identical
   *  mailbox login (app-password mint → JMAP) locally. */
  siteUrl: string;
}

const AUTH_URL_MAINNET =
  process.env.NEXT_PUBLIC_XPR_AUTH_URL_MAINNET ||
  process.env.NEXT_PUBLIC_XPR_AUTH_SERVICE_URL || // legacy single-var default
  "https://auth.mailsigil.pro";

const AUTH_URL_TESTNET =
  process.env.NEXT_PUBLIC_XPR_AUTH_URL_TESTNET ||
  "https://testnet-auth.mailsigil.pro";

const SITE_URL_MAINNET =
  process.env.NEXT_PUBLIC_XPR_SITE_URL_MAINNET || "https://webmail.mailsigil.pro";

const SITE_URL_TESTNET =
  process.env.NEXT_PUBLIC_XPR_SITE_URL_TESTNET || "https://testnet.mailsigil.pro";

export const XPR_NETWORKS: Record<XprNetworkName, XprNetwork> = {
  mainnet: {
    name: "mainnet",
    label: "Mainnet",
    chainId: "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0",
    endpoints: ["https://proton.eosusa.io", "https://proton.protonuk.io"],
    mailContract: "mailsigil",
    loginContract: "sigillogin",
    authUrl: AUTH_URL_MAINNET,
    siteUrl: SITE_URL_MAINNET,
  },
  testnet: {
    name: "testnet",
    label: "Testnet",
    chainId: "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd",
    endpoints: ["https://test.proton.eosusa.io", "https://testnet-api.xprcore.com"],
    mailContract: "mailsigil",
    loginContract: "sigillogin",
    authUrl: AUTH_URL_TESTNET,
    siteUrl: SITE_URL_TESTNET,
  },
};

// Per-network maintenance. Comma-separated network names whose sign-in is
// paused, e.g. NEXT_PUBLIC_MAINTENANCE_NETWORKS=mainnet. The toggle still
// offers the network and still switches to it — only login/account creation
// is blocked, with a notice explaining why and pointing at the other network.
//
// This exists instead of the app-wide MAINTENANCE_MODE gate in proxy.ts, which
// 503s the whole site: that also kills the login page's network toggle, so a
// visitor can't reach the healthy network either. Client-side this is UI only;
// the enforcing gate is LOGIN_MAINTENANCE in that network's own auth service
// (auth/src/server.ts), which is what actually refuses to mint a session.
const MAINTENANCE_NETWORKS = (process.env.NEXT_PUBLIC_MAINTENANCE_NETWORKS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isNetworkInMaintenance(name: XprNetworkName): boolean {
  return MAINTENANCE_NETWORKS.includes(name);
}

// Per-deployment default: the testnet stack sets NEXT_PUBLIC_DEFAULT_NETWORK=testnet
// so its site defaults to testnet (login toggle + session network), while mainnet
// leaves it unset and defaults to mainnet. Both configs are still bundled, so the
// toggle can cross over either way.
export const DEFAULT_NETWORK: XprNetworkName =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === "testnet" ? "testnet" : "mainnet";

export function getNetwork(name: XprNetworkName | string | null | undefined): XprNetwork {
  return name === "testnet" ? XPR_NETWORKS.testnet : XPR_NETWORKS.mainnet;
}

const NETWORK_STORAGE_KEY = "sigil_network";

/** The network the current webmail session logged in on. Session-global;
 *  set at login, read by grants/confirm/refresh. Before any login has ever
 *  happened on this browser (no stored key yet), falls back to this
 *  deployment's DEFAULT_NETWORK rather than unconditionally mainnet — a
 *  fresh visit to a testnet build (e.g. a shared-mailbox grant link opened
 *  by someone who's never logged in before) must resolve to testnet, not
 *  leak to mainnet. `getNetwork(null)` alone would always return mainnet
 *  here, which is only correct on a mainnet deployment. */
export function getSessionNetwork(): XprNetwork {
  try {
    const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
    return stored ? getNetwork(stored) : XPR_NETWORKS[DEFAULT_NETWORK];
  } catch {
    return XPR_NETWORKS[DEFAULT_NETWORK];
  }
}

export function setSessionNetwork(name: XprNetworkName): void {
  try {
    localStorage.setItem(NETWORK_STORAGE_KEY, name);
  } catch {
    /* storage unavailable — falls back to mainnet default on read */
  }
}

export function clearSessionNetwork(): void {
  try {
    localStorage.removeItem(NETWORK_STORAGE_KEY);
  } catch {
    /* noop */
  }
}
