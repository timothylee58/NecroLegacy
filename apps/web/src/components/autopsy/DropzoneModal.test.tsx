import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DropzoneModal } from "./DropzoneModal";
import type { AutopsyClient } from "@/lib/api-client";
import type { CreateSessionResponse } from "@/types/autopsy";

const RESPONSE = { session_id: "s1" } as unknown as CreateSessionResponse;

function setup(createSession = vi.fn().mockResolvedValue(RESPONSE)) {
  const client = { createSession } as unknown as AutopsyClient;
  const onSession = vi.fn();
  const onOpenChange = vi.fn();
  render(<DropzoneModal client={client} onSession={onSession} open onOpenChange={onOpenChange} />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  return { createSession, onSession, onOpenChange, input, user: userEvent.setup() };
}

const sized = (name: string, size: number, type = "text/plain") => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("DropzoneModal", () => {
  it("says the API is waking when an upload waits past a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resolve!: (r: CreateSessionResponse) => void;
      const createSession = vi.fn(() => new Promise<CreateSessionResponse>((r) => (resolve = r)));
      const client = { createSession } as unknown as AutopsyClient;
      render(<DropzoneModal client={client} onSession={vi.fn()} open onOpenChange={vi.fn()} />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getAllByRole("radio")[0]!);
      expect(screen.getByRole("status")).toHaveTextContent("Uploading");
      await vi.advanceTimersByTimeAsync(4_000);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/waking the api/i));
      resolve(RESPONSE);
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
  it("alerts on an unsupported extension and does not upload", async () => {
    const { input, createSession } = setup();
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["x"], "notes.exe"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("notes.exe");
    expect(alert).toHaveTextContent("Unsupported file type");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("alerts when a text file exceeds 5 MB", async () => {
    const { input, createSession } = setup();
    await userEvent.setup().upload(input, sized("big.dat", 5_242_881));
    expect(await screen.findByRole("alert")).toHaveTextContent("5 MB");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("alerts when an image exceeds 10 MB", async () => {
    const { input, createSession } = setup();
    await userEvent.setup().upload(input, sized("scan.png", 10_485_761, "image/png"));
    expect(await screen.findByRole("alert")).toHaveTextContent("10 MB");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("dispatches a valid file within 500 ms", async () => {
    const { input, createSession, onSession } = setup();
    const file = new File(["A,B\n1,2\n"], "ok.csv", { type: "text/csv" });
    const start = performance.now();
    await userEvent.setup().upload(input, file);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(performance.now() - start).toBeLessThan(500);
    expect(createSession.mock.calls[0]![0]).toEqual({ kind: "file", file });
    await waitFor(() => expect(onSession).toHaveBeenCalled());
  });

  it("selects a preset using the keyboard only", async () => {
    const { user, createSession } = setup();
    const radios = screen.getAllByRole("radio");
    radios[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(radios[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(radios[2]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(radios[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0]![0]).toEqual({
      kind: "preset",
      preset: "fnb_pos_corrupted",
    });
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
  });

  it("shows a retryable alert after a timeout and re-sends the same input", async () => {
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(RESPONSE);
    const { user, onSession } = setup(createSession);
    await user.click(screen.getAllByRole("radio")[0]!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("45 seconds");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1]![0]).toEqual(createSession.mock.calls[0]![0]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
