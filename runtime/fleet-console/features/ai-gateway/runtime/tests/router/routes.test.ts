import { decideGatewayRoutingBatch, NoEnabledGatewayModelsError } from "../../src/fleet/routing-batch.js";
import { routingBatchInstructions, routingDifficulty } from "../../src/fleet/routing-decision.js";
import { GatewayRoutingDistribution } from "../../src/fleet/routing-distribution.js";
import {
  AnthropicMessagesGateway,
  createClaudeCodexCompactionStore,
  createProviderAuthService,
  createMuseCodeOAuth,
  MUSE_CODE_AUTH_PROVIDER_ID,
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
import type { GatewayFailureRecord, GatewayRequestTimingRecord } from "../../src/index.js";
import type { GatewayHttpHandlerContext } from "../../src/router/types.js";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_GATEWAY_REQUEST_BODY_BYTES,
  MUSE_CODE_RESPONSES_URL,
  encodeReasoningSignature,
  XAI_CLI_RESPONSES_URL,
  XAI_RESPONSES_URL,
  buildAnthropicModelList,
  createAiGatewayRouter as createCoreAiGatewayRouter,
  decideGatewayRoutingAssignment,
  evaluateGatewayCandidateModels,
  errorMessage,
  applyClaudeNativeModels,
  findGatewayModel,
  GATEWAY_MODELS,
  parseClaudeUsage,
  parseGatewayAssignmentRequest,
  resolveAiGatewaySelection,
  FLEET_MODEL_SPEED_HEADER,
} from "../../src/index.js";
import {
  pickSeat,
} from "../../src/fleet/routing-fallback.js";
import { buildGatewayCandidates, buildGatewayEnabledModels, buildGatewayLoadout } from "../../src/fleet/model-loadout.js";
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

  it("recovers input overflow before commit and preserves streaming after output starts", async () => {
    const overflow = { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." };
    const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
    const created = { type: "response.created", response: { id: "r", model: "gpt-6.1-sol", usage: null } };
    const failed = { type: "response.failed", response: { error: overflow } };
    const text = { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "recovered" };
    const completed = { type: "response.completed", response: { id: "r", model: "gpt-6.1-sol", usage: { input_tokens: 1, output_tokens: 1 } } };
    let mode: "http" | "early" | "summary" | "late" | "success" | "quiet" = "http";
    let finish: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      if (mode === "http" || mode === "summary") {
        const native = payload.input.some((item: { type: string }) => item.type === "compaction_trigger");
        return new Response(JSON.stringify({ error: native ? { type: "invalid_request_error", message: "Unsupported compaction trigger" } : overflow }), { status: 400 });
      }
      if (mode === "quiet") {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(frame(created)));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(frame(text) + frame(completed)));
            controller.close();
          }, 15_000);
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      if (mode === "success") {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(frame(created) + frame(text)));
          finish = () => { controller.enqueue(new TextEncoder().encode(frame(completed))); controller.close(); };
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(frame(created) + (mode === "late" ? frame(text) : "") + frame(failed), { headers: { "content-type": "text/event-stream" } });
    });
    const router = createAiGatewayRouter({
      readAuth, fetch: fetchMock,
      compactionStore: {
        path: "unused", recordPreCompact() {}, recordPostCompact() {}, clearPending() {}, writeReady() {}, clear() {},
        readReady: () => undefined,
        readPending: () => ({ trigger: "auto", customInstructions: "", updatedAt: Date.now() }),
      },
    });
    const run = async (messages?: ReadonlyArray<Record<string, unknown>>) => {
      const res = response();
      await router.handle(ctx({ res, token: ANTHROPIC_CRED, messages }));
      return res;
    };
    const expectOverflow = (res: ResponseStub) => {
      expect(res.status).toBe(413);
      const error = JSON.parse(res.body).error;
      expect(error.type).toBe("invalid_request_error");
      expect(error.message).toMatch(/^Prompt is too long:.*context window/);
    };
    try {
      const guarded = await run([{ role: "user", content: "x".repeat(2_400_000) }]);
      expectOverflow(guarded);
      const numericOverflow = /^Prompt is too long: (\d+) tokens > (\d+) maximum context window$/.exec(JSON.parse(guarded.body).error.message);
      expect(Number(numericOverflow?.[1])).toBeGreaterThan(500_000);
      expect(Number(numericOverflow?.[2])).toBe(500_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expectOverflow(await run());
      mode = "early";
      expectOverflow(await run());
      mode = "summary";
      const summary = response();
      await router.handle(ctx({ res: summary, token: ANTHROPIC_CRED,
        metadata: { user_id: JSON.stringify({ session_id: "4d7c1b52-3f7e-4f0a-9d55-2b8f6a1c0e91" }) },
        messages: [{ role: "user", content: `${CLAUDE_COMPACT_PROMPT_MARKER} Summarize.` }],
      }));
      expectOverflow(summary);
      mode = "late";
      const late = await run();
      expect(late.status).toBe(200);
      expect(late.body).toContain("recovered");
      expect(late.body).toContain("event: error");
      expect(late.body).toContain("Prompt is too long");
      mode = "success";
      const live = response();
      let firstOutput!: () => void;
      const first = new Promise<void>((resolve) => { firstOutput = resolve; });
      const write = live.write.bind(live);
      live.write = (chunk) => { const result = write(chunk); if (live.body.includes("recovered")) firstOutput(); return result; };
      const pending = router.handle(ctx({ res: live, token: ANTHROPIC_CRED }));
      await first;
      expect(live.status).toBe(200);
      expect(live.body).not.toContain("message_stop");
      finish!();
      await pending;
      expect(live.body).toContain("message_stop");

      // Codex may buffer response.created until actual output; silence must still get heartbeats.
      vi.useFakeTimers();
      mode = "quiet";
      const quiet = response();
      const delayed = router.handle(ctx({ res: quiet, token: ANTHROPIC_CRED }));
      await vi.advanceTimersByTimeAsync(999);
      expect(quiet.headersSent).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(quiet.status).toBe(200);
      expect(quiet.body).toContain(": keep-alive\n\n");
      expect(quiet.body).not.toContain("recovered");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(quiet.body.match(/: keep-alive/g)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4_000);
      await delayed;
      expect(quiet.body).toContain("recovered");
      expect(quiet.body).toContain("message_stop");
    } finally {
      vi.useRealTimers();
      router.dispose();
    }
  });

  // 압축 다음 턴은 체크포인트를 앞에 실은 채 업스트림에 닿아야 한다. 한때 입력 토큰 추정이
  // 그 항목을 도구 결과로 읽어 TypeError를 냈고, 압축 뒤 모든 턴이 500으로 끝났다.
  it("continues the turn after a compaction with the checkpoint replayed upstream", async () => {
    const sse = (events: unknown[]) => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const completed = (id: string) => ({
      type: "response.completed",
      response: { id, model: "gpt-6.1-sol", usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const bodies: Array<Record<string, any>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return sse([
          { type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "opaque-checkpoint" } },
          completed("compact"),
        ]);
      }
      return sse([
        { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: bodies.length === 2 ? "summary" : "RECALLED" },
        completed(`turn-${bodies.length}`),
      ]);
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compaction-"));
    const compactionStore = createClaudeCodexCompactionStore({ directory });
    const router = createAiGatewayRouter({ readAuth, fetch: fetchMock, compactionStore });
    const sessionId = "4d7c1b52-3f7e-4f0a-9d55-2b8f6a1c0e91";
    const metadata = { user_id: JSON.stringify({ session_id: sessionId }) };
    // 압축 사건은 이제 인프로세스 콜백이 저장소에 직접 기록한다 — 퇴역한 HTTP 경로를 거치지 않는다.
    const hook = async (event: Record<string, unknown>) => {
      if (event.hook_event_name === "PreCompact") {
        compactionStore.recordPreCompact({
          sessionId,
          trigger: event.trigger === "manual" ? "manual" : "auto",
          customInstructions: typeof event.custom_instructions === "string" ? event.custom_instructions : "",
        });
      } else {
        compactionStore.recordPostCompact({
          sessionId,
          summary: typeof event.compact_summary === "string" ? event.compact_summary : "",
        });
      }
    };
    try {
      await hook({ hook_event_name: "PreCompact" });
      const compact = response();
      await router.handle(ctx({
        res: compact,
        token: ANTHROPIC_CRED,
        metadata,
        messages: [
          { role: "user", content: "Remember CANARY-1" },
          { role: "assistant", content: "STORED" },
          { role: "user", content: `${CLAUDE_COMPACT_PROMPT_MARKER} Summarize.` },
        ],
      }));
      expect(compact.status).toBe(200);
      await hook({ hook_event_name: "PostCompact", compact_summary: "summary" });

      const next = response();
      await router.handle(ctx({
        res: next,
        token: ANTHROPIC_CRED,
        metadata,
        messages: [
          { role: "user", content: `${CLAUDE_COMPACT_CONTINUATION_MARKER} summary` },
          { role: "user", content: "Reply RECALL" },
        ],
      }));
      expect(next.status).toBe(200);
      expect(next.body).toContain("RECALLED");
      expect(bodies).toHaveLength(3);
      expect(bodies[2]!.input[0]).toEqual({ type: "compaction", encrypted_content: "opaque-checkpoint" });
    } finally {
      router.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 위임 배정. 호출 전 판정이 남긴 사실을 Console의 코드 규칙이 모델과 강도로 바꾸는 경계다.
 *
 * 여기서 고정하는 것은 판정 규칙 자체다 — 노출·쿼터·공급자 부하·모델 범위 제한이 후보를
 * 어떻게 가르는지, 그리고 Fleet 자신의 실행 정체성을 호스트가 이름으로 불렀다고 해서
 * 배정이 꺼지지 않는지. 퇴역한 mod HTTP 경로는 부르지 않고 판정 함수를 직접 부른다.
 */
describe("delegation assignment", () => {
  const exposure = {
    delegationModels: [requireGatewayModel("codex--gpt-6.1-terra")],
  };
  // 퇴역한 HTTP 배정 경로 대신 공개 판정 경계를 직접 부른다. 판정 규칙은 그대로다.
  const assign = async (body: Record<string, unknown>) => {
    const decision = decideGatewayRoutingAssignment(parseGatewayAssignmentRequest(body), exposure);
    return { status: 200, body: JSON.stringify(decision) };
  };

  it("assigns subagents and workflow stages by the code rule without an AI routing-model call", async () => {
    const now = Date.now();
    const hour = 3_600_000;
    const exposure: GatewayAssignmentExposure = {
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-4.7"),
        requireGatewayModel("opencode--deepseek-v4.1-flash"),
        requireGatewayModel("muse-code--muse-spark-1.3-contributor"),
      ],
      quota: {
        // critical: 제외되어야 함
        codex: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 96, resetsAt: now + hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // elevated: 84% 사용, 경과 70%(남은 기간 30%) → paceRatio 1.2 < 1.5, sustainableHeadroom = 0.16 / 0.3 = 0.533333
        xai: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 84, resetsAt: now + 1.5 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // ok: 20% 사용, 경과 50%(남은 기간 50%) → paceRatio 0.4, sustainableHeadroom 1.6
        opencode: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 20, resetsAt: now + 2.5 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // muse-code: 쿼터 미상(unknown) → elevated 뒤 끝에 놓여야 함
      },
    };

    const evaluated = evaluateGatewayCandidateModels(exposure, now);
    expect(evaluated.map((entry) => [entry.model.provider, entry.allowance.pressure])).toEqual([
      ["opencode", "ok"],
      ["xai", "elevated"],
      ["muse-code", "unknown"],
    ]);

    const agentDecision = decideGatewayRoutingAssignment(
      { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine" },
      exposure,
    );
    expect(agentDecision.model).toBe("claude-gateway--opencode--deepseek-v4.1-flash[1m]");
    expect(agentDecision.effort).toBe("high");
    expect(agentDecision.because).not.toContain("fallback");

    const stageDecision = decideGatewayRoutingAssignment(
      { surface: "stage" },
      exposure,
    );
    expect(stageDecision.model).toBe("claude-gateway--opencode--deepseek-v4.1-flash[1m]");
  });

  it("orders candidates within the same pressure class by sustainableHeadroom first and falls back to remainingPercent only when headroom is absent", () => {
    const now = Date.now();
    const hour = 3_600_000;
    const day = 24 * hour;
    const evaluated = evaluateGatewayCandidateModels({
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-4.7"),
        requireGatewayModel("opencode--deepseek-v4.1-flash"),
        requireGatewayModel("muse-code--muse-spark-1.3-contributor"),
        requireGatewayModel("claude--sonnet-1m"),
      ],
      quota: {
        // codex(주간): used 35%(remaining 65%), 남은 기간 3.5/7일(elapsed 0.5, paceRatio 0.7 → ok) → sustainableHeadroom = 0.65 / 0.5 = 1.3
        codex: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "weekly", usedPercent: 35, resetsAt: now + 3.5 * day, period: { durationMs: 7 * day, durationBasis: "upstream" } }],
        },
        // xai(5시간): used 40%(remaining 60% < 65%), 남은 기간 1/5시간(elapsed 0.8, paceRatio 0.5 → ok) → sustainableHeadroom = 0.60 / 0.2 = 3.0
        // remainingPercent는 codex(65%)가 크지만 sustainableHeadroom은 xai(3.0 > 1.3)가 크므로 xai가 앞서야 한다.
        xai: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 40, resetsAt: now + 1 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // opencode(elevated): used 88%(remaining 12%), 경과 80%(남은 기간 20%, paceRatio 1.1 → elevated) → sustainableHeadroom = 0.12 / 0.2 = 0.6
        opencode: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 88, resetsAt: now + 1 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // muse-code(elevated): used 85%(remaining 15%), 경과 90%(남은 기간 10%, paceRatio 0.94, used>=80 → elevated) → sustainableHeadroom = 0.15 / 0.1 = 1.5
        "muse-code": {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 85, resetsAt: now + 0.5 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // claude: 미상(unknown)
      },
    }, now);

    expect(evaluated.map((entry) => entry.model.provider)).toEqual([
      "xai",
      "codex",
      "muse-code",
      "opencode",
      "claude",
    ]);

    // 양쪽 sustainableHeadroom이 같으면 remainingPercent가 달라도 0(원래 순서 유지)이고,
    // 한쪽만 sustainableHeadroom이 있으면 있는 쪽이 앞서며,
    // 양쪽 모두 sustainableHeadroom이 없을 때만 remainingPercent로 비교한다.
    const tiedAndClockless = evaluateGatewayCandidateModels({
      delegationModels: [
        requireGatewayModel("opencode--deepseek-v4.1-flash"),
        requireGatewayModel("muse-code--muse-spark-1.3-contributor"),
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-4.7"),
      ],
      quota: {
        // opencode: 시계 없는 창(sustainableHeadroom 없음), used 40%(remaining 60%)
        opencode: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "cycle", usedPercent: 40 }],
        },
        // muse-code: 시계 없는 창(sustainableHeadroom 없음), used 10%(remaining 90% > 60%) → 양쪽 모두 headroom이 없으므로 opencode보다 앞
        "muse-code": {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "cycle", usedPercent: 10 }],
        },
        // codex: used 50%(remaining 50%), 남은 기간 2.5/5시간 → sustainableHeadroom = 1.0 (headroom이 있으므로 시계 없는 창들보다 앞)
        codex: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 50, resetsAt: now + 2.5 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
        // xai: used 20%(remaining 80% > 50%), 남은 기간 4/5시간 → sustainableHeadroom = 1.0 (codex와 동률이므로 codex 뒤 유지)
        xai: {
          status: "ok",
          fetchedAt: now,
          windows: [{ id: "session", usedPercent: 20, resetsAt: now + 4 * hour, period: { durationMs: 5 * hour, durationBasis: "upstream" } }],
        },
      },
    }, now);
    expect(tiedAndClockless.map((entry) => entry.model.provider)).toEqual([
      "codex",
      "xai",
      "muse-code",
      "opencode",
    ]);
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
      model: "claude-gateway--codex--gpt-6.1-terra[1m]",
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

    expect(JSON.parse(res.body)).toMatchObject({ model: "claude-gateway--codex--gpt-6.1-terra[1m]" });
  });

  it("spreads a fan across providers instead of piling onto one, and steps over a spent allowance", async () => {
    // 고정 목록의 머리만 집으면 같은 등급의 팬아웃이 전원 한 모델로 간다. 공급자별 부하를
    // 세는 것이 그 몰림을 막는 유일한 상태이므로, 그 상태가 실제로 돌아가는지 본다.
    const now = Date.now();
    const providerLoad = new Map<string, number>();
    const spread = {
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      // xai는 소진 직전이다. critical은 후보에서 제외된다.
      quota: {
        codex: { status: "ok", fetchedAt: now, windows: [{ id: "cycle", usedPercent: 4, resetsAt: now + 1_296_000_000, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: now - 1_296_000_000 } }] },
        xai: { status: "ok", fetchedAt: now, windows: [{ id: "cycle", usedPercent: 99, resetsAt: now + 1_296_000_000, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: now - 1_296_000_000 } }] },
      },
      providerLoad,
    } satisfies GatewayAssignmentExposure;

    const carried = [0, 1, 2, 3].map(() => decideGatewayRoutingAssignment(
      { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine" },
      spread,
    ).model);

    expect(carried.every((model) => model === "claude-gateway--codex--gpt-6.1-terra[1m]")).toBe(true);
    expect(providerLoad.get("codex")).toBe(4);
    expect(providerLoad.get("xai")).toBeUndefined();
  });

  it("alternates between providers whose allowances read the same", async () => {
    const now = Date.now();
    const providerLoad = new Map<string, number>();
    const even = {
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      quota: {
        codex: { status: "ok", fetchedAt: now, windows: [{ id: "cycle", usedPercent: 4, resetsAt: now + 1_296_000_000, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: now - 1_296_000_000 } }] },
        xai: { status: "ok", fetchedAt: now, windows: [{ id: "cycle", usedPercent: 4, resetsAt: now + 1_296_000_000, period: { durationMs: 2_592_000_000, durationBasis: "catalog", startsAt: now - 1_296_000_000 } }] },
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
      delegationModels: [requireGatewayModel("codex--gpt-6.1-terra")],
    } satisfies GatewayAssignmentExposure;

    const decision = decideGatewayRoutingAssignment(
      { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine", requestedModel: reserved },
      hostOnly,
    );

    expect(decision.model).not.toBe(reserved);
    expect(decision.model).toBe("claude-gateway--codex--gpt-6.1-terra[1m]");
    // hostOnly는 위임 후보를 더 이상 갈라내지 않는다. 구 200k 좌표는 가족의 1M 항목으로 접힌다.
    // 표식이 있던 항목을 켠 목록에서 빼는 것은 저장 이행(4판)이 한다.
    const claude = resolveAiGatewaySelection({ version: 1, models: [{ id: "claude--opus-1m", hostOnly: true }, { id: "claude--sonnet" }] } as unknown as Parameters<typeof resolveAiGatewaySelection>[0]);
    expect(claude.models.map((model) => model.id)).toEqual(["claude--opus-1m", "claude--sonnet-1m"]);
    expect(claude.delegationModels.map((model) => model.id)).toEqual(claude.models.map((model) => model.id));
    expect(buildGatewayCandidates({ delegationModels: claude.delegationModels }).candidates).toEqual([
      expect.objectContaining({ model: "opus[1m]", pressure: "unknown", summary: expect.any(String) }),
      expect.objectContaining({ model: "sonnet[1m]", pressure: "unknown", summary: expect.any(String) }),
    ]);
  });

  it("drops a not-connected Codex model from delegation and keeps a consent-off Claude model", () => {
    const models = [requireGatewayModel("claude--sonnet-1m"), requireGatewayModel("codex--gpt-6.1-sol")];
    const hidden = {
      delegationModels: models,
      quota: { claude: { status: "not_connected" }, codex: { status: "not_connected" } },
    } satisfies GatewayAssignmentExposure;
    expect(buildGatewayCandidates(hidden).candidates.map((candidate) => candidate.model)).toEqual(["sonnet[1m]"]);
    expect(decideGatewayRoutingAssignment(
      { surface: "agent", subagentType: "general-purpose", providerPlugin: "engine" },
      hidden,
    ).model).toBe("sonnet[1m]");
    expect(buildGatewayCandidates({ delegationModels: models }).candidates.map((candidate) => candidate.model)).toEqual([
      "sonnet[1m]",
      "codex--gpt-6.1-sol",
    ]);
  });

  it("proxies native Claude requests to Anthropic with caller credentials and without alias advertisement", async () => {
    // Claude Code 2.1.284가 실제로 보고한 표 모양이다. Opus는 1M 좌표로만 오고 구버전 명시 id도 섞인다.
    // alias는 그중 최신으로만 풀리고, API로 가는 id에는 1M 표식이 남지 않아야 한다.
    const ladder = ["low", "medium", "high", "xhigh", "max"];
    const ensureClaudeNativeModels = vi.fn(async () => {
      applyClaudeNativeModels([
        { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)", effortLevels: ladder },
        { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)", effortLevels: ladder },
        { value: "claude-opus-5[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus 5", effortLevels: ladder },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", effortLevels: ladder },
        { value: "sonnet[1m]", resolvedModel: "claude-sonnet-5-5[1m]", displayName: "Sonnet 5.5 (1M context)", effortLevels: ladder },
      ]);
    });
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ANTHROPIC_CRED}`);
      expect(JSON.parse(String(init?.body)).model).toBe("claude-sonnet-5-5");
      // bare alias는 하위 호환 입력이다 — 가족의 단일 1M 항목으로 풀려 1M beta를 싣는다.
      expect(headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
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
      { delegationModels: [requireGatewayModel("claude--opus-1m")] },
    );
    expect(decision.model).toBe("opus[1m]");
    const nativeRouter = createAiGatewayRouter({ resolveExecutionModel: async () => ({ modelId: "claude-opus-5-5" }), fetch: vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).model).toBe("claude-opus-5-5");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ANTHROPIC_CRED}`);
      expect(headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
      return new Response("{}", { status: 200 });
    }) });
    const delegated = response();
    await nativeRouter.handle(ctx({ res: delegated, token: ANTHROPIC_CRED, model: decision.model!, messages: [{ role: "user", content: "hello" }] }));
    expect(delegated.status).toBe(200);
    // 후보가 없으면 지휘관의 버전 고정 native 모델을 상속한다. 가상 id가 upstream으로 새면 안 된다.
    const inherited = response();
    await nativeRouter.handle(ctx({ res: inherited, token: ANTHROPIC_CRED,
      model: "claude-gateway--fleet--execute",
      headers: { "x-claude-code-session-id": "parent", "x-claude-code-agent-id": "child", "anthropic-beta": "context-1m-2025-08-07" },
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(inherited.status).toBe(200);

    // Verify /v1/models excludes native Claude aliases (no duplicate advertisement)
    const discovery = buildAnthropicModelList(GATEWAY_MODELS);
    const discoveredIds = discovery.data.map((entry) => entry.id);
    expect(discoveredIds.some((id) => id.startsWith("claude-gateway--claude--") || id === "sonnet" || id === "opus[1m]")).toBe(false);
  });

  it("routes delegation to Claude native models without gateway prefix", () => {
    const sonnet = requireGatewayModel("claude--sonnet-1m");
    const exposure = {
      delegationModels: [sonnet],
      quota: { claude: { status: "ok" } },
    } satisfies GatewayAssignmentExposure;

    const loadout = buildGatewayCandidates(exposure);
    expect(loadout.candidates.map((candidate) => candidate.model)).toEqual(["sonnet[1m]"]);

    const decision = decideGatewayRoutingAssignment(
      { surface: "agent", requestedModel: "sonnet" },
      exposure,
    );
    expect(decision.model).toBe("sonnet[1m]");
    expect(decision.effort).toBe("medium");
  });

  it("leaves a fork on the session model", async () => {
    const res = await assign({ surface: "agent", fork: true, subagentType: "general-purpose" });

    const decision = JSON.parse(res.body) as Record<string, unknown>;
    expect(decision).not.toHaveProperty("model");
    expect(decision.label).toBe("session model");
  });

  it("shapes candidates with canonical ids, allowed efforts, summary, and pressure only", () => {
    const now = Date.now();
    const hour = 3_600_000;
    const window = (id: string, usedPercent: number, durationHours: number, remainingHours: number) => ({
      id, usedPercent, resetsAt: now + remainingHours * hour,
      period: { durationMs: durationHours * hour, durationBasis: "upstream" },
    });
    // session: 60% used, 80% elapsed (paceRatio 0.75, remaining 40%, headroom 2.0)
    // week: 70% used, 60% elapsed (remainingHours = 67.2, paceRatio 1.17 -> elevated, remaining 30%, headroom 0.75)
    const windows = [window("session", 60, 5, 1), window("week", 70, 168, 67.2)];
    const run = (quota: GatewayAssignmentExposure["quota"]) => buildGatewayCandidates({
      quota,
      effortExposure: { "codex--gpt-6.1-terra": ["low", "medium", "high"] },
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
        requireGatewayModel("claude--opus-1m"),
      ],
    }, now);
    const quota = { status: "ok", fetchedAt: now, windows };
    const data = run({
      codex: quota,
      // claude는 critical → 응답에서 제외되어야 함
      claude: { status: "ok", fetchedAt: now, windows: [window("session", 96, 5, 1)] },
    });

    expect(Object.keys(data)).toEqual(["candidates"]);
    expect(data.candidates.map((candidate) => candidate.model)).toEqual([
      "codex--gpt-6.1-terra",
      "xai--grok-composer-2.5-fast",
    ]);
    expect(data.candidates[0]).toEqual({
      model: "codex--gpt-6.1-terra",
      fast: false,
      efforts: ["low", "medium", "high"],
      pressure: "elevated",
      summary: "Balanced coding and implementation model.",
    });
    expect(data.candidates[1]).toEqual({
      model: "xai--grok-composer-2.5-fast",
      fast: true,
      efforts: [],
      pressure: "unknown",
      summary: "Code editing and implementation model.",
    });

    // 리셋이 지난 창이나 미래 시각 관측은 ok로 오인하지 않고 unknown으로 처리한다.
    const expired = run({ codex: { ...quota, windows: [window("expired", 50, 5, -0.01)] } }).candidates.find(
      (candidate) => candidate.model === "codex--gpt-6.1-terra",
    )!;
    expect(expired.pressure).toBe("unknown");
    // 만료된 창이 있어도 다른 유효한 창이 critical 이면 unknown 으로 되살아나지 않고 제외된다.
    expect(run({ codex: { ...quota, windows: [window("session", 40, 5, -1 / 60), window("week", 100, 168, 72)] } }).candidates.map((candidate) => candidate.model)).not.toContain("codex--gpt-6.1-terra");

    const future = run({ codex: { ...quota, fetchedAt: now + hour } }).candidates.find(
      (candidate) => candidate.model === "codex--gpt-6.1-terra",
    )!;
    expect(future.pressure).toBe("unknown");
  });

  it("excludes critical providers without falling back to critical or hidden providers when empty", () => {
    const reachable = [
      {
        model: "claude-gateway--codex--gpt-6.1-terra",
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
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
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

    // critical인 codex는 제외되고 xai가 선택된다.
    const seat = pickSeat(reachable, exposure);
    expect(seat?.model.provider).toBe("xai");

    // 전부 critical이면 critical로 폴백하지 않고 배정하지 않는다.
    const allCriticalExposure: GatewayAssignmentExposure = {
      ...exposure,
      quota: { ...exposure.quota, xai: { status: "ok", windows: [{ id: "monthly", usedPercent: 100 }] } },
    };
    expect(pickSeat(reachable, allCriticalExposure)).toBeUndefined();
    const unassignedCritical = decideGatewayRoutingAssignment({ surface: "agent" }, allCriticalExposure);
    expect(unassignedCritical.model).toBeUndefined();
    expect(unassignedCritical.because).toContain("critical");

    // 전부 숨긴 공급자(not_connected / signed_out)여도 숨긴 공급자로 폴백하지 않는다.
    const allHiddenExposure: GatewayAssignmentExposure = {
      delegationModels: [
        requireGatewayModel("codex--gpt-6.1-terra"),
        requireGatewayModel("xai--grok-composer-2.5-fast"),
      ],
      quota: {
        codex: { status: "not_connected" },
        xai: { status: "signed_out" },
      },
    };
    expect(evaluateGatewayCandidateModels(allHiddenExposure)).toEqual([]);
    const unassignedHidden = decideGatewayRoutingAssignment({ surface: "agent" }, allHiddenExposure);
    expect(unassignedHidden.model).toBeUndefined();
  });

  it("scopes Fable-only weekly limits to Fable so Sonnet, Haiku, and Opus remain candidates", () => {
    const now = Date.parse("2026-11-15T04:00:00Z");
    // 7일 창 중 약 71% 경과(2일 남음) 상태에서 주간 66%는 paceRatio ~0.92(ok), Fable 95%는 critical이다.
    const weekReset = new Date(now + 2 * 24 * 3_600_000).toISOString();
    const claudeModels = [
      requireGatewayModel("claude--haiku-1m"),
      requireGatewayModel("claude--sonnet-1m"),
      requireGatewayModel("claude--opus-1m"),
      requireGatewayModel("claude--fable-1m"),
    ];

    // 실제 Anthropic /api/oauth/usage 응답 형태: 공통 주간 한도는 66%, Fable 전용 weekly_scoped 한도만 95%(critical).
    const scopedUsage = parseClaudeUsage({
      five_hour: { used_percentage: 20, resets_at: new Date(now + 3 * 3_600_000).toISOString() },
      seven_day: { used_percentage: 66, resets_at: weekReset },
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Fable" } },
          used_percentage: 95,
          resets_at: weekReset,
        },
      ],
    });
    const scopedExposure: GatewayAssignmentExposure = {
      delegationModels: claudeModels,
      quota: {
        claude: { status: "ok", fetchedAt: now, windows: scopedUsage.windows },
      },
    };
    const scopedCandidates = buildGatewayCandidates(scopedExposure, now).candidates;
    expect(scopedCandidates.map((candidate) => candidate.model)).toEqual(["haiku[1m]", "sonnet[1m]", "opus[1m]"]);
    expect(scopedCandidates.every((candidate) => candidate.pressure === "ok")).toBe(true);
    expect(buildGatewayLoadout(scopedExposure, now).quotaPools["claude:shared"]?.remainingPercent).toBe(34);

    // 대체 경로(fable_weekly / seven_day_fable)로 Fable 한도가 와도 Fable만 제외된다.
    const aliasUsage = parseClaudeUsage({
      seven_day: { used_percentage: 66, resets_at: weekReset },
      seven_day_fable: { used_percentage: 95, resets_at: weekReset },
    });
    const aliasCandidates = buildGatewayCandidates({
      delegationModels: claudeModels,
      quota: { claude: { status: "ok", fetchedAt: now, windows: aliasUsage.windows } },
    }, now).candidates;
    expect(aliasCandidates.map((candidate) => candidate.model)).toEqual(["haiku[1m]", "sonnet[1m]", "opus[1m]"]);

    // Fable 전용 창이 없는 응답에서는 공통 한도로만 판정한다(여유가 있으면 Fable도 남고, 공통 한도가 critical이면 모두 빠진다).
    const sharedHealthy = parseClaudeUsage({
      five_hour: { used_percentage: 20, resets_at: new Date(now + 3 * 3_600_000).toISOString() },
      seven_day: { used_percentage: 66, resets_at: weekReset },
    });
    expect(buildGatewayCandidates({
      delegationModels: claudeModels,
      quota: { claude: { status: "ok", fetchedAt: now, windows: sharedHealthy.windows } },
    }, now).candidates.map((candidate) => [candidate.model, candidate.pressure])).toEqual([
      ["haiku[1m]", "ok"],
      ["sonnet[1m]", "ok"],
      ["opus[1m]", "ok"],
      ["fable[1m]", "ok"],
    ]);

    const sharedCritical = parseClaudeUsage({
      five_hour: { used_percentage: 98, resets_at: new Date(now + 3 * 3_600_000).toISOString() },
      seven_day: { used_percentage: 66, resets_at: weekReset },
    });
    expect(buildGatewayCandidates({
      delegationModels: claudeModels,
      quota: { claude: { status: "ok", fetchedAt: now, windows: sharedCritical.windows } },
    }, now).candidates).toEqual([]);
  });

  it("isolates every model-scoped limit (Claude weekly_scoped, future models) while applying common limits to all", () => {
    const now = Date.parse("2026-11-15T04:00:00Z");
    const sessionReset = new Date(now + 3 * 3_600_000).toISOString();
    const weekReset = new Date(now + 5 * 24 * 3_600_000).toISOString();
    const claudeModels = [
      requireGatewayModel("claude--haiku-1m"),
      requireGatewayModel("claude--sonnet-1m"),
      requireGatewayModel("claude--opus-1m"),
      requireGatewayModel("claude--fable-1m"),
    ];

    // 1) Claude의 다른 모델(Opus 5.5) weekly_scoped가 98%여도 Opus만 빠지고 Haiku·Sonnet·Fable은 남는다.
    const opusScoped = parseClaudeUsage({
      five_hour: { used_percentage: 20, resets_at: sessionReset },
      seven_day: { used_percentage: 30, resets_at: weekReset },
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Opus 5.5" } },
          used_percentage: 98,
          resets_at: weekReset,
        },
      ],
    });
    const opusExposure: GatewayAssignmentExposure = {
      delegationModels: claudeModels,
      quota: { claude: { status: "ok", fetchedAt: now, windows: opusScoped.windows } },
    };
    expect(buildGatewayCandidates(opusExposure, now).candidates.map((candidate) => candidate.model)).toEqual([
      "haiku[1m]",
      "sonnet[1m]",
      "fable[1m]",
    ]);
    const opusLoadout = buildGatewayLoadout(opusExposure, now);
    expect(opusLoadout.quotaPools["claude:shared"]?.remainingPercent).toBe(70);

    // 2) 카탈로그에 없는 미래 모델의 weekly_scoped 창(예: Cedar 99%)도 scope가 붙어 기존 모델에 번지지 않는다.
    const futureModelScoped = parseClaudeUsage({
      five_hour: { used_percentage: 20, resets_at: sessionReset },
      seven_day: { used_percentage: 30, resets_at: weekReset },
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Cedar" } },
          used_percentage: 99,
          resets_at: weekReset,
        },
      ],
    });
    expect(buildGatewayCandidates({
      delegationModels: claudeModels,
      quota: { claude: { status: "ok", fetchedAt: now, windows: futureModelScoped.windows } },
    }, now).candidates.map((candidate) => candidate.model)).toEqual([
      "haiku[1m]",
      "sonnet[1m]",
      "opus[1m]",
      "fable[1m]",
    ]);
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
  // 4 chars/token puts this at 150_000 tokens, past the 100_000 one skill may take
  // from a 500_000-token window.
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
      model: "claude-gateway--codex--gpt-6.1-terra",
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
      model: "claude-gateway--codex--gpt-6.1-terra",
      messages: [listingTurn],
    }));

    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).not.toContain("claude-api");
    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).toContain("- agent-browser:");
  });
});

