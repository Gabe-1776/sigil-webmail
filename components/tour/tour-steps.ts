export interface TourStep {
  id: string;
  target: string;
  titleKey: string;
  descriptionKey: string;
  placement: "top" | "bottom" | "left" | "right";
  interactive?: boolean;
  spotlight?: "rect" | "circle";
  page?: string;
  demoOnly?: boolean;
  beforeAction?: () => void;
}

export const BASE_TOUR_STEPS: TourStep[] = [
  {
    id: "sidebar",
    target: '[data-tour="sidebar"]',
    titleKey: "tour.sidebar_title",
    descriptionKey: "tour.sidebar_desc",
    placement: "right",
  },
  {
    id: "compose",
    target: '[data-tour="compose-button"]',
    titleKey: "tour.compose_title",
    descriptionKey: "tour.compose_desc",
    placement: "right",
    interactive: true,
  },
  {
    id: "search",
    target: '[data-tour="search-input"]',
    titleKey: "tour.search_title",
    descriptionKey: "tour.search_desc",
    placement: "bottom",
    interactive: true,
  },
  {
    id: "email-list",
    target: '[data-tour="email-list"]',
    titleKey: "tour.email_list_title",
    descriptionKey: "tour.email_list_desc",
    placement: "right",
  },
  // REMOVED 2026-07-25: "email-viewer" and "keywords".
  //
  // Both were impossible to satisfy on a freshly created Sigil account and
  // broke the tour for every new tester. "email-viewer" ran a beforeAction
  // that clicked the "Welcome to Bulwark Mail" demo email (or any first row)
  // to force the viewer open — a brand-new mailbox has no mail, so nothing
  // was clicked and [data-tour="email-viewer"] never appeared. "keywords"
  // targeted [data-tour="keyword-tags"], which sidebar.tsx only renders when
  // emailKeywords.length > 0 — also never true on a new account.
  //
  // A missing target costs the 5-second poll in tour-overlay.tsx before the
  // step is auto-skipped, so the two of them put ~10 seconds of dimmed screen
  // with no tooltip in front of every new user, who reasonably read it as
  // frozen and clicked the overlay (which ends the tour). They were also the
  // only two steps that reached into the user's actual mail to stage
  // themselves. Onboarding for an empty mailbox is the welcome email's job
  // now (auth/src/welcome-email.ts), not a tour step's.
  {
    id: "nav-calendar",
    target: '[data-tour="nav-calendar"]',
    titleKey: "tour.calendar_title",
    descriptionKey: "tour.calendar_desc",
    placement: "right",
  },
  {
    id: "nav-contacts",
    target: '[data-tour="nav-contacts"]',
    titleKey: "tour.contacts_title",
    descriptionKey: "tour.contacts_desc",
    placement: "right",
  },
  {
    id: "nav-settings",
    target: '[data-tour="nav-settings"]',
    titleKey: "tour.settings_title",
    descriptionKey: "tour.settings_desc",
    placement: "right",
  },
  {
    id: "shortcuts",
    target: '[data-tour="nav-shortcuts"]',
    titleKey: "tour.shortcuts_title",
    descriptionKey: "tour.shortcuts_desc",
    placement: "right",
    interactive: true,
  },
];

