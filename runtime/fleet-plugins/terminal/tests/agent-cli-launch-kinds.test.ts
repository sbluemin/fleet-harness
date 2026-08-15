import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

// 축은 사다리 어휘 그대로다. 한 모델이 그 일부만 내놓아도 축은 줄지 않는다 — 그래야 표면이
// 내놓은 단을 균등히 벌리는 대신 제자리에 세울 수 있다.
const EFFORT_AXIS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const EVERYDAY_AXIS = ["low", "medium", "high", "xhigh"];
const APEX_EFFORTS = ["max", "ultra"];
const MAX_ONLY_AXIS = [...EVERYDAY_AXIS, "max"];

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
  it("adds the complete built-in model and effort menu to the enabled gateway kind", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true },
      ],
      "agent",
      resolveAiGatewaySelection({ version: 1 }),
    );

    expect(result).toEqual([
      {
        id: "claude-gateway",
        type: "agent",
        title: "Claude (Gateway)",
        variants: [builtinVariants],
        // 채팅으로 태어나는 길은 SDK 인수 계약 위에 서므로 이 종류에서만 선언된다 —
        // 컴포저의 시작 뷰 선택이 이 선언 하나에 매여 있다.
        launchViews: ["terminal", "chat"],
      },
    ]);
  });

  it("adds enabled gateway models in provider order with their exposed effort ladders", () => {
    const resolved = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "kimi--k3", efforts: ["max"] },
        { id: "codex--gpt-5.6-sol-fast" },
      ],
    });
    const selection = {
      ...resolved,
      effortExposure: {
        ...resolved.effortExposure,
        "codex--gpt-5.6-sol-fast": ["low", "medium", "high", "xhigh", "max", "ultra"] as const,
      },
    };

    const result = buildAgentCliLaunchKinds(
      [{ id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true }],
      "agent",
      selection,
    );

    expect(result[0]?.variants).toEqual([
      builtinVariants,
      {
        id: "gateway:codex",
        label: "Codex",
        rows: [
          {
            id: "codex--gpt-5.6-sol-fast",
            label: "GPT-5.6-Sol-Fast",
            launch: { model: "codex--gpt-5.6-sol-fast" },
            effortAxis: EFFORT_AXIS,
            gatedEfforts: APEX_EFFORTS,
            chips: [
              gatewayChip("codex--gpt-5.6-sol-fast", "low", "LOW"),
              gatewayChip("codex--gpt-5.6-sol-fast", "medium", "MED"),
              gatewayChip("codex--gpt-5.6-sol-fast", "high", "HIGH"),
              gatewayChip("codex--gpt-5.6-sol-fast", "xhigh", "XHIGH"),
              gatewayChip("codex--gpt-5.6-sol-fast", "max", "MAX"),
              gatewayChip("codex--gpt-5.6-sol-fast", "ultra", "ULTRACODE"),
            ],
          },
        ],
      },
      {
        id: "gateway:kimi",
        label: "Moonshot-Kimi",
        rows: [
          {
            id: "kimi--k3",
            label: "K3-1M",
            launch: { model: "kimi--k3" },
            // 노출은 MAX 한 단 — 축에서도 ultra를 빼 유령 스톱이 일상 사다리에 붙지 않게 한다.
            effortAxis: MAX_ONLY_AXIS,
            gatedEfforts: ["max"],
            chips: [gatewayChip("kimi--k3", "max", "MAX")],
          },
        ],
      },
    ]);
  });

  it("omits the apex expander when the model exposes neither max nor ultra", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "kimi--k3", efforts: ["low", "high"] }],
    });

    const result = buildAgentCliLaunchKinds(
      [{ id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true }],
      "agent",
      selection,
    );
    const row = result[0]?.variants?.find((group) => group.id === "gateway:kimi")?.rows[0];

    expect(row).toEqual({
      id: "kimi--k3",
      label: "K3-1M",
      launch: { model: "kimi--k3" },
      effortAxis: EVERYDAY_AXIS,
      chips: [
        gatewayChip("kimi--k3", "low", "LOW"),
        gatewayChip("kimi--k3", "high", "HIGH"),
      ],
    });
    expect(row).not.toHaveProperty("gatedEfforts");
  });

  it("gates max alone for models that stop before ultra", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "codex--gpt-5.6-luna-fast" }],
    });

    const result = buildAgentCliLaunchKinds(
      [{ id: "claude-gateway", label: "Claude (Gateway)", available: true, signedIn: true }],
      "agent",
      selection,
    );
    const row = result[0]?.variants?.find((group) => group.id === "gateway:codex")?.rows[0];

    expect(row).toMatchObject({
      id: "codex--gpt-5.6-luna-fast",
      effortAxis: MAX_ONLY_AXIS,
      gatedEfforts: ["max"],
    });
    expect(row?.chips?.map((chip) => chip.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(row?.chips?.some((chip) => chip.id === "ultra")).toBe(false);
  });

  it("keeps disabled reasons and does not attach variants to a disabled gateway kind", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude-gateway", label: "Claude (Gateway)", available: false, signedIn: true },
      ],
      "agent",
      resolveAiGatewaySelection({
        version: 1,
        models: [{ id: "kimi--k3" }],
      }),
    );

    expect(result).toEqual([
      { id: "claude-gateway", type: "agent", title: "Claude (Gateway)", disabled: true, disabledReason: "Not installed" },
    ]);
  });
});

function builtinRow(model: string, label: string) {
  return {
    id: model,
    label,
    launch: { model },
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