describe("session model speed", () => {
  it("lets a session's explicit speed for its model override the Fast toggle, and keeps one catalog identity", async () => {
    const tiers: Array<string | undefined> = [];
    const send = async (fastToggle: boolean, speed?: string) => {
      const router = createAiGatewayRouter({
        gateway: stubGateway((request) => tiers.push(request.service_tier)),
        readAuth,
        readAiGatewaySettings: aiGatewaySettingsStub({ version: 1, models: [{ id: "codex--gpt-6.1-sol", ...(fastToggle ? { fast: true } : {}) }] }),
      });
      await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model: "claude-gateway--codex--gpt-6.1-sol", ...(speed ? { headers: { [FLEET_MODEL_SPEED_HEADER]: speed } } : {}) }));
    };
    await send(true);
    // 「일반」도 명시값이다 — 토글이 켜져 있어도 일반으로 돈다.
    await send(true, "codex--gpt-6.1-sol=standard");
    await send(false, "codex--gpt-6.1-sol=fast");
    // 다른 모델에 대한 명시는 이 요청에 새지 않는다(위임·압축 요청).
    await send(true, "codex--gpt-6.1-terra=standard");
    expect(tiers).toEqual(["priority", undefined, "priority", "priority"]);

    // Fast는 속도 선택일 뿐 새 모델 항목이 아니다.
    expect(buildAnthropicModelList(GATEWAY_MODELS).data.filter((entry) => entry.id.includes("gpt-6.1-sol"))).toHaveLength(1);
    expect(buildGatewayCandidates({ delegationModels: [requireGatewayModel("codex--gpt-6.1-sol")] }).candidates).toEqual([
      expect.objectContaining({ model: "codex--gpt-6.1-sol", fast: false }),
    ]);
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
      model: "claude-gateway--codex--gpt-6-astra",
      messages: [{ role: "user", content: "read the files" }], tools, stream: true, max_tokens: 128,
    };
    try {
      for (const rawBody of [
        base,
        { ...base, stream: false },
        { ...base, tool_choice: { type: "auto", disable_parallel_tool_use: true } },
        { ...base, model: "claude-gateway--codex--gpt-6.1-sol" },
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

describe("Muse Code routing", () => {
  const MUSE_KEY = "LLM|muse-model-key";
  const MUSE_MODEL = "claude-gateway--muse-code--muse-spark-1.3-contributor";
  const signedIn = () => ({ status: "ok" as const, credentials: { apiKey: MUSE_KEY } });
  // Muse가 실제로 보내는 reasoning id 형태(콜론 포함)를 쓴다.
  const REASONING_ID = "rs_n1:rs_n2";
  const museCreated = (id: string) => ({
    type: "response.created" as const,
    response: { id, model: "muse-spark-1.3-contributor", usage: null },
  });
  const museCompleted = (id: string, outputTokens: number, reasoningTokens: number) => ({
    type: "response.completed" as const,
    response: {
      id,
      model: "muse-spark-1.3-contributor",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: reasoningTokens } },
    },
  });
  /** 추론 없이 텍스트 한 줄로 끝나는 Muse SSE. 재요청 판정이 보는 첫 응답이다. */
  const museAnnouncement = (id: string, messageId: string, text: string) => [
    museCreated(id),
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: messageId, role: "assistant" } },
    { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: text },
    museCompleted(id, 8, 0),
  ];
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
    const timingRecords: GatewayRequestTimingRecord[] = [];
    let throwOnTimingSink = false;
    const router = createAiGatewayRouter({
      fetch: fetchMock,
      readMuseCodeAuth: signedIn,
      requestTiming: (record) => {
        timingRecords.push(record);
        if (throwOnTimingSink) {
          throw new Error("simulated request timing sink failure");
        }
      },
    });
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

      expect(timingRecords.length).toBe(1);
      const [timing] = timingRecords;
      expect(timing.provider).toBe("muse-code");
      expect(timing.route).toBe("translated");
      expect(timing.outcome).toBe("ok");
      expect(timing.status).toBe(200);
      expect(timing.ms.upstreamStart).toBeDefined();
      expect(timing.ms.upstreamHeaders).toBeDefined();
      expect(timing.ms.thinkingBlockStart).toBeDefined();
      expect(timing.ms.contentBlockStart).toBeDefined();
      expect(timing.contentBlockKind).toBe("tool_use");

      // Verify no sensitive prompts, completions, reasoning, tool arguments, or credentials leaked into the journal
      const timingJson = JSON.stringify(timingRecords);
      expect(timingJson).not.toContain("read b.ts");
      expect(timingJson).not.toContain("Now a.ts.");
      expect(timingJson).not.toContain("check a.ts");
      expect(timingJson).not.toContain('"Read"');
      expect(timingJson).not.toContain('"/a.ts"');
      expect(timingJson).not.toContain(MUSE_KEY);
      expect(timingJson).not.toContain(ANTHROPIC_CRED);
      expect(timingJson).not.toContain("xai-blob");
      expect(timingJson).not.toContain("muse-blob-new");

      // Arm the sink to throw on the second turn: sink exceptions must be swallowed and must not alter the client response
      throwOnTimingSink = true;

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
      expect(timingRecords.length).toBe(2);
      const replayed = calls[1]!.body.input.filter((item: { type: string }) => item.type === "reasoning");
      expect(replayed).toEqual([{ type: "reasoning", id: REASONING_ID, summary: [], encrypted_content: "muse-blob-new" }]);
      expect(JSON.stringify(calls[1]!.body.input)).not.toContain("reasoning_origin");
    } finally {
      router.dispose();
    }
  });

  it("ends an answer the output cap cut short as max_tokens, never as a finished turn", async () => {
    // Responses ends a capped answer either as `response.incomplete` or as `response.completed`
    // carrying `status: incomplete`. Both once reached Claude Code as end_turn (or, streamed, as a
    // mid-response error), so its output-cap recovery never ran and the cut text read as final.
    const capped = (terminal: Record<string, unknown>) => [
      { type: "response.created", response: { id: "r2", model: "muse-spark-1.3-contributor", usage: null } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "The verdict is" },
      terminal,
    ];
    const incompleteResponse = {
      id: "r2",
      model: "muse-spark-1.3-contributor",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 10, output_tokens: 128 },
    };
    const terminals = [
      { type: "response.incomplete", response: incompleteResponse },
      { type: "response.completed", response: incompleteResponse },
    ];
    let served = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      capped(terminals[served++]!).map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: signedIn });
    try {
      const streamed = response();
      await router.handle(ctx({ res: streamed, token: ANTHROPIC_CRED, model: MUSE_MODEL }));
      expect(streamed.status).toBe(200);
      expect(streamed.body).toContain('"stop_reason":"max_tokens"');
      expect(streamed.body).toContain("event: message_stop");
      expect(streamed.body).not.toContain("event: error");

      const collected = response();
      await router.handle(ctx({
        res: collected,
        token: ANTHROPIC_CRED,
        rawBody: { model: MUSE_MODEL, messages: [{ role: "user", content: "Hello" }], max_tokens: 128, stream: false },
      }));
      expect(collected.status).toBe(200);
      const message = JSON.parse(collected.body) as { stop_reason: string; content: unknown[] };
      expect(message.stop_reason).toBe("max_tokens");
      expect(message.content).toEqual([{ type: "text", text: "The verdict is" }]);
    } finally {
      router.dispose();
    }
  });

  it("nudges a tool-result turn on when Muse skipped reasoning and only announced its next step", async () => {
    // Muse sometimes skips reasoning and ends a tool loop on "Now I'll run the tests." with no
    // call, and the same request drawn again repeats it. The gateway asks once more with that
    // announcement and a short nudge appended. The client must see one message — the announcement
    // followed by the recovered call — and the gateway must ask at most once more.
    const created = museCreated("r4");
    const completed = (outputTokens: number, reasoningTokens: number) => museCompleted("r4", outputTokens, reasoningTokens);
    const announced = museAnnouncement("r4", "msg_a", "Now I'll run the tests.");
    const recovered = [
      created,
      { type: "response.reasoning_text.delta", item_id: REASONING_ID, output_index: 0, delta: "run them" },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: REASONING_ID, encrypted_content: "muse-blob-2", summary: [] } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "Bash", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc_2", output_index: 1, arguments: '{"command":"pnpm test"}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "Bash", arguments: '{"command":"pnpm test"}' } },
      completed(30, 12),
    ];
    const scripts = [announced, recovered, announced, announced, recovered];
    let served = 0;
    const sentInputs: Array<Array<Record<string, unknown>>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      sentInputs.push((JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> }).input);
      return new Response(
        scripts[served++]!.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: signedIn });
    const afterToolResult = [
      { role: "user", content: "fix the build" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Edit", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ];
    const tools = [{ name: "Bash", input_schema: { type: "object", properties: {} } }, { name: "Edit", input_schema: { type: "object", properties: {} } }];
    // A main turn's output budget; small budgets are side calls the gateway never redraws.
    const mainTurn = { model: MUSE_MODEL, messages: afterToolResult, tools, max_tokens: 32_000, stream: true };
    try {
      const recoveredRes = response();
      await router.handle(ctx({ res: recoveredRes, token: ANTHROPIC_CRED, rawBody: mainTurn }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The second ask is the first one plus the announcement and a developer nudge, nothing else.
      expect(sentInputs[1]!.slice(0, -2)).toEqual(sentInputs[0]);
      expect(sentInputs[1]!.slice(-2)).toEqual([
        { type: "message", role: "assistant", content: "Now I'll run the tests." },
        { type: "message", role: "developer", content: expect.any(String) },
      ]);
      expect(recoveredRes.body.match(/event: message_start/g)).toHaveLength(1);
      expect(recoveredRes.body.match(/Now I'll run the tests\./g)).toHaveLength(1);
      expect(recoveredRes.body.indexOf("Now I'll run the tests.")).toBeLessThan(recoveredRes.body.indexOf('"name":"Bash"'));
      expect(recoveredRes.body).toContain('"stop_reason":"tool_use"');

      // A second ask that only announces again is dropped: the client gets the first answer, and
      // there is no third ask.
      const againRes = response();
      await router.handle(ctx({ res: againRes, token: ANTHROPIC_CRED, rawBody: mainTurn }));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(againRes.body.match(/event: message_start/g)).toHaveLength(1);
      expect(againRes.body.match(/Now I'll run the tests\./g)).toHaveLength(1);
      expect(againRes.body).toContain('"stop_reason":"end_turn"');

      // Early-preview contract (red): the first announcement must reach the client while the
      // upstream second turn has supplied nothing but a blob-less reasoning add (dropped by the
      // adapter, as in run3:419/879) — i.e. long before reasoning completes. The gate holds
      // reasoning done and every call frame back, so a fix gated on a visible reasoning signal
      // alone (A) still fails here; only emitting the preview up front (C1) passes.
      // Order is asserted with events only: the mock signals when it reaches the gate, and the
      // test reads the downstream body until the preview arrives (releasing the gate on success).
      // No sleep acts as a correctness condition; the waitFor bounds are failure timeouts.
      const created2 = { type: "response.created", response: { id: "r5", model: "muse-spark-1.3-contributor", usage: null } };
      const reasoningAddedNoBlob = { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: REASONING_ID, summary: [] } };
      const reasoningDoneWithBlob = { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: REASONING_ID, encrypted_content: "muse-blob-early", summary: [] } };
      const callFrames = [
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "Bash", arguments: "" } },
        { type: "response.function_call_arguments.done", item_id: "fc_3", output_index: 1, arguments: '{"command":"pnpm test"}' },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "Bash", arguments: '{"command":"pnpm test"}' } },
        completed(30, 12),
      ];
      let releaseSecond: () => void = () => {};
      const releaseGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let reachedGate = false;
      const sseEncode = (frame: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
      let earlyCalls = 0;
      const earlyFetchMock = vi.fn<typeof fetch>(async () => {
        earlyCalls += 1;
        if (earlyCalls === 1) {
          return new Response(announced.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(sseEncode(created2));
            controller.enqueue(sseEncode(reasoningAddedNoBlob));
            reachedGate = true;
            await releaseGate;
            controller.enqueue(sseEncode(reasoningDoneWithBlob));
            for (const frame of callFrames) controller.enqueue(sseEncode(frame));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      });
      const earlyRouter = createAiGatewayRouter({ fetch: earlyFetchMock, readMuseCodeAuth: signedIn });
      const earlyRes = response();
      const earlyHandle = earlyRouter.handle(ctx({ res: earlyRes, token: ANTHROPIC_CRED, rawBody: mainTurn }));
      try {
        await vi.waitFor(() => expect(earlyCalls).toBe(2), { timeout: 5_000 });
        await vi.waitFor(() => expect(reachedGate).toBe(true), { timeout: 5_000 });
        // Reasoning done and the function call are still behind the gate. The first announcement
        // must already be downstream — before the long reasoning completes.
        await vi.waitFor(() => expect(earlyRes.body).toContain("Now I'll run the tests."), { timeout: 3_000 });
      } finally {
        releaseSecond();
        await earlyHandle;
        earlyRouter.dispose();
      }
      expect(earlyFetchMock).toHaveBeenCalledTimes(2);
      expect(earlyRes.body.match(/Now I'll run the tests\./g)).toHaveLength(1);
      expect(earlyRes.body.indexOf("Now I'll run the tests.")).toBeLessThan(earlyRes.body.indexOf('"name":"Bash"'));
      // The early preview must not open a second message: one message, closed as tool_use.
      expect(earlyRes.body.match(/event: message_start/g)).toHaveLength(1);
      expect(earlyRes.body.match(/event: message_stop/g)).toHaveLength(1);
      expect(earlyRes.body).toContain('"stop_reason":"tool_use"');
    } finally {
      router.dispose();
    }
  });

  it("does not ask again after a turn-yielding tool result, and still recovers a foreground Bash", async () => {
    // ScheduleWakeup, and Bash only when run_in_background is true, end the turn on purpose.
    // A yield anywhere in the trailing result batch disarms the redraw, so a later Read must not
    // re-arm it. Asking again would poll or start the job twice. A foreground Bash still recovers.
    const recovered = [
      museCreated("r6"),
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_y", call_id: "call_y", name: "Bash", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc_y", output_index: 0, arguments: '{"command":"pnpm test"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_y", call_id: "call_y", name: "Bash", arguments: '{"command":"pnpm test"}' } },
      museCompleted("r6", 12, 0),
    ];
    // Yield turns consume only their announcement. The foreground Bash consumes the recovery too.
    const scripts = [
      museAnnouncement("r6", "msg_y", "Waiting for the wakeup."),
      museAnnouncement("r6", "msg_y", "Waiting for the background job."),
      museAnnouncement("r6", "msg_y", "Now I'll run the tests."),
      recovered,
    ];
    let served = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      scripts[served++]!.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ));
    const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: signedIn });
    const tools = [
      { name: "ScheduleWakeup", input_schema: { type: "object", properties: {} } },
      { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" }, run_in_background: { type: "boolean" } } } },
      { name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
    ];
    const turn = (name: string, input: Record<string, unknown>, id: string) => ({
      model: MUSE_MODEL,
      max_tokens: 32_000,
      stream: true,
      tools,
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      ],
    });
    // Read is last on purpose. Disarming only the last result would redraw this turn.
    const backgroundBatch = {
      model: MUSE_MODEL,
      max_tokens: 32_000,
      stream: true,
      tools,
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_b", name: "Bash", input: { command: "pnpm test", run_in_background: true } },
            { type: "tool_use", id: "call_r", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_b", content: "started" },
            { type: "tool_result", tool_use_id: "call_r", content: "file" },
          ],
        },
      ],
    };
    try {
      const wakeup = response();
      await router.handle(ctx({
        res: wakeup,
        token: ANTHROPIC_CRED,
        rawBody: turn("ScheduleWakeup", { delaySeconds: 30 }, "call_w"),
      }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(wakeup.body).toContain("Waiting for the wakeup.");
      expect(wakeup.body).toContain('"stop_reason":"end_turn"');
      expect(wakeup.body).not.toContain('"name":"Bash"');

      const background = response();
      await router.handle(ctx({
        res: background,
        token: ANTHROPIC_CRED,
        rawBody: backgroundBatch,
      }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(background.body).toContain("Waiting for the background job.");
      expect(background.body).toContain('"stop_reason":"end_turn"');
      expect(background.body).not.toContain('"name":"Bash"');

      const foreground = response();
      await router.handle(ctx({
        res: foreground,
        token: ANTHROPIC_CRED,
        rawBody: turn("Bash", { command: "pnpm test" }, "call_f"),
      }));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(foreground.body).toContain("Now I'll run the tests.");
      expect(foreground.body).toContain('"stop_reason":"tool_use"');
    } finally {
      router.dispose();
    }
  });

  it("stops the upstream turn and frees its slot when the client hangs up mid-stream", async () => {
    // Node emits the request's `close` once the body is read, so a disconnect after that went
    // unheard: the provider generated to the end, the handler waited forever on a `drain` the dead
    // socket never sends, and its upstream permit was never handed back.
    const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    let upstreamSignal: AbortSignal | undefined;
    let upstreamCancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame({ type: "response.created", response: { id: "r3", model: "muse-spark-1.3-contributor", usage: null } }));
          controller.enqueue(frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } }));
          timer = setInterval(() => controller.enqueue(frame({
            type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "x".repeat(256 * 1024),
          })), 5);
        },
        cancel() {
          upstreamCancelled = true;
          clearInterval(timer);
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const journal: GatewayFailureRecord[] = [];
    const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: signedIn, failureJournal: (record) => journal.push(record) });
    let serverRes: http.ServerResponse | undefined;
    let handled: Promise<unknown> | undefined;
    const server = http.createServer((req, res) => {
      serverRes = res;
      handled = Promise.resolve(router.handle({ req, res, pathname: new URL(req.url ?? "/", "http://127.0.0.1").pathname }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const payload = JSON.stringify({ model: MUSE_MODEL, messages: [{ role: "user", content: "Hello" }], max_tokens: 128, stream: true });
      const client = net.connect({ port, host: "127.0.0.1" }, () => {
        client.write(
          `POST ${MESSAGES} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nauthorization: Bearer ${ANTHROPIC_CRED}\r\n` +
          `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
        );
      });
      // A client that stops reading parks the handler on backpressure; hanging up there is the
      // case that used to wedge it for good.
      client.pause();
      await vi.waitFor(() => expect(serverRes?.writableNeedDrain).toBe(true), { timeout: 5_000 });
      expect(router.upstreamStats().map((stats) => stats.inFlight)).toEqual([1]);
      client.destroy();

      await vi.waitFor(() => expect(handled).toBeDefined());
      await handled;
      expect(upstreamSignal?.aborted).toBe(true);
      expect(upstreamCancelled).toBe(true);
      expect(router.upstreamStats().reduce((sum, stats) => sum + stats.inFlight, 0)).toBe(0);
      expect(journal).toEqual([expect.objectContaining({ phase: "post_commit", detail: "client disconnected", provider: "muse-code" })]);
      expect(journal[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
      router.dispose();
    }
  });

  it("refuses before spending a request when the sign-in or a forced tool choice cannot be honored", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { message: `bad key ${MUSE_KEY}`, type: "invalid_api_key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-auth-routing-"));
    const authService = createProviderAuthService({ dataDir: directory });
    const oauth = createMuseCodeOAuth({ authService });
    const signedOut = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: oauth.readAuth });
    try {
      const signedOutRes = response();
      await signedOut.handle(ctx({ res: signedOutRes, token: ANTHROPIC_CRED, model: MUSE_MODEL }));
      expect(signedOutRes.status).toBe(403);
      expect(signedOutRes.headers["x-should-retry"]).toBe("false");
      expect(signedOutRes.body).not.toContain("model:");
      expect(signedOutRes.body).toContain("Console quota panel");

      await authService.setEntry(MUSE_CODE_AUTH_PROVIDER_ID, {
        key: MUSE_KEY, type: "oauth-device", accessToken: "account-token", mintedAt: Date.now(), version: 1,
      });
      const router = createAiGatewayRouter({ fetch: fetchMock, readMuseCodeAuth: oauth.readAuth });
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
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${MUSE_KEY}`);
      expect(refusedRes.status).toBe(403);
      expect(refusedRes.headers["x-should-retry"]).toBe("false");
      expect(refusedRes.body).not.toContain("model:");
      expect(refusedRes.body).toContain("Console quota panel");
      expect(refusedRes.body).not.toContain(MUSE_KEY);
      router.dispose();
    } finally {
      signedOut.dispose();
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("OpenCode Go routing", () => {
  it("sends each model over its own wire with the stored key, Fleet's user agent, and one session per conversation", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(String(url).endsWith("/responses")
        ? 'data: {"type":"response.completed","response":{"id":"r","model":"muse-spark-1.3-contributor","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
        : "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });

    // No stored key: refused as a sign-in problem before anything leaves the process.
    const signedOut = createAiGatewayRouter({ fetch: fetchMock, readOpencodeApiKey: () => undefined });
    const refused = response();
    await signedOut.handle(ctx({ res: refused, token: ANTHROPIC_CRED, model: "claude-gateway--opencode--deepseek-v4.1-flash" }));
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("OpenCode Go");
    expect(fetchMock).not.toHaveBeenCalled();
    signedOut.dispose();

    const router = createAiGatewayRouter({ fetch: fetchMock, readOpencodeApiKey: async () => "opencode-key" });
    try {
      const wires = [
        { model: "deepseek-v4.1-flash", url: "https://opencode.ai/inference/go/openai/v1/chat/completions" },
        // The same model id Muse Code serves, reached through OpenCode Go instead.
        { model: "muse-spark-1.3-contributor", url: "https://opencode.ai/inference/go/openai/v1/responses" },
      ];
      for (const wire of wires) {
        calls.length = 0;
        for (const userId of ["private-user-session-a", "private-user-session-a", "private-user-session-b", null, null]) {
          const res = response();
          await router.handle(ctx({
            res, token: ANTHROPIC_CRED, model: `claude-gateway--opencode--${wire.model}`,
            metadata: userId === null ? null : { user_id: userId },
          }));
          expect(res.status).toBe(200);
        }
        for (const call of calls) {
          expect(call.url).toBe(wire.url);
          expect(call.body.model).toBe(wire.model);
          expect(call.headers.get("authorization")).toBe("Bearer opencode-key");
          expect(call.headers.get("user-agent")).toBe("fleet-console");
        }
        const sessions = calls.map((call) => call.headers.get("x-opencode-session"));
        expect(sessions[0]).toBeTruthy();
        expect(sessions[1]).toBe(sessions[0]);
        expect(sessions[2]).not.toBe(sessions[0]);
        expect(sessions[3]).not.toBe(sessions[4]);
        expect(sessions.join(" ")).not.toContain("private-user");
      }
    } finally {
      router.dispose();
    }
  });
});

describe("Gemini routing", () => {
  it("refuses without a stored key, then calls the Gemini API with that key and reports the turn to the ledger", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(`data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, serviceTier: "standard" },
      })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const geminiUsage = { observeUsage: vi.fn(), observeBlock: vi.fn() };

    const signedOut = createAiGatewayRouter({ fetch: fetchMock, readGeminiApiKey: () => undefined, geminiUsage });
    const refused = response();
    await signedOut.handle(ctx({ res: refused, token: ANTHROPIC_CRED, model: "claude-gateway--gemini--gemini-4-hydrogen" }));
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("Gemini");
    expect(fetchMock).not.toHaveBeenCalled();
    signedOut.dispose();

    const router = createAiGatewayRouter({ fetch: fetchMock, readGeminiApiKey: async () => "gemini-key", geminiUsage });
    try {
      const res = response();
      await router.handle(ctx({ res, token: ANTHROPIC_CRED, model: "claude-gateway--gemini--gemini-4-argon" }));
      expect(res.status).toBe(200);
      expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse");
      expect(calls[0]?.headers.get("x-goog-api-key")).toBe("gemini-key");
      expect(geminiUsage.observeUsage).toHaveBeenCalledTimes(1);
      expect(geminiUsage.observeUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-4-argon", promptTokens: 3, serviceTier: "standard" }));
    } finally {
      router.dispose();
    }
  });
});

describe("Anthropic API key routing", () => {
  // 카탈로그 id는 가족 기준(`anthropic--sonnet-1m`)이고, 상류 id는 설치된 Claude Code 동기화가 알려 주는 값이다.
  const CREDIT_MODEL = "claude-gateway--anthropic--sonnet-1m[1m]";
  const syncClaudeLineup = (version: string) => async () => {
    applyClaudeNativeModels([
      { value: "sonnet[1m]", resolvedModel: `claude-sonnet-${version}[1m]`, displayName: "Sonnet", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ]);
  };
  const sse = (events: ReadonlyArray<Record<string, unknown>>): string =>
    events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const completedTurn = sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ]);

  it("sends the stored key as x-api-key only, never the caller's subscription credential, and refuses without a key", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(completedTurn, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "anthropic-ratelimit-requests-limit": "50",
          "anthropic-ratelimit-requests-remaining": "49",
          "anthropic-ratelimit-requests-reset": "2026-11-18T10:00:30Z",
        },
      });
    });
    const anthropicUsage = { observeUsage: vi.fn(), observeBlock: vi.fn(), observeRateLimit: vi.fn() };

    const ensureClaudeNativeModels = vi.fn(syncClaudeLineup("5-5"));
    const signedOut = createAiGatewayRouter({ fetch: fetchMock, ensureClaudeNativeModels, readAnthropicApiKey: () => undefined, anthropicUsage });
    const refused = response();
    await signedOut.handle(ctx({ res: refused, token: ANTHROPIC_CRED, model: CREDIT_MODEL }));
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("Anthropic");
    expect(fetchMock).not.toHaveBeenCalled();
    signedOut.dispose();

    const router = createAiGatewayRouter({ fetch: fetchMock, ensureClaudeNativeModels, readAnthropicApiKey: async () => "sk-ant-api03-stored", anthropicUsage });
    try {
      const res = response();
      await router.handle(ctx({
        res,
        token: ANTHROPIC_CRED,
        model: CREDIT_MODEL,
        headers: { "anthropic-beta": "oauth-2025-04-20,context-management-2025-06-27", "user-agent": "claude-cli/9.9.9 (external, sdk-ts)" },
        rawBody: { model: CREDIT_MODEL, speed: "fast", max_tokens: 128, stream: true, messages: [{ role: "user", content: "hi" }] },
      }));
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
      // 보안 경계: 크레딧 모델은 저장된 키만 싣고 호출자의 구독 토큰은 상류로 나가지 않는다.
      expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant-api03-stored");
      expect(calls[0]?.headers.get("authorization")).toBeNull();
      expect([...calls[0]!.headers.values()].join("\n")).not.toContain(ANTHROPIC_CRED);
      // OAuth 전용 베타는 빠지고, 나머지 베타·진입점 표식(user-agent)은 호출자 값 그대로다.
      expect(calls[0]?.headers.get("anthropic-beta")).toBe("context-management-2025-06-27");
      expect(calls[0]?.headers.get("user-agent")).toBe("claude-cli/9.9.9 (external, sdk-ts)");
      // 가상 id는 동기화가 알려 준 상류 id로 바뀌고 Fast(`speed`)는 지워진다.
      expect(calls[0]?.body.model).toBe("claude-sonnet-5-5");
      expect(calls[0]?.body).not.toHaveProperty("speed");
      // 응답은 그대로 흘러가고, 옆에서 지출·한도 헤더를 읽는다.
      expect(res.body).toBe(completedTurn);
      expect(anthropicUsage.observeRateLimit).toHaveBeenCalledWith(expect.objectContaining({
        requests: { limit: 50, remaining: 49, resetsAt: Date.parse("2026-11-18T10:00:30Z") },
      }));
      expect(anthropicUsage.observeUsage).toHaveBeenCalledTimes(1);
      expect(anthropicUsage.observeUsage).toHaveBeenCalledWith(expect.objectContaining({
        model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 40,
      }));
      expect(anthropicUsage.observeBlock).not.toHaveBeenCalled();

      // 구독 모델(네이티브 claude)은 키를 모른다 — 저장된 키가 있어도 호출자 자격만 간다.
      const native = new Headers();
      const nativeRouter = createAiGatewayRouter({
        resolveExecutionModel: async () => ({ modelId: "claude-opus-5-5" }),
        readAnthropicApiKey: async () => "sk-ant-api03-stored",
        fetch: vi.fn<typeof fetch>(async (_url, init) => {
          new Headers(init?.headers).forEach((value, key) => native.set(key, value));
          return new Response("{}", { status: 200 });
        }),
      });
      try {
        await nativeRouter.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model: "claude-gateway--fleet--execute", headers: { "x-claude-code-session-id": "parent", "x-claude-code-agent-id": "child" } }));
        expect(native.get("authorization")).toBe(`Bearer ${ANTHROPIC_CRED}`);
        expect(native.get("x-api-key")).toBeNull();
      } finally {
        nativeRouter.dispose();
      }
    } finally {
      router.dispose();
    }
  });

  it("reports a depleted credit balance and does not count spend for a turn that did not complete", async () => {
    const anthropicUsage = { observeUsage: vi.fn(), observeBlock: vi.fn(), observeRateLimit: vi.fn() };
    const bodies = [
      new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400, headers: { "content-type": "application/json" } }),
      new Response(sse([
        { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 9, output_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      ]), { status: 200, headers: { "content-type": "text/event-stream" } }),
    ];
    const router = createAiGatewayRouter({ fetch: vi.fn<typeof fetch>(async () => bodies.shift()!), ensureClaudeNativeModels: syncClaudeLineup("5-5"), readAnthropicApiKey: async () => "sk-ant-api03-stored", anthropicUsage });
    try {
      const depleted = response();
      await router.handle(ctx({ res: depleted, token: ANTHROPIC_CRED, model: CREDIT_MODEL }));
      expect(depleted.body).toContain("credit balance is too low");
      expect(anthropicUsage.observeBlock).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5-5", httpStatus: 400, reason: "balance_depleted" }));
      // 스트림이 message_stop 없이 끝났다 — 0이나 부분값으로 지어내지 않는다.
      await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model: CREDIT_MODEL }));
      expect(anthropicUsage.observeUsage).not.toHaveBeenCalled();
    } finally {
      router.dispose();
    }
  });

  it("does not send an alias upstream before Claude Code has reported the version, and follows a version change", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) =>
      new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", content: [], model: JSON.parse(String(init?.body)).model }), { status: 200, headers: { "content-type": "application/json" } }));
    applyClaudeNativeModels([]);
    const unresolved = createAiGatewayRouter({ fetch: fetchMock, ensureClaudeNativeModels: async () => undefined, readAnthropicApiKey: async () => "sk-ant-api03-stored" });
    const early = response();
    await unresolved.handle(ctx({ res: early, token: ANTHROPIC_CRED, model: CREDIT_MODEL }));
    expect(early.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    unresolved.dispose();

    // 같은 카탈로그 id가 버전이 바뀐 뒤에도 그대로 새 상류 id로 간다.
    let version = "5-5";
    const router = createAiGatewayRouter({ fetch: fetchMock, ensureClaudeNativeModels: async () => syncClaudeLineup(version)(), readAnthropicApiKey: async () => "sk-ant-api03-stored" });
    try {
      await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model: CREDIT_MODEL }));
      version = "5-6";
      await router.handle(ctx({ res: response(), token: ANTHROPIC_CRED, model: CREDIT_MODEL }));
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-6"]);
    } finally {
      router.dispose();
    }
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
    model: options.model ?? "claude-gateway--codex--gpt-6.1-sol",
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


describe("upper-session routing batch", () => {
  const items = [{ key: "member", prompt: "Implement the requested change" }];
  const models = [requireGatewayModel("claude--opus-1m"), requireGatewayModel("codex--gpt-6.1-sol")];

  it("commits judged choices and rule fallbacks, and rechecks exposure after the judgment", async () => {
    const providerLoad = new Map<string, number>();
    const distribution = new GatewayRoutingDistribution();
    const exposure: GatewayAssignmentExposure = { delegationModels: models, providerLoad, distribution };
    const choose = vi.fn(async () => ({ t0: { seat: "c1", difficulty: "xhigh" } }));
    const [routed] = await decideGatewayRoutingBatch(items, exposure, { choose });
    expect(routed).toMatchObject({ key: "member", model: "codex--gpt-6.1-sol", effort: "xhigh", via: "route" });
    expect(choose.mock.calls).toHaveLength(1);
    expect(providerLoad.get("codex")).toBe(1);
    const [failed] = await decideGatewayRoutingBatch(items, exposure, { choose: async () => { throw new Error("judge failed"); } });
    expect(failed).toMatchObject({ model: "opus[1m]", effort: "medium", via: "rule" });
    expect(providerLoad.get("claude")).toBe(1);
    expect(distribution.snapshot(exposure).providers).toMatchObject({ claude: { assignments: 1 }, codex: { assignments: 1 } });
    const [stale] = await decideGatewayRoutingBatch(items, exposure, {
      choose: async () => ({ t0: { seat: "c1" } }),
      refreshExposure: (() => { let reads = 0; return () => ++reads === 1 ? exposure : { ...exposure, delegationModels: [models[0]!] }; })(),
    });
    expect(stale).toMatchObject({ model: "opus[1m]", via: "rule" });
  });

  it("keeps critical models in settings order but routes only to the least consumed when all are critical", async () => {
    const now = Date.now();
    const quota = (usedPercent: number) => ({ status: "ok", fetchedAt: now, windows: [{
      id: "session", usedPercent, resetsAt: now + 4 * 3_600_000,
      period: { durationMs: 5 * 3_600_000, durationBasis: "upstream" },
    }] });
    const exposure: GatewayAssignmentExposure = { delegationModels: models, quota: { claude: quota(100), codex: quota(40) } };
    expect(buildGatewayCandidates(exposure).candidates).toEqual([]);
    const enabled = buildGatewayEnabledModels(exposure);
    expect(enabled.models.map(row => row.model)).toEqual(["opus[1m]", "codex--gpt-6.1-sol"]);
    expect(Object.keys(enabled.models[0]!)).toEqual(["model", "fast", "efforts", "summary"]);
    const choose = vi.fn(async () => ({}));
    const [decision] = await decideGatewayRoutingBatch(items, exposure, { choose });
    expect(decision).toMatchObject({ model: "codex--gpt-6.1-sol", effort: "medium", via: "least-used" });
    expect(choose).not.toHaveBeenCalled();
    await expect(decideGatewayRoutingBatch(items, { delegationModels: [] }, { choose })).rejects.toBeInstanceOf(NoEnabledGatewayModelsError);
  });

  it("sends a fresh snapshot and the confirmed commander assignment under one policy", async () => {
    const seen: Array<{ readonly state: Readonly<Record<string, unknown>>; readonly instructions: readonly string[] }> = [];
    await decideGatewayRoutingBatch(items, { delegationModels: models, providerLoad: new Map() }, {
      choose: async (input) => { seen.push(input); return { t0: { seat: "c0", difficulty: "low" } }; },
      commanderAssignment: { model: "opus[1m]", effort: "high" },
    });
    const question = seen[0]!;
    expect(question.state.commanderAssignment).toEqual({ model: "opus[1m]", effort: "high" });
    expect(question.state).toHaveProperty("gateway_models");
    expect(question.state).toHaveProperty("tasks");
    expect(JSON.stringify(question.state)).not.toMatch(/intelligenceIndex|roleThresholds/);
    const policy = routingBatchInstructions.join("\n");
    expect(policy).toContain("Per turn, route only state.tasks using current candidates; task and candidate keys are local to this turn. For mutable routing facts, current state supersedes prior turns; missing values remain unknown. Use history for objective context, not as evidence of current routing facts or applied assignments. If present, state.commanderAssignment is the saved commander assignment; use it as context, not a constraint on member choices.");
    expect(policy).toContain("These counts are neither actual quota consumption nor active runs. Do not add historical choices to recentAssignments. Prioritize remaining quota");
    expect(policy).not.toContain("Prior choices are not execution evidence");
    expect(policy).toContain("Do not infer capabilities from model names or aliases");
    expect(policy).not.toMatch(/forget/i);
    expect(routingDifficulty.instructions.join("\n")).toContain("If torn between levels, choose the lower one");
    expect(question.instructions).toEqual(routingBatchInstructions);
  });

  it("does not commit an interrupted judgment", async () => {
    const controller = new AbortController();
    const providerLoad = new Map<string, number>();
    await expect(decideGatewayRoutingBatch(items, { delegationModels: models, providerLoad }, {
      signal: controller.signal, choose: async () => { controller.abort(new Error("caller closed")); throw controller.signal.reason; },
    })).rejects.toThrow("caller closed");
    expect(providerLoad.size).toBe(0);
  });
});
