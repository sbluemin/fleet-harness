import { describe, expect, it, vi } from "vitest";

import { createAiGatewayQuotaCollectors, createQuotaService } from "../../src/quota/service.js";
import { OPENCODE_AUTH_PROVIDER_ID } from "../../src/upstream/opencode-go/index.js";
import { getJson } from "../../src/quota/windows.js";
import type { ProviderSuccess } from "../../src/quota/types.js";

const museAuth = vi.hoisted(() => ({
  resolveMuseAuth: vi.fn(async () => ({
    status: "ok" as const,
    credentials: { accountToken: "muse-account-token", method: "keychain" as const },
  })),
}));
vi.mock("../../src/upstream/muse-code/credentials.js", () => museAuth);

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
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    expect((await service.getSummary()).providers.claude).toEqual({ status: "not_connected", method: "keychain" });
    expect(fetchClaude).not.toHaveBeenCalled();
  });

  it("uses a five-minute cache, supports force bypass, and single-flights", async () => {
    let now = 1_000;
    let resolveClaude: ((value: ProviderSuccess) => void) | undefined;
    const fetchClaude = vi.fn(() => new Promise<ProviderSuccess>((resolve) => { resolveClaude = resolve; }));
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    const first = service.getSummary();
    const second = service.getSummary();
    await Promise.resolve();
    resolveClaude?.(ok(now));
    await Promise.all([first, second]);
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    now += 299_999;
    await service.getSummary();
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    now += 1;
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
      fetchOpencode: async () => ({ status: "signed_out" }),
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

  it("collectors read OpenCode keys only through the injected auth service", async () => {
    const authService = {
      getApiKey: vi.fn(async () => "opencode-key"),
      setApiKey: async () => undefined,
      deleteApiKey: async () => false,
      listProviderIds: async () => [],
    };
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        usage: {
          rolling: { percent: 1, resetsAt: "2026-07-12T17:00:00.000Z" },
          weekly: { percent: 2, resetsAt: "2026-07-13T00:00:00.000Z" },
          monthly: { percent: 3, resetsAt: "2026-08-04T00:00:00.000Z" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const collectors = createAiGatewayQuotaCollectors({
      authService,
      fetch: fetchImpl as typeof fetch,
    });

    await expect(collectors.fetchOpencode()).resolves.toMatchObject({ status: "ok", plan: "Go" });
    expect(authService.getApiKey).toHaveBeenCalledWith(OPENCODE_AUTH_PROVIDER_ID);
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
      .mockResolvedValueOnce({ status: "error", message: "Credential store unavailable (keychain_denied)" })
      .mockRejectedValue(new Error("Bearer super-secret upstream unavailable"));
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    await service.getSummary();
    now += 300_000;
    const limited = (await service.getSummary()).providers.claude;
    expect(limited).toMatchObject({ status: "stale", fetchedAt: 100_000, windows: [{ usedPercent: 41 }, { usedPercent: 70 }] });
    await service.getSummary();
    expect(fetchClaude).toHaveBeenCalledTimes(2);

    // 조회가 예외 대신 오류 결과를 돌려줘도 실패다. 원인 문구는 stale 값에 실린다.
    const unreadable = (await service.getSummary({ force: true })).providers.claude;
    expect(unreadable).toMatchObject({ status: "stale", message: "Credential store unavailable (keychain_denied)", windows: [{ usedPercent: 41 }, { usedPercent: 70 }] });

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
    const collectors = createAiGatewayQuotaCollectors({
      authService: { getApiKey: async () => undefined, setApiKey: async () => undefined, deleteApiKey: async () => false, listProviderIds: async () => [] },
      fetch: fetchImpl as typeof fetch,
      now: () => now,
    });
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
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
      method: "keychain",
      plan: "Pro",
      windows: [
        { id: "session", usedPercent: 12, resetsAt: Date.parse("2026-09-25T03:00:00.000Z"), period: { durationMs: 18_000_000, durationBasis: "upstream" } },
        { id: "weekly", usedPercent: 30, resetsAt: 1_759_363_200_000 },
      ],
    });
    expect(muse.windows?.[1]).not.toHaveProperty("period");
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
    expect((await service.getSummary({ force: true })).providers["muse-code"]).toMatchObject({ status: "expired", method: "keychain" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
