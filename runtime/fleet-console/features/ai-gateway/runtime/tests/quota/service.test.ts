import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createQuotaLastGoodStore } from "../../src/quota/last-good.js";
import { createAnthropicSpendLedger } from "../../src/quota/anthropic-ledger.js";
import { priceAnthropicTurn } from "../../src/quota/anthropic-pricing.js";
import { classifyAnthropicBlock } from "../../src/upstream/anthropic/observe.js";
import { createGeminiSpendLedger } from "../../src/quota/gemini-ledger.js";
import { budgetUsedPercent, geminiTokenPrice, spendWeekBounds } from "../../src/quota/gemini-pricing.js";
import { normalizeRoutingQuota } from "../../src/fleet/routing-quota.js";
import { parseMuseCodeSubscriptionUsage } from "../../src/upstream/muse-code/quota.js";
import { createAiGatewayQuotaCollectors, createQuotaService, QUOTA_CACHE_TTL_MS } from "../../src/quota/service.js";
import { createMuseCodeOAuth, MUSE_CODE_AUTH_PROVIDER_ID } from "../../src/oauth/index.js";
import type { AuthStorageEntry } from "../../src/auth/types.js";
import { getJson } from "../../src/quota/windows.js";
import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_USAGE_URL } from "../../src/upstream/opencode-go/coordinates.js";
import type { ProviderResult, ProviderSpend, ProviderSuccess } from "../../src/quota/types.js";

function ok(fetchedAt: number, usedPercent = 10): ProviderSuccess {
  return { status: "ok", fetchedAt, windows: [{ id: "session", usedPercent }] };
}

