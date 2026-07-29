import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenSharedMailboxButton } from "../open-shared-mailbox-button";
import { useGrantsDrawerStore } from "@/stores/grants-drawer-store";

const mocks = vi.hoisted(() => {
  const pushMock = vi.fn();
  const reconnectMock = vi.fn(async () => {});
  const fetchMailboxesMock = vi.fn(async () => {});
  return { pushMock, reconnectMock, fetchMailboxesMock };
});

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mocks.pushMock, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/en",
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/stores/auth-store", () => {
  const state = { client: { reconnect: mocks.reconnectMock } as any };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === "function" ? sel(state) : state);
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock("@/stores/email-store", () => {
  const state = { fetchMailboxes: mocks.fetchMailboxesMock };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === "function" ? sel(state) : state);
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

describe("OpenSharedMailboxButton", () => {
  beforeEach(() => {
    mocks.pushMock.mockClear();
    mocks.reconnectMock.mockClear();
    mocks.fetchMailboxesMock.mockClear();
    mocks.reconnectMock.mockResolvedValue(undefined);
    mocks.fetchMailboxesMock.mockResolvedValue(undefined);
    useGrantsDrawerStore.setState({ isOpen: true });
  });

  it("reconnects the JMAP client, refetches mailboxes, closes the drawer, and navigates home", async () => {
    render(<OpenSharedMailboxButton ownerActor="gabe" />);
    fireEvent.click(screen.getByRole("button", { name: /open shared mailbox/i }));

    await waitFor(() => expect(mocks.reconnectMock).toHaveBeenCalledTimes(1));
    expect(mocks.fetchMailboxesMock).toHaveBeenCalledTimes(1);
    expect(useGrantsDrawerStore.getState().isOpen).toBe(false);
    expect(mocks.pushMock).toHaveBeenCalledWith("/");
  });

  it("shows a retry affordance instead of crashing when the client is missing", async () => {
    const { useAuthStore } = await import("@/stores/auth-store");
    (useAuthStore as any).setState({ client: null });
    render(<OpenSharedMailboxButton ownerActor="gabe" />);
    fireEvent.click(screen.getByRole("button", { name: /open shared mailbox/i }));

    expect(await screen.findByText(/not connected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    (useAuthStore as any).setState({ client: { reconnect: mocks.reconnectMock } });
  });

  it("surfaces a reconnect failure without crashing", async () => {
    mocks.reconnectMock.mockRejectedValueOnce(new Error("network down"));
    render(<OpenSharedMailboxButton ownerActor="gabe" />);
    fireEvent.click(screen.getByRole("button", { name: /open shared mailbox/i }));

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(mocks.pushMock).not.toHaveBeenCalled();
  });
});
