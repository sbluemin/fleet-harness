import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { QuotaWindow } from "@dotobokuri/core-ai-gateway";

import {
  beginRequestGeneration,
  elapsedMarkPercent,
  EXPIRED_KEY,
  FOLDED_STATUS_KEY,
  foldedWindow,
  formatCountdown,
  formatPace,
  formatResetInstant,
  isLatestRequestGeneration,
  meterSeverity,
  movedProviderOrder,
  NO_SUBSCRIPTION_KEY,
  projectedSpan,
  PROVIDER_ORDER_DEFAULT,
  riskNote,
  sanitizeFoldedProviders,
  sanitizeProviderOrder,
  SIGNED_OUT_KEY,
  toggledFoldedProviders,
  visibleCredits,
} from "../client/rail-panel.js";
import { providerGlyph } from "../client/cli-glyphs.js";
import { QUOTA_MESSAGES } from "../client/i18n/messages.js";

describe("quota countdown", () => {
  it("formats day, hour, and minute windows", () => {
    const now = 1_000_000;
    expect(formatCountdown(now + 4 * 86_400_000 + 7 * 3_600_000, now)).toBe("4d 7h");
    expect(formatCountdown(now + 4 * 3_600_000 + 23 * 60_000, now)).toBe("4h 23m");
    expect(formatCountdown(now + 12 * 60_000, now)).toBe("12m");
  });

  it("prevents an older in-flight request from committing after a newer request starts", () => {
    const generation = { current: 0 };
    const staleRequest = beginRequestGeneration(generation);
    const newestRequest = beginRequestGeneration(generation);
    expect(isLatestRequestGeneration(generation, staleRequest)).toBe(false);
    expect(isLatestRequestGeneration(generation, newestRequest)).toBe(true);
  });
});

describe("quota reset instant", () => {
  const now = new Date(2026, 7, 16, 12, 0, 0).getTime();

  it("names the calendar date once the reset is more than a day away", () => {
    const wednesday = new Date(2026, 7, 19, 23, 0, 0).getTime();
    expect(formatResetInstant(wednesday, now, "ko")).toBe("8월 19일 (수) 23시");
    expect(formatResetInstant(wednesday, now, "en")).toBe("Aug 19 (Wed) 23:00");
  });

  it("names the local 24-hour clock when the reset is a day or less away", () => {
    const tonight = new Date(2026, 7, 16, 23, 0, 0).getTime();
    const tomorrowMorning = new Date(2026, 7, 17, 0, 30, 0).getTime();
    expect(formatResetInstant(tonight, now, "ko")).toBe("23:00");
    expect(formatResetInstant(tonight, now, "en")).toBe("23:00");
    expect(formatResetInstant(tomorrowMorning, now, "ko")).toBe("00:30");
  });

  it("switches from clock to date at the day boundary", () => {
    const atBoundary = now + 86_400_000;
    const justOver = now + 86_400_000 + 1;
    expect(formatResetInstant(atBoundary, now, "ko")).toBe("12:00");
    expect(formatResetInstant(justOver, now, "ko")).toBe("8월 17일 (월) 12시");
  });

  it("returns null when the timestamp is not a real instant", () => {
    expect(formatResetInstant(undefined, now, "ko")).toBeNull();
    expect(formatResetInstant(Number.NaN, now, "ko")).toBeNull();
    expect(formatResetInstant(Number.POSITIVE_INFINITY, now, "en")).toBeNull();
  });
});

