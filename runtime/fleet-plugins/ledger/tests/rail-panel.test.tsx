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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const modelRow = {
  modelId: "claude-opus-5",
  provider: "anthropic",
  label: "Claude Opus 5",
  usage: { input: 1_000, output: 200, cacheRead: 300 },
  costUsd: 12.34,
  messages: 4,
} as const;

function dto(
  status: LedgerSourceStatus = "ok",
  window: LedgerWindow = "week",
  costUsd = 12.34,
  daily: LedgerSummaryDto["daily"] = [],
): LedgerSummaryDto {
  const modelsStatus = status === "bootstrapping" || status === "unavailable" || status === "unreadable"
    ? status
    : "ok";
  const rows = costUsd === 0 ? [] : [{ ...modelRow, costUsd }];
  return {
    schemaVersion: 2,
    scope: { window },
    generatedAtMs: Date.now(),
    currentDay: "2026-08-14",
    totals: { costUsd, input: 1_000, output: 200, cacheRead: 300, messages: 4 },
    modelRows: rows,
    modelCount: rows.length,
    daily,
    dailyDetails: daily.filter((point) => point.costUsd > 0).map((point) => ({
      day: point.day,
      costUsd: point.costUsd,
      usage: { input: 1_000, output: 200, cacheRead: 300 },
      messages: 4,
      models: [{ ...modelRow, costUsd: point.costUsd }],
      modelCount: 1,
    })),
    dailySource: { unmatchedEntries: 0 },
    source: {
      status,
      models: modelsStatus,
      report: "ok",
      skippedEntries: 0,
      skippedSessions: 0,
    },
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

async function renderWith(value: LedgerSummaryDto): Promise<ReturnType<typeof vi.fn>> {
  const fetch = vi.fn(async () => ({ json: async () => value } as Response));
  await act(async () => root.render(ledgerPanel.render(context(fetch))));
  return fetch;
}

async function renderWindowWith(value: LedgerSummaryDto, label: "Today" | "This month"): Promise<void> {
  const fetch = vi.fn(async (_pluginId: string, path: string) => ({
    json: async () => path.includes(`window=${value.scope.window}`) ? value : dto("ok", "week", 0),
  } as Response));
  await act(async () => root.render(ledgerPanel.render(context(fetch))));
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === label);
  await act(async () => button!.click());
}

async function renderTodayWith(value: LedgerSummaryDto): Promise<void> {
  await renderWindowWith(value, "Today");
}

function trendDto(window: LedgerWindow = "week"): LedgerSummaryDto {
  const value = dto("ok", window, 13.59, [
    { day: "2026-08-13", costUsd: 1.25 },
    { day: "2026-08-14", costUsd: 12.34 },
  ]);
  return { ...value, generatedAtMs: new Date(2026, 7, 14, 12).getTime() };
}

describe("Ledger Claude Code provider presentation", () => {
  it("renders one canonical total and provider-attributed model rows without Operation or Theater UI", async () => {
    const value = dto();
    await renderWith({
      ...value,
      modelRows: [
        value.modelRows[0]!,
        {
          ...modelRow,
          modelId: "claude-gateway--xai--grok-4.6",
          provider: "xai",
          label: "Grok 4.6",
          costUsd: 3,
        },
      ],
      modelCount: 2,
    });
    expect(container.querySelector(".ledger-hero-cost")?.textContent).toBe("$12.34");
    expect(container.textContent).toContain("Claude Code · 2 models");
    expect(container.textContent).toContain("All models used through Claude Code are included.");
    expect(container.textContent).toContain("Claude Opus 5Anthropic");
    expect(container.textContent).toContain("Grok 4.6xAI");
    expect(container.querySelector(".ledger-client-mark.is-anthropic")).not.toBeNull();
    expect(container.querySelector(".ledger-client-mark.is-xai")).not.toBeNull();
    expect(container.textContent).toContain("Total tokens");
    expect(container.textContent).not.toMatch(/Operation|Theater|device-wide/i);
  });

  it("renders a Claude Code model empty state", async () => {
    await renderWith(dto("ok", "week", 0));
    expect(container.querySelector(".ledger-hero-cost")?.textContent).toBe("$0.00");
    expect(container.textContent).toContain("No Claude Code model usage");
    expect(container.textContent).toContain("No model records from Claude Code were found in this window.");
  });

  it("shows zero-cost model activity without a pricing qualifier", async () => {
    const value = dto("ok", "week", 1);
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 0 },
      modelRows: [{ ...modelRow, provider: "opencode", costUsd: 0, messages: 12 }],
      modelCount: 1,
    });
    expect(container.querySelector(".ledger-client-copy small")?.textContent).toBe("OpenCode");
  });

  it("reports omitted model rows from the uncapped count", async () => {
    const value = dto();
    await renderWith({ ...value, modelCount: 81 });
    expect(container.textContent).toContain("+80 more models");
  });
});

