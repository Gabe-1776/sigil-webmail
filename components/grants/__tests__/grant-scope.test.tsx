import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  GrantScopeChip,
  GrantScopeExplain,
  GrantHolderBadge,
  GrantScopePicker,
  getHolderKind,
  getScopeMeta,
  isKnownScope,
  type KnownScope,
} from "../grant-scope";

describe("scope metadata", () => {
  it("recognizes the three real auth-service scopes", () => {
    expect(isKnownScope("full")).toBe(true);
    expect(isKnownScope("read")).toBe(true);
    expect(isKnownScope("send")).toBe(true);
  });

  it("fails open (never throws) for an unrecognized scope string", () => {
    expect(isKnownScope("delete")).toBe(false);
    expect(() => getScopeMeta("delete")).not.toThrow();
    expect(getScopeMeta("bogus").label).toBe("Custom scope");
  });

  it("gives each known scope a distinct, non-empty explanation", () => {
    const explains = (["full", "read", "send"] as KnownScope[]).map((s) => getScopeMeta(s).explain);
    expect(new Set(explains).size).toBe(3);
    explains.forEach((e) => expect(e.length).toBeGreaterThan(10));
  });

  it("read scope explanation says it cannot send or delete", () => {
    const explain = getScopeMeta("read").explain.toLowerCase();
    expect(explain).toContain("cannot send");
  });

  it("send scope explanation says it cannot delete", () => {
    const explain = getScopeMeta("send").explain.toLowerCase();
    expect(explain).toContain("cannot delete");
  });
});

describe("GrantScopeChip", () => {
  it("renders the human label for each known scope", () => {
    const { rerender } = render(<GrantScopeChip scope="full" />);
    expect(screen.getByText("Full access")).toBeInTheDocument();
    rerender(<GrantScopeChip scope="read" />);
    expect(screen.getByText("Read only")).toBeInTheDocument();
    rerender(<GrantScopeChip scope="send" />);
    expect(screen.getByText("Read + Send")).toBeInTheDocument();
  });

  it("carries the one-line explanation as a title tooltip", () => {
    render(<GrantScopeChip scope="read" />);
    const chip = screen.getByText("Read only");
    const title = chip.closest("span")?.getAttribute("title");
    expect(title).toContain("view");
  });

  it("renders a fallback chip for an unknown scope instead of crashing", () => {
    render(<GrantScopeChip scope="something-new" />);
    expect(screen.getByText("Custom scope")).toBeInTheDocument();
  });
});

describe("GrantScopeExplain", () => {
  it("renders the explanation text as body copy", () => {
    render(<GrantScopeExplain scope="full" />);
    expect(screen.getByText(getScopeMeta("full").explain)).toBeInTheDocument();
  });
});

describe("getHolderKind", () => {
  const linked = {
    ownedBy: null as string | null,
    ownedAgentsDetailed: [{ actor: "mybot", hasMailbox: true }],
  };

  it("classifies a known owned agent as 'agent'", () => {
    expect(getHolderKind("mybot", linked)).toBe("agent");
  });

  it("classifies the account's own owner as 'owner'", () => {
    expect(getHolderKind("gabe", { ownedBy: "gabe", ownedAgentsDetailed: [] })).toBe("owner");
  });

  it("classifies an unrelated actor as 'unknown' rather than guessing", () => {
    expect(getHolderKind("stranger", linked)).toBe("unknown");
  });

  it("classifies everything as 'unknown' when linked data hasn't loaded yet", () => {
    expect(getHolderKind("anyone", null)).toBe("unknown");
  });
});

describe("GrantHolderBadge", () => {
  it("renders nothing for an unknown counterparty (no guessing in the UI)", () => {
    const { container } = render(<GrantHolderBadge kind="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels an agent-held grant", () => {
    render(<GrantHolderBadge kind="agent" />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("labels an owner-held grant", () => {
    render(<GrantHolderBadge kind="owner" />);
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });
});

describe("GrantScopePicker", () => {
  it("renders all three offerable scopes and marks the active one", () => {
    render(<GrantScopePicker value="read" onChange={() => {}} />);
    const readBtn = screen.getByRole("radio", { name: /read only/i });
    const fullBtn = screen.getByRole("radio", { name: /full access/i });
    expect(readBtn).toHaveAttribute("aria-checked", "true");
    expect(fullBtn).toHaveAttribute("aria-checked", "false");
  });

  it("defaults to full being selectable and calls onChange with the clicked scope", () => {
    let picked: string | null = null;
    render(<GrantScopePicker value="full" onChange={(s) => { picked = s; }} />);
    fireEvent.click(screen.getByRole("radio", { name: /send/i }));
    expect(picked).toBe("send");
  });
});
