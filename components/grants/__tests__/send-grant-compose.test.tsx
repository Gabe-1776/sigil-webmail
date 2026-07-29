import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SendGrantCompose } from "../send-grant-compose";

describe("SendGrantCompose", () => {
  it("starts collapsed behind a 'Compose as <owner>' toggle", () => {
    render(<SendGrantCompose grantId="g1" ownerActor="gabe" authFetch={vi.fn()} />);
    expect(screen.getByText(/compose as gabe/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/subject/i)).not.toBeInTheDocument();
  });

  it("expands to a minimal to/subject/body form", () => {
    render(<SendGrantCompose grantId="g1" ownerActor="gabe" authFetch={vi.fn()} />);
    fireEvent.click(screen.getByText(/compose as gabe/i));
    expect(screen.getByPlaceholderText(/to — recipient/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/subject/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/message/i)).toBeInTheDocument();
  });

  it("disables Send until all three fields are filled", () => {
    render(<SendGrantCompose grantId="g1" ownerActor="gabe" authFetch={vi.fn()} />);
    fireEvent.click(screen.getByText(/compose as gabe/i));
    const sendBtn = screen.getByRole("button", { name: /^send$/i });
    expect(sendBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/to — recipient/i), { target: { value: "alice@example.com" } });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/subject/i), { target: { value: "Hi" } });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: "Hello there" } });
    expect(sendBtn).not.toBeDisabled();
  });

  it("posts to the grant's scoped send proxy with the composed fields and shows Sent on success", async () => {
    const authFetch = vi.fn().mockResolvedValue({ ok: true, emailId: "e1", submissionId: "s1" });
    render(<SendGrantCompose grantId="grant-42" ownerActor="gabe" authFetch={authFetch} />);
    fireEvent.click(screen.getByText(/compose as gabe/i));
    fireEvent.change(screen.getByPlaceholderText(/to — recipient/i), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByPlaceholderText(/subject/i), { target: { value: "Hi" } });
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: "Hello there" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [path, opts] = authFetch.mock.calls[0];
    expect(path).toBe("/api/grants/grant-42/mail/send");
    expect(JSON.parse(opts.body)).toEqual({ to: "alice@example.com", subject: "Hi", text: "Hello there" });
    expect(await screen.findByText("Sent")).toBeInTheDocument();
  });

  it("shows the server error and keeps the form usable on failure", async () => {
    const authFetch = vi.fn().mockResolvedValue({ ok: false, error: "grant is revoked, not accepted" });
    render(<SendGrantCompose grantId="grant-42" ownerActor="gabe" authFetch={authFetch} />);
    fireEvent.click(screen.getByText(/compose as gabe/i));
    fireEvent.change(screen.getByPlaceholderText(/to — recipient/i), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByPlaceholderText(/subject/i), { target: { value: "Hi" } });
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: "Hello there" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByText("grant is revoked, not accepted")).toBeInTheDocument();
    // Fields are NOT cleared on failure — the human shouldn't have to retype.
    expect(screen.getByPlaceholderText(/subject/i)).toHaveValue("Hi");
  });
});
