import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

// 축은 사다리 어휘 그대로다. 한 모델이 그 일부만 내놓아도 축은 줄지 않는다 — 그래야 표면이
// 내놓은 단을 균등히 벌리는 대신 제자리에 세울 수 있다.
const EFFORT_AXIS = ["low", "medium", "high", "xhigh", "max"];

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
      },
    ]);
  });

  it("adds enabled gateway models in provider order with their exposed effort ladders", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "kimi--k3", efforts: ["max"] },
        { id: "codex--gpt-5.6-sol-fast" },
      ],
      defaultModel: "kimi--k3",
    });

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
            chips: [
              gatewayChip("codex--gpt-5.6-sol-fast", "low", "LOW"),
              gatewayChip("codex--gpt-5.6-sol-fast", "medium", "MED"),
              gatewayChip("codex--gpt-5.6-sol-fast", "high", "HIGH"),
              gatewayChip("codex--gpt-5.6-sol-fast", "xhigh", "XHIGH"),
              gatewayChip("codex--gpt-5.6-sol-fast", "max", "MAX"),
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
            starred: true,
            launch: { model: "kimi--k3" },
            // 노출은 MAX 한 단뿐이지만 축은 다섯 단 그대로다.
            effortAxis: EFFORT_AXIS,
            chips: [gatewayChip("kimi--k3", "max", "MAX")],
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("ultra");
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
    chips: [
      gatewayChip(model, "low", "LOW"),
      gatewayChip(model, "medium", "MED"),
      gatewayChip(model, "high", "HIGH"),
      gatewayChip(model, "xhigh", "XHIGH"),
      gatewayChip(model, "max", "MAX"),
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
