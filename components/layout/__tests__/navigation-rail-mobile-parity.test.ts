// The mobile nav bar must not silently miss what the desktop rail gained.
//
// navigation-rail.tsx renders two completely separate trees: an early return
// for orientation === "horizontal" (the phone bottom bar) and the vertical rail
// below it. Anything added to the rail reaches the desktop only, and the gap is
// invisible unless someone opens the app on a phone.
//
// This has now bitten twice:
//   - the guided tour was dead on mobile because the horizontal branch had no
//     data-tour attributes (2026-07-29)
//   - storage usage and its percentage were missing entirely on mobile, so the
//     only way to see them was Settings -> Account (Gabriel, 2026-07-31:
//     "doesn't show data usage in mobile version, doesn't show the percentage")
//
// Both were one-line omissions in the branch nobody looks at.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/layout/navigation-rail.tsx'), 'utf8');

/** The horizontal early-return block, i.e. everything the phone actually renders. */
function horizontalBranch(): string {
  const start = src.indexOf('if (orientation === "horizontal")');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  }', src.indexOf('</nav>', start));
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('navigation rail: mobile parity', () => {
  it('renders the storage quota indicator on mobile', () => {
    expect(horizontalBranch()).toContain('StorageQuotaCircle');
  });

  it('opens the storage popover upward on the bottom bar', () => {
    // Defaulting to "right" here would push the popover off the side of a
    // phone screen, which looks identical to "the feature is missing".
    expect(horizontalBranch()).toMatch(/placement="top"/);
  });

  it('quota values are computed before the horizontal branch returns', () => {
    // If these stay below the early return they are out of scope for the
    // mobile tree, which is a build error rather than a silent gap — but only
    // once something in that branch actually uses them.
    const declIdx = src.indexOf('const showQuota =');
    const branchIdx = src.indexOf('if (orientation === "horizontal")');
    expect(declIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(branchIdx);
  });

  it('keeps nav items tour-targetable on mobile', () => {
    // The earlier regression: no data-tour attributes in this branch meant the
    // onboarding tour had nothing to anchor to and silently did nothing.
    const branch = horizontalBranch();
    expect(branch).toMatch(/data-tour=\{`nav-\$\{item\.id\}`\}/);
    expect(branch).toContain('data-tour="nav-settings"');
  });
});
