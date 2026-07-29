// Repro for Gabriel's "the new account creation guided tour is still broken".
//
// Does a REAL testnet login (nonce -> sign sigillogin::login, never broadcast ->
// verify -> mint app password), logs into the live testnet webmail with that
// app password, then restarts the tour from Settings > Appearance and records
// every [Tour] console line the overlay emits. The overlay logs each step's
// target and whether the element was FOUND / NOT found / SKIPPED, so this shows
// exactly which step stalls instead of guessing.
//
// Usage: node tour-repro.mjs [actor] [--width=390 --height=844]  (mobile size)
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const ACTOR = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "felixpaw";
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.split("=")[1]) : d;
};
const WIDTH = arg("width", 1440);
const HEIGHT = arg("height", 900);

const AUTH = "https://testnet-auth.mailsigil.pro";
const SITE = "https://testnet.mailsigil.pro";
const RPC = "https://tn1.protonnz.com";

const wallets = JSON.parse(readFileSync(process.env.HOME + "/.xpr-testnet/wallets.json", "utf-8"));
const key = wallets.accounts[ACTOR]?.private_key;
if (!key) throw new Error(`no testnet key on file for ${ACTOR}`);

// --- 1. wallet login against the testnet auth service -----------------------
const nonceRes = await fetch(`${AUTH}/api/auth/nonce`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ actor: ACTOR }),
}).then((r) => r.json());
const { challengeId, nonce } = nonceRes;
if (!nonce) throw new Error(`nonce failed: ${JSON.stringify(nonceRes)}`);

const rpc = new JsonRpc([RPC], { fetch });
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([key]) });
const signed = await api.transact(
  {
    actions: [
      {
        account: "sigillogin",
        name: "login",
        authorization: [{ actor: ACTOR, permission: "active" }],
        data: { account: ACTOR, nonce },
      },
    ],
  },
  { blocksBehind: 3, expireSeconds: 120, broadcast: false, sign: true },
);

const verify = await fetch(`${AUTH}/api/auth/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    challengeId,
    actor: ACTOR,
    permission: "active",
    signatures: signed.signatures,
    serializedTransaction: Buffer.from(signed.serializedTransaction).toString("hex"),
  }),
}).then((r) => r.json());
if (!verify.accessToken) throw new Error(`verify failed: ${JSON.stringify(verify)}`);
console.log(`[login] ok — mailbox created=${verify.mailbox?.created}`);

// NOTE: do NOT mint an app password here. The page mints its own with the
// description "Bulwark webmail session", which the auth service caches and
// reuses forever; any OTHER description burns one of the account's 5 slots
// per run and eventually locks the account out of webmail login entirely.

// --- 2. drive the webmail ---------------------------------------------------
const browser = await chromium.launch({
  executablePath:
    process.env.HOME +
    "/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

const tourLog = [];
page.on("console", (m) => {
  const txt = m.text();
  if (txt.includes("[Tour]")) tourLog.push(txt);
  else if (m.type() === "error") tourLog.push(`ERROR: ${txt}`);
});
page.on("pageerror", (e) => tourLog.push(`PAGEERROR: ${e.message}`));

// This build has no password form (wallet-only sign-in), and a headless browser
// can't drive the WebAuth popup. So enter through the cross-network handoff
// receiver — a real, supported code path: it revalidates the token via
// /api/auth/refresh and then runs the identical mailbox finish (app-password
// mint -> JMAP) the wallet flow would have run.
const frag = encodeURIComponent(JSON.stringify({ t: verify.accessToken }));
await page.goto(`${SITE}/en/login#sigil-xnet=${frag}`, { waitUntil: "domcontentloaded", timeout: 60000 });
try {
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45000 });
} catch {
  console.log("[webmail] still on the login page — dumping what it says:");
  console.log(await page.evaluate(() => {
    const txt = (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return { lines: txt.slice(0, 25), url: location.href };
  }));
  console.log("console so far:", tourLog.slice(0, 12));
  await page.screenshot({ path: "tour-repro-login-stuck.png" });
  await browser.close();
  process.exit(1);
}
console.log(`[webmail] logged in, at ${page.url()}`);
await page.waitForTimeout(4000);

// Restart the tour from Settings > Appearance (same entry point a user has).
await page.goto(`${SITE}/en/settings`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000);
// On narrow viewports Settings is a two-level list, so click the section by
// role (the text match alone lands on the wrong node there).
const appearance = page.getByRole("button", { name: /^appearance$/i }).first();
if (await appearance.isVisible().catch(() => false)) {
  await appearance.click();
  await page.waitForTimeout(2000);
}
const restart = page.getByRole("button", { name: /tour|onboarding|walkthrough/i }).first();
if (!(await restart.isVisible().catch(() => false))) {
  console.log("[tour] could not find the restart-tour button; dumping buttons:");
  console.log(await page.evaluate(() => Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim()).filter(Boolean)));
} else {
  await restart.click();
  console.log("[tour] restart clicked — watching for 60s");
  // Walk the tour: click Next whenever the tooltip offers it, so we see how far
  // it gets on its own rather than only the first stall.
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(2500);
    const next = page.getByRole("button", { name: /next|got it|finish|done/i }).first();
    if (await next.isVisible().catch(() => false)) await next.click().catch(() => {});
  }
}

console.log("\n=== TOUR CONSOLE TRACE ===");
for (const l of tourLog) console.log(l);
await page.screenshot({ path: "tour-repro.png", fullPage: false });
console.log("\nscreenshot: tour-repro.png");
await browser.close();
