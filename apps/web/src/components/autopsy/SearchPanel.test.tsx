import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AutopsyClient } from "@/lib/api-client";
import type { SearchHit } from "@/types/autopsy";
import { LiveAnnouncer } from "./LiveAnnouncer";
import { MAX_QUERY_LENGTH, SearchPanel } from "./SearchPanel";

function setup(hits: SearchHit[] = []) {
  const search = vi.fn().mockResolvedValue({ hits });
  const onHits = vi.fn();
  render(
    <LiveAnnouncer>
      <SearchPanel client={{ search } as unknown as AutopsyClient} sessionId="s1" onHits={onHits} />
    </LiveAnnouncer>,
  );
  return { search, onHits, input: screen.getByRole("searchbox") };
}

const hit: SearchHit = {
  entity: "CUSTOMER",
  row_number: 3,
  similarity: 0.9,
  anomaly_flags: [],
  preview: "row",
};

describe("SearchPanel", () => {
  it("rejects an empty (whitespace-only) query without calling the API", async () => {
    const user = userEvent.setup();
    const { search, input } = setup();
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/between 1 and 500/);
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects an over-length query without calling the API", async () => {
    const user = userEvent.setup();
    const { search, input } = setup();
    await user.click(input);
    await user.paste("a".repeat(MAX_QUERY_LENGTH + 1));
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts a query of exactly the maximum length", async () => {
    const user = userEvent.setup();
    const { search, input } = setup();
    await user.click(input);
    await user.paste("a".repeat(MAX_QUERY_LENGTH));
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  });

  it("shows a no-match message and announces it", async () => {
    const user = userEvent.setup();
    const { onHits, input } = setup([]);
    await user.type(input, "zzz");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No records matched.")).toBeInTheDocument();
    expect(onHits).toHaveBeenCalledWith([]);
    await waitFor(() =>
      expect(screen.getByTestId("live-announcer")).toHaveTextContent("No records matched your query."),
    );
  });

  it("announces the result count when there are matches", async () => {
    const user = userEvent.setup();
    const { input } = setup([hit]);
    await user.type(input, "cust");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/CUSTOMER, row 3/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("live-announcer")).toHaveTextContent("1 record matched."),
    );
  });
});
