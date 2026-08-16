import type { OperationLaunchKind, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";
import {
  bareModelName,
  exposableEffortLadder,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  type AiGatewaySelection,
  type GatewayModel,
  type GatewayProvider,
  type GatewayReasoningEffort,
} from "@dotobokuri/core-ai-gateway";
import { NATIVE_CLAUDE_EFFORTS, NATIVE_CLAUDE_MODEL_ALIASES } from "@dotobokuri/fleet-admiral";

import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
  ultra: "ULTRACODE",
};

/** 게이트 뒤에 숨는 apex 티어 — 일상 다이얼은 xhigh에서 닫고, 이 단들은 트랙의 확장 제스처가 연다. */
const APEX_EFFORTS = ["max", "ultra"] as const;

/**
 * Console launch 전용 sentinel — 카탈로그 사다리(GatewayReasoningEffort)의 단이 아니라 모든
 * gateway 모델의 마지막 칩으로 무조건 서는 Claude Code 하네스 능력이다. launch payload에는
 * 이 문자열이 그대로 실리고, spawn은 launch factory가 `--effort ultracode`로 전달한다.
 */
const ULTRACODE_LAUNCH_EFFORT = "ultra";

const NATIVE_MODEL_LABELS: Readonly<Record<(typeof NATIVE_CLAUDE_MODEL_ALIASES)[number], string>> = {
  // Claude Code's 1M coordinates stay under their plain menu labels.
  "fable[1m]": "Fable",
  "opus[1m]": "Opus",
  sonnet: "Sonnet",
};

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
  gatewaySelection?: AiGatewaySelection,
): OperationLaunchKind[] {
  return metadata
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: operationType,
        title: cli.label,
        ...(disabledReason
          ? { disabled: true, disabledReason }
          : cli.id === "claude-gateway"
            ? {
              variants: buildClaudeGatewayLaunchVariants(gatewaySelection),
              // 채팅으로 태어나는 길은 SDK 인수 계약 위에 서므로 Claude Gateway 종류에서만 열린다
              // (전환 경로의 `chat_unsupported`와 같은 판정). 다른 종류는 선언하지 않으므로
              // 컴포저의 시작 뷰 선택 자체가 서지 않는다.
              launchViews: ["terminal", "chat"] as const,
            }
            : {}),
      };
    });
}

export function buildClaudeGatewayLaunchVariants(selection?: AiGatewaySelection): readonly OperationLaunchVariantGroup[] {
  const native: OperationLaunchVariantGroup = {
    id: "native",
    label: "Claude",
    rows: NATIVE_CLAUDE_MODEL_ALIASES.map((model) => ({
      id: model,
      label: NATIVE_MODEL_LABELS[model],
      launch: { model },
      effortAxis: EFFORT_AXIS,
      gatedEfforts: APEX_EFFORTS,
      // 네이티브 행은 max·ultra를 항상 노출한다 — ultracode는 모델 사다리의 단이 아니라
      // 하네스 능력(standing orchestration)이라 Claude native에서 모델 독립이다.
      // spawn은 launch factory가 `--effort ultracode`로 전달한다.
      chips: EFFORT_AXIS.map((effort) => ({
        id: effort,
        label: EFFORT_LABELS[effort]!,
        launch: { model, effort },
      })),
    })),
  };
  if (!selection || selection.models.length === 0) return [native];

  // Gateway rows stay sorted by GATEWAY_PROVIDERS, but launch menus show one band
  // per provider so glyphs and captions can identify the supplier without the
  // Claude Code displayName prefix.
  const groups: OperationLaunchVariantGroup[] = [native];
  for (const provider of GATEWAY_PROVIDERS) {
    const models = selection.models.filter((model) => model.provider === provider);
    if (models.length === 0) continue;
    groups.push({
      id: providerGroupId(provider),
      label: GATEWAY_PROVIDER_NAMES[provider],
      rows: models.map((model) => toGatewayRow(model, selection)),
    });
  }
  return groups;
}

// 강도 축은 사다리 어휘를 아는 이쪽이 소유한다. 한 모델이 그 일부만 내놓아도(low/high/max)
// 일상 단의 자리는 지키되, 게이트 티어(max/ultra)는 실제로 설 수 있는 것만 축에 올린다 —
// 안 내놓은 apex를 축에 남겨 두면 + 없이도 빈 스톱이 일상 사다리 끝에 붙는다.
const EFFORT_AXIS = [...NATIVE_CLAUDE_EFFORTS, ULTRACODE_LAUNCH_EFFORT] as const;

function providerGroupId(provider: GatewayProvider): string {
  return `gateway:${provider}`;
}

function toGatewayRow(model: GatewayModel, selection: AiGatewaySelection) {
  // 일상 단은 노출/카탈로그 사다리만 따른다 — ultra는 이 어휘에 없으니 여기서는 절대 나오지
  // 않고, Console launch sentinel로 마지막 칩에 따로 합성한다.
  const ordinary: readonly GatewayReasoningEffort[] = selection.effortExposure[model.id] ?? exposableEffortLadder(model);
  const hasMax = ordinary.includes("max");
  // apex는 게이트 뒤 전용이다. max는 모델이 실제로 내놓을 때만 축에 올리고, ultra는 하네스
  // 능력이라 모델과 무관하게 끝에 선다. 강도를 아예 지원하지 않는 모델은 ULTRACODE 단독 행이다.
  const effortAxis: readonly string[] = ordinary.length === 0
    ? [ULTRACODE_LAUNCH_EFFORT]
    : [...NATIVE_CLAUDE_EFFORTS.filter((effort) => effort !== "max" || hasMax), ULTRACODE_LAUNCH_EFFORT];
  const gatedEfforts: readonly string[] = hasMax ? ["max", ULTRACODE_LAUNCH_EFFORT] : [ULTRACODE_LAUNCH_EFFORT];
  const chips: readonly string[] = [...ordinary, ULTRACODE_LAUNCH_EFFORT];
  return {
    id: model.id,
    label: bareModelName(model),
    launch: { model: model.id },
    effortAxis,
    gatedEfforts,
    chips: chips.map((effort) => ({
      id: effort,
      label: EFFORT_LABELS[effort] ?? effort.toUpperCase(),
      launch: { model: model.id, effort },
    })),
  };
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
