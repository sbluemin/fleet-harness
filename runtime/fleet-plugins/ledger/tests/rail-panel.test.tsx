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
  daily: LedgerSummaryDto["daily"] = [],
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
    unmatched: [],
    unmatchedTotal: 0,
    otherTheaterTotals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 },
    deviceTotals: {
      costUsd: costUsd * 2,
      input: 2_000,
      output: 400,
      cacheRead: 600,
      messages: 8,
      sessions: 2,
    },
    clients: [{
      client: "claude",
      sessions: 1,
      usage: { input: 1_000, output: 200, cacheRead: 300 },
      costUsd,
    }],
    daily,
    dailyAttributed: daily.map((point) => ({ day: point.day, costUsd: 0 })),
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

  it("renders a device-wide daily trend before the CLI rows with peak summary text", async () => {
    await renderWith(dto("ok", "week", 12.34, 0, [
      { day: "2026-07-28", costUsd: 1.25 },
      { day: "2026-07-29", costUsd: 3.75 },
    ]));

    const trend = container.querySelector(".ledger-trend");
    expect(trend).not.toBeNull();
    expect(container.querySelector(".ledger-clients")?.firstElementChild).toBe(trend);
    expect(trend?.querySelectorAll(".ledger-trend-bar")).toHaveLength(2);
    expect(trend?.querySelector(".ledger-trend-description")?.textContent).toBe(
      "Each session's cost counts on the day it was last active, so a session spanning midnight lands entirely on the later day.",
    );
    expect(trend?.textContent).toContain("Peak Jul 29 · $3.75");
    expect(trend?.textContent).toContain("Daily avg $2.50");
  });

  it.each([
    ["zero", []],
    ["one", [{ day: "2026-07-29", costUsd: 3.75 }]],
  ] satisfies ReadonlyArray<readonly [string, LedgerSummaryDto["daily"]]>)
  ("does not render the trend for %s daily points", async (_label, daily) => {
    await renderWith(dto("ok", "week", 12.34, 0, daily));
    expect(container.querySelector(".ledger-trend")).toBeNull();
  });

  it("labels every daily bar for assistive technology", async () => {
    await renderWith(dto("ok", "week", 12.34, 0, [
      { day: "2026-07-28", costUsd: 1.25 },
      { day: "2026-07-29", costUsd: 3.75 },
    ]));

    const barsContainer = container.querySelector(".ledger-trend-bars");
    const bars = [...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")];
    expect(barsContainer?.getAttribute("role")).toBe("group");
    expect(barsContainer?.getAttribute("aria-label")).toBe("Daily cost bar chart");
    expect(bars.map((bar) => ({ tag: bar.tagName, role: bar.getAttribute("role"), tabIndex: bar.tabIndex }))).toEqual([
      { tag: "SPAN", role: "img", tabIndex: 0 },
      { tag: "SPAN", role: "img", tabIndex: 0 },
    ]);
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Jul 28 · $1.25",
      "Jul 29 · $3.75",
    ]);
  });

  it("anchors daily tooltips proportionally across the chart", async () => {
    await renderWith(dto("ok", "week", 12.34, 0, [
      { day: "2026-07-28", costUsd: 1.25 },
      { day: "2026-07-29", costUsd: 2.5 },
      { day: "2026-07-30", costUsd: 3.75 },
    ]));

    expect([...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")]
      .map((bar) => bar.style.getPropertyValue("--ledger-bar-pos"))).toEqual(["0", "0.5", "1"]);
  });

  it("renders a finite daily average when the unscaled sum would overflow", async () => {
    await expect(renderWith(dto("ok", "week", 12.34, 0, [
      { day: "2026-07-28", costUsd: Number.MAX_VALUE },
      { day: "2026-07-29", costUsd: Number.MAX_VALUE },
    ]))).resolves.toBeUndefined();

    expect(container.querySelector(".ledger-trend")).not.toBeNull();
    expect(container.querySelector(".ledger-trend-summary")?.textContent)
      .toContain(`Daily avg $${Number.MAX_VALUE.toFixed(2)}`);
    expect(container.querySelector(".ledger-trend-summary")?.textContent).not.toContain("Daily avg $0.00");
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

  it("resets scroll on detail entry and restores the list position on back", async () => {
    await renderWith(dto("ok"));
    const listRoot = container.querySelector<HTMLDivElement>(".ledger-root");
    expect(listRoot).not.toBeNull();
    listRoot!.scrollTop = 480;

    const operation = container.querySelector<HTMLButtonElement>(".ledger-operation");
    await act(async () => operation!.click());
    expect(container.querySelector(".ledger-detail")).not.toBeNull();
    expect(container.querySelector<HTMLDivElement>(".ledger-root")!.scrollTop).toBe(0);

    const back = container.querySelector<HTMLButtonElement>(".ledger-back");
    expect(back).not.toBeNull();
    await act(async () => back!.click());
    expect(container.querySelector(".ledger-operation")).not.toBeNull();
    expect(container.querySelector<HTMLDivElement>(".ledger-root")!.scrollTop).toBe(480);
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

describe("Ledger attribution bridge and coverage", () => {
  it("renders the attribution bridge reconciling the hero to the device-wide total", async () => {
    await renderWith(dto("ok", "week", 12.34));
    const bridge = container.querySelector(".ledger-bridge");
    expect(bridge).not.toBeNull();
    expect(bridge?.textContent).toContain("This Theater's operations");
    expect(bridge?.textContent).toContain("$12.34 · 50%");
    expect(bridge?.textContent).toContain("Other local sessions");
    expect(bridge?.textContent).toContain("Device-wide this window");
    expect(bridge?.textContent).toContain("$24.68");
    expect(bridge?.querySelector(".ledger-bridge-bar")?.getAttribute("aria-label")).toContain("50%");
    expect(bridge?.querySelector(".ledger-bridge-attributed")?.getAttribute("style")).toContain("width: 50%");
  });

  it("hides the bridge when the device-wide total is zero", async () => {
    const value = dto("ok", "week", 0);
    await renderWith({ ...value, deviceTotals: { ...value.deviceTotals, costUsd: 0 } });
    expect(container.querySelector(".ledger-bridge")).toBeNull();
  });

  it("renders unmatched operations as ghost rows with a coverage line", async () => {
    const value = dto("ok");
    await renderWith({
      ...value,
      unmatched: [{
        operationId: "operation-ghost",
        title: "Ghost Operation",
        cliId: "codex",
        cliLabel: "Codex",
        lastActivityAtMs: Date.now() - 1_000,
      }],
      unmatchedTotal: 1,
    });
    expect(container.textContent).toContain("2 operations with saved sessions");
    expect(container.textContent).toContain("1 matched · 1 unmatched");
    const ghost = container.querySelector(".ledger-operation--unmatched");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toContain("Ghost Operation");
    expect(ghost?.textContent).toContain("No usage matched in this window");
    expect(ghost?.closest("button")).toBeNull();
    expect(ghost?.getAttribute("aria-label")).toBeNull();
  });

  it("keeps the list honest when nothing matches: ghost rows without the empty-state copy", async () => {
    const value = dto("ok", "week", 0);
    await renderWith({
      ...value,
      unmatched: [{
        operationId: "operation-ghost",
        title: "Ghost Operation",
        cliId: "codex",
        cliLabel: "Codex",
        lastActivityAtMs: Date.now() - 1_000,
      }],
      unmatchedTotal: 1,
    });
    expect(container.textContent).not.toContain("No usage in this window");
    expect(container.querySelector(".ledger-operation--unmatched")).not.toBeNull();
  });

  it("switches the operation list order between recent activity and highest cost", async () => {
    const value = dto("ok");
    const now = Date.now();
    await renderWith({
      ...value,
      operations: [
        { ...value.operations[0]!, operationId: "cheap-recent", title: "Cheap Recent", costUsd: 0.5, lastActivityAtMs: now },
        { ...value.operations[0]!, operationId: "dear-stale", title: "Dear Stale", costUsd: 40, lastActivityAtMs: now - 3_600_000 },
      ],
      totals: { ...value.totals, costUsd: 40.5 },
    });
    const titles = () => [...container.querySelectorAll(".ledger-operation .ledger-operation-copy strong")].map((node) => node.textContent);
    expect(titles()).toEqual(["Cheap Recent", "Dear Stale"]);

    const costSort = [...container.querySelectorAll<HTMLElement>(".ledger-segment button")].find((button) => button.textContent === "Highest cost");
    await act(async () => costSort!.click());
    expect(titles()).toEqual(["Dear Stale", "Cheap Recent"]);

    const activitySort = [...container.querySelectorAll<HTMLElement>(".ledger-segment button")].find((button) => button.textContent === "Recent activity");
    await act(async () => activitySort!.click());
    expect(titles()).toEqual(["Cheap Recent", "Dear Stale"]);
  });
});

describe("Ledger bridge share boundaries and buckets", () => {
  function bridgeDto(attributed: number, deviceWide: number): LedgerSummaryDto {
    const value = dto("ok");
    return {
      ...value,
      totals: { ...value.totals, costUsd: attributed },
      deviceTotals: { ...value.deviceTotals, costUsd: deviceWide },
    };
  }

  function bridgeText(): string {
    return container.querySelector(".ledger-bridge")?.textContent ?? "";
  }

  it.each([
    [0, 100, "0%"],
    [0.04, 100, "<0.1%"],
    [9.94, 100, "9.9%"],
    [9.95, 100, "10%"],
    [50, 100, "50%"],
    [99.5, 100, "99%"],
    [99.96, 100, ">99.9%"],
    [100, 100, "100%"],
  ])("formats the share %s / %s as %s without contradicting the remainder", async (attributed, deviceWide, label) => {
    await renderWith(bridgeDto(attributed, deviceWide));
    expect(bridgeText()).toContain(label);
    expect(bridgeText()).not.toContain(label === "100%" ? ">99.9%" : "100%");
  });

  it("clamps an over-attributed share to 100% with a zero remainder", async () => {
    await renderWith(bridgeDto(120, 100));
    expect(bridgeText()).toContain("100%");
    expect(bridgeText()).toContain("$0.00");
    expect(container.querySelector(".ledger-bridge-attributed")?.getAttribute("style")).toContain("width: 100%");
  });

  it("stays finite at maximum values", async () => {
    await renderWith(bridgeDto(Number.MAX_VALUE, Number.MAX_VALUE));
    expect(bridgeText()).toContain("100%");
    expect(bridgeText()).not.toContain("NaN");
    expect(bridgeText()).not.toContain("Infinity");
  });

  it("splits other theaters' Console attribution into its own bucket in Theater scope", async () => {
    const value = bridgeDto(5, 10);
    await renderWith({
      ...value,
      otherTheaterTotals: { costUsd: 3, input: 0, output: 0, cacheRead: 0, messages: 0 },
    });
    expect(bridgeText()).toContain("This Theater's operations");
    expect(bridgeText()).toContain("Other theaters' operations");
    expect(bridgeText()).toContain("$3.00");
    expect(bridgeText()).toContain("Other local sessions");
    expect(bridgeText()).toContain("$2.00");
    expect(container.querySelector(".ledger-bridge-other-theater")).not.toBeNull();
    // ARIA 라벨도 3버킷을 그대로 말해야 한다(시각 범례와 모순 금지).
    const aria = container.querySelector(".ledger-bridge-bar")?.getAttribute("aria-label") ?? "";
    expect(aria).toContain("this Theater's operations");
    expect(aria).toContain("$3.00 to other theaters' operations");
    expect(aria).toContain("$2.00 to other local sessions");
  });

  it("hides the other-theater bucket in all-theaters scope even if the payload carries one", async () => {
    const value = bridgeDto(5, 10);
    const payload = {
      ...value,
      scope: { theaterId: null, window: "week" as const },
      otherTheaterTotals: { costUsd: 3, input: 0, output: 0, cacheRead: 0, messages: 0 },
    };
    const fetch = vi.fn(async () => ({ json: async () => payload } as Response));
    await act(async () => {
      root.render(ledgerPanel.render({ ...context(fetch), theaterId: null }));
    });
    expect(bridgeText()).toContain("Console operations");
    expect(bridgeText()).not.toContain("Other theaters' operations");
    expect(container.querySelector(".ledger-bridge-other-theater")).toBeNull();
  });
});

describe("Ledger unmatched capping and sort interleave", () => {
  function ghost(index: number, lastActivityAtMs: number) {
    return {
      operationId: `ghost-${index}`,
      title: `Ghost ${index}`,
      cliId: "codex",
      cliLabel: "Codex",
      lastActivityAtMs,
    };
  }

  it("renders at most five ghost rows and rolls the rest into a +N line", async () => {
    const now = Date.now();
    const value = dto("ok");
    await renderWith({
      ...value,
      unmatched: Array.from({ length: 7 }, (_, index) => ghost(index, now - (index + 1) * 60_000)),
      unmatchedTotal: 7,
    });
    expect(container.querySelectorAll(".ledger-operation--unmatched")).toHaveLength(5);
    expect(container.textContent).toContain("+2 more unmatched");
    expect(container.textContent).toContain("1 matched · 7 unmatched");
  });

  it("interleaves ghost rows by activity in recent-activity mode and groups them in cost mode", async () => {
    const now = Date.now();
    const value = dto("ok");
    const staleMatched = { ...value.operations[0]!, title: "Stale Matched", lastActivityAtMs: now - 3_600_000 };
    await renderWith({
      ...value,
      operations: [staleMatched],
      unmatched: [ghost(0, now)],
      unmatchedTotal: 1,
    });
    const titles = () => [...container.querySelectorAll(".ledger-operation .ledger-operation-copy strong")].map((node) => node.textContent);
    expect(titles()).toEqual(["Ghost 0", "Stale Matched"]);

    const costSort = [...container.querySelectorAll<HTMLElement>(".ledger-segment button")].find((button) => button.textContent === "Highest cost");
    await act(async () => costSort!.click());
    expect(titles()).toEqual(["Stale Matched", "Ghost 0"]);
  });

  it("breaks cost-sort ties by recent activity", async () => {
    const now = Date.now();
    const value = dto("ok");
    await renderWith({
      ...value,
      operations: [
        { ...value.operations[0]!, operationId: "older", title: "Older Same Cost", costUsd: 10, lastActivityAtMs: now - 60_000 },
        { ...value.operations[0]!, operationId: "newer", title: "Newer Same Cost", costUsd: 10, lastActivityAtMs: now },
      ],
    });
    const costSort = [...container.querySelectorAll<HTMLElement>(".ledger-segment button")].find((button) => button.textContent === "Highest cost");
    await act(async () => costSort!.click());
    const titles = [...container.querySelectorAll(".ledger-operation .ledger-operation-copy strong")].map((node) => node.textContent);
    expect(titles).toEqual(["Newer Same Cost", "Older Same Cost"]);
  });
});

describe("Ledger trend scale and attributed layer", () => {
  const twoDay = [
    { day: "2026-08-13", costUsd: 100 },
    { day: "2026-08-14", costUsd: 1 },
  ];

  function trendDto(attributedSecond: number): LedgerSummaryDto {
    const value = dto("ok", "week", 12.34, 0, twoDay);
    return {
      ...value,
      dailyAttributed: [
        { day: "2026-08-13", costUsd: 0 },
        { day: "2026-08-14", costUsd: attributedSecond },
      ],
    };
  }

  it("renders the attributed layer only on days with attributed cost and labels it with the scale", async () => {
    await renderWith(trendDto(0.5));
    const bars = [...container.querySelectorAll(".ledger-trend-bar")];
    expect(bars[0]!.querySelector(".ledger-trend-bar-attributed")).toBeNull();
    const layer = bars[1]!.querySelector(".ledger-trend-bar-attributed");
    expect(layer).not.toBeNull();
    expect(bars[1]!.getAttribute("aria-label")).toBe("Aug 14 · $1.00 · attributed $0.50 · Linear scale");
    expect(container.textContent).toContain("Bright layer: cost attributed to this scope's Console operations.");
    expect(container.textContent).toContain("Linear scale — bar height is proportional to cost.");
  });

  it("rescales bar heights on the square-root toggle and says so in the note and aria", async () => {
    await renderWith(trendDto(0));
    const heights = () => [...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")].map((bar) => bar.style.height);
    const linearHeights = heights();
    expect(linearHeights[0]).toBe("100%");
    expect(Number.parseFloat(linearHeights[1]!)).toBeCloseTo(3, 5);

    const sqrt = [...container.querySelectorAll<HTMLElement>(".ledger-segment button")].find((button) => button.textContent === "Square root");
    await act(async () => sqrt!.click());
    const sqrtHeights = heights();
    // sqrt(1)/sqrt(100) = 10% — 선형의 1%(최소 3% 클램프) 위로 작은 날이 살아난다.
    expect(Number.parseFloat(sqrtHeights[1]!)).toBeCloseTo(10, 5);
    expect(container.textContent).toContain("Square-root scale — heights follow √cost so small days stay readable; compare labels, not heights.");

    await renderWith(trendDto(0.5));
    const sqrtAgain = [...container.querySelectorAll<HTMLElement>(".ledger-segment button")].find((button) => button.textContent === "Square root");
    await act(async () => sqrtAgain!.click());
    const bars = [...container.querySelectorAll(".ledger-trend-bar")];
    expect(bars[1]!.getAttribute("aria-label")).toBe("Aug 14 · $1.00 · attributed $0.50 · Square root scale");
  });
});