describe("quota service", () => {
  it("does not read Claude credentials before explicit connection", async () => {
    const fetchClaude = vi.fn(async () => ok(1));
    const service = createQuotaService({
      platform: "darwin",
      isClaudeConnected: async () => false,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
    });
    expect((await service.getSummary()).providers.claude).toEqual({ status: "not_connected", method: "keychain" });
    expect(fetchClaude).not.toHaveBeenCalled();
  });

  it("does not let a forced refresh join a read that a record invalidated", async () => {
    const gates: Array<(value: ProviderResult) => void> = [];
    const fetchXai = vi.fn(() => new Promise<ProviderResult>((resolve) => { gates.push(resolve); }));
    const service = createQuotaService({
      isClaudeConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchXai,
    });
    const first = service.getSummary({ forceProvider: "xai" });
    await Promise.resolve();
    expect(gates).toHaveLength(1);
    service.record("xai", { status: "not_connected" });
    const second = service.getSummary({ forceProvider: "xai" });
    expect(gates).toHaveLength(2);
    gates[0]?.({ status: "ok", windows: [{ id: "session", usedPercent: 1 }], fetchedAt: 1 });
    gates[1]?.({ status: "ok", windows: [{ id: "session", usedPercent: 4 }], fetchedAt: 2 });
    expect((await first).providers.xai.status).toBe("not_connected");
    expect((await second).providers.xai).toMatchObject({ status: "ok", windows: [{ usedPercent: 4 }] });
  });

  it("uses a five-minute cache, serves an expired one without lapsed windows, supports force bypass, and single-flights", async () => {
    let now = 1_000;
    let resolveClaude: ((value: ProviderSuccess) => void) | undefined;
    const fetchClaude = vi.fn(() => new Promise<ProviderSuccess>((resolve) => { resolveClaude = resolve; }));
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
    });
    const first = service.getSummary();
    const second = service.getSummary();
    await Promise.resolve();
    resolveClaude?.({
      ...ok(now),
      windows: [
        { id: "session", usedPercent: 10, resetsAt: now + 200_000 },
        { id: "weekly", usedPercent: 30, resetsAt: now + 7 * 86_400_000 },
      ],
    });
    await Promise.all([first, second]);
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    now += 299_999;
    await service.getSummary();
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    expect(service.readCachedSummary()?.expired).toBe(false);
    now += 1;
    // 만료된 값도 기다림 없이 내주되, 리셋이 지난 창은 이미 틀린 수치라 빠진다.
    const cached = service.readCachedSummary();
    expect(cached?.expired).toBe(true);
    expect(cached?.summary.providers.claude.windows?.map((window) => window.id)).toEqual(["weekly"]);
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    const expired = service.getSummary();
    await Promise.resolve();
    resolveClaude?.(ok(now));
    await expired;
    expect(fetchClaude).toHaveBeenCalledTimes(2);
    now += 1;
    const forced = service.getSummary({ force: true });
    await Promise.resolve();
    resolveClaude?.(ok(now));
    await forced;
    expect(fetchClaude).toHaveBeenCalledTimes(3);
    expect(service.peekSummary()?.providers.claude.fetchedAt).toBe(now);
  });

  it("force-loads only the selected provider and preserves other cached snapshots", async () => {
    let claudeCount = 0;
    let codexCount = 0;
    let xaiCount = 0;
    const fetchClaude = vi.fn(async () => ok(1, 10 + ++claudeCount));
    const fetchCodex = vi.fn(async () => ok(1, 20 + ++codexCount));
    const fetchXai = vi.fn(async () => ok(1, 40 + ++xaiCount));
    const service = createQuotaService({
      now: () => 1_000,
      isClaudeConnected: async () => true,
      fetchClaude,
      fetchCodex,
      fetchXai,
    });
    const cached = await service.getSummary();
    const refreshed = await service.getSummary({ forceProvider: "xai" });
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    expect(fetchCodex).toHaveBeenCalledTimes(1);
    expect(fetchXai).toHaveBeenCalledTimes(2);
    expect(refreshed.providers.claude).toEqual(cached.providers.claude);
    expect(refreshed.providers.codex).toEqual(cached.providers.codex);
    expect(refreshed.providers.xai.windows?.[0]?.usedPercent).toBe(42);
  });

  it("keeps last-good data as stale after any failure until its windows reset, but not for routing", async () => {
    let now = 100_000;
    const fetchClaude = vi.fn()
      .mockResolvedValueOnce({
        status: "ok",
        fetchedAt: now,
        windows: [
          { id: "session", usedPercent: 41, resetsAt: now + 3_600_000 },
          { id: "weekly", usedPercent: 70, resetsAt: now + 7_200_000 },
        ],
      } satisfies ProviderSuccess)
      .mockImplementationOnce(() => getJson(async () => new Response(null, { status: 429 }), "https://quota.example/usage", {}))
      .mockResolvedValueOnce({ status: "error", message: "Credential store unavailable" })
      .mockRejectedValue(new Error("Bearer super-secret upstream unavailable"));
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
    });
    await service.getSummary();
    now += 300_000;
    const limited = (await service.getSummary()).providers.claude;
    expect(limited).toMatchObject({ status: "stale", fetchedAt: 100_000, windows: [{ usedPercent: 41 }, { usedPercent: 70 }] });
    expect(limited).not.toHaveProperty("staleReason");
    await service.getSummary();
    expect(fetchClaude).toHaveBeenCalledTimes(2);

    // 조회가 예외 대신 오류 결과를 돌려줘도 실패다. 원인 문구는 stale 값에 실린다.
    const unreadable = (await service.getSummary({ force: true })).providers.claude;
    expect(unreadable).toMatchObject({ status: "stale", message: "Credential store unavailable", windows: [{ usedPercent: 41 }, { usedPercent: 70 }] });

    // 30분이 지나도 패널에는 잇되, 배정은 낡은 값을 믿지 않는다.
    now = 100_000 + 1_800_001;
    const stale = (await service.getSummary({ force: true })).providers.claude;
    expect(stale).toMatchObject({ status: "stale", windows: [{ usedPercent: 41 }, { usedPercent: 70 }] });
    expect(stale.message).not.toContain("super-secret");
    expect(service.peekSummary()?.providers.claude.status).toBe("error");

    // 리셋이 지난 창은 빠지고, 남은 창이 없으면 오류다.
    now = 100_000 + 3_600_001;
    expect((await service.getSummary({ force: true })).providers.claude.windows).toEqual([
      expect.objectContaining({ id: "weekly", usedPercent: 70 }),
    ]);
    now = 100_000 + 7_200_001;
    const error = (await service.getSummary()).providers.claude;
    expect(error.status).toBe("error");
    expect(error).not.toHaveProperty("windows");
  });

  it("reads OpenCode Go usage with the key Fleet stores and reports the three official windows", async () => {
    let apiKey: string | undefined = "opencode-key";
    let status = 200;
    const authService = {
      getEntry: async () => undefined, setEntry: async () => undefined, updateEntry: async () => false,
      getApiKey: vi.fn(async () => apiKey), setApiKey: async () => undefined,
      deleteApiKey: async () => false, listProviderIds: async () => [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      usage: {
        rolling: { percent: 1, resetsAt: "2026-11-16T03:00:00.000Z" },
        weekly: { percent: 2, resetsAt: "2026-11-16T00:00:00.000Z" },
        monthly: { percent: 3, resetsAt: "2026-12-01T00:00:00.000Z" },
      },
    }), { status, headers: { "Content-Type": "application/json" } }));
    const collectors = createAiGatewayQuotaCollectors({ authService, fetch: fetchImpl });
    const service = createQuotaService({
      isClaudeConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchOpencode: collectors.fetchOpencode,
    });

    const opencode = (await service.getSummary()).providers.opencode;
    expect(opencode).toMatchObject({ status: "ok", plan: "Go" });
    expect(opencode.windows?.map((window) => [window.id, window.usedPercent])).toEqual([["session", 1], ["weekly", 2], ["cycle", 3]]);
    expect(authService.getApiKey).toHaveBeenCalledWith(OPENCODE_AUTH_PROVIDER_ID);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(OPENCODE_GO_USAGE_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer opencode-key");

    // A valid key without a Go plan is not an expired one.
    status = 403;
    expect((await service.getSummary({ forceProvider: "opencode" })).providers.opencode.status).toBe("no_subscription");
    apiKey = undefined;
    expect((await service.getSummary({ forceProvider: "opencode" })).providers.opencode.status).toBe("signed_out");
  });

  it("keeps only Muse Code usage from the key response and never lets a forced refresh bypass backoff", async () => {
    let now = Date.parse("2026-09-25T00:00:00.000Z");
    let status = 200;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({
        api_key: "minted-secret-key",
        user_email: "person@example.com",
        user_full_name: "Person",
        is_subs_active: true,
        subs_tier_name: "pro",
        subs_usage: {
          window: { used_percent: 12.4, window_duration_mins: 300, resets_at: "2026-09-25T03:00:00.000Z" },
          weekly: { used_percent: 30, resets_at: 1_759_363_200 },
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    ));
    let entry: AuthStorageEntry = { key: "previous-key", type: "oauth-device", version: 1, accessToken: "muse-account-token", mintedAt: now };
    const authService = {
      getEntry: async () => entry,
      setEntry: async (_id: string, value: AuthStorageEntry) => { entry = value; },
      updateEntry: async () => false,
      getApiKey: async () => entry.key, setApiKey: async () => undefined,
      deleteApiKey: async () => false, listProviderIds: async () => [MUSE_CODE_AUTH_PROVIDER_ID],
    };
    const museCode = createMuseCodeOAuth({ authService, fetch: fetchImpl as typeof fetch, now: () => now });
    const collectors = createAiGatewayQuotaCollectors({
      authService, museCode,
      fetch: fetchImpl as typeof fetch,
      now: () => now,
    });
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchMuseCode: collectors.fetchMuseCode,
    });

    const muse = (await service.getSummary()).providers["muse-code"];
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.meta.ai/muse-code/key");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer muse-account-token");
    expect(new Headers(init?.headers).get("x-api-version")).toBe("1.0.0");
    expect(muse).toMatchObject({
      status: "ok",
      plan: "Pro",
      windows: [
        { id: "session", usedPercent: 12, resetsAt: Date.parse("2026-09-25T03:00:00.000Z"), period: { durationMs: 18_000_000, durationBasis: "upstream" } },
        { id: "weekly", usedPercent: 30, resetsAt: 1_759_363_200_000 },
      ],
    });
    expect(entry.key).toBe("minted-secret-key");
    expect(muse).not.toHaveProperty("method");
    expect(muse.windows?.[1]).toMatchObject({
      period: {
        durationMs: 604_800_000,
        durationBasis: "catalog",
        startsAt: 1_759_363_200_000 - 604_800_000,
        startsAtBasis: "derived",
      },
    });
    expect(JSON.stringify(muse)).not.toMatch(/minted-secret-key|person@example\.com|Person/);

    // 응답 직후의 새로고침은 upstream에 다시 닿지 않는다.
    await service.getSummary({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 29분 된 성공값 뒤의 429: 5분 backoff는 일반·강제 조회 모두에 유지되고, 그동안 stale 값을 잇는다.
    now += 29 * 60_000;
    status = 429;
    expect((await service.getSummary({ force: true })).providers["muse-code"]).toMatchObject({ status: "stale", plan: "Pro" });
    now += 120_000;
    expect((await service.getSummary()).providers["muse-code"]).toMatchObject({ status: "stale", plan: "Pro" });
    await service.getSummary({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 180_000;
    status = 401;
    expect((await service.getSummary({ force: true })).providers["muse-code"]).toMatchObject({ status: "expired" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((await museCode.readAuth()).status).toBe("expired");
    museCode.dispose();
  });

  it("keeps an empty success from erasing the last windows and restores that snapshot after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quota-last-good-"));
    const filePath = path.join(directory, "quota-last-good.json");
    let now = 1_000_000;
    const liveReset = now + 7 * 86_400_000;
    let windows: ProviderSuccess["windows"] = [
      { id: "session", usedPercent: 12, resetsAt: now - 1_000 },
      { id: "weekly", usedPercent: 30, resetsAt: liveReset },
    ];
    let plan = "Pro";
    const fetchMuseCode = vi.fn(async (): Promise<ProviderSuccess> => ({
      status: "ok",
      plan,
      fetchedAt: now,
      windows,
    }));
    const open = () => createQuotaService({
      now: () => now,
      isClaudeConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchMuseCode,
      lastGoodStore: createQuotaLastGoodStore({ filePath }),
    });
    try {
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        providers: {
          "muse-code": {
            status: "ok",
            plan: "Old",
            fetchedAt: now,
            apiKey: "secret-key",
            accessToken: "secret-token",
            windows: [{ id: "weekly", usedPercent: 1, resetsAt: liveReset, apiKey: "secret-window" }],
          },
        },
      }));
      const service = open();
      expect(fs.readFileSync(filePath, "utf8")).not.toMatch(/secret-key|secret-token|secret-window|apiKey|accessToken/);

      const fetched = (await service.getSummary()).providers["muse-code"];
      expect(fetched).toMatchObject({ status: "ok", plan: "Pro" });
      expect(fetched.windows?.map((window) => window.id)).toEqual(["session", "weekly"]);

      windows = [];
      plan = "Power";
      now += 300_000;
      const emptied = (await service.getSummary()).providers["muse-code"];
      expect(emptied).toMatchObject({
        status: "ok",
        plan: "Power",
        fetchedAt: now,
        windows: [
          { id: "session", usedPercent: 0 },
          { id: "weekly", usedPercent: 30 },
        ],
      });
      expect(emptied.windows?.[0]).toEqual({ id: "session", usedPercent: 0, risk: { pressure: "ok" } });
      expect(JSON.stringify(emptied)).not.toMatch(/secret/);
      expect(service.peekSummary()?.providers["muse-code"]).toMatchObject({ status: "ok", fetchedAt: now });
      expect(normalizeRoutingQuota(emptied, undefined, now)).toEqual({
        observation: "partial",
        ageSeconds: 0,
        remainingPercent: 70,
      });

      // 추론 스트림이 알려 준 창은 그 뒤의 빈 key 성공이 리셋 전에 지우면 안 된다.
      const sessionReset = now + 5 * 3_600_000;
      service.record("muse-code", {
        status: "ok",
        fetchedAt: now,
        windows: [
          { id: "session", usedPercent: 4, resetsAt: sessionReset },
          { id: "weekly", usedPercent: 30, resetsAt: liveReset },
        ],
      });
      now += 300_000;
      const afterStream = (await service.getSummary()).providers["muse-code"];
      expect(afterStream).toMatchObject({
        status: "ok",
        plan: "Power",
        fetchedAt: now,
        windows: [
          { id: "session", usedPercent: 0 },
          { id: "weekly", usedPercent: 30 },
        ],
      });

      const restarted = (await open().getSummary()).providers["muse-code"];
      expect(restarted).toMatchObject({
        status: "ok",
        plan: "Power",
        fetchedAt: now,
        windows: [
          { id: "session", usedPercent: 0 },
          { id: "weekly", usedPercent: 30 },
        ],
      });

      // 리셋이 지난 주간 창은 빼고, 창 없는 성공은 세션 미사용으로 남긴다.
      now = liveReset + 1;
      const lapsed = (await open().getSummary({ force: true })).providers["muse-code"];
      expect(lapsed).toMatchObject({
        status: "ok",
        fetchedAt: now,
        windows: [{ id: "session", usedPercent: 0 }],
      });
      expect(lapsed.windows?.some((window) => window.id === "weekly")).toBe(false);
      expect(normalizeRoutingQuota(lapsed, undefined, now)).toEqual({
        observation: "fresh",
        ageSeconds: 0,
        remainingPercent: 100,
        sustainableHeadroom: 1,
      });
      // 세션 20%는 5시간 중 3시간이 남고, 주간 40%는 7일 중 3일이 남는다.
      const openedAt = Date.parse("2026-10-01T00:00:00.000Z");
      const weeklyReset = openedAt + 3 * 86_400_000;
      const opened = parseMuseCodeSubscriptionUsage({
        window: { used_percent: 20, window_duration_mins: 300, resets_at: new Date(openedAt + 3 * 3_600_000).toISOString() },
        weekly: { used_percent: 40, resets_at: Math.floor(weeklyReset / 1000) },
      });
      const weekly = parseMuseCodeSubscriptionUsage({
        weekly: { used_percent: 40, resets_at: Math.floor(weeklyReset / 1000) },
      });
      expect(normalizeRoutingQuota({ status: "ok", fetchedAt: openedAt, windows: [{ id: "session", usedPercent: 0 }] }, undefined, openedAt)).toEqual({
        observation: "fresh", ageSeconds: 0, remainingPercent: 100, sustainableHeadroom: 1,
      });
      expect(normalizeRoutingQuota({
        status: "ok", fetchedAt: openedAt,
        windows: [{ id: "session", usedPercent: 0 }, ...(weekly ?? [])],
      }, undefined, openedAt)).toEqual({
        observation: "fresh", ageSeconds: 0, remainingPercent: 60, sustainableHeadroom: 1,
        recovery: { inSeconds: 3 * 86_400, remainingPercent: 100 },
      });
      expect(normalizeRoutingQuota({ status: "ok", fetchedAt: openedAt, windows: opened ?? [] }, undefined, openedAt)).toEqual({
        observation: "fresh", ageSeconds: 0, remainingPercent: 60, sustainableHeadroom: 1.33333,
        recovery: { inSeconds: 3 * 86_400, remainingPercent: 100 },
      });
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).providers["muse-code"]?.windows).toEqual([
        { id: "session", usedPercent: 0 },
      ]);

      open().record("muse-code", { status: "not_connected" });
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).providers["muse-code"]).toBeUndefined();

      fs.writeFileSync(filePath, "{not json");
      const ignored = (await open().getSummary()).providers["muse-code"];
      expect(ignored).toMatchObject({
        status: "ok",
        plan: "Power",
        windows: [{ id: "session", usedPercent: 0 }],
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drops persisted windows whose scope is no longer supported instead of sharing them", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quota-last-good-"));
    const filePath = path.join(directory, "quota-last-good.json");
    const now = 1_000_000;
    const resetsAt = now + 86_400_000;
    try {
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        providers: {
          xai: {
            status: "ok",
            fetchedAt: now,
            windows: [
              { id: "cycle", scope: "api", label: "API", usedPercent: 90, resetsAt },
              { id: "cycle", scope: "auto", label: "Auto", usedPercent: 10, resetsAt },
            ],
          },
          claude: {
            status: "ok",
            fetchedAt: now,
            windows: [
              { id: "weekly", usedPercent: 66, resetsAt },
              { id: "model", scope: "model:fable", label: "Fable", usedPercent: 95, resetsAt },
              { id: "model", scope: "model:future-model", label: "Future", usedPercent: 10, resetsAt },
            ],
          },
        },
      }));
      // 은퇴한 풀의 창이 scope 없이 살아남으면 Auto 모델의 공유 제한으로 읽혀 배정을 그르친다.
      const read = createQuotaLastGoodStore({ filePath }).read();
      expect(read.xai?.windows).toEqual([
        { id: "cycle", scope: "auto", label: "Auto", usedPercent: 10, resetsAt },
      ]);
      expect(read.claude?.windows).toEqual([
        { id: "weekly", usedPercent: 66, resetsAt },
        { id: "model", scope: "model:fable", label: "Fable", usedPercent: 95, resetsAt },
        { id: "model", scope: "model:future-model", label: "Future", usedPercent: 10, resetsAt },
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("gemini spend ledger", () => {
  it("prices turns, keeps the Pacific week, doubles Argon on December 1, and clears a block on the next usage", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-spend-"));
    const filePath = path.join(directory, "gemini-spend.json");
    // 11-16(월, PST)이 시작하는 주와, Argon 단가가 2배가 된 뒤의 다른 주(11-30 월요일이 시작).
    const firstWeek = Date.UTC(2026, 10, 18, 12);
    const laterWeek = Date.UTC(2026, 11, 1, 9);
    try {
      // 주 단위 전환 전의 달 누적은 지우지 않고 남긴다 — 화면과 계산은 이번 주만 본다(A3).
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, months: { "2026-11": "5000000000000" } }));
      const ledger = createGeminiSpendLedger({ filePath });
      // 11-16 00:00 PST(-8)에 시작해 11-23 00:00 PST에 리셋한다.
      expect(spendWeekBounds(firstWeek)).toEqual({
        key: "2026-11-16",
        periodStart: Date.UTC(2026, 10, 16, 8),
        resetsAt: Date.UTC(2026, 10, 23, 8),
      });
      // DST가 끼는 주는 시작(3-02 PST)과 리셋(3-09 PDT)의 오프셋이 다르다.
      expect(spendWeekBounds(Date.UTC(2026, 2, 4, 12))).toEqual({
        key: "2026-03-02",
        periodStart: Date.UTC(2026, 2, 2, 8),
        resetsAt: Date.UTC(2026, 2, 9, 7),
      });
      // 단가 전환은 태평양시 12-01 00:00 정각부터다.
      expect(geminiTokenPrice("gemini-4-argon", "standard", Date.UTC(2026, 11, 1, 8) - 1).input).toBe(2_000_000n);
      expect(geminiTokenPrice("gemini-4-argon", "standard", Date.UTC(2026, 11, 1, 8)).input).toBe(4_000_000n);

      // Hydrogen: (100−40)×1.5 + 40×0.075(캐시) + (10+10)×7.5 = 0.000243 USD.
      ledger.observeUsage({ model: "gemini-4-hydrogen", at: firstWeek, serviceTier: "standard", promptTokens: 100, cachedTokens: 40, candidatesTokens: 10, thoughtsTokens: 10 });
      // Argon(11월): 100×2 + 20×10 = 0.0004 USD.
      ledger.observeUsage({ model: "gemini-4-argon", at: firstWeek, serviceTier: "standard", promptTokens: 100, cachedTokens: 0, candidatesTokens: 10, thoughtsTokens: 10 });
      // 레거시 달 누적(US$5)은 이번 주 지출에 더하지 않는다.
      expect(ledger.read(firstWeek).spend).toMatchObject({ currency: "USD", spent: "0.000643", basis: "fleet_measured" });
      // 다음 주 Argon은 2배다: 100×4 + 20×20 = 0.0008 USD. 첫 주 누적은 그대로 남는다.
      ledger.observeUsage({ model: "gemini-4-argon", at: laterWeek, serviceTier: "standard", promptTokens: 100, cachedTokens: 0, candidatesTokens: 10, thoughtsTokens: 10 });
      expect(ledger.read(laterWeek).spend.spent).toBe("0.0008");
      expect(ledger.read(firstWeek).spend.spent).toBe("0.000643");

      // 예산은 주를 넘어 유지되고, 사용률은 이번 주 누적에만 걸린다.
      expect(budgetUsedPercent(5n * 10n ** 12n, 10n * 10n ** 12n)).toBe(50);
      expect(ledger.setBudget("10")).toBe(true);
      expect(ledger.setBudget("0")).toBe(false);
      expect(ledger.setBudget("-3")).toBe(false);
      expect(ledger.setBudget("abc")).toBe(false);
      expect(ledger.read(firstWeek).spend).toMatchObject({ budget: "10", usedPercent: 0 });
      // 재시작해도 누적·예산·레거시 달 기록이 남는다 — 파일이 원장의 유일한 저장소다.
      expect(createGeminiSpendLedger({ filePath }).read(laterWeek).spend).toMatchObject({ spent: "0.0008", budget: "10" });
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).months).toEqual({ "2026-11": "5000000000000" });

      // 402는 사유·시각과 함께 남고, 지난주의 차단은 이번 주 카드에 서지 않는다.
      ledger.observeBlock({ model: "gemini-4-argon", at: firstWeek, httpStatus: 402, reason: "balance_depleted", code: "payment_required", message: "Prepay credit balance is depleted." });
      expect(ledger.read(firstWeek).block).toMatchObject({ httpStatus: 402, reason: "balance_depleted", code: "payment_required" });
      expect(ledger.read(laterWeek).block).toBeUndefined();
      // 다음 성공 사용량이 차단 표시를 걷는다.
      ledger.observeUsage({ model: "gemini-4-argon", at: laterWeek, serviceTier: "standard", promptTokens: 1, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0 });
      expect(ledger.read(laterWeek).block).toBeUndefined();
      expect(ledger.read(firstWeek).block).toBeUndefined();

      ledger.clearBudget();
      expect(ledger.read(laterWeek).spend.budget).toBeUndefined();
      expect(ledger.read(laterWeek).spend.usedPercent).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("anthropic spend ledger", () => {
  const cost = (observation: Parameters<typeof priceAnthropicTurn>[0]) => priceAnthropicTurn(observation)?.costPicoUsd;
  const turn = { at: Date.UTC(2026, 10, 18, 12), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, webSearchRequests: 0 } as const;

  it("prices every token class, splits Haiku at 100k, keeps the week and budget on disk, and tells credit exhaustion from other refusals", () => {
    // Sonnet 5.5: 1000×2 + 500×10 + 200×0.10 + 100×2.5 + 100×4 = 7,670 µ$ → 0.00767 USD.
    expect(cost({ ...turn, model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWrite5mTokens: 100, cacheWrite1hTokens: 100 })).toBe(7_670_000_000n);
    // Haiku 5.5는 요청의 모든 입력(캐시 포함)이 100,000을 넘어야 높은 단가다 — 입력 50k + 캐시 읽기 50,001.
    expect(cost({ ...turn, model: "claude-haiku-5-5", inputTokens: 50_000, cacheReadTokens: 50_000, outputTokens: 1 })).toBe(50_000n * 100_000n + 50_000n * 10_000n + 500_000n);
    expect(cost({ ...turn, model: "claude-haiku-5-5", inputTokens: 50_000, cacheReadTokens: 50_001, outputTokens: 1 })).toBe(50_000n * 500_000n + 50_001n * 50_000n + 2_500_000n);
    // 웹 검색은 1회 $0.01이고 미국 한정 추론은 토큰에만 ×1.1이다.
    expect(cost({ ...turn, model: "claude-opus-5-5", outputTokens: 10, webSearchRequests: 2, inferenceGeo: "us" })).toBe(220_000_000n + 20_000_000_000n);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-spend-"));
    const filePath = path.join(directory, "anthropic-spend.json");
    const firstWeek = Date.UTC(2026, 10, 18, 12);
    const laterWeek = Date.UTC(2026, 11, 1, 9);
    try {
      const ledger = createAnthropicSpendLedger({ filePath });
      ledger.observeUsage({ ...turn, model: "claude-opus-5-5", at: firstWeek, inputTokens: 1000, outputTokens: 100 });
      // 4×1000 + 20×100 = 6,000 µ$.
      expect(ledger.read(firstWeek).spend).toMatchObject({ currency: "USD", spent: "0.006", basis: "fleet_measured" });
      expect(ledger.read(laterWeek).spend.spent).toBe("0");
      expect(ledger.setBudget("10")).toBe(true);
      expect(ledger.setBudget("0")).toBe(false);
      expect(ledger.setBudget("abc")).toBe(false);
      // 재시작해도 누적·예산이 남고, 파일에는 키·본문이 없다.
      expect(createAnthropicSpendLedger({ filePath }).read(firstWeek).spend).toMatchObject({ spent: "0.006", budget: "10" });
      expect(fs.readFileSync(filePath, "utf8")).not.toMatch(/sk-ant|authorization/i);

      // 잔액 소진은 400·402 어느 쪽으로 와도 같은 사유다. 모델 제약 400·인증 401은 차단이 아니다.
      const depleted400 = classifyAnthropicBlock(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
      const depleted402 = classifyAnthropicBlock(402, { type: "error", error: { type: "billing_error", message: "Credit balance is too low" } });
      expect(depleted400).toMatchObject({ httpStatus: 400, reason: "balance_depleted" });
      expect(depleted402).toMatchObject({ httpStatus: 402, reason: "balance_depleted", code: "billing_error" });
      expect(classifyAnthropicBlock(400, { error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } })).toMatchObject({ reason: "spend_limit" });
      expect(classifyAnthropicBlock(429, { error: { type: "rate_limit_error", message: "slow down", details: { error_code: "ramp_limit_exceeded" } } })).toMatchObject({ httpStatus: 429, reason: "rate_limited", code: "ramp_limit_exceeded" });
      expect(classifyAnthropicBlock(400, { error: { type: "invalid_request_error", message: "max_tokens: too large" } })).toBeUndefined();
      expect(classifyAnthropicBlock(401, { error: { type: "authentication_error", message: "invalid x-api-key" } })).toBeUndefined();

      ledger.observeBlock({ model: "claude-opus-5-5", at: firstWeek, ...depleted402! });
      ledger.observeRateLimit({ observedAt: firstWeek, requests: { limit: 50, remaining: 0, resetsAt: firstWeek + 30_000 } });
      expect(ledger.read(firstWeek)).toMatchObject({ block: { httpStatus: 402, reason: "balance_depleted" }, rateLimit: { requests: { remaining: 0 } } });
      // 지난주 차단은 이번 주 카드에 서지 않고, 다음 성공 사용량이 걷는다.
      expect(ledger.read(laterWeek).block).toBeUndefined();
      ledger.observeUsage({ ...turn, model: "claude-opus-5-5", at: firstWeek, inputTokens: 1, outputTokens: 1 });
      expect(ledger.read(firstWeek).block).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("anthropic pricing for versions and families the table does not list", () => {
  const base = { at: Date.UTC(2026, 10, 18, 12), inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, webSearchRequests: 0 } as const;

  it("estimates a newer version at the latest priced version of its family and records it, and never invents a cost for an unknown family", () => {
    // 같은 가족의 가장 최근 표 버전(5.5)으로 추정하고, 날짜 접미가 붙어도 같은 가족·버전으로 읽는다.
    expect(priceAnthropicTurn({ ...base, model: "claude-opus-5-5" })).toMatchObject({ pricedAs: "claude-opus-5-5", estimated: false });
    const estimated = priceAnthropicTurn({ ...base, model: "claude-opus-5-6-20261201" });
    expect(estimated).toMatchObject({ pricedAs: "claude-opus-5-5", estimated: true, costPicoUsd: 6_000_000_000n });
    // 가족이 표에 없으면 단가가 없다 — 0원으로 두지도 않는다.
    expect(priceAnthropicTurn({ ...base, model: "claude-ember-1-0" })).toBeUndefined();
    expect(priceAnthropicTurn({ ...base, model: "not-a-claude-id" })).toBeUndefined();

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-estimate-"));
    const filePath = path.join(directory, "anthropic-spend.json");
    try {
      const ledger = createAnthropicSpendLedger({ filePath });
      ledger.observeUsage({ ...base, model: "claude-opus-5-5" });
      ledger.observeUsage({ ...base, model: "claude-opus-5-6" });
      ledger.observeUsage({ ...base, model: "claude-opus-5-6" });
      ledger.observeUsage({ ...base, model: "claude-ember-1-0" });
      // 4×1000 + 20×100 = 6,000 µ$ 가 세 번(정확 1 + 추정 2). 모르는 가족은 합계에 들어가지 않는다.
      expect(ledger.read(base.at).spend.spent).toBe("0.018");
      const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as { estimates: unknown; unpriced: unknown };
      // 어떤 버전을 어느 단가로 셌는지, 못 센 턴이 몇 번인지 파일에 남고 재시작해도 읽힌다.
      expect(stored.estimates).toEqual({ "2026-11-16": { "claude-opus-5-6": { pricedAs: "claude-opus-5-5", turns: 2, costPicoUsd: "12000000000", lastAt: base.at } } });
      expect(stored.unpriced).toEqual({ "2026-11-16": { "claude-ember-1-0": { turns: 1, lastAt: base.at } } });
      expect(createAnthropicSpendLedger({ filePath }).read(base.at).spend.spent).toBe("0.018");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("gemini quota provider", () => {
  it("serves spend from the ledger without making it a window, and signed_out without a stored key", async () => {
    const spend: ProviderSpend = { currency: "USD", spent: "0.000643", periodStart: 1, resetsAt: 2, basis: "fleet_measured" };
    const fetchGemini = vi.fn(async (): Promise<ProviderResult> => ({ status: "ok", fetchedAt: 5, spend }));
    const service = createQuotaService({
      now: () => 10,
      isClaudeConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchGemini,
    });
    const summary = await service.getSummary();
    expect(summary.providers.gemini).toMatchObject({ status: "ok", spend });
    // 지출·예산은 창이 아니다 — routing이 windows로 압박도를 계산하므로 여기에 싣지 않는다.
    expect(summary.providers.gemini.windows).toBeUndefined();
    // 원장이 바뀌면 게이트웨이가 캐시를 만료시켜 다음 읽기가 다시 부른다(키 저장·삭제도 같은 길).
    fetchGemini.mockResolvedValueOnce({ status: "signed_out" });
    service.expire("gemini");
    expect(service.readCachedSummary()?.expired).toBe(true);
    expect((await service.getSummary()).providers.gemini.status).toBe("signed_out");
    expect(fetchGemini).toHaveBeenCalledTimes(2);
  });
});
