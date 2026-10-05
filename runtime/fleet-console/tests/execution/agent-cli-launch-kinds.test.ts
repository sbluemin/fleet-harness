import { resolveAiGatewaySelection } from "@fleet-console/ai-gateway";
import { describe, expect, it } from "vitest";

import { parseModelRoster, resolveRosterCoordinate } from "@fleet-console/sdk/models";

import { buildAgentCliLaunchKinds } from "../../features/execution/host/agent/agent-cli-launch-kinds.js";
import { buildModelRoster, createModelRosterHost } from "../../features/ai-gateway/host/model-roster.js";

// 축은 사다리 어휘 그대로다. 한 모델이 그 일부만 내놓아도 축은 줄지 않는다 — 그래야 표면이
// 내놓은 단을 균등히 벌리는 대신 제자리에 세울 수 있다.
const EFFORT_AXIS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const EVERYDAY_AXIS = ["low", "medium", "high", "xhigh"];
const APEX_EFFORTS = ["max", "ultra"];
// max를 내지 않는 gateway 모델의 축 — max 자리는 건너뛰고, 하네스 능력인 ultra가 끝에 선다.
const MAX_LESS_AXIS = [...EVERYDAY_AXIS, "ultra"];

describe("buildAgentCliLaunchKinds", () => {

  it("projects the enabled roster as launch variants in provider order with exposed effort ladders", () => {
    const resolved = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "claude--sonnet-1m" },
        { id: "opencode--muse-spark-1.3-contributor", efforts: ["high"] },
        { id: "codex--gpt-6-sol-fast" },
      ],
    });

    const result = buildAgentCliLaunchKinds(
      [{ id: "claude", label: "Claude (Gateway)", available: true, signedIn: true }],
      "agent",
      resolved,
    );

    expect(result[0]?.variants).toEqual([
      // Claude 항목도 로스터의 한 띠다 — 하드코딩 네이티브 띠는 없다. 1M 좌표는 Claude Code 별칭으로 선다.
      {
        id: "gateway:claude",
        label: "Claude",
        rows: [
          {
            id: "sonnet[1m]",
            label: expect.any(String),
            launch: { model: "sonnet[1m]" },
            contextWindow: 1_000_000,
            capabilityClass: expect.any(String),
            effortAxis: EFFORT_AXIS,
            gatedEfforts: APEX_EFFORTS,
            chips: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => expect.objectContaining({ id: effort, launch: { model: "sonnet[1m]", effort } })),
          },
        ],
      },
      {
        id: "gateway:codex",
        label: "Codex",
        rows: [
          {
            id: "codex--gpt-6-sol-fast",
            label: "GPT-6-Sol-Fast",
            launch: { model: "codex--gpt-6-sol-fast" },
            contextWindow: expect.any(Number),
            capabilityClass: expect.any(String),
            effortAxis: EFFORT_AXIS,
            gatedEfforts: APEX_EFFORTS,
            chips: [
              gatewayChip("codex--gpt-6-sol-fast", "low", "LOW"),
              gatewayChip("codex--gpt-6-sol-fast", "medium", "MED"),
              gatewayChip("codex--gpt-6-sol-fast", "high", "HIGH"),
              gatewayChip("codex--gpt-6-sol-fast", "xhigh", "XHIGH"),
              gatewayChip("codex--gpt-6-sol-fast", "max", "MAX"),
              gatewayChip("codex--gpt-6-sol-fast", "ultra", "ULTRACODE"),
            ],
          },
        ],
      },
      {
        id: "gateway:opencode",
        label: "OpenCode",
        rows: [
          {
            id: "opencode--muse-spark-1.3-contributor",
            label: "Muse-Spark-1.3-Contributor",
            launch: { model: "opencode--muse-spark-1.3-contributor" },
            contextWindow: expect.any(Number),
            capabilityClass: expect.any(String),
            effortAxis: MAX_LESS_AXIS,
            gatedEfforts: ["ultra"],
            chips: [
              gatewayChip("opencode--muse-spark-1.3-contributor", "high", "HIGH"),
              gatewayChip("opencode--muse-spark-1.3-contributor", "ultra", "ULTRACODE"),
            ],
          },
        ],
      },
    ]);
  });

  it("projects the Gateway roster once for every target and resolves stored coordinates without rewriting them", () => {
    // 빈 로스터에는 공급자 띠가 없다 — 최후 폴백(sonnet) 한 행의 폴백 띠만 서서 표면이 폴백 표식으로 그린다.
    expect(buildAgentCliLaunchKinds([{ id: "claude", label: "Claude", available: true, signedIn: true }], "agent", resolveAiGatewaySelection({ version: 1, models: [] }))[0]?.variants?.map((group) => [group.id, group.rows.map((row) => row.launch.model)])).toEqual([["roster-fallback", ["sonnet"]]]);
    const settings = {
      version: 1 as const,
      models: [{ id: "claude--sonnet" }, { id: "codex--gpt-6-sol-fast", efforts: ["low", "high"] }],
    };
    const selection = resolveAiGatewaySelection(settings);
    const agent = buildModelRoster(selection, "agent");
    // 정준 id(실행 id)로 서고, Agent SDK 대상에는 ultra도 게이트도 없다. 노출 사다리(effortExposure)가 곧 전체다.
    expect(agent.map((group) => [group.id, group.rows.map((row) => [row.launch.model, row.chips?.map((chip) => chip.id)])])).toEqual([
      ["gateway:claude", [["sonnet", ["low", "medium", "high", "xhigh", "max"]]]],
      ["gateway:codex", [["codex--gpt-6-sol-fast", ["low", "high"]]]],
    ]);
    expect(agent.flatMap((group) => group.rows).some((row) => row.gatedEfforts !== undefined)).toBe(false);
    // launch 대상은 같은 행에 하네스 능력 ultra를 끝에 붙인다.
    expect(buildModelRoster(selection, "launch")[0]?.rows[0]?.chips?.map((chip) => chip.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);

    // 레거시 저장 문법은 읽을 때 정준 id로 접힌다. 사다리 밖 강도는 그 이하의 가장 높은 단으로 내려간다.
    expect(resolveRosterCoordinate(agent, { model: "claude-gateway--codex--gpt-6-sol-fast", effort: "xhigh" })).toMatchObject({ model: "codex--gpt-6-sol-fast", effort: "high", fallback: false });
    expect(resolveRosterCoordinate(agent, { model: "claude--sonnet", effort: "max" })).toMatchObject({ model: "sonnet", effort: "max", fallback: false });
    // 로스터 밖(꺼진 모델)은 sonnet으로 돌고 폴백을 드러낸다. 빈 로스터는 최후 폴백 sonnet이다.
    expect(resolveRosterCoordinate(agent, { model: "opus[1m]", effort: "high" })).toMatchObject({ model: "sonnet", effort: "high", fallback: true, reason: "model_off" });
    expect(resolveRosterCoordinate([], { model: "opus[1m]", effort: "high" })).toMatchObject({ model: "sonnet", row: null, fallback: true, reason: "roster_empty" });

    // 플러그인 포트는 같은 해석에 Agent SDK wire id를 붙인다.
    const host = createModelRosterHost({ readSettings: () => settings });
    expect(host.resolve({ model: "codex--gpt-6-sol-fast" }, "agent")).toMatchObject({ model: "codex--gpt-6-sol-fast", wireModel: expect.stringMatching(/^claude-gateway--codex--gpt-6-sol-fast/) });
    expect(host.resolve({ model: "sonnet" }, "agent").wireModel).toBe("sonnet");

    // 호스트 전용 Claude도 다른 모델처럼 로스터에 그대로 서고, 행이 그 사실과 200k 창을 싣는다(브라우저 파서도 보존한다).
    const reserved = buildModelRoster(resolveAiGatewaySelection({ version: 1, models: [{ id: "claude--sonnet", hostOnly: true }] }), "agent");
    expect(parseModelRoster(JSON.parse(JSON.stringify(reserved)))[0]?.rows[0]).toMatchObject({ launch: { model: "sonnet" }, contextWindow: 200_000, hostOnly: true });
  });

  it("keeps disabled reasons and does not attach variants to a disabled gateway kind", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude (Gateway)", available: false, signedIn: true },
      ],
      "agent",
      resolveAiGatewaySelection({
        version: 1,
        models: [{ id: "opencode--glm-5.3" }],
      }),
    );

    expect(result).toEqual([
      { id: "claude", type: "agent", title: "Claude (Gateway)", disabled: true, disabledReason: "Not installed" },
    ]);
  });
});

function gatewayChip(model: string, effort: string, label: string) {
  return {
    id: effort,
    label,
    launch: { model, effort },
  };
}