describe("Ledger daily model detail", () => {
  it("renders selectable button marks with labels, tooltip, and the latest nonzero day selected", async () => {
    await renderTodayWith(trendDto("today"));
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".ledger-trend-bar")];
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => ({ tag: bar.tagName, pressed: bar.getAttribute("aria-pressed") }))).toEqual([
      { tag: "BUTTON", pressed: "false" },
      { tag: "BUTTON", pressed: "true" },
    ]);
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Aug 13 · $1.25 · Linear scale",
      "Aug 14 · $12.34 · Linear scale",
    ]);
    expect(bars[1]?.querySelector(".ledger-trend-tooltip")?.textContent).toContain("$12.34");
    expect(container.textContent).toContain("Aug 14 model detail");
  });

  it.each(["week", "month"] as const)("shows no model detail in the %s window", async (window) => {
    const value = trendDto(window);
    if (window === "month") await renderWindowWith(value, "This month");
    else await renderWith(value);
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".ledger-trend-bar")];
    expect(bars.every((bar) => bar.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(bars.every((bar) => bar.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(container.querySelector(".ledger-daily-detail")).toBeNull();
    await act(async () => bars[0]!.click());
    expect(container.querySelector(".ledger-daily-detail")).toBeNull();
  });

  it("keeps today's detail available in the Today window", async () => {
    await renderTodayWith(trendDto("today"));
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".ledger-trend-bar")];
    expect(bars[1]?.getAttribute("aria-disabled")).toBe("false");
    expect(container.textContent).toContain("Aug 14 model detail");
  });

  it("uses the Console host day instead of the browser-local generated date", async () => {
    const value = trendDto("today");
    await renderTodayWith({
      ...value,
      generatedAtMs: new Date(2026, 7, 13, 12).getTime(),
      currentDay: "2026-08-14",
    });
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".ledger-trend-bar")];
    expect(bars[1]?.getAttribute("aria-disabled")).toBe("false");
    expect(container.textContent).toContain("Aug 14 model detail");
  });

  it("keeps past bars non-selectable even in the Today response", async () => {
    await renderTodayWith(trendDto("today"));
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".ledger-trend-bar")];
    expect(bars[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(bars[1]?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => bars[0]!.click());
    expect(bars[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(bars[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Aug 14 model detail");
    expect(container.textContent).not.toContain("Aug 13 model detail");
  });

  it("switches between linear and square-root scales without changing values", async () => {
    const value = dto("ok", "week", 101, [
      { day: "2026-08-13", costUsd: 100 },
      { day: "2026-08-14", costUsd: 1 },
    ]);
    await renderWith(value);
    const heights = () => [...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")].map((bar) => bar.style.height);
    expect(heights()).toEqual(["100%", "3%"]);
    const sqrt = [...container.querySelectorAll<HTMLButtonElement>(".ledger-segment button")]
      .find((button) => button.textContent === "Square root");
    await act(async () => sqrt!.click());
    expect(Number.parseFloat(heights()[1]!)).toBeCloseTo(10, 5);
    expect(container.textContent).toContain("heights follow √cost");
    expect(container.querySelectorAll(".ledger-trend-bar")[1]?.getAttribute("aria-label"))
      .toBe("Aug 14 · $1.00 · Square root scale");
  });

  it("anchors tooltips across the chart and computes finite averages without summing first", async () => {
    const value = dto("ok", "week", Number.MAX_VALUE, [
      { day: "2026-08-12", costUsd: Number.MAX_VALUE },
      { day: "2026-08-13", costUsd: Number.MAX_VALUE },
      { day: "2026-08-14", costUsd: 0 },
    ]);
    await renderWith(value);
    expect([...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")]
      .map((bar) => bar.style.getPropertyValue("--ledger-bar-pos"))).toEqual(["0", "0.5", "1"]);
    expect(container.querySelector(".ledger-trend-summary")?.textContent).not.toContain("Infinity");
    expect(container.querySelector(".ledger-trend-summary")?.textContent).not.toContain("NaN");
  });
});

describe("Ledger source status", () => {
  it.each([
    ["unavailable" as const, "Model ledger unavailable"],
    ["unreadable" as const, "Model ledger unreadable"],
  ])("renders canonical model source %s as retryable and never paints zero cost", async (status, label) => {
    await renderWith(dto(status, "week", 0));
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("Retry");
    expect(container.textContent?.toLowerCase()).toContain("no cost is shown");
    expect(container.textContent).not.toContain("$0.00");
    expect(container.querySelector(`[data-ledger-source-status=${status}]`)).not.toBeNull();
  });

  it("keeps model totals and explains missing daily detail when only report metadata fails", async () => {
    const value = dto("degraded");
    await renderWith({
      ...value,
      source: { ...value.source, status: "degraded", report: "unavailable" },
    });
    expect(container.querySelector(".ledger-hero-cost")?.textContent).toBe("$12.34");
    expect(container.textContent).toContain("Daily detail is unavailable, but the model totals above remain complete.");
  });

  it("reports skipped records and unmatched day joins independently", async () => {
    const value = dto("degraded");
    await renderWith({
      ...value,
      dailySource: { unmatchedEntries: 2 },
      source: { ...value.source, status: "degraded", skippedEntries: 3, skippedSessions: 1 },
    });
    expect(container.textContent).toContain("Some source records could not be read and were excluded (4).");
    expect(container.textContent).toContain("2 model records are included in the total but have no matching day metadata.");
  });

  it("shows bootstrapping without exposing tool implementation or a fabricated value", async () => {
    await renderWith(dto("bootstrapping", "week", 0));
    expect(container.textContent).toContain("Reading the local model ledger");
    expect(container.textContent).not.toContain("tokscale");
    expect(container.textContent).not.toContain("$0.00");
  });
});

describe("Ledger requests", () => {
  it("requests only window scope and hides stale data immediately during a period change", async () => {
    let resolveToday!: (value: Response) => void;
    const fetch = vi.fn((_pluginId: string, path: string) => {
      if (path.includes("window=today")) {
        return new Promise<Response>((resolve) => { resolveToday = resolve; });
      }
      return Promise.resolve({ json: async () => dto("ok", "week", 12.34) } as Response);
    });
    await act(async () => root.render(ledgerPanel.render(context(fetch))));
    expect(fetch).toHaveBeenCalledWith("ledger", "summary?window=week");
    expect(container.textContent).toContain("$12.34");

    const today = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Today");
    await act(async () => today!.click());
    expect(container.textContent).not.toContain("$12.34");
    expect(container.textContent).toContain("Reading the local model ledger");

    await act(async () => resolveToday({ json: async () => dto("ok", "today", 1) } as Response));
    expect(container.textContent).toContain("$1.00");
    expect(fetch.mock.calls.flat().join(" ")).not.toContain("theaterId");
  });

  it("adds refresh=1 only after an explicit refresh", async () => {
    const fetch = await renderWith(dto());
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Refresh");
    await act(async () => refresh!.click());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith("ledger", "summary?window=week&refresh=1");
  });

  it("turns request rejection into a retryable transport error", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    await act(async () => root.render(ledgerPanel.render(context(fetch))));
    expect(container.textContent).toContain("Could not load usage");
    expect(container.textContent).toContain("Retry");
  });
});
