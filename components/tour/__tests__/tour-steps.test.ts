import { describe, it, expect } from "vitest";
import { getTourSteps, BASE_TOUR_STEPS } from "../tour-steps";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The onboarding tour points at `[data-tour="..."]` selectors rendered by other
// components. Nothing type-checks that relationship, so when the nav rail's
// compact (bottom-bar) branch shipped without those attributes, every nav step
// polled for 5 seconds and self-skipped — the tour "died after step 4" on a
// phone while working perfectly on desktop. These tests pin the contract.

const NAV_RAIL = readFileSync(
  join(__dirname, "../../layout/navigation-rail.tsx"),
  "utf-8",
);

const base = {
  isDemoMode: false,
  supportsCalendar: true,
  supportsContacts: true,
  supportsWebDAV: true,
};

describe("getTourSteps", () => {
  it("drops the steps that have no target in the compact nav layout", () => {
    const ids = getTourSteps({ ...base, isCompactNav: true }).map((s) => s.id);
    // The sidebar is off-canvas below `lg` (querySelector finds it at a
    // negative x, so the overlay shows a spotlight nobody can see), and the
    // bottom bar renders no keyboard-shortcuts button at all.
    expect(ids).not.toContain("sidebar");
    expect(ids).not.toContain("shortcuts");
    // …but the nav steps must survive: the bottom bar does carry these.
    expect(ids).toContain("nav-calendar");
    expect(ids).toContain("nav-contacts");
    expect(ids).toContain("nav-settings");
  });

  it("keeps the full set on the desktop rail", () => {
    const ids = getTourSteps({ ...base, isCompactNav: false }).map((s) => s.id);
    expect(ids).toContain("sidebar");
    expect(ids).toContain("shortcuts");
  });

  it("drops nav steps whose feature is switched off", () => {
    const noCal = getTourSteps({ ...base, supportsCalendar: false, isCompactNav: false });
    expect(noCal.map((s) => s.id)).not.toContain("nav-calendar");
    const noContacts = getTourSteps({ ...base, supportsContacts: false, isCompactNav: false });
    expect(noContacts.map((s) => s.id)).not.toContain("nav-contacts");
  });

  it("every nav step it can emit on a phone has a data-tour attribute in the nav rail", () => {
    const compact = getTourSteps({ ...base, isCompactNav: true });
    const navSteps = compact.filter((s) => s.id.startsWith("nav-"));
    expect(navSteps.length).toBeGreaterThan(0);

    for (const step of navSteps) {
      const id = step.id.replace(/^nav-/, "");
      // Either a literal attribute (nav-settings) or the templated one the
      // items map emits (`data-tour={`nav-${item.id}`}`).
      const literal = NAV_RAIL.includes(`data-tour="${step.id}"`);
      const templated = NAV_RAIL.includes("data-tour={`nav-${item.id}`}");
      const isNavItem = NAV_RAIL.includes(`id: "${id}"`);
      expect(
        literal || (templated && isNavItem),
        `tour step "${step.id}" has no data-tour target in navigation-rail.tsx`,
      ).toBe(true);
    }
  });

  it("the compact bar carries data-tour on BOTH of its rendered link groups", () => {
    // Regression guard for the actual 2026-07-28 bug: the file has two
    // `visibleItems.map(...)` blocks (horizontal bar + vertical rail) and only
    // the vertical one was tagged. Count the templated attribute occurrences.
    const templated = NAV_RAIL.match(/data-tour=\{`nav-\$\{item\.id\}`\}/g) ?? [];
    const maps = NAV_RAIL.match(/visibleItems\.map\(/g) ?? [];
    expect(templated.length).toBe(maps.length);
  });

  it("BASE_TOUR_STEPS has no duplicate ids", () => {
    const ids = BASE_TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
