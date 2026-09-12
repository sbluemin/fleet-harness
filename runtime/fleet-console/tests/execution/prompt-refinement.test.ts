import type { ConsoleRuntimeContext } from "../../core/host/runtime-context.js";
import type http from "node:http";

import { PROMPT_REFINE_MAX_CHARS } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import { describe, expect, it, vi } from "vitest";

import { refineLaunchPrompt } from "../../core/client/src/agent/experiments-api.js";
import { registerExperimentRoutes } from "../../core/host/agent/experiments-routes.js";

// 전달 테스트는 다듬기 API를 지나지 않는다. 여기서는 클라이언트→라우트의 옵트인·본문 전용
// 계약과 초안 무결성을 검증하고, 실제 모델의 문장 품질은 검증했다고 간주하지 않는다.
function harness() {
  let route: RouteHandler;
  let body: unknown;
  let enabled = true;
  let authorized = true;
  let response: { status: number; body: unknown };
  const runOneShot = vi.fn(async (_input: { baseUrl: string; model: string; system: string; user: string }) => JSON.stringify({ prompt: "앞서 제안한 변경 중 로깅만 추가해 줘.", notes: [] }));
  const getOperation = vi.fn(() => { throw new Error("세션 조회 금지"); });
  const ctx = {
    basePath: "/api/v1",
    registerRouter: (_path: string, handler: RouteHandler) => { route = handler; },
    host: {
      experiments: { read: () => ({ ...DEFAULT_EXPERIMENT_SETTINGS, promptRefine: enabled }) },
      server: { origin: () => "http://127.0.0.1:12345" },
      security: { validateHost: () => authorized, isTerminalAuthorized: () => authorized },
      events: { registerSseChannel: () => {} },
      operations: { get: getOperation },
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, value: unknown) => { response = { status, body: value }; },
      },
    },
  } as unknown as ConsoleRuntimeContext;
  registerExperimentRoutes(ctx, { runOneShot });
  const request = async (value: unknown) => {
    body = value;
    await route!({ req: { method: "POST" } as http.IncomingMessage, res: {} as http.ServerResponse, pathname: "/api/v1/experiments/refine-prompt" } as Parameters<RouteHandler>[0]);
    return response!;
  };
  return {
    request, runOneShot, getOperation,
    enable: (value: boolean) => { enabled = value; },
    authorize: (value: boolean) => { authorized = value; },
    api: {
      fetch: async (_plugin: string, _path: string, init?: RequestInit) => {
        const result = await request(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(result.body), { status: result.status });
      },
      subscribe: () => () => {},
      resync: vi.fn(),
    },
  };
}

const input = { prompt: "앞서 제안한 변경에서 로깅만 추가해 줘", theaterLabel: "대상 프로젝트", language: "ko" as const };

describe("프롬프트 다듬기 계약", () => {
  it("후속 메시지와 기존 런치를 분리하고 세션 조회 없이 초안을 반환한다", async () => {
    const h = harness();
    const result = await refineLaunchPrompt(h.api, { ...input, purpose: "follow-up" });
    expect(result?.prompt).toBe("앞서 제안한 변경 중 로깅만 추가해 줘.");
    const followUp = h.runOneShot.mock.calls[0]?.[0];
    expect(followUp).toEqual(expect.objectContaining({ user: expect.stringContaining(input.prompt) }));
    await h.request(input);
    const launch = h.runOneShot.mock.calls[1]?.[0];
    expect(launch?.system).not.toBe(followUp?.system);
    expect(h.getOperation).not.toHaveBeenCalled();
  });

  it("권한·옵트인·입력 검증을 모델 호출보다 먼저 적용하고 긴 결과를 자르지 않는다", async () => {
    const h = harness();
    h.authorize(false);
    expect((await h.request(input)).status).toBe(403);
    h.authorize(true);
    h.enable(false);
    expect((await h.request(input)).status).toBe(404);
    h.enable(true);
    expect((await h.request({ ...input, purpose: "unknown" })).status).toBe(400);
    expect((await h.request({ ...input, prompt: "x".repeat(PROMPT_REFINE_MAX_CHARS + 1) })).status).toBe(400);
    expect(h.runOneShot).not.toHaveBeenCalled();
    h.runOneShot.mockResolvedValue(JSON.stringify({ prompt: "x".repeat(PROMPT_REFINE_MAX_CHARS + 1), notes: [] }));
    expect(await refineLaunchPrompt(h.api, { ...input, purpose: "follow-up" })).toBeNull();
  });
});
