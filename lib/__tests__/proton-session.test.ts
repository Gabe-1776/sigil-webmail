import { describe, it, expect, beforeEach } from "vitest";
import { purgeProtonSdkStorage, isWalletCancel } from "../proton-session";

// Both behaviours here are load-bearing for sign-in UX and were regressions
// reported by Gabriel on 2026-07-28:
//   "i log out and try logging in and it pushes a transaction nonce.
//    i cancel it, then i try logging in with scan and its 2 transactions again"
// — logout left the SDK's wallet session behind (so the next sign-in silently
// restored it and jumped straight to a signature request), and a cancellation
// was being treated as a dead session (so declining re-prompted instead of
// stopping).

describe("purgeProtonSdkStorage", () => {
  beforeEach(() => localStorage.clear());

  it("removes proton SDK keys and leaves everything else alone", () => {
    localStorage.setItem("proton-storage-session", "x");
    localStorage.setItem("proton-link-abc", "y");
    localStorage.setItem("auth-storage", "keep");
    localStorage.setItem("sigil_network", "testnet");

    purgeProtonSdkStorage();

    expect(localStorage.getItem("proton-storage-session")).toBeNull();
    expect(localStorage.getItem("proton-link-abc")).toBeNull();
    expect(localStorage.getItem("auth-storage")).toBe("keep");
    expect(localStorage.getItem("sigil_network")).toBe("testnet");
  });

  it("removes EVERY matching key (index-shift safety)", () => {
    // Removing while iterating by index skips entries — the reason this
    // collects first and deletes after.
    for (let i = 0; i < 10; i++) localStorage.setItem(`proton-link-${i}`, "x");
    purgeProtonSdkStorage();
    const left = Object.keys(localStorage).filter((k) => k.startsWith("proton-"));
    expect(left).toEqual([]);
  });

  it("does not throw when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError"); },
    });
    expect(() => purgeProtonSdkStorage()).not.toThrow();
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  });
});

describe("isWalletCancel", () => {
  it("recognises the SDK's E_CANCEL code", () => {
    // Shape of @proton/link's CancelError.
    const err = Object.assign(new Error("Request cancelled (user)"), { code: "E_CANCEL" });
    expect(isWalletCancel(err)).toBe(true);
  });

  it("recognises cancellation by message, both spellings", () => {
    expect(isWalletCancel(new Error("Wallet connection was cancelled"))).toBe(true);
    expect(isWalletCancel(new Error("User canceled the request"))).toBe(true);
  });

  it("does NOT treat a stale/dead session as a cancellation", () => {
    // This one MUST still reach the reconnect recovery path.
    expect(isWalletCancel(new Error("Restored wallet session did not respond — reconnecting…"))).toBe(false);
    expect(isWalletCancel(Object.assign(new Error("no route"), { code: "E_DELIVERY" }))).toBe(false);
    expect(isWalletCancel(Object.assign(new Error("timed out"), { code: "E_TIMEOUT" }))).toBe(false);
  });

  it("survives non-Error values", () => {
    expect(isWalletCancel(null)).toBe(false);
    expect(isWalletCancel(undefined)).toBe(false);
    expect(isWalletCancel("cancelled")).toBe(true);
  });
});
