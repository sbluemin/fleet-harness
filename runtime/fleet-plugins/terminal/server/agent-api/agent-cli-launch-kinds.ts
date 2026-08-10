import type { OperationLaunchKind, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";
import {
  bareModelName,
  exposableEffortLadder,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  type AiGatewaySelection,
  type GatewayModel,
  type GatewayProvider,
} from "@dotobokuri/core-ai-gateway";
import {
  NATIVE_CLAUDE_EFFORTS,
  NATIVE_CLAUDE_LAUNCH_EFFORTS,
  NATIVE_CLAUDE_MODEL_ALIASES,
  NATIVE_CLAUDE_SPECIAL_EFFORTS,
} from "@dotobokuri/fleet-admiral";

import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
  // 특수 강도는 줄여 쓰지 않는다 — 무엇을 켜는지 이름이 다 말해야 한다.
  ultracode: "ULTRACODE",
};

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
      ...(NATIVE_EFFORT_EXPANSION ? { effortExpansion: NATIVE_EFFORT_EXPANSION } : {}),
      chips: NATIVE_CLAUDE_LAUNCH_EFFORTS.map((effort) => ({
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
// 축은 그대로라, 표면이 내놓은 단을 균등히 벌리는 대신 제자리에 세울 수 있다.
const EFFORT_AXIS: readonly string[] = NATIVE_CLAUDE_LAUNCH_EFFORTS;

/**
 * 평범한 레일의 천장. 이 뒤(max·ultracode)는 한 번 더 펼쳐야 닿는다 — 값이 비싸서가 아니라
 * 스쳐 지나간 드래그가 그 값을 고르는 일이 사고이기 때문이다.
 */
const EFFORT_EXPANSION_AFTER = "xhigh";

function effortExpansionFor(offered: readonly string[]): { readonly after: string; readonly rungs: readonly string[] } | undefined {
  const boundary = EFFORT_AXIS.indexOf(EFFORT_EXPANSION_AFTER);
  const rungs = EFFORT_AXIS.slice(boundary + 1).filter((rung) => offered.includes(rung));
  return rungs.length > 0 ? { after: EFFORT_EXPANSION_AFTER, rungs } : undefined;
}

const NATIVE_EFFORT_EXPANSION = effortExpansionFor(NATIVE_CLAUDE_LAUNCH_EFFORTS);

function providerGroupId(provider: GatewayProvider): string {
  return `gateway:${provider}`;
}

function toGatewayRow(model: GatewayModel, selection: AiGatewaySelection) {
  const ladder = selection.effortExposure[model.id] ?? exposableEffortLadder(model);
  const efforts: string[] = ladder
    .filter((effort): effort is (typeof NATIVE_CLAUDE_EFFORTS)[number] =>
      NATIVE_CLAUDE_EFFORTS.includes(effort as (typeof NATIVE_CLAUDE_EFFORTS)[number]));
  // ultracode는 이 모델의 단이 아니라 Claude Code 세션 모드이고 상류에는 xhigh로 나간다.
  // xhigh를 내놓는 모델에만 걸어 주지 않으면 고른 단이 조용히 깎인다.
  if (efforts.includes("xhigh")) efforts.push(...NATIVE_CLAUDE_SPECIAL_EFFORTS);
  const expansion = effortExpansionFor(efforts);
  return {
    id: model.id,
    label: bareModelName(model),
    ...(selection.defaultModel?.id === model.id ? { starred: true } : {}),
    launch: { model: model.id },
    ...(efforts.length > 0 ? {
      effortAxis: EFFORT_AXIS,
      ...(expansion ? { effortExpansion: expansion } : {}),
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
