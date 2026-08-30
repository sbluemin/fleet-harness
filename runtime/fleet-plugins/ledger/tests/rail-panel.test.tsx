// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { PaneContext } from "@fleet-console/sdk/pane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ledgerEn, ledgerKo } from "../client/i18n/messages.js";
import { ledgerPane } from "../client/rail-panel.js";
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
  usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0 },
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
    totals: { costUsd, input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0, messages: 4 },
    modelRows: rows,
    modelCount: rows.length,
    daily,
    dailyDetails: daily.filter((point) => point.costUsd > 0).map((point) => ({
      day: point.day,
      costUsd: point.costUsd,
      usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0 },
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

function context(fetchImpl: PaneContext["api"]["fetch"]): PaneContext {
  return {
    paneId: "ledger",
    instanceId: "ledger-1",
    params: {},
    role: "primary",
    mount: "rail",
    width: 392,
    visible: true,
    focused: false,
    theaterId: "theater-a",
    api: { fetch: fetchImpl, subscribe: vi.fn(), resync: vi.fn() },
    // 본문은 api와 language만 읽는다. 나머지 호스트 능력은 이 테스트의 사정권 밖이라
    // 최소 스텁으로 둔다 — 채워 넣으면 계약이 아니라 스텁을 검증하게 된다.
    lifecycle: {} as PaneContext["lifecycle"],
    preferences: {} as PaneContext["preferences"],
    panes: { open: vi.fn(), close: vi.fn(), replaceParams: vi.fn(), isOpen: () => false },
    signal: new AbortController().signal,
    language: "en",
  };
}

async function renderWith(value: LedgerSummaryDto): Promise<ReturnType<typeof vi.fn>> {
  const fetch = vi.fn(async () => ({ json: async () => value } as Response));
  await act(async () => root.render(ledgerPane.render(context(fetch))));
  return fetch;
}

async function renderWindowWith(value: LedgerSummaryDto, label: "Today" | "This month"): Promise<void> {
  const fetch = vi.fn(async (_pluginId: string, path: string) => ({
    json: async () => path.includes(`window=${value.scope.window}`) ? value : dto("ok", "week", 0),
  } as Response));
  await act(async () => root.render(ledgerPane.render(context(fetch))));
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === label);
  await act(async () => button!.click());
}

async function renderTodayWith(value: LedgerSummaryDto): Promise<void> {
  await renderWindowWith(value, "Today");
}

function backendHeads(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".ledger-backend-head")];
}

