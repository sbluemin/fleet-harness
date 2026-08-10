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
            ? { variants: buildClaudeGatewayLaunchVariants(gatewaySelection) }
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
      chips: NATIVE_CLAUDE_EFFORTS.map((effort) => ({
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
// 축은 그대로라, 표면이 내놓은 단을 균등히 벌리는 대신 제자리에 세울 수 있다. 게이트웨이
// 카탈로그는 max 뒤에 ultra 단을 두므로(GATEWAY_REASONING_EFFORTS), 축은 그 끝까지 세운다.
// 네이티브 Claude 행의 칩은 max에서 닫히므로 ultra 칩은 카탈로그가 낸 게이트웨이 행에만 선다.
const EFFORT_AXIS: readonly string[] = [...NATIVE_CLAUDE_EFFORTS, "ultra"];

function providerGroupId(provider: GatewayProvider): string {
  return `gateway:${provider}`;
}

function toGatewayRow(model: GatewayModel, selection: AiGatewaySelection) {
  const efforts = (selection.effortExposure[model.id] ?? exposableEffortLadder(model))
    .filter((effort): effort is Extract<GatewayReasoningEffort, (typeof EFFORT_AXIS)[number]> =>
      EFFORT_AXIS.includes(effort));
  return {
    id: model.id,
    label: bareModelName(model),
    launch: { model: model.id },
    ...(efforts.length > 0 ? {
      effortAxis: EFFORT_AXIS,
      gatedEfforts: APEX_EFFORTS,
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
