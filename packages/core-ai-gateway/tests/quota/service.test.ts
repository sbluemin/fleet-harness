import { describe, expect, it, vi } from "vitest";

import { createAiGatewayQuotaCollectors, createQuotaService } from "../../src/quota/service.js";
import { KIMI_AUTH_PROVIDER_ID } from "../../src/models.js";
import { OPENCODE_AUTH_PROVIDER_ID } from "../../src/opencode-go/index.js";
import type { ProviderSuccess } from "../../src/quota/types.js";

function ok(fetchedAt: number, usedPercent = 10): ProviderSuccess {
  return { status: "ok", fetchedAt, windows: [{ id: "session", usedPercent }] };
}

describe("quota service", () => {
  it("does not read Claude credentials before explicit connection", async () => {
    const fetchClaude = vi.fn(async () => ok(1));
    const service = createQuotaService({
      platform: "darwin",
      isClaudeConnected: async () => false,
      fetchKimi: async () => ({ status: "signed_out" }),
      isCursorConnected: async () => false,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchCursor: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    expect((await service.getSummary()).providers.claude).toEqual({ status: "not_connected", method: "keychain" });
    expect(fetchClaude).not.toHaveBeenCalled();
  });

  it("gates Cursor independently with the platform credential method", async () => {
    const fetchCursor = vi.fn(async () => ok(1));
    const service = createQuotaService({
      platform: "darwin",
      isClaudeConnected: async () => true,
      fetchKimi: async () => ({ status: "signed_out" }),
      isCursorConnected: async () => false,
      fetchClaude: async () => ({ status: "signed_out" }),
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchCursor,
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    expect((await service.getSummary()).providers.cursor)
      .toEqual({ status: "not_connected", method: "keychain" });
    expect(fetchCursor).not.toHaveBeenCalled();
  });

  it("uses a 120-second cache, supports force bypass, and single-flights", async () => {
    let now = 1_000;
    let resolveClaude: ((value: ProviderSuccess) => void) | undefined;
    const fetchClaude = vi.fn(() => new Promise<ProviderSuccess>((resolve) => { resolveClaude = resolve; }));
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      fetchKimi: async () => ({ status: "signed_out" }),
      isCursorConnected: async () => false,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchCursor: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    const first = service.getSummary();
    const second = service.getSummary();
    await Promise.resolve();
    resolveClaude?.(ok(now));
    await Promise.all([first, second]);
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    await service.getSummary();
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    now += 1;
    const forced = service.getSummary({ force: true });
    await Promise.resolve();
    resolveClaude?.(ok(now));
    await forced;
    expect(fetchClaude).toHaveBeenCalledTimes(2);
  });

  it("force-loads only the selected provider and preserves other cached snapshots", async () => {
    let claudeCount = 0;
    let codexCount = 0;
    let cursorCount = 0;
    let xaiCount = 0;
    const fetchClaude = vi.fn(async () => ok(1, 10 + ++claudeCount));
    const fetchCodex = vi.fn(async () => ok(1, 20 + ++codexCount));
    const fetchCursor = vi.fn(async () => ok(1, 30 + ++cursorCount));
    const fetchXai = vi.fn(async () => ok(1, 40 + ++xaiCount));
    const service = createQuotaService({
      now: () => 1_000,
      isClaudeConnected: async () => true,
      fetchKimi: async () => ({ status: "signed_out" }),
      isCursorConnected: async () => true,
      fetchClaude,
      fetchCodex,
      fetchCursor,
      fetchOpencode: async () => ({ status: "signed_out" }),
      fetchXai,
    });
    const cached = await service.getSummary();
    const refreshed = await service.getSummary({ forceProvider: "xai" });
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    expect(fetchCodex).toHaveBeenCalledTimes(1);
    expect(fetchCursor).toHaveBeenCalledTimes(1);
    expect(fetchXai).toHaveBeenCalledTimes(2);
    expect(refreshed.providers.claude).toEqual(cached.providers.claude);
    expect(refreshed.providers.codex).toEqual(cached.providers.codex);
    expect(refreshed.providers.cursor).toEqual(cached.providers.cursor);
    expect(refreshed.providers.xai.windows?.[0]?.usedPercent).toBe(42);
  });

  it("collectors read Kimi and OpenCode keys only through the injected auth service", async () => {
    const authService = {
      getApiKey: vi.fn(async (providerId: string) => providerId === KIMI_AUTH_PROVIDER_ID ? "kimi-key" : "opencode-key"),
      setApiKey: async () => undefined,
      deleteApiKey: async () => false,
      listProviderIds: async () => [],
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(
      String(url).includes("kimi")
        ? JSON.stringify({ usage: { limit: "100", used: "4" } })
        : JSON.stringify({
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

    await expect(collectors.fetchKimi()).resolves.toMatchObject({ status: "ok" });
    await expect(collectors.fetchOpencode()).resolves.toMatchObject({ status: "ok", plan: "Go" });
    expect(authService.getApiKey).toHaveBeenNthCalledWith(1, KIMI_AUTH_PROVIDER_ID);
    expect(authService.getApiKey).toHaveBeenNthCalledWith(2, OPENCODE_AUTH_PROVIDER_ID);
  });

  it("serves last-good data as stale for 30 minutes, then returns sanitized error", async () => {
    let now = 100_000;
    const fetchClaude = vi.fn()
      .mockResolvedValueOnce(ok(now, 41))
      .mockRejectedValue(new Error("Bearer super-secret upstream unavailable"));
    const service = createQuotaService({
      now: () => now,
      isClaudeConnected: async () => true,
      fetchKimi: async () => ({ status: "signed_out" }),
      isCursorConnected: async () => false,
      fetchClaude,
      fetchCodex: async () => ({ status: "signed_out" }),
      fetchCursor: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    await service.getSummary();
    now += 1_799_999;
    const stale = (await service.getSummary({ force: true })).providers.claude;
    expect(stale).toMatchObject({ status: "stale", windows: [{ usedPercent: 41 }] });
    expect(stale.message).not.toContain("super-secret");
    now += 2;
    const error = (await service.getSummary()).providers.claude;
    expect(error.status).toBe("error");
    expect(error).not.toHaveProperty("windows");
  });
});
