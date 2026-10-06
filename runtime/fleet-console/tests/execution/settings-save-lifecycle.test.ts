import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemPromptSettingsState } from "../../features/settings/client/execution-settings.js";

const BASE: SystemPromptSettingsState = {
  agentIdleDormantMinutes: 60,
  aiGateway: null,
  aiGatewayCatalog: { providers: [] },
  cursorDiagnosticsEnabled: false,
  wireLogEnabled: false,
  delegationRoutingEnabled: true,
  delegationRoutingModel: null,
  delegationRoutingMode: "model",
  compactCeiling: null,
  xaiEndpoint: "cli-proxy",
};

const response = (state: SystemPromptSettingsState) => new Response(JSON.stringify(state));

// 저장 응답 경합은 HTTP 라우트 테스트로 잡히지 않는다. 설정값·실패 복원의 경계를 검증한다.
describe("terminal settings save lifecycle", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  // 저장 중 들어온 조작은 거절되지 않고 합쳐진다 — 연달아 고르는 것이 정상 사용이라,
  // 두 번째부터 버리면 사용자가 만진 것이 조용히 되돌아간다. 중간 의도는 보내지 않는다.
  it("coalesces in-flight writes per field while keeping fields and failures isolated", async () => {
    const writes: { readonly field: string; readonly body: unknown; readonly resolve: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return Promise.resolve(response(BASE));
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      const field = Object.keys(body)[0]!;
      return new Promise<Response>((resolve) => { writes.push({ field, body: body[field], resolve }); });
    }));
    const store = await import("../../features/settings/client/execution-settings.js");
    await store.loadSystemPromptSettings();

    const routing = store.setSystemPromptSettingsField("delegationRoutingModel", "sonnet");
    const idle = store.setSystemPromptSettingsField("agentIdleDormantMinutes", 30);
    await expect(store.setSystemPromptSettingsField("delegationRoutingModel", "opus")).resolves.toBe(true);
    await expect(store.setSystemPromptSettingsField("delegationRoutingModel", null)).resolves.toBe(true);
    // 화면은 기다리지 않는다 — 마지막으로 고른 것이 즉시 선다.
    expect(store.getSystemPromptSettingsStoreState().state?.delegationRoutingModel).toBeNull();
    expect(store.getSystemPromptSettingsStoreState().savingFields.size).toBe(2);
    expect(writes).toHaveLength(2);

    const routingWrites = () => writes.filter((write) => write.field === "delegationRoutingModel");
    routingWrites()[0]!.resolve(response({ ...BASE, delegationRoutingModel: "sonnet" }));
    // 큐에 남은 마지막 의도만 이어 나간다 — 버려진 중간값 "opus"는 보내지 않는다.
    await vi.waitFor(() => expect(routingWrites()).toHaveLength(2));
    expect(routingWrites().map((write) => write.body)).toEqual(["sonnet", null]);
    routingWrites()[1]!.resolve(response({ ...BASE, delegationRoutingModel: null }));
    await expect(routing).resolves.toBe(true);

    writes.find((write) => write.field === "agentIdleDormantMinutes")!.resolve(
      new Response(JSON.stringify({ error: "idle write refused" }), { status: 500 }),
    );
    await expect(idle).resolves.toBe(false);
    expect(store.getSystemPromptSettingsStoreState()).toMatchObject({
      // 실패한 필드만 되감고, 합쳐진 저장은 그대로 남는다.
      state: { agentIdleDormantMinutes: 60, delegationRoutingModel: null },
      error: "idle write refused",
    });
    expect(store.getSystemPromptSettingsStoreState().savingFields.size).toBe(0);
  });

  it("ignores stale reads after saving and settles cancelled loads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(BASE));
    vi.stubGlobal("fetch", fetchMock);
    const store = await import("../../features/settings/client/execution-settings.js");
    await store.loadSystemPromptSettings();
    let resolveRead!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRead = resolve; }));
    const read = store.loadSystemPromptSettings();
    fetchMock.mockResolvedValueOnce(response({ ...BASE, wireLogEnabled: true }));
    await store.setSystemPromptSettingsField("wireLogEnabled", true);
    resolveRead(response(BASE));
    await read;
    expect(store.getSystemPromptSettingsStoreState().state?.wireLogEnabled).toBe(true);
    expect(store.getSystemPromptSettingsStoreState().loading).toBe(false);

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRead = resolve; }));
    const cancelled = store.loadSystemPromptSettings(controller.signal);
    controller.abort();
    resolveRead(response(BASE));
    await cancelled;
    expect(store.getSystemPromptSettingsStoreState().loading).toBe(false);
    expect(store.getSystemPromptSettingsStoreState().state?.wireLogEnabled).toBe(true);
  });
});
