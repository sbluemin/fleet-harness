import {
  AnthropicMessagesGateway,
  createClaudeCodexCompactionStore,
  ContextWindowExceededError,
  CLAUDE_COMPACT_CONTINUATION_MARKER,
  CLAUDE_COMPACT_PROMPT_MARKER,
} from "../../src/index.js";
import type {
  AdapterResponse,
  AiGatewayAdapter,
  AiGatewayStoredSettings,
  AnthropicMessagesRequest,
  CanonicalResponseRequest,
} from "../../src/index.js";
import type { GatewayFailureRecord } from "../../src/index.js";
import type { GatewayHttpHandlerContext } from "../../src/router/types.js";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_GATEWAY_REQUEST_BODY_BYTES,
  MUSE_CODE_RESPONSES_URL,
  OPENCODE_MESSAGES_URL,
  encodeReasoningSignature,
  XAI_CLI_RESPONSES_URL,
  XAI_RESPONSES_URL,
  buildAnthropicModelList,
  createAiGatewayRouter as createCoreAiGatewayRouter,
  fallbackGatewayRoutingAssignment as decideGatewayRoutingAssignment,
  decideGatewayRoutingAssignment as decideGatewayRoutingAssignmentWithJev,
  errorMessage,
  applyClaudeNativeModels,
  findGatewayModel,
  GATEWAY_MODELS,
  GatewayRoutingDistribution,
  parseGatewayAssignmentRequest,
  SystemOneClient,
  SystemOneError,
} from "../../src/index.js";
import {
  pickSeat,
} from "../../src/fleet/routing-fallback.js";
import { buildGatewayLoadout } from "../../src/fleet/model-loadout.js";
import type { AiGatewayRouteDeps, GatewayAssignmentExposure } from "../../src/index.js";
import { wireLogFixture } from "../helpers/wire-log.js";

function requireGatewayModel(id: string) {
  const model = findGatewayModel(id);
  if (!model) throw new Error(`missing gateway model fixture: ${id}`);
  return model;
}

function aiGatewaySettingsStub(settings: AiGatewayStoredSettings): () => AiGatewayStoredSettings {
  return () => settings;
}

const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;
const ANTHROPIC_CRED = "sk-ant-oat01-caller";
const SUBSCRIPTION_TOKEN = "chatgpt-subscription-access-token";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

/** Claude Code's shell-first directive as it arrives, with one neighbour on each side. */
/** A caller catalog carrying the tools provider policies decide about. */
const SEARCH_CATALOG = [
  { name: "Read", input_schema: { type: "object", properties: {} } },
  { name: "Grep", input_schema: { type: "object", properties: {} } },
  { name: "Glob", input_schema: { type: "object", properties: {} } },
  { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
];

describe("Claude Codex compaction routing", () => {

  it("refuses compact events without the process token", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      compactionStore: {} as any,
      compactionHookToken: "hook-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      pathname: `${BASE}/v1/compact-events`,
      rawBody: { hook_event_name: "PreCompact", session_id: "session", trigger: "auto" },
    }));
    expect(res.status).toBe(401);
  });
});

/**
 * 위임 배정. 라우팅 Mod가 사실을 보내고 Console이 모델과 강도를 답하는 경로다.
 *
 * 이 계약을 여기서 고정하는 이유는 세 가지가 한 요청 안에서 동시에 성립해야 하기 때문이다:
 * 자격 없는 호출은 원문 프롬프트를 실은 본문을 읽지 못해야 하고, 답은 훅이 그대로 스폰에
 * 실을 수 있는 모양이어야 하며, Fleet 자신의 실행 정체성을 호스트가 이름으로 불렀다고 해서
 * 배정이 꺼지면 안 된다 — 마지막 것은 목록에 보이는 이름 하나가 배정을 통째로 끄는 함정을
 * 실제로 만들었던 자리다.
 */
