import { resolveAiGatewaySelection } from "@fleet-console/ai-gateway";
import { describe, expect, it } from "vitest";

import { resolveRosterCoordinate } from "@fleet-console/sdk/models";

import { buildAgentCliLaunchKinds } from "../../features/execution/host/agent/agent-cli-launch-kinds.js";
import { buildModelRoster, createModelRosterHost } from "../../features/ai-gateway/host/model-roster.js";

// 축은 사다리 어휘 그대로다. 한 모델이 그 일부만 내놓아도 축은 줄지 않는다 — 그래야 표면이
// 내놓은 단을 균등히 벌리는 대신 제자리에 세울 수 있다.
const EFFORT_AXIS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const EVERYDAY_AXIS = ["low", "medium", "high", "xhigh"];
const APEX_EFFORTS = ["max", "ultra"];
// max를 내지 않는 gateway 모델의 축 — max 자리는 건너뛰고, 하네스 능력인 ultra가 끝에 선다.
const MAX_LESS_AXIS = [...EVERYDAY_AXIS, "ultra"];

const builtinVariants = {
  id: "native",
  label: "Claude",
  rows: [
    // Claude Code's 1M coordinates launch under their plain labels.
    builtinRow("fable[1m]", "Fable"),
    builtinRow("opus[1m]", "Opus"),
    builtinRow("sonnet", "Sonnet"),
  ],
};

describe("buildAgentCliLaunchKinds", () => {

  it("adds enabled gateway models in provider order with their exposed effort ladders", () => {
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
      builtinVariants,
      {
        id: "gateway:codex",
        label: "Codex",
        rows: [
          {
            id: "codex--gpt-6-sol-fast",
            label: "GPT-6-Sol-Fast",
            launch: { model: "codex--gpt-6-sol-fast" },
            contextWindow: expect.any(Number),
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

function builtinRow(model: string, label: string) {
  return {
    id: model,
    label,
    launch: { model },
    // Claude Code의 두 좌표 — 채팅 중 창이 작은 모델로 내려가는 변경을 막는 근거다.
    contextWindow: model.endsWith("[1m]") ? 1_000_000 : 200_000,
    effortAxis: EFFORT_AXIS,
    gatedEfforts: APEX_EFFORTS,
    // ultracode는 하네스 능력이라 네이티브 행도 ultra 칩을 낸다.
    chips: [
      gatewayChip(model, "low", "LOW"),
      gatewayChip(model, "medium", "MED"),
      gatewayChip(model, "high", "HIGH"),
      gatewayChip(model, "xhigh", "XHIGH"),
      gatewayChip(model, "max", "MAX"),
      gatewayChip(model, "ultra", "ULTRACODE"),
    ],
  };
}

function gatewayChip(model: string, effort: string, label: string) {
  return {
    id: effort,
    label,
    launch: { model, effort },
  };
}
