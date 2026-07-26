// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ledgerPanel } from "../client/rail-panel.js";
import type { LedgerSourceStatus, LedgerSummaryDto, LedgerWindow } from "../server/types.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function dto(
  status: LedgerSourceStatus,
  window: LedgerWindow = "week",
  costUsd = 12.34,
  skippedSessions = 0,
): LedgerSummaryDto {
  return {
    schemaVersion: 1,
    scope: { theaterId: "theater-a", window },
    generatedAtMs: Date.now(),
    totals: { costUsd, input: 1_000, output: 200, cacheRead: 300, messages: 4 },
    operations: costUsd === 0 ? [] : [{
      operationId: "operation-a",
      title: "Operation A",
      cliId: "claude",
      cliLabel: "Claude Code",
      client: "claude",
      messages: 4,
      usage: { input: 1_000, output: 200, cacheRead: 300 },
      costUsd,
      models: ["claude-sonnet-4"],
      lastActivityAtMs: Date.now(),
    }],
    clients: [{
      client: "claude",
      sessions: 1,
      usage: { input: 1_000, output: 200, cacheRead: 300 },
      costUsd,
    }],
    source: { status, skippedSessions },
  };
}

function context(fetchImpl: RailPanelContext["api"]["fetch"]): RailPanelContext {
  return {
    theaterId: "theater-a",
    pathContext: { kind: "root", relPath: null, label: "root" },
    api: { fetch: fetchImpl, subscribe: vi.fn(), resync: vi.fn() },
    language: "en",
  };
}

async function renderWith(value: LedgerSummaryDto): Promise<void> {
  const fetch = vi.fn(async () => ({ json: async () => value } as Response));
  await act(async () => {
    root.render(ledgerPanel.render(context(fetch)));
  });
}

describe("Ledger rail status rendering", () => {
  it("renders ok data and its empty state distinctly", async () => {
    await renderWith(dto("ok"));
    expect(container.textContent).toContain("$12.34");
    expect(container.textContent).toContain("1 operations active in this window");
    expect(container.textContent).toContain("Total tokens");
    expect(container.querySelector(".ledger-operation-values")?.textContent).toContain("2k");
    expect(container.querySelector(".ledger-client-values")?.textContent).toContain("2k");
    expect(container.textContent).toContain("By CLI · device-wide");
    expect(container.textContent).not.toContain("Source");
    expect(container.textContent).not.toContain("tokscale 4.7.0");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderWith(dto("ok", "week", 0));
    expect(container.textContent).toContain("No usage in this window");
  });

  it("renders degraded data with the skipped-session warning", async () => {
    await renderWith(dto("degraded", "week", 12.34, 3));
    expect(container.textContent).toContain("$12.34");
    expect(container.textContent).toContain("Some records could not be read and were excluded (3).");
    expect(container.querySelector("[data-ledger-source-status=degraded]")).not.toBeNull();
    expect(container.textContent).not.toContain("tokscale 4.7.0");
  });

  it.each([
    ["unavailable" as const, "Installation or launch failed"],
    ["unreadable" as const, "Usage data unreadable"],
  ])("renders %s as a retryable error without zero usage", async (status, label) => {
    await renderWith(dto(status, "week", 0));
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).not.toContain("$0.00");
    expect(container.textContent).not.toContain("No usage in this window");
    expect(container.querySelector(`[data-ledger-source-status=${status}]`)).not.toBeNull();
    expect(container.textContent).not.toContain("tokscale 4.7.0");
  });

  it("shows bootstrapping as a source state without exposing the tool version", async () => {
    await renderWith(dto("bootstrapping"));
    expect(container.textContent).toContain("Reading local usage");
    expect(container.querySelector("[data-ledger-source-status=bootstrapping]")).not.toBeNull();
    expect(container.textContent).not.toContain("tokscale 4.7.0");
  });

  it("shows total tokens in the Operation detail view", async () => {
    await renderWith(dto("ok"));
    const operation = container.querySelector<HTMLButtonElement>(".ledger-operation");
    expect(operation).not.toBeNull();
    await act(async () => operation!.click());
    expect(container.textContent).toContain("Total tokens");
    expect(container.querySelector(".ledger-total-token")?.textContent).toContain("2k");
  });

  it("hides the previous window data immediately while the next request is pending", async () => {
    let resolveToday!: (value: Response) => void;
    const fetch = vi.fn((_pluginId: string, path: string) => {
      if (path.includes("window=today")) {
        return new Promise<Response>((resolve) => {
          resolveToday = resolve;
        });
      }
      return Promise.resolve({ json: async () => dto("ok", "week", 12.34) } as Response);
    });
    await act(async () => {
      root.render(ledgerPanel.render(context(fetch)));
    });
    expect(container.textContent).toContain("$12.34");

    const today = [...container.querySelectorAll("button")].find((button) => button.textContent === "Today");
    expect(today).toBeDefined();
    await act(async () => today!.click());
    expect(container.textContent).not.toContain("$12.34");
    expect(container.textContent).toContain("Reading local usage");

    await act(async () => {
      resolveToday({ json: async () => dto("ok", "today", 1) } as Response);
    });
    expect(container.textContent).toContain("$1.00");
  });

  it("hides Theater data immediately while the all-theaters request is pending", async () => {
    let resolveAll!: (value: Response) => void;
    const fetch = vi.fn((_pluginId: string, path: string) => {
      if (!path.includes("theaterId=")) {
        return new Promise<Response>((resolve) => {
          resolveAll = resolve;
        });
      }
      return Promise.resolve({ json: async () => dto("ok", "week", 12.34) } as Response);
    });
    await act(async () => {
      root.render(ledgerPanel.render(context(fetch)));
    });
    expect(container.textContent).toContain("$12.34");

    const allTheaters = [...container.querySelectorAll("button")].find((button) => button.textContent === "All theaters");
    expect(allTheaters).toBeDefined();
    await act(async () => allTheaters!.click());
    expect(container.textContent).not.toContain("$12.34");
    expect(container.textContent).toContain("Reading local usage");

    await act(async () => {
      const allDto = dto("ok", "week", 99);
      resolveAll({ json: async () => ({ ...allDto, scope: { theaterId: null, window: "week" } }) } as Response);
    });
    expect(container.textContent).toContain("$99.00");
  });
});