describe("delegation assignment", () => {
  const MOD_TOKEN = "mod-token";
  const exposure = {
    delegationRoutingEnabled: true,
    delegationModels: [requireGatewayModel("codex--gpt-5.6-terra")],
  };
  const assigningRouter = () => createAiGatewayRouter({
    readAuth,
    modHookToken: MOD_TOKEN,
    assignRouting: (request) => decideGatewayRoutingAssignment(parseGatewayAssignmentRequest(request), exposure),
  });
  // 자격 없음은 `null`로 말한다. `undefined`를 넘기면 기본 인자가 되살아나 자격이 실린다.
  const assign = async (body: Record<string, unknown>, token: string | null = MOD_TOKEN) => {
    const res = response();
    await assigningRouter().handle(ctx({
      res,
      method: "POST",
      pathname: `${BASE}/v1/fleet/routing/assign`,
      headers: token === null ? {} : { "x-fleet-mod-token": token },
      rawBody: body,
    }));
    return res;
  };

  it("uses local fallback without invoking an AI when routing is off", async () => {
    const choose = vi.fn(async () => { throw new Error("must not call AI"); });
    const decision = await decideGatewayRoutingAssignmentWithJev(
      { surface: "agent", prompt: "review this code" },
      { ...exposure, delegationRoutingEnabled: false, delegationRoutingMode: "model" },
      { choose },
    );
    expect(decision.model).toBe("claude-gateway--codex--gpt-5.6-terra");
    expect(decision.because).toContain("fallback");
    expect(choose).not.toHaveBeenCalled();
  });

  it("runs burst decisions in parallel and reports committed assignments per quota observation", async () => {
    const distribution = new GatewayRoutingDistribution();
    const at = Date.now();
    let current: GatewayAssignmentExposure = {
      delegationRoutingEnabled: true, delegationRoutingMode: "model", distribution,
      delegationModels: [requireGatewayModel("codex--gpt-5.6-terra"), requireGatewayModel("xai--grok-composer-2.5-fast")],
      quota: { codex: { status: "ok", fetchedAt: at, windows: [] }, xai: { status: "ok", fetchedAt: at, windows: [] } },
    };
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const seen: number[] = [];
    let calls = 0;
    const choose = vi.fn(async ({ state, criteria }: any) => {
      // 동일 스냅샷으로 병렬 판단하되 이후 호출은 확정된 배정을 보아야 한다.
      expect(Object.values(criteria).some((value: any) => value.includes("codex"))).toBe(true);
      expect(Object.values(criteria).some((value: any) => value.includes("xai"))).toBe(true);
      seen.push(state.gateway_models.recentAssignments.providers.codex.assignments);
      calls++;
      if (calls === 1) await barrier;
      return Object.keys(criteria).find(key => criteria[key].includes("codex"))!;
    });
    const options = { choose, refreshExposure: () => current };
    const first = decideGatewayRoutingAssignmentWithJev({ surface: "agent" }, current, options);
    const controller = new AbortController();
    const cancelled = decideGatewayRoutingAssignmentWithJev({ surface: "agent" }, current, { ...options, signal: controller.signal });
    const rejected = expect(cancelled).rejects.toThrow();
    controller.abort();
    const second = decideGatewayRoutingAssignmentWithJev({ surface: "agent" }, current, options);
    await rejected;
    expect(calls).toBe(3);
    expect(seen).toEqual([0, 0, 0]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([0, 0, 0]);
    await decideGatewayRoutingAssignmentWithJev({ surface: "agent" }, current, options);
    expect(seen).toEqual([0, 0, 0, 2]);
    expect(distribution.snapshot(current).providers.codex?.assignments).toBe(3);
    current = { ...current, quota: { ...current.quota, xai: { status: "ok", fetchedAt: at + 1, windows: [] } } };
    expect(distribution.snapshot(current).providers.codex?.assignments).toBe(3);
    current = { ...current, quota: { ...current.quota, codex: { status: "stale", fetchedAt: at, windows: [] } } };
    expect(distribution.snapshot(current).providers.codex?.assignments).toBe(3);
    current = { ...current, quota: { ...current.quota, codex: { status: "ok", fetchedAt: at + 1, windows: [] } } };
    expect(distribution.snapshot(current).providers.codex?.assignments).toBe(0);
    await decideGatewayRoutingAssignmentWithJev({ surface: "agent" }, current, options);
    expect(seen).toEqual([0, 0, 0, 2, 0]);
    distribution.snapshot({ ...current, quota: { codex: { status: "ok", fetchedAt: at, windows: [] } } });
    expect(distribution.snapshot(current).providers.codex?.assignments).toBe(1);
  });

  it("refuses an assignment request that carries no mod credential", async () => {
    const res = await assign({ surface: "agent", prompt: "secret host prompt" }, null);
    expect(res.status).toBe(401);
  });

  it("assigns a model and effort to a run that named none", async () => {
    const res = await assign({
      surface: "agent",
      prompt: "map the delegation surfaces",
      description: "map surfaces",
      subagentType: "general-purpose",
      providerPlugin: "engine",
      requestedEffort: null,
      fork: false,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      model: "claude-gateway--codex--gpt-5.6-terra",
      because: "no model named → work",
    });
  });

  it("still assigns when the host names Fleet's own execution identity", async () => {
    // 엔진은 이 정체성을 플러그인 소유로 보고한다. 모델을 소유하는 쪽은 배정이므로,
    // 이름을 불렀다는 이유로 남의 정의처럼 비켜서면 안 된다.
    const res = await assign({
      surface: "agent",
      subagentType: "fleet:execute",
      providerPlugin: "fleet",
    });

    expect(JSON.parse(res.body)).toMatchObject({ model: "claude-gateway--codex--gpt-5.6-terra" });
  });

  it("spreads a fan across providers instead of piling onto one, and steps over a spent allowance", async () => {
    // 고정 목록의 머리만 집으면 같은 등급의 팬아웃이 전원 한 모델로 간다. 공급자별 부하를
    // 세는 것이 그 몰림을 막는 유일한 상태이므로, 그 상태가 실제로 돌아가는지 본다.
    const providerLoad = new Map<string, number>();
    const spread = {
      delegationRoutingEnabled: true,
      delegationModels: [
        requireGatewayModel("codex--gpt-5.6-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      // xai는 소진 직전이다. 읽을 수 있는 대안이 있는 한 그쪽으로 보내지 않는다.
      quota: {
        codex: { status: "ok", fetchedAt: 1, windows: [{ id: "cycle", usedPercent: 4, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: 0 } }] },
        xai: { status: "ok", fetchedAt: 1, windows: [{ id: "cycle", usedPercent: 99, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: 0 } }] },
      },
      providerLoad,
    } satisfies GatewayAssignmentExposure;

    const carried = [0, 1, 2, 3].map(() => decideGatewayRoutingAssignment(
      { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine" },
      spread,
    ).model);

    expect(carried.every((model) => model === "claude-gateway--codex--gpt-5.6-terra")).toBe(true);
    expect(providerLoad.get("codex")).toBe(4);
    expect(providerLoad.get("xai")).toBeUndefined();
  });

  it("alternates between providers whose allowances read the same", async () => {
    const providerLoad = new Map<string, number>();
    const even = {
      delegationRoutingEnabled: true,
      delegationModels: [
        requireGatewayModel("codex--gpt-5.6-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      quota: {
        codex: { status: "ok", fetchedAt: 1, windows: [{ id: "cycle", usedPercent: 4, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: 0 } }] },
        xai: { status: "ok", fetchedAt: 1, windows: [{ id: "cycle", usedPercent: 4, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: 0 } }] },
      },
      providerLoad,
    } satisfies GatewayAssignmentExposure;

    for (const _ of [0, 1, 2, 3]) {
      decideGatewayRoutingAssignment(
        { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine" },
        even,
      );
    }

    // 넷을 둘로 나눈다. 한 공급자가 다른 쪽보다 한 갈래 넘게 앞서지 않는다.
    expect(providerLoad.get("codex")).toBe(2);
    expect(providerLoad.get("xai")).toBe(2);
  });

  it("never assigns a model the user reserved for the host, whatever the dispatch carries", async () => {
    // 호스트 전용은 "위임에 주지 말라"는 뜻이다. 후보 목록에서 빼는 것만으로는 지켜지지
    // 않는다 — 실려 온 모델을 그대로 돌려주는 길이 그 옆에 있으면 거기로 샌다.
    const reserved = "claude-gateway--xai--grok-4.6";
    const hostOnly = {
      delegationRoutingEnabled: true,
      delegationModels: [requireGatewayModel("codex--gpt-5.6-terra")],
    } satisfies GatewayAssignmentExposure;

    const decision = decideGatewayRoutingAssignment(
      { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine", requestedModel: reserved },
      hostOnly,
    );

    expect(decision.model).not.toBe(reserved);
    expect(decision.model).toBe("claude-gateway--codex--gpt-5.6-terra");
  });

  it("routes a workflow stage instead of letting it keep the model it inherited", async () => {
    // 스테이지는 스폰을 지나지 않아 세션의 모델을 그대로 물려받는다. 그것을 결정으로 읽으면
    // 한 워크플로우의 스테이지 전부가 같은 모델에 몰리고 배분이 아예 돌지 않는다.
    const providerLoad = new Map<string, number>();
    const inherited = "claude-gateway--xai--grok-4.6";
    const exposure = {
      delegationRoutingEnabled: true,
      delegationModels: [
        requireGatewayModel("codex--gpt-5.6-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      providerLoad,
    } satisfies GatewayAssignmentExposure;

    const carried = [0, 1, 2, 3].map(() => decideGatewayRoutingAssignment(
      { surface: "stage", requestedModel: inherited },
      exposure,
    ).model);

    expect(carried).not.toContain(inherited);
    expect(new Set(carried).size).toBe(2);
    expect(providerLoad.get("codex")).toBe(2);
    expect(providerLoad.get("xai")).toBe(2);
  });

  it("proxies native Claude requests to Anthropic with caller credentials and without alias advertisement", async () => {
    // 설치된 CLI의 표에는 구버전 명시 id도 섞여 온다. alias는 그중 최신으로만 풀려야 한다.
    const ensureClaudeNativeModels = vi.fn(async () => {
      applyClaudeNativeModels([
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      ]);
    });
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ANTHROPIC_CRED}`);
      expect(JSON.parse(String(init?.body)).model).toBe("claude-sonnet-5");
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const router = createAiGatewayRouter({ fetch: fetchMock, ensureClaudeNativeModels });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "sonnet",
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureClaudeNativeModels).toHaveBeenCalledTimes(1);

    // 위임 훅은 CLI alias 해석을 거치지 않는다. 배정 ID를 그대로 보내도 API ID와 1M 헤더가 맞아야 한다.
    const decision = decideGatewayRoutingAssignment(
      { surface: "agent", requestedModel: "opus" },
      { delegationRoutingEnabled: true, delegationModels: [requireGatewayModel("claude--opus-1m")] },
    );
    expect(decision.model).toBe("opus[1m]");
    const nativeRouter = createAiGatewayRouter({ fetch: vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).model).toBe("claude-opus-5-5");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ANTHROPIC_CRED}`);
      expect(headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
      return new Response("{}", { status: 200 });
    }) });
    const delegated = response();
    await nativeRouter.handle(ctx({ res: delegated, token: ANTHROPIC_CRED, model: decision.model!, messages: [{ role: "user", content: "hello" }] }));
    expect(delegated.status).toBe(200);

    // Verify /v1/models excludes native Claude aliases (no duplicate advertisement)
    const discovery = buildAnthropicModelList(GATEWAY_MODELS);
    const discoveredIds = discovery.data.map((entry) => entry.id);
    expect(discoveredIds.some((id) => id.startsWith("claude-gateway--claude--") || id === "sonnet" || id === "opus[1m]")).toBe(false);
  });

  it("routes delegation to Claude native models without gateway prefix", () => {
    const sonnet = requireGatewayModel("claude--sonnet");
    const exposure = {
      delegationRoutingEnabled: true,
      delegationModels: [sonnet],
      quota: { claude: { status: "ok" } },
    } satisfies GatewayAssignmentExposure;

    const loadout = buildGatewayLoadout(exposure);
    expect(loadout.models.filter((m) => m.provider === "claude").map((m) => m.modelId)).toEqual(["sonnet"]);

    const decision = decideGatewayRoutingAssignment(
      { surface: "agent", requestedModel: "sonnet" },
      exposure,
    );
    expect(decision.model).toBe("sonnet");
    expect(decision.effort).toBe("medium");
  });

  it("leaves a fork on the session model", async () => {
    const res = await assign({ surface: "agent", fork: true, subagentType: "general-purpose" });

    const decision = JSON.parse(res.body) as Record<string, unknown>;
    expect(decision).not.toHaveProperty("model");
    expect(decision.label).toBe("session model");
  });

  it("shares normalized routing evidence with Jev and AI models and preserves fallback lifecycle", async () => {
    const providerLoad = new Map<string, number>();
    const jevExposure = {
      delegationRoutingEnabled: true,
      delegationRoutingMode: "jev",
      delegationModels: [
        requireGatewayModel("codex--gpt-5.6-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      providerLoad,
      providerPriority: ["codex", "xai"],
    } satisfies GatewayAssignmentExposure;
    const request = {
      surface: "agent" as const,
      description: "map surfaces",
      prompt: "map the delegation surfaces",
      subagentType: "general-purpose",
      providerPlugin: "engine",
    };

    let jevState: unknown;
    let jevInstructions: unknown;
    let jevCriteria: unknown;
    let xaiChoice = "";
    const picking = new SystemOneClient({
      readApiKey: async () => "tsv_test",
      maxAttempts: 1,
      timeoutMs: 2_000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.state).not.toHaveProperty("tier");
        expect(body.state.prompt).toBe(request.prompt);
        jevState = body.state;
        jevInstructions = body.questions.seat.instructions;
        jevCriteria = body.questions.seat.criteria;
        xaiChoice = Object.keys(jevCriteria as Record<string, string>).find((key) => (jevCriteria as Record<string, string>)[key]!.includes("--xai--"))!;
        expect(body.state.gateway_models.models[0]).toMatchObject({ preferenceRank: 1, quotaPool: "codex:shared" });
        expect(body.state.gateway_models.quotaPools["xai:shared"]).toEqual({ observation: "unknown" });
        expect(body.state).not.toHaveProperty("candidates");
        return new Response(JSON.stringify({
        model: "jev-latest",
        answers: {
          seat: {
            type: "choice",
            choice: xaiChoice,
            confidence: 0.91,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
      },
    });
    const picked = await decideGatewayRoutingAssignmentWithJev(request, jevExposure, { client: picking });
    expect(picked.model).toBe("claude-gateway--xai--grok-composer-2.5-fast");
    expect(picked.because).toContain("· jev");
    expect(providerLoad.get("xai")).toBe(1);
    expect(providerLoad.get("codex")).toBeUndefined();

    const aiPicked = await decideGatewayRoutingAssignmentWithJev(request, {
      ...jevExposure, delegationRoutingMode: "model", providerLoad: new Map(),
    }, { choose: async ({ state, criteria, instructions }) => {
      expect(state).toEqual(jevState);
      expect(instructions).toEqual(jevInstructions);
      expect(criteria).toEqual(jevCriteria);
      expect(criteria[xaiChoice]).toContain("claude-gateway--xai--grok-composer-2.5-fast");
      return xaiChoice;
    } });
    expect(aiPicked.model).toBe(picked.model);
    expect(aiPicked.because).toContain("AI model");

    const unsigned = new SystemOneClient({
      readApiKey: async () => undefined,
      maxAttempts: 1,
      timeoutMs: 2_000,
      fetch: async () => {
        throw new Error("TypeSafe must not be called while signed out");
      },
    });
    const fallback = await decideGatewayRoutingAssignmentWithJev(request, jevExposure, { client: unsigned });
    expect(fallback.model).toBe("claude-gateway--codex--gpt-5.6-terra");
    expect(fallback.because).toContain("fallback: routing decision failed: not signed in");
    expect(providerLoad.get("codex")).toBe(1);
    expect(providerLoad.get("xai")).toBe(1);

    // await 중 host-only로 바뀌면 옛 후보로 결정론 확정하지 않는다.
    const refreshed = await decideGatewayRoutingAssignmentWithJev(request, jevExposure, {
      client: unsigned,
      refreshExposure: () => ({
        delegationRoutingEnabled: true,
        delegationRoutingMode: "jev",
        delegationModels: [requireGatewayModel("xai--grok-composer-2.5-fast")],
        providerLoad,
      }),
    });
    expect(refreshed.model).toBe("claude-gateway--xai--grok-composer-2.5-fast");
    expect(refreshed.because).toContain("fallback: routing decision failed: not signed in");
    expect(refreshed.because).not.toContain("· jev");
    expect(providerLoad.get("xai")).toBe(2);

    // 유효한 후보 선택은 부가 확률이 없거나 서로 맞지 않아도 수락한다.
    for (const metadata of [{}, { confidence: 2, probabilities: { c0: 0.9, c1: 0.2 } }]) {
      const chosen = await decideGatewayRoutingAssignmentWithJev(request, {
        ...jevExposure, providerLoad: new Map(),
      }, {
        client: new SystemOneClient({
          readApiKey: async () => "tsv_test", maxAttempts: 1,
          fetch: async () => new Response(JSON.stringify({
            answers: { seat: { type: "choice", choice: xaiChoice, ...metadata } },
          })),
        }),
      });
      expect(chosen.model).toBe("claude-gateway--xai--grok-composer-2.5-fast");
      expect(chosen.because).toContain("· jev");
      expect(chosen.because).not.toContain("fallback");
    }
    // 확률 검증 제거가 후보 경계를 넓히지는 않는다.
    const invalid = await decideGatewayRoutingAssignmentWithJev(request, jevExposure, {
      client: new SystemOneClient({
        readApiKey: async () => "tsv_test", maxAttempts: 1,
        fetch: async () => new Response(JSON.stringify({
          answers: { seat: { type: "choice", choice: "not-offered" } },
        })),
      }),
    });
    expect(invalid.because).toContain("fallback: routing decision failed: invalid choice");

    // 좌석이 하나면 Jev를 부르지 않으므로 원장도 그렇게 말한다.
    const sole = await decideGatewayRoutingAssignmentWithJev(request, {
      delegationRoutingEnabled: true,
      delegationRoutingMode: "jev",
      delegationModels: [requireGatewayModel("xai--grok-composer-2.5-fast")],
      providerLoad: new Map(),
    }, {
      client: new SystemOneClient({
        readApiKey: async () => "tsv_test",
        fetch: async () => {
          throw new Error("Jev must not run for a sole candidate");
        },
      }),
    });
    expect(sole.model).toBe("claude-gateway--xai--grok-composer-2.5-fast");
    expect(sole.because).toContain("· sole candidate");
    expect(sole.because).not.toContain("· jev");

    const abort = new AbortController();
    abort.abort();
    const cancelled = new SystemOneClient({
      readApiKey: async () => "tsv_test",
      maxAttempts: 1,
      timeoutMs: 2_000,
      fetch: async () => {
        throw new Error("fetch must not run after caller abort");
      },
    });
    await expect(decideGatewayRoutingAssignmentWithJev(request, jevExposure, {
      client: cancelled,
      signal: abort.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    // unsigned + invalid-choice 두 결정론 fallback이 codex를 올렸다.
    expect(providerLoad.get("codex")).toBe(2);
    expect(providerLoad.get("xai")).toBe(2);
  });

  it("keeps simultaneous quota bottlenecks and uncertain observations in routing evidence", async () => {
    const now = Date.now();
    const hour = 3_600_000;
    const window = (id: string, usedPercent: number, durationHours: number, remainingHours: number) => ({
      id, usedPercent, resetsAt: now + remainingHours * hour,
      period: { durationMs: durationHours * hour, durationBasis: "upstream" },
    });
    const windows = [window("session", 60, 5, 1), window("week", 70, 168, 100.8)];
    const run = async (quota: GatewayAssignmentExposure["quota"]) => {
      let data: any;
      const decision = await decideGatewayRoutingAssignmentWithJev({ surface: "agent", prompt: "review authentication" }, {
        delegationRoutingEnabled: true, delegationRoutingMode: "model", quota,
        delegationModels: [requireGatewayModel("codex--gpt-5.6-terra"), requireGatewayModel("xai--grok-composer-2.5-fast")],
      }, { choose: async ({ state }) => { data = (state as Record<string, unknown>).gateway_models; return "c0"; } });
      expect(decision.model).toBe("claude-gateway--codex--gpt-5.6-terra");
      return data;
    };
    const quota = { status: "ok", fetchedAt: now, windows };
    const data = await run({ codex: quota });
    expect(Object.keys(data.quotaPools)).toEqual(["codex:shared", "xai:shared"]);
    expect(data.quotaPools["codex:shared"]).toMatchObject({
      observation: "fresh", remainingPercent: 30, sustainableHeadroom: 0.5,
      recovery: { remainingPercent: 100 },
    });
    expect(data.quotaPools["codex:shared"].recovery.inSeconds).toBeGreaterThan(100 * 3600);
    expect(data.quotaPools["codex:shared"].recovery.inSeconds).toBeLessThanOrEqual(100.8 * 3600);
    expect(data.quotaPools["codex:shared"]).not.toHaveProperty("windows");

    const expired = (await run({ codex: { ...quota, windows: [window("expired", 100, 5, -0.01)] } })).quotaPools["codex:shared"];
    expect(expired.observation).toBe("stale");
    expect(expired).not.toHaveProperty("remainingPercent");
    const retained = (await run({ codex: { ...quota, status: "stale", fetchedAt: now - 4 * 60_000 } })).quotaPools["codex:shared"];
    expect(retained).toMatchObject({ observation: "stale", remainingPercent: 30 });
    const partial = (await run({ codex: { ...quota, windows: [{ id: "session", usedPercent: 100 }] } })).quotaPools["codex:shared"];
    expect(partial).toMatchObject({ observation: "partial", remainingPercent: 0 });
    expect(partial).not.toHaveProperty("sustainableHeadroom");
    const invalid = (await run({ codex: { ...quota, windows: [{ id: "session", usedPercent: NaN }] } })).quotaPools["codex:shared"];
    expect(invalid).not.toHaveProperty("remainingPercent");
    const exhausted = (await run({ codex: { ...quota, windows: [window("week", 105, 168, 1)] } })).quotaPools["codex:shared"];
    expect(exhausted).toMatchObject({ remainingPercent: 0, sustainableHeadroom: 0 });
    const future = (await run({ codex: { ...quota, fetchedAt: now + hour } })).quotaPools["codex:shared"];
    expect(future).toEqual({ observation: "unknown" });
  });

  it("falls back for a stage that carries no work text instead of guessing quietly", async () => {
    const providerLoad = new Map<string, number>();
    const decision = await decideGatewayRoutingAssignmentWithJev(
      { surface: "stage", requestedModel: "claude-gateway--xai--grok-composer-2.5-fast" },
      {
        delegationRoutingEnabled: true,
        delegationRoutingMode: "jev",
        delegationModels: [
          requireGatewayModel("codex--gpt-5.6-terra"),
          requireGatewayModel("xai--grok-composer-2.5-fast"),
        ],
        providerLoad,
      },
      {
        client: new SystemOneClient({
          readApiKey: async () => "tsv_test",
          fetch: async () => {
            throw new SystemOneError("Jev must not be called without stage work text", undefined);
          },
        }),
      },
    );

    expect(decision.model).toBe("claude-gateway--codex--gpt-5.6-terra");
    expect(decision.because).toContain("fallback: Workflow stage");
    expect(providerLoad.get("codex")).toBe(1);
  });

  it("preserves deterministic spend order with providerPriority even under critical quota", () => {
    const reachable = [
      {
        model: "claude-gateway--codex--gpt-5.6-terra",
        provider: "codex" as const,
        label: "composer",
      },
      {
        model: "claude-gateway--xai--grok-composer-2.5-fast",
        provider: "xai" as const,
        label: "grok",
      },
    ];
    const exposure: GatewayAssignmentExposure = {
      delegationRoutingEnabled: true,
      delegationModels: [
        requireGatewayModel("codex--gpt-5.6-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      providerPriority: ["codex", "xai"],
      quota: {
        codex: {
          status: "ok",
          windows: [{ id: "monthly", usedPercent: 100 }],
        },
      },
    };

    // 결정론 pickSeat: 소진 순서가 압박 예측을 이겨 critical인 codex를 그대로 집는다.
    const seat = pickSeat(reachable, exposure);
    expect(seat.model.provider).toBe("codex");
    expect(seat.suffix).toBe(" · spend order");


  });

  it("spreads provider load across concurrent Jev assignments resolving at the same barrier", async () => {
    const providerLoad = new Map<string, number>();
    const jevExposure = {
      delegationRoutingEnabled: true,
      delegationRoutingMode: "jev",
      delegationModels: [
        requireGatewayModel("codex--gpt-5.6-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      providerLoad,
    } satisfies GatewayAssignmentExposure;

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    let inFlight = 0;
    const barrierClient = new SystemOneClient({
      readApiKey: async () => "tsv_test",
      maxAttempts: 1,
      timeoutMs: 5_000,
      fetch: async () => {
        inFlight++;
        await barrier;
        throw new Error("simulated barrier fallback");
      },
    });

    const req1 = { surface: "agent" as const, prompt: "task 1", description: "work 1" };
    const req2 = { surface: "agent" as const, prompt: "task 2", description: "work 2" };

    const p1 = decideGatewayRoutingAssignmentWithJev(req1, jevExposure, { client: barrierClient });
    const p2 = decideGatewayRoutingAssignmentWithJev(req2, jevExposure, { client: barrierClient });

    while (inFlight < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    releaseBarrier();

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.model).not.toBe(d2.model);
    expect(providerLoad.get("codex")).toBe(1);
    expect(providerLoad.get("xai")).toBe(1);
  });

  it("completes a normal POST assign request without premature abort during delayed Jev", async () => {
    let seenSignal: AbortSignal | undefined;
    const router = createAiGatewayRouter({
      readAuth,
      modHookToken: MOD_TOKEN,
      assignRouting: async (_request, options) => {
        seenSignal = options?.signal;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          model: "claude-gateway--codex--gpt-5.6-terra",
          label: "composer",
          because: "test · jev",
        };
      },
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void router.handle({ req, res, pathname: url.pathname });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${BASE}/v1/fleet/routing/assign`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-mod-token": MOD_TOKEN,
        },
        body: JSON.stringify({
          surface: "agent",
          prompt: "map the delegation surfaces",
          description: "map surfaces",
          subagentType: "general-purpose",
          providerPlugin: "engine",
        }),
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.model).toBe("claude-gateway--codex--gpt-5.6-terra");
      expect(data.because).toBe("test · jev");
      expect(seenSignal?.aborted).toBe(false);
    } finally {
      server.close();
    }
  });

  it("aborts an in-flight Jev assign on real HTTP disconnect", async () => {
    let seenSignal: AbortSignal | undefined;
    let abortPromiseResolve!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      abortPromiseResolve = resolve;
    });

    const router = createAiGatewayRouter({
      readAuth,
      modHookToken: MOD_TOKEN,
      assignRouting: async (_request, options) => {
        seenSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => {
          abortPromiseResolve();
        }, { once: true });
        await new Promise<never>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          options?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      },
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void router.handle({ req, res, pathname: url.pathname });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const payload = JSON.stringify({
        surface: "agent",
        prompt: "map the delegation surfaces",
        description: "map surfaces",
        subagentType: "general-purpose",
        providerPlugin: "engine",
      });

      const client = net.connect({ port, host: "127.0.0.1" }, () => {
        client.write(
          `POST ${BASE}/v1/fleet/routing/assign HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `x-fleet-mod-token: ${MOD_TOKEN}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
          payload,
        );
        const check = setInterval(() => {
          if (seenSignal !== undefined) {
            clearInterval(check);
            client.destroy();
          }
        }, 10);
      });

      await abortPromise;
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("caller credential", () => {
  it("rejects a request that carries no credential", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res }));

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Missing Anthropic credential" },
    });
  });

});

describe("upstream credential", () => {

  it("never echoes the subscription token back to the caller", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain(SUBSCRIPTION_TOKEN);
  });
});

describe("oversized skill payloads", () => {
  const LISTING = [
    "The following skills are available for use with the Skill tool:",
    "",
    "- agent-browser: Browser automation CLI for AI agents.",
    "- claude-api: Reference for the Claude API / Anthropic SDK.",
    "TRIGGER — read BEFORE opening the target file.",
  ].join("\n");
  // 4 chars/token puts this at 150_000 tokens, past the 54_400 one skill may take
  // from a 272_000-token window.
  const BODY = "Base directory for this skill: /tmp/bundled-skills/2.1.222/abc/claude-api\n\n"
    + "x".repeat(600_000);

  function sentText(request: AnthropicMessagesRequest | undefined, index: number): string {
    const content = request?.messages[index]?.content;
    if (typeof content === "string") return content;
    const block = content?.[0];
    return block && "text" in block && typeof block.text === "string" ? block.text : "";
  }

  it("withholds the body before the provider sees it, and delists the skill from then on", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const listingTurn = { role: "user", content: [{ type: "text", text: LISTING }] };

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      messages: [listingTurn, { role: "user", content: [{ type: "text", text: BODY }] }],
    }));

    const first = streamSpy.mock.calls[0]?.[0];
    expect(sentText(first, 1)).toMatch(/^\[Fleet AI gateway withheld the "claude-api" skill/);
    expect(sentText(first, 1)).not.toContain("xxxx");
    // The listing loses the entry in the same request that withheld its body.
    expect(sentText(first, 0)).not.toContain("claude-api");
    expect(sentText(first, 0)).toContain("- agent-browser:");

    // A later turn on the same router never carries the entry at all.
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      messages: [listingTurn],
    }));

    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).not.toContain("claude-api");
    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).toContain("- agent-browser:");
  });
});

// 선별은 광고 목록이 아니라 지출 계약이다. 디스커버리가 켠 모델만 내놓아도 실행 경로가 카탈로그
// 전체를 받아 주면, raw id를 아는 호출자가 사용자가 끈 모델로 그 구독을 그대로 쓴다.

describe("Astra asynchronous tools", () => {
  it("keeps async tools disabled by default and preserves caller parallel-tool control", async () => {
    const bodies: Array<Record<string, any>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"type":"response.completed","response":{"id":"r","model":"gpt-6-astra","usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const tools = ["Read", "Grep", "Glob", "Bash", "Edit", "AskUserQuestion", "mcp__other__Read"]
      .map((name) => ({ name, input_schema: { type: "object", properties: {}, additionalProperties: false } }));
    const base = {
      model: "claude-gateway--codex--gpt-6-astra-1m[1m]",
      messages: [{ role: "user", content: "read the files" }], tools, stream: true, max_tokens: 128,
    };
    try {
      for (const rawBody of [
        base,
        { ...base, stream: false },
        { ...base, tool_choice: { type: "auto", disable_parallel_tool_use: true } },
        { ...base, model: "claude-gateway--codex--gpt-6-sol" },
      ]) {
        const res = response();
        await router.handle(ctx({ res, token: ANTHROPIC_CRED, rawBody }));
        expect(res.status).toBe(200);
      }
      for (const body of bodies) {
        expect(body.tools.every((tool: { async?: boolean }) => tool.async === undefined)).toBe(true);
      }
      expect(bodies[0]?.store).toBe(false);
      expect(bodies[2]?.parallel_tool_calls).toBe(false);
    } finally {
      router.dispose();
    }
  });
});

describe("OpenCode conversation routing", () => {
  it("sends a stable, isolated session through each provider wire", async () => {
    const sessions: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const session = new Headers(init?.headers).get("x-opencode-session");
      expect(session).toBeTruthy();
      expect(session).not.toContain("private-user");
      sessions.push(session!);
      const endpoint = String(url);
      return new Response(endpoint.endsWith("/responses")
        ? 'data: {"type":"response.completed","response":{"id":"r","model":"muse-spark-1.3-contributor","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
        : 'data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const router = createAiGatewayRouter({ fetch: fetchMock, readOpencodeApiKey: async () => "test-key" });
    try {
      for (const model of ["muse-spark-1.3-contributor", "deepseek-v4.1-flash"]) {
        for (const userId of ["private-user-session-a", "private-user-session-a", "private-user-session-b", null, null]) {
          const res = response();
          await router.handle(ctx({
            res, token: ANTHROPIC_CRED, model: `claude-gateway--opencode--${model}`,
            metadata: userId === null ? null : { user_id: userId },
          }));
          expect(res.status).toBe(200);
        }
      }
      expect(sessions).toHaveLength(10);
      for (let index = 0; index < sessions.length; index += 5) {
        expect(sessions[index]).toBe(sessions[0]);
        expect(sessions[index + 1]).toBe(sessions[index]);
        expect(sessions[index + 2]).not.toBe(sessions[index]);
        expect(sessions[index + 3]).not.toBe(sessions[index + 4]);
      }
    } finally {
      router.dispose();
    }
  });
});

describe("Muse Code routing", () => {
  const MUSE_KEY = "LLM|muse-model-key";
  const MUSE_MODEL = "claude-gateway--muse-code--muse-spark-1.3-contributor";
  const signedIn = () => ({ status: "ok" as const, credentials: { apiKey: MUSE_KEY, accountToken: "acct", method: "keychain" as const } });
  // Muse가 실제로 보내는 reasoning id 형태(콜론 포함)를 쓴다.
  const REASONING_ID = "rs_n1:rs_n2";
  const museFrames = [
    { type: "response.created", response: { id: "r1", model: "muse-spark-1.3-contributor", usage: null } },
    { type: "response.reasoning_text.delta", item_id: REASONING_ID, output_index: 0, delta: "check a.ts" },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: REASONING_ID, encrypted_content: "muse-blob-new", summary: [] } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"file_path":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '"/a.ts"}' },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"file_path":"/a.ts"}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: '{"file_path":"/a.ts"}' } },
    { type: "response.completed", response: { id: "r1", model: "muse-spark-1.3-contributor", usage: { input_tokens: 10, output_tokens: 5 } } },
  ];

  it("runs a tool loop on the sign-in key and replays only its own reasoning, under its original id", async () => {
    const calls: Array<{ url: string; headers: Headers; redirect?: RequestRedirect; body: Record<string, any> }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), redirect: init?.redirect, body: JSON.parse(String(init?.body)) });
      return new Response(museFrames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: signedIn });
    const tools = [
      ...SEARCH_CATALOG,
      { name: "Artifact", input_schema: { type: "object", properties: { file_paths: { type: "array", items: { type: "string", pattern: "^[^\\0]*$" } } } } },
    ];
    const firstTurn = [
      { role: "user", content: "read b.ts" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: encodeReasoningSignature("rs_foreign", "xai-blob", "xai") },
          { type: "text", text: "Now a.ts." },
        ],
      },
      { role: "user", content: "go on" },
    ];
    const first = response();
    const second = response();
    try {
      await router.handle(ctx({ res: first, token: ANTHROPIC_CRED, model: MUSE_MODEL, tools, toolChoice: { type: "auto" }, messages: firstTurn }));

      expect(first.status).toBe(200);
      const [call] = calls;
      expect(call!.url).toBe(MUSE_CODE_RESPONSES_URL);
      // 키가 실린 요청은 고정 엔드포인트 밖으로 리다이렉트되어 재전송되지 않는다.
      expect(call!.redirect).toBe("error");
      expect(call!.headers.get("authorization")).toBe(`Bearer ${MUSE_KEY}`);
      expect(call!.headers.get("x-api-version")).toBe("1.0.0");
      expect(call!.body.model).toBe("muse-spark-1.3-contributor");
      expect(call!.body.tool_choice).toBeUndefined();
      expect(call!.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["Read", "Grep", "Glob", "Artifact"]);
      expect(call!.body.tools.every((tool: Record<string, unknown>) => tool.type === "function" && tool.strict === undefined)).toBe(true);
      expect(JSON.stringify(call!.body.tools)).not.toContain("pattern");
      // 다른 공급자의 blob은 이 와이어에 실리지 않는다.
      expect(call!.body.input.some((item: { type: string }) => item.type === "reasoning")).toBe(false);
      expect(JSON.stringify(call!.body)).not.toContain("xai-blob");

      expect(first.body).toContain('"name":"Read"');
      expect(first.body).toContain('"partial_json":"{\\"file_path\\":"');
      // reasoning 텍스트와 blob이 자리표시 서명이 아닌 하나의 thinking 블록으로 닫힌다.
      expect(first.body).toContain("check a.ts");
      expect(first.body).not.toContain('"signature":"gateway_');
      const signature = /"signature":"(fleet-reasoning:v2:muse-code:[^"]+)"/.exec(first.body)?.[1];
      expect(signature).toBeDefined();
      expect(first.body).not.toContain(MUSE_KEY);

      await router.handle(ctx({
        res: second,
        token: ANTHROPIC_CRED,
        model: MUSE_MODEL,
        tools,
        messages: [
          ...firstTurn,
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "check a.ts", signature },
              { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a.ts" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a" }] },
        ],
      }));

      expect(second.status).toBe(200);
      const replayed = calls[1]!.body.input.filter((item: { type: string }) => item.type === "reasoning");
      expect(replayed).toEqual([{ type: "reasoning", id: REASONING_ID, summary: [], encrypted_content: "muse-blob-new" }]);
      expect(JSON.stringify(calls[1]!.body.input)).not.toContain("reasoning_origin");
    } finally {
      router.dispose();
    }
  });

  it("refuses before spending a request when the sign-in or a forced tool choice cannot be honored", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { message: `bad key ${MUSE_KEY}`, type: "invalid_api_key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));

    const signedOut = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: () => ({ status: "signed_out" }) });
    const signedOutRes = response();
    await signedOut.handle(ctx({ res: signedOutRes, token: ANTHROPIC_CRED, model: MUSE_MODEL }));
    expect(signedOutRes.status).toBe(401);
    expect(signedOutRes.body).toContain("muse login");

    const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: signedIn });
    const forcedRes = response();
    await router.handle(ctx({
      res: forcedRes, token: ANTHROPIC_CRED, model: MUSE_MODEL,
      tools: SEARCH_CATALOG, toolChoice: { type: "tool", name: "Read" },
    }));
    expect(forcedRes.status).toBe(400);
    expect(forcedRes.body).toContain("automatic tool choice");
    expect(fetchMock).not.toHaveBeenCalled();

    const refusedRes = response();
    await router.handle(ctx({ res: refusedRes, token: ANTHROPIC_CRED, model: MUSE_MODEL }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refusedRes.status).toBe(401);
    expect(refusedRes.body).toContain("muse login");
    expect(refusedRes.body).not.toContain(MUSE_KEY);
    signedOut.dispose();
    router.dispose();
  });
});

describe("request body limit", () => {
  it("refuses a body past the limit with a 413 that does not arm reactive compaction", async () => {
    // "context window"가 들어간 413만 Claude Code의 압축을 무장시킨다(canonical/index.ts).
    // 큰 본문이 곧 창 초과는 아니므로 그 문구를 빌려 쓰지 않는다.
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(oversizedCtx(res, MAX_GATEWAY_REQUEST_BODY_BYTES));

    expect(res.status).toBe(413);
    expect(res.body).not.toContain("context window");
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

function oversizedCtx(res: ResponseStub, limit: number): GatewayHttpHandlerContext {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${ANTHROPIC_CRED}` },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      for (let sent = 0; sent <= limit; sent += chunk.length) yield chunk;
    },
  };
  return { req, res, pathname: MESSAGES } as unknown as GatewayHttpHandlerContext;
}

describe("route surface", () => {

  it("rejects an unknown id reserved for the gateway instead of leaking it to Anthropic", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--does-not-exist",
    }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a content block the wire cannot translate as the client's 400, not a retryable fault", async () => {
    // Claude Code only abandons a rejected block shape on a 400 naming it; any other status
    // makes it resend the same body until its retry budget runs out.
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      messages: [{ role: "user", content: [{ type: "tool_removal_v9", tool: { name: "Read" } }] }],
    }));

    expect(res.status).toBe(400);
    expect(res.body).toContain("Unsupported Anthropic content block type: tool_removal_v9");
    expect(streamSpy).toHaveBeenCalledTimes(1);
  });
});

function createAiGatewayRouter(
  deps: Partial<AiGatewayRouteDeps> = {},
) {
  // readAuth는 프로덕션에서 필수 주입이다. 테스트 래퍼는 자격증명 부재 스텁을
  // 기본값으로 두고, 각 테스트가 필요한 조달자만 덮어쓴다.
  return createCoreAiGatewayRouter({
    originator: "fleet-console",
    readAuth: () => null,
    ...deps,
  });
}

function readAuth() {
  return { accessToken: SUBSCRIPTION_TOKEN, accountId: ACCOUNT_ID };
}

function stubGateway(onRequest?: (request: CanonicalResponseRequest) => void): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(request): Promise<AdapterResponse> {
      onRequest?.(request);
      return successfulAdapterResponse();
    },
  };
  return new AnthropicMessagesGateway(adapter);
}

function successfulAdapterResponse(): AdapterResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    events: (async function* () {
      yield {
        type: "response.created",
        response: { id: "resp_stub", model: "gpt-5.5", usage: null },
      } as const;
      yield {
        type: "response.completed",
        response: {
          id: "resp_stub",
          model: "gpt-5.5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as const;
    })(),
  };
}

interface ResponseStub {
  status: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array | string): boolean;
  end(body?: string): void;
  once(event: string, listener: () => void): void;
  off?(event: string, listener: () => void): void;
}

function response(): ResponseStub {
  const decoder = new TextDecoder();
  return {
    status: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      return true;
    },
    end(body) {
      if (body !== undefined) this.body += body;
    },
    once() {
      /* backpressure is never exercised by the stub writer */
    },
    off() {},
  };
}

function ctx(options: {
  readonly res: ResponseStub;
  readonly token?: string;
  readonly pathname?: string;
  readonly method?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly thinking?: Record<string, unknown>;
  readonly outputConfig?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | null;
  readonly messages?: ReadonlyArray<Record<string, unknown>>;
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly toolChoice?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: unknown;
}): GatewayHttpHandlerContext {
  const payload = JSON.stringify(options.rawBody ?? {
    model: options.model ?? "claude-gateway--codex--gpt-6-sol",
    messages: options.messages ?? [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.outputConfig ? { output_config: options.outputConfig } : {}),
    ...(options.metadata === null
      ? {}
      : { metadata: options.metadata ?? { user_id: "claude-session-test" } }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    stream: true,
  });
  const req = {
    method: options.method ?? "POST",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.apiKey === undefined ? {} : { "x-api-key": options.apiKey }),
      ...options.headers,
    },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
  return {
    req,
    res: options.res,
    pathname: options.pathname ?? MESSAGES,
  } as unknown as GatewayHttpHandlerContext;
}
