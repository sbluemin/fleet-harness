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
// 일상 단의 자리는 지키되, 게이트 티어(max/ultra)는 모델이 실제로 내놓은 것만 축에 올린다 —
// 안 내놓은 apex를 축에 남겨 두면 + 없이도 빈 스톱이 일상 사다리 끝에 붙는다.
const EFFORT_AXIS = [...NATIVE_CLAUDE_EFFORTS, "ultra"] as const;

function providerGroupId(provider: GatewayProvider): string {
  return `gateway:${provider}`;
}

function toGatewayRow(model: GatewayModel, selection: AiGatewaySelection) {
  const efforts = (selection.effortExposure[model.id] ?? exposableEffortLadder(model))
    .filter((effort): effort is Extract<GatewayReasoningEffort, (typeof EFFORT_AXIS)[number]> =>
      EFFORT_AXIS.includes(effort));
  const gatedEfforts = APEX_EFFORTS.filter((effort) => efforts.includes(effort));
  // apex는 게이트 뒤 전용이다. 노출되지 않은 max/ultra는 축에서도 빼, 닫힌 트랙에
  // 유령 스톱이 서지 않게 한다. 일상 단(medium/xhigh 등)의 빈 자리는 그대로 둔다.
  const effortAxis = EFFORT_AXIS.filter((effort) =>
    !(APEX_EFFORTS as readonly string[]).includes(effort) || efforts.includes(effort));
  return {
    id: model.id,
    label: bareModelName(model),
    launch: { model: model.id },
    ...(efforts.length > 0 ? {
      effortAxis,
      ...(gatedEfforts.length > 0 ? { gatedEfforts } : {}),
      chips: efforts.map((effort) => ({
        id: effort,
        label: EFFORT_LABELS[effort] ?? effort.toUpperCase(),
        launch: { model: model.id, effort },
      })),
    } : {}),
  };
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
