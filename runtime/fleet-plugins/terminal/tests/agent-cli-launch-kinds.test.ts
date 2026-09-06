import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { buildAgentCliLaunchKinds } from "../server/agent-api/agent-cli-launch-kinds.js";

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
        { id: "kimi--k3", efforts: ["max"] },
        { id: "codex--gpt-5.6-sol-fast" },
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
            // 노출은 MAX 한 단이지만 ultra는 하네스 능력이라 사다리 밖에서 끝 칩으로 선다.
            effortAxis: EFFORT_AXIS,
            gatedEfforts: APEX_EFFORTS,
            chips: [
              gatewayChip("kimi--k3", "max", "MAX"),
              gatewayChip("kimi--k3", "ultra", "ULTRACODE"),
            ],
          },
        ],
      },
    ]);
  });

  it("keeps disabled reasons and does not attach variants to a disabled gateway kind", () => {
    const result = buildAgentCliLaunchKinds(
      [
        { id: "claude", label: "Claude (Gateway)", available: false, signedIn: true },
      ],
      "agent",
      resolveAiGatewaySelection({
        version: 1,
        models: [{ id: "kimi--k3" }],
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