describe("meter risk", () => {
  function window(usedPercent: number, risk?: QuotaWindow["risk"]): QuotaWindow {
    return { id: "weekly", usedPercent, ...(risk ? { risk } : {}) };
  }

  // The note names its key so the assertions read as "which sentence", not "which wording".
  const t = ((key: string, vars?: Record<string, unknown>) =>
    `${key}(${Object.entries(vars ?? {}).map(([name, value]) => `${name}=${String(value)}`).join(",")})`
  ) as unknown as Parameters<typeof riskNote>[2];

  // The defect this replaced: a pool 44% spent a fifth of the way into its week
  // is on track to run dry days early, and the gateway says so — but a local
  // 70/90 percent band painted it calm, so the panel and the roster a model
  // reads disagreed about the same allowance.
  it("takes its severity from the gateway verdict, not from the percentage", () => {
    expect(meterSeverity(window(44, { pressure: "critical", paceRatio: 2.11 }))).toBe("critical");
    expect(meterSeverity(window(92, { pressure: "ok", paceRatio: 0.4 }))).toBe("normal");
    expect(meterSeverity(window(85, { pressure: "elevated", paceRatio: 1.2 }))).toBe("warning");
  });

  it("falls back to percent bands only when no verdict arrived", () => {
    expect(meterSeverity(window(95))).toBe("critical");
    expect(meterSeverity(window(75))).toBe("warning");
    expect(meterSeverity(window(10))).toBe("normal");
  });

  it("spans the projection from what is spent to the end of the bar", () => {
    expect(projectedSpan(window(44, { pressure: "critical", projectedExhaustionAt: 5 }), 0))
      .toEqual({ left: 44, width: 56 });
  });

  it("draws no projection when the window lasts to its reset", () => {
    expect(projectedSpan(window(44, { pressure: "ok" }), 0)).toBeNull();
    // A drained pool has no remaining stretch to project into.
    expect(projectedSpan(window(100, { pressure: "critical", projectedExhaustionAt: 5 }), 0)).toBeNull();
  });

  // The hatching and the note are two renderings of one forecast. Suppressing the
  // lapsed one in the text while the picture kept claiming "this much is spent
  // before the reset" left the meter asserting what its own caption had withdrawn.
  it("withdraws the hatching once the projected instant has passed", () => {
    const now = 1_000_000;
    const spent = window(44, { pressure: "critical", paceRatio: 2.11, projectedExhaustionAt: now - 60_000 });
    expect(projectedSpan(spent, now)).toBeNull();
    expect(riskNote(spent, now, t)).toBe("quota.meter.pace(n=2.1)");
    const ahead = window(44, { pressure: "critical", paceRatio: 2.11, projectedExhaustionAt: now + 60_000 });
    expect(projectedSpan(ahead, now)).toEqual({ left: 44, width: 56 });
  });

  it("places the elapsed mark only when the window's clock is known", () => {
    expect(elapsedMarkPercent(window(44, { pressure: "critical", elapsedFraction: 0.21 }))).toBe(21);
    expect(elapsedMarkPercent(window(44, { pressure: "ok" }))).toBeNull();
  });

  it("states pace to one decimal", () => {
    expect(formatPace(2.11)).toBe("2.1");
    expect(formatPace(1)).toBe("1");
  });

  it("forecasts exhaustion only while the projection is still ahead", () => {
    const now = 1_000_000;
    expect(riskNote(window(44, { pressure: "critical", paceRatio: 2.11, projectedExhaustionAt: now + 3_600_000 }), now, t))
      .toBe("quota.meter.exhausts(t=1h 0m)");
  });

  // A reading outlives its forecast: the summary is cached for two minutes and served
  // stale for thirty, so the target can pass before the next one lands. The countdown
  // clamps to zero there, which announced "at this pace, out in 0m" — a lapsed forecast
  // read as a future one. The pace is what the same reading still supports.
  it("falls back to pace once the projected instant has passed", () => {
    const now = 1_000_000;
    expect(riskNote(window(44, { pressure: "critical", paceRatio: 2.11, projectedExhaustionAt: now - 60_000 }), now, t))
      .toBe("quota.meter.pace(n=2.1)");
    expect(riskNote(window(44, { pressure: "critical", paceRatio: 2.11, projectedExhaustionAt: now }), now, t))
      .toBe("quota.meter.pace(n=2.1)");
  });

  it("says nothing when a calm window has no forecast to report", () => {
    expect(riskNote(window(44, { pressure: "ok", paceRatio: 0.4 }), 1_000_000, t)).toBeNull();
    expect(riskNote(window(44), 1_000_000, t)).toBeNull();
  });
});