export const DEMO_TOUR_STEPS: TourStep[] = [
  {
    id: "compose-open",
    target: '[data-tour="composer"]',
    titleKey: "tour.compose_open_title",
    descriptionKey: "tour.compose_open_desc",
    placement: "left",
    demoOnly: true,
    beforeAction: () => {
      // Click the compose button to open the composer
      const btn = document.querySelector('[data-tour="compose-button"]') as HTMLElement | null;
      if (btn) btn.click();
    },
  },
  {
    id: "calendar-view",
    target: '[data-tour="calendar-view"]',
    titleKey: "tour.calendar_view_title",
    descriptionKey: "tour.calendar_view_desc",
    placement: "bottom",
    page: "/calendar",
    demoOnly: true,
  },
  {
    id: "create-event",
    target: '[data-tour="create-event-button"]',
    titleKey: "tour.create_event_title",
    descriptionKey: "tour.create_event_desc",
    placement: "bottom",
    page: "/calendar",
    interactive: true,
    demoOnly: true,
  },
  {
    id: "event-modal",
    target: '[data-tour="event-modal"]',
    titleKey: "tour.event_modal_title",
    descriptionKey: "tour.event_modal_desc",
    placement: "left",
    page: "/calendar",
    interactive: true,
    demoOnly: true,
    beforeAction: () => {
      // Click the create event button to open the modal
      const btn = document.querySelector('[data-tour="create-event-button"]') as HTMLElement | null;
      if (btn) btn.click();
    },
  },
  {
    id: "contacts-list",
    target: '[data-tour="contacts-list"]',
    titleKey: "tour.contacts_list_title",
    descriptionKey: "tour.contacts_list_desc",
    placement: "right",
    page: "/contacts",
    demoOnly: true,
  },
  {
    id: "settings-tabs",
    target: '[data-tour="settings-tabs"]',
    titleKey: "tour.settings_tabs_title",
    descriptionKey: "tour.settings_tabs_desc",
    placement: "right",
    page: "/settings",
    demoOnly: true,
  },
  {
    id: "nav-files",
    target: '[data-tour="nav-files"]',
    titleKey: "tour.files_title",
    descriptionKey: "tour.files_desc",
    placement: "right",
    demoOnly: true,
  },
  {
    id: "demo-banner",
    target: '[data-tour="demo-banner"]',
    titleKey: "tour.demo_banner_title",
    descriptionKey: "tour.demo_banner_desc",
    placement: "bottom",
    page: "/",
    demoOnly: true,
  },
  {
    id: "quota",
    target: '[data-tour="storage-quota"]',
    titleKey: "tour.quota_title",
    descriptionKey: "tour.quota_desc",
    placement: "right",
    demoOnly: true,
  },
];

export function getTourSteps(options: {
  isDemoMode: boolean;
  supportsCalendar: boolean;
  supportsContacts: boolean;
  supportsWebDAV: boolean;
  /** Below `lg` the app renders the horizontal bottom bar instead of the
   *  vertical rail (`isMobile || isTablet` in page.tsx). Different chrome =
   *  different available targets. */
  isCompactNav: boolean;
}): TourStep[] {
  let steps = [...BASE_TOUR_STEPS];

  // Steps with no counterpart in the compact layout (2026-07-28). Both existed
  // in the DOM or not at all in ways that broke the tour on a phone:
  //
  // - "sidebar" is an off-canvas drawer there. querySelector FINDS it, so the
  //   overlay happily shows a spotlight — at x=-288, entirely off screen.
  //   Worse than skipping it: the user sees a dimmed page and no tooltip.
  // - "shortcuts" targets the keyboard-shortcuts button, which the horizontal
  //   bar deliberately doesn't render. Keyboard shortcuts on a phone aren't a
  //   thing, so this is correct chrome — the tour just has to agree.
  //
  // The remaining nav steps DO work now: the horizontal bar carries the same
  // data-tour ids as the vertical rail (see navigation-rail.tsx).
  if (options.isCompactNav) {
    steps = steps.filter((s) => s.id !== "sidebar" && s.id !== "shortcuts");
  }

  // A step whose feature is switched off has no nav icon to point at, and a
  // step with no target burns the overlay's 5-second poll before skipping
  // itself. Every conditional nav step must be filtered here on the SAME
  // condition navigation-rail.tsx uses to hide the icon.
  if (!options.supportsCalendar) {
    steps = steps.filter((s) => s.id !== "nav-calendar");
  }

  if (!options.supportsContacts) {
    steps = steps.filter((s) => s.id !== "nav-contacts");
  }

  if (options.isDemoMode) {
    const demoSteps = DEMO_TOUR_STEPS.filter((s) => {
      if (s.id === "nav-files" && !options.supportsWebDAV) return false;
      if ((s.id === "calendar-view" || s.id === "create-event" || s.id === "event-modal") && !options.supportsCalendar) return false;
      return true;
    });
    steps = [...steps, ...demoSteps];
  }

  return steps;
}