async function expandBackend(label: string): Promise<void> {
  const head = backendHeads().find((candidate) => candidate.textContent?.startsWith(label));
  await act(async () => head!.click());
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
    expect(container.textContent).toContain("Grouped by backend.");
    expect(container.querySelector(".ledger-client-mark.is-anthropic")).not.toBeNull();
    expect(container.querySelector(".ledger-client-mark.is-xai")).not.toBeNull();
    expect(container.textContent).toContain("Total tokens");
    expect(container.textContent).not.toMatch(/Operation|Theater|device-wide/i);
  });

  it("folds model rows into cost-ranked backends and opens one on demand", async () => {
    const value = dto();
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 15 },
      modelRows: [
        { ...modelRow, costUsd: 12 },
        { ...modelRow, modelId: "claude-gateway--xai--grok-4.6", provider: "xai", label: "Grok 4.6", costUsd: 3 },
      ],
      modelCount: 2,
    });

    // Backends carry the money; individual models stay behind a disclosure.
    expect(backendHeads().map((head) => head.textContent)).toEqual([
      expect.stringContaining("Anthropic80%"),
      expect.stringContaining("xAI20%"),
    ]);
    expect(container.querySelector(".ledger-client-row")).toBeNull();
    expect(backendHeads()[0]?.getAttribute("aria-label")).toBe("Anthropic · $12.00 · 2k tokens · 80% of spend");

    await expandBackend("Anthropic");
    expect(backendHeads()[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Claude Opus 5Anthropic");
    expect(container.textContent).not.toContain("Grok 4.6xAI");

    await expandBackend("Anthropic");
    expect(container.querySelector(".ledger-client-row")).toBeNull();
  });

  it("paints one composition slice per backend and only when a split exists", async () => {
    const value = dto();
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 15 },
      modelRows: [
        { ...modelRow, costUsd: 12 },
        { ...modelRow, modelId: "claude-gateway--xai--grok-4.6", provider: "xai", label: "Grok 4.6", costUsd: 3 },
      ],
      modelCount: 2,
    });
    const slices = [...container.querySelectorAll<HTMLElement>(".ledger-backend-slice")];
    expect(slices.map((slice) => slice.className)).toEqual([
      "ledger-backend-slice is-anthropic",
      "ledger-backend-slice is-xai",
    ]);
    expect(slices.map((slice) => slice.style.flexGrow)).toEqual(["12", "3"]);

    await renderWith(dto("ok", "week", 0));
    expect(container.querySelector(".ledger-backend-composition")).toBeNull();
  });

  it("gives no composition width to a backend that spent nothing", async () => {
    const value = dto();
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 12 },
      modelRows: [
        { ...modelRow, costUsd: 12 },
        { ...modelRow, modelId: "claude-gateway--xai--grok-4.6", provider: "xai", label: "Grok 4.6", costUsd: 0, messages: 40 },
      ],
      modelCount: 2,
    });
    // 조각에는 `min-width` 하한이 있어, $0 그룹을 남기면 스스로 `0%`라 말하면서 실제 지출과 같은 폭을 갖는다.
    expect([...container.querySelectorAll<HTMLElement>(".ledger-backend-slice")].map((slice) => slice.className))
      .toEqual(["ledger-backend-slice is-anthropic"]);
    // 행은 사라지지 않는다 — 쓴 토큰은 여전히 그 백엔드의 것이다.
    expect(backendHeads().map((head) => head.querySelector("strong")?.textContent)).toEqual(["Anthropic", "xAI"]);
  });

  it("never rounds a nonzero backend share to 0% or a partial share to 100%", async () => {
    const value = dto();
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 10_000 },
      modelRows: [
        { ...modelRow, costUsd: 9_999.5 },
        { ...modelRow, modelId: "claude-gateway--xai--grok-4.6", provider: "xai", label: "Grok 4.6", costUsd: 0.5 },
      ],
      modelCount: 2,
    });
    expect(backendHeads().map((head) => head.querySelector("small")?.textContent)).toEqual([">99.9%", "<0.1%"]);
  });

  it("strands no model behind an opened backend", async () => {
    const value = dto();
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...modelRow,
      modelId: `claude-opus-5-${index}`,
      label: `Model ${index}`,
      costUsd: 10 - index,
    }));
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 49 },
      modelRows: rows,
      modelCount: 7,
    });
    await expandBackend("Anthropic");
    // 서버가 보낸 행을 클라이언트가 다시 자르면 그 모델에 닿을 길이 사라진다.
    expect(container.querySelectorAll(".ledger-client-row")).toHaveLength(7);
    expect(container.textContent).not.toContain("more models");
  });

  it("closes the composition bar against the window total, not the grouped subtotal", async () => {
    const value = dto();
    await renderWith({
      ...value,
      // 80행 상한과 날짜 없는 기록 때문에 모델 행 합계는 창 합계보다 작을 수 있다.
      totals: { ...value.totals, costUsd: 100 },
      modelRows: [
        { ...modelRow, costUsd: 60 },
        { ...modelRow, modelId: "claude-gateway--xai--grok-4.6", provider: "xai", label: "Grok 4.6", costUsd: 30 },
      ],
      modelCount: 2,
    });
    const slices = [...container.querySelectorAll<HTMLElement>(".ledger-backend-slice")];
    expect(slices.map((slice) => slice.style.flexGrow)).toEqual(["60", "30", "10"]);
    expect(slices[2]?.className).toContain("ledger-backend-slice--remainder");
    expect(slices[2]?.getAttribute("title")).toBe("Not attributed to a listed backend · $10.00 · 10%");
    // 폭의 분모와 라벨의 분모가 같아야 60%가 60%로 읽힌다.
    expect(backendHeads().map((head) => head.querySelector("small")?.textContent)).toEqual(["60%", "30%"]);
  });

  it("still paints a composition bar when one backend holds every grouped dollar", async () => {
    await renderWith(dto());
    const slices = [...container.querySelectorAll<HTMLElement>(".ledger-backend-slice")];
    expect(slices).toHaveLength(1);
    expect(container.querySelector(".ledger-backend-slice--remainder")).toBeNull();
  });

  it("names the token total it shows in the backend accessible name", async () => {
    await renderWith(dto());
    expect(backendHeads()[0]?.getAttribute("aria-label"))
      .toBe("Anthropic · $12.34 · 2k tokens · 100% of spend");
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
    expect(backendHeads()[0]?.querySelector("strong")?.textContent).toBe("OpenCode");
    await expandBackend("OpenCode");
    expect(container.querySelector(".ledger-client-copy small")?.textContent).toBe("OpenCode");
  });

  it("includes cache-write tokens in displayed token totals", async () => {
    const value = dto();
    await renderWith({
      ...value,
      totals: { ...value.totals, cacheWrite: 500 },
      modelRows: [{
        ...modelRow,
        usage: { ...modelRow.usage, cacheWrite: 500 },
      }],
    });
    expect(container.querySelector(".ledger-total-token")?.textContent).toContain("2k");
    expect(container.querySelector(".ledger-backend-values")?.textContent).toContain("2k");
    await expandBackend("Anthropic");
    expect(container.querySelector(".ledger-client-values")?.textContent).toContain("2k");
  });

  it("reports omitted model rows from the uncapped count", async () => {
    const value = dto();
    await renderWith({ ...value, modelCount: 81 });
    expect(container.textContent).toContain("+80 more models");
  });
});