describe("reset credits", () => {
  // Codex는 보유량 0에도 크레딧 객체를 준다. 그대로 그리면 카드가 상시로 "0" 한 줄을
  // 차지하는데, 그 줄이 알리는 사실은 없다.
  it("shows the row only when at least one credit is held", () => {
    expect(visibleCredits({ available: 2 })).toEqual({ available: 2 });
    expect(visibleCredits({ available: 0 })).toBeNull();
    expect(visibleCredits({ available: 0, nextExpiresAt: 1_000 })).toBeNull();
    expect(visibleCredits(undefined)).toBeNull();
  });

  // 문구가 API 용어를 그대로 노출하면 카드의 나머지 카피와 어긋난다.
  it("names the credits in product language, not in the upstream endpoint's", () => {
    expect(QUOTA_MESSAGES.en["quota.credits"]).not.toContain("rate-limit");
    expect(QUOTA_MESSAGES.ko["quota.credits"]).not.toContain("rate-limit");
  });
});

describe("provider glyphs", () => {
  it("renders the Grok product mark at the quota header size", () => {
    const markup = renderToStaticMarkup(createElement("span", null, providerGlyph("xai")));
    expect(markup).toContain('viewBox="0 0 512 512"');
    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
  });

  it("renders the previous OpenCode square mark at the quota header size", () => {
    const markup = renderToStaticMarkup(createElement("span", null, providerGlyph("opencode")));
    expect(markup).toContain('viewBox="0 0 240 300"');
    expect(markup).toContain('width="13"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('opacity="0.45"');
  });
});

describe("provider status copy", () => {
  // 상태 문구는 해당 공급자에서 무엇을 해야 하는지 지시한다. 한 공급자의 안내가 다른
  // 공급자 카드에 뜨면 사용자는 엉뚱한 CLI나 설정 화면으로 보내진다.
  it("names its own provider in every provider-specific message", () => {
    const en = QUOTA_MESSAGES.en;
    const expectedMention: Readonly<Record<string, string>> = {
      antigravity: "Antigravity",
      claude: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      kimi: "Kimi",
      opencode: "OpenCode Go",
      xai: "Grok CLI",
    };
    for (const map of [SIGNED_OUT_KEY, EXPIRED_KEY]) {
      for (const [provider, key] of Object.entries(map)) {
        expect(en[key], `${provider} → ${key}`).toContain(expectedMention[provider] ?? provider);
      }
    }
    // Kimi가 공용 문구를 타면 "No active Cursor subscription." 이 뜬다.
    expect(en[NO_SUBSCRIPTION_KEY.kimi]).toContain("Kimi");
    expect(en[NO_SUBSCRIPTION_KEY.kimi]).not.toContain("Cursor");
    expect(en[NO_SUBSCRIPTION_KEY.cursor]).toContain("Cursor");
    expect(en[NO_SUBSCRIPTION_KEY.opencode]).toContain("OpenCode Go");
    expect(en[NO_SUBSCRIPTION_KEY.opencode]).not.toContain("Cursor");
  });
});

describe("provider order", () => {
  // 옛 릴리스의 설정 파일이 살아남는다: 모르는 id를 담거나 그 사이 추가된 공급자를
  // 빠뜨린 순서라도 카드가 전부, 정확히 한 번씩 그려져야 한다.
  it("drops unknown ids, dedupes, and appends missing providers in default order", () => {
    expect(sanitizeProviderOrder(["opencode", "bogus", "claude", "opencode"]))
      .toEqual(["opencode", "claude", "codex", "xai", "cursor", "kimi", "antigravity"]);
    expect(sanitizeProviderOrder(undefined)).toEqual([...PROVIDER_ORDER_DEFAULT]);
    expect(sanitizeProviderOrder("claude")).toEqual([...PROVIDER_ORDER_DEFAULT]);
  });

  it("moves a provider one step and refuses to cross the list boundary", () => {
    expect(movedProviderOrder(PROVIDER_ORDER_DEFAULT, "cursor", -1))
      .toEqual(["claude", "codex", "cursor", "xai", "opencode", "kimi", "antigravity"]);
    expect(movedProviderOrder(PROVIDER_ORDER_DEFAULT, "cursor", 1))
      .toEqual(["claude", "codex", "xai", "opencode", "cursor", "kimi", "antigravity"]);
    expect(movedProviderOrder(PROVIDER_ORDER_DEFAULT, "claude", -1)).toBeNull();
    expect(movedProviderOrder(PROVIDER_ORDER_DEFAULT, "antigravity", 1)).toBeNull();
  });
});

describe("folded card summary", () => {
  function pool(usedPercent: number, extra: Partial<QuotaWindow> = {}): QuotaWindow {
    return { id: "weekly", usedPercent, ...extra };
  }

  // 접힌 행이 대변할 창은 "가장 많이 쓴 창"이 아니라 "가장 급한 창"이다. 회차의 5분의 1
  // 지점에서 44%를 쓴 창은 게이트웨이가 critical로 판정하고, 퍼센트만 보는 비교는 그
  // 사실을 보지 못해 조용한 60% 창을 대표로 세운다.
  it("lets the gateway's verdict outrank the raw percentage", () => {
    const calm = pool(60, { risk: { pressure: "ok" } });
    const urgent = pool(44, { risk: { pressure: "critical" } });
    expect(foldedWindow([calm, urgent])).toBe(urgent);
    expect(foldedWindow([urgent, calm])).toBe(urgent);
  });

  it("breaks a severity tie on how much of the pool is spent", () => {
    const lighter = pool(30, { risk: { pressure: "elevated" } });
    const heavier = pool(72, { risk: { pressure: "elevated" } });
    expect(foldedWindow([lighter, heavier])).toBe(heavier);
  });

  // 집계 창은 형제 창들의 합이라 개별 풀이 말라도 평온하게 읽힌다. 그 창을 대표로
  // 세우면 접힌 행은 "여유 있음"을 말하는데 실제로 모델이 당기는 풀은 비어 있다.
  it("never speaks for an aggregate window while a real pool is present", () => {
    const total = pool(40, { isAggregate: true });
    const drained = pool(98, { scope: "api" });
    expect(foldedWindow([total, drained])).toBe(drained);
    // 집계뿐이면 그것이 이 공급자가 가진 전부다.
    expect(foldedWindow([total])).toBe(total);
  });

  it("has nothing to say without a window", () => {
    expect(foldedWindow(undefined)).toBeNull();
    expect(foldedWindow([])).toBeNull();
  });

  // 수치가 없는 카드가 이름만 남으면 아직 못 읽은 카드와 구분되지 않는다. 사용자가
  // 손을 써야 하는 상태에는 전부 접힌 행에 남을 한 마디가 있어야 한다.
  it("names a reason for every status that carries no reading", () => {
    for (const status of ["not_connected", "signed_out", "expired", "no_subscription", "error", "stale"] as const) {
      expect(FOLDED_STATUS_KEY[status], status).toBeDefined();
    }
  });
});

describe("folded providers", () => {
  // 옛 설정 파일이 살아남는다. 순서와 달리 빠진 id를 채우지 않는 것이 계약이다 —
  // 목록에 없다는 것이 곧 "펼침"이고, 채우면 모든 카드가 접힌 채로 열린다.
  it("drops unknown ids, dedupes, and leaves absent providers expanded", () => {
    expect(sanitizeFoldedProviders(["kimi", "bogus", "claude", "kimi"])).toEqual(["claude", "kimi"]);
    expect(sanitizeFoldedProviders(undefined)).toEqual([]);
    expect(sanitizeFoldedProviders("claude")).toEqual([]);
    expect(sanitizeFoldedProviders([])).toEqual([]);
  });

  // 같은 집합이 늘 같은 페이로드여야 저장이 순서 때문에 다시 쓰이지 않는다.
  it("normalises to the default order however the set was built", () => {
    expect(sanitizeFoldedProviders(["antigravity", "claude", "xai"]))
      .toEqual(["claude", "xai", "antigravity"]);
  });

  it("toggles one provider without disturbing the rest", () => {
    expect(toggledFoldedProviders([], "codex")).toEqual(["codex"]);
    expect(toggledFoldedProviders(["codex"], "codex")).toEqual([]);
    expect(toggledFoldedProviders(["antigravity", "claude"], "xai"))
      .toEqual(["claude", "xai", "antigravity"]);
  });
});