describe("Ledger daily model detail", () => {
  it("explains last-active-day attribution in both languages", () => {
    expect(ledgerEn["ledger.trend.explanation"]).toBe(
      "Each session-model row counts in full on its last-active local day, so a session spanning midnight lands entirely on the later day.",
    );
    expect(ledgerKo["ledger.trend.explanation"]).toBe(
      "각 세션-모델 기록은 마지막으로 활동한 현지 날짜에 전액 반영되므로, 자정을 넘긴 세션은 전부 다음 날에 반영됩니다.",
    );
  });

  it("labels every bar and opens no detail until a day is chosen", async () => {
    await renderTodayWith(trendDto("today"));
    const bars = [...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")];
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Aug 13 · $1.25 · Linear scale",
      "Aug 14 · $12.34 · Linear scale",
    ]);
    expect(bars[1]?.querySelector(".ledger-trend-tooltip")?.textContent).toContain("$12.34");
    // 자동 선택은 창 전체 목록과 하루 목록을 같은 화면에 겹쳐 그렸다 — 선택은 클릭에서만 시작한다.
    expect(bars.every((bar) => bar.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(container.querySelector(".ledger-daily-detail")).toBeNull();
    expect(container.textContent).toContain("Select a day to see the models that ran on it.");
  });

  it.each(["today", "week", "month"] as const)("opens a day's models in the %s window", async (window) => {
    const value = trendDto(window);
    if (window === "month") await renderWindowWith(value, "This month");
    else if (window === "today") await renderTodayWith(value);
    else await renderWith(value);

    const bars = [...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")];
    expect(bars.map((bar) => bar.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(container.querySelector(".ledger-daily-detail")).toBeNull();

    await act(async () => (bars[1] as HTMLButtonElement).click());
    expect(bars[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Aug 14 model detail");

    await act(async () => (bars[0] as HTMLButtonElement).click());
    expect(bars[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(bars[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Aug 13 model detail");

    // Pressing the selected day again closes it, so the disclosure is reversible.
    await act(async () => (bars[0] as HTMLButtonElement).click());
    expect(container.querySelector(".ledger-daily-detail")).toBeNull();
  });

  it("draws a day with no detail as a mark, never as a control", async () => {
    const value = dto("ok", "week", 12.34, [
      { day: "2026-08-13", costUsd: 0 },
      { day: "2026-08-14", costUsd: 12.34 },
    ]);
    await renderWith({ ...value, generatedAtMs: new Date(2026, 7, 14, 12).getTime() });
    const bars = [...container.querySelectorAll<HTMLElement>(".ledger-trend-bar")];
    expect(bars.map((bar) => bar.tagName)).toEqual(["DIV", "BUTTON"]);
    expect(bars[0]?.getAttribute("role")).toBe("img");
    expect(bars[0]?.className).toContain("ledger-trend-bar--inert");
    // `aria-disabled` 만 붙은 <button>은 탭 순서에 남아 죽은 정지점이 된다 — 그 형태는 더 이상 없다.
    expect(container.querySelector("[aria-disabled]")).toBeNull();
    expect(bars[0]?.getAttribute("aria-label")).toBe("Aug 13 · $0.00 · Linear scale");
  });

  it("labels days from the server's day keys, never from the browser clock", async () => {
    const value = trendDto("today");
    await renderTodayWith({
      ...value,
      // 브라우저가 보는 생성 시각이 하루 이르더라도 축·상세 라벨은 서버가 준 날짜 키를 따른다.
      generatedAtMs: new Date(2026, 7, 13, 12).getTime(),
      currentDay: "2026-08-14",
    });
    expect([...container.querySelectorAll(".ledger-trend-axis span")].map((node) => node.textContent))
      .toEqual(["Aug 13", "Aug 14"]);
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".ledger-trend-bar")];
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Aug 13 · $1.25 · Linear scale",
      "Aug 14 · $12.34 · Linear scale",
    ]);
    await act(async () => bars[1]!.click());
    expect(container.textContent).toContain("Aug 14 model detail");
  });

  it("names the undated remainder in dollars and caps the chart with it", async () => {
    const value = trendDto("week");
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 20 },
      dailySource: { unmatchedEntries: 3 },
    });
    // hero $20.00 - dated ($1.25 + $12.34) = $6.41
    expect(container.querySelector(".ledger-trend-residual")?.textContent)
      .toContain("$6.41 is in the total but not on the chart — 3 records carry no day.");
    const cap = container.querySelector<HTMLElement>(".ledger-trend-residual-cap");
    expect(cap?.tagName).toBe("DIV");
    expect(cap?.getAttribute("aria-label"))
      .toBe("Undated remainder $6.41, in the total but not on any day.");
    // 툴팁은 `.ledger-trend-bars` 폭을 기준으로 앵커된다 — 마개가 그 안에 있으면 모든 날짜가 밀린다.
    expect(container.querySelector(".ledger-trend-bars .ledger-trend-residual-cap")).toBeNull();
    expect(container.querySelectorAll(".ledger-trend-bars > *")).toHaveLength(2);
  });

  it("stays silent when every record carries a day", async () => {
    const value = trendDto("week");
    await renderWith({ ...value, totals: { ...value.totals, costUsd: 13.59 } });
    expect(container.querySelector(".ledger-trend-residual")).toBeNull();
    expect(container.querySelector(".ledger-trend-residual-cap")).toBeNull();
  });

  it("names a gap the undated records do not explain", async () => {
    const value = trendDto("week");
    await renderWith({ ...value, totals: { ...value.totals, costUsd: 20 } });
    // 날짜 없는 기록이 0이어도 히어로와 차트가 어긋나면 침묵하지 않는다(예: 일별 축의 366일 상한).
    expect(container.querySelector(".ledger-trend-residual")?.textContent)
      .toContain("$6.41 is in the total but not on the chart.");
    expect(container.querySelector(".ledger-trend-residual")?.textContent).not.toContain("records");
  });

  it("names the whole total in dollars when no record could be dated", async () => {
    const value = dto("ok", "week", 42.5);
    await renderWith({ ...value, daily: [], dailyDetails: [], dailySource: { unmatchedEntries: 3 } });
    // 축이 통째로 비면 부모가 차트를 렌더하지 않아 차트 안의 잔여 문장도 사라진다 —
    // 지출 전액이 빠진 그 상태가 금액을 말해야 할 자리다.
    expect(container.querySelector(".ledger-trend")).toBeNull();
    expect(container.querySelector(".ledger-trend-residual")?.textContent).toContain(
      "No record could be dated, so there is no daily chart. The full $42.50 stays in the total — 3 records carry no day.",
    );
  });

  it("leaves an unreadable report to its own explanation", async () => {
    const value = dto("degraded", "week", 42.5);
    await renderWith({
      ...value,
      daily: [],
      dailyDetails: [],
      dailySource: { unmatchedEntries: 0 },
      source: { ...value.source, status: "degraded", report: "unavailable" },
    });
    // 리포트를 읽지 못한 경우는 `ledger.daily.unavailable`이 이미 정확히 설명한다.
    expect(container.querySelector(".ledger-trend-residual")).toBeNull();
    expect(container.textContent).toContain("Daily detail is unavailable, but the model totals above remain complete.");
  });

  it("stays silent when the remainder rounds away below a cent", async () => {
    const value = trendDto("week");
    await renderWith({
      ...value,
      totals: { ...value.totals, costUsd: 13.592 },
      dailySource: { unmatchedEntries: 1 },
    });
    expect(container.querySelector(".ledger-trend-residual")).toBeNull();
    expect(container.querySelector(".ledger-trend-residual-cap")).toBeNull();
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
    await act(async () => root.render(ledgerPane.render(context(fetch))));
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
    await act(async () => root.render(ledgerPane.render(context(fetch))));
    expect(container.textContent).toContain("Could not load usage");
    expect(container.textContent).toContain("Retry");
  });
});
